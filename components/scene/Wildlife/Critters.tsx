/**
 * The rest of the valley's inhabitants: fireflies, butterflies, dragonflies,
 * fish, cattle, chickens, the windowsill cat and the night fox.
 *
 * @module components/scene/Wildlife/Critters
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { useWorld } from '../TerrainContext';
import { useLighting } from '@/hooks/useTimeOfDay';
import { useGameStore } from '@/store/gameStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useSynthEngine, emitAudioSubtitle } from '@/components/audio/useSpatialAudio';
import { playFishSplash, playCatMeow, playFoxBark } from '@/components/audio/sources/wildlife';
import { spawnWaterRipple } from '../Water';
import { mergeGeometries, transformGeometry } from '@/lib/geometry/merge';
import { softSprite } from '@/lib/textures/procedural';
import { RandomSource } from '@/lib/utils/random';
import { pushToast } from '@/store/uiState';
import { WILDLIFE, VILLAGE, ZONES, SEASONS, WORLD, QUALITY_PRESETS } from '@/config/game';
import { POND, ROAD_POLYLINE } from '@/lib/world/layout';
import { clamp, damp, wrap, smoothstep } from '@/lib/utils/math';

/** True when `t` is inside a possibly-wrapping window. */
function inWindow(t: number, window: readonly [number, number]): boolean {
  const [a, b] = window;
  const x = wrap(t, 1);
  return a <= b ? x >= a && x < b : x >= a || x < b;
}

/**
 * Resolves how many particles to draw for a system of `capacity`.
 *
 * Clamped to the capacity, hard. Every particle system here allocates its
 * buffers and colour tables once at full size; a quality multiplier above 1
 * would index past the end of them. Doing that inside a `useEffect` throws,
 * and a throw from an effect unmounts the whole React tree — the game simply
 * never appears. Cheap insurance against a future config edit.
 */
function particleCount(capacity: number, budget: number): number {
  return Math.max(0, Math.min(capacity, Math.floor(capacity * budget)));
}

/* ───────────────────────────────────────────────────────────────────────────
 * FIREFLIES
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Fireflies.
 *
 * The single most atmospheric thing in the game at night, and almost free:
 * additive point sprites with a per-insect blink phase.
 *
 * Two details do the heavy lifting:
 *
 * 1. **They blink out of phase.** A synchronised swarm looks like a strobe.
 *    Independent phases produce the drifting constellation of a real meadow.
 * 2. **They hover at grass height and avoid open ground**, clustering in the
 *    grove and along the brook — because that is where they actually are, and
 *    because a uniform scatter would read as particles rather than as animals.
 */
export function Fireflies() {
  const { terrain } = useWorld();
  const lighting = useLighting();
  const season = useGameStore((s) => s.season);
  const preset = useSettingsStore((s) => s.graphics.preset);

  const budget = useMemo(() => {
    const p = preset === 'custom' ? 'high' : preset;
    return QUALITY_PRESETS[p]?.maxParticles ?? 1;
  }, [preset]);

  const count = particleCount(WILDLIFE.FIREFLY_COUNT, budget);

  const { geometry, material, state } = useMemo(() => {
    const max = WILDLIFE.FIREFLY_COUNT;
    const positions = new Float32Array(max * 3);
    const alphas = new Float32Array(max);
    const rng = new RandomSource('fireflies', 'v1');

    const home = new Float32Array(max * 3);
    const phase = new Float32Array(max);
    const speed = new Float32Array(max);

    // Cluster around the grove, the brook and the meadow edge.
    const clusters = [
      ZONES.ANCIENT_GROVE.center,
      ZONES.BROOK_AND_POND.center,
      ZONES.MEADOW_FIELDS.center,
      [0, 0] as [number, number],
    ];

    for (let i = 0; i < max; i++) {
      const cluster = clusters[i % clusters.length]!;
      const [dx, dz] = rng.insideDisc(26);
      const x = clamp(cluster[0] + dx, -WORLD.HALF + 8, WORLD.HALF - 8);
      const z = clamp(cluster[1] + dz, -WORLD.HALF + 8, WORLD.HALF - 8);
      const y = terrain.heightAt(x, z) + rng.range(0.4, 2.6);

      home[i * 3] = x;
      home[i * 3 + 1] = y;
      home[i * 3 + 2] = z;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      phase[i] = rng.next() * WILDLIFE.FIREFLY_BLINK_PERIOD;
      speed[i] = rng.range(0.25, 0.8);
      alphas[i] = 0;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), WORLD.SIZE);

    const mat = new THREE.PointsMaterial({
      size: 0.32,
      map: softSprite(64, 2.4),
      transparent: true,
      opacity: 1,
      depthWrite: false,
      sizeAttenuation: true,
      // Additive so they genuinely glow and feed the bloom pass.
      blending: THREE.AdditiveBlending,
      color: '#c8ff7a',
    });

    return { geometry: geo, material: mat, state: { positions, alphas, home, phase, speed } };
  }, [terrain]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  const time = useRef(0);

  useFrame((_, dt) => {
    time.current += dt;

    /* Only out at night, and only in warm seasons. Winter fireflies would be a
     * lovely image and a complete lie. */
    const nightly = inWindow(lighting.t, WILDLIFE.FIREFLY_ACTIVE) ? 1 : 0;
    const seasonal = season === 'winter' ? 0 : season === 'autumn' ? 0.4 : 1;
    const activity = nightly * seasonal;

    if (activity < 0.01) {
      geometry.setDrawRange(0, 0);
      return;
    }
    geometry.setDrawRange(0, count);

    const { positions, alphas, home, phase, speed } = state;
    const alphaAttr = geometry.attributes.alpha as THREE.BufferAttribute;
    const posAttr = geometry.attributes.position as THREE.BufferAttribute;

    for (let i = 0; i < count; i++) {
      const b = i * 3;
      const t = time.current * speed[i]!;

      /* Wandering flight: three sines at incommensurate frequencies produce a
       * path that never repeats and never looks like a circle. */
      positions[b] = home[b]! + Math.sin(t * 0.8 + i) * 2.2 + Math.sin(t * 0.31 + i * 2.1) * 1.1;
      positions[b + 1] =
        home[b + 1]! + Math.sin(t * 1.3 + i * 1.7) * 0.55 + Math.sin(t * 0.47) * 0.3;
      positions[b + 2] =
        home[b + 2]! + Math.cos(t * 0.73 + i * 1.3) * 2.2 + Math.cos(t * 0.29 + i) * 1.1;

      /* Blink. A sharp attack and a slow decay, like a real firefly's lantern —
       * `pow` on a sine gives exactly that asymmetry for one instruction. */
      const blinkT = wrap((time.current + phase[i]!) / WILDLIFE.FIREFLY_BLINK_PERIOD, 1);
      const pulse = Math.pow(Math.max(Math.sin(blinkT * Math.PI), 0), 6);
      alphas[i] = pulse * activity;
    }

    posAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    material.opacity = activity;
  });

  return <points geometry={geometry} material={material} frustumCulled={false} name="fireflies" />;
}

/* ───────────────────────────────────────────────────────────────────────────
 * BUTTERFLIES & DRAGONFLIES
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Butterflies.
 *
 * The flight path is the character: butterflies do not fly in curves, they
 * **bounce**. The vertical motion here is a rectified sine (`abs`), producing
 * the up-down-up-down bobbing that is instantly recognisable and completely
 * unlike a bird or a bee.
 */
export function Butterflies() {
  const { terrain } = useWorld();
  const lighting = useLighting();
  const season = useGameStore((s) => s.season);
  const preset = useSettingsStore((s) => s.graphics.preset);

  const budget = useMemo(() => {
    const p = preset === 'custom' ? 'high' : preset;
    return QUALITY_PRESETS[p]?.maxParticles ?? 1;
  }, [preset]);
  const count = particleCount(WILDLIFE.BUTTERFLY_COUNT, budget);

  const { geometry, material, state } = useMemo(() => {
    // Two triangular wings.
    const geo = new THREE.BufferGeometry();
    const v = new Float32Array([
      0, 0, 0, 0.16, 0, 0.1, 0.14, 0, -0.12,
      0, 0, 0, -0.14, 0, -0.12, -0.16, 0, 0.1,
    ]);
    geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
    geo.setAttribute(
      'uv',
      new THREE.BufferAttribute(new Float32Array([0.5, 0.5, 1, 1, 1, 0, 0.5, 0.5, 0, 0, 0, 1]), 2),
    );
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: '#f0d060',
      roughness: 0.7,
      side: THREE.DoubleSide,
      emissive: new THREE.Color('#4a3a10'),
      emissiveIntensity: 0.2,
    });

    const rng = new RandomSource('butterflies', 'v1');
    const s = {
      home: new Float32Array(WILDLIFE.BUTTERFLY_COUNT * 3),
      phase: new Float32Array(WILDLIFE.BUTTERFLY_COUNT),
      speed: new Float32Array(WILDLIFE.BUTTERFLY_COUNT),
      colors: [] as THREE.Color[],
    };

    const palette = ['#f0d060', '#e88a4a', '#d8e0f0', '#c86ab0', '#f2f0e6', '#6ab0d8'];
    for (let i = 0; i < WILDLIFE.BUTTERFLY_COUNT; i++) {
      const cluster = i % 2 === 0 ? ZONES.MEADOW_FIELDS.center : ZONES.VILLAGE_HEART.center;
      const [dx, dz] = rng.insideDisc(38);
      const x = clamp(cluster[0] + dx, -WORLD.HALF + 8, WORLD.HALF - 8);
      const z = clamp(cluster[1] + dz, -WORLD.HALF + 8, WORLD.HALF - 8);
      s.home[i * 3] = x;
      s.home[i * 3 + 1] = terrain.heightAt(x, z) + rng.range(0.5, 2.2);
      s.home[i * 3 + 2] = z;
      s.phase[i] = rng.angle();
      s.speed[i] = rng.range(0.5, 1.3);
      s.colors.push(new THREE.Color(palette[i % palette.length]!));
    }

    return { geometry: geo, material: mat, state: s };
  }, [terrain]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  const meshRef = useRef<THREE.InstancedMesh>(null);
  const time = useRef(0);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    // Bound by the colour table, not by `count` — see `particleCount`.
    const n = Math.min(count, state.colors.length);
    for (let i = 0; i < n; i++) mesh.setColorAt(i, state.colors[i]!);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [count, state.colors]);

  useFrame((_, dt) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    time.current += dt;

    const daytime = inWindow(lighting.t, WILDLIFE.BUTTERFLY_ACTIVE) ? 1 : 0;
    const seasonal = SEASONS[season].wildlifeDensity * (season === 'winter' ? 0 : 1);
    const activity = daytime * clamp(seasonal, 0, 1);

    for (let i = 0; i < count; i++) {
      if (activity < 0.05) {
        _critMat.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, _critMat);
        continue;
      }

      const b = i * 3;
      const t = time.current * state.speed[i]! + state.phase[i]!;

      const x = state.home[b]! + Math.sin(t * 0.6) * 4.5 + Math.sin(t * 0.23) * 2.2;
      const z = state.home[b + 2]! + Math.cos(t * 0.5) * 4.5 + Math.cos(t * 0.19) * 2.2;
      /* The bounce. `abs(sin)` gives a rectified wave — always upward impulses
       * with a fall between, which is exactly how a butterfly moves. */
      const y = state.home[b + 1]! + Math.abs(Math.sin(t * 3.4)) * 0.55;

      _critPos.set(x, y, z);

      // Face the direction of travel.
      const yaw = Math.atan2(Math.cos(t * 0.6) * 0.6, -Math.sin(t * 0.5) * 0.5);
      // Wings clap together and open — a fast flap on a shared phase.
      const flap = Math.sin(t * 14) * 0.9;
      _critEuler.set(flap, yaw, 0);
      _critQuat.setFromEuler(_critEuler);
      _critScale.setScalar(1);
      _critMat.compose(_critPos, _critQuat, _critScale);
      mesh.setMatrixAt(i, _critMat);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  if (count === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, count]}
      frustumCulled={false}
      name="butterflies"
    />
  );
}

/**
 * Dragonflies over the pond.
 *
 * Where butterflies bounce, dragonflies **dart**: they hold position, then
 * accelerate hard to a new one and stop dead. Modelled as a hover-and-dash
 * state machine, which is far more characterful than any smooth path.
 */
export function Dragonflies() {
  const lighting = useLighting();
  const season = useGameStore((s) => s.season);

  const count = WILDLIFE.DRAGONFLY_COUNT;

  const { geometry, material, state } = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    const body = new THREE.CapsuleGeometry(0.018, 0.22, 3, 5);
    transformGeometry(body, { rotation: [Math.PI / 2, 0, 0] });
    parts.push(body);
    // Four wings.
    for (const [x, z] of [
      [0.13, 0.04],
      [-0.13, 0.04],
      [0.11, -0.06],
      [-0.11, -0.06],
    ] as const) {
      const wing = new THREE.PlaneGeometry(0.22, 0.05);
      transformGeometry(wing, { position: [x, 0.02, z], rotation: [-Math.PI / 2, 0, 0] });
      parts.push(wing);
    }

    const geo = mergeGeometries(parts, true);
    const mat = new THREE.MeshStandardMaterial({
      color: '#2a7a8c',
      roughness: 0.4,
      metalness: 0.35,
      emissive: new THREE.Color('#0a3a44'),
      emissiveIntensity: 0.3,
      side: THREE.DoubleSide,
    });

    const rng = new RandomSource('dragonflies', 'v1');
    const s = {
      pos: [] as THREE.Vector3[],
      target: [] as THREE.Vector3[],
      hover: new Float32Array(count),
      yaw: new Float32Array(count),
    };
    for (let i = 0; i < count; i++) {
      const [dx, dz] = rng.insideDisc(POND.radius + 6);
      const x = POND.center[0] + dx;
      const z = POND.center[1] + dz;
      const y = WORLD.WATER_LEVEL + rng.range(0.4, 1.8);
      s.pos.push(new THREE.Vector3(x, y, z));
      s.target.push(new THREE.Vector3(x, y, z));
      s.hover[i] = rng.range(0.3, 2);
      s.yaw[i] = rng.angle();
    }

    return { geometry: geo, material: mat, state: s };
  }, [count]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  const meshRef = useRef<THREE.InstancedMesh>(null);

  useFrame((_, dt) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const active =
      lighting.t > 0.28 && lighting.t < 0.8 && season !== 'winter' ? 1 : 0;

    for (let i = 0; i < count; i++) {
      if (!active) {
        _critMat.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, _critMat);
        continue;
      }

      state.hover[i]! -= dt;
      if (state.hover[i]! <= 0) {
        // Pick a new spot and dash to it.
        state.hover[i] = 0.4 + Math.random() * 2.4;
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * (POND.radius + 5);
        state.target[i]!.set(
          POND.center[0] + Math.cos(a) * r,
          WORLD.WATER_LEVEL + 0.4 + Math.random() * 1.6,
          POND.center[1] + Math.sin(a) * r,
        );
      }

      const pos = state.pos[i]!;
      const target = state.target[i]!;
      /* Very short half-life: the dash is nearly instantaneous, then it stops.
       * That abruptness is the whole character of the animal. */
      pos.x = damp(pos.x, target.x, 0.16, dt);
      pos.y = damp(pos.y, target.y, 0.22, dt);
      pos.z = damp(pos.z, target.z, 0.16, dt);

      const dx = target.x - pos.x;
      const dz = target.z - pos.z;
      if (Math.abs(dx) + Math.abs(dz) > 0.05) state.yaw[i] = Math.atan2(dx, dz);

      // Wings beat far too fast to resolve — a blur is the honest depiction.
      const blur = Math.sin(performance.now() * 0.09 + i) * 0.12;
      _critEuler.set(blur, state.yaw[i]!, 0);
      _critQuat.setFromEuler(_critEuler);
      _critScale.setScalar(1);
      _critMat.compose(pos, _critQuat, _critScale);
      mesh.setMatrixAt(i, _critMat);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, count]}
      frustumCulled={false}
      name="dragonflies"
    />
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * FISH
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Pond fish.
 *
 * Mostly invisible — dark shapes cruising below the surface — until one jumps.
 * The jump is a real parabola, and it spawns a ripple in the water shader and a
 * splash in the audio engine on landing. Three systems agreeing on one event is
 * what makes it feel like something happened rather than something played.
 */
export function Fish() {
  const engine = useSynthEngine();
  const { camera } = useThree();
  const count = WILDLIFE.FISH_COUNT;

  const { geometry, material, state } = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    const body = new THREE.CapsuleGeometry(0.09, 0.3, 4, 7);
    transformGeometry(body, { rotation: [Math.PI / 2, 0, 0], scale: [0.65, 1, 1] });
    parts.push(body);
    const tail = new THREE.ConeGeometry(0.11, 0.18, 4);
    transformGeometry(tail, { position: [0, 0, -0.26], rotation: [-Math.PI / 2, 0, 0] });
    parts.push(tail);

    const geo = mergeGeometries(parts, true);
    const mat = new THREE.MeshStandardMaterial({
      color: '#4a5a48',
      roughness: 0.35,
      metalness: 0.4,
    });

    const rng = new RandomSource('fish', 'v1');
    const s = {
      angle: new Float32Array(count),
      radius: new Float32Array(count),
      speed: new Float32Array(count),
      depth: new Float32Array(count),
      /** >0 while airborne; counts down through the jump. */
      jumpTime: new Float32Array(count),
      jumpDuration: new Float32Array(count),
      nextJump: rng.range(4, 20),
      splashed: new Uint8Array(count),
    };
    for (let i = 0; i < count; i++) {
      s.angle[i] = rng.angle();
      s.radius[i] = rng.range(3, POND.radius - 3);
      s.speed[i] = rng.range(0.08, 0.24) * (rng.chance(0.5) ? 1 : -1);
      s.depth[i] = rng.range(0.35, 1.3);
    }
    return { geometry: geo, material: mat, state: s };
  }, [count]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  const meshRef = useRef<THREE.InstancedMesh>(null);
  const jumpTimer = useRef<number>(WILDLIFE.FISH_JUMP_INTERVAL);
  const audioSource = useRef<ReturnType<typeof engine.createSource>>(null);

  useEffect(() => {
    if (!engine.ready) return;
    audioSource.current = engine.createSource({
      bus: 'wildlife',
      position: [POND.center[0], WORLD.WATER_LEVEL, POND.center[1]],
      refDistance: 6,
      maxDistance: 80,
      rolloff: 1.4,
      reverbSend: 0.22,
    });
    return () => {
      audioSource.current?.dispose();
      audioSource.current = null;
    };
  }, [engine, engine.ready]);

  useFrame((_, dt) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    // Schedule the next jump.
    jumpTimer.current -= dt;
    if (jumpTimer.current <= 0) {
      jumpTimer.current = WILDLIFE.FISH_JUMP_INTERVAL * (0.4 + Math.random() * 1.4);
      const i = Math.floor(Math.random() * count);
      if (state.jumpTime[i]! <= 0) {
        state.jumpDuration[i] = 0.75 + Math.random() * 0.35;
        state.jumpTime[i] = state.jumpDuration[i]!;
        state.splashed[i] = 0;
      }
    }

    for (let i = 0; i < count; i++) {
      state.angle[i]! += state.speed[i]! * dt;
      const x = POND.center[0] + Math.cos(state.angle[i]!) * state.radius[i]!;
      const z = POND.center[1] + Math.sin(state.angle[i]!) * state.radius[i]!;

      let y = WORLD.WATER_LEVEL - state.depth[i]!;
      let pitch = 0;

      if (state.jumpTime[i]! > 0) {
        state.jumpTime[i]! -= dt;
        const duration = state.jumpDuration[i]!;
        const t = 1 - state.jumpTime[i]! / duration;

        /* A real parabola: height = 4h·t(1−t) peaks at t = 0.5 and returns to
         * zero at t = 1. Deriving the pitch from the *derivative* means the
         * fish points up on the way out and down on the way in, automatically. */
        const peak = 1.1;
        const arc = 4 * peak * t * (1 - t);
        y = WORLD.WATER_LEVEL + arc - 0.15;
        // d/dt of the arc, scaled into a pitch angle.
        pitch = Math.atan2(4 * peak * (1 - 2 * t), 3);

        // Ripple and splash on entry.
        if (t > 0.94 && !state.splashed[i]) {
          state.splashed[i] = 1;
          spawnWaterRipple(x, z);
          audioSource.current?.setPosition(x, WORLD.WATER_LEVEL, z, 0.001);
          playFishSplash(engine, audioSource.current ?? null, 0.85);
          emitAudioSubtitle('🐟', 'A fish breaks the surface', [x, WORLD.WATER_LEVEL, z], camera);
        }
        // Ripple on exit too.
        if (t < 0.06 && !state.splashed[i]) {
          spawnWaterRipple(x, z);
        }
      }

      _critPos.set(x, y, z);
      const yaw = state.angle[i]! + (state.speed[i]! > 0 ? Math.PI / 2 : -Math.PI / 2);
      _critEuler.set(pitch, yaw, Math.sin(performance.now() * 0.004 + i) * 0.18);
      _critQuat.setFromEuler(_critEuler);
      _critScale.setScalar(0.8 + (i % 4) * 0.14);
      _critMat.compose(_critPos, _critQuat, _critScale);
      mesh.setMatrixAt(i, _critMat);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, count]}
      frustumCulled={false}
      name="fish"
    />
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * LIVESTOCK
 * ─────────────────────────────────────────────────────────────────────────── */

/** Cows in the paddock. They graze, wander a little, and can be fed grain. */
export function Cattle() {
  const { terrain } = useWorld();
  const lighting = useLighting();

  const cows = useMemo(() => {
    const rng = new RandomSource('cows', 'v1');
    // The paddock, matching the fence run in Village.tsx.
    const centre: [number, number] = [37, -19];
    return Array.from({ length: VILLAGE.COW_COUNT }, (_, i) => {
      const [dx, dz] = rng.insideDisc(8);
      const x = centre[0] + dx;
      const z = centre[1] + dz;
      return {
        home: new THREE.Vector3(x, terrain.heightAt(x, z), z),
        pos: new THREE.Vector3(x, terrain.heightAt(x, z), z),
        target: new THREE.Vector3(x, terrain.heightAt(x, z), z),
        yaw: rng.angle(),
        idle: rng.range(2, 12),
        /** 0 = head down grazing, 1 = head up. */
        headUp: rng.next(),
        // Holstein-ish patchwork: some mostly white, some mostly brown.
        color: rng.pick(['#e8e4dc', '#3a2e26', '#8a6a4a', '#e0dcd4']),
        index: i,
      };
    });
  }, [terrain]);

  const { geometry, material } = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    // Body.
    const body = new THREE.BoxGeometry(0.85, 0.95, 1.75);
    transformGeometry(body, { position: [0, 1.05, 0] });
    parts.push(body);
    // Neck and head.
    const neck = new THREE.BoxGeometry(0.5, 0.5, 0.6);
    transformGeometry(neck, { position: [0, 1.15, 1.05], rotation: [0.3, 0, 0] });
    parts.push(neck);
    const head = new THREE.BoxGeometry(0.42, 0.42, 0.62);
    transformGeometry(head, { position: [0, 1.05, 1.5], rotation: [0.5, 0, 0] });
    parts.push(head);
    // Ears.
    for (const side of [-1, 1]) {
      const ear = new THREE.BoxGeometry(0.22, 0.1, 0.16);
      transformGeometry(ear, { position: [side * 0.26, 1.22, 1.42] });
      parts.push(ear);
    }
    // Legs.
    for (const [x, z] of [
      [-0.3, 0.62],
      [0.3, 0.62],
      [-0.3, -0.62],
      [0.3, -0.62],
    ] as const) {
      const leg = new THREE.BoxGeometry(0.17, 0.62, 0.17);
      transformGeometry(leg, { position: [x, 0.31, z] });
      parts.push(leg);
    }
    // Tail.
    const tail = new THREE.BoxGeometry(0.08, 0.7, 0.08);
    transformGeometry(tail, { position: [0, 1.05, -0.92], rotation: [-0.25, 0, 0] });
    parts.push(tail);

    return {
      geometry: mergeGeometries(parts, true),
      material: new THREE.MeshStandardMaterial({ color: '#e8e4dc', roughness: 0.9 }),
    };
  }, []);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  const meshRef = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    cows.forEach((cow, i) => {
      _critColor.set(cow.color);
      mesh.setColorAt(i, _critColor);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [cows]);

  useFrame((_, dt) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    // Cattle lie down at night — the herd goes quiet and still.
    const resting = lighting.lampIntensity > 0.6;

    for (let i = 0; i < cows.length; i++) {
      const cow = cows[i]!;

      if (!resting) {
        cow.idle -= dt;
        if (cow.idle <= 0) {
          cow.idle = 6 + Math.random() * 18;
          // Amble a short distance to a new patch of grass.
          const a = Math.random() * Math.PI * 2;
          const r = 1.5 + Math.random() * 4;
          const nx = cow.home.x + Math.cos(a) * r;
          const nz = cow.home.z + Math.sin(a) * r;
          cow.target.set(nx, terrain.heightAt(nx, nz), nz);
          cow.headUp = Math.random();
        }

        const dx = cow.target.x - cow.pos.x;
        const dz = cow.target.z - cow.pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.2) {
          // Cows walk slowly. 0.6 m/s is about right and looks unhurried.
          const step = Math.min(0.6 * dt, dist);
          cow.pos.x += (dx / dist) * step;
          cow.pos.z += (dz / dist) * step;
          cow.pos.y = terrain.heightAt(cow.pos.x, cow.pos.z);
          cow.yaw = damp(cow.yaw, Math.atan2(dx, dz), 0.3, dt);
        }
      }

      _critPos.copy(cow.pos);
      // Head-down grazing tilts the whole body slightly forward.
      const graze = resting ? 0 : (1 - cow.headUp) * 0.12;
      _critEuler.set(graze, cow.yaw, 0);
      _critQuat.setFromEuler(_critEuler);
      _critScale.setScalar(resting ? 0.92 : 1);
      _critMat.compose(_critPos, _critQuat, _critScale);
      mesh.setMatrixAt(i, _critMat);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, VILLAGE.COW_COUNT]}
      castShadow
      receiveShadow
      name="cattle"
    />
  );
}

/** Chickens pecking around the plaza. */
export function Chickens() {
  const { terrain } = useWorld();
  const lighting = useLighting();

  const birds = useMemo(() => {
    const rng = new RandomSource('chickens', 'v1');
    return Array.from({ length: VILLAGE.CHICKEN_COUNT }, () => {
      const [dx, dz] = rng.insideDisc(14);
      const x = dx + 4;
      const z = dz - 6;
      return {
        pos: new THREE.Vector3(x, terrain.heightAt(x, z), z),
        target: new THREE.Vector3(x, terrain.heightAt(x, z), z),
        yaw: rng.angle(),
        idle: rng.range(0.5, 3),
        peckPhase: rng.angle(),
        color: rng.pick(['#e8e0d0', '#8a5a3a', '#3a3028', '#d8c8a8']),
      };
    });
  }, [terrain]);

  const { geometry, material } = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    const body = new THREE.SphereGeometry(0.16, 8, 6);
    transformGeometry(body, { position: [0, 0.2, 0], scale: [1, 0.9, 1.25] });
    parts.push(body);
    const head = new THREE.SphereGeometry(0.085, 7, 5);
    transformGeometry(head, { position: [0, 0.36, 0.14] });
    parts.push(head);
    const beak = new THREE.ConeGeometry(0.028, 0.07, 4);
    transformGeometry(beak, { position: [0, 0.34, 0.22], rotation: [Math.PI / 2, 0, 0] });
    parts.push(beak);
    // Comb.
    const comb = new THREE.BoxGeometry(0.03, 0.06, 0.1);
    transformGeometry(comb, { position: [0, 0.43, 0.13] });
    parts.push(comb);
    // Legs.
    for (const side of [-1, 1]) {
      const leg = new THREE.CylinderGeometry(0.015, 0.015, 0.13, 4);
      transformGeometry(leg, { position: [side * 0.055, 0.065, 0] });
      parts.push(leg);
    }
    // Tail.
    const tail = new THREE.ConeGeometry(0.09, 0.16, 5);
    transformGeometry(tail, { position: [0, 0.26, -0.18], rotation: [-1.1, 0, 0] });
    parts.push(tail);

    return {
      geometry: mergeGeometries(parts, true),
      material: new THREE.MeshStandardMaterial({ color: '#e8e0d0', roughness: 0.88 }),
    };
  }, []);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  const meshRef = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    birds.forEach((b, i) => {
      _critColor.set(b.color);
      mesh.setColorAt(i, _critColor);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [birds]);

  useFrame((_, dt) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    // Chickens roost at night and vanish into the coop.
    const roosting = lighting.lampIntensity > 0.7;

    for (let i = 0; i < birds.length; i++) {
      const bird = birds[i]!;

      if (roosting) {
        _critMat.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, _critMat);
        continue;
      }

      bird.idle -= dt;
      if (bird.idle <= 0) {
        bird.idle = 0.8 + Math.random() * 3.5;
        const a = Math.random() * Math.PI * 2;
        const r = 0.5 + Math.random() * 2.5;
        const nx = bird.pos.x + Math.cos(a) * r;
        const nz = bird.pos.z + Math.sin(a) * r;
        bird.target.set(nx, terrain.heightAt(nx, nz), nz);
      }

      const dx = bird.target.x - bird.pos.x;
      const dz = bird.target.z - bird.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.1) {
        // Chickens move in quick darts, not a smooth walk.
        const step = Math.min(1.4 * dt, dist);
        bird.pos.x += (dx / dist) * step;
        bird.pos.z += (dz / dist) * step;
        bird.pos.y = terrain.heightAt(bird.pos.x, bird.pos.z);
        bird.yaw = damp(bird.yaw, Math.atan2(dx, dz), 0.08, dt);
        // Head bob while walking — chickens' heads stay still while their
        // bodies move, then snap forward. Approximated with a fast sine.
        bird.peckPhase += dt * 9;
      } else {
        // Pecking at the ground while stationary.
        bird.peckPhase += dt * 3.2;
      }

      _critPos.copy(bird.pos);
      const peck = Math.max(0, Math.sin(bird.peckPhase)) * 0.45;
      _critEuler.set(peck, bird.yaw, 0);
      _critQuat.setFromEuler(_critEuler);
      _critScale.setScalar(1);
      _critMat.compose(_critPos, _critQuat, _critScale);
      mesh.setMatrixAt(i, _critMat);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, VILLAGE.CHICKEN_COUNT]}
      castShadow
      name="chickens"
    />
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * THE FOX
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The night visitor.
 *
 * She appears on the dirt path only after 23:00, and only if the player is
 * moving slowly. Approach quietly and you can get within three metres; hurry
 * and she is gone. She is the game's one genuinely conditional encounter, and
 * the reason the "Silent Friend" achievement means something.
 */
export function Fox() {
  const { terrain } = useWorld();
  const lighting = useLighting();
  const engine = useSynthEngine();
  const { camera } = useThree();
  const discover = useGameStore((s) => s.discover);
  const unlockAchievement = useGameStore((s) => s.unlockAchievement);

  const groupRef = useRef<THREE.Group>(null);
  const state = useRef({
    present: false,
    pos: new THREE.Vector3(),
    target: new THREE.Vector3(),
    yaw: 0,
    /** Path progress along the road polyline. */
    pathT: 0.3,
    fleeing: false,
    alertness: 0,
    befriended: false,
    /** Player's smoothed speed, so a single frame spike doesn't scare her. */
    playerSpeed: 0,
  });
  const lastCamPos = useRef(new THREE.Vector3());
  const audioSource = useRef<ReturnType<typeof engine.createSource>>(null);
  const barkTimer = useRef(8);

  const { geometry, material } = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    const body = new THREE.CapsuleGeometry(0.16, 0.5, 4, 8);
    transformGeometry(body, { position: [0, 0.42, 0], rotation: [Math.PI / 2, 0, 0] });
    parts.push(body);
    // Head with a pointed muzzle — the defining fox silhouette.
    const head = new THREE.SphereGeometry(0.13, 8, 6);
    transformGeometry(head, { position: [0, 0.5, 0.4] });
    parts.push(head);
    const muzzle = new THREE.ConeGeometry(0.075, 0.22, 6);
    transformGeometry(muzzle, { position: [0, 0.46, 0.56], rotation: [Math.PI / 2, 0, 0] });
    parts.push(muzzle);
    // Big triangular ears.
    for (const side of [-1, 1]) {
      const ear = new THREE.ConeGeometry(0.06, 0.16, 4);
      transformGeometry(ear, { position: [side * 0.08, 0.63, 0.36], rotation: [0, 0, side * 0.2] });
      parts.push(ear);
    }
    // Legs.
    for (const [x, z] of [
      [-0.11, 0.2],
      [0.11, 0.2],
      [-0.11, -0.22],
      [0.11, -0.22],
    ] as const) {
      const leg = new THREE.CylinderGeometry(0.035, 0.03, 0.42, 5);
      transformGeometry(leg, { position: [x, 0.21, z] });
      parts.push(leg);
    }
    // The brush — thick and long, held low.
    const tail = new THREE.CapsuleGeometry(0.085, 0.34, 4, 7);
    transformGeometry(tail, { position: [0, 0.34, -0.52], rotation: [1.1, 0, 0] });
    parts.push(tail);

    return {
      geometry: mergeGeometries(parts, true),
      material: new THREE.MeshStandardMaterial({ color: '#c4682c', roughness: 0.82 }),
    };
  }, []);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useEffect(() => {
    if (!engine.ready) return;
    audioSource.current = engine.createSource({
      bus: 'wildlife',
      position: [0, 1, 0],
      refDistance: 5,
      maxDistance: 90,
      rolloff: 1.5,
      reverbSend: 0.35,
    });
    return () => {
      audioSource.current?.dispose();
      audioSource.current = null;
    };
  }, [engine, engine.ready]);

  useFrame((_, dt) => {
    const s = state.current;
    const group = groupRef.current;
    if (!group) return;

    /* ── Presence window ─────────────────────────────────────────────────
     * FOX_SPAWN_TIME is 0.958 ≈ 23:00. She stays until about 03:00. */
    const t = lighting.t;
    const inWindowNow = t > WILDLIFE.FOX_SPAWN_TIME || t < 0.13;

    if (!inWindowNow) {
      if (s.present) {
        s.present = false;
        group.visible = false;
      }
      return;
    }

    if (!s.present) {
      s.present = true;
      group.visible = true;
      s.fleeing = false;
      s.alertness = 0;
      s.pathT = 0.25 + Math.random() * 0.35;
      const p = ROAD_POLYLINE[Math.floor(s.pathT * (ROAD_POLYLINE.length - 1))]!;
      s.pos.set(p[0], terrain.heightAt(p[0], p[2]), p[2]);
      lastCamPos.current.copy(camera.position);
    }

    /* ── Player noise ─────────────────────────────────────────────────────
     * Smoothed over about a third of a second, so stopping abruptly calms her
     * down within a beat rather than instantly. */
    const rawSpeed = camera.position.distanceTo(lastCamPos.current) / Math.max(dt, 1e-4);
    lastCamPos.current.copy(camera.position);
    s.playerSpeed = damp(s.playerSpeed, rawSpeed, 0.33, dt);

    const distToPlayer = s.pos.distanceTo(camera.position);

    /* ── Flee logic ───────────────────────────────────────────────────────
     * Two independent triggers: moving too fast within the flee radius, or
     * simply getting very close regardless. Alertness ramps rather than
     * switching, so she raises her head and watches before she bolts — which
     * is the moment that teaches the player to slow down. */
    if (distToPlayer < WILDLIFE.FOX_FLEE_DISTANCE) {
      if (s.playerSpeed > WILDLIFE.FOX_SILENCE_SPEED) {
        s.alertness = clamp(s.alertness + dt * 2.2, 0, 1);
      } else {
        s.alertness = clamp(s.alertness - dt * 0.7, 0, 1);
      }
      if (s.alertness >= 1) s.fleeing = true;

      // The reward.
      if (!s.befriended && distToPlayer < WILDLIFE.FOX_FRIEND_DISTANCE && !s.fleeing) {
        s.befriended = true;
        if (discover('secret-fox')) {
          pushToast({
            kind: 'discovery',
            title: 'The Night Visitor',
            body: 'She looks at you for a moment, then goes back to what she was doing.',
            icon: '🦊',
            ttl: 7000,
          });
        }
        unlockAchievement('silent-friend');
      }
    } else {
      s.alertness = clamp(s.alertness - dt * 0.5, 0, 1);
    }

    if (s.fleeing) {
      /* Run away from the player, fast. Foxes are quick — 6 m/s is a genuine
       * bolt and makes the loss feel like a consequence. */
      _critTmp.subVectors(s.pos, camera.position).setY(0).normalize();
      s.pos.addScaledVector(_critTmp, 6.5 * dt);
      s.pos.y = terrain.heightAt(s.pos.x, s.pos.z);
      s.yaw = damp(s.yaw, Math.atan2(_critTmp.x, _critTmp.z), 0.1, dt);

      if (distToPlayer > 45) {
        // Far enough away — she disappears until tomorrow night.
        s.present = false;
        group.visible = false;
      }
    } else {
      // Trot along the path.
      s.pathT = wrap(s.pathT + dt * 0.012, 1);
      const idx = Math.floor(s.pathT * (ROAD_POLYLINE.length - 1));
      const p = ROAD_POLYLINE[idx]!;
      s.target.set(p[0], terrain.heightAt(p[0], p[2]), p[2]);

      _critTmp.subVectors(s.target, s.pos);
      const dist = _critTmp.length();
      if (dist > 0.1) {
        _critTmp.divideScalar(dist);
        // Slower when alert — she's watching, not travelling.
        const speed = 1.5 * (1 - s.alertness * 0.85);
        s.pos.addScaledVector(_critTmp, speed * dt);
        s.pos.y = terrain.heightAt(s.pos.x, s.pos.z);
        if (s.alertness < 0.8) {
          s.yaw = damp(s.yaw, Math.atan2(_critTmp.x, _critTmp.z), 0.25, dt);
        } else {
          // When alert she turns to face the player.
          const toPlayer = _critTmp2.subVectors(camera.position, s.pos);
          s.yaw = damp(s.yaw, Math.atan2(toPlayer.x, toPlayer.z), 0.18, dt);
        }
      }

      // The occasional bark, far off.
      barkTimer.current -= dt;
      if (barkTimer.current <= 0) {
        barkTimer.current = 14 + Math.random() * 40;
        audioSource.current?.setPosition(s.pos.x, s.pos.y + 0.5, s.pos.z, 0.001);
        playFoxBark(engine, audioSource.current ?? null, 0.7);
        emitAudioSubtitle('🦊', 'A fox barks somewhere in the dark', s.pos, camera);
      }
    }

    group.position.copy(s.pos);
    group.rotation.y = s.yaw;
    // A slight crouch as she gets alert.
    group.scale.setScalar(1 - s.alertness * 0.06);
  });

  return (
    <group ref={groupRef} visible={false} name="fox">
      <mesh geometry={geometry} material={material} castShadow />
      {/* White chest and tail tip — the markings that make a fox a fox. */}
      <mesh position={[0, 0.36, 0.24]}>
        <sphereGeometry args={[0.1, 7, 5]} />
        <meshStandardMaterial color="#f0e8dc" roughness={0.85} />
      </mesh>
      <mesh position={[0, 0.2, -0.74]}>
        <sphereGeometry args={[0.085, 7, 5]} />
        <meshStandardMaterial color="#f0e8dc" roughness={0.85} />
      </mesh>
    </group>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * THE CAT
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The sleeping cat on a windowsill.
 *
 * Wake her (F) and she stretches — a real stretch, arching then extending —
 * and meows. Then she settles back down and, after a while, goes back to sleep.
 */
export function WindowsillCat({
  position,
  wakeSignal,
}: {
  position: [number, number, number];
  /** Set to 1 by the interaction system to wake her. */
  wakeSignal: React.RefObject<number>;
}) {
  const engine = useSynthEngine();
  const { camera } = useThree();
  const discover = useGameStore((s) => s.discover);

  const groupRef = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Group>(null);
  const tailRef = useRef<THREE.Group>(null);
  const stretchTime = useRef(-1);
  const audioSource = useRef<ReturnType<typeof engine.createSource>>(null);

  useEffect(() => {
    if (!engine.ready) return;
    audioSource.current = engine.createSource({
      bus: 'wildlife',
      position,
      refDistance: 3,
      maxDistance: 40,
      rolloff: 1.6,
      reverbSend: 0.2,
    });
    return () => {
      audioSource.current?.dispose();
      audioSource.current = null;
    };
  }, [engine, engine.ready, position]);

  useFrame((_, dt) => {
    const group = groupRef.current;
    if (!group) return;

    // Wake trigger.
    if ((wakeSignal.current ?? 0) > 0 && stretchTime.current < 0) {
      wakeSignal.current = 0;
      stretchTime.current = 0;
      playCatMeow(engine, audioSource.current ?? null, 0.9);
      emitAudioSubtitle('🐈', 'A cat meows, unimpressed', position, camera);
      if (discover('secret-cat')) {
        pushToast({
          kind: 'discovery',
          title: 'The Windowsill Cat',
          body: 'She stretches, considers you, and goes back to sleep.',
          icon: '🐈',
          ttl: 6000,
        });
      }
    }

    if (stretchTime.current >= 0) {
      stretchTime.current += dt;
      const t = stretchTime.current;

      /* The stretch, in three beats: arch up (0–0.6 s), extend forward
       * (0.6–1.4 s), settle (1.4–2.6 s). Animating the *sequence* rather than
       * a single pose is what makes it read as an animal waking up. */
      if (t < 0.6) {
        const k = smoothstep(0, 0.6, t);
        group.scale.set(1, 1 + k * 0.32, 1 - k * 0.1);
        group.position.y = position[1] + k * 0.05;
      } else if (t < 1.4) {
        const k = smoothstep(0.6, 1.4, t);
        group.scale.set(1, 1.32 - k * 0.28, 0.9 + k * 0.42);
        group.position.y = position[1] + 0.05 - k * 0.05;
        if (headRef.current) headRef.current.rotation.x = -k * 0.55;
      } else if (t < 2.8) {
        const k = smoothstep(1.4, 2.8, t);
        group.scale.set(1, 1.04 - k * 0.04, 1.32 - k * 0.32);
        if (headRef.current) headRef.current.rotation.x = -0.55 + k * 0.55;
      } else {
        stretchTime.current = -1;
        group.scale.set(1, 1, 1);
        if (headRef.current) headRef.current.rotation.x = 0;
      }
    } else {
      /* Asleep: breathing. A slow, small scale oscillation on the body. This
       * is one of the cheapest possible "alive" cues and it works every time. */
      const breath = Math.sin(performance.now() * 0.0011) * 0.022;
      group.scale.set(1 + breath, 1 + breath * 0.6, 1);
    }

    // The tail twitches, awake or asleep.
    if (tailRef.current) {
      tailRef.current.rotation.y = Math.sin(performance.now() * 0.0009) * 0.35;
    }
  });

  return (
    <group ref={groupRef} position={position} name="cat">
      {/* Curled body. */}
      <mesh castShadow>
        <sphereGeometry args={[0.16, 10, 8]} />
        <meshStandardMaterial color="#4a4038" roughness={0.92} />
      </mesh>
      <group ref={headRef} position={[0, 0.06, 0.13]}>
        <mesh castShadow>
          <sphereGeometry args={[0.09, 9, 7]} />
          <meshStandardMaterial color="#4a4038" roughness={0.92} />
        </mesh>
        {/* Ears. */}
        {[-1, 1].map((side) => (
          <mesh key={side} position={[side * 0.05, 0.07, -0.01]} rotation={[0, 0, side * 0.3]}>
            <coneGeometry args={[0.035, 0.07, 4]} />
            <meshStandardMaterial color="#4a4038" roughness={0.92} />
          </mesh>
        ))}
      </group>
      <group ref={tailRef}>
        <mesh position={[0.13, -0.03, -0.08]} rotation={[0, 0.5, 1.4]} castShadow>
          <capsuleGeometry args={[0.028, 0.22, 3, 6]} />
          <meshStandardMaterial color="#4a4038" roughness={0.92} />
        </mesh>
      </group>
    </group>
  );
}

const _critPos = new THREE.Vector3();
const _critQuat = new THREE.Quaternion();
const _critEuler = new THREE.Euler();
const _critScale = new THREE.Vector3();
const _critMat = new THREE.Matrix4();
const _critColor = new THREE.Color();
const _critTmp = new THREE.Vector3();
const _critTmp2 = new THREE.Vector3();
