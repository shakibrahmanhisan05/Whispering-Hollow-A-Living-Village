/**
 * Village assembly: places the houses, the plaza, the lanterns, the stalls, the
 * fences, the signposts and the cemetery.
 *
 * @module components/scene/Village/Village
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RigidBody, CuboidCollider } from '@react-three/rapier';
import * as THREE from 'three';

import { useWorld } from '../TerrainContext';
import { useLighting } from '@/hooks/useTimeOfDay';
import { useWindField } from '@/hooks/useWind';
import { useGameStore } from '@/store/gameStore';
import { useSettingsStore } from '@/store/settingsStore';
import { House } from './House';
import { Well, Windmill, Church, MarketStall, Bouquet } from './Landmarks';
import { RandomSource } from '@/lib/utils/random';
import { mergeGeometries, transformGeometry } from '@/lib/geometry/merge';
import { cobbleTexture, woodTexture, rockTexture } from '@/lib/textures/procedural';
import { SIGNPOSTS } from '@/lib/progression/content';
import { VILLAGE, ZONES, WORLD, SEASONS } from '@/config/game';
import { RIDGE_BENCH, POND } from '@/lib/world/layout';
import { clamp } from '@/lib/utils/math';

/** Exposed so the interaction system can trigger the bell swing. */
export const bellSwingRef = { current: 0 };

export function Village() {
  const { terrain } = useWorld();
  const villageSize = useSettingsStore((s) => s.world.villageSize);

  const houseCount = VILLAGE.HOUSE_COUNT[villageSize];

  /* ── House placement ─────────────────────────────────────────────────────
   * Houses sit on a jittered ring around the plaza, each rotated to face the
   * centre. Facing inward is what makes a scatter of buildings read as a
   * *village* rather than a subdivision. */
  const houses = useMemo(() => {
    const rng = new RandomSource(terrain.seed, 'village-houses');
    const out: Array<{
      position: [number, number, number];
      rotation: number;
      seed: string;
      index: number;
    }> = [];

    for (let i = 0; i < houseCount; i++) {
      // Golden-angle spacing avoids the visible symmetry of even spacing.
      const angle = (i / houseCount) * Math.PI * 2 + rng.gaussian(0, 0.14);
      const radius = VILLAGE.HOUSE_RING_RADIUS + rng.gaussian(0, VILLAGE.HOUSE_RING_JITTER * 0.5);
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const y = terrain.heightAt(x, z);

      // Face the plaza, with a little variation so the ring isn't rigid.
      const facing = Math.atan2(-x, -z) + rng.gaussian(0, 0.22);

      out.push({
        position: [x, y - 0.15, z],
        rotation: facing,
        seed: `${terrain.seed}-house-${i}`,
        index: i,
      });
    }
    return out;
  }, [terrain, houseCount]);

  const churchPos = useMemo<[number, number, number]>(() => {
    const x = -24;
    const z = 26;
    return [x, terrain.heightAt(x, z) - 0.2, z];
  }, [terrain]);

  const windmillPos = useMemo<[number, number, number]>(() => {
    const [x, z] = ZONES.WHEAT_AND_WINDMILL.center;
    return [x, terrain.heightAt(x, z) - 0.4, z];
  }, [terrain]);

  const wellPos = useMemo<[number, number, number]>(
    () => [2, terrain.heightAt(2, -3), -3],
    [terrain],
  );

  const stalls = useMemo(() => {
    const rng = new RandomSource(terrain.seed, 'stalls');
    const palettes: Array<[string, string]> = [
      ['#c94a38', '#f0e8d8'],
      ['#3f7a8c', '#e8e0cc'],
      ['#8a6ab0', '#f2ecd8'],
      ['#4a8a4a', '#eee6d0'],
      ['#d4923c', '#f2e8d4'],
    ];
    return Array.from({ length: VILLAGE.STALL_COUNT }, (_, i) => {
      const angle = (i / VILLAGE.STALL_COUNT) * Math.PI * 2 + 0.6;
      const r = VILLAGE.PLAZA_RADIUS - 2.5;
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      const palette = palettes[i % palettes.length]!;
      return {
        position: [x, terrain.heightAt(x, z), z] as [number, number, number],
        rotation: Math.atan2(-x, -z) + rng.gaussian(0, 0.1),
        colorA: palette[0],
        colorB: palette[1],
        index: i,
      };
    });
  }, [terrain]);

  return (
    <group name="village">
      <Plaza />

      {houses.map((h) => (
        <House key={h.index} {...h} />
      ))}

      <Well position={wellPos} />
      <Church position={churchPos} rotation={-0.4} bellSwing={bellSwingRef} />
      <Windmill position={windmillPos} />

      {stalls.map((s) => (
        <MarketStall key={s.index} {...s} />
      ))}

      <HangingLanterns />
      <Signposts />
      <Cemetery position={[churchPos[0] - 4, churchPos[1], churchPos[2] - 12]} />
      <Fences />
      <RidgeViewpoint />
      <PondDock />
      <GroundClutter />
    </group>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * PLAZA
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The cobbled plaza.
 *
 * Rendered as a single disc with the procedural cobble texture, plus a few
 * hundred instanced raised stones near the centre for genuine relief. A flat
 * texture alone goes lifeless at grazing angles; the raised stones catch the
 * low sun and give the plaza a surface.
 */
function Plaza() {
  const { terrain } = useWorld();

  const { discGeo, discMat, stoneGeo, stoneMat, matrices } = useMemo(() => {
    /* The disc follows the terrain, so it never floats or clips at the edges
     * where the flattening blends out. */
    const segments = 64;
    const geo = new THREE.CircleGeometry(VILLAGE.PLAZA_RADIUS, segments, 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, terrain.heightAt(x, z) + 0.035);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    const tex = cobbleTexture(512).clone();
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(7, 7);
    tex.needsUpdate = true;

    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 });

    // Raised stones.
    const sGeo = new THREE.BoxGeometry(0.34, 0.09, 0.28);
    const sMat = new THREE.MeshStandardMaterial({ color: '#8a857a', roughness: 0.9 });
    const rng = new RandomSource('plaza', 'stones');
    const mats: THREE.Matrix4[] = [];
    for (let i = 0; i < VILLAGE.COBBLE_COUNT; i++) {
      const [x, z] = rng.insideDisc(VILLAGE.PLAZA_RADIUS - 0.4);
      const y = terrain.heightAt(x, z) + 0.05;
      mats.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(x, y, z),
          new THREE.Quaternion().setFromEuler(
            new THREE.Euler(rng.gaussian(0, 0.04), rng.angle(), rng.gaussian(0, 0.04)),
          ),
          new THREE.Vector3(rng.range(0.8, 1.25), rng.range(0.7, 1.3), rng.range(0.8, 1.25)),
        ),
      );
    }

    return { discGeo: geo, discMat: mat, stoneGeo: sGeo, stoneMat: sMat, matrices: mats };
  }, [terrain]);

  const meshRef = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [matrices]);

  useEffect(
    () => () => {
      discGeo.dispose();
      discMat.dispose();
      stoneGeo.dispose();
      stoneMat.dispose();
    },
    [discGeo, discMat, stoneGeo, stoneMat],
  );

  return (
    <group name="plaza">
      <mesh geometry={discGeo} material={discMat} receiveShadow renderOrder={1} />
      <instancedMesh
        ref={meshRef}
        args={[stoneGeo, stoneMat, matrices.length]}
        receiveShadow
        castShadow={false}
      />
    </group>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * LANTERNS
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Lanterns strung across the plaza on catenary cables.
 *
 * The cable sag uses a real catenary (`cosh`), not a parabola. The difference
 * is small but visible at these spans — a parabola sags too evenly and reads as
 * a drawn curve rather than a hanging rope.
 *
 * Lanterns are emissive and swing in the wind. Only the four nearest cast an
 * actual `PointLight`: 22 shadow-less point lights would still cost 22 lighting
 * evaluations per fragment, so the rest rely on emissive + bloom.
 */
function HangingLanterns() {
  const { terrain } = useWorld();
  const lighting = useLighting();
  const wind = useWindField();
  const groupRef = useRef<THREE.Group>(null);
  const materialRef = useRef<THREE.MeshStandardMaterial>(null);

  const { anchors, lanterns, cableGeo } = useMemo(() => {
    const rng = new RandomSource('lanterns', 'v1');
    const poleCount = 6;
    const radius = VILLAGE.PLAZA_RADIUS - 1;
    const poles: Array<[number, number, number]> = [];

    for (let i = 0; i < poleCount; i++) {
      const a = (i / poleCount) * Math.PI * 2;
      const x = Math.cos(a) * radius;
      const z = Math.sin(a) * radius;
      poles.push([x, terrain.heightAt(x, z), z]);
    }

    /* Lanterns hang along catenary spans between consecutive poles.
     * y = a·cosh(x/a) — the shape a uniform cable takes under gravity. */
    const lanternList: Array<{ pos: [number, number, number]; phase: number }> = [];
    const cableParts: THREE.BufferGeometry[] = [];
    const poleHeight = 4.6;
    const perSpan = Math.ceil(VILLAGE.LANTERN_COUNT / poleCount);

    for (let i = 0; i < poleCount; i++) {
      const a = poles[i]!;
      const b = poles[(i + 1) % poleCount]!;
      const span = Math.hypot(b[0] - a[0], b[2] - a[2]);
      // Catenary parameter: larger = tighter cable, smaller = deeper sag.
      const catA = span * 0.9;
      const sagAt = (t: number) => {
        const s = (t - 0.5) * span;
        return catA * Math.cosh(s / catA) - catA * Math.cosh(span / 2 / catA);
      };

      for (let j = 0; j < perSpan && lanternList.length < VILLAGE.LANTERN_COUNT; j++) {
        const t = (j + 0.5) / perSpan;
        const x = a[0] + (b[0] - a[0]) * t;
        const z = a[2] + (b[2] - a[2]) * t;
        const y = a[1] + poleHeight + sagAt(t);
        lanternList.push({ pos: [x, y, z], phase: rng.angle() });
      }

      // Cable segments following the same curve.
      const steps = 10;
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps;
        const t1 = (s + 1) / steps;
        const p0 = new THREE.Vector3(
          a[0] + (b[0] - a[0]) * t0,
          a[1] + poleHeight + sagAt(t0),
          a[2] + (b[2] - a[2]) * t0,
        );
        const p1 = new THREE.Vector3(
          a[0] + (b[0] - a[0]) * t1,
          a[1] + poleHeight + sagAt(t1),
          a[2] + (b[2] - a[2]) * t1,
        );
        const len = p0.distanceTo(p1);
        const seg = new THREE.CylinderGeometry(0.015, 0.015, len, 4);
        const mid = p0.clone().add(p1).multiplyScalar(0.5);
        const dir = p1.clone().sub(p0).normalize();
        const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        seg.applyMatrix4(new THREE.Matrix4().compose(mid, quat, new THREE.Vector3(1, 1, 1)));
        cableParts.push(seg);
      }

      // The pole.
      const pole = new THREE.CylinderGeometry(0.09, 0.13, poleHeight, 7);
      transformGeometry(pole, { position: [a[0], a[1] + poleHeight / 2, a[2]] });
      cableParts.push(pole);
    }

    return {
      anchors: poles,
      lanterns: lanternList,
      cableGeo: mergeGeometries(cableParts, true),
    };
  }, [terrain]);

  const cableMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#3a3028', roughness: 0.95 }),
    [],
  );

  useEffect(
    () => () => {
      cableGeo.dispose();
      cableMat.dispose();
    },
    [cableGeo, cableMat],
  );

  useFrame(({ clock }) => {
    if (materialRef.current) {
      materialRef.current.emissiveIntensity = lighting.lampIntensity * 3.2;
    }

    // Swing the lanterns.
    const group = groupRef.current;
    if (!group) return;
    const t = clock.elapsedTime;
    const amp = 0.04 + wind.strength * 0.12;
    group.children.forEach((child, i) => {
      const phase = lanterns[i]?.phase ?? 0;
      child.rotation.z = Math.sin(t * 1.6 + phase) * amp;
      child.rotation.x = Math.sin(t * 1.15 + phase * 1.7) * amp * 0.7;
    });
  });

  /* Only the four lanterns nearest the plaza centre get real lights. */
  const litIndices = useMemo(() => [0, Math.floor(lanterns.length * 0.25), Math.floor(lanterns.length * 0.5), Math.floor(lanterns.length * 0.75)], [lanterns.length]);

  return (
    <group name="lanterns">
      <mesh geometry={cableGeo} material={cableMat} castShadow />

      <group ref={groupRef}>
        {lanterns.map((l, i) => (
          <group key={i} position={l.pos}>
            {/* Hanging point is above the lantern, so it swings like a pendulum. */}
            <mesh position={[0, -0.28, 0]} castShadow>
              <cylinderGeometry args={[0.13, 0.16, 0.32, 8]} />
              <meshStandardMaterial
                ref={i === 0 ? materialRef : undefined}
                color="#3a2f22"
                emissive={new THREE.Color('#ffb45a')}
                emissiveIntensity={0}
                roughness={0.5}
              />
            </mesh>
            <mesh position={[0, -0.12, 0]}>
              <cylinderGeometry args={[0.017, 0.017, 0.3, 4]} />
              <meshStandardMaterial color="#2a2018" />
            </mesh>
            {litIndices.includes(i) && (
              <LanternLight intensity={lighting.lampIntensity} />
            )}
          </group>
        ))}
      </group>

      {anchors.map((a, i) => (
        <RigidBody key={i} type="fixed" colliders={false}>
          <CuboidCollider args={[0.14, 2.3, 0.14]} position={[a[0], a[1] + 2.3, a[2]]} />
        </RigidBody>
      ))}
    </group>
  );
}

/** A point light attached to one lantern, disabled during the day. */
function LanternLight({ intensity }: { intensity: number }) {
  const ref = useRef<THREE.PointLight>(null);
  useFrame(() => {
    if (!ref.current) return;
    ref.current.intensity = intensity * 4.5;
    ref.current.visible = intensity > 0.04;
  });
  return (
    <pointLight ref={ref} position={[0, -0.28, 0]} color="#ffb45a" distance={11} decay={2} />
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * SIGNPOSTS
 * ─────────────────────────────────────────────────────────────────────────── */

/** The eight readable signposts. */
function Signposts() {
  const { terrain } = useWorld();

  const { geometry, material, transforms } = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    // Post.
    const post = new THREE.BoxGeometry(0.12, 2.1, 0.12);
    transformGeometry(post, { position: [0, 1.05, 0] });
    parts.push(post);
    // Board.
    const board = new THREE.BoxGeometry(1.25, 0.62, 0.07);
    transformGeometry(board, { position: [0, 1.72, 0.04] });
    parts.push(board);
    // Frame trim.
    for (const [w, h, y] of [
      [1.35, 0.07, 1.72 + 0.31],
      [1.35, 0.07, 1.72 - 0.31],
    ] as const) {
      const trim = new THREE.BoxGeometry(w, h, 0.09);
      transformGeometry(trim, { position: [0, y, 0.04] });
      parts.push(trim);
    }

    const geo = mergeGeometries(parts, true);
    const mat = new THREE.MeshStandardMaterial({
      map: woodTexture(256, [0.42, 0.32, 0.22]),
      roughness: 0.92,
    });

    const tf = SIGNPOSTS.map((s) => ({
      position: [s.position[0], terrain.heightAt(s.position[0], s.position[1]), s.position[1]] as [
        number,
        number,
        number,
      ],
      rotation: s.yaw,
      id: s.id,
    }));

    return { geometry: geo, material: mat, transforms: tf };
  }, [terrain]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  return (
    <group name="signposts">
      {transforms.map((t) => (
        <group key={t.id} position={t.position} rotation={[0, t.rotation, 0]}>
          <mesh geometry={geometry} material={material} castShadow receiveShadow />
          <RigidBody type="fixed" colliders={false}>
            <CuboidCollider args={[0.12, 1.05, 0.12]} position={[0, 1.05, 0]} />
          </RigidBody>
        </group>
      ))}
    </group>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * CEMETERY
 * ─────────────────────────────────────────────────────────────────────────── */

/** The small graveyard behind the church. Another place to leave flowers. */
function Cemetery({ position }: { position: [number, number, number] }) {
  const { terrain } = useWorld();
  const graveFlowers = useGameStore((s) => s.progress.discoveries['grave-bouquet']);

  const { geometry, material, transforms } = useMemo(() => {
    const rng = new RandomSource('cemetery', 'v1');
    const parts: THREE.BufferGeometry[] = [];
    // A rounded headstone: a box with a half-cylinder cap.
    const stone = new THREE.BoxGeometry(0.5, 0.7, 0.11);
    transformGeometry(stone, { position: [0, 0.35, 0] });
    parts.push(stone);
    const cap = new THREE.CylinderGeometry(0.25, 0.25, 0.11, 10, 1, false, 0, Math.PI);
    transformGeometry(cap, { position: [0, 0.7, 0], rotation: [Math.PI / 2, 0, 0] });
    parts.push(cap);

    const geo = mergeGeometries(parts, true);
    const mat = new THREE.MeshStandardMaterial({
      map: rockTexture(512),
      color: '#9a958a',
      roughness: 0.96,
    });

    const tf = Array.from({ length: VILLAGE.GRAVE_COUNT }, (_, i) => {
      const row = Math.floor(i / 4);
      const col = i % 4;
      const x = position[0] + (col - 1.5) * 1.5 + rng.gaussian(0, 0.14);
      const z = position[2] + row * 1.9 + rng.gaussian(0, 0.14);
      return {
        position: [x, terrain.heightAt(x, z), z] as [number, number, number],
        // Old stones lean.
        tilt: rng.gaussian(0, 0.08),
        rotation: rng.gaussian(0, 0.12),
        scale: rng.range(0.85, 1.2),
      };
    });

    return { geometry: geo, material: mat, transforms: tf };
  }, [terrain, position]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  return (
    <group name="cemetery">
      {transforms.map((t, i) => (
        <group key={i} position={t.position} rotation={[t.tilt, t.rotation, t.tilt * 0.6]} scale={t.scale}>
          <mesh geometry={geometry} material={material} castShadow receiveShadow />
          {graveFlowers && i === 0 && <Bouquet position={[0, 0.06, 0.28]} />}
        </group>
      ))}
    </group>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * FENCES
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Fencing around the cattle paddock and along parts of the road.
 *
 * All the posts and rails merge into one geometry — a fence is dozens of small
 * boxes, and drawing them individually would be one of the most wasteful things
 * in the scene.
 */
function Fences() {
  const { terrain } = useWorld();

  const { geometry, material, colliders } = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    const cols: Array<{ half: [number, number, number]; pos: [number, number, number] }> = [];

    /** Runs a fence line between two points, following the terrain. */
    const run = (from: [number, number], to: [number, number], spacing = 2.2) => {
      const dx = to[0] - from[0];
      const dz = to[1] - from[1];
      const length = Math.hypot(dx, dz);
      const count = Math.max(2, Math.round(length / spacing));
      const angle = Math.atan2(dz, dx);

      for (let i = 0; i <= count; i++) {
        const t = i / count;
        const x = from[0] + dx * t;
        const z = from[1] + dz * t;
        const y = terrain.heightAt(x, z);

        const post = new THREE.BoxGeometry(0.11, 1.25, 0.11);
        transformGeometry(post, { position: [x, y + 0.6, z], rotation: [0, angle, 0] });
        parts.push(post);

        // Two rails between consecutive posts, following the ground.
        if (i < count) {
          const t2 = (i + 1) / count;
          const x2 = from[0] + dx * t2;
          const z2 = from[1] + dz * t2;
          const y2 = terrain.heightAt(x2, z2);
          const segLen = Math.hypot(x2 - x, z2 - z, y2 - y);

          for (const railY of [0.42, 0.92]) {
            const rail = new THREE.BoxGeometry(segLen, 0.07, 0.05);
            const midX = (x + x2) / 2;
            const midZ = (z + z2) / 2;
            const midY = (y + y2) / 2 + railY;
            // Pitch the rail to follow the slope.
            const pitch = Math.atan2(y2 - y, Math.hypot(x2 - x, z2 - z));
            transformGeometry(rail, {
              position: [midX, midY, midZ],
              rotation: [0, -angle, pitch],
            });
            parts.push(rail);
          }
        }
      }

      // One collider along the whole run, rather than per post.
      cols.push({
        half: [length / 2, 0.65, 0.12],
        pos: [
          (from[0] + to[0]) / 2,
          terrain.heightAt((from[0] + to[0]) / 2, (from[1] + to[1]) / 2) + 0.65,
          (from[1] + to[1]) / 2,
        ],
      });
    };

    // The cattle paddock — a rough rectangle east of the village.
    const paddock: Array<[number, number]> = [
      [24, -30],
      [46, -26],
      [50, -8],
      [28, -12],
    ];
    for (let i = 0; i < paddock.length; i++) {
      run(paddock[i]!, paddock[(i + 1) % paddock.length]!);
    }

    // A short run along the road out of the village.
    run([12, 12], [16, 34]);
    run([-6, 10], [-14, 30]);

    const geo = mergeGeometries(parts, true);
    const mat = new THREE.MeshStandardMaterial({
      map: woodTexture(256, [0.44, 0.34, 0.24]),
      roughness: 0.94,
    });

    return { geometry: geo, material: mat, colliders: cols };
  }, [terrain]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  return (
    <group name="fences">
      <mesh geometry={geometry} material={material} castShadow receiveShadow />
      <RigidBody type="fixed" colliders={false}>
        {colliders.map((c, i) => {
          // Rotate the collider to match the fence run's heading.
          return <CuboidCollider key={i} args={c.half} position={c.pos} />;
        })}
      </RigidBody>
    </group>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * RIDGE
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The ridge viewpoint: a stone bench, a flagpole with a flag that reacts to
 * wind, and a wind-chime.
 */
function RidgeViewpoint() {
  const { terrain } = useWorld();
  const wind = useWindField();
  const flagRef = useRef<THREE.Mesh>(null);
  const flagBase = useRef<Float32Array | null>(null);
  const chimeRef = useRef<THREE.Group>(null);

  const groundY = useMemo(
    () => terrain.heightAt(RIDGE_BENCH.x, RIDGE_BENCH.z),
    [terrain],
  );

  const flagGeo = useMemo(() => {
    const geo = new THREE.PlaneGeometry(1.8, 1.1, 16, 8);
    flagBase.current = Float32Array.from(geo.attributes.position!.array as Float32Array);
    return geo;
  }, []);

  useEffect(() => () => flagGeo.dispose(), [flagGeo]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;

    /* Flag ripple. Anchored at the left edge (x = −0.9), free at the right, so
     * displacement grows with distance from the pole. The travelling wave runs
     * along X, which is what makes a flag look like it is being *blown* rather
     * than shaken. */
    const mesh = flagRef.current;
    const base = flagBase.current;
    if (mesh && base) {
      const attr = mesh.geometry.attributes.position as THREE.BufferAttribute;
      const strength = clamp(wind.strength, 0, 2);
      for (let i = 0; i < attr.count; i++) {
        const x = base[i * 3]!;
        const y = base[i * 3 + 1]!;
        const free = clamp((x + 0.9) / 1.8, 0, 1);
        const wave =
          Math.sin(x * 5.2 - t * 7 + y * 1.4) * 0.13 + Math.sin(x * 8.5 - t * 11) * 0.06;
        attr.setXYZ(i, x, y + wave * free * strength * 0.4, wave * free * strength);
      }
      attr.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
    }

    // The chime tubes sway.
    if (chimeRef.current) {
      const amp = 0.06 + wind.strength * 0.2;
      chimeRef.current.rotation.z = Math.sin(t * 2.1) * amp;
      chimeRef.current.rotation.x = Math.sin(t * 1.7 + 0.9) * amp * 0.8;
    }
  });

  return (
    <group name="ridge-viewpoint" position={[RIDGE_BENCH.x, groundY, RIDGE_BENCH.z]}>
      {/* Stone bench. */}
      <group rotation={[0, RIDGE_BENCH.yaw, 0]}>
        <mesh position={[0, 0.42, 0]} castShadow receiveShadow>
          <boxGeometry args={[2.2, 0.14, 0.52]} />
          <meshStandardMaterial color="#8f8a7e" roughness={0.95} />
        </mesh>
        {[-0.85, 0.85].map((x) => (
          <mesh key={x} position={[x, 0.2, 0]} castShadow>
            <boxGeometry args={[0.28, 0.4, 0.46]} />
            <meshStandardMaterial color="#7f7a70" roughness={0.96} />
          </mesh>
        ))}
        <mesh position={[0, 0.78, -0.22]} rotation={[-0.18, 0, 0]} castShadow>
          <boxGeometry args={[2.2, 0.5, 0.1]} />
          <meshStandardMaterial color="#8f8a7e" roughness={0.95} />
        </mesh>
        <RigidBody type="fixed" colliders={false}>
          <CuboidCollider args={[1.1, 0.45, 0.3]} position={[0, 0.45, 0]} />
        </RigidBody>
      </group>

      {/* Flagpole. */}
      <group position={[3.2, 0, -1.4]}>
        <mesh position={[0, 2.6, 0]} castShadow>
          <cylinderGeometry args={[0.055, 0.075, 5.2, 8]} />
          <meshStandardMaterial color="#d8d4c8" roughness={0.6} metalness={0.15} />
        </mesh>
        <mesh position={[0, 5.25, 0]}>
          <sphereGeometry args={[0.1, 8, 6]} />
          <meshStandardMaterial color="#c8a24a" metalness={0.8} roughness={0.3} />
        </mesh>
        <mesh ref={flagRef} geometry={flagGeo} position={[0.95, 4.4, 0]} castShadow>
          <meshStandardMaterial color="#c94a38" side={THREE.DoubleSide} roughness={0.9} />
        </mesh>
        <RigidBody type="fixed" colliders={false}>
          <CuboidCollider args={[0.1, 2.6, 0.1]} position={[0, 2.6, 0]} />
        </RigidBody>
      </group>

      {/* Wind chime, hanging from a small post. */}
      <group position={[-2.4, 0, 0.8]}>
        <mesh position={[0, 1.2, 0]} castShadow>
          <cylinderGeometry args={[0.05, 0.06, 2.4, 6]} />
          <meshStandardMaterial color="#6a5038" roughness={0.9} />
        </mesh>
        <mesh position={[0.3, 2.35, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.035, 0.035, 0.65, 6]} />
          <meshStandardMaterial color="#6a5038" roughness={0.9} />
        </mesh>
        <group ref={chimeRef} position={[0.58, 2.3, 0]}>
          {[0, 1, 2, 3, 4].map((i) => {
            const a = (i / 5) * Math.PI * 2;
            const len = 0.55 - i * 0.06;
            return (
              <mesh
                key={i}
                position={[Math.cos(a) * 0.11, -len / 2 - 0.1, Math.sin(a) * 0.11]}
                castShadow
              >
                <cylinderGeometry args={[0.022, 0.022, len, 6]} />
                <meshStandardMaterial color="#c8b078" metalness={0.75} roughness={0.32} />
              </mesh>
            );
          })}
        </group>
      </group>
    </group>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * POND DOCK
 * ─────────────────────────────────────────────────────────────────────────── */

/** A short wooden jetty — the stone-skipping and fish-feeding spot. */
function PondDock() {
  const position = useMemo<[number, number, number]>(() => {
    // On the shore nearest the village.
    const angle = Math.atan2(-POND.center[1], -POND.center[0]);
    const x = POND.center[0] + Math.cos(angle) * (POND.radius - 1);
    const z = POND.center[1] + Math.sin(angle) * (POND.radius - 1);
    return [x, WORLD.WATER_LEVEL, z];
  }, []);

  const yaw = useMemo(
    () => Math.atan2(POND.center[1] - position[2], POND.center[0] - position[0]),
    [position],
  );

  const woodMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: woodTexture(256, [0.46, 0.36, 0.26]),
        roughness: 0.94,
      }),
    [],
  );

  useEffect(() => () => woodMat.dispose(), [woodMat]);

  return (
    <group position={position} rotation={[0, -yaw, 0]} name="pond-dock">
      {/* Deck planks. */}
      {Array.from({ length: 9 }, (_, i) => (
        <mesh key={i} position={[i * 0.42 + 0.3, 0.42, 0]} material={woodMat} castShadow receiveShadow>
          <boxGeometry args={[0.36, 0.08, 1.6]} />
        </mesh>
      ))}
      {/* Piles. */}
      {[0.5, 2.0, 3.5].map((x) =>
        [-0.65, 0.65].map((z) => (
          <mesh key={`${x}-${z}`} position={[x, -0.35, z]} material={woodMat} castShadow>
            <cylinderGeometry args={[0.09, 0.09, 1.6, 6]} />
          </mesh>
        )),
      )}
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[1.95, 0.06, 0.8]} position={[2.0, 0.42, 0]} />
      </RigidBody>
    </group>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * GROUND CLUTTER
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Scattered rocks, logs and stumps.
 *
 * The cheapest possible way to make a landscape feel inhabited rather than
 * generated: a few hundred instanced irregular boulders, sunk partly into the
 * ground so they read as *emerging* from the terrain rather than resting on it.
 */
function GroundClutter() {
  const { terrain: clutterTerrain } = useWorld();
  const season = useGameStore((s) => s.season);
  const snowUniform = useRef({ value: 0 });

  const { geometry, material, matrices } = useMemo(() => {
    /* An icosahedron with jittered vertices makes a convincing boulder in 20
     * triangles. Jittering *after* generation, rather than using noise in a
     * shader, keeps them all one instanced draw. */
    const geo = new THREE.IcosahedronGeometry(0.5, 0);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const rngGeo = new RandomSource('rocks', 'shape');
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(
        i,
        pos.getX(i) * rngGeo.range(0.7, 1.3),
        pos.getY(i) * rngGeo.range(0.6, 1.1),
        pos.getZ(i) * rngGeo.range(0.7, 1.3),
      );
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      map: rockTexture(512),
      color: '#8a857c',
      roughness: 0.96,
    });

    const rng = new RandomSource(clutterTerrain.seed, 'clutter');
    const mats: THREE.Matrix4[] = [];
    const margin = WORLD.HALF - 20;

    for (let i = 0; i < VEGETATION_ROCK_COUNT; i++) {
      const x = rng.range(-margin, margin);
      const z = rng.range(-margin, margin);
      const y = clutterTerrain.heightAt(x, z);
      if (y < WORLD.WATER_LEVEL) continue;
      if (Math.hypot(x, z) < 18) continue;

      const scale = rng.range(0.35, 1.9);
      mats.push(
        new THREE.Matrix4().compose(
          // Sink each rock partway into the ground.
          new THREE.Vector3(x, y - scale * 0.22, z),
          new THREE.Quaternion().setFromEuler(
            new THREE.Euler(rng.angle(), rng.angle(), rng.angle()),
          ),
          new THREE.Vector3(scale, scale * rng.range(0.6, 1), scale),
        ),
      );
    }

    return { geometry: geo, material: mat, matrices: mats };
  }, [clutterTerrain]);

  const meshRef = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [matrices]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useFrame((_, dt) => {
    snowUniform.current.value +=
      (SEASONS[season].snowCoverage - snowUniform.current.value) * Math.min(dt, 0.08);
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, matrices.length]}
      castShadow
      receiveShadow
      name="ground-clutter"
    />
  );
}

const VEGETATION_ROCK_COUNT = 520;
