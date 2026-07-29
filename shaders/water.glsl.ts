/**
 * Water: the reflective pond and the flowing brook.
 *
 * Two related shaders sharing a lighting model.
 *
 * ## The pond
 *
 * Four effects stack to make still water read as water:
 *
 * 1. **Fresnel reflectance.** Water reflects almost nothing when you look
 *    straight down into it and almost everything at a grazing angle. Schlick's
 *    approximation with F₀ = 0.02 (water's actual normal-incidence
 *    reflectance) is what makes the far shore mirror-bright while your own
 *    feet are visible through the near edge. Getting this one term right is
 *    most of the battle.
 * 2. **Dual scrolling normal maps.** Two samples of the same normal texture,
 *    scrolling at different speeds and angles, summed. Their interference
 *    never repeats, so the surface never visibly loops.
 * 3. **Caustics.** Refracted light focusing on the bottom, approximated with
 *    layered Voronoi-ish noise. Only visible in shallow water, where it should
 *    be.
 4. **Depth-based colour.** Shallow water shows the bed; deep water goes green
 *    and then dark. Driven by the difference between the water plane and the
 *    terrain's depth buffer.
 *
 * ## The brook
 *
 * Uses a **flow map**: a direction field baked from the stream's polyline that
 * tells each fragment which way the water is moving. Two time-offset samples
 * are cross-faded so the texture advects downstream continuously without
 * stretching — the standard trick, and the only practical way to make a river
 * flow around bends.
 *
 * @module shaders/water
 */

import { glsl, SIMPLEX_NOISE, HASH_NOISE } from './common.glsl';

export const WATER_VERTEX = glsl`
precision highp float;

uniform float uTime;
uniform float uWaveHeight;
uniform vec2  uWindDirection;
uniform float uWindStrength;

varying vec3 vWorldPos;
varying vec2 vUv;
varying vec3 vNormal;
varying vec4 vScreenPos;

void main() {
  vUv = uv;
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);

  /* Gerstner-ish surface displacement. Three waves at different frequencies and
   * headings; the sum is quasi-periodic rather than periodic, so no obvious
   * wave train appears. Amplitude scales with wind — a still day gives glass. */
  float w = uWindStrength;
  float t = uTime;
  vec2 p = worldPosition.xz;

  float wave =
      sin(dot(p, vec2( 0.71,  0.71)) * 0.42 + t * 1.10) * 0.55
    + sin(dot(p, vec2(-0.42,  0.91)) * 0.71 + t * 1.63) * 0.30
    + sin(dot(p, vec2( 0.94, -0.34)) * 1.23 + t * 2.31) * 0.15;

  worldPosition.y += wave * uWaveHeight * (0.35 + w * 0.65);

  vWorldPos = worldPosition.xyz;
  vNormal = vec3(0.0, 1.0, 0.0);

  vec4 clip = projectionMatrix * viewMatrix * worldPosition;
  vScreenPos = clip;
  gl_Position = clip;
}
`;

export const WATER_FRAGMENT = glsl`
precision highp float;

uniform sampler2D uNormalMap;
uniform sampler2D uReflectionMap;
uniform float uHasReflection;

uniform vec3  uSunDirection;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform vec3  uSkyColor;
uniform vec3  uAmbientColor;
uniform float uAmbientIntensity;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform vec3  uCameraPos;

uniform vec3  uShallowColor;
uniform vec3  uDeepColor;
uniform float uWaterLevel;
uniform float uTime;
uniform float uWindStrength;
uniform float uCausticStrength;
uniform float uFrozen;       // 0..1 — winter ice
uniform float uRainRipples;  // 0..1 — rain intensity

// Player-generated ripples (stone skips, thrown objects, fish).
uniform vec3  uRippleOrigins[8];   // xz = position, y = start time
uniform int   uRippleCount;

varying vec3 vWorldPos;
varying vec2 vUv;
varying vec3 vNormal;
varying vec4 vScreenPos;

${SIMPLEX_NOISE}
${HASH_NOISE}

/**
 * Caustics.
 *
 * Real caustics are the envelope of refracted light rays converging on the
 * bottom. Simulating that is expensive; the standard cheat is layered noise
 * pushed through a high power, which produces the same bright, branching,
 * cell-like network. Two layers scrolling in opposite directions keeps it
 * animated without repeating.
 */
float caustics(vec2 p, float t) {
  vec2 a = p + vec2(t * 0.08, t * 0.05);
  vec2 b = p * 1.37 - vec2(t * 0.06, -t * 0.09);

  float n1 = snoise(vec3(a * 1.4, t * 0.12)) * 0.5 + 0.5;
  float n2 = snoise(vec3(b * 2.1, t * 0.17)) * 0.5 + 0.5;

  // The high exponent is what turns soft noise into sharp caustic filaments.
  float c = pow(1.0 - abs(n1 - n2), 9.0);
  return clamp(c, 0.0, 1.0);
}

/** Expanding concentric ripple from a point impact. */
float impactRipple(vec2 pos, vec2 origin, float age) {
  if (age < 0.0 || age > 4.0) return 0.0;
  float d = distance(pos, origin);
  float radius = age * 3.2;
  // A decaying sine ring travelling outward.
  float ring = sin((d - radius) * 7.0) * exp(-abs(d - radius) * 1.8);
  // Fade with age and with distance from the impact.
  return ring * exp(-age * 0.9) * exp(-d * 0.12);
}

void main() {
  vec3 viewDir = normalize(uCameraPos - vWorldPos);
  float dist = distance(uCameraPos, vWorldPos);

  /* ── Surface normal from two scrolling samples ──────────────────────────── */
  float speed = 0.014 + uWindStrength * 0.02;
  vec2 uv1 = vWorldPos.xz * 0.055 + vec2(uTime * speed, uTime * speed * 0.7);
  vec2 uv2 = vWorldPos.xz * 0.021 - vec2(uTime * speed * 0.55, uTime * speed * 0.9);

  vec3 n1 = texture2D(uNormalMap, uv1).rgb * 2.0 - 1.0;
  vec3 n2 = texture2D(uNormalMap, uv2).rgb * 2.0 - 1.0;
  // Summing tangent-space normals then renormalising is the cheap, standard
  // blend; it slightly over-flattens but is imperceptible on water.
  vec3 tangentNormal = normalize(n1 + n2 * 0.65);

  float choppiness = mix(0.12, 0.55, clamp(uWindStrength, 0.0, 1.5) / 1.5);
  vec3 normal = normalize(vec3(
    tangentNormal.x * choppiness,
    1.0,
    tangentNormal.z * choppiness
  ));

  /* ── Player and rain ripples ─────────────────────────────────────────────
   * Perturb the normal rather than the geometry — displacement would need far
   * more tessellation than the pond has. */
  float rippleSum = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= uRippleCount) break;
    rippleSum += impactRipple(vWorldPos.xz, uRippleOrigins[i].xz, uTime - uRippleOrigins[i].y);
  }
  if (uRainRipples > 0.01) {
    // Scattered impacts on a jittered grid.
    vec2 cell = floor(vWorldPos.xz * 1.6);
    float phase = hash21(cell);
    float age = fract(uTime * 0.9 + phase) * 1.4;
    vec2 origin = (cell + 0.5 + vec2(hash21(cell + 7.0), hash21(cell + 13.0)) - 0.5) / 1.6;
    rippleSum += impactRipple(vWorldPos.xz, origin, age) * uRainRipples * 1.4;
  }
  normal = normalize(normal + vec3(dFdx(rippleSum), 0.0, dFdy(rippleSum)) * 14.0);

  /* ── Ice ─────────────────────────────────────────────────────────────────
   * In winter the pond freezes: the surface flattens, goes rough-specular and
   * picks up crack patterns. */
  if (uFrozen > 0.01) {
    normal = normalize(mix(normal, vec3(0.0, 1.0, 0.0), uFrozen * 0.85));
  }

  /* ── Fresnel ─────────────────────────────────────────────────────────────
   * Schlick's approximation. F₀ = 0.02 is water's true reflectance at normal
   * incidence — barely 2 % — rising to 100 % at grazing angles. */
  float cosTheta = clamp(dot(normal, viewDir), 0.0, 1.0);
  float f0 = mix(0.02, 0.06, uFrozen);
  float fresnel = f0 + (1.0 - f0) * pow(1.0 - cosTheta, 5.0);

  /* ── Reflection ──────────────────────────────────────────────────────────
   * When a reflection probe is available, sample it with the normal-perturbed
   * screen UV. Otherwise fall back to the sky colour, which is a surprisingly
   * good approximation for an open pond under an open sky. */
  vec3 screenUv = vScreenPos.xyz / max(vScreenPos.w, 0.0001);
  vec2 reflUv = screenUv.xy * 0.5 + 0.5;
  reflUv += normal.xz * 0.06;

  vec3 reflection = uSkyColor;
  if (uHasReflection > 0.5) {
    reflection = mix(uSkyColor, texture2D(uReflectionMap, clamp(reflUv, 0.001, 0.999)).rgb, 0.85);
  }

  /* ── Water body colour ───────────────────────────────────────────────────
   * Depth is approximated from how far the fragment is below the water line
   * plus a noise-driven bed variation, since the pond has no depth texture. */
  float depthProxy = clamp((uWaterLevel - vWorldPos.y + 1.6) * 0.42, 0.0, 1.0);
  float bedVariation = snoise(vWorldPos * 0.09) * 0.5 + 0.5;
  float depth = clamp(depthProxy * (0.7 + bedVariation * 0.6), 0.0, 1.0);
  vec3 bodyColor = mix(uShallowColor, uDeepColor, depth);

  /* ── Caustics ────────────────────────────────────────────────────────────
   * Only in shallow water — in deep water the light never reaches the bottom. */
  float shallowness = 1.0 - depth;
  float caustic = caustics(vWorldPos.xz, uTime) * shallowness * uCausticStrength;
  caustic *= max(uSunDirection.y, 0.0); // No caustics after dark.
  bodyColor += uSunColor * caustic * 0.55;

  /* ── Specular sun glint ──────────────────────────────────────────────────
   * The tight highlight where the sun reflects off the surface. Very high
   * exponent — water is smooth, so the glint is small and intense. */
  vec3 halfDir = normalize(uSunDirection + viewDir);
  float specPower = mix(340.0, 90.0, clamp(uWindStrength, 0.0, 1.5) / 1.5);
  float spec = pow(max(dot(normal, halfDir), 0.0), specPower);
  vec3 specular = uSunColor * spec * uSunIntensity * 2.4;

  /* ── Composite ───────────────────────────────────────────────────────────
   * Fresnel is exactly the mix factor between what is under the water and what
   * is reflected off it. */
  vec3 color = mix(bodyColor, reflection, fresnel);
  color += specular;
  color += uAmbientColor * uAmbientIntensity * 0.18;

  // Ice looks quite different: brighter, whiter, with visible fracture lines.
  if (uFrozen > 0.01) {
    float cracks = pow(abs(snoise(vWorldPos * 0.42)), 12.0);
    vec3 iceColor = mix(vec3(0.72, 0.82, 0.88), vec3(0.95, 0.98, 1.0), cracks);
    color = mix(color, iceColor * (0.6 + fresnel * 0.8) + specular * 0.5, uFrozen);
  }

  /* ── Foam at the shoreline ───────────────────────────────────────────────
   * A bright rim where the water meets the bank. Uses the same depth proxy, so
   * it automatically follows the pond's irregular edge. */
  float foam = 1.0 - smoothstep(0.0, 0.14, depthProxy);
  float foamNoise = snoise(vec3(vWorldPos.xz * 2.4, uTime * 0.35)) * 0.5 + 0.5;
  color = mix(color, vec3(0.92, 0.95, 0.96), foam * foamNoise * 0.55 * (1.0 - uFrozen));

  float fogFactor = 1.0 - exp(-dist * dist * uFogDensity * uFogDensity);
  color = mix(color, uFogColor, clamp(fogFactor, 0.0, 1.0));

  // Water is opaque at grazing angles and translucent looking down — matching
  // the fresnel term keeps the alpha physically consistent with the colour.
  float alpha = mix(0.78, 1.0, fresnel);
  alpha = mix(alpha, 1.0, uFrozen);

  gl_FragColor = vec4(color, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ───────────────────────────────────────────────────────────────────────────
 * FLOWING BROOK
 * ─────────────────────────────────────────────────────────────────────────── */

export const STREAM_VERTEX = glsl`
precision highp float;

attribute vec2 aFlowDirection;  // Baked per-vertex downstream direction
attribute float aFlowSpeed;

uniform float uTime;

varying vec3  vWorldPos;
varying vec2  vUv;
varying vec2  vFlow;
varying float vFlowSpeed;

void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPosition.xyz;
  vUv = uv;
  vFlow = aFlowDirection;
  vFlowSpeed = aFlowSpeed;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

export const STREAM_FRAGMENT = glsl`
precision highp float;

uniform sampler2D uNormalMap;
uniform vec3  uSunDirection;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform vec3  uSkyColor;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform vec3  uCameraPos;
uniform vec3  uShallowColor;
uniform vec3  uDeepColor;
uniform float uTime;

varying vec3  vWorldPos;
varying vec2  vUv;
varying vec2  vFlow;
varying float vFlowSpeed;

${SIMPLEX_NOISE}

/**
 * Flow-map sampling.
 *
 * The problem: scrolling a texture along a curved flow field stretches it more
 * and more the longer it scrolls. The solution — standard in every river shader
 * since Portal 2 — is to take two samples whose scroll phases are offset by
 * half a cycle, and cross-fade between them with a triangle wave. Each sample
 * is reset to zero offset before it has stretched noticeably, and the crossfade
 * hides the reset.
 */
vec3 flowSample(sampler2D tex, vec2 uv, vec2 flow, float time, float scale) {
  float cycle = fract(time);
  float cycleOffset = fract(time + 0.5);

  vec2 uvA = uv * scale - flow * cycle;
  vec2 uvB = uv * scale - flow * cycleOffset;

  vec3 a = texture2D(tex, uvA).rgb;
  vec3 b = texture2D(tex, uvB).rgb;

  // Triangle wave: 1 at cycle=0.5, 0 at cycle=0 and 1 — so each sample is
  // weighted most when it is least stretched.
  float blend = abs(cycle - 0.5) * 2.0;
  return mix(a, b, blend);
}

void main() {
  vec3 viewDir = normalize(uCameraPos - vWorldPos);
  float dist = distance(uCameraPos, vWorldPos);

  float flowTime = uTime * vFlowSpeed * 0.35;
  vec3 n = flowSample(uNormalMap, vWorldPos.xz, vFlow, flowTime, 0.18) * 2.0 - 1.0;
  // Faster water is choppier.
  vec3 normal = normalize(vec3(n.x * 0.6 * vFlowSpeed, 1.0, n.z * 0.6 * vFlowSpeed));

  float cosTheta = clamp(dot(normal, viewDir), 0.0, 1.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - cosTheta, 5.0);

  // A shallow brook shows its bed almost everywhere.
  vec3 body = mix(uShallowColor, uDeepColor, 0.35);

  vec3 halfDir = normalize(uSunDirection + viewDir);
  float spec = pow(max(dot(normal, halfDir), 0.0), 120.0);

  vec3 color = mix(body, uSkyColor, fresnel * 0.75);
  color += uSunColor * spec * uSunIntensity * 1.6;

  /* White water: where the flow is fastest, air entrains and the surface goes
   * white. Driven by flow speed and a noise field so it appears in patches, the
   * way it does over rocks. */
  float turbulence = snoise(vec3(vWorldPos.xz * 3.2 - vFlow * uTime * 1.4, uTime * 0.8)) * 0.5 + 0.5;
  float whitewater = smoothstep(0.55, 0.95, turbulence * vFlowSpeed);
  color = mix(color, vec3(0.94, 0.96, 0.97), whitewater * 0.6);

  float fogFactor = 1.0 - exp(-dist * dist * uFogDensity * uFogDensity);
  color = mix(color, uFogColor, clamp(fogFactor, 0.0, 1.0));

  gl_FragColor = vec4(color, mix(0.72, 0.95, fresnel));

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
