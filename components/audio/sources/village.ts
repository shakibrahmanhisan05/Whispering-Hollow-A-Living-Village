/**
 * Village and player Foley: the church bell, the windmill, footsteps, jumps,
 * the well, weather and UI.
 *
 * @module components/audio/sources/village
 */

import type { SynthEngine, SpatialSource } from '../SynthEngine';
import type { SurfaceId } from '@/config/game';
import { clamp, lerp } from '@/lib/utils/math';

/* ───────────────────────────────────────────────────────────────────────────
 * CHURCH BELL
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The church bell — additive synthesis with **inharmonic** partials.
 *
 * This is the one voice where the physics really matter. A struck bar or string
 * produces harmonics at integer multiples of the fundamental. A *bell* does
 * not: its partials sit at irregular ratios determined by the shape of the
 * casting, and it is precisely that inharmonicity which makes a bell sound like
 * a bell rather than an organ pipe.
 *
 * The ratios below are the classic set for a well-tuned church bell:
 *
 * | Partial | Ratio | Traditional name |
 * |---------|-------|------------------|
 * | 1       | 0.50  | Hum (an octave below the strike) |
 * | 2       | 1.00  | Prime / fundamental |
 * | 3       | 1.19  | Tierce (a *minor* third — why bells sound melancholy) |
 * | 4       | 1.50  | Quint |
 * | 5       | 2.00  | Nominal (this is the pitch you actually perceive) |
 * | 6       | 2.51  | Superquint |
 * | 7       | 3.01  | Octave nominal |
 * | 8+      | …     | Upper partials, decaying fastest |
 *
 * Each partial also gets its **own decay rate** — high partials die away in a
 * second or two while the hum rings for many seconds. That divergence is what
 * makes the tail evolve from a bright clang into a warm hum instead of just
 * getting quieter.
 */
export function playChurchBell(
  e: SynthEngine,
  src: SpatialSource | null,
  opts: { fundamental?: number; volume?: number } = {},
): void {
  if (!e.ready || !e.context) return;
  const { fundamental = 220, volume = 1 } = opts;
  const t = e.now + 0.02;

  /** `[frequencyRatio, relativeAmplitude, decaySeconds]` */
  const partials: Array<[number, number, number]> = [
    [0.5, 0.55, 9.5], // hum — longest ring
    [1.0, 0.85, 7.2], // prime
    [1.19, 0.62, 5.8], // tierce (minor third)
    [1.5, 0.4, 4.6], // quint
    [2.0, 1.0, 6.4], // nominal — the perceived pitch
    [2.51, 0.34, 3.2], // superquint
    [3.01, 0.28, 2.6], // octave nominal
    [4.13, 0.19, 1.7],
    [5.33, 0.13, 1.2],
    [6.81, 0.09, 0.8], // upper partials — the initial "clang"
  ];

  const nodes: AudioNode[] = [];
  const sources: AudioScheduledSourceNode[] = [];

  const busGain = e.createGain(0.22 * volume);
  if (!busGain) return;
  busGain.connect(src?.input ?? e.bus('ambient'));
  nodes.push(busGain);

  let longest = 0;
  for (const [ratio, amp, decay] of partials) {
    const osc = e.createOscillator('sine', fundamental * ratio);
    const gain = e.createGain(0.0001);
    if (!osc || !gain) continue;

    // Real bells have slightly detuned twin partials that beat against each
    // other — the shimmer in a bell's tail. A few cents is enough.
    osc.detune.value = (Math.random() - 0.5) * 6;

    osc.connect(gain);
    gain.connect(busGain);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(amp, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);

    osc.start(t);
    nodes.push(osc, gain);
    sources.push(osc);
    longest = Math.max(longest, decay);
  }

  // The strike transient: a short noise burst for the clapper hitting metal.
  const strike = e.createNoiseSource('white');
  const strikeBp = e.createFilter('bandpass', fundamental * 6, 1.8);
  const strikeGain = e.createGain(0.0001);
  if (strike && strikeBp && strikeGain) {
    strike.connect(strikeBp);
    strikeBp.connect(strikeGain);
    strikeGain.connect(busGain);
    e.envelope(strikeGain.gain, t, { peak: 0.5, attack: 0.001, release: 0.09 });
    strike.start(t);
    nodes.push(strike, strikeBp, strikeGain);
    sources.push(strike);
  }

  if (src) src.setReverb(0.65);
  e.scheduleTeardown(nodes, sources, t + longest + 0.5);
}

/* ───────────────────────────────────────────────────────────────────────────
 * WINDMILL
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The windmill's creaking timber.
 *
 * A creak is stick–slip friction: wood binds, releases, and the released energy
 * rings a resonance. Modelled as a very high-Q band-pass excited by a short
 * noise impulse, with the resonant frequency randomised per creak. Creaks fire
 * once per revolution, synced to the sail rotation.
 */
export class WindmillVoice {
  private lastPhase = 0;
  private axleNoise: AudioBufferSourceNode | null = null;
  private axleFilter: BiquadFilterNode | null = null;
  private axleGain: GainNode | null = null;

  constructor(
    private readonly engine: SynthEngine,
    private readonly source: SpatialSource | null,
  ) {}

  start(): void {
    const e = this.engine;
    if (!e.ready) return;
    // A continuous low grinding bed under the discrete creaks.
    this.axleNoise = e.createNoiseSource('brown');
    this.axleFilter = e.createFilter('bandpass', 140, 3.5);
    this.axleGain = e.createGain(0.0001);
    if (!this.axleNoise || !this.axleFilter || !this.axleGain) return;

    this.axleNoise.connect(this.axleFilter);
    this.axleFilter.connect(this.axleGain);
    this.axleGain.connect(this.source?.input ?? e.bus('ambient'));
    this.axleNoise.start();
  }

  /**
   * @param rotationPhase - Sail rotation in radians; creaks fire on wrap.
   * @param speed - Angular speed, rad/s. Drives creak brightness and axle level.
   */
  update(rotationPhase: number, speed: number): void {
    const e = this.engine;
    if (!e.ready) return;

    if (this.axleGain && this.axleFilter) {
      this.axleGain.gain.setTargetAtTime(
        Math.max(clamp(speed, 0, 3) * 0.012, 0.0001),
        e.now,
        0.4,
      );
      this.axleFilter.frequency.setTargetAtTime(lerp(90, 210, clamp(speed / 3, 0, 1)), e.now, 0.4);
    }

    // Fire a creak each quarter revolution — once per sail passing the tower.
    const quarter = Math.PI / 2;
    const phase = Math.floor(rotationPhase / quarter);
    if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      if (speed > 0.12) this.creak(clamp(speed / 2.2, 0.15, 1));
    }
  }

  private creak(intensity: number): void {
    const e = this.engine;
    const t = e.now + Math.random() * 0.05;

    const noise = e.createNoiseSource('pink');
    // Q of 26 is nearly a resonator — a struck plank rather than a rustle.
    const bp = e.createFilter('bandpass', 380 + Math.random() * 900, 26);
    const gain = e.createGain(0.0001);
    if (!noise || !bp || !gain) return;

    noise.connect(bp);
    bp.connect(gain);
    gain.connect(this.source?.input ?? e.bus('ambient'));

    const dur = 0.25 + Math.random() * 0.45;
    // The upward frequency drift is the stick–slip "grrrk".
    bp.frequency.linearRampToValueAtTime(bp.frequency.value * (1.2 + Math.random() * 0.6), t + dur);

    const end = e.envelope(gain.gain, t, {
      peak: 0.06 * intensity,
      attack: 0.04,
      decay: dur * 0.4,
      sustain: 0.02 * intensity,
      release: dur * 0.6,
    });

    noise.start(t);
    e.scheduleTeardown([noise, bp, gain], [noise], end + 0.05);
  }

  dispose(): void {
    try {
      this.axleNoise?.stop();
    } catch {
      /* Not started. */
    }
    [this.axleNoise, this.axleFilter, this.axleGain].forEach((n) => n?.disconnect());
  }
}

/**
 * The ridge wind-chime: five tuned metal tubes in a pentatonic scale, struck
 * at a rate proportional to wind strength.
 *
 * Pentatonic because any two notes in it are consonant — the chime can never
 * sound wrong no matter which tubes the wind happens to hit.
 */
export class WindChimeVoice {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private strength = 0.4;
  private running = false;

  /** D major pentatonic, tuned high and bright. */
  private readonly notes = [587.33, 659.25, 783.99, 880.0, 1046.5];

  constructor(
    private readonly engine: SynthEngine,
    private readonly source: SpatialSource | null,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  update(windStrength: number): void {
    this.strength = clamp(windStrength, 0, 2);
  }

  private schedule(): void {
    if (!this.running) return;
    const gap = lerp(4200, 260, clamp(this.strength / 1.6, 0, 1)) * (0.4 + Math.random() * 1.2);
    this.timer = setTimeout(() => {
      if (this.strength > 0.12) this.strike();
      this.schedule();
    }, gap);
  }

  private strike(): void {
    const e = this.engine;
    if (!e.ready) return;
    const t = e.now + 0.01;
    const freq = this.notes[Math.floor(Math.random() * this.notes.length)]!;

    // A metal tube's partials are inharmonic but far simpler than a bell's.
    const ratios: Array<[number, number, number]> = [
      [1, 1, 3.4],
      [2.76, 0.4, 2.1],
      [5.4, 0.16, 1.1],
    ];

    const nodes: AudioNode[] = [];
    const sources: AudioScheduledSourceNode[] = [];
    const out = e.createGain(0.09 * clamp(this.strength, 0.2, 1.4));
    if (!out) return;
    out.connect(this.source?.input ?? e.bus('ambient'));
    nodes.push(out);

    let longest = 0;
    for (const [ratio, amp, decay] of ratios) {
      const osc = e.createOscillator('sine', freq * ratio);
      const g = e.createGain(0.0001);
      if (!osc || !g) continue;
      osc.connect(g);
      g.connect(out);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      osc.start(t);
      nodes.push(osc, g);
      sources.push(osc);
      longest = Math.max(longest, decay);
    }

    e.scheduleTeardown(nodes, sources, t + longest + 0.2);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  dispose(): void {
    this.stop();
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * FOOTSTEPS
 * ─────────────────────────────────────────────────────────────────────────── */

/** Per-surface synthesis parameters. */
const SURFACE_PROFILES: Record<
  SurfaceId,
  {
    noise: 'white' | 'pink' | 'brown';
    filterType: BiquadFilterType;
    freq: [number, number];
    q: number;
    /** Impact duration. */
    decay: number;
    level: number;
    /** Optional pitched body resonance (wood, cobble). */
    body?: { freq: [number, number]; decay: number; gain: number };
    reverb: number;
  }
> = {
  /* Grass: a soft, high, brief swish. Almost no body — grass doesn't resonate. */
  grass: {
    noise: 'white',
    filterType: 'bandpass',
    freq: [2200, 4200],
    q: 0.9,
    decay: 0.11,
    level: 0.07,
    reverb: 0.06,
  },
  /* Dirt: mid-band scuff plus a small low thud from compacted earth. */
  dirt: {
    noise: 'pink',
    filterType: 'bandpass',
    freq: [700, 1500],
    q: 1.1,
    decay: 0.13,
    level: 0.09,
    body: { freq: [80, 130], decay: 0.09, gain: 0.35 },
    reverb: 0.1,
  },
  /* Cobble: a sharp, bright click with a genuine reverb tail — stone in an
   * open plaza is the most reflective surface in the village. */
  cobblestone: {
    noise: 'white',
    filterType: 'highpass',
    freq: [2600, 5200],
    q: 1.4,
    decay: 0.055,
    level: 0.085,
    body: { freq: [320, 520], decay: 0.06, gain: 0.28 },
    reverb: 0.42,
  },
  /* Wood: dominated by the body resonance — a hollow plank over a void. */
  wood: {
    noise: 'pink',
    filterType: 'bandpass',
    freq: [900, 1800],
    q: 1.6,
    decay: 0.09,
    level: 0.08,
    body: { freq: [150, 260], decay: 0.19, gain: 0.75 },
    reverb: 0.2,
  },
};

/**
 * One footstep.
 *
 * @param surface - Ground material, from the terrain classifier.
 * @param intensity - 0..1; sprinting steps are heavier than crouched ones.
 */
export function playFootstep(
  e: SynthEngine,
  src: SpatialSource | null,
  surface: SurfaceId,
  intensity = 1,
): void {
  if (!e.ready) return;
  const profile = SURFACE_PROFILES[surface] ?? SURFACE_PROFILES.grass;
  const t = e.now + 0.005;

  const nodes: AudioNode[] = [];
  const sources: AudioScheduledSourceNode[] = [];

  const out = e.createGain(1);
  if (!out) return;
  out.connect(src?.input ?? e.bus('footsteps'));
  nodes.push(out);
  if (src) src.setReverb(profile.reverb);

  // Scuff / impact noise.
  const noise = e.createNoiseSource(profile.noise);
  const filter = e.createFilter(
    profile.filterType,
    lerp(profile.freq[0], profile.freq[1], Math.random()),
    profile.q,
  );
  const gain = e.createGain(0.0001);
  if (noise && filter && gain) {
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(out);
    e.envelope(gain.gain, t, {
      peak: profile.level * intensity,
      attack: 0.002,
      decay: profile.decay * 0.35,
      sustain: profile.level * intensity * 0.25,
      release: profile.decay * 0.65,
    });
    noise.start(t);
    nodes.push(noise, filter, gain);
    sources.push(noise);
  }

  // Pitched body resonance, where the surface has one.
  if (profile.body) {
    const osc = e.createOscillator(
      'sine',
      lerp(profile.body.freq[0], profile.body.freq[1], Math.random()),
    );
    const bodyGain = e.createGain(0.0001);
    if (osc && bodyGain) {
      osc.connect(bodyGain);
      bodyGain.connect(out);
      // A slight downward pitch bend reads as the surface flexing under load.
      osc.frequency.exponentialRampToValueAtTime(
        osc.frequency.value * 0.82,
        t + profile.body.decay,
      );
      e.envelope(bodyGain.gain, t, {
        peak: profile.level * profile.body.gain * intensity,
        attack: 0.003,
        release: profile.body.decay,
      });
      osc.start(t);
      nodes.push(osc, bodyGain);
      sources.push(osc);
    }
  }

  const total = Math.max(profile.decay, profile.body?.decay ?? 0) + 0.15;
  e.scheduleTeardown(nodes, sources, t + total);
}

/** Landing thud after a jump, with a dust-puff noise tail. */
export function playLanding(
  e: SynthEngine,
  src: SpatialSource | null,
  surface: SurfaceId,
  force = 1,
): void {
  playFootstep(e, src, surface, clamp(force * 1.9, 0.5, 2.4));
  if (!e.ready) return;

  const t = e.now + 0.01;
  const thud = e.createOscillator('sine', 62);
  const gain = e.createGain(0.0001);
  if (!thud || !gain) return;
  thud.connect(gain);
  gain.connect(src?.input ?? e.bus('footsteps'));
  thud.frequency.exponentialRampToValueAtTime(38, t + 0.16);
  const end = e.envelope(gain.gain, t, { peak: 0.11 * force, attack: 0.004, release: 0.19 });
  thud.start(t);
  e.scheduleTeardown([thud, gain], [thud], end + 0.05);
}

/** Cloth rustle for the jump take-off and emotes. */
export function playClothRustle(e: SynthEngine, src: SpatialSource | null, volume = 1): void {
  if (!e.ready) return;
  const t = e.now + 0.005;
  const noise = e.createNoiseSource('white');
  const bp = e.createFilter('bandpass', 2800, 0.8);
  const gain = e.createGain(0.0001);
  if (!noise || !bp || !gain) return;
  noise.connect(bp);
  bp.connect(gain);
  gain.connect(src?.input ?? e.bus('footsteps'));
  const end = e.envelope(gain.gain, t, {
    peak: 0.035 * volume,
    attack: 0.012,
    decay: 0.06,
    sustain: 0.01,
    release: 0.12,
  });
  noise.start(t);
  e.scheduleTeardown([noise, bp, gain], [noise], end + 0.03);
}

/* ───────────────────────────────────────────────────────────────────────────
 * WATER INTERACTIONS
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * A stone skipping across the pond. Each skip is quieter, higher and closer to
 * the last than the one before, which is exactly how a real skip decays.
 *
 * @param skips - How many bounces to sound.
 */
export function playStoneSkip(e: SynthEngine, src: SpatialSource | null, skips: number): void {
  if (!e.ready) return;
  let cursor = e.now + 0.02;
  let gap = 0.36;

  for (let i = 0; i < skips; i++) {
    const fade = 1 - (i / Math.max(skips, 1)) * 0.65;

    const osc = e.createOscillator('sine', 900 + i * 180);
    const oscGain = e.createGain(0.0001);
    const noise = e.createNoiseSource('white');
    const hp = e.createFilter('highpass', 2200 + i * 400, 0.9);
    const noiseGain = e.createGain(0.0001);
    if (!osc || !oscGain || !noise || !hp || !noiseGain) break;

    const out = src?.input ?? e.bus('ambient');
    osc.connect(oscGain);
    oscGain.connect(out);
    noise.connect(hp);
    hp.connect(noiseGain);
    noiseGain.connect(out);

    osc.frequency.exponentialRampToValueAtTime(280 + i * 90, cursor + 0.06);
    e.envelope(oscGain.gain, cursor, { peak: 0.1 * fade, attack: 0.002, release: 0.07 });
    e.envelope(noiseGain.gain, cursor, { peak: 0.05 * fade, attack: 0.002, release: 0.1 });

    osc.start(cursor);
    noise.start(cursor);
    e.scheduleTeardown([osc, oscGain, noise, hp, noiseGain], [osc, noise], cursor + 0.25);

    cursor += gap;
    // Each successive skip comes faster — the stone is losing energy.
    gap *= 0.76;
  }

  // The final plunk as it sinks.
  const t = cursor;
  const sink = e.createOscillator('sine', 420);
  const sinkGain = e.createGain(0.0001);
  if (sink && sinkGain) {
    sink.connect(sinkGain);
    sinkGain.connect(src?.input ?? e.bus('ambient'));
    sink.frequency.exponentialRampToValueAtTime(120, t + 0.18);
    const end = e.envelope(sinkGain.gain, t, { peak: 0.11, attack: 0.003, release: 0.2 });
    sink.start(t);
    e.scheduleTeardown([sink, sinkGain], [sink], end + 0.05);
  }
}

/** The well's bucket and chain. */
export function playWellCrank(e: SynthEngine, src: SpatialSource | null): void {
  if (!e.ready) return;
  const t0 = e.now + 0.02;
  // A ratcheting sequence of small metallic clicks.
  for (let i = 0; i < 9; i++) {
    const t = t0 + i * 0.13;
    const osc = e.createOscillator('square', 1400 + Math.random() * 600);
    const bp = e.createFilter('bandpass', 2600, 8);
    const gain = e.createGain(0.0001);
    if (!osc || !bp || !gain) continue;
    osc.connect(bp);
    bp.connect(gain);
    gain.connect(src?.input ?? e.bus('ambient'));
    const end = e.envelope(gain.gain, t, { peak: 0.05, attack: 0.001, release: 0.06 });
    osc.start(t);
    e.scheduleTeardown([osc, bp, gain], [osc], end + 0.03);
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * WEATHER
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Rain.
 *
 * Two simultaneous noise beds: a bright one (rain striking leaves and roofs)
 * and a darker, wetter one (rain on soil and water). Crossfading between them
 * as the player moves under trees is what makes the rain feel like it is
 * landing on *this* place rather than playing over it.
 */
export class RainVoice {
  private noise: AudioBufferSourceNode | null = null;
  private brightBp: BiquadFilterNode | null = null;
  private darkBp: BiquadFilterNode | null = null;
  private brightGain: GainNode | null = null;
  private darkGain: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private started = false;

  constructor(private readonly engine: SynthEngine) {}

  start(): void {
    const e = this.engine;
    if (!e.ready || this.started) return;

    this.noise = e.createNoiseSource('white');
    this.brightBp = e.createFilter('bandpass', 5200, 0.55);
    this.darkBp = e.createFilter('bandpass', 1300, 0.5);
    this.brightGain = e.createGain(0.5);
    this.darkGain = e.createGain(0.5);
    this.masterGain = e.createGain(0.0001);
    if (
      !this.noise ||
      !this.brightBp ||
      !this.darkBp ||
      !this.brightGain ||
      !this.darkGain ||
      !this.masterGain
    )
      return;

    this.noise.connect(this.brightBp);
    this.noise.connect(this.darkBp);
    this.brightBp.connect(this.brightGain);
    this.darkBp.connect(this.darkGain);
    this.brightGain.connect(this.masterGain);
    this.darkGain.connect(this.masterGain);
    this.masterGain.connect(e.bus('ambient'));

    this.noise.start();
    this.started = true;
  }

  /**
   * @param intensity - 0 (dry) to 1 (downpour).
   * @param canopy - 0 (open sky) to 1 (dense canopy overhead).
   */
  update(intensity: number, canopy: number): void {
    if (!this.masterGain || !this.brightGain || !this.darkGain) return;
    const t = this.engine.now;
    const i = clamp(intensity, 0, 1);
    this.masterGain.gain.setTargetAtTime(Math.max(i * 0.15, 0.0001), t, 0.8);
    // Under a canopy the sound is all leaf-strike: brighter and drier.
    this.brightGain.gain.setTargetAtTime(lerp(0.32, 0.78, clamp(canopy, 0, 1)), t, 0.5);
    this.darkGain.gain.setTargetAtTime(lerp(0.7, 0.28, clamp(canopy, 0, 1)), t, 0.5);
  }

  stop(): void {
    this.masterGain?.gain.setTargetAtTime(0.0001, this.engine.now, 0.9);
  }

  dispose(): void {
    try {
      this.noise?.stop();
    } catch {
      /* Not started. */
    }
    [this.noise, this.brightBp, this.darkBp, this.brightGain, this.darkGain, this.masterGain].forEach(
      (n) => n?.disconnect(),
    );
    this.started = false;
  }
}

/**
 * Thunder.
 *
 * Three overlapping layers, because a real thunderclap is three separate
 * physical events:
 *   1. The **crack** — the initial shock front. Bright, fast, brutal.
 *   2. The **body** — the main discharge, mid-frequency, half a second.
 *   3. The **rumble** — the echo off terrain and cloud, brown noise low-passed
 *      hard, rolling on for many seconds with a wandering amplitude.
 *
 * @param distance - World units from the strike. Controls both the delay before
 *   the sound arrives and how much high frequency has been absorbed by the air.
 */
export function playThunder(e: SynthEngine, distance: number): void {
  if (!e.ready) return;
  const t = e.now + 0.02;
  // Air absorbs high frequencies with distance: a close strike cracks, a
  // distant one only rumbles.
  const closeness = clamp(1 - distance / 400, 0, 1);
  const nodes: AudioNode[] = [];
  const sources: AudioScheduledSourceNode[] = [];

  const out = e.createGain(1);
  if (!out) return;
  out.connect(e.bus('ambient'));
  nodes.push(out);

  // 1. Crack.
  if (closeness > 0.25) {
    const crack = e.createNoiseSource('white');
    const hp = e.createFilter('highpass', 1400, 0.8);
    const g = e.createGain(0.0001);
    if (crack && hp && g) {
      crack.connect(hp);
      hp.connect(g);
      g.connect(out);
      e.envelope(g.gain, t, { peak: 0.4 * closeness, attack: 0.001, release: 0.22 });
      crack.start(t);
      nodes.push(crack, hp, g);
      sources.push(crack);
    }
  }

  // 2. Body.
  const body = e.createNoiseSource('pink');
  const bodyLp = e.createFilter('lowpass', lerp(300, 1800, closeness), 0.9);
  const bodyGain = e.createGain(0.0001);
  if (body && bodyLp && bodyGain) {
    body.connect(bodyLp);
    bodyLp.connect(bodyGain);
    bodyGain.connect(out);
    e.envelope(bodyGain.gain, t + 0.02, {
      peak: 0.32,
      attack: 0.02,
      decay: 0.3,
      sustain: 0.12,
      hold: 0.2,
      release: 0.9,
    });
    body.start(t);
    nodes.push(body, bodyLp, bodyGain);
    sources.push(body);
  }

  // 3. Rumble — with a slow LFO on gain so the tail rolls rather than fading
  // smoothly. This is the difference between "thunder" and "a noise sweep".
  const rumble = e.createNoiseSource('brown');
  const rumbleLp = e.createFilter('lowpass', lerp(90, 220, closeness), 1.2);
  const rumbleGain = e.createGain(0.0001);
  const roll = e.createOscillator('sine', 0.6 + Math.random() * 0.5);
  const rollGain = e.createGain(0.16);
  if (rumble && rumbleLp && rumbleGain && roll && rollGain) {
    rumble.connect(rumbleLp);
    rumbleLp.connect(rumbleGain);
    rumbleGain.connect(out);
    roll.connect(rollGain);
    rollGain.connect(rumbleGain.gain);

    const rumbleDur = 3.5 + closeness * 3;
    rumbleGain.gain.setValueAtTime(0.0001, t);
    rumbleGain.gain.exponentialRampToValueAtTime(0.34, t + 0.35);
    rumbleGain.gain.exponentialRampToValueAtTime(0.0001, t + rumbleDur);

    rumble.start(t);
    roll.start(t);
    nodes.push(rumble, rumbleLp, rumbleGain, roll, rollGain);
    sources.push(rumble, roll);
    e.scheduleTeardown(nodes, sources, t + rumbleDur + 0.4);
  } else {
    e.scheduleTeardown(nodes, sources, t + 2.5);
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * UI
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Menu clicks: two-operator FM synthesis, marimba-like.
 *
 * A modulator oscillator at ~3.5× the carrier frequency, with a fast-decaying
 * modulation index, produces a bright inharmonic attack that settles into a
 * near-pure tone — the defining envelope of a struck wooden bar. The whole
 * thing is four nodes and sounds far better than a filtered sine.
 *
 * @param variant - `'click'` for navigation, `'confirm'` for a positive action,
 *   `'back'` for dismissal, `'unlock'` for an achievement.
 */
export function playUiSound(
  e: SynthEngine,
  variant: 'click' | 'confirm' | 'back' | 'unlock' = 'click',
): void {
  if (!e.ready) return;
  const t = e.now + 0.005;

  const config = {
    click: { freq: 880, decay: 0.22, peak: 0.06, index: 3.2 },
    confirm: { freq: 1174.7, decay: 0.34, peak: 0.075, index: 2.6 },
    back: { freq: 587.3, decay: 0.26, peak: 0.06, index: 3.6 },
    unlock: { freq: 1318.5, decay: 0.72, peak: 0.09, index: 2.2 },
  }[variant];

  const carrier = e.createOscillator('sine', config.freq);
  const modulator = e.createOscillator('sine', config.freq * 3.5);
  const modGain = e.createGain(config.freq * config.index);
  const gain = e.createGain(0.0001);
  if (!carrier || !modulator || !modGain || !gain) return;

  modulator.connect(modGain);
  modGain.connect(carrier.frequency);
  carrier.connect(gain);
  gain.connect(e.bus('master'));

  // The modulation index collapsing is what produces the percussive attack.
  modGain.gain.setValueAtTime(config.freq * config.index, t);
  modGain.gain.exponentialRampToValueAtTime(1, t + config.decay * 0.4);

  const end = e.envelope(gain.gain, t, {
    peak: config.peak,
    attack: 0.003,
    release: config.decay,
  });

  carrier.start(t);
  modulator.start(t);

  if (variant === 'unlock') {
    // A rising perfect fifth above, a beat later — the "reward" gesture.
    const second = e.createOscillator('sine', config.freq * 1.5);
    const secondGain = e.createGain(0.0001);
    if (second && secondGain) {
      second.connect(secondGain);
      secondGain.connect(e.bus('master'));
      e.envelope(secondGain.gain, t + 0.12, { peak: 0.06, attack: 0.004, release: 0.6 });
      second.start(t + 0.12);
      e.scheduleTeardown([second, secondGain], [second], t + 0.85);
    }
  }

  e.scheduleTeardown([carrier, modulator, modGain, gain], [carrier, modulator], end + 0.05);
}
