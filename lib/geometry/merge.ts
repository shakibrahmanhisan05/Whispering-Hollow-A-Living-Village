/**
 * Geometry merging.
 *
 * A hand-rolled replacement for three's `BufferGeometryUtils.mergeGeometries`.
 * Written locally for two reasons: it avoids importing from `three/examples`
 * (whose path has moved between versions), and it can be strict about
 * attributes — silently dropping a mismatched attribute, as the stock helper
 * does, produces geometry that renders subtly wrong with no error.
 *
 * @module lib/geometry/merge
 */

import * as THREE from 'three';

/**
 * Merges several geometries into one.
 *
 * All inputs must be indexed or all non-indexed, and must share the same
 * attribute names and item sizes. Merging is what turns a tree built from 40
 * separate primitives into a single draw call.
 *
 * @param geometries - Geometries to merge. Not disposed; the caller owns them.
 * @param disposeSources - When true, disposes each input after merging.
 * @throws If the geometries have incompatible attribute sets.
 */
export function mergeGeometries(
  geometries: THREE.BufferGeometry[],
  disposeSources = false,
): THREE.BufferGeometry {
  if (geometries.length === 0) return new THREE.BufferGeometry();
  if (geometries.length === 1) return geometries[0]!.clone();

  /* ── Normalise indexing ──────────────────────────────────────────────────
   * three.js is inconsistent about this: `CylinderGeometry` and `BoxGeometry`
   * are indexed, while `IcosahedronGeometry` (and everything else derived from
   * `PolyhedronGeometry`) is not. A willow — cylinders for the drooping
   * strands, icosahedra for the canopy — hits both in one merge.
   *
   * Rather than making every caller keep track, un-index the whole batch when
   * the set is mixed. Un-indexing costs some vertex duplication but is always
   * correct, whereas inventing indices for a non-indexed geometry is not. */
  const anyIndexed = geometries.some((g) => g.index !== null);
  const allIndexed = geometries.every((g) => g.index !== null);
  let working = geometries;
  let converted = false;

  if (anyIndexed && !allIndexed) {
    working = geometries.map((g) => (g.index !== null ? g.toNonIndexed() : g));
    converted = true;
  }

  const first = working[0]!;
  const attributeNames = Object.keys(first.attributes);
  const isIndexed = first.index !== null;

  // Validate the attribute sets — a mismatch discovered halfway through leaves
  // a half-built geometry that is very hard to debug from the render output.
  for (const g of working) {
    for (const name of attributeNames) {
      if (!g.attributes[name]) {
        throw new Error(`mergeGeometries: geometry is missing attribute "${name}"`);
      }
      if (g.attributes[name]!.itemSize !== first.attributes[name]!.itemSize) {
        throw new Error(`mergeGeometries: attribute "${name}" has inconsistent itemSize`);
      }
    }
  }

  const merged = new THREE.BufferGeometry();

  for (const name of attributeNames) {
    const itemSize = first.attributes[name]!.itemSize;
    let total = 0;
    for (const g of working) total += g.attributes[name]!.count;

    const array = new Float32Array(total * itemSize);
    let offset = 0;
    for (const g of working) {
      const attr = g.attributes[name]!;
      for (let i = 0; i < attr.count; i++) {
        for (let c = 0; c < itemSize; c++) {
          array[offset + i * itemSize + c] = attr.array[i * itemSize + c] as number;
        }
      }
      offset += attr.count * itemSize;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
  }

  if (isIndexed) {
    let totalIndices = 0;
    let totalVertices = 0;
    for (const g of working) {
      totalIndices += g.index!.count;
      totalVertices += g.attributes.position!.count;
    }

    // Use 32-bit indices past 65 535 vertices, or the mesh silently corrupts.
    const IndexArray = totalVertices > 65535 ? Uint32Array : Uint16Array;
    const indices = new IndexArray(totalIndices);

    let indexOffset = 0;
    let vertexOffset = 0;
    for (const g of working) {
      const idx = g.index!;
      for (let i = 0; i < idx.count; i++) {
        indices[indexOffset + i] = (idx.array[i] as number) + vertexOffset;
      }
      indexOffset += idx.count;
      vertexOffset += g.attributes.position!.count;
    }
    merged.setIndex(new THREE.BufferAttribute(indices, 1));
  }

  merged.computeBoundingSphere();
  merged.computeBoundingBox();

  // Any temporaries created by the un-indexing pass are ours to release.
  if (converted) {
    for (let i = 0; i < working.length; i++) {
      if (working[i] !== geometries[i]) working[i]!.dispose();
    }
  }
  if (disposeSources) for (const g of geometries) g.dispose();
  return merged;
}

/**
 * Applies a transform to a geometry and returns it, for use in merge chains.
 *
 * Note this bakes the transform into the vertex data — the whole point when
 * merging, since the merged result has a single transform of its own.
 */
export function transformGeometry(
  geometry: THREE.BufferGeometry,
  opts: {
    position?: [number, number, number];
    rotation?: [number, number, number];
    scale?: [number, number, number] | number;
  },
): THREE.BufferGeometry {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler(...(opts.rotation ?? [0, 0, 0]));
  q.setFromEuler(e);
  const s = opts.scale ?? 1;
  const scaleVec = typeof s === 'number' ? new THREE.Vector3(s, s, s) : new THREE.Vector3(...s);
  m.compose(new THREE.Vector3(...(opts.position ?? [0, 0, 0])), q, scaleVec);
  geometry.applyMatrix4(m);
  return geometry;
}

/**
 * Adds a constant-valued custom attribute to every vertex.
 *
 * Used to tag parts of a merged tree with their wind weight: the trunk gets 0
 * (rigid), the outer canopy gets 1 (fully flexible). Without this the whole
 * merged mesh would have to sway as one rigid body.
 */
export function setUniformAttribute(
  geometry: THREE.BufferGeometry,
  name: string,
  value: number,
): THREE.BufferGeometry {
  const count = geometry.attributes.position!.count;
  const array = new Float32Array(count).fill(value);
  geometry.setAttribute(name, new THREE.BufferAttribute(array, 1));
  return geometry;
}

/**
 * Adds a per-vertex attribute computed from each vertex's position.
 * Used for height-graded wind weights within a single canopy blob.
 */
export function setComputedAttribute(
  geometry: THREE.BufferGeometry,
  name: string,
  compute: (x: number, y: number, z: number) => number,
): THREE.BufferGeometry {
  const pos = geometry.attributes.position!;
  const array = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    array[i] = compute(pos.getX(i), pos.getY(i), pos.getZ(i));
  }
  geometry.setAttribute(name, new THREE.BufferAttribute(array, 1));
  return geometry;
}
