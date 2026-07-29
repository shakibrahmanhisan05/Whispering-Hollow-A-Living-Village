/**
 * Adaptive quality and frame-rate limiting.
 *
 * Watches the frame time and steps the graphics preset down when the player is
 * consistently below target, and back up when there is headroom. The hysteresis
 * lives in {@link AdaptiveQualityMonitor} — see there for why a naive
 * "drop quality if FPS < 40" check produces a game that oscillates.
 *
 * @module components/scene/AdaptiveQuality
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { useSettingsStore } from '@/store/settingsStore';
import { useGameStore } from '@/store/gameStore';
import { ui } from '@/store/uiState';
import { pushToast } from '@/store/uiState';
import { AdaptiveQualityMonitor, computeDpr } from '@/lib/utils/perf';
import { QUALITY_PRESETS, type QualityPresetId } from '@/config/game';

/** The tier ladder, ordered cheapest to most expensive. */
const LADDER: Array<Exclude<QualityPresetId, 'custom'>> = [
  'potato',
  'low',
  'medium',
  'high',
  'cinematic',
];

export function AdaptiveQuality() {
  const { gl, setDpr } = useThree();
  const graphics = useSettingsStore((s) => s.graphics);
  const applyPreset = useSettingsStore((s) => s.applyQualityPreset);
  const phase = useGameStore((s) => s.phase);

  const currentPreset = useRef(graphics.preset);
  currentPreset.current = graphics.preset;

  /* ── Resolution scale ────────────────────────────────────────────────── */
  useEffect(() => {
    setDpr(computeDpr(graphics.resolutionScale));
  }, [graphics.resolutionScale, setDpr]);

  /* ── Shadow map ──────────────────────────────────────────────────────── */
  useEffect(() => {
    gl.shadowMap.enabled = graphics.shadows !== 'off';
    /* PCF, always. `PCFSoftShadowMap` was deprecated in three r182 and now
     * silently falls back to `PCFShadowMap` anyway, logging a warning on every
     * renderer configuration — so asking for it buys nothing but console
     * noise. Shadow softness comes from `shadow-radius` and the cascade
     * configuration in `SceneLighting` instead. */
    gl.shadowMap.type = THREE.PCFShadowMap;
    gl.shadowMap.needsUpdate = true;
  }, [gl, graphics.shadows]);

  /* ── Adaptive monitor ────────────────────────────────────────────────── */
  const monitor = useMemo(
    () =>
      new AdaptiveQualityMonitor(
        () => {
          const index = LADDER.indexOf(currentPreset.current as Exclude<QualityPresetId, 'custom'>);
          // Never touch a manually-customised configuration.
          if (index <= 0) return;
          const next = LADDER[index - 1]!;
          applyPreset(next);
          ui.effectiveQuality = next;
          pushToast({
            kind: 'info',
            title: 'Graphics lowered',
            body: `Switched to ${QUALITY_PRESETS[next].label} to keep the framerate steady. Change this in Settings → Graphics.`,
            icon: '⚙️',
            ttl: 6000,
          });
        },
        () => {
          const index = LADDER.indexOf(currentPreset.current as Exclude<QualityPresetId, 'custom'>);
          if (index < 0 || index >= LADDER.length - 1) return;
          /* Only ever climb back to High automatically. Cinematic is an
           * explicit choice — auto-selecting it on a machine that briefly hits
           * 60 FPS in a quiet corner is a good way to tank the framerate the
           * moment the player walks into the village. */
          const next = LADDER[Math.min(index + 1, LADDER.indexOf('high'))]!;
          if (next === currentPreset.current) return;
          applyPreset(next);
          ui.effectiveQuality = next;
        },
      ),
    [applyPreset],
  );

  /* ── Frame limiter ───────────────────────────────────────────────────── */

  const fpsAccumulator = useRef(0);
  const fpsFrames = useRef(0);

  useFrame((_, dt) => {
    if (phase !== 'playing' && phase !== 'photo' && phase !== 'seated') return;

    /* Adaptive quality only runs when the player has asked for it, and only
     * while a named preset is active — a Custom configuration is the player's
     * business, not ours. */
    if (graphics.adaptiveQuality && graphics.preset !== 'custom') {
      monitor.update(dt);
    }

    // FPS readout for the debug HUD, averaged over half a second.
    fpsAccumulator.current += dt;
    fpsFrames.current++;
    if (fpsAccumulator.current >= 0.5) {
      ui.fps = Math.round(fpsFrames.current / fpsAccumulator.current);
      ui.drawCalls = gl.info.render.calls;
      ui.triangles = gl.info.render.triangles;
      fpsAccumulator.current = 0;
      fpsFrames.current = 0;
    }
  });

  return null;
}
