/**
 * Atmospheric sky shader.
 *
 * Implements a simplified single-scattering model — the same physics that
 * makes a real sky blue and a real sunset orange, reduced to something that
 * runs in a few dozen instructions on a fragment.
 *
 * ## The physics, briefly
 *
 * Sunlight entering the atmosphere scatters off two kinds of particle:
 *
 * - **Rayleigh scattering** — off air molecules, much smaller than the
 *   wavelength of light. Its strength goes as **1/λ⁴**, so blue (450 nm)
 *   scatters about 5.5× more than red (650 nm). That single exponent is why the
 *   sky is blue overhead and why the sun turns red at the horizon: looking at
 *   sunset you are staring down a long atmospheric path that has scattered all
 *   the blue *out* of the direct beam.
 *
 * - **Mie scattering** — off aerosols, dust and water droplets, comparable in
 *   size to the wavelength. Essentially wavelength-independent (hence white
 *   haze) and strongly **forward-scattering**, which is what produces the bright
 *   halo hugging the sun and the milky band along the horizon.
 *
 * The phase functions below are the standard ones: Rayleigh's `1 + cos²θ`, and
 * the Henyey–Greenstein approximation for Mie with an asymmetry parameter `g`
 * near 0.8 (strongly forward).
 *
 * @module shaders/sky
 */

import { glsl, HASH_NOISE } from './common.glsl';

export const SKY_VERTEX = glsl`
varying vec3 vWorldPosition;
varying vec3 vViewDirection;

void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPosition.xyz;
  // Direction from camera to this point on the dome.
  vViewDirection = normalize(worldPosition.xyz - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

export const SKY_FRAGMENT = glsl`
precision highp float;

uniform vec3  uSunDirection;
uniform vec3  uMoonDirection;
uniform vec3  uSkyTint;
uniform vec3  uHorizonColor;
uniform vec3  uGroundColor;
uniform float uSunIntensity;
uniform float uTurbidity;      // Aerosol load: 1 = alpine clear, 10 = hazy city
uniform float uRayleighScale;
uniform float uMieScale;
uniform float uMieG;           // Forward-scattering asymmetry, 0..0.95
uniform float uStarOpacity;
uniform float uMoonPhase;
uniform float uCloudCover;
uniform float uTime;
uniform sampler2D uMilkyWay;
uniform float uExposure;

varying vec3 vWorldPosition;
varying vec3 vViewDirection;

${HASH_NOISE}

/**
 * Rayleigh phase function.
 * Symmetric about 90°: equal scattering forward and back, minimum sideways.
 */
float rayleighPhase(float cosTheta) {
  return (3.0 / (16.0 * 3.14159265)) * (1.0 + cosTheta * cosTheta);
}

/**
 * Henyey–Greenstein phase function for Mie scattering.
 * g → 0 is isotropic; g → 1 concentrates everything forward. At g = 0.8
 * the result is the tight, bright glow around the sun.
 */
float miePhase(float cosTheta, float g) {
  float g2 = g * g;
  float denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(denom, 0.0001), 1.5));
}

/**
 * Optical depth approximation.
 *
 * A full model integrates density along the view ray through a spherical
 * atmosphere. This approximates it with a cheap analytic curve in the view
 * angle, which is accurate enough to produce the correct *shape* of horizon
 * brightening at a fraction of the cost.
 */
float opticalDepth(float cosZenith) {
  // Chapman-function-like approximation; blows up gracefully at the horizon.
  float denom = cosZenith + 0.15 * pow(max(93.885 - degrees(acos(clamp(cosZenith, -1.0, 1.0))), 0.001), -1.253);
  return 1.0 / max(denom, 0.0001);
}

void main() {
  vec3 dir = normalize(vViewDirection);

  // Below the horizon: blend to a ground tone rather than showing the void.
  float horizonBlend = smoothstep(-0.12, 0.02, dir.y);

  float cosZenith = max(dir.y, 0.0);
  float depth = opticalDepth(max(dir.y, 0.02));

  float cosSun  = dot(dir, uSunDirection);
  float cosMoon = dot(dir, uMoonDirection);

  /* ── Rayleigh ────────────────────────────────────────────────────────────
   * The 1/λ⁴ coefficients for R, G, B at 680/550/440 nm. These specific
   * numbers are what make the sky the *right* blue rather than a guessed one. */
  vec3 rayleighCoeff = vec3(5.8e-6, 13.5e-6, 33.1e-6) * uRayleighScale * 1.0e5;
  vec3 rayleigh = rayleighCoeff * rayleighPhase(cosSun) * depth;

  /* ── Mie ──────────────────────────────────────────────────────────────── */
  float mieCoeff = 21e-6 * uMieScale * uTurbidity * 1.0e5;
  float mie = mieCoeff * miePhase(cosSun, uMieG) * depth;

  /* ── Extinction ──────────────────────────────────────────────────────────
   * Light is also removed along the path. Without this the sky saturates to
   * pure white at the horizon instead of desaturating into haze. */
  vec3 extinction = exp(-(rayleighCoeff + vec3(mieCoeff)) * depth * 0.35);

  // How much sunlight reaches the atmosphere at all — the whole sky dims and
  // reddens as the sun sets, and goes out when it is below the horizon.
  float sunAltitude = uSunDirection.y;
  float dayFactor = smoothstep(-0.22, 0.14, sunAltitude);

  vec3 skyColor = (rayleigh + vec3(mie)) * uSunIntensity * dayFactor;
  skyColor *= extinction;

  // Artistic tint — pulls the physical result toward the authored palette for
  // the current time of day. Physics gets the gradient right; the tint gets
  // the *mood* right.
  skyColor = mix(skyColor, skyColor * uSkyTint * 1.6, 0.55);

  /* ── Night sky ─────────────────────────────────────────────────────────── */
  vec3 nightColor = mix(vec3(0.008, 0.014, 0.035), vec3(0.03, 0.045, 0.09), cosZenith);

  if (uStarOpacity > 0.001) {
    // Milky Way band, sampled equirectangularly from the generated texture.
    vec2 milkyUv = vec2(atan(dir.z, dir.x) / 6.2831853 + 0.5, acos(clamp(dir.y, -1.0, 1.0)) / 3.14159265);
    vec3 milky = texture2D(uMilkyWay, milkyUv).rgb;
    nightColor += milky * uStarOpacity * 0.55;

    // A dusting of procedural point stars on top of the band texture, so the
    // sky still resolves individual stars when the player looks closely.
    vec3 starCell = floor(dir * 420.0);
    float starHash = hash21(starCell.xy + starCell.z * 37.0);
    if (starHash > 0.9975) {
      float twinkle = 0.65 + 0.35 * sin(uTime * (2.0 + hash11(starHash) * 5.0) + starHash * 100.0);
      float brightness = pow((starHash - 0.9975) / 0.0025, 0.6);
      nightColor += vec3(brightness * twinkle * 1.4) * uStarOpacity;
    }
  }

  /* ── Moon ──────────────────────────────────────────────────────────────── */
  float moonDisc = smoothstep(0.9993, 0.99965, cosMoon);
  if (moonDisc > 0.0) {
    /* Phase: shade the disc by how much of the lit hemisphere faces us. The
     * terminator is derived from the angle between the moon and sun directions,
     * which means the phase is always physically consistent with where the sun
     * actually is. */
    vec3 moonUp = normalize(cross(uMoonDirection, vec3(0.0, 1.0, 0.0)));
    float acrossDisc = dot(normalize(dir - uMoonDirection * cosMoon), moonUp);
    float terminator = cos(uMoonPhase * 6.2831853);
    float lit = smoothstep(terminator - 0.25, terminator + 0.25, acrossDisc);
    // Faint craters.
    float craters = 0.85 + 0.15 * valueNoise(dir.xz * 900.0);
    nightColor += vec3(0.95, 0.94, 0.88) * moonDisc * lit * craters * 2.2;
  }
  // Soft halo around the moon.
  nightColor += vec3(0.5, 0.55, 0.7) * pow(max(cosMoon, 0.0), 220.0) * 0.35 * (1.0 - dayFactor);

  /* ── Sun disc ──────────────────────────────────────────────────────────── */
  // Two terms: a hard-edged disc, and a wide bloom-like glow that survives
  // being looked at through fog.
  float sunDisc = smoothstep(0.99965, 0.99985, cosSun);
  float sunGlow = pow(max(cosSun, 0.0), 800.0) * 0.6 + pow(max(cosSun, 0.0), 60.0) * 0.12;
  vec3 sunColor = mix(vec3(1.0, 0.42, 0.16), vec3(1.0, 0.96, 0.88), smoothstep(0.0, 0.35, sunAltitude));
  skyColor += sunColor * (sunDisc * 14.0 + sunGlow * 3.0) * dayFactor;

  /* ── Composite day and night ───────────────────────────────────────────── */
  vec3 color = mix(nightColor, skyColor, dayFactor);

  // Cloud cover flattens and greys the whole dome.
  if (uCloudCover > 0.01) {
    vec3 overcast = mix(vec3(0.32, 0.34, 0.38), vec3(0.62, 0.64, 0.68), cosZenith) * (0.25 + dayFactor * 0.75);
    color = mix(color, overcast, uCloudCover * 0.72);
  }

  // Horizon haze band — where the atmosphere is thickest.
  float haze = pow(1.0 - cosZenith, 5.0);
  color = mix(color, uHorizonColor, haze * 0.42 * (0.25 + dayFactor * 0.75));

  // Ground hemisphere.
  color = mix(uGroundColor * (0.2 + dayFactor * 0.8), color, horizonBlend);

  color *= uExposure;

  gl_FragColor = vec4(color, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ───────────────────────────────────────────────────────────────────────────
 * STARS (instanced points, drawn on top of the dome)
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Instanced star field.
 *
 * Rendered as GL points on a sphere far outside the scene. Each star carries
 * its own magnitude, colour temperature and twinkle phase as instance
 * attributes, so 3200 stars cost one draw call.
 *
 * Twinkle is amplitude modulation at a per-star frequency, scaled by how low
 * the star sits in the sky — real scintillation is caused by atmospheric
 * turbulence, and there is far more atmosphere between you and a star near the
 * horizon than one overhead.
 */
export const STAR_VERTEX = glsl`
attribute float aMagnitude;
attribute float aTwinklePhase;
attribute vec3  aColor;

uniform float uTime;
uniform float uOpacity;
uniform float uPixelRatio;

varying float vAlpha;
varying vec3  vColor;

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  vec3 dir = normalize(position);
  // More twinkle near the horizon — thicker atmosphere, more turbulence.
  float horizonFactor = 1.0 - clamp(dir.y, 0.0, 1.0);
  float twinkle = 0.78 + 0.22 * sin(uTime * (1.6 + aTwinklePhase * 4.0) + aTwinklePhase * 62.8)
                      * (0.35 + horizonFactor * 0.65);

  vAlpha = uOpacity * aMagnitude * twinkle;
  vColor = aColor;

  // Brighter stars are drawn larger; this is how the eye reads magnitude.
  gl_PointSize = (1.2 + aMagnitude * 2.6) * uPixelRatio;
}
`;

export const STAR_FRAGMENT = glsl`
precision mediump float;

varying float vAlpha;
varying vec3  vColor;

void main() {
  // Round the square point sprite into a soft disc.
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;

  // Gaussian-ish falloff plus a tight core, which is what a real point source
  // looks like through a lens.
  float core = exp(-d * d * 26.0);
  float halo = exp(-d * d * 6.0) * 0.35;

  gl_FragColor = vec4(vColor * (core + halo), (core + halo) * vAlpha);
}
`;
