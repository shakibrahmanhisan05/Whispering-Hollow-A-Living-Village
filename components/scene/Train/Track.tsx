/**
 * The railway: rails, sleepers, ballast, telegraph poles and the station.
 *
 * The track is defined by a `CatmullRomCurve3` through the same control points
 * the terrain generator used to carve the cutting — so the rails always sit
 * exactly on the graded formation, with no gaps or floating sections.
 *
 * @module components/scene/Train/Track
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { RigidBody, CuboidCollider } from '@react-three/rapier';
import * as THREE from 'three';

import { useWorld } from '../TerrainContext';
import { useGameStore } from '@/store/gameStore';
import { mergeGeometries, transformGeometry } from '@/lib/geometry/merge';
import { woodTexture, rockTexture, roofTexture } from '@/lib/textures/procedural';
import { RandomSource } from '@/lib/utils/random';
import { RAIL_CONTROL_POINTS, STATION } from '@/lib/world/layout';
import { TRAIN, VILLAGE, WORLD } from '@/config/game';

/**
 * Builds the shared track curve.
 *
 * Centripetal parameterisation, matching `lib/utils/curve.ts` — the two must
 * agree or the rails will not sit in the cutting the terrain carved.
 */
export function useTrackCurve(): THREE.CatmullRomCurve3 {
  return useMemo(() => {
    const points = RAIL_CONTROL_POINTS.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5);
    return curve;
  }, []);
}

export function Track() {
  const curve = useTrackCurve();

  const { rails, sleepers, ballast, materials } = useMemo(() => {
    const samples = TRAIN.CURVE_SAMPLES;
    const points = curve.getSpacedPoints(samples);
    const tangents: THREE.Vector3[] = [];
    for (let i = 0; i < points.length; i++) {
      tangents.push(curve.getTangentAt(i / samples).normalize());
    }

    /* ── Rails ────────────────────────────────────────────────────────────
     * Two extruded strips following the curve, offset either side by the
     * gauge. Built as a triangle strip rather than a TubeGeometry: a rail head
     * is flat on top and catches the sun as a hard line, which a tube can't do
     * and which is most of what makes rails read as steel. */
    const railParts: THREE.BufferGeometry[] = [];
    const railWidth = 0.09;
    const railHeight = 0.14;

    for (const side of [-1, 1]) {
      const positions: number[] = [];
      const normals: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];

      for (let i = 0; i < points.length; i++) {
        const p = points[i]!;
        const t = tangents[i]!;
        // Perpendicular in the horizontal plane.
        const right = new THREE.Vector3(t.z, 0, -t.x).normalize();
        const center = p.clone().addScaledVector(right, side * TRAIN.RAIL_GAUGE);

        // Four points of the rail's cross section: two on top, two on the web.
        const a = center.clone().addScaledVector(right, -railWidth / 2);
        const b = center.clone().addScaledVector(right, railWidth / 2);
        a.y += railHeight;
        b.y += railHeight;
        const c = center.clone().addScaledVector(right, railWidth / 2);
        const d = center.clone().addScaledVector(right, -railWidth / 2);

        for (const v of [a, b, c, d]) positions.push(v.x, v.y, v.z);
        normals.push(0, 1, 0, 0, 1, 0, right.x, 0, right.z, -right.x, 0, -right.z);
        const u = i / points.length;
        uvs.push(0, u, 1, u, 1, u, 0, u);

        if (i < points.length - 1) {
          const base = i * 4;
          const next = (i + 1) * 4;
          // Top face.
          indices.push(base, next, base + 1, base + 1, next, next + 1);
          // Outer web.
          indices.push(base + 1, next + 1, base + 2, base + 2, next + 1, next + 2);
          // Inner web.
          indices.push(base + 3, next + 3, base, base, next + 3, next);
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      railParts.push(geo);
    }

    /* ── Sleepers ─────────────────────────────────────────────────────────── */
    const sleeperParts: THREE.BufferGeometry[] = [];
    const sleeperCount = TRAIN.SLEEPER_COUNT;
    const rng = new RandomSource('track', 'sleepers');

    for (let i = 0; i < sleeperCount; i++) {
      const t = i / sleeperCount;
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t).normalize();
      const yaw = Math.atan2(tan.x, tan.z);

      const sleeper = new THREE.BoxGeometry(2.5, 0.14, 0.26);
      transformGeometry(sleeper, {
        position: [p.x, p.y - 0.06, p.z],
        // Sleepers are perpendicular to the rails, with a little rotational
        // scatter — real track is never perfectly regular.
        rotation: [0, yaw + Math.PI / 2 + rng.gaussian(0, 0.012), rng.gaussian(0, 0.01)],
      });
      sleeperParts.push(sleeper);
    }

    /* ── Ballast ──────────────────────────────────────────────────────────
     * The trapezoidal stone bed under the sleepers. Built as a ribbon rather
     * than instanced pebbles — the pebble detail lives in the texture. */
    const ballastPositions: number[] = [];
    const ballastNormals: number[] = [];
    const ballastUvs: number[] = [];
    const ballastIndices: number[] = [];
    const step = 4;

    for (let i = 0; i < points.length; i += step) {
      const p = points[i]!;
      const t = tangents[i]!;
      const right = new THREE.Vector3(t.z, 0, -t.x).normalize();

      // Trapezoid: narrow on top, wide at the base.
      const topL = p.clone().addScaledVector(right, -1.7);
      const topR = p.clone().addScaledVector(right, 1.7);
      const botL = p.clone().addScaledVector(right, -2.9);
      const botR = p.clone().addScaledVector(right, 2.9);
      topL.y -= 0.14;
      topR.y -= 0.14;
      botL.y -= 0.62;
      botR.y -= 0.62;

      for (const v of [botL, topL, topR, botR]) ballastPositions.push(v.x, v.y, v.z);
      for (let k = 0; k < 4; k++) ballastNormals.push(0, 1, 0);
      const u = i / points.length;
      ballastUvs.push(0, u * 24, 0.3, u * 24, 0.7, u * 24, 1, u * 24);

      if (i + step < points.length) {
        const base = (i / step) * 4;
        const next = base + 4;
        for (let k = 0; k < 3; k++) {
          ballastIndices.push(base + k, next + k, base + k + 1);
          ballastIndices.push(base + k + 1, next + k, next + k + 1);
        }
      }
    }

    const ballastGeo = new THREE.BufferGeometry();
    ballastGeo.setAttribute('position', new THREE.Float32BufferAttribute(ballastPositions, 3));
    ballastGeo.setAttribute('uv', new THREE.Float32BufferAttribute(ballastUvs, 2));
    ballastGeo.setIndex(ballastIndices);
    ballastGeo.computeVertexNormals();

    const mats = {
      rail: new THREE.MeshStandardMaterial({
        color: '#6a6560',
        // Polished by passing wheels: the top of a rail is genuinely shiny.
        metalness: 0.92,
        roughness: 0.28,
      }),
      sleeper: new THREE.MeshStandardMaterial({
        map: woodTexture(256, [0.24, 0.18, 0.13]),
        roughness: 0.96,
      }),
      ballast: new THREE.MeshStandardMaterial({
        map: (() => {
          const t = rockTexture(512).clone();
          t.wrapS = THREE.RepeatWrapping;
          t.wrapT = THREE.RepeatWrapping;
          t.repeat.set(2, 1);
          t.needsUpdate = true;
          return t;
        })(),
        color: '#7a756c',
        roughness: 0.98,
      }),
    };

    return {
      rails: mergeGeometries(railParts, true),
      sleepers: mergeGeometries(sleeperParts, true),
      ballast: ballastGeo,
      materials: mats,
    };
  }, [curve]);

  useEffect(
    () => () => {
      rails.dispose();
      sleepers.dispose();
      ballast.dispose();
      Object.values(materials).forEach((m) => m.dispose());
    },
    [rails, sleepers, ballast, materials],
  );

  return (
    <group name="track">
      <mesh geometry={ballast} material={materials.ballast} receiveShadow />
      <mesh geometry={sleepers} material={materials.sleeper} receiveShadow castShadow />
      <mesh geometry={rails} material={materials.rail} receiveShadow castShadow />
      <TelegraphPoles curve={curve} />
      <Station />
    </group>
  );
}

/**
 * Telegraph poles with sagging wires.
 *
 * The wires use the same catenary as the plaza lanterns. Running them alongside
 * the track, receding into the distance, is one of the strongest depth cues in
 * the whole scene — the eye reads the converging line as *distance* far more
 * readily than it reads fog.
 */
function TelegraphPoles({ curve }: { curve: THREE.CatmullRomCurve3 }) {
  const { terrain } = useWorld();

  const { geometry, material } = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    const count = VILLAGE.TELEGRAPH_POLES;
    const poleHeight = 7.2;
    const anchors: THREE.Vector3[][] = [];

    for (let i = 0; i < count; i++) {
      // Spread along the middle of the curve, where the player can see them.
      const t = 0.12 + (i / (count - 1)) * 0.76;
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t).normalize();
      const right = new THREE.Vector3(tan.z, 0, -tan.x).normalize();

      const base = p.clone().addScaledVector(right, 5.4);
      base.y = terrain.heightAt(base.x, base.z);

      if (Math.abs(base.x) > WORLD.HALF - 8 || Math.abs(base.z) > WORLD.HALF - 8) continue;

      const pole = new THREE.CylinderGeometry(0.11, 0.15, poleHeight, 7);
      transformGeometry(pole, { position: [base.x, base.y + poleHeight / 2, base.z] });
      parts.push(pole);

      // Crossarm.
      const yaw = Math.atan2(tan.x, tan.z);
      const arm = new THREE.BoxGeometry(1.5, 0.11, 0.11);
      transformGeometry(arm, {
        position: [base.x, base.y + poleHeight - 0.5, base.z],
        rotation: [0, yaw, 0],
      });
      parts.push(arm);

      // Three insulator positions per pole.
      const armDir = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      const pts: THREE.Vector3[] = [];
      for (const offset of [-0.6, 0, 0.6]) {
        pts.push(
          new THREE.Vector3(
            base.x + armDir.x * offset,
            base.y + poleHeight - 0.38,
            base.z + armDir.z * offset,
          ),
        );
      }
      anchors.push(pts);
    }

    // Catenary wires between consecutive poles.
    for (let i = 0; i < anchors.length - 1; i++) {
      const from = anchors[i]!;
      const to = anchors[i + 1]!;
      for (let w = 0; w < 3; w++) {
        const a = from[w]!;
        const b = to[w]!;
        const span = a.distanceTo(b);
        const catA = span * 1.4;
        const steps = 8;

        for (let s = 0; s < steps; s++) {
          const t0 = s / steps;
          const t1 = (s + 1) / steps;
          const sag = (t: number) => {
            const x = (t - 0.5) * span;
            return catA * Math.cosh(x / catA) - catA * Math.cosh(span / 2 / catA);
          };
          const p0 = a.clone().lerp(b, t0);
          p0.y += sag(t0);
          const p1 = a.clone().lerp(b, t1);
          p1.y += sag(t1);

          const len = p0.distanceTo(p1);
          const seg = new THREE.CylinderGeometry(0.014, 0.014, len, 3);
          const mid = p0.clone().add(p1).multiplyScalar(0.5);
          const dir = p1.clone().sub(p0).normalize();
          const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
          seg.applyMatrix4(new THREE.Matrix4().compose(mid, quat, new THREE.Vector3(1, 1, 1)));
          parts.push(seg);
        }
      }
    }

    return {
      geometry: mergeGeometries(parts, true),
      material: new THREE.MeshStandardMaterial({
        map: woodTexture(256, [0.3, 0.24, 0.18]),
        roughness: 0.95,
      }),
    };
  }, [curve, terrain]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  return <mesh geometry={geometry} material={material} castShadow name="telegraph-poles" />;
}

/** The little station shelter, with a bench and a vintage clock. */
function Station() {
  const { terrain } = useWorld();
  const clockHandRef = useRef<THREE.Group>(null);
  const minuteHandRef = useRef<THREE.Group>(null);

  const y = useMemo(() => terrain.heightAt(STATION.x, STATION.z), [terrain]);

  const { geometry, material, roofGeo, roofMat } = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    const roofParts: THREE.BufferGeometry[] = [];

    // Platform.
    const platform = new THREE.BoxGeometry(9, 0.5, 3.6);
    transformGeometry(platform, { position: [0, 0.25, 0] });
    parts.push(platform);

    // Back wall.
    const wall = new THREE.BoxGeometry(6.5, 2.6, 0.18);
    transformGeometry(wall, { position: [0, 1.8, -1.6] });
    parts.push(wall);

    // Posts.
    for (const x of [-3, 0, 3]) {
      const post = new THREE.BoxGeometry(0.14, 2.6, 0.14);
      transformGeometry(post, { position: [x, 1.8, 1.5] });
      parts.push(post);
    }

    // Bench.
    const seat = new THREE.BoxGeometry(3.2, 0.1, 0.45);
    transformGeometry(seat, { position: [0, 0.95, -1.15] });
    parts.push(seat);
    const back = new THREE.BoxGeometry(3.2, 0.5, 0.08);
    transformGeometry(back, { position: [0, 1.35, -1.38] });
    parts.push(back);
    for (const x of [-1.4, 1.4]) {
      const leg = new THREE.BoxGeometry(0.12, 0.45, 0.4);
      transformGeometry(leg, { position: [x, 0.72, -1.15] });
      parts.push(leg);
    }

    // Roof — a single pitch sloping toward the track.
    const roof = new THREE.BoxGeometry(7.4, 0.12, 4.2);
    transformGeometry(roof, { position: [0, 3.2, 0], rotation: [-0.2, 0, 0] });
    roofParts.push(roof);

    // Clock post and face housing.
    const clockPost = new THREE.CylinderGeometry(0.08, 0.1, 3.2, 8);
    transformGeometry(clockPost, { position: [4.2, 1.6, 0.8] });
    parts.push(clockPost);
    const housing = new THREE.CylinderGeometry(0.42, 0.42, 0.16, 16);
    transformGeometry(housing, { position: [4.2, 3.35, 0.8], rotation: [Math.PI / 2, 0, 0] });
    parts.push(housing);

    return {
      geometry: mergeGeometries(parts, true),
      material: new THREE.MeshStandardMaterial({
        map: woodTexture(256, [0.38, 0.3, 0.22]),
        roughness: 0.93,
      }),
      roofGeo: mergeGeometries(roofParts, true),
      roofMat: new THREE.MeshStandardMaterial({ map: roofTexture(256, false), roughness: 0.85 }),
    };
  }, []);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
      roofGeo.dispose();
      roofMat.dispose();
    },
    [geometry, material, roofGeo, roofMat],
  );

  /* The clock shows the in-game time. A nice touch: the player can read the
   * hour from across the platform, and it agrees with the sun. */
  const timeOfDay = useGameStore((s) => s.timeOfDay);

  useEffect(() => {
    if (clockHandRef.current) {
      // Twelve-hour dial: two revolutions per day.
      clockHandRef.current.rotation.z = -timeOfDay * Math.PI * 4;
    }
    if (minuteHandRef.current) {
      minuteHandRef.current.rotation.z = -timeOfDay * Math.PI * 48;
    }
  }, [timeOfDay]);

  const yaw = -0.15;

  return (
    <group position={[STATION.x, y, STATION.z]} rotation={[0, yaw, 0]} name="station">
      <mesh geometry={geometry} material={material} castShadow receiveShadow />
      <mesh geometry={roofGeo} material={roofMat} castShadow receiveShadow />

      {/* Clock face and hands. */}
      <group position={[4.2, 3.35, 0.89]}>
        <mesh>
          <circleGeometry args={[0.36, 20]} />
          <meshStandardMaterial color="#f0ead8" roughness={0.4} />
        </mesh>
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i / 12) * Math.PI * 2;
          return (
            <mesh key={i} position={[Math.sin(a) * 0.29, Math.cos(a) * 0.29, 0.01]}>
              <boxGeometry args={[0.025, 0.06, 0.005]} />
              <meshStandardMaterial color="#2a2620" />
            </mesh>
          );
        })}
        <group ref={clockHandRef} position={[0, 0, 0.02]}>
          <mesh position={[0, 0.09, 0]}>
            <boxGeometry args={[0.028, 0.18, 0.006]} />
            <meshStandardMaterial color="#2a2620" />
          </mesh>
        </group>
        <group ref={minuteHandRef} position={[0, 0, 0.03]}>
          <mesh position={[0, 0.13, 0]}>
            <boxGeometry args={[0.018, 0.26, 0.006]} />
            <meshStandardMaterial color="#2a2620" />
          </mesh>
        </group>
      </group>

      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[4.5, 0.25, 1.8]} position={[0, 0.25, 0]} />
        <CuboidCollider args={[3.25, 1.3, 0.1]} position={[0, 1.8, -1.6]} />
      </RigidBody>
    </group>
  );
}
