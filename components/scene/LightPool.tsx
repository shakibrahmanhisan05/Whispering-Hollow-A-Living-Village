/**
 * A fixed pool of point lights, shared by every lamp in the world.
 *
 * ## Why this exists
 *
 * three.js compiles a separate shader program for each distinct *light
 * configuration*: the program cache key includes the number of directional,
 * point and spot lights in the scene, and how many of them cast shadows. Show
 * or hide a single light and every material in the scene needs a new program.
 *
 * That is fatal for a village that lights its windows at dusk. Each house
 * switching on its interior light changed the point-light count by one, which
 * recompiled all ~17 materials in the scene — a 1–3 second freeze — and every
 * house did it a moment apart. Sunset cost the better part of a minute of
 * stutter, and left several hundred dead programs in the cache.
 *
 * The fix is to make the count a constant. A fixed number of `PointLight`s is
 * mounted once, always visible, and every frame they are re-aimed at the
 * nearest lamps that are actually lit. Fixtures no longer own a light; they
 * register a {@link PointLightSource} describing where they are and how
 * brightly they are burning, and the pool decides which ones get hardware.
 *
 * This is also just good rendering practice independently of the recompiles:
 * a point light costs its shader evaluation on every lit fragment whether or
 * not the player is anywhere near it, so twenty-two of them is twenty-two
 * times the cost for light the player cannot see. Six is plenty — beyond the
 * three or four nearest lamps, the rest are a wash against the emissive
 * materials and bloom that make the lamps look lit in the first place.
 *
 * @module components/scene/LightPool
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { LIGHT_POOL } from '@/config/game';

/**
 * A lamp that would like a real light if one is available.
 *
 * Owners mutate these fields in place from their own `useFrame` — position
 * because lamps move (a swinging lantern, the player's own), intensity because
 * they brighten and dim. Nothing here is read except by the pool.
 */
export interface PointLightSource {
  /** World-space position of the emitter. */
  position: THREE.Vector3;
  color: THREE.Color;
  /** Zero means "off": the source stays registered but is never chosen. */
  intensity: number;
  /** Range at which the light has fallen to nothing. */
  distance: number;
  decay: number;
}

const sources = new Set<PointLightSource>();

/**
 * Adds a lamp to the pool's candidate set.
 *
 * @returns an unregister function, suitable for returning from `useEffect`.
 */
export function registerPointLight(source: PointLightSource): () => void {
  sources.add(source);
  return () => {
    sources.delete(source);
  };
}

/**
 * Convenience for the common case: a lamp at a fixed world position.
 *
 * The returned object is stable, so callers can mutate `intensity` on it every
 * frame without re-registering.
 */
export function usePointLightSource(
  position: THREE.Vector3 | [number, number, number],
  color: string,
  distance: number,
  decay = 2,
): PointLightSource {
  const source = useMemo<PointLightSource>(
    () => ({
      position: Array.isArray(position) ? new THREE.Vector3(...position) : position.clone(),
      color: new THREE.Color(color),
      intensity: 0,
      distance,
      decay,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- position is copied once by design; owners mutate it in place afterwards.
    [color, distance, decay],
  );

  useEffect(() => registerPointLight(source), [source]);
  return source;
}

/**
 * The world's one and only spot light.
 *
 * There is exactly one thing in Whispering Hollow with a directed beam — the
 * locomotive's headlight — and it exists for forty seconds at a time. Mounting
 * it with the train would change the scene's spot-light count twice per ritual
 * and recompile every shader in the world at the exact moment the player is
 * meant to be watching something. So the light is permanent and the train
 * simply drives it, dimming it to nothing the rest of the time.
 */
export const spotSlot = {
  position: new THREE.Vector3(0, -1000, 0),
  target: new THREE.Vector3(0, -1000, 1),
  color: new THREE.Color('#fff2cc'),
  intensity: 0,
  angle: 0.34,
  penumbra: 0.55,
  distance: 70,
  decay: 1.6,
};

/** One pool slot: the winning source and the score that won it. */
interface Slot {
  src: PointLightSource | null;
  score: number;
}

/**
 * Mount once, near the root of the scene.
 *
 * `frustumCulled` is irrelevant for lights and `visible` is never touched —
 * that is the entire point.
 */
export function PointLightPool() {
  const group = useRef<THREE.Group>(null);
  const lights = useRef<THREE.PointLight[]>([]);
  const slots = useRef<Slot[]>([]);
  const spot = useRef<THREE.SpotLight>(null);
  const spotTarget = useMemo(() => new THREE.Object3D(), []);

  useFrame(({ camera }) => {
    const s = spot.current;
    if (s) {
      s.position.copy(spotSlot.position);
      s.color.copy(spotSlot.color);
      s.intensity = spotSlot.intensity;
      s.angle = spotSlot.angle;
      s.penumbra = spotSlot.penumbra;
      s.distance = spotSlot.distance;
      s.decay = spotSlot.decay;
      spotTarget.position.copy(spotSlot.target);
      spotTarget.updateMatrixWorld();
    }

    const pool = lights.current;
    if (pool.length === 0) return;

    if (slots.current.length !== pool.length) {
      slots.current = pool.map(() => ({ src: null, score: -1 }));
    }
    const chosen = slots.current;
    for (const slot of chosen) {
      slot.src = null;
      slot.score = -1;
    }

    /* Score every candidate and keep the best `pool.length` of them.
     *
     * Insertion into a tiny sorted array beats sorting the whole candidate
     * list: there are a few dozen lamps and six slots, so this is a couple of
     * hundred comparisons a frame in the worst case and usually far fewer,
     * with no allocation at all. */
    for (const src of sources) {
      if (src.intensity <= LIGHT_POOL.MIN_INTENSITY) continue;

      const dx = src.position.x - camera.position.x;
      const dy = src.position.y - camera.position.y;
      const dz = src.position.z - camera.position.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      // Outside its own falloff range it contributes literally nothing.
      const reach = src.distance + LIGHT_POOL.REACH_MARGIN;
      if (distSq > reach * reach) continue;

      /* Brighter and closer wins. Dividing by distance rather than its square
       * deliberately under-weights distance: a bright lamp a little further
       * away is more worth a slot than a dim one underfoot. */
      const score = src.intensity / (Math.sqrt(distSq) + 1);

      let i = chosen.length - 1;
      if (score <= chosen[i]!.score) continue;
      while (i > 0 && score > chosen[i - 1]!.score) i--;

      // Shift the losers down, then write the winner into the freed slot.
      for (let j = chosen.length - 1; j > i; j--) {
        chosen[j]!.score = chosen[j - 1]!.score;
        chosen[j]!.src = chosen[j - 1]!.src;
      }
      chosen[i]!.score = score;
      chosen[i]!.src = src;
    }

    /* Hand the winners their hardware. Slots nobody claimed are switched off
     * rather than hidden — see the module comment. A zero-intensity light with
     * a zero radius is free everywhere except the one multiply that proves it
     * contributes nothing. */
    for (let i = 0; i < pool.length; i++) {
      const light = pool[i]!;
      const src = chosen[i]!.src;
      if (src) {
        light.position.copy(src.position);
        light.color.copy(src.color);
        light.intensity = src.intensity;
        light.distance = src.distance;
        light.decay = src.decay;
      } else {
        light.intensity = 0;
        light.distance = 0.01;
      }
    }
  });

  return (
    <group ref={group} name="light-pool">
      {Array.from({ length: LIGHT_POOL.SIZE }, (_, i) => (
        <pointLight
          key={i}
          ref={(el) => {
            if (el) lights.current[i] = el;
          }}
          intensity={0}
          distance={0.01}
          decay={2}
          castShadow={false}
        />
      ))}

      <primitive object={spotTarget} />
      <spotLight ref={spot} target={spotTarget} intensity={0} castShadow={false} />
    </group>
  );
}
