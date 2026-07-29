/**
 * Generates the PWA icons as real PNG files.
 *
 * The project ships no binary assets, so the icons are written here from raw
 * pixel data using Node's built-in `zlib` — no `sharp`, no `canvas`, no native
 * dependency to install on a fresh clone.
 *
 * PNG is simple enough to emit by hand: a signature, an IHDR chunk describing
 * the image, an IDAT chunk holding zlib-compressed scanlines (each prefixed
 * with a filter byte), and an IEND terminator. Each chunk carries a CRC32 of
 * its type and data.
 *
 * Run with: npm run gen:icons
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'public', 'icons');

/* ───────────────────────────────────────────────────────────────────────────
 * PNG ENCODER
 * ─────────────────────────────────────────────────────────────────────────── */

/** Precomputed CRC32 table. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds a PNG chunk: length, type, data, CRC. */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

/**
 * Encodes RGBA pixel data as a PNG.
 * @param {Uint8Array} pixels - `size * size * 4` bytes, RGBA.
 * @param {number} size - Image edge length.
 */
function encodePng(pixels, size) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR: width, height, bit depth 8, colour type 6 (RGBA), no interlace.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  /* Scanlines. Every row is prefixed with a filter-type byte; 0 means "no
   * filtering", which costs a little compression ratio and saves a great deal
   * of complexity for icons this small. */
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size * 4; x++) {
      raw[rowStart + 1 + x] = pixels[y * size * 4 + x];
    }
  }

  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ───────────────────────────────────────────────────────────────────────────
 * ICON ARTWORK
 * ─────────────────────────────────────────────────────────────────────────── */

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Draws the icon: a golden-hour sky, a low sun, a hill silhouette and a small
 * train.
 *
 * @param {number} size
 * @param {boolean} maskable - Adds the safe-zone padding maskable icons need.
 */
function drawIcon(size, maskable) {
  const pixels = new Uint8Array(size * size * 4);
  /* Maskable icons may be cropped to a circle inscribed in the middle 80%, so
   * all meaningful content has to sit inside that safe zone. */
  const inset = maskable ? size * 0.14 : 0;
  const contentSize = size - inset * 2;

  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    // Simple source-over blend.
    const alpha = a / 255;
    pixels[i] = Math.round(lerp(pixels[i], r, alpha));
    pixels[i + 1] = Math.round(lerp(pixels[i + 1], g, alpha));
    pixels[i + 2] = Math.round(lerp(pixels[i + 2], b, alpha));
    pixels[i + 3] = Math.max(pixels[i + 3], a);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x - inset) / contentSize;
      const v = (y - inset) / contentSize;

      // Background fill for maskable padding.
      if (u < 0 || u > 1 || v < 0 || v > 1) {
        set(x, y, 12, 17, 15, 255);
        continue;
      }

      /* Sky: a vertical gradient from deep blue at the top through amber at
       * the horizon — the golden-hour palette the whole game is built on. */
      let r, g, b;
      if (v < 0.62) {
        const t = v / 0.62;
        r = lerp(40, 255, Math.pow(t, 1.6));
        g = lerp(58, 168, Math.pow(t, 1.5));
        b = lerp(92, 88, Math.pow(t, 1.4));
      } else {
        // Ground.
        const t = (v - 0.62) / 0.38;
        r = lerp(58, 22, t);
        g = lerp(72, 34, t);
        b = lerp(38, 24, t);
      }

      // The sun, sitting just above the horizon.
      const sunX = 0.5;
      const sunY = 0.52;
      const sunR = 0.13;
      const d = Math.hypot(u - sunX, (v - sunY) * 1.0);
      if (d < sunR) {
        const core = 1 - smoothstep(sunR * 0.75, sunR, d);
        r = lerp(r, 255, core);
        g = lerp(g, 232, core);
        b = lerp(b, 176, core);
      } else if (d < sunR * 2.6) {
        // Glow.
        const glow = (1 - smoothstep(sunR, sunR * 2.6, d)) * 0.5;
        r = lerp(r, 255, glow);
        g = lerp(g, 190, glow);
        b = lerp(b, 110, glow);
      }

      /* Hill silhouettes — two overlapping sine ridges, the far one lighter to
       * suggest atmospheric haze. */
      const farRidge = 0.63 + Math.sin(u * Math.PI * 1.6 + 0.4) * 0.045;
      const nearRidge = 0.71 + Math.sin(u * Math.PI * 2.4 + 2.1) * 0.055;

      if (v > farRidge) {
        const shade = v > nearRidge ? 0 : 1;
        if (shade === 1) {
          r = lerp(r, 46, 0.85);
          g = lerp(g, 58, 0.85);
          b = lerp(b, 44, 0.85);
        } else {
          r = lerp(r, 24, 0.92);
          g = lerp(g, 34, 0.92);
          b = lerp(b, 26, 0.92);
        }
      }

      set(x, y, Math.round(r), Math.round(g), Math.round(b), 255);
    }
  }

  /* The train: a small dark silhouette crossing the near hill, with a warm
   * headlight. Drawn last so it sits on top of everything. */
  const trainY = Math.round(inset + contentSize * 0.735);
  const trainH = Math.max(2, Math.round(contentSize * 0.045));
  const trainStart = Math.round(inset + contentSize * 0.2);
  const trainEnd = Math.round(inset + contentSize * 0.62);

  for (let y = trainY - trainH; y < trainY; y++) {
    for (let x = trainStart; x < trainEnd; x++) {
      set(x, y, 16, 20, 18, 255);
    }
  }
  // Cab, slightly taller, at the leading end.
  const cabW = Math.round(contentSize * 0.075);
  for (let y = trainY - trainH * 1.9; y < trainY; y++) {
    for (let x = trainEnd - cabW; x < trainEnd; x++) {
      set(x, Math.round(y), 16, 20, 18, 255);
    }
  }
  // Funnel.
  const funnelX = trainEnd - Math.round(cabW * 0.45);
  for (let y = trainY - trainH * 2.7; y < trainY - trainH * 1.9; y++) {
    for (let x = funnelX; x < funnelX + Math.max(2, Math.round(contentSize * 0.016)); x++) {
      set(x, Math.round(y), 16, 20, 18, 255);
    }
  }
  // Headlight.
  const lightX = trainEnd + 1;
  const lightY = trainY - Math.round(trainH * 1.2);
  const lightR = Math.max(1, Math.round(contentSize * 0.014));
  for (let dy = -lightR * 2; dy <= lightR * 2; dy++) {
    for (let dx = -lightR * 2; dx <= lightR * 2; dx++) {
      const dist = Math.hypot(dx, dy);
      if (dist > lightR * 2) continue;
      const a = Math.round(255 * (1 - dist / (lightR * 2)));
      set(lightX + dx, lightY + dy, 255, 214, 140, a);
    }
  }

  return pixels;
}

/* ───────────────────────────────────────────────────────────────────────────
 * MAIN
 * ─────────────────────────────────────────────────────────────────────────── */

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { name: 'icon-192.png', size: 192, maskable: false },
  { name: 'icon-512.png', size: 512, maskable: false },
  { name: 'icon-maskable-192.png', size: 192, maskable: true },
  { name: 'icon-maskable-512.png', size: 512, maskable: true },
  { name: 'favicon-32.png', size: 32, maskable: false },
];

for (const target of targets) {
  const pixels = drawIcon(target.size, target.maskable);
  const png = encodePng(pixels, target.size);
  writeFileSync(join(OUT_DIR, target.name), png);
  console.log(`  ✓ ${target.name}  (${(png.length / 1024).toFixed(1)} KB)`);
}

console.log(`\nWrote ${targets.length} icons to public/icons/`);
