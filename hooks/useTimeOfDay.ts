/**
 * The day/night cycle and its derived lighting.
 *
 * Advances the world clock and resolves it into everything the renderer needs:
 * sun and moon directions, light colours and intensities, fog, sky tint,
 * exposure and the star field's opacity.
 *
 * Colours are produced by blending between the five authored
 * {@link LIGHTING_STATES} rather than by evaluating a physical sky model on the
 * CPU. Hand-authored key frames are the right call here: a physically correct
 * sunset is often muddy, whereas these five states were chosen to look like the
 * reference art at every point between them.
 *
 * @module hooks/useTimeOfDay
 */

'use client';

import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { LIGHTING_STATES, TIME, WEATHER, SEASONS, TERRAIN_NOISE } from '@/config/game';
import { useGameStore } from '@/store/gameStore';
import { useSettingsStore } from '@/store/settingsStore';
import { clamp, wrap, lerp, smoothstep, invLerp } from '@/lib/utils/math';

/** Everything the scene needs to light a frame. */
export interface LightingState {
  /** Normalised time, 0..1. */
  t: number;
  /** Unit vector pointing *from* the world *to* the sun. */
  sunDirection: THREE.Vector3;
  /** Unit vector pointing to the moon (opposite the sun, with a tilt offset). */
  moonDirection: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  ambientColor: THREE.Color;
  ambientIntensity: number;
  fogColor: THREE.Color;
  fogDensity: number;
  skyTint: THREE.Color;
  exposure: number;
  /** 0 = sun below horizon, 1 = high noon. Drives shadows and god rays. */
  sunElevation: number;
  /** 0..1 star visibility. */
  starOpacity: number;
  /** 0..1 — how "lit" artificial lights should be (windows, lanterns). */
  lampIntensity: number;
  /** Moon phase, 0..1, cycling over several in-game days. */
  moonPhase: number;
}

/** Mutable singleton; read every frame by many components. */
const state: LightingState = {
  t: TIME.DEFAULT_TIME,
  sunDirection: new THREE.Vector3(0, 1, 0),
  moonDirection: new THREE.Vector3(0, -1, 0),
  sunColor: new THREE.Color('#ffb457'),
  sunIntensity: 2.35,
  ambientColor: new THREE.Color('#9a95c8'),
  ambientIntensity: 0.5,
  fogColor: new THREE.Color('#f0c99a'),
  fogDensity: 0.0082,
  skyTint: new THREE.Color('#ffc98a'),
  exposure: 1.08,
  sunElevation: 0.4,
  starOpacity: 0,
  lampIntensity: 0,
  moonPhase: 0.5,
};

/** Returns the shared lighting state. Identity is stable. */
export function useLighting(): LightingState {
  return state;
}

/** Non-hook accessor. */
export function getLighting(): LightingState {
  return state;
}

/* Scratch objects — reused every frame so the cycle allocates nothing. */
const _a = new THREE.Color();
const _b = new THREE.Color();

/**
 * Finds the two authored lighting states bracketing `t` and returns their
 * indices plus the blend factor between them.
 *
 * The list wraps: the last state (night, t = 0.94) blends forward into the
 * first (dawn, t = 0.22) across midnight.
 */
function bracket(t: number): { i0: number; i1: number; k: number } {
  const n = LIGHTING_STATES.length;
  const x = wrap(t, 1);

  for (let i = 0; i < n; i++) {
    const a = LIGHTING_STATES[i]!.t;
    const b = LIGHTING_STATES[(i + 1) % n]!.t;
    // Handle the wrapping final segment.
    if (i === n - 1) {
      if (x >= a || x < b) {
        const span = 1 - a + b;
        const local = x >= a ? x - a : 1 - a + x;
        return { i0: i, i1: 0, k: span > 0 ? local / span : 0 };
      }
    } else if (x >= a && x < b) {
      return { i0: i, i1: i + 1, k: invLerp(a, b, x) };
    }
  }
  // Before the first key frame — wrap back to the last.
  const last = n - 1;
  const a = LIGHTING_STATES[last]!.t;
  const b = LIGHTING_STATES[0]!.t;
  const span = 1 - a + b;
  return { i0: last, i1: 0, k: span > 0 ? (1 - a + x) / span : 0 };
}

/**
 * Advances the clock and recomputes lighting. Mount **once** in the `<Canvas>`.
 */
export function useTimeSimulation(): LightingState {
  const timeScale = useGameStore((s) => s.timeScale);
  const weather = useGameStore((s) => s.weather);
  const season = useGameStore((s) => s.season);
  const setTimeOfDay = useGameStore((s) => s.setTimeOfDay);
  const { timeFlowing, dayLength, fogDensity: fogMultiplier } = useSettingsStore((s) => s.world);

  /* The clock lives in a ref and is only written back to the store a few times
   * a second. Writing it every frame would re-render every component that reads
   * `timeOfDay` — which is most of the scene. */
  const clock = useRef(useGameStore.getState().timeOfDay);
  const publishAccumulator = useRef(0);
  const externallySet = useRef(clock.current);

  /* Adopt external jumps — the time slider in Settings — *without* subscribing
   * this component to `timeOfDay`.
   *
   * Reading it with `useGameStore((s) => s.timeOfDay)` looks harmless and is
   * anything but: this hook publishes the clock six times a second, so a
   * subscription here re-rendered its host — `<World>`, the root of the entire
   * scene — six times a second too. React re-rendering the scene tree is
   * cheap; what is not cheap is that `<EffectComposer>` rebuilds its whole
   * pass chain whenever its `children` array changes identity, which it does
   * on every parent render. That was ~35 shader programs and ~35 render
   * targets allocated per second, multi-second compile stalls, and a steadily
   * climbing texture count that ended in a lost context.
   *
   * A store subscription in an effect gets the same behaviour with no render. */
  useEffect(
    () =>
      useGameStore.subscribe(
        (s) => s.timeOfDay,
        (t) => {
          if (Math.abs(externallySet.current - t) > 1e-4) {
            clock.current = t;
            externallySet.current = t;
          }
        },
      ),
    [],
  );

  const dayNumber = useRef(0);

  useFrame((three, dt) => {
    if (dt <= 0 || dt > 0.5) dt = 1 / 60;

    if (timeFlowing) {
      const advance = (dt * timeScale) / Math.max(dayLength, 1);
      const before = clock.current;
      clock.current = wrap(clock.current + advance, 1);
      // Count day rollovers so the moon phase can drift between nights.
      if (clock.current < before) dayNumber.current++;
    }

    const t = clock.current;
    state.t = t;

    /* ── Sun & moon positions ────────────────────────────────────────────
     * The sun sweeps a circle tilted from the vertical. t = 0 is midnight
     * (sun at its lowest), t = 0.5 is noon (sun highest). */
    const sunAngle = (t - 0.25) * Math.PI * 2;
    const tilt = TIME.SUN_ORBIT_TILT;
    state.sunDirection
      .set(Math.cos(sunAngle) * Math.sin(tilt), Math.sin(sunAngle), Math.cos(sunAngle) * Math.cos(tilt))
      .normalize();

    // Moon opposes the sun but on a slightly different plane, so they are
    // rarely exactly antipodal in the sky.
    const moonAngle = sunAngle + Math.PI;
    state.moonDirection
      .set(
        Math.cos(moonAngle) * Math.sin(-tilt * 0.7),
        Math.sin(moonAngle),
        Math.cos(moonAngle) * Math.cos(-tilt * 0.7),
      )
      .normalize();

    state.sunElevation = clamp(state.sunDirection.y, -1, 1);
    // Moon phase advances ~1/8 per in-game day.
    state.moonPhase = wrap(dayNumber.current * 0.125 + 0.3, 1);

    /* ── Colour blend ────────────────────────────────────────────────────── */
    const { i0, i1, k } = bracket(t);
    const s0 = LIGHTING_STATES[i0]!;
    const s1 = LIGHTING_STATES[i1]!;
    // Smootherstep the blend so transitions have no visible velocity change.
    const kk = smoothstep(0, 1, k);

    state.sunColor.set(s0.sunColor).lerp(_a.set(s1.sunColor), kk);
    state.ambientColor.set(s0.ambientColor).lerp(_a.set(s1.ambientColor), kk);
    state.skyTint.set(s0.skyTint).lerp(_a.set(s1.skyTint), kk);
    state.sunIntensity = lerp(s0.sunIntensity, s1.sunIntensity, kk);
    state.ambientIntensity = lerp(s0.ambientIntensity, s1.ambientIntensity, kk);
    state.exposure = lerp(s0.exposure, s1.exposure, kk);

    /* ── Fog ─────────────────────────────────────────────────────────────
     * Base density from the lighting state, multiplied by weather and the
     * player's own slider, and tinted toward the season's palette. */
    const w = WEATHER[weather] ?? WEATHER.clear;
    state.fogDensity = lerp(s0.fogDensity, s1.fogDensity, kk) * w.fogBoost * fogMultiplier;

    _b.set(s0.fogColor).lerp(_a.set(s1.fogColor), kk);
    // Season tints the fog: winter fog is blue-white, autumn fog is amber.
    _a.set(SEASONS[season].fogTint);
    state.fogColor.copy(_b).lerp(_a, 0.35);

    /* ── Stars & lamps ───────────────────────────────────────────────────
     * Stars fade in after dusk. The window is expressed as a wrapping range,
     * so the maths has to handle 0.78 → 0.24 crossing midnight. */
    const nightT = wrap(t - TIME.STARS_FADE_IN, 1);
    const nightSpan = wrap(TIME.STARS_FADE_OUT - TIME.STARS_FADE_IN, 1);
    if (nightT < nightSpan) {
      // Fade in over the first 15% of night, out over the last 20%.
      const local = nightT / nightSpan;
      state.starOpacity = clamp(smoothstep(0, 0.15, local) * (1 - smoothstep(0.8, 1, local)), 0, 1);
    } else {
      state.starOpacity = 0;
    }
    // Overcast skies hide the stars.
    state.starOpacity *= 1 - w.cloudCover * 0.9;

    // Artificial lights follow roughly the same curve, a little earlier.
    state.lampIntensity = clamp(
      smoothstep(0.74, 0.82, t) * (1 - smoothstep(0.2, 0.3, t < 0.5 ? t : 0)),
      0,
      1,
    );
    if (t < 0.3) state.lampIntensity = 1 - smoothstep(0.18, 0.3, t);

    // Heavy weather dims the sun.
    const overcast = 1 - w.cloudCover * 0.55;
    state.sunIntensity *= overcast;

    /* ── Publish to the store at ~6 Hz ───────────────────────────────────── */
    publishAccumulator.current += dt;
    if (publishAccumulator.current > 1 / 6) {
      publishAccumulator.current = 0;
      if (timeFlowing) {
        externallySet.current = clock.current;
        setTimeOfDay(clock.current);
      }
    }
  });

  return state;
}

/**
 * Convenience: is it "night" for gameplay purposes (fox, fireflies, owls)?
 */
export function isNight(t: number): boolean {
  const x = wrap(t, 1);
  return x > 0.79 || x < 0.22;
}

/** True during the golden-hour window, used for the Wanderer achievement. */
export function isGoldenHour(t: number): boolean {
  const x = wrap(t, 1);
  return x > 0.66 && x < 0.82;
}

/**
 * A convenience hook returning a *reactive* time-of-day for UI components.
 * Uses the store value (updated at 6 Hz), which is plenty for a clock readout
 * and avoids subscribing the UI to the frame loop.
 */
export function useTimeOfDay(): number {
  return useGameStore((s) => s.timeOfDay);
}

/**
 * Derives an "hour label" for the settings preset buttons.
 */
export const TIME_PRESETS = [
  { id: 'dawn', label: 'Dawn', t: 0.22 },
  { id: 'morning', label: 'Morning', t: 0.34 },
  { id: 'noon', label: 'Noon', t: 0.5 },
  { id: 'golden', label: 'Golden Hour', t: 0.74 },
  { id: 'dusk', label: 'Dusk', t: 0.81 },
  { id: 'night', label: 'Night', t: 0.95 },
] as const;

/** Village flatten height — re-exported so the sky dome can sit on the horizon. */
export const GROUND_REFERENCE_HEIGHT = TERRAIN_NOISE.VILLAGE_FLATTEN_HEIGHT;
