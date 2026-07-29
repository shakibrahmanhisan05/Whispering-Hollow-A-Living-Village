/**
 * Pure Catmull–Rom spline evaluation and a distance-query accelerator.
 *
 * This module deliberately has **no three.js dependency** so it can run inside
 * the terrain Web Worker, which must carve the railway cutting before any
 * renderer exists. `components/scene/Train/Track.tsx` wraps the same control
 * points in a `THREE.CatmullRomCurve3` for rendering; both agree because they
 * evaluate the same centripetal formulation.
 *
 * @module lib/utils/curve
 */

/** A point in 3D space as a plain tuple — structured-clone friendly. */
export type Pt3 = [number, number, number];

/**
 * Evaluates a Catmull–Rom segment between `p1` and `p2`.
 *
 * Uses the **centripetal** parameterisation (alpha = 0.5). Uniform Catmull–Rom
 * (alpha = 0) produces cusps and self-intersections when control points are
 * unevenly spaced — exactly what happens on a hand-placed railway. Centripetal
 * is provably cusp-free, which is why the train never jerks at a control point.
 *
 * @param p0 - Point before the segment (tangent support).
 * @param p1 - Segment start.
 * @param p2 - Segment end.
 * @param p3 - Point after the segment (tangent support).
 * @param t - Parameter within the segment, `[0, 1]`.
 * @param alpha - Knot parameterisation exponent. 0.5 = centripetal.
 */
export function catmullRomSegment(
  p0: Pt3,
  p1: Pt3,
  p2: Pt3,
  p3: Pt3,
  t: number,
  alpha = 0.5,
): Pt3 {
  const knot = (ti: number, a: Pt3, b: Pt3): number => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // Degenerate (duplicate) control points would divide by zero.
    return ti + Math.pow(Math.max(d, 1e-6), alpha);
  };

  const t0 = 0;
  const t1 = knot(t0, p0, p1);
  const t2 = knot(t1, p1, p2);
  const t3 = knot(t2, p2, p3);
  const tt = t1 + (t2 - t1) * t;

  const mix = (a: Pt3, b: Pt3, ta: number, tb: number, x: number): Pt3 => {
    const d = tb - ta;
    if (Math.abs(d) < 1e-9) return [a[0], a[1], a[2]];
    const w1 = (tb - x) / d;
    const w2 = (x - ta) / d;
    return [a[0] * w1 + b[0] * w2, a[1] * w1 + b[1] * w2, a[2] * w1 + b[2] * w2];
  };

  const a1 = mix(p0, p1, t0, t1, tt);
  const a2 = mix(p1, p2, t1, t2, tt);
  const a3 = mix(p2, p3, t2, t3, tt);
  const b1 = mix(a1, a2, t0, t2, tt);
  const b2 = mix(a2, a3, t1, t3, tt);
  return mix(b1, b2, t1, t2, tt);
}

/**
 * Samples an open Catmull–Rom spline through `points` into a polyline.
 *
 * The first and last control points are duplicated to provide tangent support,
 * so the curve passes exactly through every supplied point.
 *
 * @param points - Control points, at least two.
 * @param samplesPerSegment - Polyline resolution per control-point interval.
 * @returns Flat polyline of sampled positions.
 */
export function sampleCatmullRom(points: readonly Pt3[], samplesPerSegment = 24): Pt3[] {
  if (points.length < 2) return points.map((p) => [...p] as Pt3);
  const out: Pt3[] = [];
  const n = points.length;
  const at = (i: number): Pt3 => points[Math.max(0, Math.min(n - 1, i))]!;

  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    // Skip the duplicate endpoint on all but the final segment.
    const steps = i === n - 2 ? samplesPerSegment : samplesPerSegment - 1;
    for (let s = 0; s <= steps; s++) {
      out.push(catmullRomSegment(p0, p1, p2, p3, s / samplesPerSegment));
    }
  }
  return out;
}

/** Cumulative arc lengths along a polyline; `lengths[i]` is the distance to `poly[i]`. */
export function arcLengths(poly: readonly Pt3[]): Float64Array {
  const out = new Float64Array(poly.length);
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    out[i] = out[i - 1]! + Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return out;
}

/** Result of a nearest-point query against a {@link PolylineQuery}. */
export interface NearestResult {
  /** Perpendicular distance in the XZ plane. */
  distance: number;
  /** Interpolated Y of the closest point on the polyline. */
  height: number;
  /** Arc length along the polyline at the closest point. */
  along: number;
  /** Index of the polyline segment that produced the hit. */
  segment: number;
}

/**
 * Accelerated nearest-point-on-polyline queries in the XZ plane.
 *
 * Terrain generation asks "how far is this cell from the railway?" once per
 * heightmap texel — 262 144 times for a 512² map. A brute-force scan over a
 * 500-segment polyline would be 130 M distance tests. Instead we bucket
 * segments into a uniform grid over their bounding boxes and only test the
 * buckets a query actually touches, which brings it down to a handful of tests
 * per query.
 */
export class PolylineQuery {
  private readonly poly: Pt3[];
  private readonly lengths: Float64Array;
  private readonly cellSize: number;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly cols: number;
  private readonly rows: number;
  /** For each grid cell, the list of segment indices whose AABB overlaps it. */
  private readonly buckets: number[][];

  /**
   * @param poly - Sampled polyline.
   * @param cellSize - Grid cell edge. Should be ≥ the query radius of interest.
   */
  constructor(poly: readonly Pt3[], cellSize = 24) {
    this.poly = poly.map((p) => [...p] as Pt3);
    this.lengths = arcLengths(this.poly);
    this.cellSize = cellSize;

    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const p of this.poly) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[2] < minZ) minZ = p[2];
      if (p[2] > maxZ) maxZ = p[2];
    }
    // Pad so queries slightly outside the curve's extent still land in a cell.
    const pad = cellSize * 2;
    this.minX = minX - pad;
    this.minZ = minZ - pad;
    this.cols = Math.max(1, Math.ceil((maxX + pad - this.minX) / cellSize));
    this.rows = Math.max(1, Math.ceil((maxZ + pad - this.minZ) / cellSize));
    this.buckets = Array.from({ length: this.cols * this.rows }, () => [] as number[]);

    for (let i = 0; i < this.poly.length - 1; i++) {
      const a = this.poly[i]!;
      const b = this.poly[i + 1]!;
      const x0 = Math.floor((Math.min(a[0], b[0]) - this.minX) / cellSize);
      const x1 = Math.floor((Math.max(a[0], b[0]) - this.minX) / cellSize);
      const z0 = Math.floor((Math.min(a[2], b[2]) - this.minZ) / cellSize);
      const z1 = Math.floor((Math.max(a[2], b[2]) - this.minZ) / cellSize);
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (x < 0 || z < 0 || x >= this.cols || z >= this.rows) continue;
          this.buckets[z * this.cols + x]!.push(i);
        }
      }
    }
  }

  /** Total arc length of the polyline. */
  get totalLength(): number {
    return this.lengths[this.lengths.length - 1] ?? 0;
  }

  /**
   * Finds the closest point on the polyline to `(x, z)` in the XZ plane.
   *
   * Searches the query cell plus a one-cell ring. If that ring is empty (the
   * point is far from the curve) the search widens until segments are found or
   * the whole grid has been covered, so the result is always correct — just
   * slower for very distant queries, which terrain gen does not perform.
   */
  nearest(x: number, z: number): NearestResult {
    const cx = Math.floor((x - this.minX) / this.cellSize);
    const cz = Math.floor((z - this.minZ) / this.cellSize);

    let best = Infinity;
    let bestSeg = 0;
    let bestT = 0;

    const testRing = (ring: number): boolean => {
      let found = false;
      const x0 = cx - ring;
      const x1 = cx + ring;
      const z0 = cz - ring;
      const z1 = cz + ring;
      for (let gz = z0; gz <= z1; gz++) {
        if (gz < 0 || gz >= this.rows) continue;
        for (let gx = x0; gx <= x1; gx++) {
          if (gx < 0 || gx >= this.cols) continue;
          // Only the perimeter of the ring is new on iterations > 0.
          if (ring > 0 && gx !== x0 && gx !== x1 && gz !== z0 && gz !== z1) continue;
          const bucket = this.buckets[gz * this.cols + gx]!;
          for (const i of bucket) {
            found = true;
            const a = this.poly[i]!;
            const b = this.poly[i + 1]!;
            const abx = b[0] - a[0];
            const abz = b[2] - a[2];
            const lenSq = abx * abx + abz * abz;
            let t = 0;
            if (lenSq > 1e-12) {
              t = ((x - a[0]) * abx + (z - a[2]) * abz) / lenSq;
              t = t < 0 ? 0 : t > 1 ? 1 : t;
            }
            const px = a[0] + abx * t;
            const pz = a[2] + abz * t;
            const dx = x - px;
            const dz = z - pz;
            const dSq = dx * dx + dz * dz;
            if (dSq < best) {
              best = dSq;
              bestSeg = i;
              bestT = t;
            }
          }
        }
      }
      return found;
    };

    let ring = 0;
    let sawAny = false;
    const maxRing = Math.max(this.cols, this.rows);
    while (ring <= maxRing) {
      const found = testRing(ring);
      sawAny = sawAny || found;
      // One extra ring after the first hit guarantees we didn't miss a closer
      // segment sitting just across a cell boundary.
      if (sawAny && ring > 0 && best < Infinity) break;
      ring++;
    }

    const a = this.poly[bestSeg]!;
    const b = this.poly[bestSeg + 1] ?? a;
    const height = a[1] + (b[1] - a[1]) * bestT;
    const segLen = (this.lengths[bestSeg + 1] ?? 0) - (this.lengths[bestSeg] ?? 0);
    const along = (this.lengths[bestSeg] ?? 0) + segLen * bestT;

    return { distance: Math.sqrt(best), height, along, segment: bestSeg };
  }

  /** Position at a given arc length, by linear search over cached lengths. */
  pointAtLength(len: number): Pt3 {
    const total = this.totalLength;
    const target = Math.max(0, Math.min(total, len));
    // Binary search the cumulative-length array.
    let lo = 0;
    let hi = this.lengths.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.lengths[mid]! <= target) lo = mid;
      else hi = mid;
    }
    const a = this.poly[lo]!;
    const b = this.poly[hi] ?? a;
    const segLen = this.lengths[hi]! - this.lengths[lo]!;
    const t = segLen > 1e-9 ? (target - this.lengths[lo]!) / segLen : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
}
