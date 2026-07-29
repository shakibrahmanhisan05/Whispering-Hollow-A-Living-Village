/**
 * The sky lantern festival.
 *
 * A rare, unannounced event: once per real hour, if the player happens to be
 * on the ridge at dusk, lanterns rise from the village below. There is no quest
 * marker and no prompt — it either happens to you or it doesn't, which is
 * exactly why people remember it.
 *
 * @module components/scene/SkyLanterns
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { useWorld } from './TerrainContext';
import { useLighting } from '@/hooks/useTimeOfDay';
import { useWindField } from '@/hooks/useWind';
import { useGameStore } from '@/store/gameStore';
import { playerState } from '../player/PlayerController';
import { pushToast } from '@/store/uiState';
import { softSprite } from '@/lib/textures/procedural';
import { mergeGeometries, transformGeometry } from '@/lib/geometry/merge';
import { RIDGE_BENCH } from '@/lib/world/layout';
import { clamp } from '@/lib/utils/math';

const LANTERN_COUNT = 64;
/** Real seconds between possible festivals. */
const FESTIVAL_COOLDOWN = 3600;

export function SkyLanterns() {
  const { terrain } = useWorld();
  const lighting = useLighting();
  const wind = useWindField();
  const discover = useGameStore((s) => s.discover);
  const unlockAchievement = useGameStore((s) => s.unlockAchievement);

  const meshRef = useRef<THREE.InstancedMesh>(null);
  const glowRef = useRef<THREE.InstancedMesh>(null);

  const state = useRef({
    active: false,
    /** Seconds since the festival began. */
    time: 0,
    lastFestival: -FESTIVAL_COOLDOWN,
    /** Per-lantern launch delay, height, drift and flicker. */
    delay: new Float32Array(LANTERN_COUNT),
    origin: new Float32Array(LANTERN_COUNT * 3),
    rise: new Float32Array(LANTERN_COUNT),
    wobble: new Float32Array(LANTERN_COUNT),
    drift: new Float32Array(LANTERN_COUNT * 2),
  });

  const { bodyGeo, glowGeo, bodyMat, glowMat } = useMemo(() => {
    /* A paper lantern: an open-bottomed truncated cone with a small frame at
     * the base. Open-bottomed matters — you can see the flame inside from
     * below, which is the whole image. */
    const parts: THREE.BufferGeometry[] = [];
    const shade = new THREE.CylinderGeometry(0.28, 0.36, 0.62, 10, 1, true);
    parts.push(shade);
    const top = new THREE.CylinderGeometry(0.28, 0.2, 0.14, 10);
    transformGeometry(top, { position: [0, 0.38, 0] });
    parts.push(top);
    // The wire frame at the base.
    const ring = new THREE.TorusGeometry(0.34, 0.012, 5, 12);
    transformGeometry(ring, { position: [0, -0.31, 0], rotation: [Math.PI / 2, 0, 0] });
    parts.push(ring);

    const glow = new THREE.PlaneGeometry(2.4, 2.4);

    return {
      bodyGeo: mergeGeometries(parts, true),
      glowGeo: glow,
      bodyMat: new THREE.MeshStandardMaterial({
        color: '#f0d8a0',
        emissive: new THREE.Color('#ff9a3c'),
        emissiveIntensity: 2.4,
        roughness: 0.85,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.92,
      }),
      glowMat: new THREE.MeshBasicMaterial({
        map: softSprite(128, 2.2),
        color: '#ffb45a',
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    };
  }, []);

  useEffect(
    () => () => {
      bodyGeo.dispose();
      glowGeo.dispose();
      bodyMat.dispose();
      glowMat.dispose();
    },
    [bodyGeo, glowGeo, bodyMat, glowMat],
  );

  /** Sets up a fresh launch. */
  const beginFestival = useMemo(
    () => () => {
      const s = state.current;
      s.active = true;
      s.time = 0;
      s.lastFestival = performance.now() / 1000;

      for (let i = 0; i < LANTERN_COUNT; i++) {
        /* Launches are staggered over twelve seconds, so lanterns go up in
         * ones and twos rather than as a single wall — which is both what
         * really happens and far more beautiful. */
        s.delay[i] = Math.random() * 12;
        // Launched from around the village plaza.
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * 18;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        s.origin[i * 3] = x;
        s.origin[i * 3 + 1] = terrain.heightAt(x, z) + 1;
        s.origin[i * 3 + 2] = z;
        s.rise[i] = 1.6 + Math.random() * 1.1;
        s.wobble[i] = Math.random() * Math.PI * 2;
        s.drift[i * 2] = (Math.random() - 0.5) * 0.6;
        s.drift[i * 2 + 1] = (Math.random() - 0.5) * 0.6;
      }

      pushToast({
        kind: 'discovery',
        title: 'Sky lanterns',
        body: 'Someone in the village is letting them go.',
        icon: '🏮',
        ttl: 8000,
      });
    },
    [terrain],
  );

  useFrame((_, dt) => {
    const s = state.current;
    const mesh = meshRef.current;
    const glow = glowRef.current;
    if (!mesh || !glow) return;

    /* ── Trigger check ────────────────────────────────────────────────────
     * Dusk, on the ridge, and not too soon after the last one. */
    if (!s.active) {
      const now = performance.now() / 1000;
      const isDusk = lighting.t > 0.77 && lighting.t < 0.86;
      const onRidge =
        Math.hypot(playerState.position.x - RIDGE_BENCH.x, playerState.position.z - RIDGE_BENCH.z) <
        26;
      const cooledDown = now - s.lastFestival > FESTIVAL_COOLDOWN;

      if (isDusk && onRidge && cooledDown) {
        beginFestival();
        if (discover('secret-lanterns')) unlockAchievement('lantern-festival');
      } else {
        mesh.visible = false;
        glow.visible = false;
        return;
      }
    }

    mesh.visible = true;
    glow.visible = true;
    s.time += dt;

    // The festival lasts about two minutes, then the lanterns are gone.
    if (s.time > 130) {
      s.active = false;
      return;
    }

    for (let i = 0; i < LANTERN_COUNT; i++) {
      const age = s.time - s.delay[i]!;
      if (age < 0) {
        _lantMat.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, _lantMat);
        glow.setMatrixAt(i, _lantMat);
        continue;
      }

      /* Rise. Buoyancy is roughly constant while the flame burns, so the ascent
       * is close to linear — but drag makes it ease slightly, which the sqrt
       * captures. */
      const height = s.origin[i * 3 + 1]! + Math.sqrt(age) * s.rise[i]! * 6;

      /* Lateral drift. Wind carries them, and each lantern wobbles on its own
       * phase — a paper shade is not aerodynamically stable and they visibly
       * bob and sway as they climb. */
      const wobble = s.wobble[i]! + age * 0.8;
      const x =
        s.origin[i * 3]! +
        wind.vector.x * wind.strength * age * 1.8 +
        s.drift[i * 2]! * age +
        Math.sin(wobble) * 0.5;
      const z =
        s.origin[i * 3 + 2]! +
        wind.vector.y * wind.strength * age * 1.8 +
        s.drift[i * 2 + 1]! * age +
        Math.cos(wobble * 0.83) * 0.5;

      _lantPos.set(x, height, z);
      // A gentle tilt into the direction of travel.
      _lantEuler.set(Math.sin(wobble) * 0.14, wobble * 0.2, Math.cos(wobble * 0.9) * 0.14);
      _lantQuat.setFromEuler(_lantEuler);
      // Fade out as they climb beyond sight.
      const fade = clamp(1 - (height - 120) / 60, 0, 1);
      _lantScale.setScalar(fade);
      _lantMat.compose(_lantPos, _lantQuat, _lantScale);
      mesh.setMatrixAt(i, _lantMat);

      // The glow billboard is larger and always faces up-ish.
      _lantScale.setScalar(fade * (0.8 + Math.sin(wobble * 3) * 0.08));
      _lantMat.compose(_lantPos, _glowQuat, _lantScale);
      glow.setMatrixAt(i, _lantMat);
    }

    mesh.instanceMatrix.needsUpdate = true;
    glow.instanceMatrix.needsUpdate = true;

    // Flicker, shared across all of them — they're all the same kind of flame.
    bodyMat.emissiveIntensity = 2.2 + Math.sin(s.time * 7.3) * 0.25 + Math.sin(s.time * 11.7) * 0.15;
  });

  return (
    <group name="sky-lanterns">
      <instancedMesh
        ref={meshRef}
        args={[bodyGeo, bodyMat, LANTERN_COUNT]}
        frustumCulled={false}
        visible={false}
      />
      <instancedMesh
        ref={glowRef}
        args={[glowGeo, glowMat, LANTERN_COUNT]}
        frustumCulled={false}
        visible={false}
        renderOrder={30}
      />
    </group>
  );
}

const _lantPos = new THREE.Vector3();
const _lantQuat = new THREE.Quaternion();
const _glowQuat = new THREE.Quaternion();
const _lantEuler = new THREE.Euler();
const _lantScale = new THREE.Vector3();
const _lantMat = new THREE.Matrix4();
