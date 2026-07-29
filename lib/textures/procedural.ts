/**
 * Procedural texture synthesis.
 *
 * Whispering Hollow ships **no image files**. Every texture — grass, dirt,
 * rock, sand, cobblestone, bark, cloth, the Milky Way band, the soft particle
 * sprites — is drawn into an offscreen canvas at load time and uploaded as a
 * `CanvasTexture`.
 *
 * Beyond the zero-asset constraint, this buys three real things:
 *   1. **Tiny payload.** A 512² albedo is ~700 KB as PNG and ~2 KB as the code
 *      that generates it.
 *   2. **Seamless by construction.** All noise here is evaluated on a torus
 *      (see {@link tileableNoise}), so textures tile without seams — no manual
 *      offset-and-heal pass.
 *   3. **Season/weather variants for free.** The same generator produces the
 *      summer and winter ground simply by shifting its palette.
 *
 * All generators are memoised: asking twice for the same texture returns the
 * same GPU upload.
 *
 * @module lib/textures/procedural
 */

import * as THREE from 'three';
import { mulberry32, hashSeed } from '@/lib/utils/random';
import { clamp, lerp, smoothstep } from '@/lib/utils/math';

/* ───────────────────────────────────────────────────────────────────────────
 * NOISE PRIMITIVES
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Builds a tileable 2D value-noise field.
 *
 * The trick for seamlessness: sample a periodic lattice and wrap the integer
 * cell coordinates modulo `period`. Because the lattice repeats exactly at the
 * texture edge, the interpolated result is continuous across the seam — the
 * texture can be tiled infinitely with no visible join.
 *
 * @param period - Lattice period in cells. Must divide the texture size evenly.
 * @param seed - Deterministic seed.
 */
export function tileableNoise(period: number, seed: number): (x: number, y: number) => number {
  const rand = mulberry32(seed);
  const lattice = new Float32Array(period * period);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();

  const at = (ix: number, iy: number): number => {
    const x = ((ix % period) + period) % period;
    const y = ((iy % period) + period) % period;
    return lattice[y * period + x]!;
  };

  return (x: number, y: number): number => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    // Quintic fade — C² continuous, so no lattice-aligned creasing shows up.
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = at(ix, iy);
    const b = at(ix + 1, iy);
    const c = at(ix, iy + 1);
    const d = at(ix + 1, iy + 1);
    return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
  };
}

/**
 * Layered tileable noise. Each octave doubles the lattice period so every layer
 * remains individually tileable, and therefore so does the sum.
 */
export function tileableFbm(
  basePeriod: number,
  octaves: number,
  seed: number,
  gain = 0.5,
): (x: number, y: number) => number {
  const layers = Array.from({ length: octaves }, (_, i) =>
    tileableNoise(basePeriod * Math.pow(2, i), seed + i * 7919),
  );
  return (x: number, y: number): number => {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let freq = 1;
    for (let i = 0; i < octaves; i++) {
      sum += layers[i]!(x * freq * basePeriod, y * freq * basePeriod) * amp;
      norm += amp;
      freq *= 2;
      amp *= gain;
    }
    return sum / norm;
  };
}

/* ───────────────────────────────────────────────────────────────────────────
 * CANVAS PLUMBING
 * ─────────────────────────────────────────────────────────────────────────── */

function createCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  if (!ctx) throw new Error('Failed to acquire a 2D context for texture synthesis');
  return { canvas, ctx };
}

function finalise(
  canvas: HTMLCanvasElement,
  { repeat = 1, srgb = true, anisotropy = 8 } = {},
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = anisotropy;
  // Albedo maps carry sRGB-encoded values; normal/roughness maps do not.
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Memoisation cache keyed on generator name + parameters. */
const cache = new Map<string, THREE.Texture>();

function memo(key: string, build: () => THREE.Texture): THREE.Texture {
  const hit = cache.get(key);
  if (hit) return hit;
  const tex = build();
  cache.set(key, tex);
  return tex;
}

/** Disposes every cached texture. Called on scene teardown to free GPU memory. */
export function disposeTextureCache(): void {
  for (const tex of cache.values()) tex.dispose();
  cache.clear();
}

/* ───────────────────────────────────────────────────────────────────────────
 * GROUND MATERIALS
 * ─────────────────────────────────────────────────────────────────────────── */

interface GroundPalette {
  base: [number, number, number];
  accent: [number, number, number];
  dark: [number, number, number];
}

/**
 * Shared generator for the four terrain splat layers.
 *
 * Structure comes from two noise scales: a broad one that establishes patches
 * of lighter and darker ground, and a fine one that adds per-pixel grain. Both
 * modulate a three-stop palette, which is enough to read convincingly as an
 * organic surface at the grazing angles terrain is normally viewed at.
 */
function groundTexture(
  size: number,
  seed: number,
  palette: GroundPalette,
  opts: { grain: number; patchScale: number; contrast: number },
): HTMLCanvasElement {
  const { canvas, ctx } = createCanvas(size);
  const img = ctx.createImageData(size, size);
  const data = img.data;

  const broad = tileableFbm(4, 4, seed);
  const fine = tileableFbm(16, 3, seed + 1013);
  const rand = mulberry32(seed + 77);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;

      const b = broad(u * opts.patchScale, v * opts.patchScale);
      const f = fine(u, v);
      // Push the broad field through a contrast curve so patches read as
      // distinct areas rather than a uniform mush.
      let t = clamp((b - 0.5) * opts.contrast + 0.5, 0, 1);
      t = lerp(t, f, 0.32);

      // Three-stop ramp: dark → base → accent.
      let r: number, g: number, bl: number;
      if (t < 0.5) {
        const k = t * 2;
        r = lerp(palette.dark[0], palette.base[0], k);
        g = lerp(palette.dark[1], palette.base[1], k);
        bl = lerp(palette.dark[2], palette.base[2], k);
      } else {
        const k = (t - 0.5) * 2;
        r = lerp(palette.base[0], palette.accent[0], k);
        g = lerp(palette.base[1], palette.accent[1], k);
        bl = lerp(palette.base[2], palette.accent[2], k);
      }

      // Per-pixel grain breaks up the smooth interpolation; without it the
      // texture looks like plastic under a directional light.
      const n = (rand() - 0.5) * opts.grain;
      const i = (y * size + x) * 4;
      data[i] = clamp(r + n, 0, 1) * 255;
      data[i + 1] = clamp(g + n, 0, 1) * 255;
      data[i + 2] = clamp(bl + n, 0, 1) * 255;
      data[i + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Grass albedo. `winter` shifts the palette toward frosted, desaturated green. */
export function grassTexture(size = 512, winter = false): THREE.Texture {
  return memo(`grass-${size}-${winter}`, () =>
    finalise(
      groundTexture(
        size,
        1337,
        winter
          ? {
              base: [0.52, 0.58, 0.53],
              accent: [0.68, 0.72, 0.7],
              dark: [0.36, 0.42, 0.39],
            }
          : {
              base: [0.32, 0.45, 0.19],
              accent: [0.5, 0.62, 0.27],
              dark: [0.18, 0.28, 0.12],
            },
        { grain: 0.09, patchScale: 3, contrast: 1.5 },
      ),
    ),
  );
}

/** Bare earth / cart-track albedo. */
export function dirtTexture(size = 512): THREE.Texture {
  return memo(`dirt-${size}`, () =>
    finalise(
      groundTexture(
        size,
        24601,
        { base: [0.42, 0.32, 0.22], accent: [0.55, 0.44, 0.31], dark: [0.26, 0.19, 0.13] },
        { grain: 0.11, patchScale: 4, contrast: 1.3 },
      ),
    ),
  );
}

/** Exposed rock albedo — high contrast, strong fine detail for the strata. */
export function rockTexture(size = 512): THREE.Texture {
  return memo(`rock-${size}`, () =>
    finalise(
      groundTexture(
        size,
        90210,
        { base: [0.44, 0.43, 0.41], accent: [0.6, 0.59, 0.56], dark: [0.24, 0.24, 0.25] },
        { grain: 0.14, patchScale: 6, contrast: 2.1 },
      ),
    ),
  );
}

/** Pale waterline sand. */
export function sandTexture(size = 512): THREE.Texture {
  return memo(`sand-${size}`, () =>
    finalise(
      groundTexture(
        size,
        5150,
        { base: [0.72, 0.64, 0.48], accent: [0.83, 0.76, 0.6], dark: [0.56, 0.48, 0.35] },
        { grain: 0.07, patchScale: 8, contrast: 1.1 },
      ),
    ),
  );
}

/**
 * Cobblestone albedo for the village plaza.
 *
 * Rather than noise, this draws actual stones: a jittered grid of rounded
 * quads, each with its own tone and a darker mortar gap. Jittering both the
 * position and the corner radius is what stops it reading as a checkerboard.
 */
export function cobbleTexture(size = 512): THREE.Texture {
  return memo(`cobble-${size}`, () => {
    const { canvas, ctx } = createCanvas(size);
    const rand = mulberry32(hashSeed('cobblestone'));

    // Mortar base.
    ctx.fillStyle = '#3a3733';
    ctx.fillRect(0, 0, size, size);

    const cells = 9;
    const cell = size / cells;

    // Draw a 3× overdraw pass wrapping past the edges so stones straddling the
    // seam appear on both sides and the tile stays continuous.
    for (let pass = 0; pass < 1; pass++) {
      for (let gy = -1; gy <= cells; gy++) {
        for (let gx = -1; gx <= cells; gx++) {
          const jitterX = (rand() - 0.5) * cell * 0.34;
          const jitterY = (rand() - 0.5) * cell * 0.34;
          const cx = gx * cell + cell / 2 + jitterX;
          const cy = gy * cell + cell / 2 + jitterY;
          const w = cell * (0.7 + rand() * 0.22);
          const h = cell * (0.66 + rand() * 0.26);
          const radius = Math.min(w, h) * (0.22 + rand() * 0.2);

          const tone = 0.38 + rand() * 0.3;
          const warm = rand() * 0.05;
          const r = Math.round((tone + warm) * 255);
          const g = Math.round(tone * 255);
          const b = Math.round((tone - warm * 0.6) * 255);

          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate((rand() - 0.5) * 0.24);

          // Rounded stone body.
          ctx.beginPath();
          ctx.roundRect(-w / 2, -h / 2, w, h, radius);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fill();

          // Top-left highlight lip sells the domed profile.
          ctx.beginPath();
          ctx.roundRect(-w / 2 + 1.5, -h / 2 + 1.5, w - 3, h - 3, radius * 0.85);
          const grad = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
          grad.addColorStop(0, `rgba(255,255,255,0.14)`);
          grad.addColorStop(0.5, 'rgba(255,255,255,0)');
          grad.addColorStop(1, 'rgba(0,0,0,0.16)');
          ctx.fillStyle = grad;
          ctx.fill();
          ctx.restore();
        }
      }
    }

    // A wash of fine noise ties the stones and mortar together.
    const img = ctx.getImageData(0, 0, size, size);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rand() - 0.5) * 22;
      d[i] = clamp((d[i]! + n) / 255, 0, 1) * 255;
      d[i + 1] = clamp((d[i + 1]! + n) / 255, 0, 1) * 255;
      d[i + 2] = clamp((d[i + 2]! + n) / 255, 0, 1) * 255;
    }
    ctx.putImageData(img, 0, 0);

    return finalise(canvas);
  });
}

/**
 * Wood plank albedo, used for the station shelter, bridges, fences and market
 * stalls. Grain lines follow a warped sine so they curve like real sawn timber.
 */
export function woodTexture(size = 512, tint: [number, number, number] = [0.42, 0.3, 0.2]) {
  return memo(`wood-${size}-${tint.join(',')}`, () => {
    const { canvas, ctx } = createCanvas(size);
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const warp = tileableFbm(4, 3, 4242);
    const grainNoise = tileableFbm(8, 2, 8484);
    const rand = mulberry32(31337);

    const planks = 6;
    const plankH = size / planks;

    for (let y = 0; y < size; y++) {
      const plankIndex = Math.floor(y / plankH);
      // Each plank gets its own tone and grain phase.
      const plankSeed = ((plankIndex * 2654435761) >>> 0) / 4294967296;
      const plankTone = 0.82 + plankSeed * 0.36;
      const gapDist = Math.min(y % plankH, plankH - (y % plankH));

      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;

        // Warping the grain coordinate is what turns straight stripes into
        // the knotted, flowing figure of real timber.
        const w = warp(u * 2, v * 2) * 0.45;
        const grain = Math.sin((u * 26 + w * 9 + plankSeed * 12) * Math.PI) * 0.5 + 0.5;
        const fine = grainNoise(u * 3, v * 3);

        let t = lerp(grain, fine, 0.35) * plankTone;
        // Darken toward the plank seam.
        t *= smoothstep(0, 2.5, gapDist) * 0.75 + 0.25;
        t += (rand() - 0.5) * 0.05;

        const i = (y * size + x) * 4;
        data[i] = clamp(tint[0] * (0.65 + t * 0.7), 0, 1) * 255;
        data[i + 1] = clamp(tint[1] * (0.65 + t * 0.7), 0, 1) * 255;
        data[i + 2] = clamp(tint[2] * (0.65 + t * 0.7), 0, 1) * 255;
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return finalise(canvas);
  });
}

/** Rough plaster / render for cottage walls. */
export function plasterTexture(size = 256, tint: [number, number, number] = [0.88, 0.84, 0.75]) {
  return memo(`plaster-${size}-${tint.join(',')}`, () => {
    const { canvas, ctx } = createCanvas(size);
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const bumps = tileableFbm(12, 3, 606);
    const rand = mulberry32(909);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const t = bumps(x / size, y / size) * 0.28 + 0.72 + (rand() - 0.5) * 0.06;
        const i = (y * size + x) * 4;
        data[i] = clamp(tint[0] * t, 0, 1) * 255;
        data[i + 1] = clamp(tint[1] * t, 0, 1) * 255;
        data[i + 2] = clamp(tint[2] * t, 0, 1) * 255;
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return finalise(canvas);
  });
}

/** Roof tile / thatch texture. */
export function roofTexture(size = 256, thatch = false): THREE.Texture {
  return memo(`roof-${size}-${thatch}`, () => {
    const { canvas, ctx } = createCanvas(size);
    const rand = mulberry32(thatch ? 1212 : 3434);

    if (thatch) {
      ctx.fillStyle = '#6b5530';
      ctx.fillRect(0, 0, size, size);
      // Thousands of short straw strokes, all leaning the same way.
      for (let i = 0; i < 5200; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const len = 6 + rand() * 12;
        const tone = 0.45 + rand() * 0.4;
        ctx.strokeStyle = `rgba(${Math.round(tone * 190)},${Math.round(tone * 158)},${Math.round(tone * 92)},0.85)`;
        ctx.lineWidth = 0.9 + rand() * 1.1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (rand() - 0.5) * 3, y + len);
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = '#5a3b33';
      ctx.fillRect(0, 0, size, size);
      const rows = 10;
      const rowH = size / rows;
      for (let r = -1; r <= rows; r++) {
        // Alternate rows are offset by half a tile, like real pantiles.
        const offset = (r % 2) * (size / 16);
        for (let c = -1; c <= 16; c++) {
          const x = c * (size / 16) + offset;
          const y = r * rowH;
          const tone = 0.62 + rand() * 0.42;
          ctx.fillStyle = `rgb(${Math.round(126 * tone)},${Math.round(74 * tone)},${Math.round(58 * tone)})`;
          ctx.beginPath();
          ctx.roundRect(x + 1, y + 1, size / 16 - 2, rowH - 2, [0, 0, 4, 4]);
          ctx.fill();
          // Shadow under the overlapping course above.
          ctx.fillStyle = 'rgba(0,0,0,0.22)';
          ctx.fillRect(x + 1, y + 1, size / 16 - 2, 2.5);
        }
      }
    }
    return finalise(canvas);
  });
}

/** Tree bark, used on trunk cylinders. Vertical fissures, per-species tint. */
export function barkTexture(size = 256, tint: [number, number, number] = [0.32, 0.24, 0.18]) {
  return memo(`bark-${size}-${tint.join(',')}`, () => {
    const { canvas, ctx } = createCanvas(size);
    const img = ctx.createImageData(size, size);
    const data = img.data;
    // Anisotropic sampling — stretched vertically — gives the long fissures
    // that read unmistakably as bark rather than generic rock.
    const fissures = tileableFbm(8, 4, 777);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        const n = fissures(u * 5, v * 0.9);
        const ridged = Math.pow(Math.abs(n - 0.5) * 2, 0.6);
        const t = 0.55 + ridged * 0.6;
        const i = (y * size + x) * 4;
        data[i] = clamp(tint[0] * t, 0, 1) * 255;
        data[i + 1] = clamp(tint[1] * t, 0, 1) * 255;
        data[i + 2] = clamp(tint[2] * t, 0, 1) * 255;
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return finalise(canvas);
  });
}

/* ───────────────────────────────────────────────────────────────────────────
 * SPRITES & ALPHA MAPS
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * A soft radial falloff sprite — the workhorse for fireflies, steam, dust,
 * light bloom and cloud puffs. Written to the alpha channel so it can be
 * tinted per-instance.
 *
 * @param falloff - Exponent on the radial gradient. Higher = tighter core.
 */
export function softSprite(size = 128, falloff = 2.2): THREE.Texture {
  return memo(`soft-${size}-${falloff}`, () => {
    const { canvas, ctx } = createCanvas(size);
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const c = (size - 1) / 2;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x - c) / c;
        const dy = (y - c) / c;
        const d = Math.sqrt(dx * dx + dy * dy);
        const a = Math.pow(clamp(1 - d, 0, 1), falloff);
        const i = (y * size + x) * 4;
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = a * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  });
}

/**
 * An irregular, puffy cloud sprite: several offset radial blobs multiplied by
 * fbm so the silhouette is lumpy rather than a perfect disc.
 */
export function cloudSprite(size = 256): THREE.Texture {
  return memo(`cloud-${size}`, () => {
    const { canvas, ctx } = createCanvas(size);
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const noise = tileableFbm(6, 4, 2024);
    const rand = mulberry32(4096);

    // A handful of overlapping lobes form the base silhouette.
    const lobes = Array.from({ length: 7 }, () => ({
      x: 0.5 + (rand() - 0.5) * 0.5,
      y: 0.5 + (rand() - 0.5) * 0.34,
      r: 0.16 + rand() * 0.2,
    }));

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;

        let density = 0;
        for (const l of lobes) {
          const dx = u - l.x;
          const dy = (v - l.y) * 1.5;
          const d = Math.sqrt(dx * dx + dy * dy);
          density = Math.max(density, clamp(1 - d / l.r, 0, 1));
        }
        // Erode the edges with noise so the outline is billowy.
        density *= 0.55 + noise(u * 2, v * 2) * 0.85;
        // Fade hard at the sprite border so neighbouring quads never show seams.
        const edge = smoothstep(0.5, 0.32, Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)));
        const a = clamp(Math.pow(density, 1.5), 0, 1) * edge;

        // Slight vertical shading: brighter on top, cooler underneath.
        const shade = lerp(0.72, 1, 1 - v);
        const i = (y * size + x) * 4;
        data[i] = 255 * shade;
        data[i + 1] = 255 * shade;
        data[i + 2] = 255 * lerp(0.92, 1, 1 - v);
        data[i + 3] = a * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  });
}

/**
 * Alpha mask for a single grass/foliage card: a tapered blade silhouette,
 * pointed at the tip and slightly wider at the base.
 */
export function bladeAlpha(size = 64): THREE.Texture {
  return memo(`blade-${size}`, () => {
    const { canvas, ctx } = createCanvas(size);
    const img = ctx.createImageData(size, size);
    const data = img.data;
    for (let y = 0; y < size; y++) {
      const v = y / (size - 1);
      // Width tapers from base (v=1) to tip (v=0) with a slight bulge.
      const halfWidth = (0.5 - v * 0.42) * (0.6 + Math.sin(v * Math.PI) * 0.4);
      for (let x = 0; x < size; x++) {
        const u = x / (size - 1) - 0.5;
        const inside = Math.abs(u) < halfWidth ? 1 : 0;
        // 1-texel feather so the alpha test doesn't produce jagged edges.
        const edge = clamp((halfWidth - Math.abs(u)) * size * 0.5, 0, 1);
        const i = (y * size + x) * 4;
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = inside * edge * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  });
}

/**
 * Foliage canopy card — a clump of overlapping leaf blobs with a soft alpha
 * edge, used for medium-LOD trees and billboards.
 */
export function foliageCard(size = 256, tint: [number, number, number] = [0.28, 0.44, 0.2]) {
  return memo(`foliage-${size}-${tint.join(',')}`, () => {
    const { canvas, ctx } = createCanvas(size);
    const rand = mulberry32(hashSeed(tint.join()));
    ctx.clearRect(0, 0, size, size);

    // Many small leaf ellipses clustered toward the centre.
    for (let i = 0; i < 260; i++) {
      const a = rand() * Math.PI * 2;
      // sqrt biases toward the rim so the centre doesn't turn into a solid blob.
      const r = Math.pow(rand(), 0.65) * size * 0.46;
      const x = size / 2 + Math.cos(a) * r;
      const y = size / 2 + Math.sin(a) * r * 0.88;
      const w = 8 + rand() * 20;
      const h = w * (0.5 + rand() * 0.4);
      const shade = 0.6 + rand() * 0.55;
      // Leaves further from the centre are darker — cheap ambient occlusion.
      const depth = lerp(1, 0.62, r / (size * 0.46));
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rand() * Math.PI);
      ctx.fillStyle = `rgba(${Math.round(tint[0] * 255 * shade * depth)},${Math.round(
        tint[1] * 255 * shade * depth,
      )},${Math.round(tint[2] * 255 * shade * depth)},0.95)`;
      ctx.beginPath();
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  });
}

/**
 * The Milky Way band: a stretched, mottled luminance streak painted across an
 * equirectangular strip, plus a dusting of faint stars.
 *
 * Generated at low resolution on purpose — it is only ever seen at night,
 * heavily bloomed, behind 3200 point-sprite stars.
 */
export function milkyWayTexture(width = 1024, height = 512): THREE.Texture {
  return memo(`milkyway-${width}x${height}`, () => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(width, height);
    const data = img.data;

    const band = tileableFbm(6, 5, 51515);
    const dust = tileableFbm(14, 4, 62626);
    const rand = mulberry32(73737);

    for (let y = 0; y < height; y++) {
      const v = y / height;
      for (let x = 0; x < width; x++) {
        const u = x / width;

        // The galactic plane, tilted across the sphere.
        const centre = 0.5 + Math.sin(u * Math.PI * 2) * 0.09;
        const dist = Math.abs(v - centre);
        let intensity = Math.exp(-(dist * dist) / (2 * 0.055 * 0.055));

        // Clumping and dark dust lanes.
        intensity *= 0.35 + band(u * 3, v * 3) * 1.2;
        intensity *= 1 - dust(u * 5, v * 5) * 0.55;
        intensity = clamp(intensity, 0, 1);

        const i = (y * width + x) * 4;
        // Slightly warm core, cool halo — how the band actually photographs.
        data[i] = intensity * 236;
        data[i + 1] = intensity * 232;
        data[i + 2] = intensity * 255;
        data[i + 3] = 255;
      }
    }

    // Faint background field of unresolved stars.
    for (let i = 0; i < 4200; i++) {
      const x = Math.floor(rand() * width);
      const y = Math.floor(rand() * height);
      const b = Math.pow(rand(), 3) * 255;
      const idx = (y * width + x) * 4;
      data[idx] = Math.min(255, data[idx]! + b);
      data[idx + 1] = Math.min(255, data[idx + 1]! + b);
      data[idx + 2] = Math.min(255, data[idx + 2]! + b);
    }

    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  });
}

/**
 * Water normal map — two sets of interfering ripples that scroll at different
 * rates in the shader, producing non-repeating surface motion.
 */
export function waterNormalTexture(size = 512): THREE.Texture {
  return memo(`waternormal-${size}`, () => {
    const { canvas, ctx } = createCanvas(size);
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const n1 = tileableFbm(8, 3, 11111);
    const n2 = tileableFbm(16, 2, 22222);

    // Build a height field first, then derive normals from its gradient.
    const heights = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        heights[y * size + x] = n1(u * 2, v * 2) * 0.7 + n2(u * 4, v * 4) * 0.3;
      }
    }

    const wrapIdx = (a: number) => ((a % size) + size) % size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const hL = heights[y * size + wrapIdx(x - 1)]!;
        const hR = heights[y * size + wrapIdx(x + 1)]!;
        const hD = heights[wrapIdx(y - 1) * size + x]!;
        const hU = heights[wrapIdx(y + 1) * size + x]!;

        // Tangent-space normal; the 6.0 strength is tuned for a calm pond.
        let nx = (hL - hR) * 6;
        let nz = (hD - hU) * 6;
        const ny = 1;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx /= len;
        nz /= len;
        const nyN = ny / len;

        const i = (y * size + x) * 4;
        data[i] = (nx * 0.5 + 0.5) * 255;
        data[i + 1] = (nyN * 0.5 + 0.5) * 255;
        data[i + 2] = (nz * 0.5 + 0.5) * 255;
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // Normal maps are raw vector data — must NOT be sRGB-decoded.
    return finalise(canvas, { srgb: false });
  });
}

/**
 * Fluttering cloth for the market stall awnings — simple stripes with a woven
 * grain, tinted per stall.
 */
export function clothTexture(
  size = 256,
  a: [number, number, number] = [0.85, 0.32, 0.25],
  b: [number, number, number] = [0.94, 0.9, 0.82],
): THREE.Texture {
  return memo(`cloth-${size}-${a.join()}-${b.join()}`, () => {
    const { canvas, ctx } = createCanvas(size);
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const weave = tileableFbm(32, 2, 8080);
    const rand = mulberry32(1234);
    const stripes = 6;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const stripe = Math.floor(u * stripes) % 2 === 0;
        const c = stripe ? a : b;
        // Weave adds the subtle criss-cross of woven fabric.
        const w = 0.86 + weave(u * 4, y / size / 4) * 0.28 + (rand() - 0.5) * 0.04;
        const i = (y * size + x) * 4;
        data[i] = clamp(c[0] * w, 0, 1) * 255;
        data[i + 1] = clamp(c[1] * w, 0, 1) * 255;
        data[i + 2] = clamp(c[2] * w, 0, 1) * 255;
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return finalise(canvas, { repeat: 1 });
  });
}

/**
 * Graffiti decal for the cargo wagon — abstract loops and tags, never text, so
 * it reads as street art without spelling anything.
 */
export function graffitiTexture(size = 256): THREE.Texture {
  return memo(`graffiti-${size}`, () => {
    const { canvas, ctx } = createCanvas(size);
    const rand = mulberry32(hashSeed('graffiti'));
    ctx.clearRect(0, 0, size, size);

    const palette = ['#e8543f', '#f2b83c', '#4fb0d8', '#8f6fd8', '#f2f0e6'];
    for (let s = 0; s < 5; s++) {
      ctx.strokeStyle = palette[Math.floor(rand() * palette.length)]!;
      ctx.lineWidth = 5 + rand() * 11;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.75 + rand() * 0.25;
      ctx.beginPath();
      let x = size * (0.15 + rand() * 0.2);
      let y = size * (0.3 + rand() * 0.4);
      ctx.moveTo(x, y);
      for (let seg = 0; seg < 5; seg++) {
        const cx = x + (rand() - 0.3) * size * 0.3;
        const cy = y + (rand() - 0.5) * size * 0.4;
        x += (rand() * 0.25 + 0.05) * size;
        y += (rand() - 0.5) * size * 0.25;
        ctx.quadraticCurveTo(cx, cy, x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  });
}
