/**
 * Weather visuals: clouds, rain, snow, falling leaves and lightning.
 *
 * All particle systems here follow the same pattern — a fixed-size buffer of
 * particles inside a volume that **follows the camera**. Rain does not fall
 * across the whole 400 m valley; it falls in a 34 m cylinder around the player
 * that moves with them. From inside, the two are indistinguishable, and the
 * second costs 1 % as much.
 *
 * Particles wrap rather than respawn: when one falls out of the bottom of the
 * volume its Y is reset to the top and its XZ is randomised. No allocation, no
 * pooling logic, no spawn timers.
 *
 * @module components/scene/Weather
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { useLighting } from '@/hooks/useTimeOfDay';
import { useWindField } from '@/hooks/useWind';
import { useGameStore } from '@/store/gameStore';
import { useSettingsStore } from '@/store/settingsStore';
import { cloudSprite, softSprite } from '@/lib/textures/procedural';
import { mulberry32 } from '@/lib/utils/random';
import { CLOUDS, PRECIPITATION, WEATHER, QUALITY_PRESETS } from '@/config/game';
import { Throttle } from '@/lib/utils/perf';
import { clamp, damp } from '@/lib/utils/math';

/**
 * Returns the particle budget multiplier for the current quality preset,
 * clamped to 1.
 *
 * Every particle system below allocates its buffers once at full capacity.
 * A multiplier above 1 would walk off the end of them — and when that happens
 * inside a `useEffect`, React unmounts the entire tree and the game never
 * renders at all. The clamp makes that impossible regardless of what a future
 * edit puts in `QUALITY_PRESETS`.
 */
function useParticleBudget(): number {
  const preset = useSettingsStore((s) => s.graphics.preset);
  return useMemo(() => {
    const p = preset === 'custom' ? 'high' : preset;
    return Math.min(1, QUALITY_PRESETS[p]?.maxParticles ?? 1);
  }, [preset]);
}

/* ───────────────────────────────────────────────────────────────────────────
 * CLOUDS
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Drifting cloud billboards.
 *
 * Each cloud is a cluster of camera-facing sprites at high altitude, drifting
 * on the real wind vector. Because they share the wind field with the grass,
 * the clouds move the same way the wheat does — a small consistency the eye
 * notices even when it can't say why.
 *
 * Updated at 10 Hz. Clouds move a few centimetres per frame; nobody has ever
 * noticed.
 */
export function Clouds() {
  const lighting = useLighting();
  const wind = useWindField();
  const weather = useGameStore((s) => s.weather);
  const { camera } = useThree();
  const tick = useMemo(() => new Throttle(CLOUDS.UPDATE_HZ), []);
  const opacity = useRef(0.5);

  const { geometry, material, puffs } = useMemo(() => {
    const rand = mulberry32(0xc10ad5);
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: cloudSprite(256),
      transparent: true,
      depthWrite: false,
      // Clouds must not receive fog — they *are* the atmosphere.
      fog: false,
      side: THREE.DoubleSide,
    });

    /* Each cloud is 4–7 overlapping puffs. A single sprite reads as a decal;
     * a cluster at slightly different depths reads as volume. */
    const list: Array<{
      x: number;
      y: number;
      z: number;
      scale: number;
      cloudIndex: number;
    }> = [];

    for (let c = 0; c < CLOUDS.COUNT; c++) {
      const baseX = (rand() - 0.5) * 900;
      const baseZ = (rand() - 0.5) * 900;
      const baseY = CLOUDS.ALTITUDE[0] + rand() * (CLOUDS.ALTITUDE[1] - CLOUDS.ALTITUDE[0]);
      const baseScale = CLOUDS.SCALE[0] + rand() * (CLOUDS.SCALE[1] - CLOUDS.SCALE[0]);
      const puffCount = 4 + Math.floor(rand() * 4);

      for (let p = 0; p < puffCount; p++) {
        list.push({
          x: baseX + (rand() - 0.5) * baseScale * 0.9,
          y: baseY + (rand() - 0.5) * baseScale * 0.16,
          z: baseZ + (rand() - 0.5) * baseScale * 0.9,
          scale: baseScale * (0.55 + rand() * 0.6),
          cloudIndex: c,
        });
      }
    }

    return { geometry: geo, material: mat, puffs: list };
  }, []);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  const meshRef = useRef<THREE.InstancedMesh>(null);
  const drift = useRef({ x: 0, z: 0 });

  useFrame((_, dt) => {
    if (!tick.step(dt)) return;
    const sdt = tick.elapsed;
    const mesh = meshRef.current;
    if (!mesh) return;

    // Advance the drift by the wind vector.
    drift.current.x += wind.vector.x * wind.strength * CLOUDS.DRIFT_FACTOR * sdt;
    drift.current.z += wind.vector.y * wind.strength * CLOUDS.DRIFT_FACTOR * sdt;

    const cover = WEATHER[weather]?.cloudCover ?? 0.2;
    opacity.current = damp(opacity.current, clamp(cover * 1.15, 0.05, 1), 2.5, sdt);
    material.opacity = opacity.current;

    /* Clouds are lit by the sun's colour, and darken underneath as cover
     * increases. Storm clouds are near-black; fair-weather cumulus are white
     * with a faint warm top. */
    const stormy = clamp((cover - 0.55) / 0.45, 0, 1);
    _cloudColor.copy(lighting.sunColor).lerp(_white, 0.55).multiplyScalar(1 - stormy * 0.62);
    _cloudColor.lerp(lighting.ambientColor, stormy * 0.45);
    material.color.copy(_cloudColor);

    const wrap = 1000;
    for (let i = 0; i < puffs.length; i++) {
      const puff = puffs[i]!;
      /* Wrap the drift so clouds circulate forever without the coordinates
       * growing without bound (which eventually destroys float precision). */
      let x = puff.x + drift.current.x;
      let z = puff.z + drift.current.z;
      x = ((((x - camera.position.x) % wrap) + wrap * 1.5) % wrap) - wrap / 2 + camera.position.x;
      z = ((((z - camera.position.z) % wrap) + wrap * 1.5) % wrap) - wrap / 2 + camera.position.z;

      _cloudPos.set(x, puff.y, z);
      /* Billboard toward the camera on the Y axis only. A full lookAt would
       * tilt the cloud when the player looks up, which reads as a flat card. */
      const angle = Math.atan2(camera.position.x - x, camera.position.z - z);
      _cloudQuat.setFromAxisAngle(_upVec, angle);
      _cloudScale.set(puff.scale, puff.scale * 0.62, puff.scale);
      _cloudMat.compose(_cloudPos, _cloudQuat, _cloudScale);
      mesh.setMatrixAt(i, _cloudMat);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, puffs.length]}
      frustumCulled={false}
      renderOrder={-500}
      name="clouds"
    />
  );
}

const _cloudPos = new THREE.Vector3();
const _cloudQuat = new THREE.Quaternion();
const _cloudScale = new THREE.Vector3();
const _cloudMat = new THREE.Matrix4();
const _cloudColor = new THREE.Color();
const _white = new THREE.Color(0xffffff);
const _upVec = new THREE.Vector3(0, 1, 0);

/** Allocated buffer size for the autumn leaf system. */
const LEAF_CAPACITY = 420;

/* ───────────────────────────────────────────────────────────────────────────
 * RAIN
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Rain, as GL line segments rather than points.
 *
 * A raindrop seen by the eye (or a camera) is a **streak**, not a dot —
 * motion blur over the exposure time. Rendering rain as short lines aligned to
 * the fall direction is both cheaper than a textured quad and more accurate:
 * the streak length even scales with fall speed, exactly as a real motion blur
 * would.
 */
export function Rain() {
  const weather = useGameStore((s) => s.weather);
  const wind = useWindField();
  const lighting = useLighting();
  const { camera } = useThree();
  const budget = useParticleBudget();

  const intensity = WEATHER[weather]?.rain ?? 0;
  const count = Math.min(
    PRECIPITATION.RAIN_PARTICLES,
    Math.floor(PRECIPITATION.RAIN_PARTICLES * budget * intensity),
  );

  const { geometry, material, positions, velocities } = useMemo(() => {
    const maxCount = Math.floor(PRECIPITATION.RAIN_PARTICLES * 1.5);
    const pos = new Float32Array(maxCount * 6); // Two endpoints per streak.
    const vel = new Float32Array(maxCount);
    const rand = mulberry32(0x2a1d2);

    for (let i = 0; i < maxCount; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * PRECIPITATION.RAIN_RADIUS;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = rand() * PRECIPITATION.RAIN_HEIGHT;
      // Per-drop speed variation so the sheet has depth.
      vel[i] = PRECIPITATION.RAIN_SPEED * (0.8 + rand() * 0.45);

      pos[i * 6] = x;
      pos[i * 6 + 1] = y;
      pos[i * 6 + 2] = z;
      pos[i * 6 + 3] = x;
      pos[i * 6 + 4] = y - 0.55;
      pos[i * 6 + 5] = z;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), PRECIPITATION.RAIN_RADIUS * 2);

    const mat = new THREE.LineBasicMaterial({
      color: '#9fb8c8',
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      fog: false,
    });

    return { geometry: geo, material: mat, positions: pos, velocities: vel };
  }, []);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  const groupRef = useRef<THREE.Group>(null);

  useFrame((_, dt) => {
    if (count === 0) return;
    const attr = geometry.attributes.position as THREE.BufferAttribute;

    // Wind pushes the rain sideways; hard rain leans noticeably.
    const driftX = wind.vector.x * wind.strength * 5.5;
    const driftZ = wind.vector.y * wind.strength * 5.5;

    for (let i = 0; i < count; i++) {
      const base = i * 6;
      const speed = velocities[i]!;
      const fall = speed * dt;

      positions[base + 1]! -= fall;
      positions[base + 4]! -= fall;
      positions[base]! += driftX * dt;
      positions[base + 3]! += driftX * dt;
      positions[base + 2]! += driftZ * dt;
      positions[base + 5]! += driftZ * dt;

      // Wrap back to the top of the column.
      if (positions[base + 1]! < 0) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * PRECIPITATION.RAIN_RADIUS;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const y = PRECIPITATION.RAIN_HEIGHT;
        // Streak length scales with speed — genuine motion blur.
        const len = 0.35 + speed * 0.016;
        positions[base] = x;
        positions[base + 1] = y;
        positions[base + 2] = z;
        positions[base + 3] = x - driftX * 0.02;
        positions[base + 4] = y - len;
        positions[base + 5] = z - driftZ * 0.02;
      }
    }

    attr.needsUpdate = true;
    geometry.setDrawRange(0, count * 2);

    // The volume follows the player.
    if (groupRef.current) {
      groupRef.current.position.set(camera.position.x, 0, camera.position.z);
    }

    // Rain is lit by the sky, so it darkens at night.
    material.opacity = 0.42 * clamp(lighting.ambientIntensity * 1.6 + 0.15, 0.15, 1);
  });

  if (count === 0) return null;

  return (
    <group ref={groupRef} name="rain">
      <lineSegments geometry={geometry} material={material} frustumCulled={false} />
    </group>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * SNOW
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Snow.
 *
 * Points rather than lines — snowflakes tumble slowly enough that they read as
 * discrete specks. Each flake follows a slow helical path (a sine on X and a
 * cosine on Z, out of phase) which is a very cheap approximation of the
 * fluttering descent of a real flake, and far more convincing than straight
 * vertical fall.
 */
export function Snow() {
  const weather = useGameStore((s) => s.weather);
  const season = useGameStore((s) => s.season);
  const wind = useWindField();
  const { camera } = useThree();
  const budget = useParticleBudget();

  // Snow falls in the snow weather state, and lightly all winter.
  const weatherSnow = WEATHER[weather]?.snow ?? 0;
  const intensity = Math.max(weatherSnow, season === 'winter' ? 0.25 : 0);
  const count = Math.min(
    PRECIPITATION.SNOW_PARTICLES,
    Math.floor(PRECIPITATION.SNOW_PARTICLES * budget * intensity),
  );

  const { geometry, material, data } = useMemo(() => {
    const maxCount = PRECIPITATION.SNOW_PARTICLES;
    const positions = new Float32Array(maxCount * 3);
    const sizes = new Float32Array(maxCount);
    const rand = mulberry32(0x5f0);
    const state = {
      phase: new Float32Array(maxCount),
      speed: new Float32Array(maxCount),
      swirl: new Float32Array(maxCount),
    };

    for (let i = 0; i < maxCount; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * PRECIPITATION.SNOW_RADIUS;
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = rand() * PRECIPITATION.SNOW_HEIGHT;
      positions[i * 3 + 2] = Math.sin(a) * r;
      sizes[i] = 0.06 + rand() * 0.13;
      state.phase[i] = rand() * Math.PI * 2;
      state.speed[i] = PRECIPITATION.SNOW_SPEED * (0.55 + rand() * 0.9);
      state.swirl[i] = 0.3 + rand() * 0.9;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), PRECIPITATION.SNOW_RADIUS * 2);

    const mat = new THREE.PointsMaterial({
      size: 0.16,
      map: softSprite(64, 1.4),
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      sizeAttenuation: true,
      color: '#ffffff',
      fog: false,
    });

    return { geometry: geo, material: mat, data: { positions, state } };
  }, []);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  const groupRef = useRef<THREE.Group>(null);
  const time = useRef(0);

  useFrame((_, dt) => {
    if (count === 0) return;
    time.current += dt;
    const { positions, state } = data;
    const attr = geometry.attributes.position as THREE.BufferAttribute;

    const driftX = wind.vector.x * wind.strength * 2.2;
    const driftZ = wind.vector.y * wind.strength * 2.2;

    for (let i = 0; i < count; i++) {
      const b = i * 3;
      positions[b + 1]! -= state.speed[i]! * dt;

      // The helical flutter.
      const swirl = state.swirl[i]!;
      const phase = state.phase[i]! + time.current * swirl;
      positions[b]! += (Math.sin(phase) * swirl * 0.55 + driftX) * dt;
      positions[b + 2]! += (Math.cos(phase * 0.83) * swirl * 0.55 + driftZ) * dt;

      if (positions[b + 1]! < -1) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * PRECIPITATION.SNOW_RADIUS;
        positions[b] = Math.cos(a) * r;
        positions[b + 1] = PRECIPITATION.SNOW_HEIGHT;
        positions[b + 2] = Math.sin(a) * r;
      }
    }

    attr.needsUpdate = true;
    geometry.setDrawRange(0, count);

    if (groupRef.current) {
      groupRef.current.position.set(camera.position.x, 0, camera.position.z);
    }
  });

  if (count === 0) return null;

  return (
    <group ref={groupRef} name="snow">
      <points geometry={geometry} material={material} frustumCulled={false} />
    </group>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * AUTUMN LEAVES
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Leaves swirling on the wind.
 *
 * Active in autumn, and much heavier during the Autumn Wind weather state.
 * Each leaf tumbles on all three axes at its own rate — a leaf that falls
 * without rotating looks like confetti.
 */
export function FallingLeaves() {
  const season = useGameStore((s) => s.season);
  const weather = useGameStore((s) => s.weather);
  const wind = useWindField();
  const { camera } = useThree();
  const budget = useParticleBudget();

  const active = season === 'autumn';
  const gusty = weather === 'autumnWind';
  // `LEAF_CAPACITY` is the allocated buffer size; never exceed it.
  const count = active ? Math.min(LEAF_CAPACITY, Math.floor((gusty ? LEAF_CAPACITY : 160) * budget)) : 0;

  const { geometry, material, state } = useMemo(() => {
    const max = LEAF_CAPACITY;
    const geo = new THREE.PlaneGeometry(0.22, 0.16);
    const mat = new THREE.MeshBasicMaterial({
      color: '#d4802f',
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    const rand = mulberry32(0x1eaf);
    const s = {
      pos: new Float32Array(max * 3),
      rot: new Float32Array(max * 3),
      rotSpeed: new Float32Array(max * 3),
      fall: new Float32Array(max),
      colors: [] as THREE.Color[],
    };

    const palette = ['#d4802f', '#c05a2a', '#e8a83c', '#a8482a', '#b8923c'];
    for (let i = 0; i < max; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * 30;
      s.pos[i * 3] = Math.cos(a) * r;
      s.pos[i * 3 + 1] = rand() * 22;
      s.pos[i * 3 + 2] = Math.sin(a) * r;
      s.rot[i * 3] = rand() * Math.PI * 2;
      s.rot[i * 3 + 1] = rand() * Math.PI * 2;
      s.rot[i * 3 + 2] = rand() * Math.PI * 2;
      s.rotSpeed[i * 3] = (rand() - 0.5) * 3.4;
      s.rotSpeed[i * 3 + 1] = (rand() - 0.5) * 3.4;
      s.rotSpeed[i * 3 + 2] = (rand() - 0.5) * 3.4;
      s.fall[i] = 0.7 + rand() * 1.3;
      s.colors.push(new THREE.Color(palette[Math.floor(rand() * palette.length)]!));
    }

    return { geometry: geo, material: mat, state: s };
  }, []);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  const meshRef = useRef<THREE.InstancedMesh>(null);
  const groupRef = useRef<THREE.Group>(null);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    // Never index past the pre-built colour table; see `particleBudget`.
    const n = Math.min(count, state.colors.length);
    for (let i = 0; i < n; i++) {
      mesh.setColorAt(i, state.colors[i]!);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [count, state.colors]);

  useFrame((_, dt) => {
    const mesh = meshRef.current;
    if (!mesh || count === 0) return;

    const driftX = wind.vector.x * wind.strength * 4.5;
    const driftZ = wind.vector.y * wind.strength * 4.5;

    for (let i = 0; i < count; i++) {
      const b = i * 3;
      state.pos[b + 1]! -= state.fall[i]! * dt;
      state.pos[b]! += driftX * dt;
      state.pos[b + 2]! += driftZ * dt;

      state.rot[b]! += state.rotSpeed[b]! * dt;
      state.rot[b + 1]! += state.rotSpeed[b + 1]! * dt;
      state.rot[b + 2]! += state.rotSpeed[b + 2]! * dt;

      if (state.pos[b + 1]! < -0.5) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * 30;
        state.pos[b] = Math.cos(a) * r;
        state.pos[b + 1] = 18 + Math.random() * 6;
        state.pos[b + 2] = Math.sin(a) * r;
      }

      _leafPos.set(state.pos[b]!, state.pos[b + 1]!, state.pos[b + 2]!);
      _leafEuler.set(state.rot[b]!, state.rot[b + 1]!, state.rot[b + 2]!);
      _leafQuat.setFromEuler(_leafEuler);
      _leafMat.compose(_leafPos, _leafQuat, _leafScale);
      mesh.setMatrixAt(i, _leafMat);
    }
    mesh.instanceMatrix.needsUpdate = true;

    if (groupRef.current) {
      groupRef.current.position.set(camera.position.x, 0, camera.position.z);
    }
  });

  if (count === 0) return null;

  return (
    <group ref={groupRef} name="leaves">
      <instancedMesh ref={meshRef} args={[geometry, material, count]} frustumCulled={false} />
    </group>
  );
}

const _leafPos = new THREE.Vector3();
const _leafEuler = new THREE.Euler();
const _leafQuat = new THREE.Quaternion();
const _leafMat = new THREE.Matrix4();
const _leafScale = new THREE.Vector3(1, 1, 1);

/* ───────────────────────────────────────────────────────────────────────────
 * LIGHTNING
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Lightning flashes.
 *
 * No bolt geometry — just a full-scene ambient flash. A real strike is almost
 * always behind cloud, and what you actually see is the whole sky lighting up.
 * The flash is a **double pulse** (bright, brief dark, brighter) because that
 * is the signature rhythm of a multi-stroke discharge, and it is instantly
 * recognisable.
 *
 * The thunder audio is triggered separately by `AmbienceSystem`, delayed by
 * distance — so you see the flash, count, and then hear it.
 */
export function Lightning() {
  const weather = useGameStore((s) => s.weather);
  const reducedMotion = useSettingsStore((s) => s.accessibility.reducedMotion);
  const lightRef = useRef<THREE.AmbientLight>(null);
  const nextStrike = useRef<number>(PRECIPITATION.THUNDER_INTERVAL);
  const flash = useRef<{ t: number; strength: number } | null>(null);

  useFrame((_, dt) => {
    const light = lightRef.current;
    if (!light) return;

    if (weather !== 'storm' || reducedMotion) {
      light.intensity = 0;
      return;
    }

    nextStrike.current -= dt;
    if (nextStrike.current <= 0) {
      nextStrike.current = PRECIPITATION.THUNDER_INTERVAL * (0.5 + Math.random());
      flash.current = { t: 0, strength: 0.6 + Math.random() * 1.6 };
    }

    if (flash.current) {
      flash.current.t += dt;
      const t = flash.current.t;
      const strength = flash.current.strength;
      let envelope = 0;
      // First stroke.
      if (t < 0.07) envelope = 1 - t / 0.07;
      // Gap.
      else if (t < 0.12) envelope = 0;
      // Second, brighter stroke.
      else if (t < 0.3) envelope = (1 - (t - 0.12) / 0.18) * 1.25;
      else flash.current = null;

      light.intensity = envelope * strength;
    } else {
      light.intensity = 0;
    }
  });

  return <ambientLight ref={lightRef} color="#cfe0ff" intensity={0} />;
}

/**
 * Ground mist.
 *
 * A stack of large horizontal quads at low altitude with a soft cloud texture,
 * scrolling slowly. Layering several at slightly different heights and speeds
 * gives the parallax that makes mist read as a volume rather than a decal —
 * and it costs four transparent quads.
 */
export function GroundMist() {
  const lighting = useLighting();
  const weather = useGameStore((s) => s.weather);
  const season = useGameStore((s) => s.season);
  const { camera } = useThree();
  const groupRef = useRef<THREE.Group>(null);
  const opacity = useRef(0);

  const layers = 4;
  const { geometry, materials } = useMemo(() => {
    const geo = new THREE.PlaneGeometry(220, 220);
    geo.rotateX(-Math.PI / 2);
    const mats = Array.from({ length: layers }, (_, i) => {
      const m = new THREE.MeshBasicMaterial({
        map: cloudSprite(256),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        color: '#e8eef2',
        fog: false,
      });
      // Each layer gets its own texture offset so they don't overlap exactly.
      m.map!.offset.set(i * 0.31, i * 0.17);
      return m;
    });
    return { geometry: geo, materials: mats };
  }, []);

  useEffect(
    () => () => {
      geometry.dispose();
      materials.forEach((m) => m.dispose());
    },
    [geometry, materials],
  );

  useFrame((_, dt) => {
    /* Mist is thickest at dawn and in fog weather — and, satisfyingly, exactly
     * when the fog density uniform is highest, so it always agrees with the
     * atmospheric fog rather than fighting it. */
    const dawnBoost = 1 - Math.min(Math.abs(lighting.t - 0.21) * 8, 1);
    const weatherBoost = weather === 'fog' ? 1 : weather === 'cloudy' ? 0.3 : 0;
    const winterBoost = season === 'winter' ? 0.25 : 0;
    const target = clamp(dawnBoost * 0.55 + weatherBoost * 0.75 + winterBoost, 0, 0.85);
    opacity.current = damp(opacity.current, target, 3, dt);

    materials.forEach((m, i) => {
      m.opacity = opacity.current * (0.5 - i * 0.08);
      m.color.copy(lighting.fogColor).lerp(_white, 0.5);
      // Scroll each layer at a different rate — the source of the parallax.
      if (m.map) {
        m.map.offset.x += dt * 0.0035 * (i + 1);
        m.map.offset.y += dt * 0.0021 * (i + 1);
      }
    });

    if (groupRef.current) {
      groupRef.current.position.set(camera.position.x, 0, camera.position.z);
    }
  });

  if (opacity.current < 0.01) return null;

  return (
    <group ref={groupRef} name="ground-mist" renderOrder={-400}>
      {materials.map((m, i) => (
        <mesh key={i} geometry={geometry} material={m} position={[0, 2.2 + i * 1.6, 0]} />
      ))}
    </group>
  );
}
