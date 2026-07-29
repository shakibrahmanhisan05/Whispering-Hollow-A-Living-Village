/**
 * Fixed world landmarks: the railway alignment, the pond basin, the ridge, the
 * dirt road and the level crossing.
 *
 * These are **hand-authored**, not procedural. The seed varies the hills, the
 * trees and the scatter — but the shape of the valley, where the train runs and
 * where the village sits are composed for the view, because a fully random
 * layout never produces a silhouette worth stopping to look at.
 *
 * This module is pure and worker-safe (no three.js, no DOM).
 *
 * @module lib/world/layout
 */

import { PolylineQuery, sampleCatmullRom, type Pt3 } from '@/lib/utils/curve';
import { ZONES } from '@/config/game';

/* ───────────────────────────────────────────────────────────────────────────
 * RAILWAY
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Base elevation of the railway at a given world X.
 *
 * Real railways refuse to climb: they cut through hills and bridge valleys to
 * hold a near-constant grade. Encoding that as a gentle function of X (rather
 * than following the terrain) is what produces the embankments and cuttings
 * that make the line read as *engineered*. The terrain generator blends toward
 * this profile near the track — see `lib/terrain/heightfield.ts`.
 *
 * @param x - World X coordinate.
 * @returns Rail-top elevation in world units.
 */
export function railHeightAt(x: number): number {
  return 8.4 + Math.sin(x * 0.0072) * 2.1 + Math.sin(x * 0.0031 + 1.4) * 1.2;
}

/**
 * Railway control points in XZ. The line sweeps in from the west, dips south to
 * skirt the village, then climbs away north-east past the wheatfield — so the
 * train is visible from the plaza, the ridge and the windmill alike.
 *
 * Extends well beyond the world edge at both ends so the train has somewhere to
 * come from and go to.
 */
const RAIL_XZ: Array<[number, number]> = [
  [-300, 128],
  [-232, 112],
  [-166, 92],
  [-104, 74],
  [-46, 62],
  [12, 57],
  [70, 60],
  [126, 72],
  [182, 92],
  [240, 118],
  [300, 148],
];

/** Railway control points with elevation resolved from {@link railHeightAt}. */
export const RAIL_CONTROL_POINTS: Pt3[] = RAIL_XZ.map(([x, z]) => [x, railHeightAt(x), z]);

/** Densely sampled railway polyline, shared by terrain carving and rendering. */
export const RAIL_POLYLINE: Pt3[] = sampleCatmullRom(RAIL_CONTROL_POINTS, 40);

/**
 * Spatial accelerator for "how far from the track is this point?" queries.
 *
 * Constructed once at module load. It is used hundreds of thousands of times
 * during heightmap generation, so the up-front bucketing pays for itself many
 * times over.
 */
export const RAIL_QUERY = new PolylineQuery(RAIL_POLYLINE, 28);

/**
 * Where the village road crosses the railway. The barrier, bell, lights and
 * station shelter are all placed relative to this point.
 */
export const LEVEL_CROSSING: { x: number; z: number } = { x: 12, z: 57 };

/** Station shelter position — trackside, just east of the crossing. */
export const STATION: { x: number; z: number } = { x: 42, z: 52 };

/* ───────────────────────────────────────────────────────────────────────────
 * WATER
 * ─────────────────────────────────────────────────────────────────────────── */

/** The reflective pond in the Brook & Pond zone. */
export const POND = {
  center: [ZONES.BROOK_AND_POND.center[0], ZONES.BROOK_AND_POND.center[1]] as [number, number],
  /** Radius of the open water surface. */
  radius: 21,
  /** Radius over which the basin blends back into the surrounding terrain. */
  falloff: 17,
  /** Depth of the basin below the water level. */
  depth: 3.4,
} as const;

/**
 * The brook: spills off the ridge shoulder, meanders north-east, feeds the pond.
 * Y values are placeholders — the terrain generator resolves the true streambed
 * elevation, and `Water.tsx` samples the finished heightmap.
 */
const BROOK_XZ: Array<[number, number]> = [
  [-158, -108],
  [-138, -96],
  [-116, -86],
  [-96, -74],
  [-82, -66],
  [-72, -62],
];

export const BROOK_CONTROL_POINTS: Pt3[] = BROOK_XZ.map(([x, z]) => [x, 0, z]);
export const BROOK_POLYLINE: Pt3[] = sampleCatmullRom(BROOK_CONTROL_POINTS, 26);
export const BROOK_QUERY = new PolylineQuery(BROOK_POLYLINE, 20);

/** Half-width of the carved streambed. */
export const BROOK_WIDTH = 3.1;
/** Distance over which the streambed blends back into the hillside. */
export const BROOK_FALLOFF = 9;
/** How far below the surrounding terrain the streambed is cut. */
export const BROOK_DEPTH = 1.35;

/* ───────────────────────────────────────────────────────────────────────────
 * RIDGE
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The Ridge — a deliberate, guaranteed high point. Procedural noise alone can
 * not be relied upon to put a viewpoint where the bench, the flag and the
 * wind-chime need to be, so we add an explicit Gaussian bump.
 */
export const RIDGE = {
  center: [ZONES.THE_RIDGE.center[0], ZONES.THE_RIDGE.center[1]] as [number, number],
  /** Peak height added on top of the base terrain. */
  amplitude: 27,
  /** Standard deviation of the Gaussian, in world units. */
  sigma: 44,
  /** Radius of the small flattened shelf at the summit for the bench. */
  plateauRadius: 11,
} as const;

/** Where the stone bench, flagpole and wind-chime stand on the ridge shelf. */
export const RIDGE_BENCH: { x: number; z: number; yaw: number } = {
  x: RIDGE.center[0] + 4,
  z: RIDGE.center[1] + 5,
  // Faces back down the valley toward the village and the railway.
  yaw: Math.atan2(0 - (RIDGE.center[1] + 5), 0 - (RIDGE.center[0] + 4)),
};

/* ───────────────────────────────────────────────────────────────────────────
 * ROADS
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The dirt road: runs from the south-east grove, through the village plaza,
 * north over the level crossing and away. Used for surface classification
 * (footstep sounds), the fox's night patrol, and light terrain smoothing.
 */
const ROAD_XZ: Array<[number, number]> = [
  [104, -84],
  [76, -58],
  [48, -34],
  [24, -14],
  [4, 2],
  [2, 20],
  [8, 38],
  [LEVEL_CROSSING.x, LEVEL_CROSSING.z],
  [16, 76],
  [24, 104],
  [38, 136],
];

export const ROAD_CONTROL_POINTS: Pt3[] = ROAD_XZ.map(([x, z]) => [x, 0, z]);
export const ROAD_POLYLINE: Pt3[] = sampleCatmullRom(ROAD_CONTROL_POINTS, 20);
export const ROAD_QUERY = new PolylineQuery(ROAD_POLYLINE, 22);

/** Half-width of the walkable dirt road. */
export const ROAD_WIDTH = 2.6;
/** Distance over which the road's terrain smoothing fades out. */
export const ROAD_FALLOFF = 5.5;

/* ───────────────────────────────────────────────────────────────────────────
 * SERIALISABLE SNAPSHOT
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The subset of the layout the terrain worker needs.
 *
 * `PolylineQuery` instances contain closures and typed arrays that do not
 * survive `structuredClone`, so the worker receives raw polylines and rebuilds
 * its own accelerators on the other side.
 */
export interface LayoutSnapshot {
  railPolyline: Pt3[];
  brookPolyline: Pt3[];
  roadPolyline: Pt3[];
}

/** Builds the worker-transferable layout snapshot. */
export function getLayoutSnapshot(): LayoutSnapshot {
  return {
    railPolyline: RAIL_POLYLINE,
    brookPolyline: BROOK_POLYLINE,
    roadPolyline: ROAD_POLYLINE,
  };
}
