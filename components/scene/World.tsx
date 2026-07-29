/**
 * Scene assembly.
 *
 * Everything that lives inside the `<Canvas>` is mounted from here, in the
 * order it should be initialised. This component owns nothing itself — it
 * exists to make the composition of the world readable in one place.
 *
 * @module components/scene/World
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { Physics } from '@react-three/rapier';
import * as THREE from 'three';

import { WorldProvider, type WorldContextValue } from './TerrainContext';
import { Terrain } from './Terrain';
import { SkyDome, StarField, SceneLighting, SceneFog, DistantHills } from './Sky';
import { PointLightPool } from './LightPool';
import { Trees } from './Trees';
import { Grass, Wheatfield } from './Grass';
import { Pond, Brook, LilyPads } from './Water';
import { Clouds, Rain, Snow, FallingLeaves, Lightning, GroundMist } from './Weather';
import { Village } from './Village/Village';
import { Track } from './Train/Track';
import { TrainSystem } from './Train/TrainDirector';
import { Birds } from './Wildlife/Birds';
import {
  Fireflies,
  Butterflies,
  Dragonflies,
  Fish,
  Cattle,
  Chickens,
  Fox,
  WindowsillCat,
} from './Wildlife/Critters';
import { SkyLanterns } from './SkyLanterns';

import { PlayerController } from '../player/PlayerController';
import { LocalAvatar } from '../player/Avatar';
import { InteractionSystem, registerInteractable } from '../player/Interactions';
import { GhostAvatars } from '../multiplayer/GhostAvatars';
import { PostProcessing } from '../postfx/PostProcessing';
import { AmbienceSystem } from '../audio/AmbienceSystem';
import { PhotoModeCamera } from '../player/PhotoMode';
import { AdaptiveQuality } from './AdaptiveQuality';
import { IntroCinematic } from './IntroCinematic';

import { useWindSimulation, useWindUniforms, useWindUniformSync, useWindReset } from '@/hooks/useWind';
import { useTimeSimulation } from '@/hooks/useTimeOfDay';
import { useWeatherSimulation, useSeasonRotation } from '@/hooks/useWeather';
import { useAudioListener, useAudioSettingsSync } from '../audio/useSpatialAudio';
import { useSettingsStore } from '@/store/settingsStore';
import { useGameStore } from '@/store/gameStore';
import type { TerrainData } from '@/lib/terrain/generate';
import type { InputState } from '@/hooks/useKeyboard';
import { VILLAGE } from '@/config/game';

export interface WorldProps {
  terrain: TerrainData;
  input: React.RefObject<InputState>;
  /** False while a menu is open or during the intro flyover. */
  inputEnabled: boolean;
}

/**
 * Compiles every material in the scene up front.
 *
 * WebGL compiles a shader the first time it is used to draw something. In a
 * world this varied that means a stall of tens of milliseconds the first time
 * you round a corner and see a species of tree, a wagon livery or a weather
 * state you have not seen yet — exactly the dropped frames that make an
 * otherwise smooth game feel unreliable.
 *
 * `compileAsync` walks the graph and builds every program before the player
 * has control, moving all of that cost into the loading screen where there is
 * nothing to stutter.
 */
function ShaderWarmup() {
  const { gl, scene, camera } = useThree();
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;

    /* One frame's delay so the scene graph is fully populated — compiling an
     * empty scene would achieve nothing.
     *
     * Synchronous `compile`, not `compileAsync`: the async variant polls
     * `KHR_parallel_shader_compile` and throws on materials whose programs it
     * cannot resolve — which the custom `ShaderMaterial`s here trip. Blocking
     * is fine, because this runs while the loading screen is still up. */
    const id = window.setTimeout(() => {
      /* `compile` only walks *visible* objects — and the things most likely to
       * stall are precisely the ones hidden at load: the train (invisible
       * until its ritual begins), rain and snow, the fox, the sky lanterns.
       * Reveal everything for the duration of the compile, then put the
       * visibility flags back exactly as they were. Nothing is rendered in
       * between, so this is invisible to the player. */
      const hidden: THREE.Object3D[] = [];
      scene.traverse((o) => {
        if (!o.visible) {
          hidden.push(o);
          o.visible = true;
        }
      });

      try {
        gl.compile(scene, camera);
      } catch (err) {
        // Warming up is an optimisation; never let it break loading.
        console.warn('[render] Shader warm-up skipped.', err);
      } finally {
        for (const o of hidden) o.visible = false;
      }
    }, 120);

    return () => window.clearTimeout(id);
  }, [gl, scene, camera]);

  return null;
}

export function World({ terrain, input, inputEnabled }: WorldProps) {
  const graphics = useSettingsStore((s) => s.graphics);
  const gameplay = useSettingsStore((s) => s.gameplay);
  const phase = useGameStore((s) => s.phase);

  /* ── Shared simulation ─────────────────────────────────────────────────
   * These four hooks own the world's continuous state. They must run exactly
   * once, at the top of the tree, before anything that reads them. */
  const windUniforms = useWindUniforms();
  useWindSimulation();
  useWindUniformSync(windUniforms);
  useWindReset(terrain.seed);
  useTimeSimulation();
  useWeatherSimulation();
  useSeasonRotation();
  useAudioListener();
  useAudioSettingsSync();

  /* The height texture is built lazily and only when something asks for it.
   * Nothing currently samples terrain elevation in a shader — the grass reads
   * its heights on the CPU at scatter time — so eagerly uploading a 512²
   * float texture was a megabyte of GPU memory and a texture unit spent on
   * nothing. Kept available for future shaders that do want it. */
  const heightTexture = useMemo(() => terrain.buildHeightTexture(), [terrain]);
  useEffect(() => () => heightTexture.dispose(), [heightTexture]);

  const contextValue = useMemo<WorldContextValue>(
    () => ({ terrain, windUniforms, heightTexture }),
    [terrain, windUniforms, heightTexture],
  );

  const inPhotoMode = phase === 'photo';

  /* Cat position — on a windowsill of the first house, resolved once. */
  const catPosition = useMemo<[number, number, number]>(() => {
    const angle = 0;
    const r = VILLAGE.HOUSE_RING_RADIUS;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    return [x + 1.6, terrain.heightAt(x, z) + 1.55, z + 2.6];
  }, [terrain]);

  const catWake = useRef(0);

  useEffect(() => {
    return registerInteractable({
      id: 'windowsill-cat',
      position: new THREE.Vector3(...catPosition),
      label: 'Wake the cat',
      range: 2.6,
      onInteract: () => {
        catWake.current = 1;
      },
    });
  }, [catPosition]);

  return (
    <WorldProvider value={contextValue}>
      {/* ── Atmosphere ──────────────────────────────────────────────────── */}
      <SceneFog />
      <SkyDome />
      <StarField />
      <SceneLighting />
      {/* Every lamp in the village shares these six lights. Mounted here, at
          the root, so the scene's light count never changes for any reason —
          see `components/scene/LightPool` for why that matters so much. */}
      <PointLightPool />
      <DistantHills />
      <Clouds />
      <GroundMist />
      <Lightning />

      {/* ── Physics world ────────────────────────────────────────────────
          Gravity is zero because the character controller applies its own —
          Rapier's gravity would fight it. The only dynamic bodies in the game
          are incidental, so nothing else needs it.

          Everything that contributes a collider must live inside this
          boundary: `<RigidBody>` calls `useRapier()` internally and throws
          outright if it is mounted outside a `<Physics>` provider. That
          includes `<Trees />`, whose 400 trunk colliders are easy to forget
          about because the component reads as pure scenery. */}
      <Physics gravity={[0, 0, 0]} timeStep="vary" paused={phase === 'loading'}>
        <Terrain />
        <Track />
        <Village />
        <TrainSystem />
        <Trees />

        {!inPhotoMode && <PlayerController enabled={inputEnabled} input={input} />}
      </Physics>

      {/* ── Vegetation (no colliders — you walk through grass) ──────────── */}
      <Grass />
      <Wheatfield />

      {/* ── Water ───────────────────────────────────────────────────────── */}
      <Pond />
      <Brook />
      <LilyPads />

      {/* ── Weather particles ───────────────────────────────────────────── */}
      <Rain />
      <Snow />
      <FallingLeaves />

      {/* ── Wildlife ────────────────────────────────────────────────────── */}
      <Birds />
      <Fireflies />
      <Butterflies />
      <Dragonflies />
      <Fish />
      <Cattle />
      <Chickens />
      <Fox />
      <WindowsillCat position={catPosition} wakeSignal={catWake} />

      {/* ── Events ──────────────────────────────────────────────────────── */}
      <SkyLanterns />

      {/* ── Player ──────────────────────────────────────────────────────── */}
      <LocalAvatar visible={gameplay.thirdPerson && !inPhotoMode} />
      <InteractionSystem input={input} />
      <GhostAvatars />
      {inPhotoMode && <PhotoModeCamera input={input} />}
      <IntroCinematic />

      {/* ── Systems ─────────────────────────────────────────────────────── */}
      <AmbienceSystem />
      <AdaptiveQuality />

      <ShaderWarmup />

      {/* ── Post ────────────────────────────────────────────────────────── */}
      {graphics.preset !== 'potato' && <PostProcessing />}
    </WorldProvider>
  );
}
