/**
 * GPU-instanced grass.
 *
 * Every blade in the meadow is one instance of a four-segment strip, displaced
 * entirely in the vertex shader. There is no per-blade CPU work at all after
 * upload: 200 000 blades cost one draw call and zero JavaScript per frame.
 *
 * ## Two things make this look like grass rather than green triangles
 *
 * **1. Curvature, not just tilt.** A blade is not a rigid quad that rotates —
 * it *bends*. The vertex shader applies a quadratic bend along the blade's own
 * length so the base stays planted and the tip arcs over. Combined with the
 * width taper this reads as a flexible organic thing.
 *
 * **2. Two-sided translucent shading.** Grass is thin enough that light passes
 * through it. When the sun is behind a blade, the blade should *glow*, not go
 * black. The fragment shader adds a back-scatter term driven by
 * `dot(viewDir, lightDir)` which lights up exactly the blades between the
 * camera and the sun. At golden hour, with the sun low, this is the entire
 * reason the meadow looks like the reference art.
 *
 * @module shaders/grass
 */

import { glsl, HASH_NOISE, WIND_DISPLACEMENT } from './common.glsl';

export const GRASS_VERTEX = glsl`
precision highp float;

// Per-instance attributes.
attribute vec3  aOffset;      // World position of the blade's base
attribute float aRotation;    // Yaw, radians
attribute float aScale;       // Height multiplier
attribute float aPhase;       // Random phase so blades aren't synchronised
attribute vec3  aColorJitter; // Per-blade hue/value variation
attribute float aBend;        // Natural resting curvature

uniform float uTime;
uniform vec2  uWindDirection;
uniform float uWindStrength;
uniform float uRipplePhase;
uniform float uRippleWavelength;
uniform vec3  uCameraPos;
uniform float uFadeStart;
uniform float uFadeEnd;
uniform float uNearFade;
uniform vec3  uBaseColor;
uniform vec3  uTipColor;
uniform float uSnowCoverage;

varying vec2  vUv;
varying vec3  vColor;
varying vec3  vWorldPos;
varying vec3  vNormal;
varying float vHeightT;
varying float vFade;

${HASH_NOISE}
${WIND_DISPLACEMENT}

void main() {
  // "position" is the unit blade: x in [-0.5, 0.5], y in [0, 1].
  vHeightT = position.y;
  vUv = uv;

  /* ── Blade-local shape ────────────────────────────────────────────────────
   * Taper the width toward the tip. The 0.7 exponent keeps the blade wide for
   * most of its length and then narrows quickly — a linear taper looks like a
   * triangle, which reads as a spike rather than a leaf. */
  float widthTaper = pow(1.0 - vHeightT, 0.7);
  vec3 local = vec3(position.x * widthTaper, vHeightT, 0.0);

  /* Resting curvature: blades are never perfectly straight. Quadratic in
   * height so the base stays vertical. */
  local.z += aBend * vHeightT * vHeightT;

  // Scale to this instance's height.
  local *= vec3(1.0, aScale, 1.0);
  local.z *= aScale;

  // Yaw the blade around its base.
  float c = cos(aRotation);
  float s = sin(aRotation);
  vec3 rotated = vec3(local.x * c - local.z * s, local.y, local.x * s + local.z * c);

  vec3 worldPos = aOffset + rotated;

  /* ── Wind ─────────────────────────────────────────────────────────────────
   * Stiffness 1.4: grass bends from fairly low down, unlike a woody stem. */
  worldPos += windDisplace(aOffset, vHeightT, 1.4, aPhase);

  vWorldPos = worldPos;

  /* ── Normal ───────────────────────────────────────────────────────────────
   * A blade's normal is perpendicular to its face. Rather than deriving it from
   * geometry (the strip is degenerate at the tip), construct it from the yaw
   * and tilt it upward with height — the tip of a bent blade faces more sky. */
  vec3 faceNormal = normalize(vec3(sin(aRotation), 0.0, -cos(aRotation)));
  vNormal = normalize(mix(faceNormal, vec3(0.0, 1.0, 0.0), vHeightT * 0.45));

  /* ── Colour ───────────────────────────────────────────────────────────────
   * Darker at the base (self-shadowing within the sward), lighter at the tip.
   * This vertical gradient does more for depth than any amount of AO. */
  vec3 baseCol = uBaseColor * (0.72 + aColorJitter.x * 0.28);
  vec3 tipCol  = uTipColor  * (0.85 + aColorJitter.y * 0.3);
  vColor = mix(baseCol, tipCol, pow(vHeightT, 0.8));
  vColor *= 0.85 + aColorJitter.z * 0.3;

  // Snow settles on the upper part of each blade in winter.
  if (uSnowCoverage > 0.01) {
    float snowLine = smoothstep(0.45, 0.95, vHeightT) * uSnowCoverage;
    vColor = mix(vColor, vec3(0.92, 0.94, 0.97), snowLine);
  }

  /* ── Distance fade ────────────────────────────────────────────────────────
   * Grass is faded out rather than popped out. Fading the *alpha* would need
   * blending; instead the blade is shrunk to nothing, which stays in the
   * alpha-test path and costs no sorting. */
  float dist = distance(uCameraPos.xz, aOffset.xz);
  vFade = 1.0 - smoothstep(uFadeStart, uFadeEnd, dist);

  /* ── Near fade ────────────────────────────────────────────────────────────
   * Blades right against the lens are shrunk away too. A first-person camera
   * standing in a field otherwise ends up with several blades spanning the
   * whole screen, which reads as being stuck inside a bush. Real eyes don't
   * focus at 20 cm either. Fading over the last 85 cm is invisible in motion
   * and removes the problem entirely. */
  float near = distance(uCameraPos, aOffset);
  vFade *= smoothstep(uNearFade * 0.35, uNearFade, near);

  worldPos = mix(aOffset, worldPos, vFade);

  gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
}
`;

export const GRASS_FRAGMENT = glsl`
precision highp float;

uniform vec3  uSunDirection;
uniform vec3  uSunColor;
uniform vec3  uAmbientColor;
uniform float uAmbientIntensity;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform vec3  uCameraPos;
uniform float uTranslucency;

varying vec2  vUv;
varying vec3  vColor;
varying vec3  vWorldPos;
varying vec3  vNormal;
varying float vHeightT;
varying float vFade;

void main() {
  if (vFade < 0.01) discard;

  vec3 normal = normalize(vNormal);
  vec3 viewDir = normalize(uCameraPos - vWorldPos);

  /* Grass is two-sided: flip the normal toward the viewer so a blade seen from
   * behind is lit rather than black. */
  if (dot(normal, viewDir) < 0.0) normal = -normal;

  /* ── Direct light ─────────────────────────────────────────────────────── */
  float ndotl = max(dot(normal, uSunDirection), 0.0);
  // Wrapped diffuse: allowing light to bleed past the terminator approximates
  // the subsurface scattering of a thin leaf far more cheaply than doing it
  // properly, and looks softer than a hard Lambert edge.
  float wrapped = max((dot(normal, uSunDirection) + 0.45) / 1.45, 0.0);
  vec3 diffuse = uSunColor * mix(ndotl, wrapped, 0.75);

  /* ── Translucency ─────────────────────────────────────────────────────────
   * The star of the shader. When the sun is *behind* the blade relative to the
   * camera, light transmits through it. dot(-sunDir, viewDir) peaks exactly
   * when the camera looks toward the sun through the grass. The high exponent
   * keeps the effect confined to blades that really are between you and the
   * sun. */
  float backScatter = pow(max(dot(-uSunDirection, viewDir), 0.0), 4.0);
  // Thin tips transmit more than thick bases.
  float thinness = pow(vHeightT, 1.3);
  vec3 transmission = uSunColor * backScatter * thinness * uTranslucency;

  /* ── Ambient ──────────────────────────────────────────────────────────────
   * Hemispheric: sky colour from above, bounced ground colour from below. */
  float hemi = normal.y * 0.5 + 0.5;
  vec3 ambient = mix(uAmbientColor * 0.55, uAmbientColor, hemi) * uAmbientIntensity;

  /* Ambient occlusion within the sward — the base of a blade is buried among
   * its neighbours and receives very little skylight. */
  float ao = mix(0.42, 1.0, pow(vHeightT, 0.6));

  vec3 color = vColor * (diffuse + ambient) * ao + transmission;

  /* ── Fog ──────────────────────────────────────────────────────────────── */
  float dist = distance(uCameraPos, vWorldPos);
  float fogFactor = 1.0 - exp(-dist * dist * uFogDensity * uFogDensity);
  color = mix(color, uFogColor, clamp(fogFactor, 0.0, 1.0));

  gl_FragColor = vec4(color, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ───────────────────────────────────────────────────────────────────────────
 * WHEAT — a stiffer, taller variant with a distinct head
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Wheat.
 *
 * Same instancing approach, but with two important differences from grass:
 *
 * - **Higher stiffness** (2.6 rather than 1.4). A wheat stalk is woody and
 *   bends mostly near the top, which is why a wheatfield moves as long
 *   travelling waves rather than the chaotic shimmer of a lawn.
 * - **A weighted head.** The top 25 % is the ear, which is heavier, so it lags
 *   the stalk's motion. Applying a phase delay to the head's displacement
 *   produces that lag and is what makes wheat look like wheat.
 */
export const WHEAT_VERTEX = glsl`
precision highp float;

attribute vec3  aOffset;
attribute float aRotation;
attribute float aScale;
attribute float aPhase;
attribute vec3  aColorJitter;

uniform float uTime;
uniform vec2  uWindDirection;
uniform float uWindStrength;
uniform float uRipplePhase;
uniform float uRippleWavelength;
uniform vec3  uCameraPos;
uniform float uFadeStart;
uniform float uFadeEnd;
uniform vec3  uStalkColor;
uniform vec3  uHeadColor;

varying vec3  vColor;
varying vec3  vWorldPos;
varying vec3  vNormal;
varying float vHeightT;
varying float vFade;
varying float vIsHead;

${HASH_NOISE}
${WIND_DISPLACEMENT}

void main() {
  vHeightT = position.y;
  // The ear occupies the top quarter of the stalk.
  vIsHead = smoothstep(0.72, 0.8, vHeightT);

  // The head is wider than the stalk.
  float width = mix(0.35, 1.0, vIsHead) * (1.0 - vHeightT * 0.25);
  vec3 local = vec3(position.x * width, vHeightT * aScale, 0.0);

  float c = cos(aRotation);
  float s = sin(aRotation);
  vec3 rotated = vec3(local.x * c, local.y, local.x * s);
  vec3 worldPos = aOffset + rotated;

  // Stiff stalk: most of the bend happens up near the ear.
  vec3 disp = windDisplace(aOffset, vHeightT, 2.6, aPhase);

  /* The heavy ear lags behind the stalk. Sampling the wind displacement with a
   * time offset is a cheap, stable way to express that inertia without
   * simulating it. */
  vec3 headDisp = windDisplace(aOffset, vHeightT, 2.6, aPhase - 0.55);
  worldPos += mix(disp, headDisp * 1.35, vIsHead);

  vWorldPos = worldPos;
  vNormal = normalize(mix(vec3(sin(aRotation), 0.25, -cos(aRotation)), vec3(0.0, 1.0, 0.0), 0.4));

  vColor = mix(uStalkColor, uHeadColor, vIsHead) * (0.8 + aColorJitter.x * 0.4);

  float dist = distance(uCameraPos.xz, aOffset.xz);
  vFade = 1.0 - smoothstep(uFadeStart, uFadeEnd, dist);
  worldPos = mix(aOffset, worldPos, vFade);

  gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
}
`;

export const WHEAT_FRAGMENT = glsl`
precision highp float;

uniform vec3  uSunDirection;
uniform vec3  uSunColor;
uniform vec3  uAmbientColor;
uniform float uAmbientIntensity;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform vec3  uCameraPos;

varying vec3  vColor;
varying vec3  vWorldPos;
varying vec3  vNormal;
varying float vHeightT;
varying float vFade;
varying float vIsHead;

void main() {
  if (vFade < 0.01) discard;

  vec3 normal = normalize(vNormal);
  vec3 viewDir = normalize(uCameraPos - vWorldPos);
  if (dot(normal, viewDir) < 0.0) normal = -normal;

  float wrapped = max((dot(normal, uSunDirection) + 0.5) / 1.5, 0.0);
  vec3 diffuse = uSunColor * wrapped;

  // Ripe ears are dry and translucent — they catch low sun spectacularly.
  float backScatter = pow(max(dot(-uSunDirection, viewDir), 0.0), 3.0);
  vec3 transmission = uSunColor * backScatter * vIsHead * 0.85;

  vec3 ambient = uAmbientColor * uAmbientIntensity;
  float ao = mix(0.5, 1.0, pow(vHeightT, 0.5));

  vec3 color = vColor * (diffuse + ambient) * ao + transmission;

  float dist = distance(uCameraPos, vWorldPos);
  float fogFactor = 1.0 - exp(-dist * dist * uFogDensity * uFogDensity);
  color = mix(color, uFogColor, clamp(fogFactor, 0.0, 1.0));

  gl_FragColor = vec4(color, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
