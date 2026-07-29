/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SYNTH ENGINE — every sound in Whispering Hollow, from oscillators
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There are **no audio files** in this project. Not one. Every bird, footstep,
 * bell, gust of wind and locomotive whistle is synthesised at runtime from Web
 * Audio primitives.
 *
 * ## Why bother
 *
 * Beyond the zero-asset constraint, synthesis buys things samples cannot:
 *
 * - **Nothing ever repeats.** A sampled cricket loop betrays itself in about
 *   twenty seconds. A synthesised one has a randomised pulse phase per chirp
 *   and will not repeat in an afternoon.
 * - **Sound follows simulation continuously.** The chuff rate *is* the wheel
 *   angular velocity. The wind bandpass sweep *is* the gust uniform driving the
 *   grass shader. There is no crossfading between "slow" and "fast" variants
 *   because there are no variants.
 * - **Payload.** The entire sound design of this game is roughly 40 KB of
 *   JavaScript.
 *
 * ## Master graph
 *
 * ```
 *  [voice]──▶[lowpass]──┬─▶[PannerNode HRTF]──▶[bus gain]──┐
 *                       │                                  ├─▶[master gain]
 *                       └─▶[reverb send]──▶[ConvolverNode]─┘        │
 *                                                                   ▼
 *                                                     [compressor]──▶[destination]
 * ```
 *
 * The convolver's impulse response is itself generated (see
 * {@link SynthEngine.buildImpulseResponse}) — an open valley with a long, dark
 * tail and a slight pre-delay.
 *
 * ## Lifecycle
 *
 * `AudioContext` cannot be created before a user gesture in any modern browser.
 * {@link SynthEngine.init} is therefore called from the "Click to explore"
 * handler, never at module load. Everything before that point is a no-op, and
 * the whole engine degrades to silence if Web Audio is unavailable.
 *
 * @module components/audio/SynthEngine
 */

import { AUDIO, AUDIO_BUSES, type AudioBus } from '@/config/game';
import { clamp } from '@/lib/utils/math';

/** Options for a spatially-positioned sound source. */
export interface SpatialSourceOptions {
  bus: AudioBus;
  /** World position. Omit for non-positional (UI, music) sources. */
  position?: [number, number, number];
  /** Distance at which the source is at full volume. */
  refDistance?: number;
  /** Distance beyond which attenuation stops. */
  maxDistance?: number;
  /** How sharply volume falls with distance. */
  rolloff?: number;
  /** Per-source low-pass cutoff, Hz. Distant sounds should be darker. */
  lowpass?: number;
  /** Amount sent to the shared reverb, 0..1. */
  reverbSend?: number;
  /** Directional cone, for sources like the locomotive headlight horn. */
  cone?: { inner: number; outer: number; outerGain: number };
}

/**
 * A positioned mixing point that voices connect into.
 *
 * Created once per persistent emitter (the windmill, the stream, a perched
 * bird) and reused for the lifetime of that emitter, rather than rebuilt per
 * sound — panner nodes are relatively expensive to construct.
 */
export class SpatialSource {
  readonly input: GainNode;
  readonly panner: PannerNode | null;
  private readonly filter: BiquadFilterNode;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private disposed = false;

  constructor(
    private readonly engine: SynthEngine,
    options: SpatialSourceOptions,
  ) {
    const ctx = engine.context!;
    this.input = ctx.createGain();

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = options.lowpass ?? 20000;
    this.filter.Q.value = 0.7;

    this.dry = ctx.createGain();
    this.dry.gain.value = 1;
    this.wet = ctx.createGain();
    this.wet.gain.value = options.reverbSend ?? 0.18;

    this.input.connect(this.filter);

    if (options.position) {
      const panner = ctx.createPanner();
      /* HRTF convolves against a head-related transfer function, giving real
       * elevation and front/back cues. It costs meaningfully more CPU than
       * 'equalpower' — which is why the settings panel exposes a toggle for
       * players on weak hardware. */
      panner.panningModel = engine.hrtfEnabled ? 'HRTF' : 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = options.refDistance ?? AUDIO.PANNER.refDistance;
      panner.maxDistance = options.maxDistance ?? AUDIO.PANNER.maxDistance;
      panner.rolloffFactor = options.rolloff ?? AUDIO.PANNER.rolloffFactor;
      if (options.cone) {
        panner.coneInnerAngle = options.cone.inner;
        panner.coneOuterAngle = options.cone.outer;
        panner.coneOuterGain = options.cone.outerGain;
      }
      panner.positionX.value = options.position[0];
      panner.positionY.value = options.position[1];
      panner.positionZ.value = options.position[2];
      this.panner = panner;

      this.filter.connect(panner);
      panner.connect(this.dry);
      panner.connect(this.wet);
    } else {
      this.panner = null;
      this.filter.connect(this.dry);
      this.filter.connect(this.wet);
    }

    this.dry.connect(engine.bus(options.bus));
    this.wet.connect(engine.reverbSend);
  }

  /** Moves the source. Uses `setTargetAtTime` to avoid zipper noise. */
  setPosition(x: number, y: number, z: number, smoothing = 0.02): void {
    if (!this.panner || this.disposed) return;
    const t = this.engine.now;
    this.panner.positionX.setTargetAtTime(x, t, smoothing);
    this.panner.positionY.setTargetAtTime(y, t, smoothing);
    this.panner.positionZ.setTargetAtTime(z, t, smoothing);
  }

  /** Points a directional source. No-op for omnidirectional sources. */
  setOrientation(x: number, y: number, z: number): void {
    if (!this.panner || this.disposed) return;
    const t = this.engine.now;
    this.panner.orientationX.setTargetAtTime(x, t, 0.05);
    this.panner.orientationY.setTargetAtTime(y, t, 0.05);
    this.panner.orientationZ.setTargetAtTime(z, t, 0.05);
  }

  /** Sets the per-source low-pass cutoff — used to darken distant sounds. */
  setLowpass(hz: number, smoothing = 0.08): void {
    if (this.disposed) return;
    this.filter.frequency.setTargetAtTime(clamp(hz, 60, 20000), this.engine.now, smoothing);
  }

  /** Sets the reverb send amount. */
  setReverb(amount: number): void {
    if (this.disposed) return;
    this.wet.gain.setTargetAtTime(clamp(amount, 0, 1), this.engine.now, 0.1);
  }

  /** Sets the source's own gain. */
  setGain(value: number, smoothing = 0.05): void {
    if (this.disposed) return;
    this.input.gain.setTargetAtTime(Math.max(0, value), this.engine.now, smoothing);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.input.disconnect();
      this.filter.disconnect();
      this.panner?.disconnect();
      this.dry.disconnect();
      this.wet.disconnect();
    } catch {
      /* Already torn down with the context. */
    }
  }
}

/** Noise colours the engine can generate. */
export type NoiseColor = 'white' | 'pink' | 'brown';

/**
 * The audio engine singleton.
 *
 * Access via {@link getSynthEngine}; never construct directly.
 */
export class SynthEngine {
  context: AudioContext | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private masterGain: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private reverbReturn: GainNode | null = null;
  reverbSend!: GainNode;

  private buses = new Map<AudioBus, GainNode>();
  private noiseBuffers = new Map<NoiseColor, AudioBuffer>();
  private volumes: Record<AudioBus, number> = { ...AUDIO.DEFAULT_VOLUMES };

  hrtfEnabled = true;
  /** True once `init()` has successfully built the graph. */
  ready = false;
  /** True when Web Audio is unavailable — the engine becomes a silent stub. */
  silent = false;

  /** Ducking multiplier applied to the music bus while the train passes. */
  private musicDuck = 1;

  /* ── Lifecycle ────────────────────────────────────────────────────────── */

  /**
   * Builds the audio graph. Must be called from within a user-gesture handler.
   * Safe to call repeatedly; subsequent calls only resume a suspended context.
   */
  async init(): Promise<void> {
    if (this.ready) {
      await this.resume();
      return;
    }

    const Ctor =
      typeof window !== 'undefined'
        ? (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;

    if (!Ctor) {
      this.silent = true;
      console.warn('[audio] Web Audio API unavailable — running in silent mode.');
      return;
    }

    try {
      const ctx = new Ctor({ latencyHint: 'interactive' });
      this.context = ctx;

      // ── Master chain ───────────────────────────────────────────────────
      this.compressor = ctx.createDynamicsCompressor();
      const c = AUDIO.COMPRESSOR;
      this.compressor.threshold.value = c.threshold;
      this.compressor.knee.value = c.knee;
      this.compressor.ratio.value = c.ratio;
      this.compressor.attack.value = c.attack;
      this.compressor.release.value = c.release;

      this.masterGain = ctx.createGain();
      this.masterGain.gain.value = this.volumes.master;

      this.masterGain.connect(this.compressor);
      this.compressor.connect(ctx.destination);

      // ── Buses ──────────────────────────────────────────────────────────
      for (const bus of AUDIO_BUSES) {
        if (bus === 'master') continue;
        const g = ctx.createGain();
        g.gain.value = this.volumes[bus];
        g.connect(this.masterGain);
        this.buses.set(bus, g);
      }
      this.buses.set('master', this.masterGain);

      // ── Reverb ─────────────────────────────────────────────────────────
      this.convolver = ctx.createConvolver();
      this.convolver.buffer = this.buildImpulseResponse();
      this.reverbSend = ctx.createGain();
      this.reverbSend.gain.value = 1;
      this.reverbReturn = ctx.createGain();
      this.reverbReturn.gain.value = 0.85;

      this.reverbSend.connect(this.convolver);
      this.convolver.connect(this.reverbReturn);
      this.reverbReturn.connect(this.masterGain);

      // ── Listener defaults ──────────────────────────────────────────────
      this.configureListener();

      this.ready = true;

      if (ctx.state === 'suspended') await ctx.resume();
    } catch (err) {
      this.silent = true;
      console.warn('[audio] Failed to initialise; running in silent mode.', err);
    }
  }

  /** Current context time, or 0 when silent. */
  get now(): number {
    return this.context?.currentTime ?? 0;
  }

  /** Sample rate, defaulting to 48 kHz before init. */
  get sampleRate(): number {
    return this.context?.sampleRate ?? 48000;
  }

  async resume(): Promise<void> {
    if (this.context?.state === 'suspended') {
      try {
        await this.context.resume();
      } catch {
        /* Autoplay policy — will succeed on the next gesture. */
      }
    }
  }

  async suspend(): Promise<void> {
    if (this.context?.state === 'running') {
      try {
        await this.context.suspend();
      } catch {
        /* Ignore. */
      }
    }
  }

  /** Tears the whole graph down. Called on unmount to release the device. */
  dispose(): void {
    try {
      this.buses.forEach((b) => b.disconnect());
      this.buses.clear();
      this.convolver?.disconnect();
      this.reverbSend?.disconnect();
      this.reverbReturn?.disconnect();
      this.masterGain?.disconnect();
      this.compressor?.disconnect();
      void this.context?.close();
    } catch {
      /* Already closed. */
    }
    this.context = null;
    this.ready = false;
    this.noiseBuffers.clear();
  }

  /* ── Mixing ───────────────────────────────────────────────────────────── */

  /** Returns the gain node for a bus. Falls back to master. */
  bus(name: AudioBus): GainNode {
    return this.buses.get(name) ?? this.masterGain!;
  }

  /**
   * Sets a bus volume. Values are applied on a perceptual curve — raw linear
   * gain sliders feel dead across their top half because loudness perception is
   * roughly logarithmic. Squaring the slider position is a cheap, stable
   * approximation that makes the whole travel useful.
   */
  setVolume(bus: AudioBus, value: number): void {
    const v = clamp(value, 0, 1);
    this.volumes[bus] = v;
    const node = this.buses.get(bus);
    if (!node || !this.context) return;
    const perceptual = v * v;
    const target = bus === 'music' ? perceptual * this.musicDuck : perceptual;
    node.gain.setTargetAtTime(target, this.now, 0.04);
  }

  /** Current volume of a bus, as the raw slider value. */
  getVolume(bus: AudioBus): number {
    return this.volumes[bus];
  }

  /**
   * Ducks the music bus. Called by the train director so the ambient score
   * steps out of the way for the horn without the player touching a slider.
   */
  duckMusic(amount: number, seconds = 1.2): void {
    this.musicDuck = clamp(amount, 0, 1);
    const node = this.buses.get('music');
    if (!node || !this.context) return;
    const target = this.volumes.music * this.volumes.music * this.musicDuck;
    node.gain.setTargetAtTime(target, this.now, seconds / 3);
  }

  /** Switches all future panners between HRTF and the cheaper equal-power model. */
  setHrtf(enabled: boolean): void {
    this.hrtfEnabled = enabled;
  }

  /* ── Listener ─────────────────────────────────────────────────────────── */

  private configureListener(): void {
    const l = this.context?.listener;
    if (!l) return;
    // Modern browsers expose AudioParams; older ones only the deprecated
    // setPosition/setOrientation methods.
    if (l.positionX) {
      l.positionX.value = 0;
      l.positionY.value = 0;
      l.positionZ.value = 0;
      l.forwardX.value = 0;
      l.forwardY.value = 0;
      l.forwardZ.value = -1;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    }
  }

  /**
   * Updates the listener from the camera, every frame.
   *
   * `setTargetAtTime` with a very short constant smooths the discrete
   * per-frame jumps into continuous motion — without it, fast mouse turns
   * produce audible stepping in the HRTF convolution.
   */
  updateListener(
    px: number,
    py: number,
    pz: number,
    fx: number,
    fy: number,
    fz: number,
    ux: number,
    uy: number,
    uz: number,
  ): void {
    const l = this.context?.listener;
    if (!l) return;
    const t = this.now;
    const s = 0.015;
    if (l.positionX) {
      l.positionX.setTargetAtTime(px, t, s);
      l.positionY.setTargetAtTime(py, t, s);
      l.positionZ.setTargetAtTime(pz, t, s);
      l.forwardX.setTargetAtTime(fx, t, s);
      l.forwardY.setTargetAtTime(fy, t, s);
      l.forwardZ.setTargetAtTime(fz, t, s);
      l.upX.setTargetAtTime(ux, t, s);
      l.upY.setTargetAtTime(uy, t, s);
      l.upZ.setTargetAtTime(uz, t, s);
    } else {
      // Deprecated API — Safari < 14 and some embedded webviews.
      const legacy = l as unknown as {
        setPosition(x: number, y: number, z: number): void;
        setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
      };
      legacy.setPosition?.(px, py, pz);
      legacy.setOrientation?.(fx, fy, fz, ux, uy, uz);
    }
  }

  /* ── Source factory ───────────────────────────────────────────────────── */

  /** Creates a spatial mixing point. Returns `null` when silent. */
  createSource(options: SpatialSourceOptions): SpatialSource | null {
    if (!this.ready || !this.context) return null;
    return new SpatialSource(this, options);
  }

  /* ── Buffers ──────────────────────────────────────────────────────────── */

  /**
   * Returns a cached 4-second noise buffer of the requested colour.
   *
   * Four seconds is long enough that looping is inaudible for noise, and short
   * enough to keep memory trivial (≈750 KB mono at 48 kHz).
   *
   * - **White**: flat spectrum. Bright, hissy — rain, sparks, transients.
   * - **Pink**: −3 dB/octave. This is the colour of most natural broadband
   *   sound (wind, water, distant traffic), which is why nearly every ambient
   *   voice here starts from pink rather than white.
   * - **Brown**: −6 dB/octave. Deep rumble — the train's rolling noise, thunder
   *   tails.
   */
  noiseBuffer(color: NoiseColor): AudioBuffer | null {
    if (!this.context) return null;
    const cached = this.noiseBuffers.get(color);
    if (cached) return cached;

    const ctx = this.context;
    const length = Math.floor(ctx.sampleRate * 4);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    if (color === 'white') {
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    } else if (color === 'pink') {
      /* Paul Kellet's economical pink-noise filter: seven one-pole low-passes
       * with staggered coefficients, summed. Accurate to within ±0.05 dB of a
       * true −3 dB/octave slope from 20 Hz to 20 kHz at a fraction of the cost
       * of an FFT-based approach. */
      let b0 = 0,
        b1 = 0,
        b2 = 0,
        b3 = 0,
        b4 = 0,
        b5 = 0,
        b6 = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      }
    } else {
      // Brown noise: a leaky integrator over white. The 0.02 coefficient and
      // 3.5 makeup gain keep it from drifting to the rails.
      let last = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      }
    }

    this.noiseBuffers.set(color, buffer);
    return buffer;
  }

  /**
   * Renders the convolution impulse response for the valley.
   *
   * Rather than a plain exponentially-decaying noise burst, this builds three
   * perceptually distinct stages, which is what separates "an outdoor space"
   * from "a reverb plugin":
   *
   * 1. **Pre-delay** — silence before anything returns. The ear reads the gap
   *    length as the distance to the nearest reflecting surface, so 35 ms says
   *    "the far hillside", not "a small room".
   * 2. **Early reflections** — a handful of discrete taps at irregular
   *    intervals. Regular spacing would ring at a pitch; irregular spacing
   *    reads as scattered terrain.
   * 3. **Diffuse tail** — exponentially decaying noise, low-passed
   *    progressively over its length because air absorbs high frequencies with
   *    distance. This is why the tail sounds like it is happening *outside*.
   *
   * Both channels are generated independently so the tail is fully decorrelated
   * and therefore wide.
   */
  private buildImpulseResponse(): AudioBuffer {
    const ctx = this.context!;
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * AUDIO.IR_DURATION);
    const buffer = ctx.createBuffer(2, length, rate);
    const preDelay = Math.floor(rate * AUDIO.IR_PREDELAY);

    // Irregular early-reflection taps, in seconds, with their gains.
    const earlyTaps: Array<[number, number]> = [
      [0.011, 0.42],
      [0.019, 0.31],
      [0.029, 0.36],
      [0.041, 0.24],
      [0.058, 0.28],
      [0.073, 0.19],
      [0.096, 0.21],
      [0.118, 0.14],
    ];

    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      // Slight inter-channel offset widens the image without comb filtering.
      const chOffset = ch === 0 ? 0 : Math.floor(rate * 0.0031);

      // Early reflections.
      for (const [time, gain] of earlyTaps) {
        const idx = preDelay + chOffset + Math.floor(time * rate);
        if (idx < length) {
          // Each tap is a short noise burst, not a click — a bare impulse
          // sounds like a digital artefact.
          const burst = Math.floor(rate * 0.002);
          for (let k = 0; k < burst && idx + k < length; k++) {
            const env = 1 - k / burst;
            data[idx + k]! += (Math.random() * 2 - 1) * gain * env * (0.85 + Math.random() * 0.3);
          }
        }
      }

      // Diffuse tail with progressive high-frequency damping.
      let lp = 0;
      for (let i = preDelay; i < length; i++) {
        const t = (i - preDelay) / (length - preDelay);
        const env = Math.pow(1 - t, AUDIO.IR_DECAY);
        const white = Math.random() * 2 - 1;
        // One-pole low-pass whose cutoff closes as the tail decays.
        const coeff = 0.32 - t * 0.24;
        lp += coeff * (white - lp);
        data[i]! += lp * env * 0.62;
      }
    }

    return buffer;
  }

  /* ── Convenience node builders ────────────────────────────────────────── */

  /** Creates a looping noise source. Caller must `start()` and later `stop()`. */
  createNoiseSource(color: NoiseColor): AudioBufferSourceNode | null {
    const ctx = this.context;
    const buffer = this.noiseBuffer(color);
    if (!ctx || !buffer) return null;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    // Randomising the start offset stops every noise voice in the scene from
    // being phase-locked to the same 4-second cycle.
    src.loopStart = 0;
    src.loopEnd = buffer.duration;
    return src;
  }

  /** Creates a configured biquad in one call. */
  createFilter(
    type: BiquadFilterType,
    frequency: number,
    q = 1,
    gain = 0,
  ): BiquadFilterNode | null {
    const ctx = this.context;
    if (!ctx) return null;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = q;
    f.gain.value = gain;
    return f;
  }

  /** Creates a gain node with an initial value. */
  createGain(value = 1): GainNode | null {
    const ctx = this.context;
    if (!ctx) return null;
    const g = ctx.createGain();
    g.gain.value = value;
    return g;
  }

  /** Creates an oscillator. */
  createOscillator(type: OscillatorType, frequency: number, detune = 0): OscillatorNode | null {
    const ctx = this.context;
    if (!ctx) return null;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = frequency;
    o.detune.value = detune;
    return o;
  }

  /**
   * Builds a soft-clipping waveshaper curve.
   *
   * Used on the train horn: a pure oscillator sounds thin and synthetic, while
   * a little asymmetric saturation adds the odd harmonics that make a horn read
   * as *loud* and *brassy* even at modest playback level.
   *
   * @param amount - 0 = linear, 1 = heavy clipping.
   */
  createDistortion(amount: number): WaveShaperNode | null {
    const ctx = this.context;
    if (!ctx) return null;
    const shaper = ctx.createWaveShaper();
    const samples = 1024;
    const curve = new Float32Array(samples);
    const k = amount * 60;
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      // Classic arctan-style transfer curve.
      curve[i] = ((3 + k) * x * 20 * Math.PI) / (Math.PI + k * Math.abs(x)) / 20;
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    return shaper;
  }

  /**
   * Schedules an ADSR-style envelope on a gain param.
   *
   * Uses `exponentialRampToValueAtTime` for the decay and release because
   * amplitude perception is logarithmic — a linear fade-out sounds like it
   * stops abruptly at the end. Exponential ramps cannot reach exactly zero, so
   * the tail lands on 0.0001 and then snaps.
   */
  envelope(
    param: AudioParam,
    startTime: number,
    opts: { peak: number; attack: number; decay?: number; sustain?: number; release: number; hold?: number },
  ): number {
    const { peak, attack, decay = 0, sustain = 0, release, hold = 0 } = opts;
    const t0 = Math.max(startTime, this.now);
    param.cancelScheduledValues(t0);
    param.setValueAtTime(0.0001, t0);
    param.exponentialRampToValueAtTime(Math.max(peak, 0.0001), t0 + attack);

    let cursor = t0 + attack;
    if (decay > 0) {
      param.exponentialRampToValueAtTime(Math.max(sustain, 0.0001), cursor + decay);
      cursor += decay;
    }
    if (hold > 0) cursor += hold;
    param.exponentialRampToValueAtTime(0.0001, cursor + release);
    return cursor + release;
  }

  /**
   * Runs a node graph for a fixed duration then tears it down.
   *
   * One-shot voices create half a dozen nodes each and the game fires hundreds
   * per minute. Without deterministic teardown the graph grows without bound —
   * this is the single most common source of Web Audio memory leaks. Every
   * one-shot in this codebase routes its cleanup through here.
   *
   * @param nodes - Every node to disconnect.
   * @param sources - Scheduled sources to stop.
   * @param stopAt - Context time to stop and disconnect at.
   */
  scheduleTeardown(
    nodes: AudioNode[],
    sources: Array<AudioScheduledSourceNode>,
    stopAt: number,
  ): void {
    if (!this.context) return;
    for (const s of sources) {
      try {
        s.stop(stopAt);
      } catch {
        /* Already stopped. */
      }
    }
    const last = sources[sources.length - 1];
    const cleanup = () => {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* Already disconnected. */
        }
      }
    };
    if (last) {
      last.onended = cleanup;
    } else {
      // No source to hang the callback on — fall back to a timer.
      const delayMs = Math.max(0, (stopAt - this.now) * 1000) + 60;
      setTimeout(cleanup, delayMs);
    }
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * SINGLETON
 * ─────────────────────────────────────────────────────────────────────────── */

let instance: SynthEngine | null = null;

/** Returns the process-wide audio engine, creating it on first use. */
export function getSynthEngine(): SynthEngine {
  if (!instance) instance = new SynthEngine();
  return instance;
}

/** Disposes and clears the singleton. Used on full teardown / HMR. */
export function destroySynthEngine(): void {
  instance?.dispose();
  instance = null;
}
