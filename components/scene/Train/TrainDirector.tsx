/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TRAIN DIRECTOR — the ritual
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the emotional centrepiece of Whispering Hollow, and the component
 * that does the most work per line.
 *
 * The train is not a prop that drives past. It is a **40-second staged event**
 * with a beginning, a build, a climax and a long silence afterwards. The
 * sequence is authored as a timeline in `TRAIN_SEQUENCE`; this component runs
 * that timeline, firing each cue exactly once and driving every continuous
 * quantity (position, shake, barrier, audio) from a single clock.
 *
 * ## The timeline
 *
 * ```
 *  T−20  Birds scatter from the trackside trees. Cattle low.
 *  T−15  The first horn — distant, heavily low-passed, drenched in reverb.
 *  T−10  The crossing wakes: bell, alternating lamps, barrier descends.
 *  T−8   The rails begin to hum.
 *  T−6   The ground trembles; camera shake starts, scaled by proximity.
 *  T−3   Steam on the horizon; the silhouette resolves out of the fog.
 *  T−0   It passes. Full horn, chuffs, sparks, Doppler.
 *  T+8   The departing horn — quieter, lower, mournful.
 *  T+15  The barrier lifts. The bell stops. Birds return.
 *  T+20  Quiet. Only wind and crickets.
 * ```
 *
 * ## Why the approach matters
 *
 * Everything is driven from **one authoritative clock** (`eventTime`), rather
 * than from a chain of timers. That means:
 *
 * - The sequence can be scrubbed, paused and resumed coherently.
 * - Cues cannot drift apart, because none of them schedule each other.
 * - A frame drop delays nothing: a long frame simply advances the clock
 *   further, and any cues crossed in that step still fire, in order.
 *
 * @module components/scene/Train/TrainDirector
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { useTrackCurve } from './Track';
import { Locomotive, Wagon } from './Locomotive';
import { Crossing } from './Crossing';
import { useSynthEngine, emitAudioSubtitle } from '@/components/audio/useSpatialAudio';
import {
  playTrainHorn,
  playChuff,
  playSteamHiss,
  playSparks,
  playBarrierMotor,
  TrainRumble,
  RailHum,
  CrossingBell,
  computeDoppler,
} from '@/components/audio/sources/train';
import { playFlockStartle, playCowMoo } from '@/components/audio/sources/wildlife';
import { useGameStore } from '@/store/gameStore';
import { useSettingsStore } from '@/store/settingsStore';
import { ui } from '@/store/uiState';
import { startleAllBirds } from '../Wildlife/Birds';
import {
  TRAIN,
  TRAIN_SEQUENCE,
  WAGON_TYPES,
  WAGON_LIVERIES,
  type TrainCueId,
  type WagonLiveryId,
} from '@/config/game';
import { LEVEL_CROSSING } from '@/lib/world/layout';
import { clamp, fbm1D, lerp } from '@/lib/utils/math';

/** Where in the ritual the train currently is. */
type Phase = 'idle' | 'running';

export function TrainSystem() {
  const curve = useTrackCurve();
  const engine = useSynthEngine();
  const { camera } = useThree();

  const trainInterval = useSettingsStore((s) => s.world.trainInterval);
  const reducedMotion = useSettingsStore((s) => s.accessibility.reducedMotion);
  const unlockedLiveries = useGameStore((s) => s.progress.unlocked.liveries);
  const recordTrainPass = useGameStore((s) => s.recordTrainPass);
  const phase = useGameStore((s) => s.phase);

  /* ── Timeline state ───────────────────────────────────────────────────── */
  const state = useRef<{
    phase: Phase;
    /** Seconds until the next train begins its approach. */
    countdown: number;
    /** Seconds relative to T-0. Negative before the pass. */
    eventTime: number;
    /** Which cues have already fired this run. */
    firedCues: Set<TrainCueId>;
    /** Whether this pass has been counted toward the achievement. */
    counted: boolean;
  }>({
    phase: 'idle',
    countdown: 12,
    eventTime: 0,
    firedCues: new Set(),
    counted: false,
  });

  /* ── Driven values, read by the render components ─────────────────────── */
  const wheelAngle = useRef(0);
  const effort = useRef(0);
  const speed = useRef(0);
  const barrierState = useRef(0);
  const crossingActive = useRef(false);

  const trainGroup = useRef<THREE.Group>(null);
  const carRefs = useRef<THREE.Group[]>([]);

  /* ── Audio voices ─────────────────────────────────────────────────────── */
  const audio = useRef<{
    source?: ReturnType<typeof engine.createSource>;
    crossingSource?: ReturnType<typeof engine.createSource>;
    rumble?: TrainRumble;
    hum?: RailHum;
    bell?: CrossingBell;
  }>({});

  const chuffAccumulator = useRef(0);
  const lastTrainPos = useRef(new THREE.Vector3());
  const trainVelocity = useRef(new THREE.Vector3());
  const listenerVelocity = useRef(new THREE.Vector3());
  const lastCamPos = useRef(new THREE.Vector3());

  /* ── Camera shake, published for the player controller to consume ─────── */
  const shakeOffset = useRef(new THREE.Vector3());

  /* ── Consist ──────────────────────────────────────────────────────────── */
  const consist = useMemo(() => {
    const available = WAGON_LIVERIES.filter((l) => unlockedLiveries.includes(l.id));
    const liveries = available.length > 0 ? available : [WAGON_LIVERIES[0]!];
    return WAGON_TYPES.slice(0, TRAIN.WAGON_COUNT).map((type, i) => ({
      type,
      // Deterministic per position, so the same wagon always has the same paint.
      livery: liveries[i % liveries.length]!.id as WagonLiveryId,
      index: i,
    }));
  }, [unlockedLiveries]);

  /**
   * Total length of the consist, used to work out how far past the crossing the
   * train must travel before the last wagon has cleared it.
   */
  const consistLength = useMemo(
    () =>
      TRAIN.LOCO_LENGTH +
      consist.length * (TRAIN.WAGON_LENGTH + TRAIN.WAGON_GAP) +
      TRAIN.WAGON_GAP,
    [consist.length],
  );

  /** Arc length along the curve at which the locomotive is level with the crossing. */
  const crossingDistance = useMemo(() => {
    const samples = 400;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i <= samples; i++) {
      const p = curve.getPointAt(i / samples);
      const d = Math.hypot(p.x - LEVEL_CROSSING.x, p.z - LEVEL_CROSSING.z);
      if (d < bestDist) {
        bestDist = d;
        best = i / samples;
      }
    }
    return best * curve.getLength();
  }, [curve]);

  const curveLength = useMemo(() => curve.getLength(), [curve]);

  /* ── Setup ────────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!engine.ready) return;

    audio.current.source = engine.createSource({
      bus: 'train',
      position: [0, 3, 0],
      refDistance: 14,
      maxDistance: 420,
      rolloff: 0.85,
      reverbSend: 0.32,
    });

    audio.current.crossingSource = engine.createSource({
      bus: 'train',
      position: [LEVEL_CROSSING.x, 3, LEVEL_CROSSING.z],
      refDistance: 9,
      maxDistance: 160,
      rolloff: 1.2,
      reverbSend: 0.28,
    });

    audio.current.rumble = new TrainRumble(engine, audio.current.source ?? null);
    audio.current.rumble.start();

    audio.current.bell = new CrossingBell(engine, audio.current.crossingSource ?? null);

    return () => {
      audio.current.rumble?.dispose();
      audio.current.hum?.dispose();
      audio.current.bell?.dispose();
      audio.current.source?.dispose();
      audio.current.crossingSource?.dispose();
      audio.current = {};
    };
  }, [engine, engine.ready]);

  /* ── Cue dispatch ─────────────────────────────────────────────────────── */
  const fireCue = useMemo(() => {
    return (cue: TrainCueId, trainPos: THREE.Vector3) => {
      const src = audio.current.source ?? null;
      const crossSrc = audio.current.crossingSource ?? null;

      switch (cue) {
        case 'birdsStartle':
          /* The birds know first. This is the only cue with no sound coming
           * from the train itself — the player's first sign is the valley
           * reacting, which is a far better hook than the train appearing. */
          startleAllBirds();
          playFlockStartle(engine, src, 0.9);
          playCowMoo(engine, crossSrc, 0.7);
          emitAudioSubtitle('🐦', 'Birds scatter from the trees', trainPos, camera);
          break;

        case 'distantHorn':
          playTrainHorn(engine, src, { distant: true, volume: 1, duration: 2.4 });
          emitAudioSubtitle('🚂', 'A distant horn', trainPos, camera);
          break;

        case 'crossingActivate':
          crossingActive.current = true;
          audio.current.bell?.start();
          playBarrierMotor(engine, crossSrc, 3.2);
          emitAudioSubtitle('🔔', 'The crossing bell begins', [LEVEL_CROSSING.x, 3, LEVEL_CROSSING.z], camera);
          break;

        case 'railHum':
          audio.current.hum?.dispose();
          audio.current.hum = new RailHum(engine, crossSrc);
          audio.current.hum.start();
          break;

        case 'groundTremble':
          // Handled continuously below; the cue only marks the start.
          break;

        case 'steamVisible':
          // Purely visual — the plume is already emitting by now.
          break;

        case 'pass':
          playTrainHorn(engine, src, { distant: false, volume: 1, duration: 1.7 });
          playSparks(engine, src, 6);
          emitAudioSubtitle('🚂', 'The train thunders past', trainPos, camera);
          break;

        case 'departingHorn':
          playTrainHorn(engine, src, { distant: true, volume: 0.7, duration: 2.8 });
          emitAudioSubtitle('🚂', 'A departing horn, further off', trainPos, camera);
          break;

        case 'crossingRelease':
          crossingActive.current = false;
          audio.current.bell?.stop();
          playBarrierMotor(engine, crossSrc, 3.6);
          audio.current.hum?.dispose();
          audio.current.hum = undefined;
          break;

        case 'quiet':
          // Restore the ambient music that was ducked for the pass.
          engine.duckMusic(1, 3.5);
          break;
      }
    };
  }, [engine, camera]);

  /* ── The loop ─────────────────────────────────────────────────────────── */
  useFrame((_, dt) => {
    if (dt <= 0 || dt > 0.5) return;
    if (phase === 'menu' || phase === 'loading') return;

    const s = state.current;

    /* ── Idle: count down to the next event ───────────────────────────── */
    if (s.phase === 'idle') {
      s.countdown -= dt;
      ui.trainCountdown = s.countdown;
      ui.trainActive = false;

      if (s.countdown <= 0) {
        s.phase = 'running';
        // Start at the first cue, not at T-0.
        s.eventTime = TRAIN_SEQUENCE[0]!.at;
        s.firedCues.clear();
        s.counted = false;
      }
      // Hide the train while idle.
      if (trainGroup.current) trainGroup.current.visible = false;
      effort.current = 0;
      speed.current = 0;
      audio.current.rumble?.update(0, 0);
      return;
    }

    /* ── Running ──────────────────────────────────────────────────────── */
    const prevTime = s.eventTime;
    s.eventTime += dt;
    ui.trainActive = true;
    ui.trainCountdown = -s.eventTime;

    /* ── Position ─────────────────────────────────────────────────────────
     * The locomotive's arc-length position is simply `crossingDistance +
     * eventTime × speed`. At eventTime = 0 it is exactly at the crossing,
     * which is what makes the whole timeline line up with the visuals for
     * free — every cue's timing is also its geometry. */
    const distance = crossingDistance + s.eventTime * TRAIN.SPEED;
    speed.current = TRAIN.SPEED;

    // Wheel rotation from distance travelled: θ = s / r. Exact, not animated.
    wheelAngle.current = distance / TRAIN.WHEEL_RADIUS;

    const visible = distance > -consistLength - 40 && distance < curveLength + consistLength + 40;
    if (trainGroup.current) trainGroup.current.visible = visible;

    /* Place the locomotive and each wagon at its own arc length, so the consist
     * follows the curve properly around bends rather than pivoting rigidly. */
    const placeCar = (group: THREE.Group | null, carDistance: number) => {
      if (!group) return;
      const t = clamp(carDistance / curveLength, 0, 1);
      const pos = curve.getPointAt(t);
      const tangent = curve.getTangentAt(t).normalize();

      group.position.copy(pos);
      // Face along the track.
      group.rotation.set(0, Math.atan2(tangent.x, tangent.z), 0);

      /* Bogie bounce and body sway. Two out-of-phase sines at incommensurate
       * frequencies, so the motion never settles into a visible rhythm. The
       * amplitudes are deliberately tiny — a couple of centimetres — because
       * anything larger reads as a broken suspension rather than a heavy
       * vehicle on jointed rail. */
      const phaseIn = carDistance * 0.35;
      group.position.y +=
        Math.sin(phaseIn) * TRAIN.BOUNCE_AMPLITUDE +
        Math.sin(phaseIn * 1.73 + 1.1) * TRAIN.BOUNCE_AMPLITUDE * 0.6;
      group.rotation.z =
        Math.sin(phaseIn * 0.61) * TRAIN.SWAY_AMPLITUDE +
        Math.sin(phaseIn * 1.31 + 2.2) * TRAIN.SWAY_AMPLITUDE * 0.5;
    };

    const loco = carRefs.current[0] ?? null;
    placeCar(loco, distance);

    let cursor = distance - TRAIN.LOCO_LENGTH / 2 - TRAIN.WAGON_GAP - TRAIN.WAGON_LENGTH / 2;
    for (let i = 0; i < consist.length; i++) {
      placeCar(carRefs.current[i + 1] ?? null, cursor);
      cursor -= TRAIN.WAGON_LENGTH + TRAIN.WAGON_GAP;
    }

    /* ── Engine effort ───────────────────────────────────────────────────
     * The locomotive works hardest as it approaches and coasts once past —
     * which is both realistic and useful: the steam plume and firebox glow
     * peak right before the moment of the pass. */
    effort.current = s.eventTime < 0 ? 1 : clamp(1 - s.eventTime / 12, 0.15, 1);

    /* ── Fire any cues crossed this frame ─────────────────────────────────
     * Iterating the whole list and checking `prevTime < at <= now` means a
     * dropped frame that skips over a cue still fires it, in order, rather
     * than losing it. */
    const trainWorldPos = loco?.position ?? _zero;
    for (const cue of TRAIN_SEQUENCE) {
      if (s.firedCues.has(cue.id)) continue;
      if (prevTime < cue.at && s.eventTime >= cue.at) {
        s.firedCues.add(cue.id);
        fireCue(cue.id, trainWorldPos);
      }
    }

    /* ── Barrier ──────────────────────────────────────────────────────────
     * Lowers over 3.2 s from T−10, stays down, rises over 3.6 s from T+15. */
    if (s.eventTime >= -10 && s.eventTime < 15) {
      barrierState.current = clamp((s.eventTime + 10) / 3.2, 0, 1);
    } else if (s.eventTime >= 15) {
      barrierState.current = clamp(1 - (s.eventTime - 15) / 3.6, 0, 1);
    } else {
      barrierState.current = 0;
    }

    /* ── Audio: proximity, Doppler, chuffs ───────────────────────────── */
    const src = audio.current.source;
    if (src && loco) {
      src.setPosition(loco.position.x, loco.position.y + 2, loco.position.z, 0.01);

      const distToListener = loco.position.distanceTo(camera.position);
      const proximity = clamp(1 - distToListener / 260, 0, 1);

      /* Distance low-pass. A train two hundred metres away across a valley is
       * almost entirely low frequency — the treble has been absorbed by the
       * air. This single filter does more for the sense of distance than the
       * volume falloff does. */
      src.setLowpass(lerp(320, 18000, Math.pow(proximity, 2.2)));
      // More reverb when far, less when close — the near sound is direct.
      src.setReverb(lerp(0.75, 0.18, proximity));

      audio.current.rumble?.update(TRAIN.SPEED, proximity);

      // Velocities for the Doppler calculation.
      trainVelocity.current.subVectors(loco.position, lastTrainPos.current).divideScalar(dt);
      lastTrainPos.current.copy(loco.position);
      listenerVelocity.current.subVectors(camera.position, lastCamPos.current).divideScalar(dt);
      lastCamPos.current.copy(camera.position);

      const doppler = computeDoppler(
        [loco.position.x, loco.position.y, loco.position.z],
        [trainVelocity.current.x, trainVelocity.current.y, trainVelocity.current.z],
        [camera.position.x, camera.position.y, camera.position.z],
        [listenerVelocity.current.x, listenerVelocity.current.y, listenerVelocity.current.z],
      );

      /* ── Chuffs ─────────────────────────────────────────────────────────
       * Four exhaust beats per wheel revolution (two cylinders, double-acting,
       * quartered cranks). Deriving the rate from wheel angle rather than a
       * timer means it is automatically, exactly in sync with the visible
       * wheels — and the Doppler shift applies to the chuff rate too, which is
       * a detail almost nobody notices consciously and everybody notices when
       * it is missing. */
      const beatsPerRevolution = 4;
      const revolutions = TRAIN.SPEED / (2 * Math.PI * TRAIN.WHEEL_RADIUS);
      const chuffRate = revolutions * beatsPerRevolution * doppler;

      chuffAccumulator.current += dt * chuffRate;
      while (chuffAccumulator.current >= 1) {
        chuffAccumulator.current -= 1;
        if (proximity > 0.05) {
          playChuff(engine, src, effort.current * proximity);
          // Steam hisses between the beats, not on them.
          if (Math.random() < 0.5) playSteamHiss(engine, src, effort.current * proximity * 0.7);
        }
      }

      /* Duck the ambient music as the train arrives, so the horn owns the mix. */
      if (s.eventTime > -12 && s.eventTime < 18) {
        const duck = lerp(1, 0.25, clamp(proximity * 1.4, 0, 1));
        engine.duckMusic(duck, 0.8);
      }

      /* ── Camera shake ───────────────────────────────────────────────────
       * Perlin-driven rather than random: random jitter looks like a broken
       * camera, whereas fBm produces a continuous tremble that reads as the
       * ground moving. Amplitude scales with proximity squared so it is felt
       * only when the train is genuinely close. */
      if (!reducedMotion && s.eventTime > -6 && s.eventTime < 6) {
        const shakeAmount =
          TRAIN.SHAKE_AMPLITUDE *
          Math.pow(clamp(1 - distToListener / TRAIN.SHAKE_RADIUS, 0, 1), 2);
        const t = performance.now() * 0.001 * TRAIN.SHAKE_FREQUENCY;
        shakeOffset.current.set(
          fbm1D(t, 2) * shakeAmount,
          fbm1D(t + 31.7, 2) * shakeAmount * 1.4,
          fbm1D(t + 73.1, 2) * shakeAmount,
        );
      } else {
        shakeOffset.current.multiplyScalar(0.88);
      }
      trainShake.copy(shakeOffset.current);

      // Count the pass once, as it goes by.
      if (!s.counted && s.eventTime > 1 && proximity > 0.12) {
        s.counted = true;
        recordTrainPass();
      }
    }

    /* ── End of the ritual ────────────────────────────────────────────── */
    if (s.eventTime > 24) {
      s.phase = 'idle';
      s.countdown = trainInterval;
      s.eventTime = 0;
      crossingActive.current = false;
      barrierState.current = 0;
      audio.current.bell?.stop();
      audio.current.hum?.dispose();
      audio.current.hum = undefined;
      engine.duckMusic(1, 3);
      trainShake.set(0, 0, 0);
      ui.trainActive = false;
    }
  });

  return (
    <group name="train-system">
      <Crossing barrierState={barrierState} active={crossingActive} />

      <group ref={trainGroup} visible={false}>
        <group
          ref={(el) => {
            if (el) carRefs.current[0] = el;
          }}
        >
          <Locomotive wheelAngle={wheelAngle} effort={effort} speed={speed} />
        </group>

        {consist.map((car, i) => (
          <group
            key={car.index}
            ref={(el) => {
              if (el) carRefs.current[i + 1] = el;
            }}
          >
            <Wagon
              type={car.type}
              livery={car.livery}
              wheelAngle={wheelAngle}
              index={car.index}
            />
          </group>
        ))}
      </group>
    </group>
  );
}

const _zero = new THREE.Vector3();

/**
 * The current camera shake offset from the train.
 *
 * Published as a module-level vector rather than through context because the
 * player controller reads it every frame and must not re-render when it
 * changes. The controller adds it to the camera position after its own
 * head-bob, so the two compose rather than fight.
 */
export const trainShake = new THREE.Vector3();
