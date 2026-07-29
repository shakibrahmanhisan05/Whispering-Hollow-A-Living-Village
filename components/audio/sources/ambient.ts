/**
 * Continuous ambient voices: wind, leaf rustle, the stream, crickets, frogs.
 *
 * These are **long-lived** — created once when a world loads and modulated
 * continuously for as long as it is running, rather than re-triggered. Each
 * exposes an `update()` that the ambience system calls with the current wind
 * strength, time of day and weather, so the whole bed responds to simulation
 * without any crossfading between pre-baked states.
 *
 * @module components/audio/sources/ambient
 */

import type { SynthEngine, SpatialSource } from '../SynthEngine';
import { clamp, lerp } from '@/lib/utils/math';

/** Common interface for a persistent ambient voice. */
export interface AmbientVoice {
  start(): void;
  stop(): void;
  dispose(): void;
}

/* ───────────────────────────────────────────────────────────────────────────
 * WIND
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The wind bed.
 *
 * Pink noise through a resonant band-pass whose centre frequency is swept by a
 * slow LFO. The sweep is the whole trick: static filtered noise reads as
 * "static", but a centre frequency wandering between roughly 300 Hz and 1.5 kHz
 * reads unmistakably as air moving past obstacles. Gain and centre frequency
 * are both driven by the same wind-strength uniform that bends the grass, so
 * what you hear and what you see are the same number.
 *
 * A second, much darker band-pass layer adds the low "roar" that only appears
 * in strong gusts.
 */
export class WindVoice implements AmbientVoice {
  private noise: AudioBufferSourceNode | null = null;
  private band: BiquadFilterNode | null = null;
  private lowBand: BiquadFilterNode | null = null;
  private lfo: OscillatorNode | null = null;
  private lfoGain: GainNode | null = null;
  private gain: GainNode | null = null;
  private lowGain: GainNode | null = null;
  private started = false;

  constructor(private readonly engine: SynthEngine) {}

  start(): void {
    const e = this.engine;
    if (!e.ready || this.started) return;

    this.noise = e.createNoiseSource('pink');
    this.band = e.createFilter('bandpass', 700, 0.85);
    this.lowBand = e.createFilter('bandpass', 180, 1.4);
    this.gain = e.createGain(0.0001);
    this.lowGain = e.createGain(0.0001);

    // LFO sweeping the band-pass centre. 0.07 Hz ≈ one full sweep every 14 s —
    // slow enough to feel like weather rather than a modulation effect.
    this.lfo = e.createOscillator('sine', 0.07);
    this.lfoGain = e.createGain(430);

    if (
      !this.noise ||
      !this.band ||
      !this.lowBand ||
      !this.gain ||
      !this.lowGain ||
      !this.lfo ||
      !this.lfoGain
    )
      return;

    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.band.frequency);

    this.noise.connect(this.band);
    this.band.connect(this.gain);
    this.gain.connect(e.bus('ambient'));

    this.noise.connect(this.lowBand);
    this.lowBand.connect(this.lowGain);
    this.lowGain.connect(e.bus('ambient'));

    this.noise.start();
    this.lfo.start();
    this.started = true;
  }

  /**
   * @param strength - Wind strength, 0..~2. Matches the shader uniform.
   * @param indoors - Muffles the bed when the listener is under cover.
   */
  update(strength: number, indoors = false): void {
    if (!this.gain || !this.band || !this.lowGain) return;
    const e = this.engine;
    const t = e.now;
    const s = clamp(strength, 0, 2);

    // Perceptual curve — wind loudness rises faster than linear with speed.
    const level = Math.pow(s, 1.35) * 0.16 * (indoors ? 0.32 : 1);
    this.gain.gain.setTargetAtTime(Math.max(level, 0.0001), t, 0.6);

    // The low roar only appears above about half strength.
    const lowLevel = Math.pow(clamp(s - 0.5, 0, 1.5), 1.8) * 0.13;
    this.lowGain.gain.setTargetAtTime(Math.max(lowLevel, 0.0001), t, 0.8);

    // Stronger wind is brighter — more turbulence, more high-frequency content.
    this.band.frequency.setTargetAtTime(lerp(420, 1250, clamp(s / 1.6, 0, 1)), t, 1.2);
    this.band.Q.setTargetAtTime(lerp(1.1, 0.55, clamp(s / 1.6, 0, 1)), t, 1.2);
  }

  stop(): void {
    this.gain?.gain.setTargetAtTime(0.0001, this.engine.now, 0.3);
    this.lowGain?.gain.setTargetAtTime(0.0001, this.engine.now, 0.3);
  }

  dispose(): void {
    try {
      this.noise?.stop();
      this.lfo?.stop();
    } catch {
      /* Not started. */
    }
    [this.noise, this.band, this.lowBand, this.lfo, this.lfoGain, this.gain, this.lowGain].forEach(
      (n) => n?.disconnect(),
    );
    this.started = false;
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * LEAVES
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Leaf rustle.
 *
 * Distinct from wind: leaves are *granular*. Rather than a continuous bed, this
 * schedules short high-passed noise bursts whose rate and amplitude scale with
 * wind strength, so a light breeze is an occasional papery tick and a gust is a
 * continuous wash. The randomised inter-onset interval is what stops it turning
 * into an audible rhythm.
 */
export class LeafRustleVoice implements AmbientVoice {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private strength = 0.4;
  private running = false;
  private density = 1;

  constructor(
    private readonly engine: SynthEngine,
    private readonly source: SpatialSource | null,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  update(strength: number, foliageDensity: number): void {
    this.strength = clamp(strength, 0, 2);
    this.density = clamp(foliageDensity, 0, 1);
  }

  private schedule(): void {
    if (!this.running) return;
    // Higher wind → shorter, more variable gaps.
    const base = lerp(900, 90, clamp(this.strength / 1.6, 0, 1));
    const delay = base * (0.5 + Math.random());
    this.timer = setTimeout(() => {
      this.burst();
      this.schedule();
    }, delay);
  }

  private burst(): void {
    const e = this.engine;
    if (!e.ready || !e.context) return;

    const src = e.createNoiseSource('white');
    const hp = e.createFilter('highpass', 1800 + Math.random() * 2600, 0.6);
    const bp = e.createFilter('bandpass', 3200 + Math.random() * 3400, 1.6);
    const gain = e.createGain(0.0001);
    if (!src || !hp || !bp || !gain) return;

    src.connect(hp);
    hp.connect(bp);
    bp.connect(gain);
    gain.connect(this.source ? this.source.input : e.bus('ambient'));

    const t = e.now;
    const amplitude = 0.028 * Math.pow(clamp(this.strength, 0, 2), 1.4) * this.density;
    const duration = 0.09 + Math.random() * 0.22;

    const end = e.envelope(gain.gain, t, {
      peak: amplitude,
      attack: 0.012,
      decay: duration * 0.4,
      sustain: amplitude * 0.4,
      release: duration * 0.6,
    });

    src.start(t);
    e.scheduleTeardown([src, hp, bp, gain], [src], end + 0.05);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stop();
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * WATER
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Flowing water.
 *
 * Two layers: a broadband pink-noise bed for the body of the flow, and sparse
 * short sine "bloops" for the individual bubbles that break the surface.
 * Running water without those discrete high-frequency events sounds like radio
 * static; with them it snaps into place as a stream.
 */
export class StreamVoice implements AmbientVoice {
  private noise: AudioBufferSourceNode | null = null;
  private bp: BiquadFilterNode | null = null;
  private hp: BiquadFilterNode | null = null;
  private gain: GainNode | null = null;
  private bubbleTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly engine: SynthEngine,
    private readonly source: SpatialSource | null,
    private readonly intensity = 1,
  ) {}

  start(): void {
    const e = this.engine;
    if (!e.ready || this.running) return;

    this.noise = e.createNoiseSource('pink');
    this.bp = e.createFilter('bandpass', 1400, 0.5);
    this.hp = e.createFilter('highpass', 600, 0.7);
    this.gain = e.createGain(0.0001);
    if (!this.noise || !this.bp || !this.hp || !this.gain) return;

    this.noise.connect(this.hp);
    this.hp.connect(this.bp);
    this.bp.connect(this.gain);
    this.gain.connect(this.source ? this.source.input : this.engine.bus('ambient'));

    this.noise.start();
    this.gain.gain.setTargetAtTime(0.07 * this.intensity, e.now, 1.5);

    this.running = true;
    this.scheduleBubble();
  }

  private scheduleBubble(): void {
    if (!this.running) return;
    this.bubbleTimer = setTimeout(
      () => {
        this.bubble();
        this.scheduleBubble();
      },
      90 + Math.random() * 320,
    );
  }

  /** A single bubble: a fast upward pitch sweep on a sine, very short. */
  private bubble(): void {
    const e = this.engine;
    if (!e.ready) return;
    const osc = e.createOscillator('sine', 600 + Math.random() * 1400);
    const gain = e.createGain(0.0001);
    if (!osc || !gain) return;

    osc.connect(gain);
    gain.connect(this.source ? this.source.input : e.bus('ambient'));

    const t = e.now;
    const dur = 0.03 + Math.random() * 0.05;
    // The rising pitch is what makes it read as a bubble rather than a beep.
    osc.frequency.exponentialRampToValueAtTime(osc.frequency.value * 2.4, t + dur);

    const end = e.envelope(gain.gain, t, {
      peak: 0.014 * this.intensity,
      attack: 0.004,
      release: dur,
    });

    osc.start(t);
    e.scheduleTeardown([osc, gain], [osc], end + 0.02);
  }

  stop(): void {
    this.running = false;
    if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
    this.gain?.gain.setTargetAtTime(0.0001, this.engine.now, 0.4);
  }

  dispose(): void {
    this.stop();
    try {
      this.noise?.stop();
    } catch {
      /* Not started. */
    }
    [this.noise, this.bp, this.hp, this.gain].forEach((n) => n?.disconnect());
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * INSECTS
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The cricket chorus.
 *
 * A real cricket chirp is a train of very short pulses of near-sinusoidal
 * ~4 kHz sound. This models that literally: a high-Q band-pass around 4.2 kHz
 * excited by a burst of amplitude-gated noise, repeated three to five times per
 * chirp. Several instances run with independent phases and slightly detuned
 * centre frequencies, which produces the shimmering, uncountable mass of a real
 * summer night rather than one loud insect.
 */
export class CricketChorus implements AmbientVoice {
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private running = false;
  private density = 1;

  constructor(
    private readonly engine: SynthEngine,
    private readonly sources: Array<SpatialSource | null>,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.sources.forEach((_, i) => this.scheduleFor(i));
  }

  /** @param density - 0 (silent) to 1 (full summer chorus). */
  update(density: number): void {
    this.density = clamp(density, 0, 1);
  }

  private scheduleFor(index: number): void {
    if (!this.running) return;
    // Silence at low density comes from stretching the gaps, not from gating —
    // gating produces an audible on/off edge.
    const gap = lerp(4200, 480, this.density) * (0.55 + Math.random() * 0.9);
    const timer = setTimeout(() => {
      if (this.density > 0.04) this.chirp(index);
      this.scheduleFor(index);
    }, gap);
    this.timers[index] = timer;
  }

  private chirp(index: number): void {
    const e = this.engine;
    if (!e.ready || !e.context) return;

    const src = e.createNoiseSource('white');
    // Q of 22 is extremely narrow — this is what gives the chirp its pitched,
    // almost-tonal quality instead of sounding like a hiss.
    const bp = e.createFilter('bandpass', 3800 + Math.random() * 900, 22);
    const gain = e.createGain(0.0001);
    if (!src || !bp || !gain) return;

    src.connect(bp);
    bp.connect(gain);
    gain.connect(this.sources[index]?.input ?? e.bus('wildlife'));

    const t = e.now;
    const pulses = 3 + Math.floor(Math.random() * 3);
    const pulseLen = 0.016;
    const pulseGap = 0.022 + Math.random() * 0.01;
    const amp = 0.05 * this.density;

    gain.gain.setValueAtTime(0.0001, t);
    for (let p = 0; p < pulses; p++) {
      const start = t + p * (pulseLen + pulseGap);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(amp, start + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + pulseLen);
    }
    const end = t + pulses * (pulseLen + pulseGap) + 0.05;

    src.start(t);
    e.scheduleTeardown([src, bp, gain], [src], end);
  }

  stop(): void {
    this.running = false;
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
  }

  dispose(): void {
    this.stop();
  }
}

/**
 * Pond frogs.
 *
 * A croak is a low buzzy pulse train shaped by two formant band-passes — the
 * same principle as a vowel in speech. The formant pair (around 400 Hz and
 * 1.1 kHz) is what makes it sound like an animal's throat rather than a
 * synthesiser's sawtooth.
 */
export class FrogVoice implements AmbientVoice {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private density = 1;

  constructor(
    private readonly engine: SynthEngine,
    private readonly source: SpatialSource | null,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  update(density: number): void {
    this.density = clamp(density, 0, 1);
  }

  private schedule(): void {
    if (!this.running) return;
    const gap = lerp(9000, 1400, this.density) * (0.5 + Math.random());
    this.timer = setTimeout(() => {
      if (this.density > 0.05) this.croak();
      this.schedule();
    }, gap);
  }

  private croak(): void {
    const e = this.engine;
    if (!e.ready) return;

    const base = 72 + Math.random() * 34;
    const osc = e.createOscillator('sawtooth', base);
    const f1 = e.createFilter('bandpass', 400 + Math.random() * 120, 5);
    const f2 = e.createFilter('bandpass', 1100 + Math.random() * 260, 7);
    const mix = e.createGain(0.5);
    const gain = e.createGain(0.0001);
    // A slow amplitude LFO gives the croak its characteristic rattle.
    const trem = e.createOscillator('square', 26 + Math.random() * 12);
    const tremGain = e.createGain(0.4);
    if (!osc || !f1 || !f2 || !mix || !gain || !trem || !tremGain) return;

    osc.connect(f1);
    osc.connect(f2);
    f1.connect(mix);
    f2.connect(mix);
    mix.connect(gain);
    gain.connect(this.source?.input ?? e.bus('wildlife'));

    trem.connect(tremGain);
    tremGain.connect(gain.gain);

    const t = e.now;
    const dur = 0.22 + Math.random() * 0.3;
    const end = e.envelope(gain.gain, t, {
      peak: 0.09 * this.density,
      attack: 0.03,
      decay: dur * 0.3,
      sustain: 0.06 * this.density,
      hold: dur * 0.4,
      release: dur * 0.35,
    });

    osc.start(t);
    trem.start(t);
    e.scheduleTeardown([osc, f1, f2, mix, gain, trem, tremGain], [osc, trem], end + 0.05);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  dispose(): void {
    this.stop();
  }
}
