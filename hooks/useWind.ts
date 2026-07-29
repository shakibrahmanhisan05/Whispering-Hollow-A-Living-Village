/**
 * The global wind field.
 *
 * A single wind vector drives *everything* that moves in the air: grass blades,
 * wheat, tree canopies, cloth awnings, the windmill, cloud drift, the ridge
 * wind-chime, falling leaves and the wind audio bed. Sharing one source is what
 * makes the world feel like one place — when a gust arrives, the whole valley
 * responds together instead of each system wobbling on its own timer.
 *
 * The field is a mutable singleton rather than React state: it is read every
 * frame by dozens of components and by shader uniforms, and re-rendering the
 * tree 60 times a second to publish a float would be absurd.
 *
 * ## The gust model
 *
 * ```
 * strength = base × (1 + A·fbm(t/P₁) + 0.4·A·fbm(t/P₂))
 * ```
 *
 * Two layered 1D fBm envelopes at different periods: a slow one (~11 s) for the
 * broad swell of a gust, and a fast one (~3.7 s) for the texture inside it.
 * Pure sines would produce an obviously periodic sway; fBm never repeats.
 *
 * Separately, `ripplePhase` advances linearly and is fed to the vegetation
 * shaders, where a travelling sine across world-space X produces the *visible
 * wave* crossing a wheatfield ahead of the gust you feel.
 *
 * @module hooks/useWind
 */

'use client';

import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { WIND, WEATHER } from '@/config/game';
import type { WindUniforms } from '@/shaders/foliage.glsl';
import { fbm1D } from '@/lib/utils/math';
import { useGameStore } from '@/store/gameStore';
import { useSettingsStore } from '@/store/settingsStore';

/** The live wind state, shared by reference across the whole app. */
export interface WindField {
  /** Current strength, nominally 0..2. Feeds shader `uWindStrength`. */
  strength: number;
  /** Heading in radians; 0 = +X. Feeds shader `uWindDirection`. */
  direction: number;
  /** Unit direction as a vector, for convenience. */
  vector: THREE.Vector2;
  /** Monotonically increasing phase driving the travelling gust ripple. */
  ripplePhase: number;
  /** Accumulated time, for shader `uTime`. */
  time: number;
  /**
   * 0..1 "gustiness" — how far above the baseline the current strength is.
   * Used to trigger leaf bursts and to brighten the wind audio.
   */
  gust: number;
}

const field: WindField = {
  strength: WIND.BASE_STRENGTH,
  direction: WIND.BASE_DIRECTION,
  vector: new THREE.Vector2(Math.cos(WIND.BASE_DIRECTION), Math.sin(WIND.BASE_DIRECTION)),
  ripplePhase: 0,
  time: 0,
  gust: 0,
};

/**
 * Returns the shared wind field. The object identity is stable, so reading
 * `wind.strength` inside `useFrame` always sees the current value.
 */
export function useWindField(): WindField {
  return field;
}

/** Non-hook accessor, for use outside the React tree. */
export function getWindField(): WindField {
  return field;
}

/**
 * Advances the wind simulation. Mount **exactly once** inside the `<Canvas>`.
 */
export function useWindSimulation(): void {
  const weather = useGameStore((s) => s.weather);
  const userStrength = useSettingsStore((s) => s.world.windStrength);

  useFrame((_, dt) => {
    if (dt <= 0 || dt > 0.5) return; // Skip absurd deltas after a tab switch.

    field.time += dt;

    const weatherBoost = WEATHER[weather]?.windBoost ?? 1;
    const base = userStrength * weatherBoost;

    /* Two-layer gust envelope. `fbm1D` returns roughly [-1, 1]; scaling and
     * offsetting keeps strength positive while allowing genuine lulls. */
    const slow = fbm1D(field.time / WIND.GUST_PERIOD, 3);
    const fast = fbm1D(field.time / WIND.GUST_PERIOD_FAST + 41.7, 2);
    const envelope = 1 + WIND.GUST_AMPLITUDE * slow + WIND.GUST_AMPLITUDE * 0.4 * fast;

    field.strength = Math.max(0, base * envelope);
    field.gust = Math.max(0, (envelope - 1) / (WIND.GUST_AMPLITUDE * 1.4));

    /* The heading wanders slowly. Using fBm rather than a random walk keeps it
     * from drifting monotonically into one corner over a long session. */
    field.direction =
      WIND.BASE_DIRECTION + fbm1D(field.time * WIND.DIRECTION_DRIFT, 2) * Math.PI * 0.55;
    field.vector.set(Math.cos(field.direction), Math.sin(field.direction));

    // The visible ripple travels faster in stronger wind.
    field.ripplePhase += dt * WIND.RIPPLE_SPEED * (0.5 + field.strength);
  });
}

/**
 * Creates the uniform object every wind-aware shader shares.
 *
 * Returning the *same* uniform objects to every material means one write per
 * frame updates the grass, the wheat, the trees and the cloth simultaneously —
 * rather than N materials each with their own copy.
 */
export function useWindUniforms(): WindUniforms {
  return useMemo<WindUniforms>(
    () => ({
      uTime: { value: 0 },
      uWindDirection: { value: new THREE.Vector2(1, 0) },
      uWindStrength: { value: WIND.BASE_STRENGTH },
      uRipplePhase: { value: 0 },
      uRippleWavelength: { value: WIND.RIPPLE_WAVELENGTH },
    }),
    [],
  );
}

/**
 * Pushes the wind field into a shared uniform object each frame.
 * Mount once alongside {@link useWindSimulation}.
 */
export function useWindUniformSync(uniforms: ReturnType<typeof useWindUniforms>): void {
  useFrame(() => {
    uniforms.uTime.value = field.time;
    uniforms.uWindDirection.value.copy(field.vector);
    uniforms.uWindStrength.value = field.strength;
    uniforms.uRipplePhase.value = field.ripplePhase;
  });
}

/** Resets the field when a new world loads. */
export function useWindReset(seed: string): void {
  useEffect(() => {
    field.time = 0;
    field.ripplePhase = 0;
    field.strength = WIND.BASE_STRENGTH;
    field.direction = WIND.BASE_DIRECTION;
    field.gust = 0;
  }, [seed]);
}
