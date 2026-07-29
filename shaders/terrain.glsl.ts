/**
 * Triplanar splatmap terrain shader.
 *
 * Blends four ground materials — grass, dirt, rock, sand — with **no visible
 * tiling** across a 400 × 400 unit valley. Three techniques combine to achieve
 * that:
 *
 * 1. **Triplanar projection** removes the stretching that plain UV mapping
 *    produces on slopes. Cliff faces are sampled from the side, so the texture
 *    stays square at any angle.
 *
 * 2. **Dual-scale sampling.** Each material is sampled twice — once at a large
 *    scale and once at a small one — and the two are combined. Because the two
 *    scales have different tiling periods, their repeats don't line up, and the
 *    obvious rectangular grid of a single-scale texture disappears.
 *
 * 3. **Noise-perturbed blend weights.** The CPU-computed splat weights are
 *    nudged per fragment by a noise field, so material boundaries are ragged and
 *    organic rather than following the smooth interpolation of the vertex
 *    attribute.
 *
 * On top of that sit three simulation-driven layers: **snow** accumulating on
 * upward faces in winter, **wetness** darkening and glossing the ground in
 * rain, and vertex **ambient occlusion** deepening the valleys.
 *
 * @module shaders/terrain
 */

import { glsl, SIMPLEX_NOISE, TRIPLANAR } from './common.glsl';

export const TERRAIN_VERTEX = glsl`
precision highp float;

attribute vec4 aSplat;      // grass / dirt / rock / sand weights from the CPU
attribute float aOcclusion; // Cheap vertex AO

varying vec3  vWorldPos;
varying vec3  vNormal;
varying vec4  vSplat;
varying float vOcclusion;
varying vec2  vUv;

void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPosition.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vSplat = aSplat;
  vOcclusion = aOcclusion;
  vUv = uv;

  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

export const TERRAIN_FRAGMENT = glsl`
precision highp float;

uniform sampler2D uGrassTex;
uniform sampler2D uDirtTex;
uniform sampler2D uRockTex;
uniform sampler2D uSandTex;

uniform vec3  uSunDirection;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform vec3  uAmbientColor;
uniform float uAmbientIntensity;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform vec3  uCameraPos;

uniform vec3  uGrassTint;    // Season tint applied to the grass layer
uniform float uSnowCoverage; // 0..1 — winter accumulation
uniform float uWetness;      // 0..1 — rain
uniform float uTextureScale;
uniform float uDetailScale;
uniform float uTime;

varying vec3  vWorldPos;
varying vec3  vNormal;
varying vec4  vSplat;
varying float vOcclusion;
varying vec2  vUv;

${SIMPLEX_NOISE}
${TRIPLANAR}

/**
 * Samples one material at two scales and combines them.
 *
 * The small-scale sample is applied as a *modulation* of the large one rather
 * than being averaged in — averaging washes both out, whereas modulating keeps
 * the contrast of the fine detail while the broad pattern still reads.
 */
vec3 dualScaleSample(sampler2D tex, vec3 worldPos, vec3 normal) {
  vec3 broad = triplanarSample(tex, worldPos, normal, uTextureScale, 4.0);
  vec3 fine  = triplanarSample(tex, worldPos, normal, uDetailScale, 4.0);
  // Centre the fine sample on 1.0 so it multiplies without darkening overall.
  return broad * (fine * 1.4 + 0.3);
}

void main() {
  vec3 normal = normalize(vNormal);
  vec3 viewDir = normalize(uCameraPos - vWorldPos);
  float dist = distance(uCameraPos, vWorldPos);

  /* ── Perturb the splat weights ────────────────────────────────────────────
   * Two noise octaves at different frequencies push the material boundaries
   * around. Without this, the transition from grass to rock follows the smooth
   * vertex interpolation and looks airbrushed. */
  float n1 = snoise(vWorldPos * 0.09) * 0.5 + 0.5;
  float n2 = snoise(vWorldPos * 0.31) * 0.5 + 0.5;
  float perturb = (n1 * 0.7 + n2 * 0.3 - 0.5) * 0.42;

  vec4 splat = vSplat;
  splat.x = max(splat.x + perturb, 0.0);
  splat.y = max(splat.y - perturb * 0.6, 0.0);
  splat.z = max(splat.z + perturb * 0.8, 0.0);
  splat.w = max(splat.w - perturb * 0.4, 0.0);

  /* Sharpen the blend. Raising the weights to a power before normalising makes
   * one material dominate over most of the surface, with narrow transition
   * bands — which is how real ground looks. Linear blending gives a permanent
   * 25 % of everything everywhere, i.e. mud. */
  splat = pow(splat, vec4(2.2));
  splat /= max(splat.x + splat.y + splat.z + splat.w, 0.0001);

  /* ── Sample the materials ─────────────────────────────────────────────────
   * Skip any layer contributing less than 1 % — on most of the map two of the
   * four are effectively zero, which saves six texture fetches per fragment. */
  vec3 albedo = vec3(0.0);
  if (splat.x > 0.01) albedo += dualScaleSample(uGrassTex, vWorldPos, normal) * uGrassTint * splat.x;
  if (splat.y > 0.01) albedo += dualScaleSample(uDirtTex,  vWorldPos, normal) * splat.y;
  if (splat.z > 0.01) albedo += dualScaleSample(uRockTex,  vWorldPos, normal) * splat.z;
  if (splat.w > 0.01) albedo += dualScaleSample(uSandTex,  vWorldPos, normal) * splat.w;

  float roughness = mix(0.95, 0.72, splat.z);

  /* ── Snow ─────────────────────────────────────────────────────────────────
   * Snow settles on upward-facing surfaces and slides off steep ones. The
   * normal.y threshold is the angle of repose; the noise term breaks the
   * boundary up so drifts look wind-blown rather than airbrushed. */
  if (uSnowCoverage > 0.01) {
    float upness = smoothstep(0.42, 0.78, normal.y);
    float drift = snoise(vWorldPos * 0.12) * 0.5 + 0.5;
    float snowMask = clamp(upness * uSnowCoverage * (0.55 + drift * 0.75), 0.0, 1.0);
    // Snow is not flat white: it picks up sky colour and has a faint sparkle.
    float sparkle = pow(max(snoise(vWorldPos * 34.0), 0.0), 8.0);
    vec3 snowColor = vec3(0.9, 0.93, 0.98) + sparkle * 0.6;
    albedo = mix(albedo, snowColor, snowMask);
    roughness = mix(roughness, 0.55, snowMask);
  }

  /* ── Wetness ──────────────────────────────────────────────────────────────
   * Wet ground is darker (water fills surface pores, trapping light) and
   * glossier (a smooth water film replaces the rough surface). Both effects
   * pool in hollows, which the vertex AO term already identifies for us. */
  if (uWetness > 0.01) {
    float pooling = (1.0 - vOcclusion) * 1.6 + 0.4;
    float wet = clamp(uWetness * pooling * smoothstep(0.3, 0.75, normal.y), 0.0, 1.0);
    albedo *= mix(1.0, 0.62, wet);
    roughness = mix(roughness, 0.12, wet);
  }

  /* ── Lighting ─────────────────────────────────────────────────────────── */
  float ndotl = max(dot(normal, uSunDirection), 0.0);

  /* A soft terminator. Real ground has enough micro-relief that the light/dark
   * boundary is never a hard line; smoothstepping it also hides shadow-map
   * acne along grazing angles.
   *
   * The diffuse term is *wrapped* (light bleeds ~30% past the terminator) to
   * match the grass shader. Soil scatters light subsurface just as leaves do,
   * and using a hard Lambert here while the grass wraps made the ground look
   * like a different, much darker material at low sun angles. */
  float shadowSoft = smoothstep(0.0, 0.22, ndotl);
  float wrapped = max((dot(normal, uSunDirection) + 0.3) / 1.3, 0.0);
  vec3 diffuse = uSunColor * uSunIntensity * mix(ndotl * shadowSoft, wrapped, 0.55);

  // Hemispheric ambient: sky above, bounce below.
  float hemi = normal.y * 0.5 + 0.5;
  vec3 ambient = mix(uAmbientColor * 0.4, uAmbientColor, hemi) * uAmbientIntensity;

  /* Specular — a cheap Blinn-Phong lobe. Only matters when the ground is wet
   * or snowy, but that is exactly when it matters a great deal. */
  vec3 halfDir = normalize(uSunDirection + viewDir);
  float specPower = mix(6.0, 220.0, 1.0 - roughness);
  float spec = pow(max(dot(normal, halfDir), 0.0), specPower) * (1.0 - roughness) * ndotl;

  vec3 color = albedo * (diffuse + ambient) * vOcclusion;
  color += uSunColor * spec * uSunIntensity * 0.55;

  /* ── Rain ripples ─────────────────────────────────────────────────────────
   * Expanding concentric rings on standing water. Cheap: one noise lookup for
   * the ring centres, one sine for the animation. */
  if (uWetness > 0.5) {
    float ripplePhase = uTime * 3.2;
    vec2 cell = floor(vWorldPos.xz * 2.2);
    float cellNoise = snoise(vec3(cell, 0.0)) * 0.5 + 0.5;
    float ringT = fract(ripplePhase * 0.5 + cellNoise);
    float radius = length(fract(vWorldPos.xz * 2.2) - 0.5);
    float ring = smoothstep(ringT - 0.06, ringT, radius) * (1.0 - smoothstep(ringT, ringT + 0.06, radius));
    color += vec3(ring * (1.0 - ringT) * 0.08 * (uWetness - 0.5) * 2.0);
  }

  /* ── Fog ──────────────────────────────────────────────────────────────────
   * Height-attenuated: fog pools in the valley floor and thins on the ridge,
   * which is what sells the depth of the landscape at dawn. */
  float heightFade = exp(-max(vWorldPos.y - 2.0, 0.0) * 0.045);
  float fogFactor = 1.0 - exp(-dist * dist * uFogDensity * uFogDensity * heightFade);
  color = mix(color, uFogColor, clamp(fogFactor, 0.0, 1.0));

  gl_FragColor = vec4(color, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
