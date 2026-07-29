/**
 * Performance instrumentation and frame-budget helpers.
 *
 * @module lib/utils/perf
 */

import { PERFORMANCE } from '@/config/game';

/**
 * A fixed-rate throttle for `useFrame` callbacks.
 *
 * Cloud drift, distant bird flapping and reflection probes do not need to run
 * at display refresh. Gating them behind a `Throttle` at 10–15 Hz frees a
 * meaningful slice of the frame budget with no visible difference.
 *
 * @example
 * ```ts
 * const cloudTick = useMemo(() => new Throttle(CLOUDS.UPDATE_HZ), []);
 * useFrame((_, dt) => {
 *   if (!cloudTick.step(dt)) return;
 *   // ...runs at ~10 Hz, with cloudTick.elapsed as the true delta
 * });
 * ```
 */
export class Throttle {
  private accumulator = 0;
  private readonly interval: number;
  /** Seconds elapsed since the previous successful step. */
  elapsed = 0;

  constructor(hz: number) {
    this.interval = hz > 0 ? 1 / hz : 0;
  }

  /**
   * Advances the throttle.
   * @param dt - Frame delta in seconds.
   * @returns `true` when the caller should do its work this frame.
   */
  step(dt: number): boolean {
    if (this.interval <= 0) {
      this.elapsed = dt;
      return true;
    }
    this.accumulator += dt;
    if (this.accumulator < this.interval) return false;
    this.elapsed = this.accumulator;
    // Subtracting (rather than zeroing) preserves the long-run average rate.
    this.accumulator %= this.interval;
    return true;
  }
}

/**
 * Distributes work across frames by processing a slice of a list each tick.
 * Used for staggered LOD re-evaluation over hundreds of tree instances.
 */
export class RoundRobin {
  private cursor = 0;
  constructor(private readonly sliceSize: number) {}

  /**
   * Invokes `fn` for the next `sliceSize` indices, wrapping around.
   * @returns `true` once a full pass over `total` has completed.
   */
  step(total: number, fn: (index: number) => void): boolean {
    if (total <= 0) return true;
    const n = Math.min(this.sliceSize, total);
    let wrapped = false;
    for (let i = 0; i < n; i++) {
      fn(this.cursor);
      this.cursor++;
      if (this.cursor >= total) {
        this.cursor = 0;
        wrapped = true;
      }
    }
    return wrapped;
  }
}

/**
 * Rolling FPS estimator with hysteresis, driving adaptive quality.
 *
 * Hysteresis matters: a single stutter (a GC pause, a texture upload) must not
 * drop the player to Low, and a brief calm must not immediately restore
 * Cinematic. Requiring several seconds of *sustained* over- or under-shoot
 * before acting keeps quality stable instead of oscillating.
 */
export class AdaptiveQualityMonitor {
  private samples: number[] = [];
  private lowTime = 0;
  private highTime = 0;

  /**
   * @param onDownshift - Called after sustained low FPS.
   * @param onUpshift - Called after sustained high FPS.
   */
  constructor(
    private readonly onDownshift: () => void,
    private readonly onUpshift: () => void,
  ) {}

  /** Feed one frame delta. */
  update(dt: number): void {
    if (dt <= 0) return;
    const fps = 1 / dt;
    this.samples.push(fps);
    if (this.samples.length > 90) this.samples.shift();

    // Median is far more robust than the mean against single-frame spikes.
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 60;

    if (median < PERFORMANCE.DOWNSHIFT_FPS) {
      this.lowTime += dt;
      this.highTime = 0;
      if (this.lowTime >= PERFORMANCE.DOWNSHIFT_HOLD) {
        this.lowTime = 0;
        this.samples.length = 0;
        this.onDownshift();
      }
    } else if (median > PERFORMANCE.UPSHIFT_FPS) {
      this.highTime += dt;
      this.lowTime = 0;
      if (this.highTime >= PERFORMANCE.UPSHIFT_HOLD) {
        this.highTime = 0;
        this.samples.length = 0;
        this.onUpshift();
      }
    } else {
      this.lowTime = 0;
      this.highTime = 0;
    }
  }

  reset(): void {
    this.samples.length = 0;
    this.lowTime = 0;
    this.highTime = 0;
  }
}

/** Coarse device capability tiers used to pick a starting quality preset. */
export type DeviceTier = 'potato' | 'low' | 'medium' | 'high';

/**
 * Guesses a sensible starting quality from what the browser will tell us.
 *
 * This is a heuristic, not a benchmark — its only job is to avoid opening on
 * Cinematic on a phone. The adaptive monitor corrects it within seconds.
 */
export function detectDeviceTier(): DeviceTier {
  if (typeof navigator === 'undefined') return 'medium';

  const ua = navigator.userAgent;
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const cores = navigator.hardwareConcurrency ?? 4;
  // `deviceMemory` is Chromium-only; absence is not a signal either way.
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;

  if (isMobile) {
    if (cores <= 4 || memory <= 3) return 'potato';
    return 'low';
  }
  if (cores <= 2 || memory <= 2) return 'potato';
  if (cores <= 4 || memory <= 4) return 'low';
  if (cores <= 8 || memory <= 8) return 'medium';
  return 'high';
}

/**
 * Detects WebGPU availability.
 *
 * Note this only reports *support*. Whispering Hollow keeps WebGPU behind the
 * `NEXT_PUBLIC_ENABLE_WEBGPU` flag because the R3F WebGPU renderer path does
 * not yet support the full postprocessing stack this game relies on.
 */
export async function detectWebGPU(): Promise<boolean> {
  const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } };
  if (!nav.gpu) return false;
  try {
    const adapter = await nav.gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}

/**
 * Detects WebGL2, the hard requirement for the game to run at all.
 *
 * The result is cached and the probe context is **explicitly released**.
 * Browsers cap the number of simultaneously live WebGL contexts (Chrome allows
 * 16) and evict the *oldest* when that cap is exceeded — so a leaked probe
 * context is not merely wasteful, it can get the game's own renderer killed.
 * `WEBGL_lose_context` is the only way to free one deterministically; dropping
 * the reference and waiting for GC is not good enough.
 */
let webgl2Support: boolean | null = null;

export function detectWebGL2(): boolean {
  if (webgl2Support !== null) return webgl2Support;
  if (typeof document === 'undefined') return false;

  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    webgl2Support = !!gl;
    if (gl) {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    return webgl2Support;
  } catch {
    webgl2Support = false;
    return false;
  }
}

/** `true` when the Pointer Lock API is usable in this context. */
export function supportsPointerLock(): boolean {
  return typeof document !== 'undefined' && 'pointerLockElement' in document;
}

/** `true` when the Web Audio API is available. */
export function supportsWebAudio(): boolean {
  return (
    typeof window !== 'undefined' &&
    (typeof window.AudioContext !== 'undefined' ||
      typeof (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext !==
        'undefined')
  );
}

/** Clamped device pixel ratio honouring the resolution-scale setting. */
export function computeDpr(resolutionScale: number): number {
  if (typeof window === 'undefined') return 1;
  return Math.min(window.devicePixelRatio * resolutionScale, PERFORMANCE.MAX_DPR);
}
