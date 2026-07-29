/**
 * The terrain mesh and its physics collider.
 *
 * @module components/scene/Terrain
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RigidBody, TrimeshCollider, CuboidCollider } from '@react-three/rapier';
import * as THREE from 'three';

import { useWorld } from './TerrainContext';
import { useLighting } from '@/hooks/useTimeOfDay';
import { useGameStore } from '@/store/gameStore';
import { useSettingsStore } from '@/store/settingsStore';
import { TERRAIN_VERTEX, TERRAIN_FRAGMENT } from '@/shaders/terrain.glsl';
import {
  grassTexture,
  dirtTexture,
  rockTexture,
  sandTexture,
} from '@/lib/textures/procedural';
import { WORLD, SEASONS, WEATHER, SHADOW_CONFIG } from '@/config/game';
import { hexToRgb, damp } from '@/lib/utils/math';

export function Terrain() {
  const { terrain } = useWorld();
  const lighting = useLighting();
  const season = useGameStore((s) => s.season);
  const weather = useGameStore((s) => s.weather);
  const shadows = useSettingsStore((s) => s.graphics.shadows);

  const meshRef = useRef<THREE.Mesh>(null);
  /** Smoothed wetness so rain starting doesn't snap the ground to soaked. */
  const wetness = useRef(0);

  /* ── Geometry ────────────────────────────────────────────────────────────
   * Built once per terrain. This is the single most expensive synchronous
   * operation at load (~250 ms for 256²) which is why the loading screen shows
   * a "meshing" phase. */
  const geometry = useMemo(() => terrain.buildGeometry(WORLD.MESH_SEGMENTS), [terrain]);

  /* Collision mesh at half the visual resolution. See `buildColliderMesh` for
   * why this is a trimesh rather than Rapier's heightfield collider. */
  const collider = useMemo(
    () => terrain.buildColliderMesh(WORLD.COLLIDER_SEGMENTS),
    [terrain],
  );

  useEffect(() => () => geometry.dispose(), [geometry]);

  /* ── Material ────────────────────────────────────────────────────────────
   * A RawShaderMaterial would be simpler, but ShaderMaterial gives us three.js's
   * tone-mapping and colour-space chunks for free, which the scene needs to
   * match the postprocessing pipeline exactly. */
  const material = useMemo(() => {
    const uniforms = {
      uGrassTex: { value: grassTexture(512, false) },
      uDirtTex: { value: dirtTexture(512) },
      uRockTex: { value: rockTexture(512) },
      uSandTex: { value: sandTexture(512) },

      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color('#ffb457') },
      uSunIntensity: { value: 2.3 },
      uAmbientColor: { value: new THREE.Color('#9a95c8') },
      uAmbientIntensity: { value: 0.5 },
      uFogColor: { value: new THREE.Color('#f0c99a') },
      uFogDensity: { value: 0.008 },
      uCameraPos: { value: new THREE.Vector3() },

      uGrassTint: { value: new THREE.Color('#9dbe4e') },
      uSnowCoverage: { value: 0 },
      uWetness: { value: 0 },
      /* Two tiling scales, deliberately non-harmonic (0.045 vs 0.31) so their
       * repeat periods never coincide. Harmonically related scales would
       * reinforce each other's tiling instead of hiding it. */
      uTextureScale: { value: 0.045 },
      uDetailScale: { value: 0.31 },
      uTime: { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader: TERRAIN_VERTEX,
      fragmentShader: TERRAIN_FRAGMENT,
      uniforms,
      // Terrain is always opaque and always front-facing.
      side: THREE.FrontSide,
      // `fog: false` because the shader implements its own height-attenuated fog.
      fog: false,
    });
    return mat;
  }, []);

  useEffect(() => () => material.dispose(), [material]);

  /* ── Per-frame uniform sync ──────────────────────────────────────────── */
  useFrame(({ camera }, dt) => {
    const u = material.uniforms;
    u.uSunDirection.value.copy(lighting.sunDirection);
    u.uSunColor.value.copy(lighting.sunColor);
    /* The grass shader uses a *wrapped* diffuse term, which stays bright well
     * past the terminator; the terrain uses a plain Lambert one, which does
     * not. At golden hour — a very low sun — that mismatch left the ground
     * reading almost black beneath brightly lit grass. Matching the exposure
     * here brings the two back into the same picture. */
    u.uSunIntensity.value = lighting.sunIntensity * 0.95;
    u.uAmbientColor.value.copy(lighting.ambientColor);
    // Ambient floor so the ground never falls to pure black when the sun is
    // on the horizon or fully occluded by cloud.
    u.uAmbientIntensity.value = Math.max(lighting.ambientIntensity, 0.34);
    u.uFogColor.value.copy(lighting.fogColor);
    u.uFogDensity.value = lighting.fogDensity;
    u.uCameraPos.value.copy(camera.position);
    u.uTime.value += dt;

    // Season drives snow and the grass tint.
    const s = SEASONS[season];
    u.uSnowCoverage.value = damp(u.uSnowCoverage.value, s.snowCoverage, 1.2, dt);
    const [r, g, b] = hexToRgb(s.grassTint);
    u.uGrassTint.value.setRGB(r * 1.6, g * 1.6, b * 1.6);

    /* Ground dries out much more slowly than it wets. Asymmetric half-lives
     * (2 s to soak, 14 s to dry) is a small detail that makes weather feel like
     * it has consequences. */
    const targetWet = WEATHER[weather]?.rain ?? 0;
    const halfLife = targetWet > wetness.current ? 2 : 14;
    wetness.current = damp(wetness.current, targetWet, halfLife, dt);
    u.uWetness.value = wetness.current;
  });

  const castShadow = SHADOW_CONFIG[shadows].enabled;

  return (
    <>
      <mesh
        ref={meshRef}
        geometry={geometry}
        material={material}
        receiveShadow={castShadow}
        frustumCulled={false}
        name="terrain"
      />

      {/* Static physics body. One rigid body holding one trimesh — Rapier
          builds a BVH over it at construction and it costs nothing per step. */}
      <RigidBody type="fixed" colliders={false} name="terrain-body">
        <TrimeshCollider args={[collider.vertices, collider.indices]} friction={0.9} />
      </RigidBody>

      <WorldBounds />
    </>
  );
}

/**
 * Invisible walls at the map edge.
 *
 * Cheaper and more reliable than clamping the player's position in the
 * controller: the character controller resolves the collision naturally, so the
 * player slides along the boundary instead of stopping dead.
 */
function WorldBounds() {
  const half = WORLD.HALF - WORLD.BOUNDARY_MARGIN;
  const halfHeight = 45;
  const halfThickness = 1;

  return (
    <RigidBody type="fixed" colliders={false} name="world-bounds">
      {/* North / South */}
      <CuboidCollider args={[half, halfHeight, halfThickness]} position={[0, halfHeight, -half]} />
      <CuboidCollider args={[half, halfHeight, halfThickness]} position={[0, halfHeight, half]} />
      {/* East / West */}
      <CuboidCollider args={[halfThickness, halfHeight, half]} position={[-half, halfHeight, 0]} />
      <CuboidCollider args={[halfThickness, halfHeight, half]} position={[half, halfHeight, 0]} />
    </RigidBody>
  );
}
