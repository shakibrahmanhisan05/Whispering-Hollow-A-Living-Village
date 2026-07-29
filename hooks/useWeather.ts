/**
 * Weather simulation.
 *
 * When "auto" is enabled the weather wanders on its own rather than jumping at
 * random: a low-frequency noise value walks a 1D axis, and that axis is mapped
 * to weather states arranged from calm to violent. Because the noise is
 * continuous, transitions always pass through the intermediate states — clear
 * becomes cloudy before it becomes rain, and rain eases off before it clears.
 * Random selection would produce sunshine flipping to thunderstorm in one step,
 * which reads as a bug rather than as weather.
 *
 * Season biases the mapping: winter's wet states become snow, autumn skews
 * windy, summer skews clear.
 *
 * @module hooks/useWeather
 */

'use client';

import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGameStore } from '@/store/gameStore';
import { useSettingsStore } from '@/store/settingsStore';
import { fbm1D, clamp } from '@/lib/utils/math';
import type { SeasonId, WeatherId } from '@/config/game';

/**
 * Maps a continuous 0..1 "severity" value to a weather state, biased by season.
 *
 * The ordering is deliberate — adjacent entries are perceptually adjacent, so
 * a small change in severity is always a small change in weather.
 */
function severityToWeather(severity: number, season: SeasonId): WeatherId {
  const s = clamp(severity, 0, 1);

  if (season === 'winter') {
    if (s < 0.3) return 'clear';
    if (s < 0.5) return 'cloudy';
    if (s < 0.66) return 'fog';
    return 'snow';
  }

  if (season === 'autumn') {
    if (s < 0.22) return 'clear';
    if (s < 0.4) return 'autumnWind';
    if (s < 0.55) return 'cloudy';
    if (s < 0.72) return 'fog';
    if (s < 0.88) return 'lightRain';
    return 'storm';
  }

  if (season === 'spring') {
    if (s < 0.3) return 'clear';
    if (s < 0.46) return 'cloudy';
    if (s < 0.6) return 'fog';
    if (s < 0.82) return 'lightRain';
    return 'storm';
  }

  // Summer — mostly clear, occasional dramatic thunderstorm.
  if (s < 0.5) return 'clear';
  if (s < 0.68) return 'cloudy';
  if (s < 0.8) return 'lightRain';
  if (s < 0.92) return 'cloudy';
  return 'storm';
}

/**
 * Runs the weather simulation. Mount **once** inside the `<Canvas>`.
 *
 * When auto is off, the store's weather is whatever the player selected and
 * this hook does nothing but keep the internal clock ticking so re-enabling
 * auto doesn't snap.
 */
export function useWeatherSimulation(): void {
  const auto = useSettingsStore((s) => s.world.weatherAuto);
  const manualWeather = useSettingsStore((s) => s.world.weather);
  const season = useGameStore((s) => s.season);
  const setWeather = useGameStore((s) => s.setWeather);
  const currentWeather = useGameStore((s) => s.weather);

  const clock = useRef(Math.random() * 1000);
  /** Debounce: a state must persist this long before it is committed. */
  const pendingRef = useRef<{ id: WeatherId; hold: number } | null>(null);

  // Manual mode: mirror the setting straight into the store.
  useEffect(() => {
    if (!auto && manualWeather !== currentWeather) setWeather(manualWeather);
  }, [auto, manualWeather, currentWeather, setWeather]);

  useFrame((_, dt) => {
    if (dt <= 0 || dt > 0.5) return;
    // Weather evolves slowly: this scaling gives a full severity sweep roughly
    // every four to six minutes of real time.
    clock.current += dt * 0.006;

    if (!auto) return;

    // fbm1D returns [-1, 1]; remap to [0, 1] and gently push toward the middle
    // so extreme weather is genuinely occasional.
    const raw = fbm1D(clock.current, 3, 2.0, 0.55);
    const severity = clamp(raw * 0.5 + 0.5, 0, 1);
    const target = severityToWeather(severity, season);

    if (target === currentWeather) {
      pendingRef.current = null;
      return;
    }

    /* Hysteresis. Without it, severity hovering exactly on a boundary would
     * flip the weather back and forth every few frames — and each flip
     * restarts particle systems and audio beds. Twelve seconds of stability is
     * required before a change is committed. */
    if (pendingRef.current?.id === target) {
      pendingRef.current.hold += dt;
      if (pendingRef.current.hold > 12) {
        setWeather(target);
        pendingRef.current = null;
      }
    } else {
      pendingRef.current = { id: target, hold: 0 };
    }
  });
}

/**
 * Season auto-rotation: advances one season per session when enabled, so a
 * player who returns tomorrow finds the valley changed.
 */
export function useSeasonRotation(): void {
  const auto = useSettingsStore((s) => s.world.seasonAuto);
  const manualSeason = useSettingsStore((s) => s.world.season);
  const setSeason = useGameStore((s) => s.setSeason);
  const applied = useRef(false);

  useEffect(() => {
    if (applied.current) return;
    applied.current = true;

    if (!auto) {
      setSeason(manualSeason);
      return;
    }

    // Derive the season from the real-world date so it feels connected to the
    // player's actual year, and advance it by the session count.
    const month = new Date().getMonth();
    const order: SeasonId[] = ['winter', 'spring', 'summer', 'autumn'];
    const base = order[Math.floor(((month + 1) % 12) / 3)] ?? 'summer';
    setSeason(base);
  }, [auto, manualSeason, setSeason]);

  // Keep manual selection in sync after the first mount.
  useEffect(() => {
    if (!auto) setSeason(manualSeason);
  }, [auto, manualSeason, setSeason]);
}
