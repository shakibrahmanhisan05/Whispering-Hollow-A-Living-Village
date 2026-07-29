/**
 * Animal voices: five bird species, plus cattle, poultry, a cat and a fox.
 *
 * Every bird is built from the same primitive — a sine or triangle oscillator
 * with a scheduled pitch contour — because that is genuinely how birdsong
 * works: a nearly pure tone whose frequency moves fast. What separates a robin
 * from a cuckoo is entirely the *shape* of that contour and the note grouping,
 * which is why each species below is essentially a small piece of notation.
 *
 * @module components/audio/sources/wildlife
 */

import type { SynthEngine, SpatialSource } from '../SynthEngine';
import { clamp } from '@/lib/utils/math';

/** Species-specific song generators. */
export type BirdVoiceId = 'robin' | 'sparrow' | 'owl' | 'crow' | 'cuckoo';

/**
 * Plays one phrase of birdsong.
 *
 * @param engine - Audio engine.
 * @param source - Spatial mixing point, so the bird sings from its branch.
 * @param voice - Which species.
 * @param volume - 0..1 scale applied on top of the species' own level.
 */
export function playBirdSong(
  engine: SynthEngine,
  source: SpatialSource | null,
  voice: BirdVoiceId,
  volume = 1,
): void {
  if (!engine.ready) return;
  switch (voice) {
    case 'robin':
      robinSong(engine, source, volume);
      break;
    case 'sparrow':
      sparrowChirp(engine, source, volume);
      break;
    case 'owl':
      owlHoot(engine, source, volume);
      break;
    case 'crow':
      crowCaw(engine, source, volume);
      break;
    case 'cuckoo':
      cuckooCall(engine, source, volume);
      break;
  }
}

/**
 * Schedules a single pitched note with a frequency contour.
 *
 * @param contour - `[timeFraction, frequencyHz]` pairs describing the glide.
 *   Fractions are of the note's total duration.
 */
function pitchedNote(
  engine: SynthEngine,
  source: SpatialSource | null,
  opts: {
    type: OscillatorType;
    startTime: number;
    duration: number;
    contour: Array<[number, number]>;
    peak: number;
    attack?: number;
    release?: number;
    /** Optional second oscillator a fixed ratio above, for a richer timbre. */
    harmonic?: { ratio: number; gain: number };
    /** Optional band-pass shaping. */
    filter?: { type: BiquadFilterType; freq: number; q: number };
    /** Vibrato depth in Hz; 0 disables. */
    vibrato?: { rate: number; depth: number };
  },
): void {
  const e = engine;
  const ctx = e.context;
  if (!ctx) return;

  const { type, startTime, duration, contour, peak } = opts;
  const attack = opts.attack ?? 0.012;
  const release = opts.release ?? 0.05;

  const osc = e.createOscillator(type, contour[0]?.[1] ?? 1000);
  const gain = e.createGain(0.0001);
  if (!osc || !gain) return;

  const nodes: AudioNode[] = [osc, gain];
  const sources: AudioScheduledSourceNode[] = [osc];

  let tail: AudioNode = osc;
  if (opts.filter) {
    const f = e.createFilter(opts.filter.type, opts.filter.freq, opts.filter.q);
    if (f) {
      tail.connect(f);
      tail = f;
      nodes.push(f);
    }
  }
  tail.connect(gain);
  gain.connect(source?.input ?? e.bus('wildlife'));

  // Frequency contour. Exponential ramps because pitch is perceived
  // logarithmically — a linear ramp between two notes sounds like it
  // accelerates through the middle.
  osc.frequency.setValueAtTime(Math.max(contour[0]?.[1] ?? 1000, 1), startTime);
  for (const [frac, hz] of contour.slice(1)) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(hz, 1), startTime + duration * frac);
  }

  if (opts.vibrato) {
    const lfo = e.createOscillator('sine', opts.vibrato.rate);
    const lfoGain = e.createGain(opts.vibrato.depth);
    if (lfo && lfoGain) {
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      lfo.start(startTime);
      nodes.push(lfo, lfoGain);
      sources.push(lfo);
    }
  }

  if (opts.harmonic) {
    const h = e.createOscillator(type, (contour[0]?.[1] ?? 1000) * opts.harmonic.ratio);
    const hGain = e.createGain(opts.harmonic.gain);
    if (h && hGain) {
      h.frequency.setValueAtTime(
        Math.max((contour[0]?.[1] ?? 1000) * opts.harmonic.ratio, 1),
        startTime,
      );
      for (const [frac, hz] of contour.slice(1)) {
        h.frequency.exponentialRampToValueAtTime(
          Math.max(hz * opts.harmonic.ratio, 1),
          startTime + duration * frac,
        );
      }
      h.connect(hGain);
      hGain.connect(gain);
      h.start(startTime);
      nodes.push(h, hGain);
      sources.push(h);
    }
  }

  const end = e.envelope(gain.gain, startTime, {
    peak,
    attack,
    decay: duration * 0.25,
    sustain: peak * 0.6,
    hold: duration * 0.5,
    release,
  });

  osc.start(startTime);
  e.scheduleTeardown(nodes, sources, end + 0.05);
}

/**
 * **Robin** — a rapid, tumbling phrase of 5–9 notes that rise and fall
 * unpredictably. The randomised note count and interval pattern mean no two
 * phrases are alike, which is exactly how a robin behaves.
 */
function robinSong(e: SynthEngine, src: SpatialSource | null, vol: number): void {
  const t0 = e.now + 0.02;
  const notes = 5 + Math.floor(Math.random() * 5);
  let cursor = t0;
  let freq = 2200 + Math.random() * 900;

  for (let i = 0; i < notes; i++) {
    const dur = 0.06 + Math.random() * 0.1;
    // Each note glides either up or down by up to a fifth.
    const target = freq * (0.72 + Math.random() * 0.72);
    pitchedNote(e, src, {
      type: 'sine',
      startTime: cursor,
      duration: dur,
      contour: [
        [0, freq],
        [0.4, freq * 1.08],
        [1, target],
      ],
      peak: 0.11 * vol,
      attack: 0.008,
      release: 0.03,
      vibrato: { rate: 34, depth: 28 },
    });
    freq = clamp(target, 1500, 4200);
    cursor += dur + 0.018 + Math.random() * 0.05;
  }
}

/**
 * **Sparrow** — two or three flat, percussive chirps. Almost no glide; the
 * character is in the sharp attack and the short, dry decay.
 */
function sparrowChirp(e: SynthEngine, src: SpatialSource | null, vol: number): void {
  const t0 = e.now + 0.02;
  const count = 2 + Math.floor(Math.random() * 2);
  const base = 3200 + Math.random() * 1100;
  for (let i = 0; i < count; i++) {
    const start = t0 + i * (0.1 + Math.random() * 0.06);
    pitchedNote(e, src, {
      type: 'triangle',
      startTime: start,
      duration: 0.045,
      contour: [
        [0, base * (0.96 + Math.random() * 0.12)],
        [1, base * 0.88],
      ],
      peak: 0.1 * vol,
      attack: 0.004,
      release: 0.02,
      filter: { type: 'bandpass', freq: base, q: 4 },
    });
  }
}

/**
 * **Owl** — a long, breathy, low hoot with heavy vibrato and a soft attack.
 * Filtered hard to remove the upper harmonics, which is what gives it the
 * hollow, flute-like quality.
 */
function owlHoot(e: SynthEngine, src: SpatialSource | null, vol: number): void {
  const t0 = e.now + 0.02;
  const base = 260 + Math.random() * 70;
  // Classic two-part hoot: short, then long.
  pitchedNote(e, src, {
    type: 'sine',
    startTime: t0,
    duration: 0.34,
    contour: [
      [0, base],
      [0.3, base * 1.05],
      [1, base * 0.94],
    ],
    peak: 0.15 * vol,
    attack: 0.06,
    release: 0.16,
    harmonic: { ratio: 2, gain: 0.12 },
    filter: { type: 'lowpass', freq: 900, q: 1.2 },
    vibrato: { rate: 5.5, depth: 4 },
  });
  pitchedNote(e, src, {
    type: 'sine',
    startTime: t0 + 0.62,
    duration: 0.58,
    contour: [
      [0, base * 0.97],
      [0.25, base * 1.02],
      [1, base * 0.88],
    ],
    peak: 0.16 * vol,
    attack: 0.08,
    release: 0.3,
    harmonic: { ratio: 2, gain: 0.1 },
    filter: { type: 'lowpass', freq: 820, q: 1.2 },
    vibrato: { rate: 5, depth: 5 },
  });
}

/**
 * **Crow** — deliberately harsh. A sawtooth (rich in odd and even harmonics)
 * through a mid band-pass, with a fast downward pitch drop and a noise layer
 * for the rasp. Repeated two to four times with a slightly falling pitch, the
 * way a real crow's calls decay across a sequence.
 */
function crowCaw(e: SynthEngine, src: SpatialSource | null, vol: number): void {
  const ctx = e.context;
  if (!ctx) return;
  const t0 = e.now + 0.02;
  const count = 2 + Math.floor(Math.random() * 3);
  let base = 620 + Math.random() * 180;

  for (let i = 0; i < count; i++) {
    const start = t0 + i * (0.28 + Math.random() * 0.12);
    const dur = 0.16 + Math.random() * 0.08;

    const osc = e.createOscillator('sawtooth', base);
    const noise = e.createNoiseSource('white');
    const noiseGain = e.createGain(0.5);
    const bp = e.createFilter('bandpass', base * 1.6, 3.2);
    const gain = e.createGain(0.0001);
    if (!osc || !noise || !noiseGain || !bp || !gain) return;

    osc.connect(bp);
    noise.connect(noiseGain);
    noiseGain.connect(bp);
    bp.connect(gain);
    gain.connect(src?.input ?? e.bus('wildlife'));

    osc.frequency.setValueAtTime(base * 1.15, start);
    osc.frequency.exponentialRampToValueAtTime(base * 0.78, start + dur);
    bp.frequency.setValueAtTime(base * 2.1, start);
    bp.frequency.exponentialRampToValueAtTime(base * 1.1, start + dur);

    const end = e.envelope(gain.gain, start, {
      peak: 0.13 * vol,
      attack: 0.008,
      decay: dur * 0.5,
      sustain: 0.06 * vol,
      release: dur * 0.5,
    });

    osc.start(start);
    noise.start(start);
    e.scheduleTeardown([osc, noise, noiseGain, bp, gain], [osc, noise], end + 0.05);

    base *= 0.94;
  }
}

/**
 * **Cuckoo** — the famous descending minor third. Two soft, flute-like notes,
 * the second a fixed 6 semitones… actually 3 semitones (ratio 2^(−3/12) ≈
 * 0.8409) below the first. Getting that interval exactly right is the entire
 * identity of the call.
 */
function cuckooCall(e: SynthEngine, src: SpatialSource | null, vol: number): void {
  const t0 = e.now + 0.02;
  const high = 700 + Math.random() * 90;
  // A minor third down: 2^(-3/12).
  const low = high * Math.pow(2, -3 / 12);

  pitchedNote(e, src, {
    type: 'sine',
    startTime: t0,
    duration: 0.17,
    contour: [
      [0, high],
      [1, high * 0.99],
    ],
    peak: 0.14 * vol,
    attack: 0.02,
    release: 0.07,
    harmonic: { ratio: 2, gain: 0.08 },
    filter: { type: 'lowpass', freq: 2200, q: 1 },
  });

  pitchedNote(e, src, {
    type: 'sine',
    startTime: t0 + 0.24,
    duration: 0.24,
    contour: [
      [0, low],
      [1, low * 0.985],
    ],
    peak: 0.13 * vol,
    attack: 0.022,
    release: 0.12,
    harmonic: { ratio: 2, gain: 0.07 },
    filter: { type: 'lowpass', freq: 2000, q: 1 },
  });
}

/* ───────────────────────────────────────────────────────────────────────────
 * FARM ANIMALS
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Cattle. A low sawtooth with a slow downward glide, two formant band-passes
 * for the throat, and a long release. Used both for ambience and — at T−20s —
 * as one of the first signs the train is coming.
 */
export function playCowMoo(
  e: SynthEngine,
  src: SpatialSource | null,
  volume = 1,
): void {
  if (!e.ready) return;
  const t = e.now + 0.02;
  const base = 108 + Math.random() * 26;
  const dur = 1.1 + Math.random() * 0.7;

  const osc = e.createOscillator('sawtooth', base);
  const sub = e.createOscillator('sine', base * 0.5);
  const subGain = e.createGain(0.35);
  const f1 = e.createFilter('bandpass', 520, 3.5);
  const f2 = e.createFilter('bandpass', 1080, 5);
  const mix = e.createGain(0.6);
  const lp = e.createFilter('lowpass', 2200, 0.8);
  const gain = e.createGain(0.0001);
  if (!osc || !sub || !subGain || !f1 || !f2 || !mix || !lp || !gain) return;

  osc.connect(f1);
  osc.connect(f2);
  sub.connect(subGain);
  subGain.connect(mix);
  f1.connect(mix);
  f2.connect(mix);
  mix.connect(lp);
  lp.connect(gain);
  gain.connect(src?.input ?? e.bus('wildlife'));

  // The characteristic rise-then-fall of a moo.
  osc.frequency.setValueAtTime(base * 0.9, t);
  osc.frequency.exponentialRampToValueAtTime(base * 1.12, t + dur * 0.25);
  osc.frequency.exponentialRampToValueAtTime(base * 0.74, t + dur);
  sub.frequency.setValueAtTime(base * 0.45, t);
  sub.frequency.exponentialRampToValueAtTime(base * 0.37, t + dur);

  const end = e.envelope(gain.gain, t, {
    peak: 0.16 * volume,
    attack: 0.12,
    decay: dur * 0.3,
    sustain: 0.1 * volume,
    hold: dur * 0.35,
    release: dur * 0.4,
  });

  osc.start(t);
  sub.start(t);
  e.scheduleTeardown([osc, sub, subGain, f1, f2, mix, lp, gain], [osc, sub], end + 0.1);
}

/** Chicken cluck — short, low, gargling formant burst. */
export function playChickenCluck(e: SynthEngine, src: SpatialSource | null, volume = 1): void {
  if (!e.ready) return;
  const t0 = e.now + 0.02;
  const count = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i++) {
    const start = t0 + i * (0.13 + Math.random() * 0.09);
    const base = 380 + Math.random() * 200;
    const osc = e.createOscillator('square', base);
    const bp = e.createFilter('bandpass', base * 2.4, 6);
    const gain = e.createGain(0.0001);
    if (!osc || !bp || !gain) return;

    osc.connect(bp);
    bp.connect(gain);
    gain.connect(src?.input ?? e.bus('wildlife'));

    osc.frequency.setValueAtTime(base * 1.3, start);
    osc.frequency.exponentialRampToValueAtTime(base * 0.7, start + 0.07);

    const end = e.envelope(gain.gain, start, {
      peak: 0.07 * volume,
      attack: 0.005,
      release: 0.07,
    });
    osc.start(start);
    e.scheduleTeardown([osc, bp, gain], [osc], end + 0.03);
  }
}

/** Rooster crow — the four-syllable dawn call, pitched high and strident. */
export function playRoosterCrow(e: SynthEngine, src: SpatialSource | null, volume = 1): void {
  if (!e.ready) return;
  const t0 = e.now + 0.02;
  const base = 520 + Math.random() * 80;
  // Four syllables with distinct lengths: "co-co-ri-cooo".
  const syllables: Array<[number, number, number]> = [
    [0, 0.12, 1.0],
    [0.16, 0.1, 1.18],
    [0.3, 0.14, 1.32],
    [0.48, 0.46, 1.1],
  ];
  for (const [offset, dur, mult] of syllables) {
    pitchedNote(e, src, {
      type: 'sawtooth',
      startTime: t0 + offset,
      duration: dur,
      contour: [
        [0, base * mult],
        [0.3, base * mult * 1.06],
        [1, base * mult * 0.86],
      ],
      peak: 0.12 * volume,
      attack: 0.014,
      release: dur * 0.5,
      filter: { type: 'bandpass', freq: base * mult * 1.8, q: 2.4 },
      vibrato: { rate: 18, depth: 12 },
    });
  }
}

/** Cat meow — a rising-then-falling glide with strong vowel formants. */
export function playCatMeow(e: SynthEngine, src: SpatialSource | null, volume = 1): void {
  if (!e.ready) return;
  const t = e.now + 0.02;
  const base = 480 + Math.random() * 140;
  pitchedNote(e, src, {
    type: 'sawtooth',
    startTime: t,
    duration: 0.72,
    contour: [
      [0, base * 0.82],
      [0.25, base * 1.22],
      [0.55, base * 1.1],
      [1, base * 0.7],
    ],
    peak: 0.13 * volume,
    attack: 0.05,
    release: 0.24,
    filter: { type: 'bandpass', freq: base * 2.1, q: 2.8 },
    vibrato: { rate: 11, depth: 16 },
  });
}

/** Fox bark — sharp, high, slightly unsettling. Two or three in quick sequence. */
export function playFoxBark(e: SynthEngine, src: SpatialSource | null, volume = 1): void {
  if (!e.ready) return;
  const t0 = e.now + 0.02;
  const count = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i++) {
    const start = t0 + i * (0.42 + Math.random() * 0.2);
    const base = 780 + Math.random() * 220;
    pitchedNote(e, src, {
      type: 'sawtooth',
      startTime: start,
      duration: 0.16,
      contour: [
        [0, base * 1.25],
        [0.2, base],
        [1, base * 0.62],
      ],
      peak: 0.1 * volume,
      attack: 0.006,
      release: 0.1,
      filter: { type: 'bandpass', freq: base * 1.5, q: 2 },
    });
  }
}

/** Fish surfacing — a wet plop plus a splash of filtered noise. */
export function playFishSplash(e: SynthEngine, src: SpatialSource | null, volume = 1): void {
  if (!e.ready) return;
  const t = e.now + 0.01;

  // The "plop": a fast downward sine sweep — the resonance of a closing cavity.
  const osc = e.createOscillator('sine', 620);
  const oscGain = e.createGain(0.0001);
  // The splash: a short burst of bright noise.
  const noise = e.createNoiseSource('white');
  const hp = e.createFilter('highpass', 1400, 0.7);
  const noiseGain = e.createGain(0.0001);
  if (!osc || !oscGain || !noise || !hp || !noiseGain) return;

  const out = src?.input ?? e.bus('ambient');
  osc.connect(oscGain);
  oscGain.connect(out);
  noise.connect(hp);
  hp.connect(noiseGain);
  noiseGain.connect(out);

  osc.frequency.setValueAtTime(720, t);
  osc.frequency.exponentialRampToValueAtTime(180, t + 0.11);

  const e1 = e.envelope(oscGain.gain, t, { peak: 0.13 * volume, attack: 0.004, release: 0.13 });
  const e2 = e.envelope(noiseGain.gain, t, { peak: 0.09 * volume, attack: 0.003, release: 0.3 });

  osc.start(t);
  noise.start(t);
  e.scheduleTeardown([osc, oscGain, noise, hp, noiseGain], [osc, noise], Math.max(e1, e2) + 0.05);
}

/**
 * A flock taking off — the sound the birds make at T−20s when the train is
 * still twenty seconds away and only they know it.
 *
 * Layered wing beats: short low-passed noise bursts at a rapid, slightly
 * irregular rate, spread across several overlapping "birds", all fading as the
 * flock climbs away.
 */
export function playFlockStartle(
  e: SynthEngine,
  src: SpatialSource | null,
  volume = 1,
): void {
  if (!e.ready) return;
  const t0 = e.now + 0.02;
  const birds = 5 + Math.floor(Math.random() * 5);

  for (let b = 0; b < birds; b++) {
    const birdStart = t0 + Math.random() * 0.5;
    const beats = 7 + Math.floor(Math.random() * 6);
    const beatGap = 0.075 + Math.random() * 0.03;

    for (let i = 0; i < beats; i++) {
      const start = birdStart + i * beatGap;
      const noise = e.createNoiseSource('pink');
      const lp = e.createFilter('lowpass', 900 + Math.random() * 700, 1.1);
      const gain = e.createGain(0.0001);
      if (!noise || !lp || !gain) continue;

      noise.connect(lp);
      lp.connect(gain);
      gain.connect(src?.input ?? e.bus('wildlife'));

      // Wing beats get quieter as the bird climbs away.
      const fade = 1 - i / beats;
      const end = e.envelope(gain.gain, start, {
        peak: 0.05 * volume * fade,
        attack: 0.008,
        release: 0.05,
      });
      noise.start(start);
      e.scheduleTeardown([noise, lp, gain], [noise], end + 0.03);
    }
  }

  // A few alarm chirps mixed in — birds are noisy when frightened.
  for (let i = 0; i < 4; i++) {
    setTimeout(() => sparrowChirp(e, src, volume * 0.7), Math.random() * 700);
  }
}
