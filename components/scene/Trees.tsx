/**
 * The forest.
 *
 * 420 trees across six species, each with three shape variations and three LOD
 * tiers, rendered as instanced meshes. Placement is blue-noise distributed,
 * slope-aware and zone-weighted, and every tree contributes a static collider.
 *
 * @module components/scene/Trees
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RigidBody, CylinderCollider } from '@react-three/rapier';
import * as THREE from 'three';

import { useWorld } from './TerrainContext';
import { useGameStore } from '@/store/gameStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  buildTree,
  speciesColors,
  isDeciduous,
  blossoms,
  TREE_SPECIES,
  type TreeSpecies,
  type TreeLod,
} from '@/lib/geometry/trees';
import { applyFoliageWind, applySnowAccumulation } from '@/shaders/foliage.glsl';
import { barkTexture } from '@/lib/textures/procedural';
import { RandomSource, blueNoise } from '@/lib/utils/random';
import { VEGETATION, ZONES, SEASONS, WORLD, SHADOW_CONFIG, QUALITY_PRESETS } from '@/config/game';
import { clamp, mixHex } from '@/lib/utils/math';
import { POND, RAIL_QUERY, ROAD_QUERY } from '@/lib/world/layout';

/** One placed tree. */
interface TreeInstance {
  x: number;
  z: number;
  y: number;
  species: TreeSpecies;
  variation: number;
  scale: number;
  rotation: number;
  /** Per-instance hue offset applied to the foliage colour. */
  hueShift: number;
  /** Trunk radius at this scale, for the collider. */
  radius: number;
  height: number;
}

/**
 * Species weighting per zone. This is what gives each part of the valley its
 * own character — pines on the ridge, willows at the water, cherry in the
 * village, oaks everywhere in between.
 */
const ZONE_SPECIES_WEIGHTS: Record<string, Partial<Record<TreeSpecies, number>>> = {
  VILLAGE_HEART: { oak: 2, cherry: 4, birch: 2 },
  MEADOW_FIELDS: { birch: 4, oak: 2, cherry: 1 },
  ANCIENT_GROVE: { oak: 6, willow: 1, deadTree: 2, pine: 1 },
  THE_RIDGE: { pine: 6, birch: 2, deadTree: 1 },
  RAIL_CORRIDOR: { birch: 3, pine: 2, oak: 2 },
  BROOK_AND_POND: { willow: 6, birch: 2, oak: 1 },
  WHEAT_AND_WINDMILL: { oak: 2, birch: 1, cherry: 1 },
  DEFAULT: { oak: 3, birch: 3, pine: 2, cherry: 1, willow: 1, deadTree: 0.5 },
};

/** Picks a species appropriate to a position, weighted by the nearest zone. */
function pickSpecies(x: number, z: number, rng: RandomSource): TreeSpecies {
  let bestZone = 'DEFAULT';
  let bestScore = -Infinity;

  for (const [id, zone] of Object.entries(ZONES)) {
    const d = Math.hypot(x - zone.center[0], z - zone.center[1]);
    // Score falls off with distance; the closest zone within range wins.
    const score = 1 - d / (zone.radius * 1.5);
    if (score > bestScore && score > 0) {
      bestScore = score;
      bestZone = id;
    }
  }

  const weights = ZONE_SPECIES_WEIGHTS[bestZone] ?? ZONE_SPECIES_WEIGHTS.DEFAULT!;
  const species = TREE_SPECIES.filter((s) => (weights[s] ?? 0) > 0);
  const w = species.map((s) => weights[s] ?? 0);
  return rng.weighted(species, w);
}

export function Trees() {
  const { terrain, windUniforms } = useWorld();
  const season = useGameStore((s) => s.season);
  const graphics = useSettingsStore((s) => s.graphics);


  const treeCount = useMemo(() => {
    const preset = graphics.preset === 'custom' ? 'high' : graphics.preset;
    return QUALITY_PRESETS[preset]?.treeCount ?? VEGETATION.TREE_COUNT;
  }, [graphics.preset]);

  const lodScale = graphics.treeLodDistance;
  const shadowsOn = SHADOW_CONFIG[graphics.shadows].enabled;

  /* ── Placement ───────────────────────────────────────────────────────────
   * Blue noise rather than pure random: uniformly random points clump, and
   * clumped trees read as a bug. Rejection tests keep trees off slopes, out of
   * the water, off the plaza, and clear of the railway and roads. */
  const instances = useMemo<TreeInstance[]>(() => {
    const rng = new RandomSource(terrain.seed, 'tree-placement');
    const margin = WORLD.HALF - 14;

    const accept = (x: number, z: number): boolean => {
      const h = terrain.heightAt(x, z);
      if (h < WORLD.WATER_LEVEL + 0.8) return false;
      if (terrain.slopeAt(x, z) > VEGETATION.MAX_TREE_SLOPE) return false;
      // Keep the plaza and the immediate village clear.
      if (Math.hypot(x, z) < 20) return false;
      // Nothing in the pond.
      if (Math.hypot(x - POND.center[0], z - POND.center[1]) < POND.radius + 3) return false;
      // Clear of the railway — the corridor must stay open for the train.
      if (RAIL_QUERY.nearest(x, z).distance < 11) return false;
      // Off the road.
      if (ROAD_QUERY.nearest(x, z).distance < 4) return false;
      return true;
    };

    const points = blueNoise(
      rng.next,
      treeCount,
      VEGETATION.MIN_TREE_SPACING,
      [-margin, -margin, margin, margin],
      accept,
      30,
    );

    return points.map(([x, z]) => {
      const species = pickSpecies(x, z, rng);
      const variation = rng.int(0, 2);
      const scale = 1 + rng.gaussian(0, VEGETATION.SCALE_JITTER * 0.5);
      const clampedScale = clamp(scale, 0.62, 1.5);
      return {
        x,
        z,
        y: terrain.heightAt(x, z),
        species,
        variation,
        scale: clampedScale,
        rotation: rng.angle(),
        hueShift: rng.gaussian(0, VEGETATION.HUE_JITTER_DEG / 360),
        radius: 0.4 * clampedScale,
        height: 10 * clampedScale,
      };
    });
  }, [terrain, treeCount]);

  /* ── Geometry cache ──────────────────────────────────────────────────────
   * One geometry per species × variation × LOD. Built once, shared by every
   * instance. Total: 6 × 3 × 2 = 36 geometries, a few MB. */
  const geometryCache = useMemo(() => {
    const cache = new Map<string, ReturnType<typeof buildTree>>();
    for (const species of TREE_SPECIES) {
      for (let v = 0; v < 3; v++) {
        for (const lod of ['high', 'medium'] as TreeLod[]) {
          cache.set(`${species}-${v}-${lod}`, buildTree(species, v, lod, terrain.seed));
        }
      }
    }
    return cache;
  }, [terrain.seed]);

  useEffect(
    () => () => {
      for (const t of geometryCache.values()) {
        t.trunk.dispose();
        t.foliage?.dispose();
      }
    },
    [geometryCache],
  );

  /* ── Materials ───────────────────────────────────────────────────────── */
  const snowUniform = useRef({ value: 0 });

  const materials = useMemo(() => {
    const map = new Map<string, { bark: THREE.Material; leaf: THREE.Material }>();

    for (const species of TREE_SPECIES) {
      const colors = speciesColors(species);

      const bark = new THREE.MeshStandardMaterial({
        map: barkTexture(256, hexToRgbTuple(colors.bark)),
        color: new THREE.Color(colors.bark).multiplyScalar(1.6),
        roughness: 0.92,
        metalness: 0,
      });
      /* Trunks are stiff: stiffness 3.6 means almost all the motion is in the
       * upper branches, which is what a real trunk does. */
      applyFoliageWind(bark, windUniforms, {
        stiffness: 3.6,
        amplitude: 0.55,
        weightSource: 'attribute',
        instanced: true,
      });
      applySnowAccumulation(bark, snowUniform.current);

      const leaf = new THREE.MeshStandardMaterial({
        color: new THREE.Color(colors.leaf),
        roughness: 0.85,
        metalness: 0,
        // Two-sided so the canopy interior isn't hollow when you walk under it.
        side: THREE.DoubleSide,
      });
      applyFoliageWind(leaf, windUniforms, {
        stiffness: 1.9,
        amplitude: 1.35,
        weightSource: 'attribute',
        instanced: true,
      });
      applySnowAccumulation(leaf, snowUniform.current);

      map.set(species, { bark, leaf });
    }
    return map;
  }, [windUniforms]);

  useEffect(
    () => () => {
      for (const m of materials.values()) {
        m.bark.dispose();
        m.leaf.dispose();
      }
    },
    [materials],
  );

  /* Season drives foliage colour and snow. */
  useFrame((_, dt) => {
    const s = SEASONS[season];
    snowUniform.current.value += (s.snowCoverage - snowUniform.current.value) * Math.min(dt, 0.1);

    for (const species of TREE_SPECIES) {
      const mats = materials.get(species);
      if (!mats) continue;
      const leaf = mats.leaf as THREE.MeshStandardMaterial;
      const base = speciesColors(species).leaf;

      let target = base;
      if (isDeciduous(species)) {
        if (season === 'autumn') {
          // Each species turns a slightly different autumn colour.
          const autumnHues = ['#d4802f', '#e8a83c', '#c05a2a', '#b8923c'];
          const idx = species.charCodeAt(0) % autumnHues.length;
          target = autumnHues[idx]!;
        } else if (season === 'spring' && blossoms(species)) {
          target = '#f2b8ce';
        } else {
          target = mixHex(base, s.foliageTint, 0.45);
        }
      }
      leaf.color.lerp(new THREE.Color(target), Math.min(dt * 0.8, 0.1));
    }
  });

  /* ── Group instances by species/variation/LOD ─────────────────────────── */
  const groups = useMemo(() => {
    const map = new Map<string, TreeInstance[]>();
    for (const inst of instances) {
      const key = `${inst.species}-${inst.variation}`;
      const arr = map.get(key);
      if (arr) arr.push(inst);
      else map.set(key, [inst]);
    }
    return map;
  }, [instances]);

  const lodHigh = VEGETATION.LOD_HIGH_DISTANCE * lodScale;
  const lodMedium = VEGETATION.LOD_MEDIUM_DISTANCE * lodScale;

  return (
    <group name="trees">
      {Array.from(groups.entries()).map(([key, group]) => {
        const [species, variationStr] = key.split('-') as [TreeSpecies, string];
        const variation = Number(variationStr);
        const mats = materials.get(species);
        if (!mats) return null;

        return (
          <TreeSpeciesGroup
            key={key}
            instances={group}
            highGeo={geometryCache.get(`${species}-${variation}-high`)!}
            mediumGeo={geometryCache.get(`${species}-${variation}-medium`)!}
            barkMaterial={mats.bark}
            leafMaterial={mats.leaf}
            castShadow={shadowsOn}
            lodHigh={lodHigh}
            lodMedium={lodMedium}
          />
        );
      })}

      <TreeColliders instances={instances} />
    </group>
  );
}

/**
 * Renders one species/variation group as two instanced meshes (high and medium
 * LOD), swapping instances between them as the camera moves.
 *
 * The LOD update is **round-robin across frames**: a slice of the instance list
 * is re-evaluated each frame rather than all of them. With 400 trees a full
 * pass completes in about six frames — imperceptible for something whose
 * trigger distance is 30 m — while costing a fraction of the per-frame budget.
 */
function TreeSpeciesGroup({
  instances,
  highGeo,
  mediumGeo,
  barkMaterial,
  leafMaterial,
  castShadow,
  lodHigh,
  lodMedium,
}: {
  instances: TreeInstance[];
  highGeo: ReturnType<typeof buildTree>;
  mediumGeo: ReturnType<typeof buildTree>;
  barkMaterial: THREE.Material;
  leafMaterial: THREE.Material;
  castShadow: boolean;
  lodHigh: number;
  lodMedium: number;
}) {
  const highTrunk = useRef<THREE.InstancedMesh>(null);
  const highLeaf = useRef<THREE.InstancedMesh>(null);
  const medTrunk = useRef<THREE.InstancedMesh>(null);
  const medLeaf = useRef<THREE.InstancedMesh>(null);

  const count = instances.length;
  const matrix = useMemo(() => new THREE.Matrix4(), []);
  const hidden = useMemo(() => new THREE.Matrix4().makeScale(0, 0, 0), []);
  const quat = useMemo(() => new THREE.Quaternion(), []);
  const pos = useMemo(() => new THREE.Vector3(), []);
  const scale = useMemo(() => new THREE.Vector3(), []);
  const cursor = useRef(0);

  /* Write every matrix once on mount; the per-frame work is only hiding and
   * showing instances by scaling them to zero, which is a single matrix write
   * rather than a full recompose. */
  useEffect(() => {
    const write = (mesh: THREE.InstancedMesh | null, visible: boolean) => {
      if (!mesh) return;
      for (let i = 0; i < count; i++) {
        const inst = instances[i]!;
        pos.set(inst.x, inst.y, inst.z);
        quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), inst.rotation);
        scale.setScalar(inst.scale);
        matrix.compose(pos, quat, scale);
        mesh.setMatrixAt(i, visible ? matrix : hidden);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    };

    // Start with everything on medium; the LOD pass promotes what's close.
    write(highTrunk.current, false);
    write(highLeaf.current, false);
    write(medTrunk.current, true);
    write(medLeaf.current, true);
  }, [instances, count, matrix, hidden, quat, pos, scale]);

  useFrame(({ camera }) => {
    if (count === 0) return;

    // Re-evaluate ~1/6 of the instances per frame.
    const slice = Math.max(8, Math.ceil(count / 6));
    const camX = camera.position.x;
    const camZ = camera.position.z;

    /* The cursor persists across renders, but `instances` does not: lowering
     * the quality preset regenerates the scatter with fewer trees, and the
     * cursor can then be pointing past the end of the new, shorter array.
     * Wrap it *before* the read, not after — reading first is how this
     * produced a `Cannot read properties of undefined` on every LOD pass
     * following a downshift. */
    if (cursor.current >= count) cursor.current = 0;

    for (let n = 0; n < slice; n++) {
      const i = cursor.current;
      cursor.current = (cursor.current + 1) % count;

      const inst = instances[i];
      if (!inst) continue;

      const dx = inst.x - camX;
      const dz = inst.z - camZ;
      const dist = Math.sqrt(dx * dx + dz * dz);

      const useHigh = dist < lodHigh;
      const useMedium = !useHigh && dist < lodMedium;

      pos.set(inst.x, inst.y, inst.z);
      quat.setFromAxisAngle(_up, inst.rotation);
      scale.setScalar(inst.scale);
      matrix.compose(pos, quat, scale);

      if (highTrunk.current) {
        highTrunk.current.setMatrixAt(i, useHigh ? matrix : hidden);
        highTrunk.current.instanceMatrix.needsUpdate = true;
      }
      if (highLeaf.current) {
        highLeaf.current.setMatrixAt(i, useHigh ? matrix : hidden);
        highLeaf.current.instanceMatrix.needsUpdate = true;
      }
      if (medTrunk.current) {
        medTrunk.current.setMatrixAt(i, useMedium ? matrix : hidden);
        medTrunk.current.instanceMatrix.needsUpdate = true;
      }
      if (medLeaf.current) {
        medLeaf.current.setMatrixAt(i, useMedium ? matrix : hidden);
        medLeaf.current.instanceMatrix.needsUpdate = true;
      }
    }
  });

  return (
    <>
      <instancedMesh
        ref={highTrunk}
        args={[highGeo.trunk, barkMaterial, count]}
        castShadow={castShadow}
        receiveShadow={castShadow}
        frustumCulled={false}
      />
      {highGeo.foliage && (
        <instancedMesh
          ref={highLeaf}
          args={[highGeo.foliage, leafMaterial, count]}
          castShadow={castShadow}
          receiveShadow={castShadow}
          frustumCulled={false}
        />
      )}
      <instancedMesh
        ref={medTrunk}
        args={[mediumGeo.trunk, barkMaterial, count]}
        castShadow={castShadow}
        frustumCulled={false}
      />
      {mediumGeo.foliage && (
        <instancedMesh
          ref={medLeaf}
          args={[mediumGeo.foliage, leafMaterial, count]}
          castShadow={castShadow}
          frustumCulled={false}
        />
      )}
    </>
  );
}

/**
 * Static colliders for every tree.
 *
 * All of them live inside **one** `RigidBody`. Rapier stores fixed colliders in
 * a static broad-phase where they cost nothing per step, so 400 cylinders is
 * genuinely cheap — but 400 *rigid bodies* would mean 400 React components and
 * 400 transform syncs, which is not.
 */
function TreeColliders({ instances }: { instances: TreeInstance[] }) {
  return (
    <RigidBody type="fixed" colliders={false} name="trees-body">
      {instances.map((inst, i) => (
        <CylinderCollider
          key={i}
          args={[inst.height * 0.5, Math.max(inst.radius, 0.25)]}
          position={[inst.x, inst.y + inst.height * 0.5, inst.z]}
          friction={0.7}
        />
      ))}
    </RigidBody>
  );
}

const _up = new THREE.Vector3(0, 1, 0);

/** `#rrggbb` → normalised RGB tuple, for the bark texture generator. */
function hexToRgbTuple(hex: string): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}
