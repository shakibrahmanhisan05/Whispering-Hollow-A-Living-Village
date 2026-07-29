/**
 * Procedural cottages.
 *
 * Each house is assembled from a small kit of parts — walls, a roof, a chimney,
 * a door, windows, and optional lean-tos, porches and flower boxes — combined
 * by a seeded random. Nine houses from one generator, all clearly from the same
 * village but none identical.
 *
 * The windows are the important part. They are separate emissive meshes whose
 * intensity is driven by time of day, so at dusk the whole village lights up
 * from inside, one warm rectangle at a time. That single effect does more for
 * the mood of the place than the geometry does.
 *
 * @module components/scene/Village/House
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RigidBody, CuboidCollider } from '@react-three/rapier';
import * as THREE from 'three';

import { useLighting } from '@/hooks/useTimeOfDay';
import { useGameStore } from '@/store/gameStore';
import { RandomSource } from '@/lib/utils/random';
import { mergeGeometries, transformGeometry } from '@/lib/geometry/merge';
import { plasterTexture, roofTexture, woodTexture, softSprite } from '@/lib/textures/procedural';
import { applySnowAccumulation } from '@/shaders/foliage.glsl';
import { SEASONS } from '@/config/game';
import { clamp } from '@/lib/utils/math';

export interface HouseProps {
  position: [number, number, number];
  rotation: number;
  /** Seeded per house so the same house is always the same shape. */
  seed: string;
  /** Index into the village, used for trinket placement. */
  index: number;
  /** Scale multiplier. */
  scale?: number;
}

/** Wall colour palette — limewashed plaster in muted period tones. */
const WALL_COLORS = [
  '#e8e0d0',
  '#dcd2bc',
  '#e0d8c4',
  '#d4c8b0',
  '#e8ddc8',
  '#c8bfa8',
  '#efe8d8',
];

/** Timber-frame and trim colours. */
const TIMBER_COLORS = ['#4a3728', '#5a4030', '#3e2e22', '#6a5040'];

/** The generated parts of one house, grouped by material. */
interface HouseGeometry {
  walls: THREE.BufferGeometry;
  roof: THREE.BufferGeometry;
  timber: THREE.BufferGeometry;
  /** Window panes, kept separate so they can be made emissive. */
  windows: THREE.BufferGeometry;
  /** Collider boxes: `[halfExtents, position]`. */
  colliders: Array<{ half: [number, number, number]; pos: [number, number, number] }>;
  /** Where a lantern hangs by the door. */
  lanternAnchor: [number, number, number];
  /** Windowsill positions where bought trinkets are displayed. */
  sills: Array<[number, number, number]>;
  /** Chimney top, for the smoke plume. */
  chimneyTop: [number, number, number];
  /** Whether this house has a windowsill wide enough for the cat. */
  catSill: [number, number, number] | null;
  wallColor: string;
  timberColor: string;
  thatched: boolean;
}

/**
 * Generates one house.
 *
 * The shape grammar is deliberately simple: a main box, a pitched roof, and
 * then a handful of optional additions. Complexity in the *layout* (which
 * additions, where, at what size) beats complexity in the individual parts —
 * an elaborate single building still reads as one repeated asset when you place
 * nine of them.
 */
function buildHouse(seed: string): HouseGeometry {
  const rng = new RandomSource(seed, 'house');

  const width = rng.range(4.2, 6.4);
  const depth = rng.range(3.8, 5.6);
  const wallHeight = rng.range(2.6, 3.6);
  const roofPitch = rng.range(0.85, 1.5);
  const thatched = rng.chance(0.35);
  const twoStorey = rng.chance(0.35);
  const storeyHeight = twoStorey ? wallHeight * 1.75 : wallHeight;

  const wallParts: THREE.BufferGeometry[] = [];
  const roofParts: THREE.BufferGeometry[] = [];
  const timberParts: THREE.BufferGeometry[] = [];
  const windowParts: THREE.BufferGeometry[] = [];
  const colliders: HouseGeometry['colliders'] = [];
  const sills: Array<[number, number, number]> = [];

  /* ── Main body ───────────────────────────────────────────────────────── */
  const body = new THREE.BoxGeometry(width, storeyHeight, depth);
  transformGeometry(body, { position: [0, storeyHeight / 2, 0] });
  wallParts.push(body);
  colliders.push({
    half: [width / 2, storeyHeight / 2, depth / 2],
    pos: [0, storeyHeight / 2, 0],
  });

  /* ── Roof ────────────────────────────────────────────────────────────────
   * A triangular prism built from two slabs. Rotating a box rather than
   * authoring a prism means the roof texture maps cleanly along the slope. */
  const roofOverhang = 0.42;
  const roofWidth = width + roofOverhang * 2;
  const roofDepth = depth + roofOverhang * 2;
  const roofHeight = (roofWidth / 2) * roofPitch;
  const slopeLength = Math.sqrt(Math.pow(roofWidth / 2, 2) + roofHeight * roofHeight);
  const slopeAngle = Math.atan2(roofHeight, roofWidth / 2);

  for (const side of [-1, 1]) {
    const slab = new THREE.BoxGeometry(slopeLength, 0.16, roofDepth);
    transformGeometry(slab, {
      position: [(side * roofWidth) / 4, storeyHeight + roofHeight / 2, 0],
      rotation: [0, 0, -side * slopeAngle],
    });
    roofParts.push(slab);
  }

  // Gable end triangles, so the roof isn't hollow when seen from the side.
  for (const side of [-1, 1]) {
    const gable = new THREE.BufferGeometry();
    const hw = width / 2;
    const verts = new Float32Array([
      -hw, storeyHeight, 0,
      hw, storeyHeight, 0,
      0, storeyHeight + roofHeight, 0,
    ]);
    gable.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    gable.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0.5, 1]), 2));
    gable.computeVertexNormals();
    transformGeometry(gable, { position: [0, 0, (side * depth) / 2] });
    wallParts.push(gable);
  }

  colliders.push({
    half: [roofWidth / 2, roofHeight / 2, roofDepth / 2],
    pos: [0, storeyHeight + roofHeight / 2, 0],
  });

  /* ── Chimney ─────────────────────────────────────────────────────────── */
  const chimneyX = rng.range(-width * 0.3, width * 0.3);
  const chimneyHeight = storeyHeight + roofHeight + rng.range(0.6, 1.4);
  const chimney = new THREE.BoxGeometry(0.62, chimneyHeight, 0.62);
  transformGeometry(chimney, { position: [chimneyX, chimneyHeight / 2, depth * 0.2] });
  wallParts.push(chimney);
  // Chimney pot.
  const pot = new THREE.CylinderGeometry(0.16, 0.19, 0.34, 8);
  transformGeometry(pot, { position: [chimneyX, chimneyHeight + 0.17, depth * 0.2] });
  roofParts.push(pot);

  /* ── Door ────────────────────────────────────────────────────────────── */
  const doorWidth = 0.95;
  const doorHeight = 2.05;
  const door = new THREE.BoxGeometry(doorWidth, doorHeight, 0.12);
  transformGeometry(door, { position: [0, doorHeight / 2, depth / 2 + 0.04] });
  timberParts.push(door);

  // Door frame.
  for (const side of [-1, 1]) {
    const jamb = new THREE.BoxGeometry(0.13, doorHeight + 0.16, 0.16);
    transformGeometry(jamb, {
      position: [(side * (doorWidth + 0.13)) / 2, (doorHeight + 0.16) / 2, depth / 2 + 0.05],
    });
    timberParts.push(jamb);
  }
  const lintel = new THREE.BoxGeometry(doorWidth + 0.34, 0.15, 0.2);
  transformGeometry(lintel, { position: [0, doorHeight + 0.08, depth / 2 + 0.06] });
  timberParts.push(lintel);

  /* ── Windows ─────────────────────────────────────────────────────────── */
  const addWindow = (x: number, y: number, z: number, rotY: number, w = 0.78, h = 0.92) => {
    // The lit pane.
    const pane = new THREE.PlaneGeometry(w, h);
    transformGeometry(pane, { position: [x, y, z], rotation: [0, rotY, 0] });
    windowParts.push(pane);

    // Frame and mullions.
    const frameThickness = 0.09;
    const frameH = new THREE.BoxGeometry(w + frameThickness * 2, frameThickness, 0.1);
    const frameV = new THREE.BoxGeometry(frameThickness, h + frameThickness * 2, 0.1);
    for (const dy of [-h / 2 - frameThickness / 2, h / 2 + frameThickness / 2]) {
      const g = frameH.clone();
      transformGeometry(g, { position: [x, y + dy, z], rotation: [0, rotY, 0] });
      timberParts.push(g);
    }
    for (const dx of [-w / 2 - frameThickness / 2, w / 2 + frameThickness / 2]) {
      const g = frameV.clone();
      const offset = new THREE.Vector3(dx, 0, 0).applyAxisAngle(_up, rotY);
      transformGeometry(g, { position: [x + offset.x, y, z + offset.z], rotation: [0, rotY, 0] });
      timberParts.push(g);
    }
    // Central mullion — the cross that makes it read as a cottage window.
    const mullion = new THREE.BoxGeometry(0.05, h, 0.09);
    transformGeometry(mullion, { position: [x, y, z], rotation: [0, rotY, 0] });
    timberParts.push(mullion);
    const transom = new THREE.BoxGeometry(w, 0.05, 0.09);
    transformGeometry(transom, { position: [x, y, z], rotation: [0, rotY, 0] });
    timberParts.push(transom);

    frameH.dispose();
    frameV.dispose();

    // A sill wide enough to stand a trinket on.
    const sill = new THREE.BoxGeometry(w + 0.3, 0.09, 0.26);
    const sillY = y - h / 2 - 0.06;
    transformGeometry(sill, { position: [x, sillY, z], rotation: [0, rotY, 0] });
    timberParts.push(sill);
    sills.push([x, sillY + 0.1, z]);
  };

  // Front windows either side of the door.
  addWindow(-width * 0.3, storeyHeight * 0.55, depth / 2 + 0.03, 0);
  addWindow(width * 0.3, storeyHeight * 0.55, depth / 2 + 0.03, 0);

  // Side windows.
  addWindow(width / 2 + 0.03, storeyHeight * 0.55, 0, Math.PI / 2);
  if (rng.chance(0.7)) addWindow(-width / 2 - 0.03, storeyHeight * 0.55, 0, -Math.PI / 2);

  // Upper-storey windows.
  if (twoStorey) {
    addWindow(-width * 0.24, storeyHeight * 0.82, depth / 2 + 0.03, 0, 0.62, 0.72);
    addWindow(width * 0.24, storeyHeight * 0.82, depth / 2 + 0.03, 0, 0.62, 0.72);
  }

  // A dormer in the roof, sometimes.
  if (rng.chance(0.32)) {
    const dormerW = 1.1;
    const dormerH = 0.95;
    const dormerBox = new THREE.BoxGeometry(dormerW, dormerH, 1.0);
    const dormerY = storeyHeight + roofHeight * 0.42;
    transformGeometry(dormerBox, { position: [0, dormerY, depth * 0.22] });
    wallParts.push(dormerBox);
    const dormerRoof = new THREE.BoxGeometry(dormerW + 0.25, 0.12, 1.15);
    transformGeometry(dormerRoof, { position: [0, dormerY + dormerH / 2, depth * 0.22] });
    roofParts.push(dormerRoof);
    addWindow(0, dormerY, depth * 0.22 + 0.51, 0, 0.62, 0.62);
  }

  /* ── Optional lean-to ────────────────────────────────────────────────── */
  if (rng.chance(0.42)) {
    const leanW = rng.range(1.6, 2.4);
    const leanH = wallHeight * 0.68;
    const leanD = depth * 0.7;
    const side = rng.chance(0.5) ? 1 : -1;
    const leanX = (side * (width + leanW)) / 2;

    const lean = new THREE.BoxGeometry(leanW, leanH, leanD);
    transformGeometry(lean, { position: [leanX, leanH / 2, 0] });
    wallParts.push(lean);
    colliders.push({ half: [leanW / 2, leanH / 2, leanD / 2], pos: [leanX, leanH / 2, 0] });

    // A single-pitch roof sloping away from the main wall.
    const leanRoof = new THREE.BoxGeometry(leanW + 0.3, 0.12, leanD + 0.3);
    transformGeometry(leanRoof, {
      position: [leanX, leanH + 0.2, 0],
      rotation: [0, 0, -side * 0.32],
    });
    roofParts.push(leanRoof);
  }

  /* ── Timber framing ──────────────────────────────────────────────────────
   * Exposed beams on the front elevation. Purely decorative, but it is what
   * makes the houses read as *old*. */
  if (rng.chance(0.55)) {
    const beamCount = 3 + rng.int(0, 2);
    for (let i = 0; i < beamCount; i++) {
      const x = -width / 2 + ((i + 0.5) / beamCount) * width;
      const beam = new THREE.BoxGeometry(0.14, storeyHeight, 0.08);
      transformGeometry(beam, { position: [x, storeyHeight / 2, depth / 2 + 0.02] });
      timberParts.push(beam);
    }
    // A horizontal rail.
    const rail = new THREE.BoxGeometry(width, 0.14, 0.08);
    transformGeometry(rail, { position: [0, storeyHeight * 0.62, depth / 2 + 0.02] });
    timberParts.push(rail);
  }

  /* ── Flower box ──────────────────────────────────────────────────────── */
  if (rng.chance(0.5) && sills.length > 0) {
    const sill = sills[0]!;
    const box = new THREE.BoxGeometry(0.85, 0.22, 0.24);
    transformGeometry(box, { position: [sill[0], sill[1] - 0.02, sill[2] + 0.06] });
    timberParts.push(box);
  }

  const catSill = rng.chance(0.28) && sills.length > 0 ? sills[sills.length - 1]! : null;

  return {
    walls: mergeGeometries(wallParts, true),
    roof: mergeGeometries(roofParts, true),
    timber: mergeGeometries(timberParts, true),
    windows: mergeGeometries(windowParts, true),
    colliders,
    lanternAnchor: [doorWidth * 0.9, doorHeight + 0.3, depth / 2 + 0.22],
    sills,
    chimneyTop: [chimneyX, chimneyHeight + 0.35, depth * 0.2],
    catSill,
    wallColor: rng.pick(WALL_COLORS),
    timberColor: rng.pick(TIMBER_COLORS),
    thatched,
  };
}

const _up = new THREE.Vector3(0, 1, 0);

export function House({ position, rotation, seed, index, scale = 1 }: HouseProps) {
  const lighting = useLighting();
  const season = useGameStore((s) => s.season);
  const trinkets = useGameStore((s) => s.progress.trinkets);

  const geo = useMemo(() => buildHouse(seed), [seed]);
  const snowUniform = useRef({ value: 0 });

  const materials = useMemo(() => {
    const wallColor = new THREE.Color(geo.wallColor);
    const wall = new THREE.MeshStandardMaterial({
      map: plasterTexture(256, [wallColor.r, wallColor.g, wallColor.b]),
      roughness: 0.94,
      metalness: 0,
    });
    const roof = new THREE.MeshStandardMaterial({
      map: roofTexture(256, geo.thatched),
      roughness: geo.thatched ? 0.98 : 0.82,
      metalness: 0,
    });
    const timberColor = new THREE.Color(geo.timberColor);
    const timber = new THREE.MeshStandardMaterial({
      map: woodTexture(256, [timberColor.r, timberColor.g, timberColor.b]),
      roughness: 0.9,
      metalness: 0,
    });
    /* Windows are emissive so they *are* a light source for bloom, rather than
     * merely being a bright colour. The intensity is animated below. */
    const window = new THREE.MeshStandardMaterial({
      color: '#2a2a2e',
      emissive: new THREE.Color('#ffb45a'),
      emissiveIntensity: 0,
      roughness: 0.28,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });

    applySnowAccumulation(wall, snowUniform.current);
    applySnowAccumulation(roof, snowUniform.current);
    applySnowAccumulation(timber, snowUniform.current);

    return { wall, roof, timber, window };
  }, [geo]);

  useEffect(
    () => () => {
      geo.walls.dispose();
      geo.roof.dispose();
      geo.timber.dispose();
      geo.windows.dispose();
      Object.values(materials).forEach((m) => m.dispose());
    },
    [geo, materials],
  );

  const lightRef = useRef<THREE.PointLight>(null);

  useFrame((_, dt) => {
    snowUniform.current.value +=
      (SEASONS[season].snowCoverage - snowUniform.current.value) * Math.min(dt, 0.08);

    /* Windows light up at dusk. Each house is offset slightly by its index, so
     * they don't all switch on in the same frame — the village comes to life
     * one window at a time, which is a far nicer moment. */
    const offset = (index % 5) * 0.006;
    const lit = clamp(lighting.lampIntensity - offset, 0, 1);
    materials.window.emissiveIntensity = lit * 2.4;

    // A matching interior spill light, only when actually lit, and only nearby.
    if (lightRef.current) {
      lightRef.current.intensity = lit * 2.6;
      lightRef.current.visible = lit > 0.03;
    }
  });

  /* Trinkets the player has bought and placed on this house's windowsills. */
  const myTrinkets = useMemo(
    () => trinkets.filter((t) => t.houseIndex === index),
    [trinkets, index],
  );

  return (
    <group position={position} rotation={[0, rotation, 0]} scale={scale} name={`house-${index}`}>
      <mesh geometry={geo.walls} material={materials.wall} castShadow receiveShadow />
      <mesh geometry={geo.roof} material={materials.roof} castShadow receiveShadow />
      <mesh geometry={geo.timber} material={materials.timber} castShadow receiveShadow />
      <mesh geometry={geo.windows} material={materials.window} />

      <pointLight
        ref={lightRef}
        position={[0, 2.2, 0]}
        color="#ffb45a"
        intensity={0}
        distance={9}
        decay={2}
      />

      <RigidBody type="fixed" colliders={false}>
        {geo.colliders.map((c, i) => (
          <CuboidCollider key={i} args={c.half} position={c.pos} />
        ))}
      </RigidBody>

      <ChimneySmoke position={geo.chimneyTop} />

      {myTrinkets.map((t, i) => {
        const sill = geo.sills[i % Math.max(geo.sills.length, 1)];
        if (!sill) return null;
        return <Trinket key={t.id} kind={t.kind} position={sill} />;
      })}
    </group>
  );
}

/**
 * Chimney smoke.
 *
 * Rises faster and further in cold weather — warm air in cold air has more
 * buoyancy, so a winter plume goes straight up and a summer one barely lifts.
 * A small physical detail that makes the season legible from a distance.
 */
function ChimneySmoke({ position }: { position: [number, number, number] }) {
  const season = useGameStore((s) => s.season);
  const lighting = useLighting();
  const count = 14;

  const { geometry, material, state } = useMemo(() => {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: softSprite(128, 1.6),
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      color: '#d8d4cc',
      fog: true,
    });
    const s = {
      age: new Float32Array(count),
      drift: new Float32Array(count * 2),
    };
    for (let i = 0; i < count; i++) {
      s.age[i] = (i / count) * 4;
      s.drift[i * 2] = (Math.random() - 0.5) * 0.4;
      s.drift[i * 2 + 1] = (Math.random() - 0.5) * 0.4;
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

  useFrame((_, dt) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    // Fires burn at night and in winter; almost never on a summer afternoon.
    const cold = season === 'winter' ? 1 : season === 'autumn' ? 0.6 : 0.15;
    const activity = clamp(cold * 0.6 + lighting.lampIntensity * 0.6, 0, 1);
    material.opacity = activity * 0.32;
    if (activity < 0.05) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;

    const rise = season === 'winter' ? 1.6 : 0.9;
    const lifetime = 4;

    for (let i = 0; i < count; i++) {
      state.age[i]! += dt;
      if (state.age[i]! > lifetime) state.age[i]! -= lifetime;
      const a = state.age[i]! / lifetime;

      _smokePos.set(
        position[0] + state.drift[i * 2]! * a * 3.2,
        position[1] + a * rise * 4.5,
        position[2] + state.drift[i * 2 + 1]! * a * 3.2,
      );
      // Puffs expand as they rise and cool.
      const size = 0.35 + a * 2.4;
      _smokeScale.set(size, size, size);
      _smokeMat.compose(_smokePos, _smokeQuat, _smokeScale);
      mesh.setMatrixAt(i, _smokeMat);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, count]}
      frustumCulled={false}
      renderOrder={5}
    />
  );
}

const _smokePos = new THREE.Vector3();
const _smokeScale = new THREE.Vector3();
const _smokeQuat = new THREE.Quaternion();
const _smokeMat = new THREE.Matrix4();

/** A trinket bought from a stall and placed on a windowsill. */
function Trinket({
  kind,
  position,
}: {
  kind: string;
  position: [number, number, number];
}) {
  const ref = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    // The pinwheel spins; everything else sits still.
    if (kind === 'pinwheel' && ref.current) {
      ref.current.rotation.z = clock.elapsedTime * 2.4;
    }
  });

  return (
    <group ref={ref} position={position} scale={0.42}>
      {kind === 'pinwheel' && (
        <>
          <mesh position={[0, 0.4, 0]}>
            <cylinderGeometry args={[0.02, 0.02, 0.8, 6]} />
            <meshStandardMaterial color="#8a6a4a" />
          </mesh>
          {[0, 1, 2, 3].map((i) => (
            <mesh key={i} position={[0, 0.8, 0]} rotation={[0, 0, (i * Math.PI) / 2]}>
              <planeGeometry args={[0.3, 0.14]} />
              <meshStandardMaterial
                color={['#e2593f', '#e8cf8a', '#6fbfae', '#8f80b8'][i]}
                side={THREE.DoubleSide}
              />
            </mesh>
          ))}
        </>
      )}
      {kind === 'birdhouse' && (
        <mesh position={[0, 0.25, 0]}>
          <boxGeometry args={[0.4, 0.5, 0.35]} />
          <meshStandardMaterial color="#8a6a4a" />
        </mesh>
      )}
      {kind === 'gnome' && (
        <>
          <mesh position={[0, 0.2, 0]}>
            <capsuleGeometry args={[0.14, 0.2, 4, 8]} />
            <meshStandardMaterial color="#4a6a8c" />
          </mesh>
          <mesh position={[0, 0.48, 0]}>
            <coneGeometry args={[0.15, 0.3, 8]} />
            <meshStandardMaterial color="#c04a3a" />
          </mesh>
        </>
      )}
      {kind === 'chime' && (
        <group>
          {[0, 1, 2, 3].map((i) => (
            <mesh key={i} position={[(i - 1.5) * 0.09, 0.3 - i * 0.05, 0]}>
              <cylinderGeometry args={[0.02, 0.02, 0.4 - i * 0.06, 6]} />
              <meshStandardMaterial color="#c8b078" metalness={0.7} roughness={0.35} />
            </mesh>
          ))}
        </group>
      )}
      {kind === 'sundial' && (
        <>
          <mesh position={[0, 0.05, 0]}>
            <cylinderGeometry args={[0.28, 0.3, 0.08, 12]} />
            <meshStandardMaterial color="#9a9488" roughness={0.85} />
          </mesh>
          <mesh position={[0, 0.2, 0]} rotation={[0.6, 0, 0]}>
            <boxGeometry args={[0.03, 0.28, 0.16]} />
            <meshStandardMaterial color="#8a7a52" metalness={0.5} />
          </mesh>
        </>
      )}
    </group>
  );
}
