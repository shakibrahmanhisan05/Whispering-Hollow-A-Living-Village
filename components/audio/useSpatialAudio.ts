/**
 * React bindings for the synth engine.
 *
 * @module components/audio/useSpatialAudio
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { getSynthEngine, type SpatialSource, type SpatialSourceOptions } from './SynthEngine';
import { useSettingsStore } from '@/store/settingsStore';
import { ui, pushSubtitle } from '@/store/uiState';
import { AUDIO_BUSES } from '@/config/game';

/** Returns the process-wide engine instance. Stable across renders. */
export function useSynthEngine() {
  return useMemo(() => getSynthEngine(), []);
}

/**
 * Creates a spatial source bound to a component's lifetime.
 *
 * The source is created lazily on first frame after the engine is ready — the
 * engine only exists after a user gesture, so components that mount during
 * loading would otherwise get `null` forever.
 *
 * @param options - Panner configuration. Changes to `position` after mount
 *   should go through the returned source's `setPosition`, not this object.
 * @param enabled - Set false to skip creating the source entirely.
 */
export function useSpatialSource(
  options: SpatialSourceOptions,
  enabled = true,
): React.RefObject<SpatialSource | null> {
  const engine = useSynthEngine();
  const ref = useRef<SpatialSource | null>(null);
  // Snapshot the options once; a changing object identity must not rebuild the
  // panner every render.
  const optsRef = useRef(options);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;

    const create = () => {
      if (disposed || ref.current) return;
      ref.current = engine.createSource(optsRef.current);
    };

    if (engine.ready) {
      create();
    } else {
      // Poll until the engine comes up after the first user gesture.
      const timer = setInterval(() => {
        if (engine.ready) {
          create();
          clearInterval(timer);
        }
      }, 250);
      return () => {
        disposed = true;
        clearInterval(timer);
        ref.current?.dispose();
        ref.current = null;
      };
    }

    return () => {
      disposed = true;
      ref.current?.dispose();
      ref.current = null;
    };
  }, [engine, enabled]);

  return ref;
}

/**
 * Drives the Web Audio listener from the R3F camera each frame.
 *
 * Mount exactly once, inside the `<Canvas>`. Also computes the listener's
 * velocity, which the train's Doppler calculation needs.
 */
export function useAudioListener(): React.RefObject<THREE.Vector3> {
  const engine = useSynthEngine();
  const { camera } = useThree();
  const velocity = useRef(new THREE.Vector3());
  const lastPos = useRef(new THREE.Vector3());
  const forward = useRef(new THREE.Vector3());
  const up = useRef(new THREE.Vector3());
  const initialised = useRef(false);

  useFrame((_, dt) => {
    if (!engine.ready || dt <= 0) return;

    camera.getWorldDirection(forward.current);
    up.current.set(0, 1, 0).applyQuaternion(camera.quaternion);

    const p = camera.position;
    if (initialised.current) {
      velocity.current.subVectors(p, lastPos.current).divideScalar(dt);
    } else {
      initialised.current = true;
    }
    lastPos.current.copy(p);

    engine.updateListener(
      p.x,
      p.y,
      p.z,
      forward.current.x,
      forward.current.y,
      forward.current.z,
      up.current.x,
      up.current.y,
      up.current.z,
    );
  });

  return velocity;
}

/**
 * Keeps the engine's bus volumes and HRTF mode in sync with the settings store.
 * Mount once, anywhere.
 */
export function useAudioSettingsSync(): void {
  const engine = useSynthEngine();
  const audio = useSettingsStore((s) => s.audio);

  useEffect(() => {
    if (!engine.ready) return;
    for (const bus of AUDIO_BUSES) engine.setVolume(bus, audio[bus]);
    engine.setHrtf(audio.hrtf);
  }, [engine, audio]);

  // Apply once more as soon as the engine becomes ready, since the effect above
  // no-ops while it is still null.
  useEffect(() => {
    const timer = setInterval(() => {
      if (engine.ready) {
        const a = useSettingsStore.getState().audio;
        for (const bus of AUDIO_BUSES) engine.setVolume(bus, a[bus]);
        engine.setHrtf(a.hrtf);
        clearInterval(timer);
      }
    }, 200);
    return () => clearInterval(timer);
  }, [engine]);
}

/**
 * Emits an accessibility subtitle for a world-space sound event, working out
 * which side of the listener it came from.
 *
 * Only does anything when the "Subtitle-style audio labels" accessibility
 * option is on, so callers can fire it unconditionally.
 *
 * @param icon - Emoji shown before the label.
 * @param text - Description, e.g. "bird chirps".
 * @param worldPos - Where the sound happened.
 * @param camera - The listener.
 */
export function emitAudioSubtitle(
  icon: string,
  text: string,
  worldPos: THREE.Vector3 | [number, number, number],
  camera: THREE.Camera,
): void {
  if (!useSettingsStore.getState().accessibility.audioSubtitles) return;

  const p = Array.isArray(worldPos) ? _tmp.set(...worldPos) : worldPos;
  _toSource.subVectors(p, camera.position);
  _toSource.y = 0;
  if (_toSource.lengthSq() < 1e-6) return;
  _toSource.normalize();

  camera.getWorldDirection(_fwd);
  _fwd.y = 0;
  _fwd.normalize();

  // Right vector is forward × up in a right-handed system.
  _right.crossVectors(_fwd, _worldUp).normalize();

  const dotForward = _fwd.dot(_toSource);
  const dotRight = _right.dot(_toSource);

  let direction: 'left' | 'right' | 'ahead' | 'behind';
  if (dotForward > 0.55) direction = 'ahead';
  else if (dotForward < -0.55) direction = 'behind';
  else direction = dotRight > 0 ? 'right' : 'left';

  pushSubtitle(icon, text, direction);
}

const _tmp = new THREE.Vector3();
const _toSource = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);

/**
 * Attenuates a source's low-pass cutoff with distance.
 *
 * Air absorbs high frequencies, so a distant sound is not merely quieter — it
 * is *darker*. `PannerNode` models the volume falloff but not this, so we apply
 * it per source. It is the single cheapest thing you can do to make a scene
 * sound like it has depth.
 *
 * @param distance - Metres from the listener.
 * @param nearCutoff - Cutoff when adjacent, Hz.
 * @param farCutoff - Cutoff at `maxDistance`, Hz.
 * @param maxDistance - Distance at which `farCutoff` is reached.
 */
export function distanceLowpass(
  distance: number,
  nearCutoff = 18000,
  farCutoff = 900,
  maxDistance = 160,
): number {
  const t = Math.min(distance / maxDistance, 1);
  // Exponential, because absorption is exponential in distance.
  return nearCutoff * Math.pow(farCutoff / nearCutoff, t);
}

/**
 * Convenience: `true` when the player is close enough that a source is worth
 * updating at all. Used to skip per-frame work for the dozens of ambient
 * emitters scattered across the map.
 */
export function withinEarshot(
  sourcePos: THREE.Vector3 | [number, number, number],
  listenerPos: THREE.Vector3,
  radius: number,
): boolean {
  const p = Array.isArray(sourcePos) ? _tmp.set(...sourcePos) : sourcePos;
  return p.distanceToSquared(listenerPos) < radius * radius;
}

/** Global mute when the tab loses focus, so the valley doesn't play to nobody. */
export function usePageVisibilityAudio(): void {
  const engine = useSynthEngine();
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) void engine.suspend();
      else if (ui.pointerLocked || true) void engine.resume();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [engine]);
}
