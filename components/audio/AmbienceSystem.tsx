/**
 * The ambience director.
 *
 * Owns every persistent ambient voice and drives them from simulation state:
 * wind strength, time of day, weather, season and the player's position. This
 * is the component that makes the valley *sound* alive rather than merely
 * having sounds in it.
 *
 * Nothing here renders. It is a `null`-returning component mounted inside the
 * `<Canvas>` so it can use `useFrame`.
 *
 * @module components/audio/AmbienceSystem
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { useSynthEngine } from './useSpatialAudio';
import {
  WindVoice,
  LeafRustleVoice,
  StreamVoice,
  CricketChorus,
  FrogVoice,
} from './sources/ambient';
import { WindmillVoice, WindChimeVoice, RainVoice, playThunder } from './sources/village';
import { AmbientMusic } from './sources/music';
import {
  playBirdSong,
  playRoosterCrow,
  playCowMoo,
  playChickenCluck,
  type BirdVoiceId,
} from './sources/wildlife';

import { useGameStore } from '@/store/gameStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useWindField } from '@/hooks/useWind';
import { BIRD_SPECIES } from '@/lib/progression/content';
import { POND, RIDGE_BENCH, BROOK_POLYLINE } from '@/lib/world/layout';
import { ZONES, WEATHER, SEASONS, PRECIPITATION, VILLAGE } from '@/config/game';
import { Throttle } from '@/lib/utils/perf';
import { wrap, clamp } from '@/lib/utils/math';
import { emitAudioSubtitle } from './useSpatialAudio';

/** Returns true when `t` lies inside a possibly-wrapping [start, end) window. */
function inWindow(t: number, window: readonly [number, number]): boolean {
  const [a, b] = window;
  const x = wrap(t, 1);
  return a <= b ? x >= a && x < b : x >= a || x < b;
}

export function AmbienceSystem() {
  const engine = useSynthEngine();
  const { camera } = useThree();
  const wind = useWindField();

  const timeOfDay = useGameStore((s) => s.timeOfDay);
  const weather = useGameStore((s) => s.weather);
  const season = useGameStore((s) => s.season);
  const phase = useGameStore((s) => s.phase);
  const musicEnabled = useSettingsStore((s) => s.audio.ambientMusic);

  /* ── Voice instances ─────────────────────────────────────────────────────
   * Created once and kept for the world's lifetime. `useRef` rather than
   * `useMemo` because these own audio nodes and must never be silently
   * recreated by a re-render. */
  const voices = useRef<{
    wind?: WindVoice;
    leaves?: LeafRustleVoice;
    stream?: StreamVoice;
    brook?: StreamVoice;
    crickets?: CricketChorus;
    frogs?: FrogVoice;
    windmill?: WindmillVoice;
    chime?: WindChimeVoice;
    rain?: RainVoice;
    music?: AmbientMusic;
  }>({});

  /** Spatial mixing points for fixed emitters. */
  const sources = useRef<Record<string, ReturnType<typeof engine.createSource>>>({});

  /** Birds currently perched, with their positions and species. */
  const birds = useMemo(() => {
    const out: Array<{ species: BirdVoiceId; id: string; pos: THREE.Vector3; next: number }> = [];
    for (const sp of BIRD_SPECIES) {
      // Two or three individuals per species, scattered across their zones.
      const count = 2 + (sp.id.charCodeAt(0) % 2);
      for (let i = 0; i < count; i++) {
        const zone = ZONES[sp.zones[i % sp.zones.length]!];
        const angle = (i / count) * Math.PI * 2 + sp.id.charCodeAt(1) * 0.37;
        const r = zone.radius * (0.3 + ((i * 37) % 50) / 100);
        out.push({
          species: sp.voice,
          id: sp.id,
          pos: new THREE.Vector3(
            zone.center[0] + Math.cos(angle) * r,
            9 + ((i * 13) % 7),
            zone.center[1] + Math.sin(angle) * r,
          ),
          next: Math.random() * 12,
        });
      }
    }
    return out;
  }, []);

  const birdSource = useRef<ReturnType<typeof engine.createSource>>(null);
  const cowTimer = useRef(6);
  const chickenTimer = useRef(9);
  const roosterFired = useRef(false);
  const thunderTimer = useRef<number>(PRECIPITATION.THUNDER_INTERVAL);
  const slowTick = useMemo(() => new Throttle(6), []);
  const lastCamPos = useRef(new THREE.Vector3());

  /* ── Setup / teardown ─────────────────────────────────────────────────── */

  useEffect(() => {
    if (!engine.ready) return;
    const v = voices.current;
    const s = sources.current;

    // Fixed positional emitters.
    s.pond = engine.createSource({
      bus: 'ambient',
      position: [POND.center[0], 2, POND.center[1]],
      refDistance: 10,
      maxDistance: 90,
      rolloff: 1.4,
      reverbSend: 0.22,
    });
    const brookMid = BROOK_POLYLINE[Math.floor(BROOK_POLYLINE.length * 0.55)] ?? [0, 0, 0];
    s.brook = engine.createSource({
      bus: 'ambient',
      position: [brookMid[0], brookMid[1] + 1, brookMid[2]],
      refDistance: 6,
      maxDistance: 70,
      rolloff: 1.6,
      reverbSend: 0.18,
    });
    s.windmill = engine.createSource({
      bus: 'ambient',
      position: [ZONES.WHEAT_AND_WINDMILL.center[0], 14, ZONES.WHEAT_AND_WINDMILL.center[1]],
      refDistance: 12,
      maxDistance: 140,
      rolloff: 1.1,
      reverbSend: 0.3,
    });
    s.ridge = engine.createSource({
      bus: 'ambient',
      position: [RIDGE_BENCH.x, 40, RIDGE_BENCH.z],
      refDistance: 8,
      maxDistance: 80,
      rolloff: 1.4,
      reverbSend: 0.4,
    });
    s.grove = engine.createSource({
      bus: 'ambient',
      position: [ZONES.ANCIENT_GROVE.center[0], 12, ZONES.ANCIENT_GROVE.center[1]],
      refDistance: 14,
      maxDistance: 120,
      rolloff: 1.0,
      reverbSend: 0.35,
    });
    s.paddock = engine.createSource({
      bus: 'wildlife',
      position: [34, 4, -20],
      refDistance: 8,
      maxDistance: 90,
      rolloff: 1.3,
      reverbSend: 0.2,
    });
    s.village = engine.createSource({
      bus: 'wildlife',
      position: [0, 4, 0],
      refDistance: 10,
      maxDistance: 80,
      rolloff: 1.3,
      reverbSend: 0.24,
    });
    // A single roving source reused for every bird call — creating a panner per
    // bird would mean 30 idle HRTF convolvers.
    birdSource.current = engine.createSource({
      bus: 'wildlife',
      position: [0, 10, 0],
      refDistance: 8,
      maxDistance: 130,
      rolloff: 1.2,
      reverbSend: 0.3,
    });

    // Persistent voices.
    v.wind = new WindVoice(engine);
    v.wind.start();

    v.leaves = new LeafRustleVoice(engine, s.grove ?? null);
    v.leaves.start();

    v.stream = new StreamVoice(engine, s.pond ?? null, 0.6);
    v.stream.start();

    v.brook = new StreamVoice(engine, s.brook ?? null, 1);
    v.brook.start();

    v.crickets = new CricketChorus(engine, [s.grove ?? null, s.ridge ?? null, s.village ?? null]);
    v.crickets.start();

    v.frogs = new FrogVoice(engine, s.pond ?? null);
    v.frogs.start();

    v.windmill = new WindmillVoice(engine, s.windmill ?? null);
    v.windmill.start();

    v.chime = new WindChimeVoice(engine, s.ridge ?? null);
    v.chime.start();

    v.rain = new RainVoice(engine);
    v.rain.start();

    return () => {
      Object.values(v).forEach((voice) => voice?.dispose());
      Object.values(s).forEach((src) => src?.dispose());
      birdSource.current?.dispose();
      voices.current = {};
      sources.current = {};
    };
  }, [engine, engine.ready]);

  /* ── Music toggle ─────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!engine.ready) return;
    if (musicEnabled && !voices.current.music) {
      voices.current.music = new AmbientMusic(engine);
      voices.current.music.start();
    } else if (!musicEnabled && voices.current.music) {
      voices.current.music.dispose();
      voices.current.music = undefined;
    }
  }, [engine, engine.ready, musicEnabled]);

  /* ── Per-frame update ─────────────────────────────────────────────────── */

  useFrame((_, dt) => {
    if (!engine.ready || phase === 'menu' || phase === 'loading') return;
    const v = voices.current;
    const w = WEATHER[weather];
    const seasonCfg = SEASONS[season];

    /* ── Continuous beds ──────────────────────────────────────────────── */
    v.wind?.update(wind.strength);
    v.leaves?.update(wind.strength, season === 'winter' ? 0.25 : 1);
    v.chime?.update(wind.strength);
    v.rain?.update(w.rain, 0.35);

    // Crickets swell after dusk and die at dawn; season scales the population.
    const nightness = inWindow(timeOfDay, [0.78, 0.24])
      ? clamp(1 - Math.abs(wrap(timeOfDay - 0.92 + 0.5, 1) - 0.5) * 3.2, 0.1, 1)
      : 0;
    v.crickets?.update(nightness * seasonCfg.wildlifeDensity * (1 - w.rain * 0.8));
    v.frogs?.update(nightness * seasonCfg.wildlifeDensity * 0.9 + w.rain * 0.35);

    // Music follows the harmonic clock.
    v.music?.setTimeOfDay(timeOfDay);

    /* ── Throttled: distance-based filtering and scheduled events ─────── */
    if (!slowTick.step(dt)) return;
    const sdt = slowTick.elapsed;
    const cam = camera.position;

    // Windmill: rotation phase advances with wind, driving the creak cadence.
    windmillPhase.current += wind.strength * 1.3 * sdt;
    v.windmill?.update(windmillPhase.current, wind.strength * 1.3);

    /* ── Birds ────────────────────────────────────────────────────────── */
    for (const bird of birds) {
      bird.next -= sdt;
      if (bird.next > 0) continue;

      const species = BIRD_SPECIES.find((b) => b.id === bird.id);
      const active = species ? inWindow(timeOfDay, species.active) : true;
      // Reschedule regardless — a silent bird still needs its next slot.
      bird.next = 7 + Math.random() * 22;

      if (!active) continue;
      // Rain suppresses song; so does winter.
      if (Math.random() < w.rain * 0.75) continue;
      if (Math.random() > seasonCfg.wildlifeDensity * 0.9) continue;

      const dist = cam.distanceTo(bird.pos);
      if (dist > 120) continue;

      const src = birdSource.current;
      if (src) {
        src.setPosition(bird.pos.x, bird.pos.y, bird.pos.z, 0.001);
        // Distant birds are darker — high frequencies absorbed by the air.
        src.setLowpass(18000 * Math.pow(0.06, Math.min(dist / 130, 1)));
        src.setReverb(0.25 + Math.min(dist / 130, 1) * 0.4);
      }
      playBirdSong(engine, src ?? null, bird.species, clamp(1 - dist / 160, 0.25, 1));

      if (dist < 45) {
        emitAudioSubtitle('🐦', `${species?.name ?? 'A bird'} sings`, bird.pos, camera);
      }
    }

    /* ── Rooster at dawn ──────────────────────────────────────────────── */
    if (inWindow(timeOfDay, [0.2, 0.26])) {
      if (!roosterFired.current) {
        roosterFired.current = true;
        playRoosterCrow(engine, sources.current.village ?? null, 0.9);
        emitAudioSubtitle('🐓', 'A rooster crows', [0, 5, 0], camera);
      }
    } else {
      roosterFired.current = false;
    }

    /* ── Livestock ────────────────────────────────────────────────────── */
    cowTimer.current -= sdt;
    if (cowTimer.current <= 0) {
      cowTimer.current = 18 + Math.random() * 34;
      if (VILLAGE.COW_COUNT > 0 && Math.random() < 0.7) {
        playCowMoo(engine, sources.current.paddock ?? null, 0.8);
        emitAudioSubtitle('🐄', 'A cow lows', [34, 4, -20], camera);
      }
    }

    chickenTimer.current -= sdt;
    if (chickenTimer.current <= 0) {
      chickenTimer.current = 9 + Math.random() * 20;
      // Chickens roost at night.
      if (!inWindow(timeOfDay, [0.8, 0.24]) && Math.random() < 0.65) {
        playChickenCluck(engine, sources.current.village ?? null, 0.7);
      }
    }

    /* ── Thunder ──────────────────────────────────────────────────────── */
    if (weather === 'storm') {
      thunderTimer.current -= sdt;
      if (thunderTimer.current <= 0) {
        thunderTimer.current = PRECIPITATION.THUNDER_INTERVAL * (0.5 + Math.random());
        // Strike somewhere on the horizon; the delay is the sound travelling.
        const distance = 80 + Math.random() * 300;
        const delayMs = distance * PRECIPITATION.THUNDER_DELAY_PER_UNIT * 1000;
        window.setTimeout(() => playThunder(engine, distance), delayMs);
        emitAudioSubtitle('⛈️', 'Thunder rolls', [cam.x, 60, cam.z - 100], camera);
      }
    } else {
      thunderTimer.current = PRECIPITATION.THUNDER_INTERVAL;
    }

    lastCamPos.current.copy(cam);
  });

  return null;
}

const windmillPhase = { current: 0 };
