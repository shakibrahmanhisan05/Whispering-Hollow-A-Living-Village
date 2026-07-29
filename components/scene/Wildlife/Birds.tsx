/**
 * Birds.
 *
 * Each bird lives in one of three states — **perched**, **flying** or
 * **landing** — and the whole system is driven by that state machine rather
 * than by animation clips.
 *
 * The startle behaviour is the point. Approach a perched bird and it takes off;
 * ring the church bell and every bird on the map takes off at once; and twenty
 * seconds before the train arrives, the birds by the track go up before you
 * have heard anything. That last one is the first beat of the train ritual and
 * it works precisely because the birds are a real simulated system the rest of
 * the game can poke.
 *
 * @module components/scene/Wildlife/Birds
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { useWorld } from '../TerrainContext';
import { useGameStore } from '@/store/gameStore';
import { mergeGeometries, transformGeometry } from '@/lib/geometry/merge';
import { RandomSource } from '@/lib/utils/random';
import { BIRD_SPECIES } from '@/lib/progression/content';
import { WILDLIFE, ZONES, SEASONS, WORLD } from '@/config/game';
import { clamp, wrap } from '@/lib/utils/math';
import { Throttle } from '@/lib/utils/perf';

type BirdState = 'perched' | 'flying' | 'landing';

interface Bird {
  speciesIndex: number;
  state: BirdState;
  /** Current world position. */
  pos: THREE.Vector3;
  /** Current velocity. */
  vel: THREE.Vector3;
  /** Where it perches when at rest. */
  perch: THREE.Vector3;
  /** Where it is heading while flying. */
  target: THREE.Vector3;
  /** Seconds remaining in the current flight. */
  flightTime: number;
  /** Wing flap phase. */
  flapPhase: number;
  /** Body yaw. */
  yaw: number;
  /** Has the player observed this species yet? */
  observed: boolean;
  /** Scale multiplier. */
  scale: number;
}

/** Module-level registry so other systems can startle the flock. */
const flock: Bird[] = [];
let startleAllRequested = false;

/**
 * Startles every bird on the map.
 *
 * Called by the church bell interaction and by the train director at T−20s.
 * Uses a flag rather than mutating directly so the change is applied inside the
 * frame loop, where the rest of the bird state lives.
 */
export function startleAllBirds(): void {
  startleAllRequested = true;
}

/** Startles only the birds within `radius` of a point. */
export function startleBirdsNear(x: number, z: number, radius: number): void {
  const r2 = radius * radius;
  for (const bird of flock) {
    if (bird.state !== 'perched') continue;
    const dx = bird.pos.x - x;
    const dz = bird.pos.z - z;
    if (dx * dx + dz * dz < r2) takeOff(bird);
  }
}

function takeOff(bird: Bird): void {
  bird.state = 'flying';
  bird.flightTime = WILDLIFE.BIRD_FLIGHT_DURATION * (0.7 + Math.random() * 0.6);
  // An initial burst upward and away.
  bird.vel.set((Math.random() - 0.5) * 6, 4 + Math.random() * 3, (Math.random() - 0.5) * 6);
}

export function Birds() {
  const { terrain } = useWorld();
  const season = useGameStore((s) => s.season);
  const timeOfDay = useGameStore((s) => s.timeOfDay);
  const discover = useGameStore((s) => s.discover);
  const advanceAchievement = useGameStore((s) => s.advanceAchievement);
  const { camera } = useThree();

  const meshRef = useRef<THREE.InstancedMesh>(null);
  const wingRef = useRef<THREE.InstancedMesh>(null);
  const flapTick = useMemo(() => new Throttle(WILDLIFE.BIRD_FLAP_HZ), []);

  /* ── Geometry ────────────────────────────────────────────────────────────
   * A bird is a body capsule, a head sphere, a tail wedge and a beak cone —
   * four primitives, merged. At the distance birds are normally seen, more
   * detail than that is invisible, and instancing 46 of them costs one draw. */
  const { bodyGeo, wingGeo, material, wingMaterial } = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];

    const body = new THREE.CapsuleGeometry(0.085, 0.16, 3, 7);
    transformGeometry(body, { rotation: [Math.PI / 2, 0, 0] });
    parts.push(body);

    const head = new THREE.SphereGeometry(0.068, 7, 6);
    transformGeometry(head, { position: [0, 0.045, 0.135] });
    parts.push(head);

    const beak = new THREE.ConeGeometry(0.022, 0.075, 5);
    transformGeometry(beak, { position: [0, 0.04, 0.205], rotation: [Math.PI / 2, 0, 0] });
    parts.push(beak);

    const tail = new THREE.BoxGeometry(0.09, 0.014, 0.15);
    transformGeometry(tail, { position: [0, 0.01, -0.19], rotation: [0.2, 0, 0] });
    parts.push(tail);

    // Wings are a separate instanced mesh so they can flap independently.
    const wing = new THREE.BufferGeometry();
    // A simple swept triangle pair, mirrored.
    const wingVerts = new Float32Array([
      0, 0, 0.04, 0.32, 0.02, -0.02, 0.1, 0, -0.11,
      0, 0, 0.04, -0.1, 0, -0.11, -0.32, 0.02, -0.02,
    ]);
    wing.setAttribute('position', new THREE.BufferAttribute(wingVerts, 3));
    wing.setAttribute(
      'uv',
      new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 1, 0]), 2),
    );
    wing.computeVertexNormals();

    return {
      bodyGeo: mergeGeometries(parts, true),
      wingGeo: wing,
      material: new THREE.MeshStandardMaterial({ color: '#7a6a52', roughness: 0.85 }),
      wingMaterial: new THREE.MeshStandardMaterial({
        color: '#5c4f3c',
        roughness: 0.88,
        side: THREE.DoubleSide,
      }),
    };
  }, []);

  useEffect(
    () => () => {
      bodyGeo.dispose();
      wingGeo.dispose();
      material.dispose();
      wingMaterial.dispose();
    },
    [bodyGeo, wingGeo, material, wingMaterial],
  );

  /* ── Population ──────────────────────────────────────────────────────── */
  useEffect(() => {
    flock.length = 0;
    const rng = new RandomSource(terrain.seed, 'birds');

    for (let i = 0; i < WILDLIFE.BIRD_COUNT; i++) {
      const speciesIndex = i % BIRD_SPECIES.length;
      const species = BIRD_SPECIES[speciesIndex]!;
      const zoneId = species.zones[i % species.zones.length]!;
      const zone = ZONES[zoneId];

      // Find a perch: somewhere in the zone, on the ground or notionally in a
      // tree (we approximate tree height rather than querying the instances).
      const [dx, dz] = rng.insideDisc(zone.radius * 0.85);
      const x = clamp(zone.center[0] + dx, -WORLD.HALF + 10, WORLD.HALF - 10);
      const z = clamp(zone.center[1] + dz, -WORLD.HALF + 10, WORLD.HALF - 10);
      const ground = terrain.heightAt(x, z);
      // Most birds perch in the canopy; a few forage on the ground.
      const perchHeight = rng.chance(0.28) ? 0.12 : rng.range(5, 11);

      const perch = new THREE.Vector3(x, ground + perchHeight, z);
      flock.push({
        speciesIndex,
        state: 'perched',
        pos: perch.clone(),
        vel: new THREE.Vector3(),
        perch,
        target: perch.clone(),
        flightTime: 0,
        flapPhase: rng.angle(),
        yaw: rng.angle(),
        observed: false,
        scale: rng.range(0.85, 1.35),
      });
    }
  }, [terrain]);

  /* Per-species colours, applied once as instance colours. */
  useEffect(() => {
    const mesh = meshRef.current;
    const wings = wingRef.current;
    if (!mesh || !wings) return;
    for (let i = 0; i < flock.length; i++) {
      const species = BIRD_SPECIES[flock[i]!.speciesIndex]!;
      _birdColor.set(species.colors.body);
      mesh.setColorAt(i, _birdColor);
      _birdColor.set(species.colors.wing);
      wings.setColorAt(i, _birdColor);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (wings.instanceColor) wings.instanceColor.needsUpdate = true;
  }, [terrain]);

  useFrame((_, dt) => {
    const mesh = meshRef.current;
    const wings = wingRef.current;
    if (!mesh || !wings || flock.length === 0) return;

    if (startleAllRequested) {
      startleAllRequested = false;
      for (const bird of flock) {
        if (bird.state === 'perched') takeOff(bird);
      }
    }

    const seasonDensity = SEASONS[season].wildlifeDensity;
    const flapping = flapTick.step(dt);

    for (let i = 0; i < flock.length; i++) {
      const bird = flock[i]!;
      const species = BIRD_SPECIES[bird.speciesIndex]!;

      /* Species that aren't active at this hour are simply hidden — an owl
       * should not be sitting in a hedge at noon. */
      const active = inWindow(timeOfDay, species.active) && i / flock.length < seasonDensity;
      if (!active) {
        _birdMatrix.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, _birdMatrix);
        wings.setMatrixAt(i, _birdMatrix);
        continue;
      }

      const distToPlayer = bird.pos.distanceTo(camera.position);

      switch (bird.state) {
        case 'perched': {
          /* ── Startle check ─────────────────────────────────────────────
           * Species have different tolerances — a robin lets you get within
           * six metres, a nightjar flushes at twelve. That variation is what
           * makes the birdwatching collectible a genuine challenge rather
           * than a walk-up. */
          if (distToPlayer < WILDLIFE.BIRD_STARTLE_RADIUS) {
            takeOff(bird);
            break;
          }

          /* ── Observation ───────────────────────────────────────────────
           * Getting inside the species' approach distance *without* startling
           * it counts as an observation. Because the startle radius is
           * smaller than several species' approach distances, some birds can
           * only be logged from a respectful distance — which is the whole
           * idea. */
          if (!bird.observed && distToPlayer < species.approachDistance) {
            bird.observed = true;
            if (discover(`bird-${species.id}`)) {
              advanceAchievement('ornithologist', 1);
            }
          }

          // Idle: settle onto the perch, with a small hop now and then.
          bird.pos.lerp(bird.perch, Math.min(dt * 4, 1));
          bird.yaw += Math.sin(performance.now() * 0.0004 + i) * dt * 0.4;
          break;
        }

        case 'flying': {
          bird.flightTime -= dt;

          if (bird.flightTime <= 0) {
            bird.state = 'landing';
            /* Pick a new perch, biased away from the player so the bird
             * doesn't land at your feet. */
            const away = _birdTmp
              .subVectors(bird.pos, camera.position)
              .setY(0)
              .normalize()
              .multiplyScalar(18 + Math.random() * 20);
            const nx = clamp(bird.pos.x + away.x, -WORLD.HALF + 12, WORLD.HALF - 12);
            const nz = clamp(bird.pos.z + away.z, -WORLD.HALF + 12, WORLD.HALF - 12);
            bird.perch.set(nx, terrain.heightAt(nx, nz) + 4 + Math.random() * 6, nz);
            bird.target.copy(bird.perch);
            break;
          }

          /* ── Flight ────────────────────────────────────────────────────
           * A wandering circular path with gentle altitude oscillation.
           * Real flocking (boids) would be more accurate but reads as noise
           * at this scale — a wide, lazy circuit is what a startled bird
           * actually does, and it keeps them on screen where they can be
           * enjoyed. */
          const t = performance.now() * 0.001;
          const circleRadius = 22 + (i % 5) * 6;
          const orbitSpeed = 0.32 + (i % 7) * 0.03;
          bird.target.set(
            bird.perch.x + Math.cos(t * orbitSpeed + i) * circleRadius,
            bird.perch.y + 14 + Math.sin(t * 0.6 + i) * 5,
            bird.perch.z + Math.sin(t * orbitSpeed + i) * circleRadius,
          );

          _birdTmp.subVectors(bird.target, bird.pos);
          const dist = _birdTmp.length();
          if (dist > 0.01) {
            _birdTmp.divideScalar(dist);
            // Steer toward the target rather than snapping — gives banking.
            bird.vel.lerp(_birdTmp.multiplyScalar(8.5), Math.min(dt * 1.6, 1));
          }
          bird.pos.addScaledVector(bird.vel, dt);

          // Face the direction of travel.
          bird.yaw = Math.atan2(bird.vel.x, bird.vel.z);
          break;
        }

        case 'landing': {
          _birdTmp.subVectors(bird.perch, bird.pos);
          const dist = _birdTmp.length();
          if (dist < 0.4) {
            bird.state = 'perched';
            bird.vel.set(0, 0, 0);
            break;
          }
          _birdTmp.divideScalar(Math.max(dist, 0.001));
          // Decelerate as it approaches — a bird flares before touching down.
          const approachSpeed = clamp(dist * 1.6, 1, 7);
          bird.vel.lerp(_birdTmp.multiplyScalar(approachSpeed), Math.min(dt * 3, 1));
          bird.pos.addScaledVector(bird.vel, dt);
          bird.yaw = Math.atan2(bird.vel.x, bird.vel.z);
          break;
        }
      }

      /* ── Wing flap ───────────────────────────────────────────────────────
       * Fast while flying, occasional twitches while perched. Throttled to
       * 30 Hz — the flap is fast enough that the eye reads it as a blur
       * anyway, so the extra frames are wasted. */
      if (flapping) {
        const rate = bird.state === 'perched' ? 0.6 : 17;
        bird.flapPhase += flapTick.elapsed * rate;
      }
      const flap = bird.state === 'perched' ? 0 : Math.sin(bird.flapPhase) * 0.85;

      /* Banking: birds roll into turns. Deriving the roll from lateral
       * acceleration means it happens automatically and in the right
       * direction, without any explicit turn logic. */
      const bank =
        bird.state === 'flying'
          ? clamp(-bird.vel.x * Math.cos(bird.yaw) + bird.vel.z * Math.sin(bird.yaw), -1, 1) * 0.5
          : 0;

      _birdEuler.set(flap * 0.15, bird.yaw, bank);
      _birdQuat.setFromEuler(_birdEuler);
      _birdScale.setScalar(bird.scale);
      _birdMatrix.compose(bird.pos, _birdQuat, _birdScale);
      mesh.setMatrixAt(i, _birdMatrix);

      // Wings pivot about the body, flapping up and down.
      _birdEuler.set(flap * 0.15, bird.yaw, bank + flap * 0.9);
      _birdQuat.setFromEuler(_birdEuler);
      _birdMatrix.compose(bird.pos, _birdQuat, _birdScale);
      wings.setMatrixAt(i, _birdMatrix);
    }

    mesh.instanceMatrix.needsUpdate = true;
    wings.instanceMatrix.needsUpdate = true;
  });

  return (
    <group name="birds">
      <instancedMesh
        ref={meshRef}
        args={[bodyGeo, material, WILDLIFE.BIRD_COUNT]}
        castShadow
        frustumCulled={false}
      />
      <instancedMesh
        ref={wingRef}
        args={[wingGeo, wingMaterial, WILDLIFE.BIRD_COUNT]}
        castShadow
        frustumCulled={false}
      />
    </group>
  );
}

/** Returns true when `t` lies inside a possibly-wrapping window. */
function inWindow(t: number, window: readonly [number, number]): boolean {
  const [a, b] = window;
  const x = wrap(t, 1);
  return a <= b ? x >= a && x < b : x >= a || x < b;
}

const _birdMatrix = new THREE.Matrix4();
const _birdQuat = new THREE.Quaternion();
const _birdEuler = new THREE.Euler();
const _birdScale = new THREE.Vector3();
const _birdTmp = new THREE.Vector3();
const _birdColor = new THREE.Color();
