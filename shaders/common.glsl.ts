/**
 * Shared GLSL chunks.
 *
 * > **Why `.glsl.ts` and not `.glsl`?**
 * > Raw `.glsl` imports need a bundler loader, and Turbopack (dev) and Webpack
 * > (production build) would each need their own. Exporting GLSL as tagged
 * > template literals from TypeScript works identically in both, survives HMR,
 * > and gives editors syntax highlighting via the `/* glsl *\/` comment tag
 * > that most GLSL extensions recognise.
 *
 * @module shaders/common
 */

/** Tag function; exists purely so editors can highlight the contents. */
export const glsl = (strings: TemplateStringsArray, ...values: unknown[]): string =>
  strings.reduce((acc, str, i) => acc + str + (values[i] ?? ''), '');

/* ───────────────────────────────────────────────────────────────────────────
 * NOISE
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Ashima/Stefan Gustavson's simplex noise, the standard GPU implementation.
 *
 * Simplex rather than classic Perlin because it has no directional artefacts
 * (Perlin's gradients align to a grid, which shows up as visible cross-hatching
 * on large surfaces) and it is cheaper in 3D.
 */
export const SIMPLEX_NOISE = glsl`
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

/** Layered simplex — broad shape plus fine detail. */
float fbm3(vec3 p, int octaves, float lacunarity, float gain) {
  float sum = 0.0;
  float amp = 1.0;
  float norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += snoise(p) * amp;
    norm += amp;
    p *= lacunarity;
    amp *= gain;
  }
  return sum / max(norm, 0.0001);
}
`;

/** Cheap hash-based value noise for cases where simplex is overkill. */
export const HASH_NOISE = glsl`
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i + vec2(0.0, 0.0)), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y);
}
`;

/* ───────────────────────────────────────────────────────────────────────────
 * WIND
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The shared wind displacement function.
 *
 * Every plant in the world bends through this, which is why they all move
 * together instead of each wobbling on its own phase.
 *
 * Three superimposed effects:
 *
 * 1. **Base sway** — a slow sine in the wind direction, phase-offset by world
 *    position so neighbouring plants aren't synchronised.
 * 2. **Travelling gust ripple** — a wave moving across the world along the wind
 *    vector. This is the visible band of motion that crosses a wheatfield
 *    *ahead* of the gust, and it is the single most convincing wind cue there
 *    is.
 * 3. **Flutter** — high-frequency, low-amplitude jitter on the tips only,
 *    standing in for individual leaves catching the air.
 *
 * The `stiffness` exponent controls how much of the bend happens near the tip:
 * grass (low stiffness) bends from the base, a tree branch (high stiffness)
 * barely moves at the trunk and a lot at the leaves.
 *
 * @param worldPos   World-space position of the vertex.
 * @param heightT    0 at the plant's base, 1 at its tip.
 * @param stiffness  Bend profile exponent. ~1.4 grass, ~2.5 branches.
 * @param phase      Per-instance random offset so nothing is in lockstep.
 */
export const WIND_UNIFORMS = glsl`
uniform float uTime;
uniform vec2  uWindDirection;
uniform float uWindStrength;
uniform float uRipplePhase;
uniform float uRippleWavelength;
`;

/**
 * The displacement function itself, *without* the uniform declarations.
 *
 * Kept separate from {@link WIND_UNIFORMS} because the two consumers need
 * different things: the standalone grass and wheat shaders declare the wind
 * uniforms in their own preamble, whereas the `onBeforeCompile` patch injected
 * into three.js's standard material has no preamble of its own and must bring
 * the declarations with it. Emitting both from one chunk produced a
 * `'uTime' : redefinition` compile error in the grass shader.
 */
export const WIND_DISPLACEMENT = glsl`
vec3 windDisplace(vec3 worldPos, float heightT, float stiffness, float phase) {
  // Nothing below the base moves at all.
  float bend = pow(clamp(heightT, 0.0, 1.0), stiffness);

  // 1. Base sway — the plant's own oscillation.
  float sway = sin(uTime * 1.6 + phase + worldPos.x * 0.12 + worldPos.z * 0.09);

  // 2. Travelling gust. Projecting world position onto the wind vector gives a
  //    scalar that increases downwind, so subtracting the advancing phase makes
  //    the wave move *with* the wind rather than standing still.
  float alongWind = dot(worldPos.xz, uWindDirection);
  float ripple = sin(alongWind / uRippleWavelength * 6.2831853 - uRipplePhase * 0.35);
  // Sharpen it: real gusts are a travelling front, not a smooth sine.
  ripple = ripple * 0.5 + 0.5;
  ripple = pow(ripple, 2.2);

  // 3. Tip flutter.
  float flutter = sin(uTime * 8.4 + phase * 3.1) * 0.12
                + sin(uTime * 13.7 + phase * 5.7) * 0.06;

  float amount = uWindStrength * bend * (0.55 + ripple * 0.85);
  vec2 offset = uWindDirection * (sway * 0.35 + ripple * 0.5 + flutter) * amount;

  /* Plants bend, they don't stretch: as the tip moves sideways it must also
   * drop, or the plant appears to grow taller in the wind. Approximating the
   * arc with a quadratic is visually indistinguishable from a true circular
   * bend at these amplitudes. */
  float horizontal = length(offset);
  float drop = horizontal * horizontal * 0.28;

  return vec3(offset.x, -drop, offset.y);
}
`;

/* ───────────────────────────────────────────────────────────────────────────
 * UTILITIES
 * ─────────────────────────────────────────────────────────────────────────── */

/** Colour-space and general helpers used across several shaders. */
export const COLOR_UTILS = glsl`
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

/* Rotates a colour's hue by "amount" turns. Cheaper than a full HSV round-trip
   when only the hue changes, but this version is used where clarity matters. */
vec3 shiftHue(vec3 color, float amount) {
  vec3 hsv = rgb2hsv(color);
  hsv.x = fract(hsv.x + amount);
  return hsv2rgb(hsv);
}

float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

/** Exponential height fog, matching three.js's FogExp2 but height-attenuated. */
vec3 applyHeightFog(vec3 color, vec3 fogColor, float dist, float height,
                    float density, float heightFalloff) {
  // Fog pools in valleys: density decays exponentially with altitude.
  float heightFactor = exp(-max(height, 0.0) * heightFalloff);
  float f = 1.0 - exp(-dist * density * heightFactor);
  return mix(color, fogColor, clamp(f, 0.0, 1.0));
}
`;

/**
 * Triplanar mapping.
 *
 * Standard UV mapping on terrain stretches horribly on anything steeper than
 * about 30° — cliff faces turn into smeared streaks. Triplanar projection
 * samples the texture three times, once along each world axis, and blends by
 * the surface normal. A vertical face is sampled from the side, so the texture
 * stays square no matter the slope.
 *
 * Cost is 3× the texture fetches, which is why `blendSharpness` matters: raising
 * the normal to a power concentrates the blend so that on mostly-flat ground
 * two of the three samples contribute almost nothing and can be skipped by the
 * GPU's early-out on multiplication by zero.
 */
export const TRIPLANAR = glsl`
vec3 triplanarSample(sampler2D tex, vec3 worldPos, vec3 normal, float scale, float blendSharpness) {
  vec3 blend = pow(abs(normal), vec3(blendSharpness));
  blend /= max(blend.x + blend.y + blend.z, 0.0001);

  vec3 xz = texture2D(tex, worldPos.xz * scale).rgb;
  vec3 xy = texture2D(tex, worldPos.xy * scale).rgb;
  vec3 zy = texture2D(tex, worldPos.zy * scale).rgb;

  // Y-axis projection (xz) dominates on flat ground.
  return xz * blend.y + xy * blend.z + zy * blend.x;
}
`;
