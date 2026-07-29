/**
 * Terrain orchestration: runs the generation worker, wraps the resulting
 * heightmap in a queryable {@link TerrainData}, and builds render + collision
 * geometry from it.
 *
 * `TerrainData` is the single source of truth for "how high is the ground
 * here?" — the player controller, tree scatter, water edges, grass chunks,
 * wildlife pathing and prop placement all call into it, so nothing can
 * disagree about where the surface is.
 *
 * @module lib/terrain/generate
 */

import * as THREE from 'three';
import { WORLD, VILLAGE, PERFORMANCE } from '@/config/game';
import { bilinearSample, clamp, smoothstep } from '@/lib/utils/math';
import { getLayoutSnapshot, ROAD_QUERY, POND } from '@/lib/world/layout';
import {
  createHeightfieldContext,
  rasterizeHeightmap,
  classifySurface,
  SURFACE_COBBLE,
  SURFACE_DIRT,
  SURFACE_WOOD,
} from './heightfield';
import type { TerrainWorkerRequest, TerrainWorkerResponse } from './erosion.worker';
import type { SurfaceId } from '@/config/game';

/** Progress phases reported while a world is generating. */
export type GenPhase = 'noise' | 'erosion' | 'meshing' | 'ready';

export interface GenerateOptions {
  seed: string;
  /** Heightmap raster resolution. */
  resolution?: number;
  /** Erosion droplet count; 0 disables the pass. */
  droplets?: number;
  /** Progress callback: phase plus 0..1 within that phase. */
  onProgress?: (phase: GenPhase, value: number) => void;
  /** Abort signal — cancels the worker if the player leaves the loading screen. */
  signal?: AbortSignal;
}

/**
 * A generated world's elevation data plus everything derived from it.
 *
 * Instances are immutable once constructed. Regenerating with a new seed
 * creates a fresh instance rather than mutating this one, so in-flight frames
 * never read a half-updated heightmap.
 */
export class TerrainData {
  /** Row-major elevations, `resolution × resolution`. */
  readonly heights: Float32Array;
  readonly resolution: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  readonly seed: string;

  /** World units per heightmap cell. */
  private readonly cellSize: number;
  /** Cached normals, computed lazily on first use. */
  private normalCache: Float32Array | null = null;

  constructor(
    heights: Float32Array,
    resolution: number,
    minHeight: number,
    maxHeight: number,
    seed: string,
  ) {
    this.heights = heights;
    this.resolution = resolution;
    this.minHeight = minHeight;
    this.maxHeight = maxHeight;
    this.seed = seed;
    this.cellSize = WORLD.SIZE / (resolution - 1);
  }

  /**
   * Ground elevation at a world XZ position, bilinearly interpolated.
   *
   * Out-of-bounds queries clamp to the edge rather than throwing — the player
   * can't leave the map, but wildlife spawn logic occasionally probes past it.
   */
  heightAt(x: number, z: number): number {
    const u = (x + WORLD.HALF) / this.cellSize;
    const v = (z + WORLD.HALF) / this.cellSize;
    return bilinearSample(this.heights, this.resolution, u, v);
  }

  /**
   * Surface normal via central differences on the heightmap.
   *
   * Sampling one cell either side rather than differentiating the analytic
   * noise keeps the normal consistent with the *eroded* surface, which the
   * analytic function knows nothing about.
   */
  normalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const d = this.cellSize;
    const hL = this.heightAt(x - d, z);
    const hR = this.heightAt(x + d, z);
    const hD = this.heightAt(x, z - d);
    const hU = this.heightAt(x, z + d);
    // Cross product of the two tangent vectors, simplified for a heightfield.
    return out.set(hL - hR, 2 * d, hD - hU).normalize();
  }

  /**
   * Slope at a position, `0` = flat, `1` = vertical.
   * Derived from the normal's Y component.
   */
  slopeAt(x: number, z: number): number {
    const n = this.normalAt(x, z, _tmpVec);
    return clamp(1 - n.y, 0, 1);
  }

  /**
   * Ground material at a position, as a footstep surface ID.
   * Bridges the numeric splat IDs to the audio engine's voice names.
   */
  surfaceAt(x: number, z: number): SurfaceId {
    const h = this.heightAt(x, z);
    const slope = this.slopeAt(x, z);
    const road = ROAD_QUERY.nearest(x, z).distance;
    const id = classifySurface(x, z, h, slope, road, VILLAGE.PLAZA_RADIUS);
    switch (id) {
      case SURFACE_COBBLE:
        return 'cobblestone';
      case SURFACE_DIRT:
        return 'dirt';
      case SURFACE_WOOD:
        return 'wood';
      default:
        return 'grass';
    }
  }

  /** `true` if the point lies within the pond's open water. */
  isWater(x: number, z: number): boolean {
    const d = Math.hypot(x - POND.center[0], z - POND.center[1]);
    return d < POND.radius && this.heightAt(x, z) < WORLD.WATER_LEVEL;
  }

  /**
   * Builds the visible terrain mesh.
   *
   * Beyond position and UV, the geometry carries two custom attributes the
   * triplanar shader consumes:
   *
   * - `aSplat` — four blend weights (grass / dirt / rock / sand) computed on the
   *   CPU from slope, altitude and proximity to roads and water. Doing this per
   *   vertex rather than per fragment costs nothing at runtime and lets the
   *   blend respond to *world layout* (roads, plaza) that a purely
   *   slope-driven fragment shader could never know about.
   * - `aOcclusion` — a cheap vertex AO term. For each vertex we compare its
   *   height with a wide neighbourhood average; points sitting below their
   *   surroundings (valley floors, gullies, the streambed) darken. It is not
   *   physically correct, but it costs one extra float per vertex and does more
   *   for readability than any amount of SSAO.
   *
   * @param segments - Subdivisions per axis.
   */
  buildGeometry(segments: number): THREE.BufferGeometry {
    const geo = new THREE.PlaneGeometry(WORLD.SIZE, WORLD.SIZE, segments, segments);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position as THREE.BufferAttribute;
    const count = pos.count;
    const splat = new Float32Array(count * 4);
    const occlusion = new Float32Array(count);

    // Wide sampling radius for the AO comparison — narrow radii just re-derive
    // the local slope and produce a muddy, uniform darkening.
    const aoRadius = this.cellSize * 6;

    for (let i = 0; i < count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = this.heightAt(x, z);
      pos.setY(i, h);

      const slope = this.slopeAt(x, z);
      const roadDist = ROAD_QUERY.nearest(x, z).distance;

      /* ── Splat weights ──────────────────────────────────────────────────── */
      // Grass thrives on gentle, well-drained ground.
      let wGrass = (1 - smoothstep(0.28, 0.62, slope)) * smoothstep(WORLD.WATER_LEVEL + 0.3, WORLD.WATER_LEVEL + 2.6, h);
      // Dirt appears on the road and on the plaza approaches.
      const distToCentre = Math.hypot(x, z);
      let wDirt =
        (1 - smoothstep(2.2, 8.5, roadDist)) * 0.95 +
        (1 - smoothstep(VILLAGE.PLAZA_RADIUS, VILLAGE.PLAZA_RADIUS + 12, distToCentre)) * 0.55;
      // Rock takes over anywhere too steep for soil, and at high altitude.
      let wRock = smoothstep(0.42, 0.72, slope) + smoothstep(28, 40, h) * 0.5;
      // Sand rings the water.
      let wSand = 1 - smoothstep(WORLD.WATER_LEVEL - 0.4, WORLD.WATER_LEVEL + 1.5, h);

      wGrass = Math.max(wGrass, 0.04);
      wDirt = clamp(wDirt, 0, 1);
      wRock = clamp(wRock, 0, 1);
      wSand = clamp(wSand, 0, 1);

      const sum = wGrass + wDirt + wRock + wSand;
      splat[i * 4 + 0] = wGrass / sum;
      splat[i * 4 + 1] = wDirt / sum;
      splat[i * 4 + 2] = wRock / sum;
      splat[i * 4 + 3] = wSand / sum;

      /* ── Vertex AO ──────────────────────────────────────────────────────── */
      let neighbourSum = 0;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        neighbourSum += this.heightAt(x + Math.cos(a) * aoRadius, z + Math.sin(a) * aoRadius);
      }
      const avg = neighbourSum / 8;
      // Sitting 2 units below the neighbourhood → fully occluded (0.55 floor).
      occlusion[i] = clamp(1 - smoothstep(0, 2.4, avg - h) * 0.45, 0.55, 1);
    }

    geo.setAttribute('aSplat', new THREE.BufferAttribute(splat, 4));
    geo.setAttribute('aOcclusion', new THREE.BufferAttribute(occlusion, 1));
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  /**
   * Builds a decimated triangle mesh for the Rapier collider.
   *
   * A trimesh is used rather than Rapier's native heightfield collider for one
   * practical reason: the trimesh takes the exact same vertex ordering as the
   * render mesh, so there is no possibility of the physics surface being
   * transposed or mirrored relative to what the player sees. The cost is a
   * one-off BVH build at load.
   *
   * @param segments - Collision resolution. Lower than the visual mesh; the
   *   sub-decimetre difference is imperceptible under a capsule collider.
   */
  buildColliderMesh(segments: number): { vertices: Float32Array; indices: Uint32Array } {
    const verts = new Float32Array((segments + 1) * (segments + 1) * 3);
    const step = WORLD.SIZE / segments;

    let v = 0;
    for (let j = 0; j <= segments; j++) {
      const z = -WORLD.HALF + j * step;
      for (let i = 0; i <= segments; i++) {
        const x = -WORLD.HALF + i * step;
        verts[v++] = x;
        verts[v++] = this.heightAt(x, z);
        verts[v++] = z;
      }
    }

    const indices = new Uint32Array(segments * segments * 6);
    let t = 0;
    for (let j = 0; j < segments; j++) {
      for (let i = 0; i < segments; i++) {
        const a = j * (segments + 1) + i;
        const b = a + 1;
        const c = a + segments + 1;
        const d = c + 1;
        // Two triangles per quad, counter-clockwise when viewed from above.
        indices[t++] = a;
        indices[t++] = c;
        indices[t++] = b;
        indices[t++] = b;
        indices[t++] = c;
        indices[t++] = d;
      }
    }

    return { vertices: verts, indices };
  }

  /**
   * Packs the heightmap into a `DataTexture` so shaders can sample terrain
   * elevation directly — used by the grass shader to plant blades on the
   * surface without a CPU round-trip per instance.
   */
  buildHeightTexture(): THREE.DataTexture {
    const res = this.resolution;
    const data = new Float32Array(res * res);
    const range = Math.max(1e-3, this.maxHeight - this.minHeight);
    for (let i = 0; i < data.length; i++) {
      data[i] = (this.heights[i]! - this.minHeight) / range;
    }
    const tex = new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.FloatType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }
}

const _tmpVec = new THREE.Vector3();

/**
 * Generates a world, preferring a Web Worker and falling back to the main
 * thread when workers are unavailable (some embedded webviews, older Safari
 * under certain CSP configurations).
 *
 * @throws If generation is aborted via `options.signal`.
 */
export async function generateTerrain(options: GenerateOptions): Promise<TerrainData> {
  const {
    seed,
    resolution = WORLD.HEIGHTMAP_RESOLUTION,
    droplets = 0,
    onProgress,
    signal,
  } = options;

  const polylines = (() => {
    const snap = getLayoutSnapshot();
    return { rail: snap.railPolyline, brook: snap.brookPolyline, road: snap.roadPolyline };
  })();

  const supportsWorker = typeof Worker !== 'undefined';

  if (supportsWorker) {
    try {
      return await new Promise<TerrainData>((resolve, reject) => {
        const worker = new Worker(new URL('./erosion.worker.ts', import.meta.url), {
          type: 'module',
        });

        const cleanup = () => {
          worker.terminate();
          signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          cleanup();
          reject(new DOMException('Terrain generation aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort);

        worker.onmessage = (event: MessageEvent<TerrainWorkerResponse>) => {
          const msg = event.data;
          if (msg.type === 'progress') {
            onProgress?.(msg.phase, msg.value);
          } else if (msg.type === 'done') {
            cleanup();
            onProgress?.('meshing', 0);
            resolve(
              new TerrainData(msg.heights, msg.resolution, msg.minHeight, msg.maxHeight, seed),
            );
          } else if (msg.type === 'error') {
            cleanup();
            reject(new Error(msg.message));
          }
        };

        worker.onerror = (e) => {
          cleanup();
          reject(new Error(`Terrain worker failed: ${e.message}`));
        };

        worker.postMessage({
          type: 'generate',
          seed,
          resolution,
          droplets,
          polylines,
        } satisfies TerrainWorkerRequest);
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      // Fall through to the synchronous path below.
      console.warn('[terrain] Worker path failed, generating on main thread.', err);
    }
  }

  /* ── Main-thread fallback ────────────────────────────────────────────────
   * No erosion here: without a worker this runs on the UI thread and a full
   * erosion pass would visibly hang the tab. The unerodedd terrain is still
   * perfectly playable, just less dramatic. */
  const ctx = createHeightfieldContext(seed, polylines);
  const heights = rasterizeHeightmap(ctx, resolution, (t) => onProgress?.('noise', t));
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i]!;
    if (h < min) min = h;
    if (h > max) max = h;
  }
  onProgress?.('meshing', 0);
  return new TerrainData(heights, resolution, min, max, seed);
}

/**
 * Chooses an erosion droplet budget appropriate to the device.
 * Mobile and low-core machines get a reduced pass so loading stays under ~2 s.
 */
export function pickDropletBudget(baseline: number): number {
  if (typeof navigator === 'undefined') return baseline;
  const cores = navigator.hardwareConcurrency ?? 4;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (mobile) return Math.floor(baseline * 0.3);
  if (cores <= 2) return Math.floor(baseline * 0.35);
  if (cores <= 4) return Math.floor(baseline * 0.65);
  return baseline;
}

/** Spatial hash for O(1) obstacle lookups, used by the player controller. */
export class SpatialHash<T extends { x: number; z: number; radius: number }> {
  private readonly cells = new Map<number, T[]>();
  private readonly cellSize: number;

  constructor(cellSize = PERFORMANCE.SPATIAL_HASH_CELL) {
    this.cellSize = cellSize;
  }

  private key(cx: number, cz: number): number {
    // Cantor-ish pairing into a single number key; fine for our coordinate range.
    return ((cx + 4096) << 13) | (cz + 4096);
  }

  insert(item: T): void {
    const cx = Math.floor(item.x / this.cellSize);
    const cz = Math.floor(item.z / this.cellSize);
    const k = this.key(cx, cz);
    const bucket = this.cells.get(k);
    if (bucket) bucket.push(item);
    else this.cells.set(k, [item]);
  }

  /** Returns every item in the 3×3 cell neighbourhood around a position. */
  query(x: number, z: number, out: T[] = []): T[] {
    out.length = 0;
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = this.cells.get(this.key(cx + dx, cz + dz));
        if (bucket) for (const it of bucket) out.push(it);
      }
    }
    return out;
  }

  clear(): void {
    this.cells.clear();
  }
}
