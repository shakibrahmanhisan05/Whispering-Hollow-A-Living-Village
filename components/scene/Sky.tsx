/**
 * The sky dome, sun, moon, stars and the scene's directional lighting.
 *
 * @module components/scene/Sky
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { useLighting } from '@/hooks/useTimeOfDay';
import { useGameStore } from '@/store/gameStore';
import { useSettingsStore } from '@/store/settingsStore';
import { SKY_VERTEX, SKY_FRAGMENT, STAR_VERTEX, STAR_FRAGMENT } from '@/shaders/sky.glsl';
import { milkyWayTexture } from '@/lib/textures/procedural';
import { TIME, WEATHER, SHADOW_CONFIG, WORLD } from '@/config/game';
import { mulberry32 } from '@/lib/utils/random';
import { clamp } from '@/lib/utils/math';

export function SkyDome() {
  const lighting = useLighting();
  const weather = useGameStore((s) => s.weather);
  const exposure = useSettingsStore((s) => s.graphics.exposure);
  const { camera } = useThree();
  const meshRef = useRef<THREE.Mesh>(null);

  const material = useMemo(() => {
    const uniforms = {
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDirection: { value: new THREE.Vector3(0, -1, 0) },
      uSkyTint: { value: new THREE.Color('#ffc98a') },
      uHorizonColor: { value: new THREE.Color('#f0c99a') },
      uGroundColor: { value: new THREE.Color('#2a2620') },
      uSunIntensity: { value: 2.3 },
      /* Turbidity is the aerosol load. 2 is an alpine winter morning; 8 is a
       * hazy summer afternoon. 3.4 gives a clean sky with enough Mie scattering
       * to produce a warm glow around a low sun. */
      uTurbidity: { value: 3.4 },
      uRayleighScale: { value: 1.0 },
      uMieScale: { value: 1.0 },
      /* g = 0.78: strongly forward-scattering, which produces the tight bright
       * halo hugging the sun. Values above ~0.9 collapse the halo to a point;
       * below ~0.5 it spreads into a uniform haze. */
      uMieG: { value: 0.78 },
      uStarOpacity: { value: 0 },
      uMoonPhase: { value: 0.5 },
      uCloudCover: { value: 0.18 },
      uTime: { value: 0 },
      uMilkyWay: { value: milkyWayTexture(1024, 512) },
      uExposure: { value: 1 },
    };

    return new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      uniforms,
      // Rendered from inside, so only back faces are visible.
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
  }, []);

  useEffect(() => () => material.dispose(), [material]);

  useFrame((_, dt) => {
    const u = material.uniforms;
    u.uSunDirection.value.copy(lighting.sunDirection);
    u.uMoonDirection.value.copy(lighting.moonDirection);
    u.uSkyTint.value.copy(lighting.skyTint);
    u.uHorizonColor.value.copy(lighting.fogColor);
    u.uSunIntensity.value = lighting.sunIntensity;
    u.uStarOpacity.value = lighting.starOpacity;
    u.uMoonPhase.value = lighting.moonPhase;
    u.uCloudCover.value = WEATHER[weather]?.cloudCover ?? 0.2;
    u.uExposure.value = exposure;
    u.uTime.value += dt;

    /* The dome follows the camera so it is always the same apparent size and
     * the player can never walk out of it. Only XZ — keeping Y fixed means the
     * horizon stays put when you climb the ridge, which is correct. */
    if (meshRef.current) {
      meshRef.current.position.set(camera.position.x, 0, camera.position.z);
    }
  });

  return (
    <mesh ref={meshRef} material={material} renderOrder={-1000} frustumCulled={false}>
      {/* Radius sits just inside the camera far plane. 32×16 segments is plenty
          — all the detail is in the fragment shader, not the geometry. */}
      <sphereGeometry args={[TIME.CELESTIAL_DISTANCE * 1.05, 32, 16]} />
    </mesh>
  );
}

/**
 * The star field.
 *
 * 3200 points distributed uniformly on a sphere. The distribution matters: the
 * naive approach of picking random spherical angles clusters heavily at the
 * poles. Sampling `z` uniformly in [−1, 1] and deriving the radius from it
 * gives genuinely uniform coverage — the same reason it is used for sampling
 * directions in path tracers.
 */
export function StarField() {
  const lighting = useLighting();
  const weather = useGameStore((s) => s.weather);
  const { gl, camera } = useThree();
  const pointsRef = useRef<THREE.Points>(null);

  const { geometry, material } = useMemo(() => {
    const count = TIME.STAR_COUNT;
    const positions = new Float32Array(count * 3);
    const magnitudes = new Float32Array(count);
    const phases = new Float32Array(count);
    const colors = new Float32Array(count * 3);
    const rand = mulberry32(0x5741125);
    const radius = TIME.CELESTIAL_DISTANCE;

    for (let i = 0; i < count; i++) {
      // Uniform sphere sampling.
      const z = rand() * 2 - 1;
      const theta = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      positions[i * 3] = Math.cos(theta) * r * radius;
      positions[i * 3 + 1] = z * radius;
      positions[i * 3 + 2] = Math.sin(theta) * r * radius;

      /* Magnitude distribution: a power curve so most stars are faint and only
       * a handful are bright, which is how the real sky looks. A uniform
       * distribution produces an implausible even sprinkle. */
      magnitudes[i] = Math.pow(rand(), 2.6) * 0.9 + 0.1;
      phases[i] = rand();

      /* Colour from an approximate stellar temperature. Most stars are white
       * to yellow-white; a few are notably blue or red, and those few are what
       * make the field look observed rather than generated. */
      const temp = rand();
      let cr: number, cg: number, cb: number;
      if (temp < 0.08) {
        // Blue giants.
        cr = 0.7;
        cg = 0.8;
        cb = 1.0;
      } else if (temp < 0.72) {
        // White / yellow-white main sequence.
        cr = 1.0;
        cg = 0.97;
        cb = 0.92;
      } else if (temp < 0.93) {
        cr = 1.0;
        cg = 0.88;
        cb = 0.7;
      } else {
        // Red giants.
        cr = 1.0;
        cg = 0.72;
        cb = 0.55;
      }
      colors[i * 3] = cr;
      colors[i * 3 + 1] = cg;
      colors[i * 3 + 2] = cb;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aMagnitude', new THREE.BufferAttribute(magnitudes, 1));
    geo.setAttribute('aTwinklePhase', new THREE.BufferAttribute(phases, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERTEX,
      fragmentShader: STAR_FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uPixelRatio: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      // Additive: stars add light to the sky, they don't occlude it.
      blending: THREE.AdditiveBlending,
      fog: false,
    });

    return { geometry: geo, material: mat };
  }, []);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useFrame((_, dt) => {
    const u = material.uniforms;
    u.uTime.value += dt;
    u.uPixelRatio.value = gl.getPixelRatio();
    // Cloud cover occludes the stars.
    u.uOpacity.value =
      lighting.starOpacity * (1 - (WEATHER[weather]?.cloudCover ?? 0) * 0.85);

    /* Rotate the whole field slowly around the celestial pole. Real stars move
     * 15°/hour; scaled to a 12-minute day that is a full revolution per day,
     * which is exactly right and just perceptible if you watch. */
    if (pointsRef.current) {
      pointsRef.current.rotation.y = lighting.t * Math.PI * 2;
      pointsRef.current.rotation.z = 0.4;
      pointsRef.current.position.copy(camera.position);
    }
  });

  // Skip the draw call entirely in daylight.
  if (lighting.starOpacity < 0.01) return null;

  return (
    <points
      ref={pointsRef}
      geometry={geometry}
      material={material}
      frustumCulled={false}
      renderOrder={-999}
    />
  );
}

/**
 * The scene's lights: a directional sun, a directional moon, and hemispheric
 * ambient.
 *
 * The sun's shadow camera **follows the player** rather than covering the whole
 * 400-unit map. A shadow frustum wide enough for the entire valley would give
 * roughly 0.2 m per shadow texel — blobby and useless. Tracking the camera with
 * a ~180 m frustum gives ~0.09 m per texel at High, which resolves individual
 * fence posts.
 */
export function SceneLighting() {
  const lighting = useLighting();
  const shadows = useSettingsStore((s) => s.graphics.shadows);
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const moonRef = useRef<THREE.DirectionalLight>(null);
  const ambientRef = useRef<THREE.HemisphereLight>(null);
  const { camera } = useThree();

  const config = SHADOW_CONFIG[shadows];

  useFrame(() => {
    const sun = sunRef.current;
    if (sun) {
      /* Position the light along the sun direction at a fixed distance from the
       * *player*, and aim its target at the player. This keeps the shadow
       * frustum centred on what the player can actually see. */
      const d = 120;
      sun.position.set(
        camera.position.x + lighting.sunDirection.x * d,
        lighting.sunDirection.y * d,
        camera.position.z + lighting.sunDirection.z * d,
      );
      sun.target.position.set(camera.position.x, 0, camera.position.z);
      sun.target.updateMatrixWorld();

      sun.color.copy(lighting.sunColor);
      // Fade the sun out as it dips below the horizon rather than cutting.
      sun.intensity = lighting.sunIntensity * clamp(lighting.sunElevation * 4 + 0.1, 0, 1);

      /* Deliberately *not* `sun.visible = intensity > 0`.
       *
       * three keys its shader program cache on the number of lights in the
       * scene, and hiding a light removes it from that count — so every
       * material in the world gets recompiled the moment the sun sets, and
       * again when it rises. Measured, that was a 1–3 second freeze at each
       * transition. A directional light at zero intensity adds one multiply
       * per fragment and nothing else, which is far cheaper than a stall.
       *
       * The shadow map is the part actually worth skipping, and
       * `shadow.autoUpdate` skips it without touching `castShadow` — which is
       * itself part of the cache key. */
      sun.shadow.autoUpdate = sun.intensity > 0.01;
    }

    const moon = moonRef.current;
    if (moon) {
      const d = 120;
      moon.position.set(
        camera.position.x + lighting.moonDirection.x * d,
        lighting.moonDirection.y * d,
        camera.position.z + lighting.moonDirection.z * d,
      );
      moon.target.position.set(camera.position.x, 0, camera.position.z);
      moon.target.updateMatrixWorld();
      // Moonlight is cool and weak, and only matters when the sun is gone.
      moon.intensity =
        clamp(lighting.moonDirection.y * 2, 0, 1) * clamp(1 - lighting.sunElevation * 6, 0, 1) * 0.42;
      // Left visible at zero intensity for the same reason as the sun above.
    }

    const amb = ambientRef.current;
    if (amb) {
      amb.color.copy(lighting.skyTint);
      amb.groundColor.copy(lighting.fogColor).multiplyScalar(0.4);
      amb.intensity = lighting.ambientIntensity;
    }
  });

  return (
    <>
      <directionalLight
        ref={sunRef}
        castShadow={config.enabled}
        shadow-mapSize-width={config.mapSize}
        shadow-mapSize-height={config.mapSize}
        shadow-camera-near={1}
        shadow-camera-far={config.far * 2}
        shadow-camera-left={-config.far / 2}
        shadow-camera-right={config.far / 2}
        shadow-camera-top={config.far / 2}
        shadow-camera-bottom={-config.far / 2}
        shadow-bias={config.bias}
        /* Normal bias pushes the shadow sample along the surface normal, which
         * is the correct fix for peter-panning on curved terrain — depth bias
         * alone either leaves acne or detaches contact shadows. */
        shadow-normalBias={0.035}
      />
      <directionalLight ref={moonRef} color="#9fb4e0" intensity={0.2} />
      <hemisphereLight ref={ambientRef} intensity={0.5} />
    </>
  );
}

/**
 * Scene fog.
 *
 * `FogExp2` rather than linear fog: exponential-squared falloff is what
 * atmospheric scattering actually does, and it never produces the hard "wall of
 * fog" that a linear near/far pair does when the camera moves.
 *
 * The custom shaders (terrain, grass, water) implement their own fog because
 * they don't use three.js's material chunks; this handles everything else.
 */
export function SceneFog() {
  const lighting = useLighting();
  const { scene } = useThree();
  const fog = useMemo(() => new THREE.FogExp2(0xf0c99a, 0.008), []);

  useEffect(() => {
    scene.fog = fog;
    return () => {
      scene.fog = null;
    };
  }, [scene, fog]);

  useFrame(() => {
    fog.color.copy(lighting.fogColor);
    fog.density = lighting.fogDensity;
  });

  return null;
}

/** Far-distance backdrop so the world edge never shows sky below the horizon. */
export function DistantHills() {
  const lighting = useLighting();
  const materialRef = useRef<THREE.MeshBasicMaterial>(null);
  const { camera } = useThree();
  const groupRef = useRef<THREE.Group>(null);

  useFrame(() => {
    if (groupRef.current) {
      groupRef.current.position.set(camera.position.x, 0, camera.position.z);
    }
    if (materialRef.current) {
      // Matches the fog exactly, so the ring is invisible as a *ring* and reads
      // purely as haze-obscured distance.
      materialRef.current.color.copy(lighting.fogColor).multiplyScalar(0.92);
    }
  });

  return (
    <group ref={groupRef}>
      <mesh position={[0, 12, 0]} renderOrder={-900}>
        <cylinderGeometry args={[WORLD.SIZE * 1.6, WORLD.SIZE * 1.6, 60, 48, 1, true]} />
        <meshBasicMaterial
          ref={materialRef}
          side={THREE.BackSide}
          fog={false}
          depthWrite={false}
          transparent
          opacity={0.92}
        />
      </mesh>
    </group>
  );
}
