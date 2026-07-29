/**
 * Procedural heightfield synthesis.
 *
 * Produces the raw elevation raster the whole world is built on: the terrain
 * mesh, the physics collider, tree placement, footstep surface classification
 * and the water plane all read from the same buffer, which is why nothing ever
 * floats or sinks.
 *
 * Pure and worker-safe — no three.js, no DOM.
 *
 * ## The signal chain
 *
 * ```
 *  domain warp  →  fBm simplex  →  ridge shaping
 *       ↓
 *  + ridge landmark bump
 *       ↓
 *  ⊗ village basin flatten      (radial smoothstep)
 *  ⊗ railway grade flatten      (distance-to-polyline smoothstep)
 *  ⊗ road smoothing             (distance-to-polyline, gentle)
 *       ↓
 *  − pond basin  − brook channel
 *       ↓
 *  hydraulic erosion (separate pass, see erosion.worker.ts)
 * ```
 *
 * @module lib/terrain/heightfield
 */

import { createNoise2D } from 'simplex-noise';
import { PolylineQuery, type Pt3 } from '@/lib/utils/curve';
import { hashSeed, mulberry32 } from '@/lib/utils/random';
import { clamp, smoothstep, lerp } from '@/lib/utils/math';
import { WORLD, TERRAIN_NOISE, ZONES } from '@/config/game';
import {
  POND,
  RIDGE,
  BROOK_WIDTH,
  BROOK_FALLOFF,
  BROOK_DEPTH,
  ROAD_WIDTH,
  ROAD_FALLOFF,
  railHeightAt,
} from '@/lib/world/layout';

/** Everything a height query needs, bundled so it can be built once and reused. */
export interface HeightfieldContext {
  /** Base terrain fBm. */
  noise: (x: number, y: number) => number;
  /** Independent noise field used to warp the domain of `noise`. */
  warpNoise: (x: number, y: number) => number;
  /** Fine detail layer added after shaping. */
  detailNoise: (x: number, y: number) => number;
  railQuery: PolylineQuery;
  brookQuery: PolylineQuery;
  roadQuery: PolylineQuery;
}

/**
 * Builds the noise fields and spatial accelerators for a given seed.
 *
 * Three *independent* noise instances are used rather than sampling one field
 * at different offsets: shared fields produce visible correlation between the
 * warp and the signal being warped, which shows up as repeating comma-shaped
 * artefacts across the map.
 */
export function createHeightfieldContext(
  seed: string,
  polylines: { rail: Pt3[]; brook: Pt3[]; road: Pt3[] },
): HeightfieldContext {
  const base = hashSeed(seed);
  return {
    noise: createNoise2D(mulberry32(base)),
    warpNoise: createNoise2D(mulberry32(base ^ 0x9e3779b9)),
    detailNoise: createNoise2D(mulberry32(base ^ 0x85ebca6b)),
    railQuery: new PolylineQuery(polylines.rail, 28),
    brookQuery: new PolylineQuery(polylines.brook, 20),
    roadQuery: new PolylineQuery(polylines.road, 22),
  };
}

/**
 * Fractional Brownian motion — the sum of successively finer, quieter noise
 * octaves. This is what turns a single smooth noise field into something with
 * both broad landforms and small-scale roughness.
 *
 * Normalising by the accumulated amplitude keeps the result in roughly
 * `[-1, 1]` regardless of octave count, so changing `OCTAVES` alters detail
 * without also changing the mountain heights.
 */
function fbm(
  noise: (x: number, y: number) => number,
  x: number,
  y: number,
  octaves: number,
  frequency: number,
  lacunarity: number,
  gain: number,
): number {
  let amp = 1;
  let freq = frequency;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq) * amp;
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return norm === 0 ? 0 : sum / norm;
}

/**
 * Evaluates the terrain elevation at a world position, **before erosion**.
 *
 * @param ctx - Context from {@link createHeightfieldContext}.
 * @param x - World X.
 * @param z - World Z.
 * @returns Elevation in world units.
 */
export function sampleTerrain(ctx: HeightfieldContext, x: number, z: number): number {
  const {
    OCTAVES,
    LACUNARITY,
    GAIN,
    BASE_FREQUENCY,
    WARP_STRENGTH,
    WARP_FREQUENCY,
    RIDGE_EXPONENT,
    VILLAGE_FLATTEN_RADIUS,
    VILLAGE_FLATTEN_FALLOFF,
    VILLAGE_FLATTEN_HEIGHT,
    RAIL_FLATTEN_WIDTH,
    RAIL_FLATTEN_FALLOFF,
  } = TERRAIN_NOISE;

  /* ── 1. Domain warping ────────────────────────────────────────────────────
   * Offsetting the sample position by a second noise field bends the terrain's
   * features into organic, wind-blown curves. Without it, fBm reads as
   * isotropic "cottage cheese" — recognisably synthetic from any viewpoint. */
  const wx = ctx.warpNoise(x * WARP_FREQUENCY, z * WARP_FREQUENCY) * WARP_STRENGTH;
  const wz = ctx.warpNoise(x * WARP_FREQUENCY + 137.7, z * WARP_FREQUENCY - 91.3) * WARP_STRENGTH;

  /* ── 2. Base fBm ─────────────────────────────────────────────────────────── */
  const n = fbm(ctx.noise, x + wx, z + wz, OCTAVES, BASE_FREQUENCY, LACUNARITY, GAIN);

  /* ── 3. Ridge shaping ─────────────────────────────────────────────────────
   * Remap to [0,1] then raise to a power. Exponents > 1 pull the mid-tones
   * down, which widens the valley floors and leaves the peaks standing — the
   * difference between "rolling blobs" and "a carved valley". */
  const normalised = Math.pow(clamp(n * 0.5 + 0.5, 0, 1), RIDGE_EXPONENT);
  let h = normalised * WORLD.HEIGHT_SCALE;

  /* ── 4. Fine detail ───────────────────────────────────────────────────────
   * A high-frequency, low-amplitude layer added *after* shaping so the ridge
   * exponent doesn't flatten it away. Gives the ground a little tooth. */
  h += ctx.detailNoise(x * 0.055, z * 0.055) * 0.42;
  h += ctx.detailNoise(x * 0.16, z * 0.16) * 0.14;

  /* ── 5. The Ridge landmark ────────────────────────────────────────────────
   * A Gaussian bump guarantees the viewpoint exists regardless of seed. */
  const rdx = x - RIDGE.center[0];
  const rdz = z - RIDGE.center[1];
  const ridgeDistSq = rdx * rdx + rdz * rdz;
  const ridgeBump = RIDGE.amplitude * Math.exp(-ridgeDistSq / (2 * RIDGE.sigma * RIDGE.sigma));
  h += ridgeBump;

  // Small flat shelf at the summit so the bench and flagpole sit level.
  const ridgeDist = Math.sqrt(ridgeDistSq);
  if (ridgeDist < RIDGE.plateauRadius * 2.2) {
    const shelfHeight = h + (RIDGE.plateauRadius * 2.2 - ridgeDist) * 0.0;
    const t = 1 - smoothstep(RIDGE.plateauRadius, RIDGE.plateauRadius * 2.2, ridgeDist);
    // Blend toward the height at the exact summit for a believable flat top.
    const summit =
      RIDGE.amplitude + WORLD.HEIGHT_SCALE * 0.52 + ctx.detailNoise(RIDGE.center[0], 0) * 0.3;
    h = lerp(shelfHeight, summit, t * 0.72);
  }

  /* ── 6. World edge ────────────────────────────────────────────────────────
   * Lift the rim so the map reads as a bowl and the player can't see the void
   * over the horizon.
   *
   * This must happen *before* the railway and village carving, not after.
   * Applied afterwards it buries the graded track under the raised rim near
   * the map edges — the train would tunnel through a hill. Applied here, the
   * rail carving cuts a proper cutting through the rim instead, which is both
   * correct and the best-looking approach to the valley the game has. */
  const edgeX = Math.abs(x) / WORLD.HALF;
  const edgeZ = Math.abs(z) / WORLD.HALF;
  const edge = Math.max(edgeX, edgeZ);
  if (edge > 0.72) {
    const t = smoothstep(0.72, 1.05, edge);
    h = lerp(h, h + WORLD.HEIGHT_SCALE * 0.85, t);
  }

  /* ── 7. Village basin ─────────────────────────────────────────────────────
   * Blend toward a level plaza so houses don't end up on a 20° slope. */
  const vdx = x - ZONES.VILLAGE_HEART.center[0];
  const vdz = z - ZONES.VILLAGE_HEART.center[1];
  const villageDist = Math.sqrt(vdx * vdx + vdz * vdz);
  const villageT =
    1 -
    smoothstep(
      VILLAGE_FLATTEN_RADIUS,
      VILLAGE_FLATTEN_RADIUS + VILLAGE_FLATTEN_FALLOFF,
      villageDist,
    );
  if (villageT > 0) {
    // Retain a whisper of the original relief so the plaza isn't a billiard table.
    const target = VILLAGE_FLATTEN_HEIGHT + ctx.detailNoise(x * 0.03, z * 0.03) * 0.55;
    h = lerp(h, target, villageT * 0.94);
  }

  /* ── 7. Railway grade ─────────────────────────────────────────────────────
   * Blend hard toward the engineered rail profile inside the corridor, then
   * ease out — producing cuttings through hills and embankments over dips. */
  const rail = ctx.railQuery.nearest(x, z);
  if (rail.distance < RAIL_FLATTEN_WIDTH + RAIL_FLATTEN_FALLOFF) {
    const railT =
      1 -
      smoothstep(RAIL_FLATTEN_WIDTH, RAIL_FLATTEN_WIDTH + RAIL_FLATTEN_FALLOFF, rail.distance);
    // The ballast shoulder sits a little below rail top.
    const target = railHeightAt(x) - 0.55;
    h = lerp(h, target, railT * 0.97);
  }

  /* ── 8. Road smoothing ────────────────────────────────────────────────────
   * Much gentler than the railway — a cart track follows the land, it doesn't
   * cut through it. Just enough to remove ankle-breaking bumps. */
  const road = ctx.roadQuery.nearest(x, z);
  if (road.distance < ROAD_WIDTH + ROAD_FALLOFF) {
    const roadT = 1 - smoothstep(ROAD_WIDTH, ROAD_WIDTH + ROAD_FALLOFF, road.distance);
    // Average the terrain over a small neighbourhood to level the track bed.
    const smoothed = h - ctx.detailNoise(x * 0.055, z * 0.055) * 0.42;
    h = lerp(h, smoothed, roadT * 0.65);
  }

  /* ── 9. Pond basin ────────────────────────────────────────────────────────
   * Carved below WATER_LEVEL so the water plane always has something to fill. */
  const pdx = x - POND.center[0];
  const pdz = z - POND.center[1];
  const pondDist = Math.sqrt(pdx * pdx + pdz * pdz);
  if (pondDist < POND.radius + POND.falloff) {
    const pondT = 1 - smoothstep(POND.radius, POND.radius + POND.falloff, pondDist);
    // A dished profile — deepest at the centre, shelving at the margins.
    const bowl = 1 - (pondDist / POND.radius) * (pondDist / POND.radius);
    const target = WORLD.WATER_LEVEL - POND.depth * clamp(bowl, 0.06, 1);
    h = lerp(h, target, pondT);
  }

  /* ── 10. Brook channel ────────────────────────────────────────────────────
   * A shallow V cut along the stream polyline, running downhill into the pond. */
  const brook = ctx.brookQuery.nearest(x, z);
  if (brook.distance < BROOK_WIDTH + BROOK_FALLOFF) {
    const brookT = 1 - smoothstep(BROOK_WIDTH, BROOK_WIDTH + BROOK_FALLOFF, brook.distance);
    h -= BROOK_DEPTH * brookT;
  }

  return h;
}

/**
 * Rasterises the terrain into a square `Float32Array` heightmap.
 *
 * @param ctx - Heightfield context.
 * @param resolution - Samples per axis.
 * @param onProgress - Optional 0..1 progress callback, fired ~20 times.
 * @returns Row-major heights, `resolution × resolution`.
 */
export function rasterizeHeightmap(
  ctx: HeightfieldContext,
  resolution: number,
  onProgress?: (t: number) => void,
): Float32Array {
  const data = new Float32Array(resolution * resolution);
  const step = WORLD.SIZE / (resolution - 1);
  const reportEvery = Math.max(1, Math.floor(resolution / 20));

  for (let j = 0; j < resolution; j++) {
    const z = -WORLD.HALF + j * step;
    for (let i = 0; i < resolution; i++) {
      const x = -WORLD.HALF + i * step;
      data[j * resolution + i] = sampleTerrain(ctx, x, z);
    }
    if (onProgress && j % reportEvery === 0) onProgress(j / resolution);
  }
  onProgress?.(1);
  return data;
}

/* ───────────────────────────────────────────────────────────────────────────
 * SURFACE CLASSIFICATION
 * ─────────────────────────────────────────────────────────────────────────── */

/** Surface material IDs, matching the splatmap channel order in the shader. */
export const SURFACE_GRASS = 0;
export const SURFACE_DIRT = 1;
export const SURFACE_ROCK = 2;
export const SURFACE_SAND = 3;
export const SURFACE_COBBLE = 4;
export const SURFACE_WOOD = 5;

/**
 * Classifies the ground material at a world position.
 *
 * Drives both the triplanar splat weights in the terrain shader and the
 * footstep synth voice, so what you hear always matches what you see.
 *
 * @param x - World X.
 * @param z - World Z.
 * @param height - Terrain elevation at that point.
 * @param slope - Terrain slope, 0 (flat) to 1 (vertical).
 * @param roadDistance - Distance to the nearest road centreline.
 * @param plazaRadius - Radius of the cobbled plaza.
 */
export function classifySurface(
  x: number,
  z: number,
  height: number,
  slope: number,
  roadDistance: number,
  plazaRadius: number,
): number {
  const distFromCentre = Math.hypot(x - ZONES.VILLAGE_HEART.center[0], z - ZONES.VILLAGE_HEART.center[1]);
  if (distFromCentre < plazaRadius) return SURFACE_COBBLE;
  if (roadDistance < ROAD_WIDTH * 1.15) return SURFACE_DIRT;
  // Waterline sand around the pond and along the brook.
  if (height < WORLD.WATER_LEVEL + 0.9) return SURFACE_SAND;
  // Anything too steep to hold soil is exposed rock.
  if (slope > 0.58) return SURFACE_ROCK;
  return SURFACE_GRASS;
}
