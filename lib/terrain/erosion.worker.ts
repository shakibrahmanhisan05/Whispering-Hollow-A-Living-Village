/// <reference lib="webworker" />
/**
 * Terrain generation + hydraulic erosion Web Worker.
 *
 * Runs the entire world-gen pipeline off the main thread so the loading screen
 * keeps animating at 60 FPS while 260 000 heightmap samples and 60 000 erosion
 * droplets are computed. On a mid-range laptop core this takes ~1.2 s; doing it
 * on the main thread would freeze the tab for that whole period.
 *
 * ## Why droplet erosion?
 *
 * fBm noise produces plausible *shapes* but physically impossible *drainage* —
 * every valley is a closed basin and ridgelines wander without converging.
 * Simulating particles of water rolling downhill, picking up sediment on steep
 * ground and dropping it on flat ground, carves connected drainage networks:
 * gullies that merge into valleys, alluvial fans where slopes ease, and sharp
 * ridge crests between catchments. It is the single highest-value pass for
 * making procedural terrain read as real.
 *
 * The implementation follows the standard particle model (Mei et al. / Lague):
 * each droplet tracks position, direction, velocity, water volume and carried
 * sediment, and its capacity to hold sediment scales with `slope × speed ×
 * water`.
 *
 * @module lib/terrain/erosion.worker
 */

import { createHeightfieldContext, rasterizeHeightmap } from './heightfield';
import type { Pt3 } from '../utils/curve';
import { EROSION } from '../../config/game';

/** Message sent from the main thread to kick off generation. */
export interface TerrainWorkerRequest {
  type: 'generate';
  seed: string;
  resolution: number;
  /** Set to 0 to skip the erosion pass entirely (low-end devices). */
  droplets: number;
  polylines: { rail: Pt3[]; brook: Pt3[]; road: Pt3[] };
}

/** Messages the worker posts back. */
export type TerrainWorkerResponse =
  | { type: 'progress'; phase: 'noise' | 'erosion'; value: number }
  | { type: 'done'; heights: Float32Array; resolution: number; minHeight: number; maxHeight: number }
  | { type: 'error'; message: string };

/**
 * Precomputes the weighted stamp used to spread a droplet's erosion over a
 * disc of cells.
 *
 * Eroding only the single cell under the droplet produces 1-pixel-wide spikes
 * and severe aliasing. Distributing the removal across a small disc, weighted
 * by `1 - distance/radius` and normalised to sum to 1, yields smooth channels.
 *
 * Returns, for every cell in the map, the neighbour indices and their weights.
 * Building this once costs a few milliseconds and saves recomputing the disc
 * for each of the 2 M droplet steps.
 */
function buildErosionBrush(
  size: number,
  radius: number,
): { indices: Int32Array[]; weights: Float32Array[] } {
  const indices: Int32Array[] = new Array(size * size);
  const weights: Float32Array[] = new Array(size * size);

  const offsetsX: number[] = [];
  const offsetsY: number[] = [];
  const offsetWeights: number[] = [];

  // The disc offsets are the same everywhere; only edge clipping differs.
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      const dSq = x * x + y * y;
      if (dSq >= radius * radius) continue;
      offsetsX.push(x);
      offsetsY.push(y);
      offsetWeights.push(1 - Math.sqrt(dSq) / radius);
    }
  }

  for (let cy = 0; cy < size; cy++) {
    for (let cx = 0; cx < size; cx++) {
      const idx = cy * size + cx;
      const localIdx: number[] = [];
      const localW: number[] = [];
      let sum = 0;
      for (let k = 0; k < offsetsX.length; k++) {
        const nx = cx + offsetsX[k]!;
        const ny = cy + offsetsY[k]!;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        localIdx.push(ny * size + nx);
        localW.push(offsetWeights[k]!);
        sum += offsetWeights[k]!;
      }
      // Normalise so the total material moved is independent of clipping.
      const w = new Float32Array(localW.length);
      for (let k = 0; k < localW.length; k++) w[k] = sum > 0 ? localW[k]! / sum : 0;
      indices[idx] = Int32Array.from(localIdx);
      weights[idx] = w;
    }
  }

  return { indices, weights };
}

/**
 * Bilinear height plus analytic gradient at a fractional grid position.
 *
 * The gradient is derived from the same four corners used for the height, so
 * the droplet always flows consistently with the surface it is standing on.
 */
function heightAndGradient(
  heights: Float32Array,
  size: number,
  posX: number,
  posY: number,
): { height: number; gradX: number; gradY: number } {
  const cx = Math.floor(posX);
  const cy = Math.floor(posY);
  const fx = posX - cx;
  const fy = posY - cy;

  const i00 = cy * size + cx;
  const i10 = i00 + 1;
  const i01 = i00 + size;
  const i11 = i01 + 1;

  const h00 = heights[i00]!;
  const h10 = heights[i10]!;
  const h01 = heights[i01]!;
  const h11 = heights[i11]!;

  // Partial derivatives of the bilinear patch.
  const gradX = (h10 - h00) * (1 - fy) + (h11 - h01) * fy;
  const gradY = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
  const height =
    h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy;

  return { height, gradX, gradY };
}

/**
 * Runs the droplet erosion simulation in place.
 *
 * @param heights - Heightmap to erode, modified in place.
 * @param size - Grid edge length.
 * @param dropletCount - Number of droplets to simulate.
 * @param seed - Numeric seed so erosion is reproducible per world.
 * @param onProgress - Progress callback, 0..1.
 */
function erode(
  heights: Float32Array,
  size: number,
  dropletCount: number,
  seed: number,
  onProgress: (t: number) => void,
): void {
  const {
    MAX_LIFETIME,
    EROSION_RADIUS,
    INERTIA,
    SEDIMENT_CAPACITY_FACTOR,
    MIN_SEDIMENT_CAPACITY,
    ERODE_SPEED,
    DEPOSIT_SPEED,
    EVAPORATE_SPEED,
    GRAVITY,
    INITIAL_WATER,
    INITIAL_SPEED,
  } = EROSION;

  const brush = buildErosionBrush(size, EROSION_RADIUS);

  // Local mulberry32 — the worker must not import DOM-touching modules.
  let rngState = seed >>> 0;
  const rand = (): number => {
    rngState = (rngState + 0x6d2b79f5) | 0;
    let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const reportEvery = Math.max(1, Math.floor(dropletCount / 25));

  for (let iter = 0; iter < dropletCount; iter++) {
    // Start somewhere in the interior; the 1-cell margin keeps the bilinear
    // lookups in bounds without per-step clamping.
    let posX = rand() * (size - 2) + 0.5;
    let posY = rand() * (size - 2) + 0.5;
    let dirX = 0;
    let dirY = 0;
    let speed: number = INITIAL_SPEED;
    let water: number = INITIAL_WATER;
    let sediment = 0;

    for (let lifetime = 0; lifetime < MAX_LIFETIME; lifetime++) {
      const nodeX = Math.floor(posX);
      const nodeY = Math.floor(posY);
      const dropletIndex = nodeY * size + nodeX;
      const cellOffsetX = posX - nodeX;
      const cellOffsetY = posY - nodeY;

      const hg = heightAndGradient(heights, size, posX, posY);

      /* Blend the previous direction with the downhill gradient. INERTIA near 0
       * means the droplet obeys the slope exactly (sharp, dendritic channels);
       * near 1 it ploughs straight ahead (smooth, braided ones). */
      dirX = dirX * INERTIA - hg.gradX * (1 - INERTIA);
      dirY = dirY * INERTIA - hg.gradY * (1 - INERTIA);

      const len = Math.sqrt(dirX * dirX + dirY * dirY);
      if (len !== 0) {
        dirX /= len;
        dirY /= len;
      }
      posX += dirX;
      posY += dirY;

      // Stalled in a pit, or walked off the map.
      if ((dirX === 0 && dirY === 0) || posX < 1 || posX >= size - 2 || posY < 1 || posY >= size - 2)
        break;

      const newHeight = heightAndGradient(heights, size, posX, posY).height;
      const deltaHeight = newHeight - hg.height;

      /* Carrying capacity. Fast, deep water on a steep slope carries the most;
       * the floor prevents flat sections from instantly dumping everything. */
      const capacity = Math.max(
        -deltaHeight * speed * water * SEDIMENT_CAPACITY_FACTOR,
        MIN_SEDIMENT_CAPACITY,
      );

      if (sediment > capacity || deltaHeight > 0) {
        /* Deposit. Going uphill means the droplet is filling a pit: deposit at
         * most enough to level it, which is what closes the closed basins that
         * raw fBm is full of. */
        const amount =
          deltaHeight > 0
            ? Math.min(deltaHeight, sediment)
            : (sediment - capacity) * DEPOSIT_SPEED;
        sediment -= amount;

        // Deposition is bilinear onto the four cells the droplet straddles.
        heights[dropletIndex]! += amount * (1 - cellOffsetX) * (1 - cellOffsetY);
        heights[dropletIndex + 1]! += amount * cellOffsetX * (1 - cellOffsetY);
        heights[dropletIndex + size]! += amount * (1 - cellOffsetX) * cellOffsetY;
        heights[dropletIndex + size + 1]! += amount * cellOffsetX * cellOffsetY;
      } else {
        /* Erode. Never remove more than the height difference, otherwise the
         * droplet digs a hole it then falls into and the map fills with pits. */
        const amount = Math.min((capacity - sediment) * ERODE_SPEED, -deltaHeight);
        const bIdx = brush.indices[dropletIndex];
        const bW = brush.weights[dropletIndex];
        if (bIdx && bW) {
          for (let k = 0; k < bIdx.length; k++) {
            const ci = bIdx[k]!;
            const weighted = amount * bW[k]!;
            const available = heights[ci]!;
            // Guard against negative elevations in already-scoured cells.
            const delta = available < weighted ? available : weighted;
            heights[ci] = available - delta;
            sediment += delta;
          }
        }
      }

      /* Gravity converts height lost into speed. `max(0, …)` matters: without
       * it, a droplet climbing a lip produces a negative radicand and NaNs
       * propagate silently through the entire heightmap. */
      speed = Math.sqrt(Math.max(0, speed * speed + -deltaHeight * GRAVITY));
      water *= 1 - EVAPORATE_SPEED;
      if (water < 0.0015) break;
    }

    if (iter % reportEvery === 0) onProgress(iter / dropletCount);
  }
  onProgress(1);
}

/* ───────────────────────────────────────────────────────────────────────────
 * WORKER ENTRY POINT
 * ─────────────────────────────────────────────────────────────────────────── */

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (event: MessageEvent<TerrainWorkerRequest>) => {
  const req = event.data;
  if (!req || req.type !== 'generate') return;

  try {
    const post = (msg: TerrainWorkerResponse, transfer?: Transferable[]) =>
      transfer ? ctx.postMessage(msg, transfer) : ctx.postMessage(msg);

    const hf = createHeightfieldContext(req.seed, req.polylines);

    const heights = rasterizeHeightmap(hf, req.resolution, (t) =>
      post({ type: 'progress', phase: 'noise', value: t }),
    );

    if (req.droplets > 0) {
      let seedNum = 0;
      for (let i = 0; i < req.seed.length; i++) {
        seedNum = (Math.imul(seedNum, 31) + req.seed.charCodeAt(i)) | 0;
      }
      erode(heights, req.resolution, req.droplets, seedNum ^ 0x5f3759df, (t) =>
        post({ type: 'progress', phase: 'erosion', value: t }),
      );
    }

    let minHeight = Infinity;
    let maxHeight = -Infinity;
    for (let i = 0; i < heights.length; i++) {
      const h = heights[i]!;
      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;
    }

    // Transfer the buffer rather than cloning it — 512² floats is 1 MB.
    post(
      { type: 'done', heights, resolution: req.resolution, minHeight, maxHeight },
      [heights.buffer],
    );
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } satisfies TerrainWorkerResponse);
  }
});

export {};
