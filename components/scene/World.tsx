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

import { Physics } from '@react-three/rapier';
import * as THREE from 'three';

import { WorldProvider, type WorldContextValue } from './TerrainContext';
import { Terrain } from './Terrain';
import { SkyDome, StarField, SceneLighting, SceneFog, DistantHills } from './Sky';
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

      {/* ── Post ────────────────────────────────────────────────────────── */}
      {graphics.preset !== 'potato' && <PostProcessing />}
    </WorldProvider>
  );
}
