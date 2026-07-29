/**
 * Generative ambient score.
 *
 * A slow arpeggiator in **D mixolydian** — the major scale with a flattened
 * seventh. Mixolydian is the mode of pastoral folk music precisely because it
 * is bright like a major scale but its flat seventh refuses to resolve upward
 * to the tonic. It sounds settled without sounding finished, which is the exact
 * emotional register this valley is aiming at.
 *
 * Harmony shifts with the time of day:
 *
 * | Time    | Chord quality                | Feel |
 * |---------|------------------------------|------|
 * | Morning | Major triads, added ninths   | Open, awake |
 * | Noon    | Major, wide voicings         | Bright, still |
 * | Golden  | Major sixths, suspended      | Warm, unresolved |
 * | Night   | Minor sevenths, minor ninths | Cool, interior |
 *
 * Voices are two-operator FM with long attacks — a bell/rhodes hybrid that sits
 * under the ambience without ever competing with it.
 *
 * @module components/audio/sources/music
 */

import type { SynthEngine } from '../SynthEngine';
import { AUDIO } from '@/config/game';
import { clamp, wrap } from '@/lib/utils/math';

/** Semitone offsets from the root for each chord, by time-of-day region. */
const PROGRESSIONS: Record<string, number[][]> = {
  /* I – V – vi – IV, all bright. Added 9ths for air. */
  morning: [
    [0, 4, 7, 14],
    [7, 11, 14, 21],
    [9, 12, 16, 23],
    [5, 9, 12, 19],
  ],
  /* Wide, sparse voicings — the harmony gets out of the way at noon. */
  noon: [
    [0, 7, 16, 26],
    [5, 12, 21, 28],
    [7, 14, 23, 31],
    [0, 9, 16, 24],
  ],
  /* Sixths and suspensions: warm, hanging, never quite landing. */
  golden: [
    [0, 4, 9, 14],
    [-3, 2, 7, 12],
    [5, 9, 14, 17],
    [-5, 2, 7, 11],
  ],
  /* Minor sevenths and ninths. The flat seventh of mixolydian doing real work. */
  night: [
    [0, 3, 7, 10],
    [-2, 3, 5, 10],
    [-5, 2, 7, 10],
    [-7, 0, 5, 8],
  ],
};

/** D mixolydian scale degrees, in semitones. */
const MIXOLYDIAN = [0, 2, 4, 5, 7, 9, 10];

/** Converts a semitone offset from the root into a frequency. */
function semitoneToHz(root: number, semitones: number): number {
  return root * Math.pow(2, semitones / 12);
}

/**
 * Picks the progression appropriate to the current time of day.
 * Boundaries are chosen to line up with the five lighting states.
 */
function progressionFor(timeOfDay: number): number[][] {
  const t = wrap(timeOfDay, 1);
  if (t >= 0.18 && t < 0.42) return PROGRESSIONS.morning!;
  if (t >= 0.42 && t < 0.66) return PROGRESSIONS.noon!;
  if (t >= 0.66 && t < 0.82) return PROGRESSIONS.golden!;
  return PROGRESSIONS.night!;
}

/**
 * The ambient music engine.
 *
 * Scheduling uses a **lookahead scheduler** rather than one `setTimeout` per
 * note: a timer fires every 100 ms and schedules any notes falling in the next
 * 300 ms directly onto the Web Audio clock. `setTimeout` drift is measured in
 * tens of milliseconds and would make the arpeggio audibly stumble; the audio
 * clock is sample-accurate.
 */
export class AmbientMusic {
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private nextNoteTime = 0;
  private step = 0;
  private chordIndex = 0;
  private running = false;
  private masterGain: GainNode | null = null;
  private timeOfDay = 0.72;

  /** How far ahead of the audio clock notes are scheduled, seconds. */
  private readonly lookahead = 0.35;
  /** How often the scheduler wakes, milliseconds. */
  private readonly tickMs = 100;

  constructor(private readonly engine: SynthEngine) {}

  start(): void {
    const e = this.engine;
    if (!e.ready || this.running) return;

    this.masterGain = e.createGain(0.0001);
    if (!this.masterGain) return;
    this.masterGain.connect(e.bus('music'));
    this.masterGain.gain.setTargetAtTime(0.55, e.now, 2.5);

    this.nextNoteTime = e.now + 0.2;
    this.running = true;
    this.schedulerTimer = setInterval(() => this.scheduler(), this.tickMs);
  }

  /** Updates the harmonic colour. Takes effect at the next chord change. */
  setTimeOfDay(t: number): void {
    this.timeOfDay = t;
  }

  private scheduler(): void {
    const e = this.engine;
    if (!this.running || !e.ready) return;

    // One "step" is an eighth note at the configured tempo.
    const secondsPerStep = 60 / AUDIO.MUSIC_BPM / 2;

    while (this.nextNoteTime < e.now + this.lookahead) {
      this.scheduleStep(this.nextNoteTime);
      this.nextNoteTime += secondsPerStep;
      this.step++;

      // Change chord every 16 steps — two bars at this tempo, roughly 18 s.
      if (this.step % 16 === 0) {
        const prog = progressionFor(this.timeOfDay);
        this.chordIndex = (this.chordIndex + 1) % prog.length;
      }
    }
  }

  private scheduleStep(time: number): void {
    const prog = progressionFor(this.timeOfDay);
    const chord = prog[this.chordIndex]!;

    // Sparse: most steps are rests. Density is what keeps this ambient rather
    // than melodic — a note on every step would demand attention.
    const density = 0.42;
    if (Math.random() > density) return;

    // Arpeggiate through the chord, occasionally reaching for a passing tone
    // from the mode.
    let semitone: number;
    if (Math.random() < 0.82) {
      semitone = chord[this.step % chord.length]!;
    } else {
      const degree = MIXOLYDIAN[Math.floor(Math.random() * MIXOLYDIAN.length)]!;
      semitone = degree + (Math.random() < 0.5 ? 12 : 0);
    }

    // Occasional octave displacement stops the line from sitting in one register.
    if (Math.random() < 0.18) semitone += 12;

    this.playNote(semitoneToHz(AUDIO.MUSIC_ROOT_HZ, semitone), time, 0.55 + Math.random() * 0.45);

    // A quiet root drone underneath, on the downbeat of each chord.
    if (this.step % 16 === 0) {
      this.playNote(semitoneToHz(AUDIO.MUSIC_ROOT_HZ, chord[0]! - 12), time, 0.5, 7);
    }
  }

  /**
   * Two-operator FM voice.
   *
   * The modulator sits at a non-integer ratio (2.01) to the carrier, which
   * produces slightly inharmonic sidebands — a bell-like shimmer that a
   * perfectly integer ratio would not give. A long attack keeps every note from
   * having a transient, which is what lets the score sit *underneath* the
   * world's sound rather than on top of it.
   */
  private playNote(freq: number, time: number, velocity: number, duration = 3.4): void {
    const e = this.engine;
    if (!e.ready || !this.masterGain) return;

    const carrier = e.createOscillator('sine', freq);
    const modulator = e.createOscillator('sine', freq * 2.01);
    const modGain = e.createGain(freq * 1.6);
    const lp = e.createFilter('lowpass', 2600, 0.7);
    const gain = e.createGain(0.0001);
    if (!carrier || !modulator || !modGain || !lp || !gain) return;

    modulator.connect(modGain);
    modGain.connect(carrier.frequency);
    carrier.connect(lp);
    lp.connect(gain);
    gain.connect(this.masterGain);

    // Modulation index decays, so the note gets purer as it sustains.
    modGain.gain.setValueAtTime(freq * 1.6 * velocity, time);
    modGain.gain.exponentialRampToValueAtTime(freq * 0.05, time + duration * 0.5);

    const peak = 0.075 * velocity;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(peak, time + 0.16);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    carrier.start(time);
    modulator.start(time);
    e.scheduleTeardown(
      [carrier, modulator, modGain, lp, gain],
      [carrier, modulator],
      time + duration + 0.1,
    );
  }

  stop(): void {
    this.running = false;
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
    this.masterGain?.gain.setTargetAtTime(0.0001, this.engine.now, 1.2);
  }

  dispose(): void {
    this.stop();
    setTimeout(() => this.masterGain?.disconnect(), 2500);
  }

  /** Sets the overall level, 0..1. */
  setLevel(value: number): void {
    this.masterGain?.gain.setTargetAtTime(clamp(value, 0, 1) * 0.55, this.engine.now, 0.8);
  }
}
