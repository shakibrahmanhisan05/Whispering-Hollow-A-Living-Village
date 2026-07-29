/**
 * Village landmarks: the well, the windmill, the church and its bell.
 *
 * @module components/scene/Village/Landmarks
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RigidBody, CuboidCollider, CylinderCollider } from '@react-three/rapier';
import * as THREE from 'three';

import { useLighting } from '@/hooks/useTimeOfDay';
import { useWindField } from '@/hooks/useWind';
import { useGameStore } from '@/store/gameStore';
import {
  woodTexture,
  plasterTexture,
  roofTexture,
  rockTexture,
  clothTexture,
} from '@/lib/textures/procedural';
import { applySnowAccumulation } from '@/shaders/foliage.glsl';
import { mergeGeometries, transformGeometry } from '@/lib/geometry/merge';
import { RandomSource } from '@/lib/utils/random';
import { SEASONS } from '@/config/game';
import { clamp } from '@/lib/utils/math';

/* ───────────────────────────────────────────────────────────────────────────
 * THE WELL
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The village well.
 *
 * Where players leave bouquets, and the visual anchor of the plaza. The bucket
 * hangs from a rope on a winch and sways very gently — a small amount of idle
 * motion is what stops a static prop from reading as scenery.
 */
export function Well({ position }: { position: [number, number, number] }) {
  const flowers = useGameStore((s) => s.progress.discoveries['well-bouquet']);
  const bucketRef = useRef<THREE.Group>(null);
  const wind = useWindField();

  const { stone, timber, materials } = useMemo(() => {
    const stoneParts: THREE.BufferGeometry[] = [];
    const timberParts: THREE.BufferGeometry[] = [];
    const rng = new RandomSource('well', 'geometry');

    /* Circular wall of individually-placed stones. Building it from real blocks
     * rather than a textured cylinder means the silhouette is irregular, which
     * is most of what makes dry-stone masonry look like masonry. */
    const radius = 1.15;
    const courses = 4;
    for (let c = 0; c < courses; c++) {
      const y = 0.12 + c * 0.21;
      const stonesInCourse = 14;
      // Offset alternate courses so the joints don't line up vertically.
      const phase = (c % 2) * (Math.PI / stonesInCourse);
      for (let i = 0; i < stonesInCourse; i++) {
        const a = phase + (i / stonesInCourse) * Math.PI * 2;
        const block = new THREE.BoxGeometry(
          rng.range(0.3, 0.44),
          rng.range(0.16, 0.22),
          rng.range(0.24, 0.34),
        );
        transformGeometry(block, {
          position: [Math.cos(a) * radius, y, Math.sin(a) * radius],
          rotation: [rng.gaussian(0, 0.05), -a, rng.gaussian(0, 0.05)],
        });
        stoneParts.push(block);
      }
    }

    // Coping stones around the rim.
    const cope = new THREE.CylinderGeometry(radius + 0.14, radius + 0.14, 0.12, 20);
    transformGeometry(cope, { position: [0, 1.0, 0] });
    stoneParts.push(cope);

    // Two uprights and a ridge beam for the roof.
    for (const side of [-1, 1]) {
      const post = new THREE.BoxGeometry(0.14, 1.9, 0.14);
      transformGeometry(post, { position: [side * (radius - 0.1), 1.9, 0] });
      timberParts.push(post);
    }
    const beam = new THREE.CylinderGeometry(0.07, 0.07, radius * 2.1, 8);
    transformGeometry(beam, { position: [0, 2.7, 0], rotation: [0, 0, Math.PI / 2] });
    timberParts.push(beam);

    // Winch drum and handle.
    const drum = new THREE.CylinderGeometry(0.13, 0.13, radius * 1.6, 10);
    transformGeometry(drum, { position: [0, 2.3, 0], rotation: [0, 0, Math.PI / 2] });
    timberParts.push(drum);
    const handle = new THREE.BoxGeometry(0.05, 0.32, 0.05);
    transformGeometry(handle, { position: [radius * 0.9, 2.42, 0.14] });
    timberParts.push(handle);

    // Pitched roof over the top.
    for (const side of [-1, 1]) {
      const slab = new THREE.BoxGeometry(1.45, 0.09, 2.4);
      transformGeometry(slab, {
        position: [side * 0.62, 2.98, 0],
        rotation: [0, 0, -side * 0.62],
      });
      timberParts.push(slab);
    }

    const stoneColor = new THREE.Color('#8a857a');
    const timberColor = new THREE.Color('#5a4030');
    const mats = {
      stone: new THREE.MeshStandardMaterial({
        map: rockTexture(512),
        color: stoneColor,
        roughness: 0.95,
      }),
      timber: new THREE.MeshStandardMaterial({
        map: woodTexture(256, [timberColor.r, timberColor.g, timberColor.b]),
        roughness: 0.9,
      }),
    };

    return {
      stone: mergeGeometries(stoneParts, true),
      timber: mergeGeometries(timberParts, true),
      materials: mats,
    };
  }, []);

  useEffect(
    () => () => {
      stone.dispose();
      timber.dispose();
      Object.values(materials).forEach((m) => m.dispose());
    },
    [stone, timber, materials],
  );

  useFrame(({ clock }) => {
    // The bucket swings a little on its rope, more in strong wind.
    if (bucketRef.current) {
      const t = clock.elapsedTime;
      const amp = 0.03 + wind.strength * 0.05;
      bucketRef.current.rotation.z = Math.sin(t * 1.3) * amp;
      bucketRef.current.rotation.x = Math.sin(t * 0.9 + 1.1) * amp * 0.6;
    }
  });

  return (
    <group position={position} name="well">
      <mesh geometry={stone} material={materials.stone} castShadow receiveShadow />
      <mesh geometry={timber} material={materials.timber} castShadow receiveShadow />

      {/* Dark water at the bottom of the shaft. */}
      <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.05, 20]} />
        <meshStandardMaterial color="#0d1a1e" roughness={0.15} metalness={0.35} />
      </mesh>

      {/* Rope and bucket. */}
      <group ref={bucketRef} position={[0, 2.3, 0]}>
        <mesh position={[0, -0.55, 0]}>
          <cylinderGeometry args={[0.014, 0.014, 1.1, 5]} />
          <meshStandardMaterial color="#a89878" roughness={1} />
        </mesh>
        <mesh position={[0, -1.22, 0]} castShadow>
          <cylinderGeometry args={[0.18, 0.15, 0.26, 10]} />
          <meshStandardMaterial color="#6a5038" roughness={0.88} />
        </mesh>
      </group>

      {/* A bouquet, once the player has left one. */}
      {flowers && <Bouquet position={[0.7, 1.07, 0.35]} />}

      <RigidBody type="fixed" colliders={false}>
        <CylinderCollider args={[0.55, 1.3]} position={[0, 0.55, 0]} />
      </RigidBody>
    </group>
  );
}

/** A small bunch of flowers, placed on the well or a grave. */
export function Bouquet({ position }: { position: [number, number, number] }) {
  const stems = 7;
  return (
    <group position={position} name="bouquet">
      {Array.from({ length: stems }, (_, i) => {
        const a = (i / stems) * Math.PI * 2;
        const lean = 0.16;
        const colors = ['#e2593f', '#e8cf8a', '#d47fb8', '#8f80b8', '#f2f0e6'];
        return (
          <group key={i} rotation={[Math.cos(a) * lean, 0, Math.sin(a) * lean]}>
            <mesh position={[0, 0.11, 0]}>
              <cylinderGeometry args={[0.008, 0.01, 0.22, 4]} />
              <meshStandardMaterial color="#4a7a38" />
            </mesh>
            <mesh position={[0, 0.24, 0]}>
              <sphereGeometry args={[0.045, 6, 5]} />
              <meshStandardMaterial
                color={colors[i % colors.length]}
                emissive={colors[i % colors.length]}
                emissiveIntensity={0.12}
              />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * THE WINDMILL
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The windmill.
 *
 * Its sails turn at a speed derived from the wind field, and the **cap rotates
 * to face into the wind** — which is what a real post mill does, and is
 * genuinely striking to notice happening on its own while you watch the
 * wheatfield.
 *
 * The creaking audio is driven from the same rotation phase, in
 * `AmbienceSystem`.
 */
export function Windmill({ position }: { position: [number, number, number] }) {
  const wind = useWindField();
  const season = useGameStore((s) => s.season);
  const sailsRef = useRef<THREE.Group>(null);
  const capRef = useRef<THREE.Group>(null);
  const rotation = useRef(0);
  const capYaw = useRef(0);
  const snowUniform = useRef({ value: 0 });

  const { tower, cap, sails, materials } = useMemo(() => {
    const towerParts: THREE.BufferGeometry[] = [];
    const capParts: THREE.BufferGeometry[] = [];
    const sailParts: THREE.BufferGeometry[] = [];

    // Tapered stone tower.
    const towerHeight = 11;
    const body = new THREE.CylinderGeometry(2.1, 3.1, towerHeight, 16, 3);
    transformGeometry(body, { position: [0, towerHeight / 2, 0] });
    towerParts.push(body);

    // Door and window openings, as recessed boxes.
    const door = new THREE.BoxGeometry(1.1, 2.1, 0.4);
    transformGeometry(door, { position: [0, 1.05, 3.0] });
    towerParts.push(door);

    // A gallery walkway partway up.
    const gallery = new THREE.CylinderGeometry(3.0, 3.0, 0.14, 20);
    transformGeometry(gallery, { position: [0, towerHeight * 0.45, 0] });
    towerParts.push(gallery);
    const rail = new THREE.TorusGeometry(2.95, 0.05, 6, 24);
    transformGeometry(rail, { position: [0, towerHeight * 0.45 + 0.85, 0], rotation: [Math.PI / 2, 0, 0] });
    towerParts.push(rail);

    // Conical cap.
    const capCone = new THREE.ConeGeometry(2.35, 2.2, 16);
    transformGeometry(capCone, { position: [0, 1.1, 0] });
    capParts.push(capCone);
    // Windshaft protruding from the front.
    const shaft = new THREE.CylinderGeometry(0.22, 0.22, 2.2, 10);
    transformGeometry(shaft, { position: [0, 0.6, 1.5], rotation: [Math.PI / 2 - 0.16, 0, 0] });
    capParts.push(shaft);
    // Fantail — the little rotor at the back that turns the cap into the wind.
    const fantailPost = new THREE.BoxGeometry(0.12, 0.12, 1.6);
    transformGeometry(fantailPost, { position: [0, 1.3, -1.5] });
    capParts.push(fantailPost);

    /* Four sails, each a lattice frame. A solid quad would read as a fan blade;
     * the lattice is what makes it a *mill* sail. */
    for (let s = 0; s < 4; s++) {
      const angle = (s / 4) * Math.PI * 2;
      const length = 7.2;
      const width = 1.15;

      // Main spar.
      const spar = new THREE.BoxGeometry(0.13, length, 0.13);
      transformGeometry(spar, {
        position: [Math.cos(angle) * (length / 2), Math.sin(angle) * (length / 2), 0],
        rotation: [0, 0, angle - Math.PI / 2],
      });
      sailParts.push(spar);

      // Cross-slats along the spar.
      const slats = 9;
      for (let i = 1; i <= slats; i++) {
        const t = i / (slats + 1);
        const dist = t * length;
        // Slats get shorter toward the tip, giving the sail its taper.
        const slatWidth = width * (1 - t * 0.35);
        const slat = new THREE.BoxGeometry(slatWidth, 0.07, 0.06);
        transformGeometry(slat, {
          position: [Math.cos(angle) * dist, Math.sin(angle) * dist, 0],
          rotation: [0, 0, angle],
        });
        sailParts.push(slat);
      }

      // The canvas panel on the trailing half.
      const canvas = new THREE.PlaneGeometry(width * 0.8, length * 0.72);
      transformGeometry(canvas, {
        position: [
          Math.cos(angle) * (length * 0.55) - Math.sin(angle) * (width * 0.3),
          Math.sin(angle) * (length * 0.55) + Math.cos(angle) * (width * 0.3),
          0.04,
        ],
        rotation: [0, 0, angle - Math.PI / 2],
      });
      sailParts.push(canvas);
    }

    const stoneColor = new THREE.Color('#cfc4ae');
    const mats = {
      tower: new THREE.MeshStandardMaterial({
        map: plasterTexture(256, [stoneColor.r, stoneColor.g, stoneColor.b]),
        roughness: 0.94,
      }),
      cap: new THREE.MeshStandardMaterial({ map: roofTexture(256, false), roughness: 0.86 }),
      sail: new THREE.MeshStandardMaterial({
        map: woodTexture(256, [0.5, 0.4, 0.28]),
        roughness: 0.9,
        side: THREE.DoubleSide,
      }),
    };
    applySnowAccumulation(mats.tower, { value: 0 });

    return {
      tower: mergeGeometries(towerParts, true),
      cap: mergeGeometries(capParts, true),
      sails: mergeGeometries(sailParts, true),
      materials: mats,
    };
  }, []);

  useEffect(
    () => () => {
      tower.dispose();
      cap.dispose();
      sails.dispose();
      Object.values(materials).forEach((m) => m.dispose());
    },
    [tower, cap, sails, materials],
  );

  useFrame((_, dt) => {
    snowUniform.current.value +=
      (SEASONS[season].snowCoverage - snowUniform.current.value) * Math.min(dt, 0.08);

    /* Sail speed. A real mill's sails turn at roughly 10–20 rpm in a working
     * breeze, so the wind strength maps to about 0.6–1.6 rad/s. The offset
     * means they never stop dead even in a lull, which would look broken. */
    const speed = 0.22 + wind.strength * 1.15;
    rotation.current += speed * dt;
    if (sailsRef.current) sailsRef.current.rotation.z = rotation.current;

    /* The cap turns to face the wind — slowly, because it is a large heavy
     * structure being turned by a small fantail. The 6-second half-life is
     * what makes it read as *massive*. */
    const targetYaw = -wind.direction + Math.PI / 2;
    const delta = ((targetYaw - capYaw.current + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    capYaw.current += delta * Math.min(dt / 6, 0.1);
    if (capRef.current) capRef.current.rotation.y = capYaw.current;
  });

  const towerHeight = 11;

  return (
    <group position={position} name="windmill">
      <mesh geometry={tower} material={materials.tower} castShadow receiveShadow />

      <group ref={capRef} position={[0, towerHeight, 0]}>
        <mesh geometry={cap} material={materials.cap} castShadow />
        <group ref={sailsRef} position={[0, 0.6, 2.6]}>
          <mesh geometry={sails} material={materials.sail} castShadow />
        </group>
      </group>

      <RigidBody type="fixed" colliders={false}>
        <CylinderCollider args={[towerHeight / 2, 2.8]} position={[0, towerHeight / 2, 0]} />
      </RigidBody>
    </group>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * THE CHURCH
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The church and its bell tower.
 *
 * Ringing the bell (F, in the tower) scatters every bird on the map — the one
 * interaction with a world-wide consequence.
 */
export function Church({
  position,
  rotation = 0,
  bellSwing,
}: {
  position: [number, number, number];
  rotation?: number;
  /** 0..1 swing amount, driven by the interaction system. */
  bellSwing: React.RefObject<number>;
}) {
  const lighting = useLighting();
  const season = useGameStore((s) => s.season);
  const bellRef = useRef<THREE.Group>(null);
  const snowUniform = useRef({ value: 0 });


  const { walls, roof, timber, windows, materials } = useMemo(() => {
    const wallParts: THREE.BufferGeometry[] = [];
    const roofParts: THREE.BufferGeometry[] = [];
    const timberParts: THREE.BufferGeometry[] = [];
    const windowParts: THREE.BufferGeometry[] = [];

    const navW = 7;
    const navD = 13;
    const navH = 5.2;

    // Nave.
    const nave = new THREE.BoxGeometry(navW, navH, navD);
    transformGeometry(nave, { position: [0, navH / 2, 0] });
    wallParts.push(nave);

    // Pitched roof.
    const roofH = 3.2;
    const slope = Math.atan2(roofH, navW / 2);
    const slopeLen = Math.hypot(navW / 2, roofH);
    for (const side of [-1, 1]) {
      const slab = new THREE.BoxGeometry(slopeLen, 0.2, navD + 0.6);
      transformGeometry(slab, {
        position: [(side * navW) / 4, navH + roofH / 2, 0],
        rotation: [0, 0, -side * slope],
      });
      roofParts.push(slab);
    }

    // Bell tower.
    const towerW = 3.4;
    const towerH = 11.5;
    const tower = new THREE.BoxGeometry(towerW, towerH, towerW);
    transformGeometry(tower, { position: [0, towerH / 2, -navD / 2 - towerW / 2 + 0.5] });
    wallParts.push(tower);

    // Belfry openings — tall arched voids on all four faces.
    const belfryY = towerH - 2.2;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const opening = new THREE.BoxGeometry(1.3, 2.0, 0.3);
      transformGeometry(opening, {
        position: [
          Math.sin(a) * (towerW / 2),
          belfryY,
          -navD / 2 - towerW / 2 + 0.5 + Math.cos(a) * (towerW / 2),
        ],
        rotation: [0, a, 0],
      });
      // Dark interior behind the opening.
      timberParts.push(opening);
    }

    // Spire.
    const spire = new THREE.ConeGeometry(towerW * 0.78, 5.2, 4);
    transformGeometry(spire, {
      position: [0, towerH + 2.6, -navD / 2 - towerW / 2 + 0.5],
      rotation: [0, Math.PI / 4, 0],
    });
    roofParts.push(spire);

    // Weather vane.
    const vanePost = new THREE.CylinderGeometry(0.04, 0.04, 1.2, 6);
    transformGeometry(vanePost, { position: [0, towerH + 5.6, -navD / 2 - towerW / 2 + 0.5] });
    timberParts.push(vanePost);

    // Arched windows down the nave.
    for (let i = -2; i <= 2; i++) {
      if (i === 0) continue;
      for (const side of [-1, 1]) {
        const w = new THREE.PlaneGeometry(0.85, 2.2);
        transformGeometry(w, {
          position: [(side * navW) / 2 + side * 0.03, navH * 0.55, i * 2.4],
          rotation: [0, (side * Math.PI) / 2, 0],
        });
        windowParts.push(w);
      }
    }

    // Rose window over the door.
    const rose = new THREE.CircleGeometry(1.05, 16);
    transformGeometry(rose, { position: [0, navH * 0.72, navD / 2 + 0.03] });
    windowParts.push(rose);

    // Door.
    const door = new THREE.BoxGeometry(1.6, 2.8, 0.16);
    transformGeometry(door, { position: [0, 1.4, navD / 2 + 0.06] });
    timberParts.push(door);

    const stoneColor = new THREE.Color('#c8c0ae');
    const timberColor = new THREE.Color('#3e2e22');
    const mats = {
      wall: new THREE.MeshStandardMaterial({
        map: plasterTexture(256, [stoneColor.r, stoneColor.g, stoneColor.b]),
        roughness: 0.95,
      }),
      roof: new THREE.MeshStandardMaterial({ map: roofTexture(256, false), roughness: 0.85 }),
      timber: new THREE.MeshStandardMaterial({
        map: woodTexture(256, [timberColor.r, timberColor.g, timberColor.b]),
        roughness: 0.9,
      }),
      /* Stained glass. Emissive from *inside* at night, which is a lovely
       * detail — the church is the last building still lit. */
      window: new THREE.MeshStandardMaterial({
        color: '#3a2c48',
        emissive: new THREE.Color('#c88a4a'),
        emissiveIntensity: 0,
        roughness: 0.25,
        metalness: 0.15,
        side: THREE.DoubleSide,
      }),
    };
    applySnowAccumulation(mats.wall, { value: 0 });
    applySnowAccumulation(mats.roof, { value: 0 });

    return {
      walls: mergeGeometries(wallParts, true),
      roof: mergeGeometries(roofParts, true),
      timber: mergeGeometries(timberParts, true),
      windows: mergeGeometries(windowParts, true),
      materials: mats,
    };
  }, []);

  useEffect(
    () => () => {
      walls.dispose();
      roof.dispose();
      timber.dispose();
      windows.dispose();
      Object.values(materials).forEach((m) => m.dispose());
    },
    [walls, roof, timber, windows, materials],
  );

  useFrame((_, dt) => {
    snowUniform.current.value +=
      (SEASONS[season].snowCoverage - snowUniform.current.value) * Math.min(dt, 0.08);

    materials.window.emissiveIntensity = lighting.lampIntensity * 1.6;

    /* Bell swing. `bellSwing` is set to 1 by the interaction and decays; the
     * bell's angle is a damped sinusoid of it, so one pull produces several
     * decreasing swings rather than a single lurch. */
    if (bellRef.current && bellSwing.current !== null) {
      const amp = bellSwing.current;
      bellRef.current.rotation.z = Math.sin(performance.now() * 0.004) * amp * 0.55;
      bellSwing.current = Math.max(0, bellSwing.current - dt * 0.14);
    }
  });

  const navD = 13;
  const towerW = 3.4;
  const towerH = 11.5;

  return (
    <group position={position} rotation={[0, rotation, 0]} name="church">
      <mesh geometry={walls} material={materials.wall} castShadow receiveShadow />
      <mesh geometry={roof} material={materials.roof} castShadow receiveShadow />
      <mesh geometry={timber} material={materials.timber} castShadow receiveShadow />
      <mesh geometry={windows} material={materials.window} />

      {/* The bell itself, hanging in the belfry. */}
      <group position={[0, towerH - 1.6, -navD / 2 - towerW / 2 + 0.5]}>
        <group ref={bellRef}>
          <mesh position={[0, -0.55, 0]} castShadow>
            {/* A truncated cone with a flared lip reads as a bell. */}
            <cylinderGeometry args={[0.28, 0.55, 0.85, 14, 1, true]} />
            <meshStandardMaterial
              color="#8a7038"
              metalness={0.85}
              roughness={0.32}
              side={THREE.DoubleSide}
            />
          </mesh>
          <mesh position={[0, -0.98, 0]}>
            <sphereGeometry args={[0.09, 8, 6]} />
            <meshStandardMaterial color="#5a4828" metalness={0.7} roughness={0.4} />
          </mesh>
        </group>
        {/* Headstock. */}
        <mesh>
          <boxGeometry args={[1.5, 0.16, 0.16]} />
          <meshStandardMaterial color="#4a3728" roughness={0.9} />
        </mesh>
      </group>

      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[3.5, 2.6, 6.5]} position={[0, 2.6, 0]} />
        <CuboidCollider
          args={[towerW / 2, towerH / 2, towerW / 2]}
          position={[0, towerH / 2, -navD / 2 - towerW / 2 + 0.5]}
        />
      </RigidBody>
    </group>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * MARKET STALLS
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * A market stall with a fluttering cloth awning.
 *
 * The awning is a subdivided plane deformed in `useFrame` by a travelling wave
 * driven by the wind field. Simulating actual cloth would be far more expensive
 * and, at this scale, indistinguishable — three sine terms with different
 * frequencies produce the same read.
 */
export function MarketStall({
  position,
  rotation,
  colorA,
  colorB,
  index,
}: {
  position: [number, number, number];
  rotation: number;
  colorA: string;
  colorB: string;
  index: number;
}) {
  const wind = useWindField();
  const awningRef = useRef<THREE.Mesh>(null);
  const basePositions = useRef<Float32Array | null>(null);

  const awningGeo = useMemo(() => {
    const geo = new THREE.PlaneGeometry(3.2, 2.2, 12, 8);
    geo.rotateX(-Math.PI / 2.6);
    basePositions.current = Float32Array.from(geo.attributes.position!.array as Float32Array);
    return geo;
  }, []);

  const clothMaterial = useMemo(() => {
    const a = new THREE.Color(colorA);
    const b = new THREE.Color(colorB);
    return new THREE.MeshStandardMaterial({
      map: clothTexture(256, [a.r, a.g, a.b], [b.r, b.g, b.b]),
      roughness: 0.92,
      side: THREE.DoubleSide,
    });
  }, [colorA, colorB]);

  useEffect(
    () => () => {
      awningGeo.dispose();
      clothMaterial.dispose();
    },
    [awningGeo, clothMaterial],
  );

  useFrame(({ clock }) => {
    const mesh = awningRef.current;
    const base = basePositions.current;
    if (!mesh || !base) return;

    const attr = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const t = clock.elapsedTime;
    const strength = clamp(wind.strength, 0, 2);

    for (let i = 0; i < attr.count; i++) {
      const x = base[i * 3]!;
      const y = base[i * 3 + 1]!;
      const z = base[i * 3 + 2]!;

      /* Cloth is fixed at the back edge and free at the front, so displacement
       * scales with distance from the anchor. Three waves at different
       * frequencies and directions give the irregular ripple of real fabric. */
      const freeEdge = clamp((y + 1.1) / 2.2, 0, 1);
      const wave =
        Math.sin(x * 2.1 + t * 3.4 + index) * 0.06 +
        Math.sin(y * 3.2 - t * 4.6 + index * 1.7) * 0.04 +
        Math.sin((x + y) * 1.4 + t * 2.1) * 0.03;

      attr.setXYZ(i, x, y, z + wave * freeEdge * strength * 1.6);
    }
    attr.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
  });

  return (
    <group position={position} rotation={[0, rotation, 0]} name={`stall-${index}`}>
      {/* Four posts. */}
      {[
        [-1.5, -1.0],
        [1.5, -1.0],
        [-1.5, 1.0],
        [1.5, 1.0],
      ].map(([x, z], i) => (
        <mesh key={i} position={[x!, 1.1, z!]} castShadow>
          <cylinderGeometry args={[0.06, 0.07, 2.2, 6]} />
          <meshStandardMaterial color="#6a5038" roughness={0.9} />
        </mesh>
      ))}

      {/* Counter. */}
      <mesh position={[0, 0.95, -0.85]} castShadow receiveShadow>
        <boxGeometry args={[3.1, 0.12, 0.85]} />
        <meshStandardMaterial color="#7a5c3c" roughness={0.88} />
      </mesh>

      {/* Awning. */}
      <mesh ref={awningRef} geometry={awningGeo} material={clothMaterial} position={[0, 2.3, 0.3]} castShadow />

      {/* Goods on the counter — crates and produce. */}
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[(i - 1) * 0.9, 1.16, -0.85]} castShadow>
          <boxGeometry args={[0.55, 0.3, 0.5]} />
          <meshStandardMaterial color={['#8a6a3c', '#7a5a34', '#96784a'][i]} roughness={0.9} />
        </mesh>
      ))}

      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[1.6, 0.6, 0.5]} position={[0, 0.6, -0.85]} />
      </RigidBody>
    </group>
  );
}
