/**
 * Procedural tree geometry.
 *
 * Six species, three shape variations each, at three levels of detail. All
 * generated at load from primitives and merged down to one geometry per
 * species/variation/LOD — so 420 trees on screen cost 18 draw calls, not 420.
 *
 * ## Building a tree that doesn't look like a lollipop
 *
 * The single biggest thing is **recursive branching with tapering**. A trunk
 * that splits into progressively shorter, thinner, more upright branches
 * produces a silhouette the eye reads as botanical. Attaching a sphere to a
 * cylinder does not, no matter how good the texture.
 *
 * The second is **species-specific branching rules**. A pine's branches leave
 * the trunk at a steep downward angle and get shorter with height; a willow's
 * droop below horizontal; an oak's fork wide and gnarled. Those three numbers —
 * branch angle, length falloff, and how much the trunk continues past the first
 * fork — are most of what distinguishes one species from another.
 *
 * @module lib/geometry/trees
 */

import * as THREE from 'three';
import { mergeGeometries, transformGeometry, setComputedAttribute } from './merge';
import { RandomSource } from '@/lib/utils/random';
import { lerp, clamp } from '@/lib/utils/math';

/** The six species in the valley. */
export const TREE_SPECIES = [
  'oak',
  'birch',
  'pine',
  'willow',
  'cherry',
  'deadTree',
] as const;

export type TreeSpecies = (typeof TREE_SPECIES)[number];

/** Level of detail tier. */
export type TreeLod = 'high' | 'medium' | 'billboard';

/** Per-species growth rules. */
interface SpeciesProfile {
  /** Trunk height range. */
  height: [number, number];
  /** Trunk radius at the base, as a fraction of height. */
  baseRadius: number;
  /** How much the trunk narrows from base to top. 0 = no taper, 1 = to a point. */
  taper: number;
  /** Recursion depth of the branch system. */
  depth: number;
  /** Branches emitted per parent. */
  branchesPerLevel: [number, number];
  /** Angle from the parent's axis, radians. Negative droops downward. */
  branchAngle: [number, number];
  /** Child length as a fraction of parent length. */
  lengthFalloff: number;
  /** Child radius as a fraction of parent radius. */
  radiusFalloff: number;
  /** Where along the parent branches start, as a fraction of its length. */
  branchStart: number;
  /** How much random bend each segment has. */
  gnarl: number;
  /** Canopy blob radius as a fraction of tree height. */
  canopyRadius: number;
  /** Number of canopy blobs. */
  canopyBlobs: number;
  /** Vertical position of the canopy centre, as a fraction of height. */
  canopyHeight: number;
  /** Canopy squash: >1 is wide and flat, <1 is tall and narrow. */
  canopyFlatten: number;
  /** Trunk colour. */
  barkColor: string;
  /** Foliage colour. */
  leafColor: string;
  /** Species has no foliage at all. */
  bare?: boolean;
  /** Foliage hangs downward in strands (willow). */
  weeping?: boolean;
}

const PROFILES: Record<TreeSpecies, SpeciesProfile> = {
  /* Oak: broad, gnarled, wide-forking. The archetypal "big tree". */
  oak: {
    height: [8, 13],
    baseRadius: 0.055,
    taper: 0.72,
    depth: 3,
    branchesPerLevel: [3, 4],
    branchAngle: [0.55, 1.0],
    lengthFalloff: 0.66,
    radiusFalloff: 0.58,
    branchStart: 0.45,
    gnarl: 0.34,
    canopyRadius: 0.42,
    canopyBlobs: 7,
    canopyHeight: 0.78,
    canopyFlatten: 1.25,
    barkColor: '#4a3c2e',
    leafColor: '#3d6b28',
  },
  /* Birch: slender, pale, upward branches, sparse canopy. */
  birch: {
    height: [9, 14],
    baseRadius: 0.028,
    taper: 0.55,
    depth: 3,
    branchesPerLevel: [2, 3],
    branchAngle: [0.35, 0.62],
    lengthFalloff: 0.7,
    radiusFalloff: 0.62,
    branchStart: 0.55,
    gnarl: 0.16,
    canopyRadius: 0.26,
    canopyBlobs: 5,
    canopyHeight: 0.82,
    canopyFlatten: 0.82,
    barkColor: '#d8d4c8',
    leafColor: '#6a9c3a',
  },
  /* Pine: a conical whorl of downward-angled branches, shortening with height. */
  pine: {
    height: [11, 17],
    baseRadius: 0.042,
    taper: 0.88,
    depth: 2,
    branchesPerLevel: [5, 7],
    branchAngle: [1.1, 1.45],
    lengthFalloff: 0.52,
    radiusFalloff: 0.45,
    branchStart: 0.18,
    gnarl: 0.1,
    canopyRadius: 0.3,
    canopyBlobs: 9,
    canopyHeight: 0.6,
    canopyFlatten: 0.6,
    barkColor: '#3e2c20',
    leafColor: '#24512c',
  },
  /* Willow: drooping. Branch angles past 90° so everything hangs. */
  willow: {
    height: [7, 11],
    baseRadius: 0.062,
    taper: 0.68,
    depth: 3,
    branchesPerLevel: [4, 5],
    branchAngle: [1.35, 1.9],
    lengthFalloff: 0.72,
    radiusFalloff: 0.55,
    branchStart: 0.5,
    gnarl: 0.42,
    canopyRadius: 0.45,
    canopyBlobs: 6,
    canopyHeight: 0.68,
    canopyFlatten: 1.05,
    barkColor: '#544433',
    leafColor: '#7a9c48',
    weeping: true,
  },
  /* Cherry: small, spreading, blossom-pink. */
  cherry: {
    height: [6, 9],
    baseRadius: 0.05,
    taper: 0.7,
    depth: 3,
    branchesPerLevel: [3, 4],
    branchAngle: [0.65, 1.15],
    lengthFalloff: 0.64,
    radiusFalloff: 0.56,
    branchStart: 0.4,
    gnarl: 0.28,
    canopyRadius: 0.44,
    canopyBlobs: 6,
    canopyHeight: 0.76,
    canopyFlatten: 1.35,
    barkColor: '#463328',
    leafColor: '#e8a8c0',
  },
  /* Dead tree: bare, sharply forked, high contrast against the sky. */
  deadTree: {
    height: [8, 12],
    baseRadius: 0.048,
    taper: 0.8,
    depth: 4,
    branchesPerLevel: [2, 3],
    branchAngle: [0.7, 1.3],
    lengthFalloff: 0.62,
    radiusFalloff: 0.5,
    branchStart: 0.35,
    gnarl: 0.55,
    canopyRadius: 0,
    canopyBlobs: 0,
    canopyHeight: 0,
    canopyFlatten: 1,
    barkColor: '#5a5148',
    leafColor: '#5a5148',
    bare: true,
  },
};

/** A generated tree, split into the two materials it needs. */
export interface TreeGeometry {
  /** Trunk and branches. */
  trunk: THREE.BufferGeometry;
  /** Leaves — null for the dead tree. */
  foliage: THREE.BufferGeometry | null;
  /** Overall height, for LOD and collision sizing. */
  height: number;
  /** Trunk radius at the base, for the collider. */
  radius: number;
  /** Canopy radius, for wind and shadow sizing. */
  canopyRadius: number;
}

/**
 * Recursively generates a branch and its children.
 *
 * @param out - Accumulator the generated cylinders are pushed into.
 * @param origin - Where this branch starts.
 * @param direction - Unit direction it grows in.
 * @param length - Its length.
 * @param radius - Its radius at the base.
 * @param depth - Remaining recursion depth.
 * @param profile - Species rules.
 * @param rng - Deterministic randomness.
 * @param tips - Accumulator for branch end points, where foliage is attached.
 */
function growBranch(
  out: THREE.BufferGeometry[],
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  length: number,
  radius: number,
  depth: number,
  profile: SpeciesProfile,
  rng: RandomSource,
  tips: Array<{ pos: THREE.Vector3; radius: number; depth: number }>,
  radialSegments: number,
): void {
  if (depth < 0 || length < 0.12 || radius < 0.006) return;

  /* A branch is built from several short segments rather than one long
   * cylinder, so it can curve. Straight branches are the clearest tell of a
   * procedurally generated tree. */
  const segments = Math.max(2, Math.min(5, depth + 2));
  const segLength = length / segments;

  const cursor = origin.clone();
  const dir = direction.clone().normalize();
  let segRadius = radius;

  for (let i = 0; i < segments; i++) {
    const t0 = i / segments;
    const t1 = (i + 1) / segments;
    const r0 = radius * (1 - profile.taper * t0);
    const r1 = radius * (1 - profile.taper * t1);

    const end = cursor.clone().addScaledVector(dir, segLength);

    // A cylinder aligned to +Y, then rotated onto the branch direction.
    const cyl = new THREE.CylinderGeometry(
      Math.max(r1, 0.004),
      Math.max(r0, 0.004),
      segLength,
      radialSegments,
      1,
      true,
    );

    const mid = cursor.clone().add(end).multiplyScalar(0.5);
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const m = new THREE.Matrix4().compose(mid, quat, new THREE.Vector3(1, 1, 1));
    cyl.applyMatrix4(m);
    out.push(cyl);

    cursor.copy(end);
    segRadius = r1;

    /* Bend the direction a little each segment. Gnarl is applied as a random
     * rotation, plus a constant upward bias so branches reach for the light —
     * which is a real phototropic behaviour and reads immediately as correct. */
    const bend = new THREE.Vector3(
      rng.gaussian(0, profile.gnarl * 0.3),
      rng.gaussian(0, profile.gnarl * 0.12) + (depth < profile.depth ? 0.08 : 0),
      rng.gaussian(0, profile.gnarl * 0.3),
    );
    dir.add(bend).normalize();
  }

  tips.push({ pos: cursor.clone(), radius: segRadius, depth });

  if (depth === 0) return;

  /* ── Children ──────────────────────────────────────────────────────────── */
  const count = rng.int(profile.branchesPerLevel[0], profile.branchesPerLevel[1]);

  /* Golden-angle phyllotaxis. Real plants space successive leaves and branches
   * by ~137.5° because that angle never repeats a pattern for any number of
   * elements — it is the most efficient packing. Using it here means branches
   * never line up into visible rows, which random angles occasionally do. */
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const phase = rng.angle();

  for (let i = 0; i < count; i++) {
    const along = lerp(profile.branchStart, 0.96, (i + rng.next() * 0.5) / count);
    const childOrigin = origin.clone().addScaledVector(direction, length * along);

    const azimuth = phase + i * goldenAngle;
    const polar = rng.range(profile.branchAngle[0], profile.branchAngle[1]);

    // Build an orthonormal basis around the parent's direction.
    const up = direction.clone().normalize();
    const ref = Math.abs(up.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(up, ref).normalize();
    const forward = new THREE.Vector3().crossVectors(side, up).normalize();

    const childDir = up
      .clone()
      .multiplyScalar(Math.cos(polar))
      .addScaledVector(side, Math.sin(polar) * Math.cos(azimuth))
      .addScaledVector(forward, Math.sin(polar) * Math.sin(azimuth))
      .normalize();

    // Branches higher on the parent are shorter — the classic taper of a crown.
    const childLength = length * profile.lengthFalloff * lerp(1.15, 0.7, along);
    const childRadius = radius * profile.radiusFalloff;

    growBranch(
      out,
      childOrigin,
      childDir,
      childLength,
      childRadius,
      depth - 1,
      profile,
      rng,
      tips,
      Math.max(3, radialSegments - 1),
    );
  }
}

/**
 * Generates one tree.
 *
 * @param species - Which species.
 * @param variation - 0–2; picks a different random stream for the same species.
 * @param lod - Detail tier.
 * @param seed - World seed, so trees are stable across sessions.
 */
export function buildTree(
  species: TreeSpecies,
  variation: number,
  lod: TreeLod,
  seed = 'hollow',
): TreeGeometry {
  const profile = PROFILES[species];
  const rng = new RandomSource(seed, `tree-${species}-${variation}`);

  const height = rng.range(profile.height[0], profile.height[1]);
  const baseRadius = height * profile.baseRadius;

  /* LOD budgets. The billboard tier is handled separately (see
   * `buildTreeBillboard`); medium halves the branch depth and radial segments,
   * which cuts the triangle count by roughly 75 % while keeping the
   * silhouette — and at 30 m+ the silhouette is all you can see. */
  const radialSegments = lod === 'high' ? 6 : 4;
  const depth = lod === 'high' ? profile.depth : Math.max(1, profile.depth - 1);

  const trunkParts: THREE.BufferGeometry[] = [];
  const tips: Array<{ pos: THREE.Vector3; radius: number; depth: number }> = [];

  growBranch(
    trunkParts,
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(rng.gaussian(0, 0.06), 1, rng.gaussian(0, 0.06)).normalize(),
    height,
    baseRadius,
    depth,
    profile,
    rng,
    tips,
    radialSegments,
  );

  // Root flare — a short, wide cone at the base. Trees do not meet the ground
  // at a clean right angle, and this one primitive fixes that read instantly.
  const flare = new THREE.CylinderGeometry(baseRadius, baseRadius * 1.9, height * 0.09, radialSegments + 2, 1);
  transformGeometry(flare, { position: [0, height * 0.045, 0] });
  trunkParts.push(flare);

  const trunk = mergeGeometries(trunkParts, true);
  trunk.computeVertexNormals();

  /* Wind weight, per vertex, from height. The trunk barely moves; the outer
   * canopy moves a lot. Squaring keeps the lower trunk near-rigid. */
  setComputedAttribute(trunk, 'aWindWeight', (_x, y) =>
    Math.pow(clamp(y / height, 0, 1), 2.1),
  );

  /* ── Foliage ─────────────────────────────────────────────────────────────
   * Blobs of low-poly icosahedra clustered at the branch tips. Icosahedron
   * rather than sphere: at detail 0 it is 20 triangles, reads as an organic
   * clump, and has no pole pinching. */
  let foliage: THREE.BufferGeometry | null = null;

  if (!profile.bare && lod !== 'billboard') {
    const blobs: THREE.BufferGeometry[] = [];
    const canopyR = height * profile.canopyRadius;
    const detail = lod === 'high' ? 1 : 0;

    // Attach a blob at every outermost branch tip.
    const outerTips = tips.filter((t) => t.depth <= 1);
    const sourceTips = outerTips.length > 0 ? outerTips : tips;

    for (const tip of sourceTips) {
      const blobRadius = canopyR * rng.range(0.34, 0.58);
      const geo = new THREE.IcosahedronGeometry(blobRadius, detail);
      // Squash so the canopy is wider than it is tall (or the reverse, for pine).
      transformGeometry(geo, {
        position: [tip.pos.x, tip.pos.y, tip.pos.z],
        scale: [profile.canopyFlatten, 1 / profile.canopyFlatten, profile.canopyFlatten],
        rotation: [rng.angle(), rng.angle(), rng.angle()],
      });
      blobs.push(geo);
    }

    // A few larger blobs at the crown centre to fill the interior.
    for (let i = 0; i < profile.canopyBlobs; i++) {
      const [ox, oz] = rng.insideDisc(canopyR * 0.7);
      const oy = height * profile.canopyHeight + rng.gaussian(0, canopyR * 0.28);
      const geo = new THREE.IcosahedronGeometry(canopyR * rng.range(0.4, 0.72), detail);
      transformGeometry(geo, {
        position: [ox, oy, oz],
        scale: [profile.canopyFlatten, 1 / profile.canopyFlatten, profile.canopyFlatten],
        rotation: [rng.angle(), rng.angle(), rng.angle()],
      });
      blobs.push(geo);
    }

    /* Willow strands: long, thin, drooping cylinders hanging from the canopy.
     * This one addition is the entire visual identity of the species. */
    if (profile.weeping) {
      const strandCount = lod === 'high' ? 34 : 16;
      for (let i = 0; i < strandCount; i++) {
        const [sx, sz] = rng.insideDisc(canopyR * 0.85);
        const top = height * profile.canopyHeight;
        const len = rng.range(height * 0.28, height * 0.52);
        const strand = new THREE.CylinderGeometry(0.035, 0.012, len, 3, 1);
        transformGeometry(strand, {
          position: [sx, top - len / 2, sz],
          rotation: [rng.gaussian(0, 0.12), rng.angle(), rng.gaussian(0, 0.12)],
        });
        blobs.push(strand);
      }
    }

    foliage = mergeGeometries(blobs, true);
    foliage.computeVertexNormals();
    // Foliage is the most flexible part — high wind weight throughout, graded
    // slightly so the inner canopy lags the outer.
    setComputedAttribute(foliage, 'aWindWeight', (x, y, z) => {
      const radial = Math.sqrt(x * x + z * z) / Math.max(canopyR, 0.001);
      const vertical = clamp(y / height, 0, 1);
      return clamp(0.45 + radial * 0.35 + vertical * 0.3, 0, 1.2);
    });
  }

  return {
    trunk,
    foliage,
    height,
    radius: baseRadius * 1.9,
    canopyRadius: height * profile.canopyRadius,
  };
}

/**
 * Builds the billboard LOD: two crossed alpha-tested quads.
 *
 * At 80 m+ a tree occupies a few dozen pixels. Two quads with a foliage texture
 * are visually indistinguishable from 3000 triangles at that distance, and cost
 * 0.1 % as much. Crossing them (rather than using a single camera-facing quad)
 * means the billboard has genuine parallax as you walk past and doesn't
 * visibly rotate.
 */
export function buildTreeBillboard(species: TreeSpecies, height: number): THREE.BufferGeometry {
  const profile = PROFILES[species];
  const width = height * profile.canopyRadius * 2.4;
  const parts: THREE.BufferGeometry[] = [];

  const quadA = new THREE.PlaneGeometry(width, height * 0.85);
  transformGeometry(quadA, { position: [0, height * 0.55, 0] });
  parts.push(quadA);

  const quadB = new THREE.PlaneGeometry(width, height * 0.85);
  transformGeometry(quadB, { position: [0, height * 0.55, 0], rotation: [0, Math.PI / 2, 0] });
  parts.push(quadB);

  const merged = mergeGeometries(parts, true);
  setComputedAttribute(merged, 'aWindWeight', (_x, y) => clamp(y / height, 0, 1) * 0.5);
  return merged;
}

/** Species colours, for material construction. */
export function speciesColors(species: TreeSpecies): { bark: string; leaf: string } {
  const p = PROFILES[species];
  return { bark: p.barkColor, leaf: p.leafColor };
}

/** Whether a species drops its leaves / changes colour in autumn. */
export function isDeciduous(species: TreeSpecies): boolean {
  return species !== 'pine' && species !== 'deadTree';
}

/** Whether a species blossoms in spring. */
export function blossoms(species: TreeSpecies): boolean {
  return species === 'cherry';
}

/** Species height range, for placement queries without building geometry. */
export function speciesHeightRange(species: TreeSpecies): [number, number] {
  return PROFILES[species].height;
}
