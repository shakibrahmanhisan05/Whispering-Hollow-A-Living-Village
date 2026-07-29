/**
 * Instanced grass, wheat, flowers and ground clutter.
 *
 * Grass is **chunked and streamed**: the world is divided into 20 m squares and
 * only the chunks near the player carry blades. Populating all 400 chunks would
 * mean 3.6 M blades on the GPU permanently; streaming a 13×13 window keeps it
 * around 200 k while looking identical, because the far chunks were fading out
 * anyway.
 *
 * Chunks are **recycled, not rebuilt**. When the player crosses a chunk
 * boundary the geometry that just went out of range is re-filled with new
 * positions and moved to the other side, so no buffers are allocated after the
 * first frame. This is what keeps walking across the meadow free of GC hitches.
 *
 * @module components/scene/Grass
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { useWorld } from './TerrainContext';
import { useLighting } from '@/hooks/useTimeOfDay';
import { useGameStore } from '@/store/gameStore';
import { useSettingsStore } from '@/store/settingsStore';
import { GRASS_VERTEX, GRASS_FRAGMENT, WHEAT_VERTEX, WHEAT_FRAGMENT } from '@/shaders/grass.glsl';
import { mulberry32 } from '@/lib/utils/random';
import { VEGETATION, SEASONS, WORLD, ZONES } from '@/config/game';
import { hexToRgb, lerp } from '@/lib/utils/math';
import { POND, ROAD_QUERY, RAIL_QUERY } from '@/lib/world/layout';

/**
 * Builds the blade geometry: a narrow strip with N segments, ready to be
 * instanced. Vertices span x ∈ [−width/2, width/2], y ∈ [0, 1].
 *
 * The `width` argument matters more than it looks. Building the strip in
 * normalised ±0.5 space and relying on the shader to scale it is the obvious
 * approach and it is wrong here: the vertex shader only scales *height* per
 * instance, so a normalised blade ends up one full world unit across — metre-
 * wide grass that the player walks into like a hedge. Baking the real width
 * into the shared geometry keeps every blade 8.5 cm across for free.
 */
function createBladeGeometry(segments: number, width: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const half = width / 2;

  for (let i = 0; i <= segments; i++) {
    const v = i / segments;
    positions.push(-half, v, 0);
    positions.push(half, v, 0);
    uvs.push(0, v, 1, v);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

/** Per-chunk instance buffers, reused as chunks are recycled. */
interface ChunkBuffers {
  offset: THREE.InstancedBufferAttribute;
  rotation: THREE.InstancedBufferAttribute;
  scale: THREE.InstancedBufferAttribute;
  phase: THREE.InstancedBufferAttribute;
  colorJitter: THREE.InstancedBufferAttribute;
  bend: THREE.InstancedBufferAttribute;
  geometry: THREE.InstancedBufferGeometry;
  /** Chunk grid coordinates currently occupied. */
  cx: number;
  cz: number;
  /** How many instances are actually in use (some are rejected by terrain). */
  count: number;
}

export function Grass() {
  const { terrain, windUniforms } = useWorld();
  const lighting = useLighting();
  const season = useGameStore((s) => s.season);
  const density = useSettingsStore((s) => s.graphics.grassDensity);

  const groupRef = useRef<THREE.Group>(null);

  /* ── Fixed-capacity pool ─────────────────────────────────────────────────
   * `capacity` is what we allocate; `bladesPerChunk` is what we *draw*.
   * Keeping the allocation constant means changing the quality preset costs a
   * single `instanceCount` write per chunk instead of tearing down and
   * rebuilding 81 geometries and ~500 GPU buffers. The old behaviour spiked
   * GPU memory hard enough to trigger `GL_OUT_OF_MEMORY` and lose the WebGL
   * context when switching presets mid-session. */
  const capacity = VEGETATION.GRASS_BLADES_PER_CHUNK;
  const bladesPerChunk = Math.min(capacity, Math.floor(capacity * density));
  const chunkRadius = VEGETATION.GRASS_CHUNK_RADIUS;
  const chunkSize = VEGETATION.GRASS_CHUNK_SIZE;

  const baseGeometry = useMemo(
    () => createBladeGeometry(VEGETATION.GRASS_BLADE_SEGMENTS, VEGETATION.GRASS_BLADE_WIDTH),
    [],
  );

  const material = useMemo(() => {
    const mat = new THREE.ShaderMaterial({
      vertexShader: GRASS_VERTEX,
      fragmentShader: GRASS_FRAGMENT,
      uniforms: {
        /* Wind uniforms are shared *by reference* with every other wind-aware
         * material in the scene, so one write per frame moves the whole world
         * together. See hooks/useWind.ts. */
        uTime: windUniforms.uTime,
        uWindDirection: windUniforms.uWindDirection,
        uWindStrength: windUniforms.uWindStrength,
        uRipplePhase: windUniforms.uRipplePhase,
        uRippleWavelength: windUniforms.uRippleWavelength,
        uCameraPos: { value: new THREE.Vector3() },
        uFadeStart: { value: chunkRadius * chunkSize * 0.55 },
        uFadeEnd: { value: chunkRadius * chunkSize * 0.95 },
        uNearFade: { value: VEGETATION.GRASS_NEAR_FADE },
        uBaseColor: { value: new THREE.Color('#2c4a1c') },
        uTipColor: { value: new THREE.Color('#7fb04a') },
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color('#ffb457') },
        uAmbientColor: { value: new THREE.Color('#9a95c8') },
        uAmbientIntensity: { value: 0.5 },
        uFogColor: { value: new THREE.Color('#f0c99a') },
        uFogDensity: { value: 0.008 },
        /* Translucency is the star of the grass shader — it is what makes the
         * meadow glow when you look toward a low sun. 1.4 is deliberately past
         * physical plausibility; at 1.0 the effect reads as a subtle rim and
         * the golden-hour shot loses its punch. */
        uTranslucency: { value: 1.4 },
        uSnowCoverage: { value: 0 },
      },
      side: THREE.DoubleSide,
      // Alpha-tested via discard in the shader, so no transparency sorting.
      transparent: false,
      fog: false,
    });
    return mat;
  }, [chunkRadius, chunkSize, windUniforms]);

  useEffect(
    () => () => {
      material.dispose();
      baseGeometry.dispose();
    },
    [material, baseGeometry],
  );

  /* ── Chunk pool ─────────────────────────────────────────────────────────── */
  const chunks = useRef<ChunkBuffers[]>([]);
  const lastCenter = useRef<{ cx: number; cz: number }>({ cx: 9999, cz: 9999 });
  /** Chunks awaiting a refill, drained a few per frame. */
  const fillQueue = useRef<Array<{ chunk: ChunkBuffers; cx: number; cz: number }>>([]);

  const chunkGrid = chunkRadius * 2 + 1;
  const totalChunks = chunkGrid * chunkGrid;

  /**
   * Fills a chunk's instance buffers with blades for the given chunk cell.
   *
   * Blades are rejected where grass wouldn't grow: underwater, on cobbles, on
   * the road, on the railway ballast, on steep rock. `count` is set to however
   * many survived, and `instanceCount` on the geometry is clamped to it so the
   * rejected slots are never drawn.
   */
  const populateChunk = useMemo(() => {
    return (chunk: ChunkBuffers, cx: number, cz: number) => {
      const rand = mulberry32(((cx & 0xffff) << 16) | (cz & 0xffff));
      const originX = cx * chunkSize;
      const originZ = cz * chunkSize;

      const target = bladesPerChunk;

      /* ── Chunk-level early-out for the expensive tests ──────────────────
       * `ROAD_QUERY.nearest` and `RAIL_QUERY.nearest` walk a spatial grid.
       * Run per blade across a whole chunk that is nowhere near either
       * feature — which is most of them — they were the single most expensive
       * thing in the fill, and the fill happens seventeen times in one frame
       * when the player crosses a chunk boundary.
       *
       * Testing the chunk centre once tells us whether any blade in it could
       * possibly be close enough to matter. The radius is the chunk's own
       * half-diagonal plus the rejection distance. */
      const centreX = originX + chunkSize * 0.5;
      const centreZ = originZ + chunkSize * 0.5;
      const chunkReach = chunkSize * 0.71 + 8;
      const nearRoad = ROAD_QUERY.nearest(centreX, centreZ).distance < chunkReach;
      const nearRail = RAIL_QUERY.nearest(centreX, centreZ).distance < chunkReach;
      const nearPlaza = Math.hypot(centreX, centreZ) < 15 + chunkReach;
      const nearPond =
        Math.hypot(centreX - POND.center[0], centreZ - POND.center[1]) <
        POND.radius + 1 + chunkReach;

      const offsets = chunk.offset.array as Float32Array;
      const rotations = chunk.rotation.array as Float32Array;
      const scales = chunk.scale.array as Float32Array;
      const phases = chunk.phase.array as Float32Array;
      const jitters = chunk.colorJitter.array as Float32Array;
      const bends = chunk.bend.array as Float32Array;

      let written = 0;
      const attempts = target;

      for (let i = 0; i < attempts; i++) {
        const x = originX + rand() * chunkSize;
        const z = originZ + rand() * chunkSize;

        // Reject outside the world.
        if (Math.abs(x) > WORLD.HALF - 4 || Math.abs(z) > WORLD.HALF - 4) continue;

        const y = terrain.heightAt(x, z);
        if (y < WORLD.WATER_LEVEL + 0.35) continue;

        /* Cheap slope test: two forward differences rather than
         * `terrain.slopeAt`, which builds a full normal from four samples.
         * Two is enough to reject a cliff, and this runs 7 500 times per
         * chunk. */
        const dhx = terrain.heightAt(x + 1, z) - y;
        const dhz = terrain.heightAt(x, z + 1) - y;
        if (dhx * dhx + dhz * dhz > 1.6) continue;

        // The plaza is paved.
        if (nearPlaza && Math.hypot(x, z) < 15) continue;
        // Nothing in the pond.
        if (nearPond && Math.hypot(x - POND.center[0], z - POND.center[1]) < POND.radius + 1) {
          continue;
        }
        // Roads and railway are bare.
        if (nearRoad && ROAD_QUERY.nearest(x, z).distance < 2.4) continue;
        if (nearRail && RAIL_QUERY.nearest(x, z).distance < 6) continue;

        const o = written * 3;
        offsets[o] = x;
        offsets[o + 1] = y;
        offsets[o + 2] = z;

        rotations[written] = rand() * Math.PI * 2;
        scales[written] =
          VEGETATION.GRASS_BLADE_HEIGHT * (0.62 + rand() * 0.72);
        phases[written] = rand() * Math.PI * 2;

        jitters[o] = rand();
        jitters[o + 1] = rand();
        jitters[o + 2] = rand();

        // Resting curvature, signed so blades lean both ways.
        bends[written] = (rand() - 0.5) * 0.5;

        written++;
      }

      chunk.count = written;
      chunk.cx = cx;
      chunk.cz = cz;

      chunk.offset.needsUpdate = true;
      chunk.rotation.needsUpdate = true;
      chunk.scale.needsUpdate = true;
      chunk.phase.needsUpdate = true;
      chunk.colorJitter.needsUpdate = true;
      chunk.bend.needsUpdate = true;
      // The draw count is set separately by `applyRingDensity`.
      chunk.geometry.instanceCount = written;
    };
  }, [bladesPerChunk, chunkSize, terrain]);

  /**
   * Sets a chunk's *draw* count from how far it is from the player.
   *
   * Blades are scattered in random order within a chunk, so drawing the first
   * N of them is an unbiased random thinning — no re-scatter needed. That makes
   * density a single integer write per chunk, cheap enough to redo for all of
   * them every time the player crosses a chunk boundary.
   *
   * Distance thinning is where nearly all the triangle savings come from:
   * blades in the outer rings are a few pixels tall and already half-eaten by
   * the shader's distance fade, so rendering them at full density was spending
   * millions of triangles a frame on nothing.
   */
  const applyRingDensity = useMemo(() => {
    return (chunk: ChunkBuffers, centerCx: number, centerCz: number) => {
      const ring = Math.max(Math.abs(chunk.cx - centerCx), Math.abs(chunk.cz - centerCz));
      const ringT = chunkRadius > 0 ? Math.min(ring / chunkRadius, 1) : 0;
      const density = lerp(
        1,
        VEGETATION.GRASS_FAR_DENSITY,
        Math.pow(ringT, VEGETATION.GRASS_FALLOFF_EXPONENT),
      );
      chunk.geometry.instanceCount = Math.max(0, Math.floor(chunk.count * density));
    };
  }, [chunkRadius]);

  /* Allocate the pool once, at fixed capacity, independent of quality. */
  useEffect(() => {
    if (capacity <= 0) {
      chunks.current = [];
      return;
    }

    const pool: ChunkBuffers[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const geo = new THREE.InstancedBufferGeometry();
      geo.index = baseGeometry.index;
      geo.attributes.position = baseGeometry.attributes.position!;
      geo.attributes.uv = baseGeometry.attributes.uv!;

      const offset = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      const rotation = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
      const scale = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
      const phase = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
      const colorJitter = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      const bend = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);

      /* `setUsage(DynamicDrawUsage)` tells the driver these buffers change, so
       * it picks a memory pool suited to frequent re-upload. Without it, every
       * chunk recycle can stall on a buffer the GPU is still reading. */
      for (const a of [offset, rotation, scale, phase, colorJitter, bend]) {
        a.setUsage(THREE.DynamicDrawUsage);
      }

      geo.setAttribute('aOffset', offset);
      geo.setAttribute('aRotation', rotation);
      geo.setAttribute('aScale', scale);
      geo.setAttribute('aPhase', phase);
      geo.setAttribute('aColorJitter', colorJitter);
      geo.setAttribute('aBend', bend);
      geo.instanceCount = 0;

      // Bounding sphere must be manual — instanced attributes aren't considered
      // by computeBoundingSphere, and frustum culling is disabled anyway.
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), chunkSize * 2);

      pool.push({
        geometry: geo,
        offset,
        rotation,
        scale,
        phase,
        colorJitter,
        bend,
        cx: 99999,
        cz: 99999,
        count: 0,
      });
    }

    chunks.current = pool;
    lastCenter.current = { cx: 9999, cz: 9999 };

    // Attach to the scene graph.
    const group = groupRef.current;
    if (group) {
      group.clear();
      for (const chunk of pool) {
        const mesh = new THREE.Mesh(chunk.geometry, material);
        mesh.frustumCulled = false;
        mesh.receiveShadow = false;
        mesh.castShadow = false;
        group.add(mesh);
      }
    }

    /* Capture the group node now rather than reading `groupRef.current` in the
     * cleanup: by the time cleanup runs React may already have detached the
     * ref, leaving the meshes orphaned in the scene graph. */
    return () => {
      for (const chunk of pool) chunk.geometry.dispose();
      group?.clear();
    };
    /* Deliberately NOT dependent on `bladesPerChunk`. The pool is allocated at
     * fixed capacity, so a quality change must not tear it down and rebuild
     * it — that reallocation is what used to exhaust GPU memory. Density is
     * applied per-chunk via `instanceCount` in the streaming pass below. */
  }, [capacity, totalChunks, baseGeometry, material, chunkSize]);

  /* Re-fill every chunk when the density setting changes, so more (or fewer)
   * blades appear immediately rather than only as chunks recycle. */
  useEffect(() => {
    const { cx, cz } = lastCenter.current;
    for (const chunk of chunks.current) {
      if (chunk.cx === 99999) continue;
      populateChunk(chunk, chunk.cx, chunk.cz);
      applyRingDensity(chunk, cx, cz);
    }
  }, [bladesPerChunk, populateChunk, applyRingDensity]);

  /* Season tint, parsed once. `hexToRgb` returns a fresh array; calling it in
   * `useFrame` allocated 60 throwaway arrays a second to re-derive a constant. */
  const grassTint = useMemo(() => hexToRgb(SEASONS[season].grassTint), [season]);

  /* ── Streaming + uniform sync ─────────────────────────────────────────── */
  useFrame(({ camera }, dt) => {
    const u = material.uniforms;
    u.uCameraPos.value.copy(camera.position);
    u.uSunDirection.value.copy(lighting.sunDirection);
    u.uSunColor.value.copy(lighting.sunColor);
    u.uAmbientColor.value.copy(lighting.ambientColor);
    u.uAmbientIntensity.value = lighting.ambientIntensity;
    u.uFogColor.value.copy(lighting.fogColor);
    u.uFogDensity.value = lighting.fogDensity;

    const s = SEASONS[season];
    const [tr, tg, tb] = grassTint;
    u.uTipColor.value.setRGB(tr, tg, tb);
    u.uBaseColor.value.setRGB(tr * 0.45, tg * 0.5, tb * 0.42);
    u.uSnowCoverage.value += (s.snowCoverage - u.uSnowCoverage.value) * Math.min(dt * 2, 0.1);

    if (chunks.current.length === 0 || bladesPerChunk <= 0) return;

    /* ── Drain the fill queue ────────────────────────────────────────────
     * Filling a chunk means scattering thousands of blades, each needing
     * terrain height, a slope test and possibly a spatial query. Doing a
     * whole boundary crossing's worth in one frame is a visible stutter
     * every twenty metres walked — it was the entire p95 frame-time spike.
     * Two chunks per frame clears a crossing in about nine frames, well
     * before the player reaches the next boundary. */
    if (fillQueue.current.length > 0) {
      const budget = Math.min(2, fillQueue.current.length);
      for (let i = 0; i < budget; i++) {
        const job = fillQueue.current.shift();
        if (!job) break;
        populateChunk(job.chunk, job.cx, job.cz);
        applyRingDensity(job.chunk, lastCenter.current.cx, lastCenter.current.cz);
      }
    }

    /* Recycle chunks when the player crosses a boundary. Only the chunks that
     * have fallen outside the window are re-populated — typically one row or
     * column, not all of them. */
    const cx = Math.floor(camera.position.x / chunkSize);
    const cz = Math.floor(camera.position.z / chunkSize);
    if (cx === lastCenter.current.cx && cz === lastCenter.current.cz) return;
    lastCenter.current = { cx, cz };

    // Which cells should be occupied?
    const wanted = new Set<string>();
    for (let dz = -chunkRadius; dz <= chunkRadius; dz++) {
      for (let dx = -chunkRadius; dx <= chunkRadius; dx++) {
        wanted.add(`${cx + dx},${cz + dz}`);
      }
    }

    // Chunks already in the right place keep their contents.
    const occupied = new Set<string>();
    const stale: ChunkBuffers[] = [];
    for (const chunk of chunks.current) {
      const key = `${chunk.cx},${chunk.cz}`;
      if (wanted.has(key) && !occupied.has(key)) occupied.add(key);
      else stale.push(chunk);
    }

    /* Queue the stale chunks for refilling rather than doing it now. They
     * keep drawing their old contents until their turn comes, which is
     * invisible — they are at the far edge of the window, behind the
     * distance fade. */
    fillQueue.current.length = 0;
    let staleIndex = 0;
    for (const key of wanted) {
      if (occupied.has(key)) continue;
      const chunk = stale[staleIndex++];
      if (!chunk) break;
      const [nx, nz] = key.split(',').map(Number) as [number, number];
      // Claim the cell immediately so the next crossing doesn't re-queue it.
      chunk.cx = nx;
      chunk.cz = nz;
      chunk.geometry.instanceCount = 0;
      fillQueue.current.push({ chunk, cx: nx, cz: nz });
    }

    /* Every chunk's ring distance has changed, including the ones that stayed
     * put — so re-apply density across the board. This is one integer write
     * per chunk, not a re-scatter, so doing all of them is trivial. */
    for (const chunk of chunks.current) {
      if (chunk.cx === 99999) continue;
      applyRingDensity(chunk, cx, cz);
    }
  });

  /* The group always mounts, even at zero density — unmounting it would
   * destroy the pool and reallocating it on the way back is exactly the
   * churn this design exists to avoid. At zero density every chunk simply
   * draws nothing. */
  return <group ref={groupRef} name="grass" />;
}

/* ───────────────────────────────────────────────────────────────────────────
 * WHEAT
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The wheatfield around the windmill.
 *
 * Unlike grass this is *not* streamed — the field is a fixed, bounded area, so
 * it is built once as a single instanced mesh. 42 000 stalks in one draw call.
 */
export function Wheatfield() {
  const { terrain, windUniforms } = useWorld();
  const lighting = useLighting();
  const season = useGameStore((s) => s.season);
  const density = useSettingsStore((s) => s.graphics.grassDensity);

  // Wheat stalks are a little thicker than grass blades.
  const baseGeometry = useMemo(() => createBladeGeometry(3, 0.16), []);

  const { geometry, count } = useMemo(() => {
    const zone = ZONES.WHEAT_AND_WINDMILL;
    const target = Math.floor(VEGETATION.WHEAT_COUNT * Math.min(density, 1.2));
    const rand = mulberry32(0xa1fa1fa);

    const offsets = new Float32Array(target * 3);
    const rotations = new Float32Array(target);
    const scales = new Float32Array(target);
    const phases = new Float32Array(target);
    const jitters = new Float32Array(target * 3);

    let written = 0;
    for (let i = 0; i < target * 2 && written < target; i++) {
      // Sample within the zone disc.
      const a = rand() * Math.PI * 2;
      const r = zone.radius * Math.sqrt(rand());
      const x = zone.center[0] + Math.cos(a) * r;
      const z = zone.center[1] + Math.sin(a) * r;

      const y = terrain.heightAt(x, z);
      if (y < WORLD.WATER_LEVEL + 1) continue;
      if (terrain.slopeAt(x, z) > 0.42) continue;
      if (RAIL_QUERY.nearest(x, z).distance < 9) continue;
      if (ROAD_QUERY.nearest(x, z).distance < 3) continue;
      // Leave a clearing around the windmill itself.
      if (Math.hypot(x - zone.center[0], z - zone.center[1]) < 9) continue;

      const o = written * 3;
      offsets[o] = x;
      offsets[o + 1] = y;
      offsets[o + 2] = z;
      rotations[written] = rand() * Math.PI * 2;
      scales[written] = 1.15 + rand() * 0.5;
      phases[written] = rand() * Math.PI * 2;
      jitters[o] = rand();
      jitters[o + 1] = rand();
      jitters[o + 2] = rand();
      written++;
    }

    const geo = new THREE.InstancedBufferGeometry();
    geo.index = baseGeometry.index;
    geo.attributes.position = baseGeometry.attributes.position!;
    geo.attributes.uv = baseGeometry.attributes.uv!;
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3));
    geo.setAttribute('aRotation', new THREE.InstancedBufferAttribute(rotations, 1));
    geo.setAttribute('aScale', new THREE.InstancedBufferAttribute(scales, 1));
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
    geo.setAttribute('aColorJitter', new THREE.InstancedBufferAttribute(jitters, 3));
    geo.instanceCount = written;
    geo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(zone.center[0], 10, zone.center[1]),
      zone.radius * 1.5,
    );

    return { geometry: geo, count: written };
  }, [terrain, density, baseGeometry]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: WHEAT_VERTEX,
        fragmentShader: WHEAT_FRAGMENT,
        uniforms: {
          uTime: windUniforms.uTime,
          uWindDirection: windUniforms.uWindDirection,
          uWindStrength: windUniforms.uWindStrength,
          uRipplePhase: windUniforms.uRipplePhase,
          uRippleWavelength: windUniforms.uRippleWavelength,
          uCameraPos: { value: new THREE.Vector3() },
          uFadeStart: { value: 150 },
          uFadeEnd: { value: 210 },
          uStalkColor: { value: new THREE.Color('#b8a05a') },
          uHeadColor: { value: new THREE.Color('#e8cf8a') },
          uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
          uSunColor: { value: new THREE.Color('#ffb457') },
          uAmbientColor: { value: new THREE.Color('#9a95c8') },
          uAmbientIntensity: { value: 0.5 },
          uFogColor: { value: new THREE.Color('#f0c99a') },
          uFogDensity: { value: 0.008 },
        },
        side: THREE.DoubleSide,
        fog: false,
      }),
    [windUniforms],
  );

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
      baseGeometry.dispose();
    },
    [geometry, material, baseGeometry],
  );

  /* The colour the crop is easing toward. Built once per season rather than
   * twice per frame — `new THREE.Color()` in a `useFrame` body is 120 dead
   * objects a second for a value that only changes when the season turns. */
  const seasonWheat = useMemo(
    () => ({
      head: new THREE.Color(
        season === 'spring' ? '#b8c46a' : season === 'winter' ? '#a89878' : '#e8cf8a',
      ),
      stalk: new THREE.Color(
        season === 'spring' ? '#8aa84a' : season === 'winter' ? '#9a8f78' : '#b8a05a',
      ),
    }),
    [season],
  );

  useFrame(({ camera }) => {
    const u = material.uniforms;
    u.uCameraPos.value.copy(camera.position);
    u.uSunDirection.value.copy(lighting.sunDirection);
    u.uSunColor.value.copy(lighting.sunColor);
    u.uAmbientColor.value.copy(lighting.ambientColor);
    u.uAmbientIntensity.value = lighting.ambientIntensity;
    u.uFogColor.value.copy(lighting.fogColor);
    u.uFogDensity.value = lighting.fogDensity;

    // Wheat is green in spring, gold in summer, cut stubble in winter.
    u.uHeadColor.value.lerp(seasonWheat.head, 0.02);
    u.uStalkColor.value.lerp(seasonWheat.stalk, 0.02);
  });

  if (count === 0) return null;

  return <mesh geometry={geometry} material={material} frustumCulled={false} name="wheat" />;
}
