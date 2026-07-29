/**
 * Colour grading and colourblind assistance, as a custom postprocessing effect.
 *
 * Implements a proper **lift / gamma / gain** grade — the same three controls a
 * colourist uses:
 *
 * - **Lift** raises the black point. Positive lift on blue and negative on red
 *   produces the cool, milky shadows of a film print; the reverse warms them.
 * - **Gamma** bends the midtones without moving black or white. This is where
 *   most of a grade's character lives.
 * - **Gain** scales the highlights. Warm gain is what makes golden hour golden.
 *
 * Applying them in that order matters: lift → gamma → gain is the standard
 * chain, and each operates on the output of the last.
 *
 * The colourblind filters use the Brettel/Viénot daltonisation matrices, which
 * project colours onto the plane a given dichromat can distinguish and then
 * redistribute the lost signal into channels they *can* see — so red/green
 * information survives as a brightness or blue difference rather than
 * disappearing.
 *
 * @module components/postfx/ColorGradeEffect
 */

'use client';

import { forwardRef, useMemo, useLayoutEffect } from 'react';
import { Effect } from 'postprocessing';
import * as THREE from 'three';

import { COLORBLIND_MODES, type ColorblindMode } from '@/config/game';

const FRAGMENT = /* glsl */ `
uniform vec3  uLift;
uniform vec3  uGamma;
uniform vec3  uGain;
uniform float uSaturation;
uniform float uContrast;
uniform float uGrain;
uniform float uTime;
uniform int   uColorblindMode;

/**
 * Daltonisation matrices.
 * Index 1 = protanopia (red-blind), 2 = deuteranopia (green-blind),
 * 3 = tritanopia (blue-blind).
 */
vec3 simulateDichromacy(vec3 c, int mode) {
  if (mode == 1) {
    return vec3(
      dot(c, vec3(0.567, 0.433, 0.000)),
      dot(c, vec3(0.558, 0.442, 0.000)),
      dot(c, vec3(0.000, 0.242, 0.758))
    );
  } else if (mode == 2) {
    return vec3(
      dot(c, vec3(0.625, 0.375, 0.000)),
      dot(c, vec3(0.700, 0.300, 0.000)),
      dot(c, vec3(0.000, 0.300, 0.700))
    );
  } else {
    return vec3(
      dot(c, vec3(0.950, 0.050, 0.000)),
      dot(c, vec3(0.000, 0.433, 0.567)),
      dot(c, vec3(0.000, 0.475, 0.525))
    );
  }
}

/**
 * Redistributes the colour information a dichromat cannot perceive into
 * channels they can. This is what makes the filter *assistive* rather than
 * merely a simulation of the deficiency.
 */
vec3 daltonize(vec3 c, int mode) {
  vec3 simulated = simulateDichromacy(c, mode);
  vec3 error = c - simulated;

  // Shift the lost signal into the remaining discriminable axes.
  vec3 correction;
  correction.r = 0.0;
  correction.g = error.r * 0.7 + error.g * 1.0;
  correction.b = error.r * 0.7 + error.b * 1.0;

  return clamp(c + correction, 0.0, 1.0);
}

float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

/** Cheap hash for the film-grain dither. */
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 color = inputColor.rgb;

  /* ── Lift / Gamma / Gain ──────────────────────────────────────────────── */

  // Lift: raise the floor, compressing the range from below.
  color = color * (1.0 - uLift) + uLift;

  // Gamma: bend the midtones. Guarding against zero avoids NaNs on pure black.
  color = pow(max(color, vec3(0.0001)), 1.0 / max(uGamma, vec3(0.0001)));

  // Gain: scale toward white.
  color *= uGain;

  /* ── Contrast, pivoted on middle grey ─────────────────────────────────────
   * Pivoting at 0.18 (18% grey, the photographic standard) rather than 0.5
   * means increasing contrast darkens shadows and brightens highlights around
   * the point the eye reads as "middle", instead of crushing everything. */
  color = (color - 0.18) * uContrast + 0.18;

  /* ── Saturation ───────────────────────────────────────────────────────── */
  float lum = luminance(color);
  color = mix(vec3(lum), color, uSaturation);

  /* ── Film grain ───────────────────────────────────────────────────────────
   * Scaled by 1 − luminance so grain sits in the shadows, where real film
   * grain is most visible. Uniform grain over the whole frame reads as
   * digital noise. */
  if (uGrain > 0.0001) {
    float n = hash(uv * 1024.0 + uTime * 137.0) - 0.5;
    color += n * uGrain * (1.0 - lum * 0.7);
  }

  /* ── Colourblind assistance ───────────────────────────────────────────── */
  if (uColorblindMode > 0) {
    color = daltonize(clamp(color, 0.0, 1.0), uColorblindMode);
  }

  outputColor = vec4(clamp(color, 0.0, 1.0), inputColor.a);
}
`;

/** The postprocessing `Effect` subclass. */
class ColorGradeEffectImpl extends Effect {
  constructor({
    lift = [0, 0, 0] as [number, number, number],
    gamma = [1, 1, 1] as [number, number, number],
    gain = [1, 1, 1] as [number, number, number],
    saturation = 1,
    contrast = 1,
    grain = 0,
    colorblindMode = 0,
  } = {}) {
    super('ColorGradeEffect', FRAGMENT, {
      uniforms: new Map<string, THREE.Uniform<unknown>>([
        ['uLift', new THREE.Uniform(new THREE.Vector3(...lift))],
        ['uGamma', new THREE.Uniform(new THREE.Vector3(...gamma))],
        ['uGain', new THREE.Uniform(new THREE.Vector3(...gain))],
        ['uSaturation', new THREE.Uniform(saturation)],
        ['uContrast', new THREE.Uniform(contrast)],
        ['uGrain', new THREE.Uniform(grain)],
        ['uTime', new THREE.Uniform(0)],
        ['uColorblindMode', new THREE.Uniform(colorblindMode)],
      ]),
    });
  }

  /** Advances the grain animation. Called by the composer each frame. */
  update(_renderer: THREE.WebGLRenderer, _inputBuffer: THREE.WebGLRenderTarget, deltaTime: number) {
    const t = this.uniforms.get('uTime');
    if (t) t.value = (t.value as number) + deltaTime;
  }
}

export interface ColorGradeProps {
  lift: readonly [number, number, number];
  gamma: readonly [number, number, number];
  gain: readonly [number, number, number];
  saturation: number;
  contrast: number;
  grain: number;
  colorblindMode: ColorblindMode;
}

/** React wrapper around {@link ColorGradeEffectImpl}. */
export const ColorGradeEffect = forwardRef<ColorGradeEffectImpl, ColorGradeProps>(
  function ColorGradeEffect(props, ref) {
    const effect = useMemo(() => new ColorGradeEffectImpl(), []);

    // Push prop changes into the uniforms without rebuilding the effect —
    // recreating it would recompile the shader on every settings tweak.
    useLayoutEffect(() => {
      const u = effect.uniforms;
      (u.get('uLift')!.value as THREE.Vector3).set(...props.lift);
      (u.get('uGamma')!.value as THREE.Vector3).set(...props.gamma);
      (u.get('uGain')!.value as THREE.Vector3).set(...props.gain);
      u.get('uSaturation')!.value = props.saturation;
      u.get('uContrast')!.value = props.contrast;
      u.get('uGrain')!.value = props.grain;
      u.get('uColorblindMode')!.value = COLORBLIND_MODES.indexOf(props.colorblindMode);
    }, [effect, props]);

    useLayoutEffect(() => {
      if (typeof ref === 'function') ref(effect);
      else if (ref) ref.current = effect;
    }, [effect, ref]);

    return <primitive object={effect} dispose={null} />;
  },
);
