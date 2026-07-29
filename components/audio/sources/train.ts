/**
 * The locomotive.
 *
 * Every element here is driven by the train's *simulation state* rather than
 * triggered as a clip:
 *
 * - The chuff rate is derived from wheel angular velocity, so it accelerates
 *   with the train automatically.
 * - The rolling rumble's filter cutoff tracks speed.
 * - Pitch is shifted by a real Doppler calculation against the listener.
 *
 * @module components/audio/sources/train
 */

import type { SynthEngine, SpatialSource } from '../SynthEngine';
import { AUDIO, TRAIN } from '@/config/game';
import { clamp, lerp } from '@/lib/utils/math';

/**
 * The two-tone horn.
 *
 * A real air horn is two chambers sounding a musical interval — here a major
 * third, 110 Hz and 138.6 Hz. Each is *two* detuned sawtooths rather than one:
 * the ±0.5 % detune produces slow beating between them, which is what makes the
 * sound feel physically large rather than like a synthesiser patch. It then
 * goes through soft saturation for brass-like odd harmonics, a low-pass to sit
 * it back in the valley, and a heavy reverb send.
 *
 * @param distant - When true, the horn is heavily filtered and quieter: this is
 *   the T−15 s cue, heard from far beyond the ridge.
 */
export function playTrainHorn(
  e: SynthEngine,
  src: SpatialSource | null,
  opts: { distant?: boolean; volume?: number; duration?: number } = {},
): void {
  if (!e.ready || !e.context) return;
  const { distant = false, volume = 1, duration = distant ? 2.2 : 1.6 } = opts;

  const t = e.now + 0.02;
  const nodes: AudioNode[] = [];
  const sources: AudioScheduledSourceNode[] = [];

  const mix = e.createGain(0.28);
  const shaper = e.createDistortion(distant ? 0.12 : 0.34);
  const lp = e.createFilter('lowpass', distant ? 620 : 2400, 0.9);
  const hp = e.createFilter('highpass', 60, 0.7);
  const gain = e.createGain(0.0001);
  if (!mix || !shaper || !lp || !hp || !gain) return;

  nodes.push(mix, shaper, lp, hp, gain);

  // Two chambers, each a detuned pair.
  const fundamentals = [110, 138.6];
  for (const f of fundamentals) {
    for (const detune of [-5, 5]) {
      const osc = e.createOscillator('sawtooth', f, detune);
      const oGain = e.createGain(0.5);
      if (!osc || !oGain) continue;
      osc.connect(oGain);
      oGain.connect(mix);
      // A slight downward drift over the note — air pressure falling.
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.linearRampToValueAtTime(f * 0.988, t + duration);
      osc.start(t);
      nodes.push(osc, oGain);
      sources.push(osc);
    }
    // A quiet octave above fills out the timbre.
    const oct = e.createOscillator('sawtooth', f * 2, 3);
    const octGain = e.createGain(0.14);
    if (oct && octGain) {
      oct.connect(octGain);
      octGain.connect(mix);
      oct.start(t);
      nodes.push(oct, octGain);
      sources.push(oct);
    }
  }

  mix.connect(shaper);
  shaper.connect(lp);
  lp.connect(hp);
  hp.connect(gain);
  gain.connect(src?.input ?? e.bus('train'));

  if (src) src.setReverb(distant ? 0.85 : 0.42);

  const peak = (distant ? 0.16 : 0.34) * volume;
  const end = e.envelope(gain.gain, t, {
    peak,
    attack: distant ? 0.28 : 0.09,
    decay: 0.2,
    sustain: peak * 0.82,
    hold: duration * 0.6,
    release: distant ? 1.4 : 0.8,
  });

  e.scheduleTeardown(nodes, sources, end + 0.2);
}

/**
 * A single chuff — one exhaust beat from the cylinders.
 *
 * Filtered pink noise with a very fast attack and an exponential decay: the
 * sound of a pressurised gas volume being released. The band-pass centre rises
 * with speed because a faster exhaust is a brighter one.
 *
 * @param intensity - 0..1. Scales both level and brightness.
 */
export function playChuff(
  e: SynthEngine,
  src: SpatialSource | null,
  intensity = 1,
): void {
  if (!e.ready) return;
  const t = e.now + 0.005;

  const noise = e.createNoiseSource('pink');
  const bp = e.createFilter('bandpass', lerp(320, 900, intensity), 1.1);
  const hp = e.createFilter('highpass', 140, 0.7);
  const gain = e.createGain(0.0001);
  if (!noise || !bp || !hp || !gain) return;

  noise.connect(hp);
  hp.connect(bp);
  bp.connect(gain);
  gain.connect(src?.input ?? e.bus('train'));

  // The downward filter sweep within the chuff is the "wuff" of the exhaust.
  bp.frequency.setValueAtTime(lerp(420, 1200, intensity), t);
  bp.frequency.exponentialRampToValueAtTime(lerp(180, 420, intensity), t + 0.14);

  const end = e.envelope(gain.gain, t, {
    peak: 0.2 * intensity,
    attack: 0.006,
    decay: 0.05,
    sustain: 0.06 * intensity,
    release: 0.16,
  });

  noise.start(t);
  e.scheduleTeardown([noise, hp, bp, gain], [noise], end + 0.05);
}

/** The steam hiss that fills the gap between chuffs. */
export function playSteamHiss(e: SynthEngine, src: SpatialSource | null, intensity = 1): void {
  if (!e.ready) return;
  const t = e.now + 0.005;

  const noise = e.createNoiseSource('white');
  const hp = e.createFilter('highpass', 2600, 0.6);
  const bp = e.createFilter('bandpass', 5200, 0.8);
  const gain = e.createGain(0.0001);
  if (!noise || !hp || !bp || !gain) return;

  noise.connect(hp);
  hp.connect(bp);
  bp.connect(gain);
  gain.connect(src?.input ?? e.bus('train'));

  const end = e.envelope(gain.gain, t, {
    peak: 0.055 * intensity,
    attack: 0.03,
    decay: 0.1,
    sustain: 0.02 * intensity,
    hold: 0.08,
    release: 0.22,
  });

  noise.start(t);
  e.scheduleTeardown([noise, hp, bp, gain], [noise], end + 0.05);
}

/**
 * The continuous rolling rumble of wheels on rail.
 *
 * Brown noise (−6 dB/octave, i.e. mostly low frequency) through a low-pass
 * whose cutoff rises with speed — a stationary train has no rumble, a fast one
 * has a broadband roar. A resonant peak around 65 Hz stands in for the
 * structural resonance of the rails themselves.
 *
 * Long-lived: created when a train spawns, `update()`d each frame, disposed
 * when it leaves.
 */
export class TrainRumble {
  private noise: AudioBufferSourceNode | null = null;
  private lp: BiquadFilterNode | null = null;
  private peak: BiquadFilterNode | null = null;
  private gain: GainNode | null = null;
  private started = false;

  constructor(
    private readonly engine: SynthEngine,
    private readonly source: SpatialSource | null,
  ) {}

  start(): void {
    const e = this.engine;
    if (!e.ready || this.started) return;

    this.noise = e.createNoiseSource('brown');
    this.lp = e.createFilter('lowpass', 300, 1.2);
    this.peak = e.createFilter('peaking', 65, 2.2, 8);
    this.gain = e.createGain(0.0001);
    if (!this.noise || !this.lp || !this.peak || !this.gain) return;

    this.noise.connect(this.peak);
    this.peak.connect(this.lp);
    this.lp.connect(this.gain);
    this.gain.connect(this.source?.input ?? e.bus('train'));

    this.noise.start();
    this.started = true;
  }

  /**
   * @param speed - Current train speed, wu/s.
   * @param proximity - 0 (far) to 1 (adjacent). Drives level independently of
   *   the panner so the rumble is felt before it is localised.
   */
  update(speed: number, proximity: number): void {
    if (!this.gain || !this.lp) return;
    const e = this.engine;
    const t = e.now;
    const norm = clamp(speed / TRAIN.SPEED, 0, 1.4);

    this.gain.gain.setTargetAtTime(Math.max(0.24 * norm * proximity, 0.0001), t, 0.12);
    this.lp.frequency.setTargetAtTime(lerp(120, 620, norm), t, 0.2);
  }

  stop(): void {
    this.gain?.gain.setTargetAtTime(0.0001, this.engine.now, 0.5);
  }

  dispose(): void {
    try {
      this.noise?.stop();
    } catch {
      /* Not started. */
    }
    [this.noise, this.lp, this.peak, this.gain].forEach((n) => n?.disconnect());
    this.started = false;
  }
}

/**
 * The rail hum at T−8 s — the sound of the track singing before the train is
 * visible. A pair of quiet, slowly-rising sine tones with heavy vibrato,
 * suggesting metal under stress.
 */
export class RailHum {
  private osc1: OscillatorNode | null = null;
  private osc2: OscillatorNode | null = null;
  private lfo: OscillatorNode | null = null;
  private lfoGain: GainNode | null = null;
  private gain: GainNode | null = null;

  constructor(
    private readonly engine: SynthEngine,
    private readonly source: SpatialSource | null,
  ) {}

  start(): void {
    const e = this.engine;
    if (!e.ready) return;

    this.osc1 = e.createOscillator('sine', 58);
    this.osc2 = e.createOscillator('sine', 87, 8);
    this.lfo = e.createOscillator('sine', 4.2);
    this.lfoGain = e.createGain(2.4);
    this.gain = e.createGain(0.0001);
    if (!this.osc1 || !this.osc2 || !this.lfo || !this.lfoGain || !this.gain) return;

    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.osc1.frequency);
    this.lfoGain.connect(this.osc2.frequency);

    this.osc1.connect(this.gain);
    this.osc2.connect(this.gain);
    this.gain.connect(this.source?.input ?? e.bus('train'));

    const t = e.now;
    this.osc1.start(t);
    this.osc2.start(t);
    this.lfo.start(t);
    // Slow swell over 8 seconds as the train closes.
    this.gain.gain.setValueAtTime(0.0001, t);
    this.gain.gain.exponentialRampToValueAtTime(0.05, t + 8);
  }

  /** @param intensity - 0..1, typically derived from time-to-arrival. */
  update(intensity: number): void {
    if (!this.gain) return;
    this.gain.gain.setTargetAtTime(Math.max(0.06 * intensity, 0.0001), this.engine.now, 0.4);
  }

  dispose(): void {
    const t = this.engine.now;
    this.gain?.gain.setTargetAtTime(0.0001, t, 0.4);
    // Let the fade finish before tearing down, or it clicks.
    setTimeout(() => {
      try {
        this.osc1?.stop();
        this.osc2?.stop();
        this.lfo?.stop();
      } catch {
        /* Already stopped. */
      }
      [this.osc1, this.osc2, this.lfo, this.lfoGain, this.gain].forEach((n) => n?.disconnect());
    }, 900);
  }
}

/**
 * The level-crossing bell.
 *
 * A bright 880 Hz square through a resonant band-pass, struck twice per second.
 * Square (not sine) because the odd-harmonic content is what gives an electric
 * crossing bell its piercing, unignorable quality.
 */
export class CrossingBell {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly engine: SynthEngine,
    private readonly source: SpatialSource | null,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.ding();
    this.timer = setInterval(() => this.ding(), 520);
  }

  private ding(): void {
    const e = this.engine;
    if (!e.ready) return;
    const t = e.now + 0.01;

    const osc = e.createOscillator('square', 880);
    const osc2 = e.createOscillator('square', 1320, 6);
    const g2 = e.createGain(0.32);
    const bp = e.createFilter('bandpass', 1760, 5);
    const gain = e.createGain(0.0001);
    if (!osc || !osc2 || !g2 || !bp || !gain) return;

    osc.connect(bp);
    osc2.connect(g2);
    g2.connect(bp);
    bp.connect(gain);
    gain.connect(this.source?.input ?? e.bus('train'));

    const end = e.envelope(gain.gain, t, {
      peak: 0.12,
      attack: 0.003,
      decay: 0.09,
      sustain: 0.02,
      release: 0.3,
    });

    osc.start(t);
    osc2.start(t);
    e.scheduleTeardown([osc, osc2, g2, bp, gain], [osc, osc2], end + 0.05);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stop();
  }
}

/** The servo whine and creak of the barrier arm lowering or raising. */
export function playBarrierMotor(
  e: SynthEngine,
  src: SpatialSource | null,
  duration: number,
): void {
  if (!e.ready) return;
  const t = e.now + 0.02;

  // Motor: a low buzzing saw through a band-pass.
  const motor = e.createOscillator('sawtooth', 62);
  const motorBp = e.createFilter('bandpass', 260, 4);
  const motorGain = e.createGain(0.0001);
  // Creak: slow, irregular noise bursts through a very resonant filter.
  const creak = e.createNoiseSource('pink');
  const creakBp = e.createFilter('bandpass', 1400, 14);
  const creakGain = e.createGain(0.0001);
  if (!motor || !motorBp || !motorGain || !creak || !creakBp || !creakGain) return;

  const out = src?.input ?? e.bus('train');
  motor.connect(motorBp);
  motorBp.connect(motorGain);
  motorGain.connect(out);
  creak.connect(creakBp);
  creakBp.connect(creakGain);
  creakGain.connect(out);

  motor.frequency.setValueAtTime(58, t);
  motor.frequency.linearRampToValueAtTime(68, t + duration);

  motorGain.gain.setValueAtTime(0.0001, t);
  motorGain.gain.exponentialRampToValueAtTime(0.05, t + 0.15);
  motorGain.gain.setValueAtTime(0.05, t + duration - 0.2);
  motorGain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

  // Creak swells in the middle of the travel where the arm is under most load.
  creakGain.gain.setValueAtTime(0.0001, t);
  creakGain.gain.exponentialRampToValueAtTime(0.03, t + duration * 0.55);
  creakGain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  creakBp.frequency.setValueAtTime(900, t);
  creakBp.frequency.linearRampToValueAtTime(2200, t + duration);

  motor.start(t);
  creak.start(t);
  e.scheduleTeardown(
    [motor, motorBp, motorGain, creak, creakBp, creakGain],
    [motor, creak],
    t + duration + 0.15,
  );
}

/** Sparks at the wheel–rail contact: very short, very bright noise transients. */
export function playSparks(e: SynthEngine, src: SpatialSource | null, count = 3): void {
  if (!e.ready) return;
  for (let i = 0; i < count; i++) {
    const t = e.now + Math.random() * 0.25;
    const noise = e.createNoiseSource('white');
    const hp = e.createFilter('highpass', 4200 + Math.random() * 3000, 1.4);
    const gain = e.createGain(0.0001);
    if (!noise || !hp || !gain) continue;

    noise.connect(hp);
    hp.connect(gain);
    gain.connect(src?.input ?? e.bus('train'));

    const end = e.envelope(gain.gain, t, {
      peak: 0.045,
      attack: 0.001,
      release: 0.035 + Math.random() * 0.04,
    });
    noise.start(t);
    e.scheduleTeardown([noise, hp, gain], [noise], end + 0.02);
  }
}

/**
 * Computes the Doppler pitch ratio for a moving source and a moving listener.
 *
 * The classic formula: `f' = f · (c + v_listener) / (c + v_source)`, where both
 * velocities are projected onto the unit vector from source to listener. A
 * source approaching the listener has a *negative* projected velocity in this
 * convention, which raises the ratio — the familiar rise-then-drop as the train
 * goes past.
 *
 * Clamped, because a fast pass can otherwise produce ratios that sound
 * cartoonish rather than dramatic.
 *
 * @returns Multiplier to apply to `playbackRate` / `detune`.
 */
export function computeDoppler(
  sourcePos: [number, number, number],
  sourceVel: [number, number, number],
  listenerPos: [number, number, number],
  listenerVel: [number, number, number],
): number {
  const dx = listenerPos[0] - sourcePos[0];
  const dy = listenerPos[1] - sourcePos[1];
  const dz = listenerPos[2] - sourcePos[2];
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 1e-3) return 1;

  const ux = dx / dist;
  const uy = dy / dist;
  const uz = dz / dist;

  // Positive = moving toward the other party along the connecting line.
  const vSource = sourceVel[0] * ux + sourceVel[1] * uy + sourceVel[2] * uz;
  const vListener = listenerVel[0] * ux + listenerVel[1] * uy + listenerVel[2] * uz;

  const c = AUDIO.SPEED_OF_SOUND;
  const ratio = (c - vListener) / Math.max(c - vSource, 1);
  return clamp(ratio, AUDIO.DOPPLER_CLAMP[0], AUDIO.DOPPLER_CLAMP[1]);
}

/**
 * Converts a Doppler ratio into a `detune` value in cents, which is how
 * oscillator-based voices apply it.
 */
export function dopplerToCents(ratio: number): number {
  return 1200 * Math.log2(Math.max(ratio, 0.01));
}
