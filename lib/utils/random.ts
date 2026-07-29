/**
 * Deterministic pseudo-random utilities.
 *
 * Every piece of world generation in Whispering Hollow must be reproducible
 * from a single string seed — two players entering seed `"elderflower"` see the
 * same hills, the same trees, the same coin behind the same fence post. That
 * requires a *seeded* generator rather than `Math.random()`.
 *
 * The generator here is `mulberry32`: a 32-bit state PRNG that is fast, has a
 * period of 2³², and passes the gjrand test suite for the small-state class.
 * It is more than sufficient for procedural placement and far cheaper than a
 * Mersenne Twister.
 *
 * @module lib/utils/random
 */

/**
 * Hashes an arbitrary string into a well-distributed 32-bit unsigned integer
 * using the xmur3 construction.
 *
 * A naive `charCodeAt` sum would map `"ab"` and `"ba"` to the same seed and
 * cluster similar strings together; xmur3 avalanches so that one changed
 * character produces a completely unrelated world.
 *
 * @param str - Any seed string, e.g. `"whispering-hollow"`.
 * @returns A 32-bit unsigned integer suitable for seeding {@link mulberry32}.
 */
export function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** A deterministic random source returning floats in `[0, 1)`. */
export type Rng = () => number;

/**
 * Creates a mulberry32 PRNG from a numeric seed.
 *
 * @param seed - 32-bit unsigned integer, typically from {@link hashSeed}.
 * @returns A function producing uniformly distributed floats in `[0, 1)`.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Convenience wrapper: string seed → PRNG.
 *
 * @param seed - Human-readable world seed.
 * @param salt - Optional discriminator so independent systems (trees, coins,
 *   houses) draw from uncorrelated streams of the same world seed.
 */
export function createRng(seed: string, salt = ''): Rng {
  return mulberry32(hashSeed(seed + '::' + salt));
}

/**
 * A small bundle of shaped-distribution helpers built on one {@link Rng}.
 * Keeping them together avoids threading the raw generator through call sites.
 */
export class RandomSource {
  readonly next: Rng;

  constructor(seed: string, salt = '') {
    this.next = createRng(seed, salt);
  }

  /** Uniform float in `[min, max)`. */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in `[min, max]` inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** `true` with the given probability. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Picks a uniformly random element. Throws on an empty array. */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('RandomSource.pick: empty array');
    return arr[Math.floor(this.next() * arr.length)]!;
  }

  /**
   * Picks an element using per-item weights.
   * @param arr - Candidates.
   * @param weights - Non-negative weights, same length as `arr`.
   */
  weighted<T>(arr: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i] ?? 0;
      if (r <= 0) return arr[i]!;
    }
    return arr[arr.length - 1]!;
  }

  /**
   * Approximately normal (Gaussian) sample via the Box–Muller transform.
   * Used for organic scale/hue jitter where a uniform distribution looks
   * artificially flat.
   */
  gaussian(mean = 0, stdDev = 1): number {
    // Guard against log(0).
    const u1 = Math.max(this.next(), 1e-9);
    const u2 = this.next();
    return mean + stdDev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** Uniform angle in `[0, 2π)`. */
  angle(): number {
    return this.next() * Math.PI * 2;
  }

  /**
   * Uniform point inside a disc of the given radius.
   * The `sqrt` is essential — without it points bunch toward the centre.
   */
  insideDisc(radius: number): [number, number] {
    const a = this.angle();
    const r = radius * Math.sqrt(this.next());
    return [Math.cos(a) * r, Math.sin(a) * r];
  }

  /** Fisher–Yates shuffle, returning a new array. */
  shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  /** Random hex colour string, useful for ghost-avatar tinting. */
  hexColor(saturation = 0.6, lightness = 0.65): string {
    const h = this.next();
    const [r, g, b] = hslToRgb(h, saturation, lightness);
    return (
      '#' +
      [r, g, b]
        .map((c) =>
          Math.round(c * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')
    );
  }
}

/**
 * HSL → RGB, all channels normalised to `[0, 1]`.
 * Standard formulation; kept local so this module has no three.js dependency
 * and can be used inside Web Workers.
 */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}

/**
 * Poisson-disc-ish blue-noise sampling via dart throwing on a spatial grid.
 *
 * True Bridson sampling is overkill here; we only need placements that don't
 * visibly clump. Dart throwing with a grid-accelerated rejection test converges
 * fast at the densities we use (a few hundred trees over 400²) and, crucially,
 * is deterministic given the same `Rng`.
 *
 * @param rng - Deterministic random source.
 * @param count - Desired number of points (may return fewer if space runs out).
 * @param minDist - Minimum separation between any two points.
 * @param bounds - `[minX, minZ, maxX, maxZ]` sampling rectangle.
 * @param accept - Optional predicate to reject a candidate (slope, zone, …).
 * @param maxAttemptsPerPoint - Dart-throwing budget before giving up on a point.
 * @returns Array of `[x, z]` positions.
 */
export function blueNoise(
  rng: Rng,
  count: number,
  minDist: number,
  bounds: [number, number, number, number],
  accept?: (x: number, z: number) => boolean,
  maxAttemptsPerPoint = 24,
): Array<[number, number]> {
  const [minX, minZ, maxX, maxZ] = bounds;
  const cell = minDist / Math.SQRT2;
  const cols = Math.max(1, Math.ceil((maxX - minX) / cell));
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / cell));
  // Grid stores the index of the point occupying each cell, or -1.
  const grid = new Int32Array(cols * rows).fill(-1);
  const points: Array<[number, number]> = [];
  const minDistSq = minDist * minDist;

  const fits = (x: number, z: number): boolean => {
    const cx = Math.floor((x - minX) / cell);
    const cz = Math.floor((z - minZ) / cell);
    // A point can only conflict with neighbours within 2 cells in each axis.
    const x0 = Math.max(0, cx - 2);
    const x1 = Math.min(cols - 1, cx + 2);
    const z0 = Math.max(0, cz - 2);
    const z1 = Math.min(rows - 1, cz + 2);
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const idx = grid[gz * cols + gx]!;
        if (idx === -1) continue;
        const p = points[idx]!;
        const dx = p[0] - x;
        const dz = p[1] - z;
        if (dx * dx + dz * dz < minDistSq) return false;
      }
    }
    return true;
  };

  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < maxAttemptsPerPoint; attempt++) {
      const x = minX + rng() * (maxX - minX);
      const z = minZ + rng() * (maxZ - minZ);
      if (accept && !accept(x, z)) continue;
      if (!fits(x, z)) continue;
      const cx = Math.floor((x - minX) / cell);
      const cz = Math.floor((z - minZ) / cell);
      grid[cz * cols + cx] = points.length;
      points.push([x, z]);
      break;
    }
  }
  return points;
}
