/**
 * The level crossing: barriers, warning lights and the bell post.
 *
 * @module components/scene/Train/Crossing
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RigidBody, CuboidCollider } from '@react-three/rapier';
import * as THREE from 'three';

import { useWorld } from '../TerrainContext';
import { registerPointLight, type PointLightSource } from '../LightPool';
import { mergeGeometries, transformGeometry } from '@/lib/geometry/merge';
import { LEVEL_CROSSING, RAIL_QUERY } from '@/lib/world/layout';
import { clamp, smootherstep } from '@/lib/utils/math';

export interface CrossingProps {
  /**
   * 0 = fully raised, 1 = fully lowered. Driven by the train director; the
   * component only renders the state, it doesn't decide it.
   */
  barrierState: React.RefObject<number>;
  /** True while the warning lights should be flashing. */
  active: React.RefObject<boolean>;
}

export function Crossing({ barrierState, active }: CrossingProps) {
  const { terrain } = useWorld();

  const arms = useRef<THREE.Group[]>([]);
  const lampMaterials = useRef<THREE.MeshStandardMaterial[]>([]);
  const blinkPhase = useRef(0);

  const groundY = useMemo(
    () => terrain.heightAt(LEVEL_CROSSING.x, LEVEL_CROSSING.z),
    [terrain],
  );

  /** Which way the track runs here — the barriers must be square to the road. */
  const trackYaw = useMemo(() => {
    const near = RAIL_QUERY.nearest(LEVEL_CROSSING.x, LEVEL_CROSSING.z);
    // Approximate the tangent from two nearby samples along the polyline.
    const a = RAIL_QUERY.pointAtLength(Math.max(0, near.along - 4));
    const b = RAIL_QUERY.pointAtLength(near.along + 4);
    return Math.atan2(b[0] - a[0], b[2] - a[2]);
  }, []);

  /* The four warning lamps take slots in the shared light pool.
   *
   * These flash at about 1 Hz, alternating. As real `pointLight`s switched on
   * and off that was two changes a second to the scene's light count — and
   * every change recompiles every shader in the world. A passing train would
   * have stuttered its way across the road. See `components/scene/LightPool`.
   *
   * Indices match `lampMaterials`: 0–1 are the far post, 2–3 the near one. */
  const lampSources = useMemo(() => {
    const out: PointLightSource[] = [];
    const cos = Math.cos(trackYaw);
    const sin = Math.sin(trackYaw);
    for (const side of [1, -1]) {
      for (const dx of [-0.42, 0.42]) {
        // Local → world through the group's own yaw, resolved once.
        const lx = side * 4.6 + dx;
        const lz = 0.12;
        out.push({
          position: new THREE.Vector3(
            LEVEL_CROSSING.x + lx * cos + lz * sin,
            groundY + 2.85,
            LEVEL_CROSSING.z - lx * sin + lz * cos,
          ),
          color: new THREE.Color('#ff3a20'),
          intensity: 0,
          distance: 8,
          decay: 2,
        });
      }
    }
    return out;
  }, [trackYaw, groundY]);

  useEffect(() => {
    const offs = lampSources.map((s) => registerPointLight(s));
    return () => offs.forEach((off) => off());
  }, [lampSources]);

  const { post, deck, materials } = useMemo(() => {
    const postParts: THREE.BufferGeometry[] = [];
    const deckParts: THREE.BufferGeometry[] = [];

    // Two posts, one either side of the road.
    for (const side of [-1, 1]) {
      const base = new THREE.BoxGeometry(0.42, 0.3, 0.42);
      transformGeometry(base, { position: [side * 4.6, 0.15, 0] });
      postParts.push(base);

      const column = new THREE.CylinderGeometry(0.12, 0.15, 3.1, 8);
      transformGeometry(column, { position: [side * 4.6, 1.7, 0] });
      postParts.push(column);

      // Lamp housing bar.
      const bar = new THREE.BoxGeometry(1.1, 0.16, 0.16);
      transformGeometry(bar, { position: [side * 4.6, 2.85, 0] });
      postParts.push(bar);

      // Saltire warning board.
      for (const rot of [0.7, -0.7]) {
        const plank = new THREE.BoxGeometry(1.5, 0.2, 0.06);
        transformGeometry(plank, { position: [side * 4.6, 3.4, 0.12], rotation: [0, 0, rot] });
        postParts.push(plank);
      }
    }

    /* Road deck across the rails — timber baulks laid between and outside the
     * rails so carts can cross. Detail nobody consciously notices, but its
     * absence makes a crossing look unfinished. */
    for (let i = -4; i <= 4; i++) {
      const plank = new THREE.BoxGeometry(0.62, 0.14, 5.5);
      transformGeometry(plank, { position: [i * 0.66, 0.06, 0] });
      deckParts.push(plank);
    }

    return {
      post: mergeGeometries(postParts, true),
      deck: mergeGeometries(deckParts, true),
      materials: {
        post: new THREE.MeshStandardMaterial({ color: '#e8e4d8', roughness: 0.75 }),
        deck: new THREE.MeshStandardMaterial({ color: '#4a3c2c', roughness: 0.95 }),
        arm: new THREE.MeshStandardMaterial({ color: '#f0ece0', roughness: 0.7 }),
        armStripe: new THREE.MeshStandardMaterial({ color: '#c9382a', roughness: 0.7 }),
      },
    };
  }, []);

  useEffect(
    () => () => {
      post.dispose();
      deck.dispose();
      Object.values(materials).forEach((m) => m.dispose());
    },
    [post, deck, materials],
  );

  useFrame((_, dt) => {
    const state = clamp(barrierState.current ?? 0, 0, 1);

    /* ── Barrier motion ──────────────────────────────────────────────────
     * Smootherstep, not linear. A real barrier is driven by a geared motor
     * that eases in and out — a linear sweep looks like a windscreen wiper.
     * The arm travels from vertical (raised) to horizontal (lowered). */
    const eased = smootherstep(0, 1, state);
    const angle = -eased * (Math.PI / 2);

    for (let i = 0; i < arms.current.length; i++) {
      const arm = arms.current[i];
      if (!arm) continue;
      const side = i === 0 ? 1 : -1;
      arm.rotation.x = angle * side;
    }

    /* ── Warning lights ──────────────────────────────────────────────────
     * The two lamps alternate — one on while the other is off — at about
     * 1 Hz per lamp. That alternation is the visual signature of a crossing;
     * two lamps flashing in sync would read as something else entirely. */
    const isActive = active.current ?? false;
    if (isActive) {
      blinkPhase.current += dt * 2.1;
    } else {
      blinkPhase.current = 0;
    }

    const leftOn = isActive && Math.sin(blinkPhase.current * Math.PI) > 0;
    const rightOn = isActive && !leftOn;

    for (let i = 0; i < lampMaterials.current.length; i++) {
      const mat = lampMaterials.current[i];
      if (!mat) continue;
      // Lamps alternate within each post as well as between posts.
      const on = i % 2 === 0 ? leftOn : rightOn;
      mat.emissiveIntensity = on ? 4.5 : 0.05;
    }
    for (let i = 0; i < lampSources.length; i++) {
      const on = i % 2 === 0 ? leftOn : rightOn;
      lampSources[i]!.intensity = on ? 3.5 : 0;
    }
  });

  return (
    <group
      position={[LEVEL_CROSSING.x, groundY, LEVEL_CROSSING.z]}
      rotation={[0, trackYaw, 0]}
      name="level-crossing"
    >
      <mesh geometry={deck} material={materials.deck} receiveShadow />
      <mesh geometry={post} material={materials.post} castShadow receiveShadow />

      {/* Warning lamps — two per post. */}
      {[-1, 1].map((side) =>
        [-0.42, 0.42].map((dx, li) => (
          <group key={`${side}-${dx}`} position={[side * 4.6 + dx, 2.85, 0.12]}>
            <mesh>
              <cylinderGeometry args={[0.15, 0.15, 0.1, 12]} />
              <meshStandardMaterial
                ref={(el) => {
                  if (el) lampMaterials.current[(side > 0 ? 0 : 2) + li] = el;
                }}
                color="#3a0a08"
                emissive={new THREE.Color('#ff2a18')}
                emissiveIntensity={0}
                roughness={0.3}
              />
            </mesh>
            {/* A hood over each lamp, so it reads even in daylight. */}
            <mesh position={[0, 0.06, 0.06]} rotation={[0.5, 0, 0]}>
              <cylinderGeometry args={[0.19, 0.19, 0.14, 12, 1, true]} />
              <meshStandardMaterial color="#1e2226" side={THREE.DoubleSide} />
            </mesh>
          </group>
        )),
      )}

      {/* Barrier arms. Pivot at the post, extending across the road. */}
      {[1, -1].map((side, i) => (
        <group
          key={side}
          ref={(el) => {
            if (el) arms.current[i] = el;
          }}
          position={[side * 4.6, 2.4, 0]}
        >
          {/* The arm itself, built from alternating red and white segments. */}
          {Array.from({ length: 6 }, (_, s) => (
            <mesh
              key={s}
              position={[0, (s + 0.5) * 0.72 * -side * -1, 0]}
              material={s % 2 === 0 ? materials.armStripe : materials.arm}
              castShadow
            >
              <boxGeometry args={[0.12, 0.72, 0.16]} />
            </mesh>
          ))}
          {/* Counterweight on the short end. */}
          <mesh position={[0, -0.5, 0]} castShadow>
            <boxGeometry args={[0.26, 0.34, 0.26]} />
            <meshStandardMaterial color="#2a2e32" metalness={0.6} roughness={0.5} />
          </mesh>
        </group>
      ))}

      <RigidBody type="fixed" colliders={false}>
        {[-1, 1].map((side) => (
          <CuboidCollider key={side} args={[0.2, 1.6, 0.2]} position={[side * 4.6, 1.6, 0]} />
        ))}
      </RigidBody>
    </group>
  );
}
