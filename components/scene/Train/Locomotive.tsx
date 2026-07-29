/**
 * The locomotive and its wagons.
 *
 * The detail that matters most here is the **valve gear**. A steam locomotive's
 * connecting rod links the piston to the driving wheel via a crank pin, so the
 * rod's position is completely determined by the wheel angle. Getting that
 * relationship right — rather than just spinning the wheels and waggling a rod
 * on its own timer — is the difference between a toy and a machine. It is also
 * the thing people look at.
 *
 * @module components/scene/Train/Locomotive
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { useLighting } from '@/hooks/useTimeOfDay';

import { registerPointLight, spotSlot, type PointLightSource } from '../LightPool';
import { mergeGeometries, transformGeometry } from '@/lib/geometry/merge';
import { graffitiTexture, softSprite } from '@/lib/textures/procedural';
import { WAGON_LIVERIES, TRAIN, type WagonType, type WagonLiveryId } from '@/config/game';
import { clamp } from '@/lib/utils/math';

/* ───────────────────────────────────────────────────────────────────────────
 * SHARED PARTS
 * ─────────────────────────────────────────────────────────────────────────── */

/** Builds a wheel: rim, hub and spokes, plus a crank pin boss. */
function buildWheel(radius: number, spokes = 10): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  // Tyre.
  const tyre = new THREE.TorusGeometry(radius * 0.92, radius * 0.09, 8, 20);
  parts.push(tyre);
  // Web.
  const web = new THREE.CylinderGeometry(radius * 0.86, radius * 0.86, 0.06, 20);
  transformGeometry(web, { rotation: [Math.PI / 2, 0, 0] });
  parts.push(web);
  // Hub.
  const hub = new THREE.CylinderGeometry(radius * 0.2, radius * 0.2, 0.16, 12);
  transformGeometry(hub, { rotation: [Math.PI / 2, 0, 0] });
  parts.push(hub);
  // Spokes.
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    const spoke = new THREE.BoxGeometry(radius * 0.08, radius * 0.72, 0.05);
    transformGeometry(spoke, {
      position: [Math.cos(a) * radius * 0.44, Math.sin(a) * radius * 0.44, 0],
      rotation: [0, 0, a + Math.PI / 2],
    });
    parts.push(spoke);
  }
  // Crank pin boss — the point the connecting rod attaches to.
  const boss = new THREE.CylinderGeometry(radius * 0.11, radius * 0.11, 0.14, 10);
  transformGeometry(boss, {
    position: [radius * 0.55, 0, 0.11],
    rotation: [Math.PI / 2, 0, 0],
  });
  parts.push(boss);

  return mergeGeometries(parts, true);
}

/** A pair of buffers and a coupling hook, at one end of a vehicle. */
function buildBuffers(halfWidth: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const shank = new THREE.CylinderGeometry(0.07, 0.07, 0.32, 8);
    transformGeometry(shank, { position: [side * halfWidth * 0.62, 0, 0.16], rotation: [Math.PI / 2, 0, 0] });
    parts.push(shank);
    const head = new THREE.CylinderGeometry(0.16, 0.16, 0.08, 12);
    transformGeometry(head, { position: [side * halfWidth * 0.62, 0, 0.34], rotation: [Math.PI / 2, 0, 0] });
    parts.push(head);
  }
  const hook = new THREE.TorusGeometry(0.1, 0.028, 6, 10);
  transformGeometry(hook, { position: [0, -0.06, 0.2], rotation: [Math.PI / 2, 0, 0] });
  parts.push(hook);
  return mergeGeometries(parts, true);
}

/* ───────────────────────────────────────────────────────────────────────────
 * LOCOMOTIVE
 * ─────────────────────────────────────────────────────────────────────────── */

export interface LocomotiveProps {
  /** Wheel rotation in radians, driven by the train director. */
  wheelAngle: React.RefObject<number>;
  /** 0..1 — how hard the engine is working, drives firebox glow and steam. */
  effort: React.RefObject<number>;
  /** Current speed, for steam plume velocity. */
  speed: React.RefObject<number>;
}

export function Locomotive({ wheelAngle, effort, speed }: LocomotiveProps) {
  const lighting = useLighting();

  const bodyRef = useRef<THREE.Group>(null);
  const drivingWheels = useRef<THREE.Group[]>([]);
  const connectingRods = useRef<THREE.Group[]>([]);
  const fireboxMat = useRef<THREE.MeshStandardMaterial>(null);
  const headlightConeRef = useRef<THREE.Mesh>(null);

  /* The firebox glow borrows a slot from the shared pool, and the headlight
   * drives the world's single permanent spot light. Neither can be mounted
   * inside the train: this group is hidden until the ritual begins, and a
   * light appearing changes the scene's light count — which recompiles every
   * shader in the world, precisely as the train comes into view. */
  const firebox = useMemo<PointLightSource>(
    () => ({
      position: new THREE.Vector3(),
      color: new THREE.Color('#ff7a30'),
      intensity: 0,
      distance: 8,
      decay: 2,
    }),
    [],
  );
  useEffect(() => registerPointLight(firebox), [firebox]);

  const { body, detail, wheel, buffers, materials } = useMemo(() => {
    const bodyParts: THREE.BufferGeometry[] = [];
    const detailParts: THREE.BufferGeometry[] = [];

    const L = TRAIN.LOCO_LENGTH;
    const halfW = 1.35;

    /* ── Boiler ─────────────────────────────────────────────────────────── */
    const boiler = new THREE.CylinderGeometry(1.05, 1.15, L * 0.52, 20);
    transformGeometry(boiler, {
      position: [0, 2.05, L * 0.14],
      rotation: [Math.PI / 2, 0, 0],
    });
    bodyParts.push(boiler);

    // Smokebox — the darker drum at the front.
    const smokebox = new THREE.CylinderGeometry(1.1, 1.1, 1.1, 20);
    transformGeometry(smokebox, {
      position: [0, 2.05, L * 0.42],
      rotation: [Math.PI / 2, 0, 0],
    });
    detailParts.push(smokebox);
    // Smokebox door.
    const doorRing = new THREE.TorusGeometry(0.95, 0.09, 8, 20);
    transformGeometry(doorRing, { position: [0, 2.05, L * 0.475] });
    detailParts.push(doorRing);

    /* ── Funnel ─────────────────────────────────────────────────────────── */
    const funnel = new THREE.CylinderGeometry(0.42, 0.32, 1.5, 14);
    transformGeometry(funnel, { position: [0, 3.6, L * 0.4] });
    detailParts.push(funnel);
    // Flared cap.
    const funnelCap = new THREE.CylinderGeometry(0.54, 0.42, 0.3, 14);
    transformGeometry(funnelCap, { position: [0, 4.3, L * 0.4] });
    detailParts.push(funnelCap);

    /* ── Dome and safety valves ─────────────────────────────────────────── */
    const dome = new THREE.SphereGeometry(0.42, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    transformGeometry(dome, { position: [0, 3.05, L * 0.16] });
    detailParts.push(dome);
    const valve = new THREE.CylinderGeometry(0.14, 0.16, 0.32, 8);
    transformGeometry(valve, { position: [0, 3.15, L * -0.02] });
    detailParts.push(valve);

    /* ── Cab ────────────────────────────────────────────────────────────── */
    const cab = new THREE.BoxGeometry(halfW * 2, 2.5, 3.1);
    transformGeometry(cab, { position: [0, 2.5, -L * 0.32] });
    bodyParts.push(cab);
    // Cab roof, slightly overhanging.
    const cabRoof = new THREE.BoxGeometry(halfW * 2.2, 0.14, 3.4);
    transformGeometry(cabRoof, { position: [0, 3.8, -L * 0.32] });
    detailParts.push(cabRoof);

    /* ── Running board and frames ───────────────────────────────────────── */
    const board = new THREE.BoxGeometry(halfW * 2.1, 0.12, L * 0.92);
    transformGeometry(board, { position: [0, 1.15, 0] });
    bodyParts.push(board);

    for (const side of [-1, 1]) {
      const frame = new THREE.BoxGeometry(0.12, 0.55, L * 0.86);
      transformGeometry(frame, { position: [side * halfW * 0.78, 0.82, 0] });
      detailParts.push(frame);
    }

    /* ── Cylinders ───────────────────────────────────────────────────────
     * The steam cylinders sit low at the front, ahead of the driving wheels.
     * The connecting rods run back from them to the crank pins. */
    for (const side of [-1, 1]) {
      const cyl = new THREE.CylinderGeometry(0.33, 0.33, 1.3, 12);
      transformGeometry(cyl, {
        position: [side * halfW * 0.82, 1.0, L * 0.3],
        rotation: [Math.PI / 2, 0, 0],
      });
      detailParts.push(cyl);
    }

    /* ── Cowcatcher ─────────────────────────────────────────────────────── */
    const catcherSlats = 7;
    for (let i = 0; i < catcherSlats; i++) {
      const t = i / (catcherSlats - 1) - 0.5;
      const slat = new THREE.BoxGeometry(0.07, 1.3, 0.07);
      transformGeometry(slat, {
        position: [t * halfW * 1.6, 0.75, L * 0.52 + Math.abs(t) * 0.25],
        rotation: [0.55, 0, t * 0.35],
      });
      detailParts.push(slat);
    }

    /* ── Handrails ──────────────────────────────────────────────────────── */
    for (const side of [-1, 1]) {
      const rail = new THREE.CylinderGeometry(0.03, 0.03, L * 0.6, 6);
      transformGeometry(rail, {
        position: [side * 1.02, 2.6, L * 0.16],
        rotation: [Math.PI / 2, 0, 0],
      });
      detailParts.push(rail);
    }

    const mats = {
      body: new THREE.MeshStandardMaterial({
        color: '#1c2a24',
        metalness: 0.72,
        roughness: 0.38,
      }),
      detail: new THREE.MeshStandardMaterial({
        color: '#14171a',
        metalness: 0.85,
        roughness: 0.3,
      }),
      wheel: new THREE.MeshStandardMaterial({
        color: '#8a2c22',
        metalness: 0.6,
        roughness: 0.45,
      }),
      rod: new THREE.MeshStandardMaterial({
        color: '#b8b4ac',
        metalness: 0.95,
        roughness: 0.2,
      }),
      brass: new THREE.MeshStandardMaterial({
        color: '#c8a24a',
        metalness: 0.9,
        roughness: 0.25,
      }),
    };

    return {
      body: mergeGeometries(bodyParts, true),
      detail: mergeGeometries(detailParts, true),
      wheel: buildWheel(TRAIN.WHEEL_RADIUS, 12),
      buffers: buildBuffers(halfW),
      materials: mats,
    };
  }, []);

  useEffect(
    () => () => {
      body.dispose();
      detail.dispose();
      wheel.dispose();
      buffers.dispose();
      Object.values(materials).forEach((m) => m.dispose());
    },
    [body, detail, wheel, buffers, materials],
  );

  /* Driving wheel positions along the locomotive. */
  const driverPositions = useMemo(() => [-2.4, -0.3, 1.8], []);
  const L = TRAIN.LOCO_LENGTH;

  useFrame(() => {
    const angle = wheelAngle.current ?? 0;
    const e = clamp(effort.current ?? 0, 0, 1);

    // Spin the driving wheels.
    for (const w of drivingWheels.current) {
      if (w) w.rotation.x = angle;
    }

    /* ── Valve gear ──────────────────────────────────────────────────────
     * The crank pin sits on the wheel at radius r, at the current wheel angle.
     * The connecting rod runs from the fixed cylinder position to that pin, so
     * its own angle and length follow directly.
     *
     *   pinY = r·sin(θ)      pinZ = r·cos(θ)
     *   rodAngle = atan2(pinY − cylY, pinZ − cylZ)
     *
     * Because the pin traces a circle while the cylinder end is fixed, the rod
     * both swings and (apparently) shortens through the stroke — exactly the
     * motion a real one has. */
    const r = TRAIN.WHEEL_RADIUS * 0.55;
    const cylZ = L * 0.3;
    const cylY = 1.0;

    for (let i = 0; i < connectingRods.current.length; i++) {
      const rod = connectingRods.current[i];
      if (!rod) continue;
      const side = i % 2 === 0 ? -1 : 1;
      /* The two sides of a locomotive are set 90° out of phase (a "quartered"
       * crank) so the engine can always start regardless of where it stopped.
       * That quartering is also why a steam engine's exhaust beat is four per
       * revolution rather than two. */
      const phase = angle + (side < 0 ? 0 : Math.PI / 2);

      const pinY = 1.0 + Math.sin(phase) * r;
      const pinZ = driverPositions[1]! + Math.cos(phase) * r;

      const dy = pinY - cylY;
      const dz = pinZ - cylZ;
      const len = Math.hypot(dy, dz);

      rod.position.set(side * 1.18, (cylY + pinY) / 2, (cylZ + pinZ) / 2);
      rod.rotation.x = -Math.atan2(dy, dz) + Math.PI / 2;
      rod.scale.set(1, len / 2.6, 1);
    }

    /* ── Firebox glow ────────────────────────────────────────────────────
     * Pulses with the exhaust beat — the fire brightens as the blast pulls
     * through it, four times per wheel revolution. */
    if (fireboxMat.current) {
      const beat = Math.sin(angle * 4) * 0.5 + 0.5;
      fireboxMat.current.emissiveIntensity = (1.6 + beat * 1.4) * (0.35 + e * 0.65);
    }

    /* ── Headlight ───────────────────────────────────────────────────────
     * Only lit at night, when it cuts a genuine visible cone through the fog. */
    const night = 1 - clamp(lighting.sunElevation * 5, 0, 1);
    if (headlightConeRef.current) {
      const mat = headlightConeRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = night * 0.12;
      headlightConeRef.current.visible = night > 0.05;
    }

    /* ── Pooled lights ───────────────────────────────────────────────────
     * The train spends most of its life hidden. Ancestor visibility is the
     * honest test — the director hides the whole consist in one go, so this
     * component's own `visible` flag says nothing. */
    const body = bodyRef.current;
    if (!body) return;

    let onStage = body.visible;
    body.traverseAncestors((o) => {
      if (!o.visible) onStage = false;
    });

    if (!onStage) {
      firebox.intensity = 0;
      spotSlot.intensity = 0;
      return;
    }

    body.localToWorld(firebox.position.set(0, 1.8, -L * 0.28));
    firebox.intensity = 3.5;

    body.localToWorld(spotSlot.position.set(0, 2.9, L * 0.5));
    body.localToWorld(spotSlot.target.set(0, 0, L * 0.5 + 40));
    spotSlot.intensity = night * 42;
  });

  return (
    <group ref={bodyRef} name="locomotive">
      <mesh geometry={body} material={materials.body} castShadow receiveShadow />
      <mesh geometry={detail} material={materials.detail} castShadow />
      <mesh geometry={buffers} material={materials.detail} position={[0, 1.0, L * 0.5]} castShadow />

      {/* Driving wheels. */}
      {driverPositions.map((z, i) =>
        [-1, 1].map((side) => (
          <group
            key={`${z}-${side}`}
            ref={(el) => {
              if (el) drivingWheels.current[i * 2 + (side > 0 ? 1 : 0)] = el;
            }}
            position={[side * 1.05, TRAIN.WHEEL_RADIUS, z]}
          >
            <mesh geometry={wheel} material={materials.wheel} castShadow />
          </group>
        )),
      )}

      {/* Leading pony truck wheels — smaller, no valve gear. */}
      {[-1, 1].map((side) => (
        <mesh
          key={`pony-${side}`}
          geometry={wheel}
          material={materials.wheel}
          position={[side * 1.05, 0.5, L * 0.4]}
          scale={0.6}
          castShadow
        />
      ))}

      {/* Connecting rods. */}
      {[0, 1].map((i) => (
        <group
          key={i}
          ref={(el) => {
            if (el) connectingRods.current[i] = el;
          }}
        >
          <mesh material={materials.rod} castShadow>
            <boxGeometry args={[0.1, 2.6, 0.14]} />
          </mesh>
        </group>
      ))}

      {/* Coupling rods linking the driving wheels — these rotate with the
          wheels and are what visually ties the axles together. */}
      {[-1, 1].map((side) => (
        <CouplingRod
          key={side}
          side={side}
          wheelAngle={wheelAngle}
          positions={driverPositions}
          material={materials.rod}
        />
      ))}

      {/* Firebox glow, visible through the cab floor. */}
      <mesh position={[0, 1.6, -L * 0.28]}>
        <boxGeometry args={[1.5, 0.9, 0.4]} />
        <meshStandardMaterial
          ref={fireboxMat}
          color="#3a1108"
          emissive={new THREE.Color('#ff6420')}
          emissiveIntensity={2}
          roughness={0.9}
        />
      </mesh>
      {/* Headlight. */}
      <mesh position={[0, 2.9, L * 0.47]}>
        <cylinderGeometry args={[0.26, 0.3, 0.34, 12]} />
        <meshStandardMaterial
          color="#1a1d1f"
          emissive={new THREE.Color('#fff0c0')}
          emissiveIntensity={2.2}
          metalness={0.7}
        />
      </mesh>
      {/* An additive cone standing in for volumetric scattering. Far cheaper
          than raymarching and, through fog at night, reads identically. */}
      <mesh
        ref={headlightConeRef}
        position={[0, 2.9, L * 0.5 + 12]}
        rotation={[Math.PI / 2, 0, 0]}
      >
        <coneGeometry args={[4.6, 24, 16, 1, true]} />
        <meshBasicMaterial
          color="#ffeec0"
          transparent
          opacity={0}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      <SteamPlume position={[0, 4.5, L * 0.4]} effort={effort} speed={speed} />
      <WheelSparks positions={driverPositions} effort={effort} />
    </group>
  );
}

/**
 * The coupling rod joining the driving wheels.
 *
 * Unlike the connecting rod this one doesn't change length: it links crank pins
 * that are all at the same angle, so it simply translates in a circle without
 * rotating. That distinction — one rod swinging, the other orbiting rigidly —
 * is instantly recognisable to anyone who has watched a steam engine.
 */
function CouplingRod({
  side,
  wheelAngle,
  positions,
  material,
}: {
  side: number;
  wheelAngle: React.RefObject<number>;
  positions: number[];
  material: THREE.Material;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const r = TRAIN.WHEEL_RADIUS * 0.55;
  const first = positions[0]!;
  const last = positions[positions.length - 1]!;
  const length = last - first;
  const midZ = (first + last) / 2;

  useFrame(() => {
    if (!ref.current) return;
    const angle = (wheelAngle.current ?? 0) + (side < 0 ? 0 : Math.PI / 2);
    // Pure translation on a circle — no rotation.
    ref.current.position.set(
      side * 1.18,
      TRAIN.WHEEL_RADIUS + Math.sin(angle) * r,
      midZ + Math.cos(angle) * r,
    );
  });

  return (
    <mesh ref={ref} material={material} castShadow>
      <boxGeometry args={[0.08, 0.16, length]} />
    </mesh>
  );
}

/**
 * The steam plume.
 *
 * Puffs are emitted from the funnel and then **left behind in world space** —
 * they do not travel with the locomotive. That is the whole point: a stationary
 * plume trailing back over the train is what communicates speed. The
 * `attach="parent"` trick is achieved by converting to world coordinates on
 * emission and rendering the plume in a group that never moves.
 */
function SteamPlume({
  position,
  effort,
  speed,
}: {
  position: [number, number, number];
  effort: React.RefObject<number>;
  speed: React.RefObject<number>;
}) {
  const count = TRAIN.STEAM_PARTICLES;
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const { geometry, material, state } = useMemo(() => {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: softSprite(128, 1.5),
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      color: '#e8e6e0',
    });
    return {
      geometry: geo,
      material: mat,
      state: {
        age: new Float32Array(count).fill(999),
        pos: new Float32Array(count * 3),
        vel: new Float32Array(count * 3),
        cursor: 0,
        emitTimer: 0,
      },
    };
  }, [count]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useFrame(({ camera }, dt) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const e = clamp(effort.current ?? 0, 0, 1);
    const v = speed.current ?? 0;
    const lifetime = 2.6;

    /* Emit in time with the exhaust beat — four puffs per wheel revolution,
     * which at speed is a rapid chuff and at low speed is a slow, heavy one. */
    state.emitTimer -= dt;
    const emitInterval = v > 0.5 ? Math.max(0.045, 1 / (v * 0.55)) : 0.4;
    if (e > 0.05 && state.emitTimer <= 0) {
      state.emitTimer = emitInterval;
      // Emit two or three puffs per beat for a fuller plume.
      for (let k = 0; k < 3; k++) {
        const i = state.cursor;
        state.cursor = (state.cursor + 1) % count;
        state.age[i] = 0;
        // Emission point in world space, since the parent group moves.
        mesh.parent?.localToWorld(_steamTmp.set(position[0], position[1], position[2]));
        state.pos[i * 3] = _steamTmp.x + (Math.random() - 0.5) * 0.3;
        state.pos[i * 3 + 1] = _steamTmp.y;
        state.pos[i * 3 + 2] = _steamTmp.z + (Math.random() - 0.5) * 0.3;
        // Initial velocity: mostly up, with a little scatter.
        state.vel[i * 3] = (Math.random() - 0.5) * 0.9;
        state.vel[i * 3 + 1] = 3.4 + Math.random() * 1.8;
        state.vel[i * 3 + 2] = (Math.random() - 0.5) * 0.9;
      }
    }

    for (let i = 0; i < count; i++) {
      if (state.age[i]! > lifetime) {
        _steamMat.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, _steamMat);
        continue;
      }
      state.age[i]! += dt;
      const a = state.age[i]! / lifetime;

      // Buoyancy decays as the steam cools and mixes.
      state.vel[i * 3 + 1]! *= 1 - dt * 0.55;
      state.pos[i * 3]! += state.vel[i * 3]! * dt;
      state.pos[i * 3 + 1]! += state.vel[i * 3 + 1]! * dt;
      state.pos[i * 3 + 2]! += state.vel[i * 3 + 2]! * dt;

      _steamPos.set(state.pos[i * 3]!, state.pos[i * 3 + 1]!, state.pos[i * 3 + 2]!);
      // Puffs expand as they dissipate.
      const size = 0.7 + a * 5.5;
      // Billboard toward the camera.
      _steamQuat.copy(camera.quaternion);
      _steamScale.set(size, size, size);
      _steamMat.compose(_steamPos, _steamQuat, _steamScale);
      mesh.setMatrixAt(i, _steamMat);
    }
    mesh.instanceMatrix.needsUpdate = true;

    material.opacity = 0.5 * e;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, count]}
      frustumCulled={false}
      renderOrder={20}
      /* The plume must not inherit the locomotive's transform — puffs stay
         where they were emitted. `matrixAutoUpdate={false}` with an identity
         matrix keeps it pinned to world space. */
      matrixAutoUpdate={false}
    />
  );
}

const _steamPos = new THREE.Vector3();
const _steamQuat = new THREE.Quaternion();
const _steamScale = new THREE.Vector3();
const _steamMat = new THREE.Matrix4();
const _steamTmp = new THREE.Vector3();

/** Sparks thrown from the wheel–rail contact patch. */
function WheelSparks({
  positions,
  effort,
}: {
  positions: number[];
  effort: React.RefObject<number>;
}) {
  const count = TRAIN.SPARK_PARTICLES;
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const { geometry, material, state } = useMemo(() => {
    const geo = new THREE.PlaneGeometry(0.06, 0.06);
    const mat = new THREE.MeshBasicMaterial({
      color: '#ffb040',
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    return {
      geometry: geo,
      material: mat,
      state: {
        age: new Float32Array(count).fill(999),
        pos: new Float32Array(count * 3),
        vel: new Float32Array(count * 3),
        cursor: 0,
      },
    };
  }, [count]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useFrame((_, dt) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const e = clamp(effort.current ?? 0, 0, 1);
    const lifetime = 0.7;

    // Emit occasionally while the engine is working hard.
    if (e > 0.6 && Math.random() < 0.35) {
      for (let k = 0; k < 3; k++) {
        const i = state.cursor;
        state.cursor = (state.cursor + 1) % count;
        state.age[i] = 0;
        const z = positions[Math.floor(Math.random() * positions.length)]!;
        const side = Math.random() < 0.5 ? -1 : 1;
        state.pos[i * 3] = side * 1.05;
        state.pos[i * 3 + 1] = 0.05;
        state.pos[i * 3 + 2] = z;
        state.vel[i * 3] = side * (0.5 + Math.random() * 1.5);
        state.vel[i * 3 + 1] = 1 + Math.random() * 2.5;
        state.vel[i * 3 + 2] = -(2 + Math.random() * 4);
      }
    }

    for (let i = 0; i < count; i++) {
      if (state.age[i]! > lifetime) {
        _sparkMat.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, _sparkMat);
        continue;
      }
      state.age[i]! += dt;
      // Gravity.
      state.vel[i * 3 + 1]! -= 9.8 * dt;
      state.pos[i * 3]! += state.vel[i * 3]! * dt;
      state.pos[i * 3 + 1]! += state.vel[i * 3 + 1]! * dt;
      state.pos[i * 3 + 2]! += state.vel[i * 3 + 2]! * dt;

      const a = 1 - state.age[i]! / lifetime;
      _sparkPos.set(state.pos[i * 3]!, state.pos[i * 3 + 1]!, state.pos[i * 3 + 2]!);
      _sparkScale.setScalar(a);
      _sparkMat.compose(_sparkPos, _sparkQuat, _sparkScale);
      mesh.setMatrixAt(i, _sparkMat);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[geometry, material, count]} frustumCulled={false} />
  );
}

const _sparkPos = new THREE.Vector3();
const _sparkQuat = new THREE.Quaternion();
const _sparkScale = new THREE.Vector3();
const _sparkMat = new THREE.Matrix4();

/* ───────────────────────────────────────────────────────────────────────────
 * WAGONS
 * ─────────────────────────────────────────────────────────────────────────── */

export interface WagonProps {
  type: WagonType;
  livery: WagonLiveryId;
  wheelAngle: React.RefObject<number>;
  index: number;
}

/**
 * One wagon. Seven distinct types, each with its own silhouette so the train
 * reads as a composed consist rather than a repeated box.
 */
export function Wagon({ type, livery, wheelAngle, index }: WagonProps) {
  const lighting = useLighting();
  const wheels = useRef<THREE.Group[]>([]);
  const lanternMat = useRef<THREE.MeshStandardMaterial>(null);

  const colors = useMemo(
    () => WAGON_LIVERIES.find((l) => l.id === livery) ?? WAGON_LIVERIES[0],
    [livery],
  );

  const { geometry, trimGeometry, wheelGeo, windowGeo, materials } = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    const trimParts: THREE.BufferGeometry[] = [];
    const windowParts: THREE.BufferGeometry[] = [];

    const L = TRAIN.WAGON_LENGTH;
    const halfW = 1.3;
    const floorY = 1.05;

    // Underframe, common to every type.
    const frame = new THREE.BoxGeometry(halfW * 2, 0.28, L);
    transformGeometry(frame, { position: [0, floorY, 0] });
    trimParts.push(frame);

    switch (type) {
      case 'tender': {
        const tank = new THREE.BoxGeometry(halfW * 2, 1.9, L * 0.86);
        transformGeometry(tank, { position: [0, floorY + 1.1, 0] });
        parts.push(tank);
        // Coal heaped on top.
        for (let i = 0; i < 14; i++) {
          const lump = new THREE.IcosahedronGeometry(0.24 + Math.random() * 0.2, 0);
          transformGeometry(lump, {
            position: [
              (Math.random() - 0.5) * halfW * 1.5,
              floorY + 2.05 + Math.random() * 0.25,
              (Math.random() - 0.5) * L * 0.7,
            ],
            rotation: [Math.random() * 3, Math.random() * 3, Math.random() * 3],
          });
          trimParts.push(lump);
        }
        break;
      }

      case 'passenger': {
        const bodyBox = new THREE.BoxGeometry(halfW * 2, 2.7, L);
        transformGeometry(bodyBox, { position: [0, floorY + 1.5, 0] });
        parts.push(bodyBox);
        // Clerestory roof — the raised central strip of a period carriage.
        const roof = new THREE.BoxGeometry(halfW * 1.5, 0.32, L * 0.94);
        transformGeometry(roof, { position: [0, floorY + 3.0, 0] });
        trimParts.push(roof);

        // Windows down both sides.
        const windowCount = 6;
        for (let i = 0; i < windowCount; i++) {
          const z = (i / (windowCount - 1) - 0.5) * L * 0.78;
          for (const side of [-1, 1]) {
            const w = new THREE.PlaneGeometry(0.72, 0.95);
            transformGeometry(w, {
              position: [side * (halfW + 0.02), floorY + 1.85, z],
              rotation: [0, (side * Math.PI) / 2, 0],
            });
            windowParts.push(w);
          }
        }
        break;
      }

      case 'cargo': {
        const container = new THREE.BoxGeometry(halfW * 2, 2.5, L * 0.95);
        transformGeometry(container, { position: [0, floorY + 1.4, 0] });
        parts.push(container);
        // Corrugation ribs.
        for (let i = 0; i < 10; i++) {
          const z = (i / 9 - 0.5) * L * 0.9;
          const rib = new THREE.BoxGeometry(halfW * 2.06, 2.4, 0.07);
          transformGeometry(rib, { position: [0, floorY + 1.4, z] });
          trimParts.push(rib);
        }
        break;
      }

      case 'flatbedLogs': {
        const deck = new THREE.BoxGeometry(halfW * 2, 0.18, L);
        transformGeometry(deck, { position: [0, floorY + 0.22, 0] });
        parts.push(deck);
        // Stanchions.
        for (const z of [-L * 0.35, 0, L * 0.35]) {
          for (const side of [-1, 1]) {
            const post = new THREE.BoxGeometry(0.12, 1.1, 0.12);
            transformGeometry(post, { position: [side * halfW, floorY + 0.85, z] });
            trimParts.push(post);
          }
        }
        // Stacked logs, in a pyramid.
        const rows = [4, 3, 2];
        let y = floorY + 0.55;
        for (const inRow of rows) {
          for (let i = 0; i < inRow; i++) {
            const log = new THREE.CylinderGeometry(0.28, 0.3, L * 0.9, 8);
            transformGeometry(log, {
              position: [(i - (inRow - 1) / 2) * 0.62, y, 0],
              rotation: [Math.PI / 2, 0, 0],
            });
            trimParts.push(log);
          }
          y += 0.54;
        }
        break;
      }

      case 'oilTank': {
        const tank = new THREE.CylinderGeometry(1.25, 1.25, L * 0.92, 18);
        transformGeometry(tank, { position: [0, floorY + 1.45, 0], rotation: [Math.PI / 2, 0, 0] });
        parts.push(tank);
        // End caps.
        for (const side of [-1, 1]) {
          const cap = new THREE.SphereGeometry(1.25, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
          transformGeometry(cap, {
            position: [0, floorY + 1.45, (side * L * 0.92) / 2],
            rotation: [(side * Math.PI) / 2, 0, 0],
          });
          parts.push(cap);
        }
        // Filler hatch and walkway.
        const hatch = new THREE.CylinderGeometry(0.32, 0.32, 0.3, 10);
        transformGeometry(hatch, { position: [0, floorY + 2.8, 0] });
        trimParts.push(hatch);
        break;
      }

      case 'cattle': {
        const bodyBox = new THREE.BoxGeometry(halfW * 2, 2.4, L);
        transformGeometry(bodyBox, { position: [0, floorY + 1.35, 0] });
        parts.push(bodyBox);
        // Slatted sides — horizontal gaps you can see daylight through.
        for (let i = 0; i < 7; i++) {
          const y = floorY + 0.5 + i * 0.3;
          for (const side of [-1, 1]) {
            const slat = new THREE.BoxGeometry(0.08, 0.18, L * 0.96);
            transformGeometry(slat, { position: [side * (halfW + 0.04), y, 0] });
            trimParts.push(slat);
          }
        }
        break;
      }

      case 'mail': {
        const bodyBox = new THREE.BoxGeometry(halfW * 2, 2.6, L * 0.9);
        transformGeometry(bodyBox, { position: [0, floorY + 1.45, 0] });
        parts.push(bodyBox);
        // Sliding door.
        const door = new THREE.BoxGeometry(0.1, 1.8, 2.2);
        transformGeometry(door, { position: [halfW + 0.05, floorY + 1.3, 0] });
        trimParts.push(door);
        // A single lit window by the guard's position.
        const w = new THREE.PlaneGeometry(0.6, 0.7);
        transformGeometry(w, {
          position: [halfW + 0.02, floorY + 1.9, -L * 0.32],
          rotation: [0, Math.PI / 2, 0],
        });
        windowParts.push(w);
        break;
      }
    }

    const mats = {
      body: new THREE.MeshStandardMaterial({
        color: colors!.body,
        roughness: 0.62,
        metalness: 0.32,
      }),
      trim: new THREE.MeshStandardMaterial({
        color: colors!.trim,
        roughness: 0.55,
        metalness: 0.45,
      }),
      wheel: new THREE.MeshStandardMaterial({
        color: '#3a3a3e',
        metalness: 0.75,
        roughness: 0.42,
      }),
      window: new THREE.MeshStandardMaterial({
        color: '#101418',
        emissive: new THREE.Color('#ffcc80'),
        emissiveIntensity: 0,
        roughness: 0.2,
        metalness: 0.2,
        side: THREE.DoubleSide,
      }),
    };

    return {
      geometry: mergeGeometries(parts, true),
      trimGeometry: mergeGeometries(trimParts, true),
      wheelGeo: buildWheel(TRAIN.WAGON_WHEEL_RADIUS, 8),
      windowGeo: windowParts.length > 0 ? mergeGeometries(windowParts, true) : null,
      materials: mats,
    };
  }, [type, colors]);

  useEffect(
    () => () => {
      geometry.dispose();
      trimGeometry.dispose();
      wheelGeo.dispose();
      windowGeo?.dispose();
      Object.values(materials).forEach((m) => m.dispose());
    },
    [geometry, trimGeometry, wheelGeo, windowGeo, materials],
  );

  const bogiePositions = useMemo(
    () => [-TRAIN.WAGON_LENGTH * 0.32, TRAIN.WAGON_LENGTH * 0.32],
    [],
  );

  useFrame(() => {
    /* Wagon wheels are smaller than the driving wheels, so they turn faster for
     * the same road speed. The ratio is exactly the inverse radius ratio. */
    const ratio = TRAIN.WHEEL_RADIUS / TRAIN.WAGON_WHEEL_RADIUS;
    const angle = (wheelAngle.current ?? 0) * ratio;
    for (const w of wheels.current) {
      if (w) w.rotation.x = angle;
    }

    if (materials.window) {
      // Carriage lights come on at dusk, like the village windows.
      materials.window.emissiveIntensity = lighting.lampIntensity * 2.6 + 0.15;
    }
    if (lanternMat.current) {
      lanternMat.current.emissiveIntensity = 1.4 + lighting.lampIntensity * 1.8;
    }
  });

  return (
    <group name={`wagon-${index}-${type}`}>
      <mesh geometry={geometry} material={materials.body} castShadow receiveShadow />
      <mesh geometry={trimGeometry} material={materials.trim} castShadow />
      {windowGeo && <mesh geometry={windowGeo} material={materials.window} />}

      {/* Bogies. */}
      {bogiePositions.map((z, bi) =>
        [-0.9, 0.9].map((dz) =>
          [-1, 1].map((side) => (
            <group
              key={`${bi}-${dz}-${side}`}
              ref={(el) => {
                if (el) wheels.current.push(el);
              }}
              position={[side * 1.05, TRAIN.WAGON_WHEEL_RADIUS, z + dz]}
            >
              <mesh geometry={wheelGeo} material={materials.wheel} castShadow />
            </group>
          )),
        ),
      )}

      {/* Silhouetted passengers in the carriage windows. */}
      {type === 'passenger' && <Passengers />}

      {/* Graffiti on the cargo container. */}
      {type === 'cargo' && (
        <mesh position={[1.32, 2.4, 0.5]} rotation={[0, Math.PI / 2, 0]}>
          <planeGeometry args={[4, 2]} />
          <meshBasicMaterial map={graffitiTexture(256)} transparent depthWrite={false} />
        </mesh>
      )}

      {/* The mail car's swinging lantern. */}
      {type === 'mail' && (
        <group position={[1.42, 2.6, -TRAIN.WAGON_LENGTH * 0.42]}>
          <mesh>
            <cylinderGeometry args={[0.12, 0.14, 0.28, 8]} />
            <meshStandardMaterial
              ref={lanternMat}
              color="#2a2418"
              emissive={new THREE.Color('#ffb45a')}
              emissiveIntensity={1.6}
            />
          </mesh>
          <pointLight color="#ffb45a" intensity={3} distance={7} decay={2} />
        </group>
      )}
    </group>
  );
}

/**
 * Silhouetted passengers.
 *
 * Deliberately just dark capsules. Detailed figures at this scale, moving past
 * at 27 m/s, would only draw attention to themselves; shapes in a lit window is
 * exactly enough for the mind to fill in the rest.
 */
function Passengers() {
  const seats = 6;
  return (
    <group>
      {Array.from({ length: seats }, (_, i) => {
        const z = (i / (seats - 1) - 0.5) * TRAIN.WAGON_LENGTH * 0.7;
        const side = i % 2 === 0 ? -0.6 : 0.6;
        return (
          <group key={i} position={[side, 2.35, z]}>
            <mesh>
              <capsuleGeometry args={[0.18, 0.34, 4, 8]} />
              <meshBasicMaterial color="#0a0c10" />
            </mesh>
            <mesh position={[0, 0.36, 0]}>
              <sphereGeometry args={[0.15, 8, 6]} />
              <meshBasicMaterial color="#0a0c10" />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
