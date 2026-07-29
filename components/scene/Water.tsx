/**
 * The pond and the brook.
 *
 * @module components/scene/Water
 */

'use client';

import { useEffect, useMemo, useRef, useCallback } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { useWorld } from './TerrainContext';
import { useLighting } from '@/hooks/useTimeOfDay';
import { useWindField } from '@/hooks/useWind';
import { useGameStore } from '@/store/gameStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  WATER_VERTEX,
  WATER_FRAGMENT,
  STREAM_VERTEX,
  STREAM_FRAGMENT,
} from '@/shaders/water.glsl';
import { waterNormalTexture } from '@/lib/textures/procedural';
import { POND, BROOK_POLYLINE, BROOK_WIDTH } from '@/lib/world/layout';
import { WORLD, PERFORMANCE } from '@/config/game';
import { Throttle } from '@/lib/utils/perf';
import { damp } from '@/lib/utils/math';

/** A ripple the player has caused, for the water shader. */
interface Ripple {
  x: number;
  z: number;
  /** Shader time at which the impact happened. */
  startTime: number;
}

/**
 * Global ripple registry.
 *
 * Lives outside React because ripples are spawned from interaction handlers,
 * physics callbacks and the fish system — none of which should have to be
 * wired to the water component through props.
 */
const rippleQueue: Ripple[] = [];
let shaderClock = 0;

/**
 * Spawns a ripple at a world position.
 * Called by the stone-skipping minigame, jumping fish and rain.
 */
export function spawnWaterRipple(x: number, z: number): void {
  rippleQueue.push({ x, z, startTime: shaderClock });
  // The shader has eight ripple slots; keep only the newest.
  if (rippleQueue.length > 8) rippleQueue.shift();
}

export function Pond() {
  const lighting = useLighting();
  const wind = useWindField();
  const season = useGameStore((s) => s.season);
  const weather = useGameStore((s) => s.weather);
  const reflectionEnabled = useSettingsStore((s) => s.graphics.waterReflection);
  const { gl, scene, camera } = useThree();

  const meshRef = useRef<THREE.Mesh>(null);
  const frozen = useRef(0);
  const reflectionTick = useMemo(() => new Throttle(PERFORMANCE.REFLECTION_HZ), []);

  /* ── Reflection probe ────────────────────────────────────────────────────
   * A planar reflection rendered by mirroring the camera through the water
   * plane. Quarter resolution and 15 Hz: a reflection is a low-frequency
   * signal viewed through a distorting normal map, so neither the pixels nor
   * the frames are missed — and it costs a quarter of a full extra pass. */
  const reflectionTarget = useMemo(() => {
    if (!reflectionEnabled) return null;
    const size = 512;
    const rt = new THREE.WebGLRenderTarget(size, size, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    return rt;
  }, [reflectionEnabled]);

  const reflectionCamera = useMemo(() => new THREE.PerspectiveCamera(), []);

  useEffect(() => () => reflectionTarget?.dispose(), [reflectionTarget]);

  const geometry = useMemo(() => {
    /* A disc rather than a plane, sized to the pond, with enough radial
     * segments that the Gerstner vertex displacement has something to move. */
    const geo = new THREE.CircleGeometry(POND.radius + 2.5, 96, 1);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }, []);

  useEffect(() => () => geometry.dispose(), [geometry]);

  const material = useMemo(() => {
    const rippleArray = Array.from({ length: 8 }, () => new THREE.Vector3(0, -999, 0));
    return new THREE.ShaderMaterial({
      vertexShader: WATER_VERTEX,
      fragmentShader: WATER_FRAGMENT,
      uniforms: {
        uNormalMap: { value: waterNormalTexture(512) },
        uReflectionMap: { value: reflectionTarget?.texture ?? null },
        uHasReflection: { value: reflectionTarget ? 1 : 0 },
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color('#ffb457') },
        uSunIntensity: { value: 2.3 },
        uSkyColor: { value: new THREE.Color('#8fc3f0') },
        uAmbientColor: { value: new THREE.Color('#9a95c8') },
        uAmbientIntensity: { value: 0.5 },
        uFogColor: { value: new THREE.Color('#f0c99a') },
        uFogDensity: { value: 0.008 },
        uCameraPos: { value: new THREE.Vector3() },
        uShallowColor: { value: new THREE.Color('#4e7a63') },
        uDeepColor: { value: new THREE.Color('#12303a') },
        uWaterLevel: { value: WORLD.WATER_LEVEL },
        uTime: { value: 0 },
        uWaveHeight: { value: 0.13 },
        uWindDirection: { value: new THREE.Vector2(1, 0) },
        uWindStrength: { value: 0.4 },
        uCausticStrength: { value: 0.9 },
        uFrozen: { value: 0 },
        uRainRipples: { value: 0 },
        uRippleOrigins: { value: rippleArray },
        uRippleCount: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
  }, [reflectionTarget]);

  useEffect(() => () => material.dispose(), [material]);

  /* Renders the mirrored view into the reflection target. */
  const renderReflection = useCallback(() => {
    if (!reflectionTarget || !meshRef.current) return;

    const waterY = WORLD.WATER_LEVEL;

    /* Mirror the camera through the horizontal water plane: negate the Y
     * position about the plane, and flip the pitch. This is the classic planar
     * reflection setup and is exact for a flat surface. */
    reflectionCamera.copy(camera as THREE.PerspectiveCamera);
    reflectionCamera.position.set(camera.position.x, 2 * waterY - camera.position.y, camera.position.z);

    const target = _reflTarget.set(0, 0, -1).applyQuaternion(camera.quaternion).add(camera.position);
    target.y = 2 * waterY - target.y;
    reflectionCamera.up.set(0, 1, 0);
    reflectionCamera.lookAt(target);
    // The mirrored view is handed-flipped; scale X to correct the winding.
    reflectionCamera.scale.set(-1, 1, 1);
    reflectionCamera.updateMatrixWorld();
    reflectionCamera.updateProjectionMatrix();

    // Hide the water itself so it can't reflect into its own probe.
    const mesh = meshRef.current;
    mesh.visible = false;

    const prevTarget = gl.getRenderTarget();
    gl.setRenderTarget(reflectionTarget);
    gl.clear();
    gl.render(scene, reflectionCamera);
    gl.setRenderTarget(prevTarget);

    mesh.visible = true;
  }, [reflectionTarget, reflectionCamera, camera, gl, scene]);

  useFrame((_, dt) => {
    const u = material.uniforms;
    shaderClock += dt;
    u.uTime.value = shaderClock;

    u.uSunDirection.value.copy(lighting.sunDirection);
    u.uSunColor.value.copy(lighting.sunColor);
    u.uSunIntensity.value = lighting.sunIntensity * 0.5;
    u.uSkyColor.value.copy(lighting.skyTint);
    u.uAmbientColor.value.copy(lighting.ambientColor);
    u.uAmbientIntensity.value = lighting.ambientIntensity;
    u.uFogColor.value.copy(lighting.fogColor);
    u.uFogDensity.value = lighting.fogDensity;
    u.uCameraPos.value.copy(camera.position);
    u.uWindDirection.value.copy(wind.vector);
    u.uWindStrength.value = wind.strength;

    // Freeze over in winter, thaw slowly.
    const targetFrozen = season === 'winter' ? 1 : 0;
    frozen.current = damp(frozen.current, targetFrozen, 4, dt);
    u.uFrozen.value = frozen.current;

    u.uRainRipples.value =
      weather === 'storm' ? 1 : weather === 'lightRain' ? 0.45 : 0;

    // Push the ripple queue into the shader.
    const arr = u.uRippleOrigins.value as THREE.Vector3[];
    for (let i = 0; i < arr.length; i++) {
      const r = rippleQueue[i];
      if (r) arr[i]!.set(r.x, r.startTime, r.z);
      else arr[i]!.set(0, -999, 0);
    }
    u.uRippleCount.value = Math.min(rippleQueue.length, 8);

    // Expire ripples older than four seconds.
    while (rippleQueue.length > 0 && shaderClock - rippleQueue[0]!.startTime > 4) {
      rippleQueue.shift();
    }

    if (reflectionEnabled && reflectionTick.step(dt)) renderReflection();
  });

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      position={[POND.center[0], WORLD.WATER_LEVEL, POND.center[1]]}
      renderOrder={10}
      name="pond"
    />
  );
}

const _reflTarget = new THREE.Vector3();

/**
 * The brook.
 *
 * Built as a ribbon following the stream polyline, with per-vertex flow
 * direction baked from the curve tangent. The flow-map shader then advects the
 * normal map along that field, so the water visibly runs downhill and around
 * every bend.
 */
export function Brook() {
  const { terrain } = useWorld();
  const lighting = useLighting();
  const { camera } = useThree();

  const geometry = useMemo(() => {
    const poly = BROOK_POLYLINE;
    const positions: number[] = [];
    const uvs: number[] = [];
    const flows: number[] = [];
    const speeds: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const prev = poly[Math.max(0, i - 1)]!;
      const next = poly[Math.min(poly.length - 1, i + 1)]!;

      // Tangent along the stream, and the perpendicular that gives it width.
      const tx = next[0] - prev[0];
      const tz = next[2] - prev[2];
      const tLen = Math.hypot(tx, tz) || 1;
      const nx = -tz / tLen;
      const nz = tx / tLen;

      const y = terrain.heightAt(p[0], p[2]) + 0.12;

      // Slope drives flow speed — steeper reaches run faster and whiter.
      const drop = terrain.heightAt(prev[0], prev[2]) - terrain.heightAt(next[0], next[2]);
      const slope = Math.max(0.25, Math.min(2.5, drop * 0.6 + 0.6));

      positions.push(p[0] + nx * BROOK_WIDTH, y, p[2] + nz * BROOK_WIDTH);
      positions.push(p[0] - nx * BROOK_WIDTH, y, p[2] - nz * BROOK_WIDTH);

      const v = i / (poly.length - 1);
      uvs.push(0, v, 1, v);

      flows.push(tx / tLen, tz / tLen);
      flows.push(tx / tLen, tz / tLen);
      speeds.push(slope, slope);

      if (i < poly.length - 1) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('aFlowDirection', new THREE.Float32BufferAttribute(flows, 2));
    geo.setAttribute('aFlowSpeed', new THREE.Float32BufferAttribute(speeds, 1));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }, [terrain]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: STREAM_VERTEX,
        fragmentShader: STREAM_FRAGMENT,
        uniforms: {
          uNormalMap: { value: waterNormalTexture(512) },
          uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
          uSunColor: { value: new THREE.Color('#ffb457') },
          uSunIntensity: { value: 2.3 },
          uSkyColor: { value: new THREE.Color('#8fc3f0') },
          uFogColor: { value: new THREE.Color('#f0c99a') },
          uFogDensity: { value: 0.008 },
          uCameraPos: { value: new THREE.Vector3() },
          uShallowColor: { value: new THREE.Color('#6a9a80') },
          uDeepColor: { value: new THREE.Color('#2c5a54') },
          uTime: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      }),
    [],
  );

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
    u.uSunDirection.value.copy(lighting.sunDirection);
    u.uSunColor.value.copy(lighting.sunColor);
    u.uSunIntensity.value = lighting.sunIntensity * 0.5;
    u.uSkyColor.value.copy(lighting.skyTint);
    u.uFogColor.value.copy(lighting.fogColor);
    u.uFogDensity.value = lighting.fogDensity;
    u.uCameraPos.value.copy(camera.position);
  });

  return <mesh geometry={geometry} material={material} renderOrder={9} name="brook" />;
}

/** Lily pads floating on the pond. */
export function LilyPads() {
  const count = 22;

  const { geometry, material, matrices } = useMemo(() => {
    const geo = new THREE.CircleGeometry(0.55, 10);
    geo.rotateX(-Math.PI / 2);
    // Notch: rotate the UVs so the classic lily-pad wedge reads.
    const mat = new THREE.MeshStandardMaterial({
      color: '#3f6b38',
      roughness: 0.62,
      metalness: 0,
      side: THREE.DoubleSide,
    });

    const mats: THREE.Matrix4[] = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 * 3.7;
      const r = POND.radius * (0.25 + ((i * 37) % 60) / 100);
      const x = POND.center[0] + Math.cos(a) * r;
      const z = POND.center[1] + Math.sin(a) * r;
      const s = 0.7 + ((i * 13) % 60) / 100;
      mats.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(x, WORLD.WATER_LEVEL + 0.04, z),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a * 2.3),
          new THREE.Vector3(s, 1, s),
        ),
      );
    }
    return { geometry: geo, material: mat, matrices: mats };
  }, []);

  const meshRef = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
  }, [matrices]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  /* Pads bob gently on the surface. Updating the whole instance matrix every
   * frame for 22 objects is trivial, and the motion sells the water as liquid
   * rather than a textured plane. */
  useFrame(({ clock }) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const t = clock.elapsedTime;
    for (let i = 0; i < matrices.length; i++) {
      const m = matrices[i]!;
      _padPos.setFromMatrixPosition(m);
      _padPos.y = WORLD.WATER_LEVEL + 0.04 + Math.sin(t * 0.9 + i * 1.7) * 0.035;
      _padMat.copy(m);
      _padMat.setPosition(_padPos);
      mesh.setMatrixAt(i, _padMat);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, count]}
      receiveShadow
      renderOrder={11}
      name="lily-pads"
    />
  );
}

const _padPos = new THREE.Vector3();
const _padMat = new THREE.Matrix4();
