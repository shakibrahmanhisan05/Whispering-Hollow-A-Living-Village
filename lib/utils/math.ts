/**
 * Framerate-independent interpolation and general math helpers.
 *
 * The most important export here is {@link damp}. Naive smoothing of the form
 * `x += (target - x) * 0.1` is *framerate dependent*: at 120 FPS it converges
 * twice as fast as at 60 FPS, so camera feel changes with the player's monitor.
 * `damp` uses an exponential decay expressed as a half-life, which is exact
 * under any timestep.
 *
 * @module lib/utils/math
 */

/** Clamps `v` to `[min, max]`. */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Clamps `v` to `[0, 1]`. */
export function saturate(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse lerp: where does `v` sit between `a` and `b`, as `[0, 1]`? */
export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : saturate((v - a) / (b - a));
}

/** Re-maps `v` from one range to another, clamped to the output range. */
export function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number) {
  return lerp(outMin, outMax, invLerp(inMin, inMax, v));
}

/** Hermite smoothstep between two edges. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = invLerp(edge0, edge1, x);
  return t * t * (3 - 2 * t);
}

/** Quintic smootherstep — zero 1st *and* 2nd derivative at the edges. */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = invLerp(edge0, edge1, x);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Framerate-independent exponential smoothing.
 *
 * `halfLife` is the time in seconds for the remaining distance to `target` to
 * halve. The decay factor is `2^(-dt / halfLife)`, which composes correctly
 * across arbitrary timesteps: two 8 ms steps produce exactly the same result as
 * one 16 ms step.
 *
 * @param current - Current value.
 * @param target - Value being approached.
 * @param halfLife - Seconds to close half the gap. Smaller = snappier.
 * @param dt - Delta time in seconds.
 */
export function damp(current: number, target: number, halfLife: number, dt: number): number {
  if (halfLife <= 0) return target;
  return target + (current - target) * Math.pow(2, -dt / halfLife);
}

/**
 * Angular variant of {@link damp} that takes the shortest path around the
 * circle, so rotating from 350° to 10° goes forward through 0 rather than
 * backwards through 180.
 */
export function dampAngle(current: number, target: number, halfLife: number, dt: number): number {
  const delta = shortestAngle(current, target);
  return damp(current, current + delta, halfLife, dt);
}

/** Signed shortest angular difference from `a` to `b`, in `(-π, π]`. */
export function shortestAngle(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Wraps `v` into `[0, max)`, correct for negative inputs. */
export function wrap(v: number, max: number): number {
  return ((v % max) + max) % max;
}

/**
 * Cyclic linear interpolation across a normalised `[0, 1)` axis — used for
 * time-of-day blending, where 0.98 → 0.02 should cross midnight rather than
 * sweeping backwards through the whole day.
 */
export function lerpCyclic(a: number, b: number, t: number, period = 1): number {
  let d = b - a;
  if (d > period / 2) d -= period;
  if (d < -period / 2) d += period;
  return wrap(a + d * t, period);
}

/** Degrees → radians. */
export const DEG2RAD = Math.PI / 180;
/** Radians → degrees. */
export const RAD2DEG = 180 / Math.PI;

/**
 * Converts a vertical FOV in degrees to the equivalent 35 mm focal length,
 * so photo mode can present a familiar "24 mm / 50 mm / 85 mm" control.
 * Uses the 24 mm film height.
 */
export function fovToFocalLength(fovDeg: number): number {
  return 12 / Math.tan((fovDeg * DEG2RAD) / 2);
}

/** Inverse of {@link fovToFocalLength}. */
export function focalLengthToFov(mm: number): number {
  return 2 * Math.atan(12 / mm) * RAD2DEG;
}

/**
 * A tiny 1D value-noise function used for camera shake and gust envelopes,
 * where a full simplex evaluation would be wasteful.
 * Deterministic for a given `x`, smooth, and roughly in `[-1, 1]`.
 */
export function noise1D(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const h = (n: number) => {
    const s = Math.sin(n * 127.1) * 43758.5453123;
    return (s - Math.floor(s)) * 2 - 1;
  };
  return lerp(h(i), h(i + 1), u);
}

/**
 * Layered {@link noise1D} — a cheap 1D fBm. Used for the wind gust envelope
 * and the perlin-driven camera tremble as the train approaches.
 *
 * @param x - Input coordinate (usually time).
 * @param octaves - Number of layers.
 * @param lacunarity - Frequency multiplier per octave.
 * @param gain - Amplitude multiplier per octave.
 */
export function fbm1D(x: number, octaves = 3, lacunarity = 2.1, gain = 0.5): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise1D(x * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm === 0 ? 0 : sum / norm;
}

/**
 * Bilinear sample of a flat 2D `Float32Array` grid.
 *
 * Used to read the generated heightmap at arbitrary world positions. Bilinear
 * (rather than nearest) is what makes the ground feel continuous under the
 * player's feet instead of stepped.
 *
 * @param data - Row-major grid of `size × size` values.
 * @param size - Grid edge length in samples.
 * @param u - Horizontal coordinate in grid space, `[0, size - 1]`.
 * @param v - Vertical coordinate in grid space, `[0, size - 1]`.
 */
export function bilinearSample(data: Float32Array, size: number, u: number, v: number): number {
  const cu = clamp(u, 0, size - 1.0001);
  const cv = clamp(v, 0, size - 1.0001);
  const x0 = Math.floor(cu);
  const z0 = Math.floor(cv);
  const x1 = Math.min(x0 + 1, size - 1);
  const z1 = Math.min(z0 + 1, size - 1);
  const fx = cu - x0;
  const fz = cv - z0;

  const h00 = data[z0 * size + x0]!;
  const h10 = data[z0 * size + x1]!;
  const h01 = data[z1 * size + x0]!;
  const h11 = data[z1 * size + x1]!;

  return lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fz);
}

/** Converts a `#rrggbb` string to normalised `[r, g, b]`. */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h,
    16,
  );
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Converts normalised `[r, g, b]` to a `#rrggbb` string. */
export function rgbToHex(r: number, g: number, b: number): string {
  const to = (c: number) =>
    Math.round(saturate(c) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Linearly blends two `#rrggbb` colours. */
export function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex(lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerp(ca[2], cb[2], t));
}

/** Formats seconds as `M:SS`, for playtime displays. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/**
 * Formats a normalised time-of-day (`0` = midnight, `0.5` = noon) as a 24-hour
 * clock string.
 */
export function formatTimeOfDay(t: number): string {
  const total = wrap(t, 1) * 24 * 60;
  const h = Math.floor(total / 60);
  const m = Math.floor(total % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}
