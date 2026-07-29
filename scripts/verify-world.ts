/**
 * Headless world-generation self-test.
 *
 * Runs the terrain pipeline, the layout carving and the procedural geometry
 * builders outside the browser and asserts that the results are sane. Useful
 * after changing anything in `config/game.ts` — a bad tuning constant usually
 * shows up here as a NaN or an out-of-range height long before it shows up as
 * a visual glitch.
 *
 * Run with: npm run verify
 *
 * @module scripts/verify-world
 */

import {
  createHeightfieldContext,
  rasterizeHeightmap,
  sampleTerrain,
} from '../lib/terrain/heightfield';
import { getLayoutSnapshot, RAIL_QUERY, POND, RIDGE, railHeightAt } from '../lib/world/layout';
import { buildTree, TREE_SPECIES } from '../lib/geometry/trees';
import { createRng, blueNoise, RandomSource } from '../lib/utils/random';
import { WORLD, TERRAIN_NOISE, ZONES, VEGETATION } from '../config/game';

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail = ''): void {
  checks++;
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
  console.log('─'.repeat(title.length));
}

const SEED = 'whispering-hollow';

/* ═══════════════════════════════════════════════════════════════════════════
 * TERRAIN
 * ═══════════════════════════════════════════════════════════════════════════ */

section('Terrain generation');

const snap = getLayoutSnapshot();
const ctx = createHeightfieldContext(SEED, {
  rail: snap.railPolyline,
  brook: snap.brookPolyline,
  road: snap.roadPolyline,
});

const RES = 192;
const t0 = Date.now();
const heights = rasterizeHeightmap(ctx, RES);
const rasterMs = Date.now() - t0;

let min = Infinity;
let max = -Infinity;
let nans = 0;
for (let i = 0; i < heights.length; i++) {
  const h = heights[i]!;
  if (!Number.isFinite(h)) nans++;
  if (h < min) min = h;
  if (h > max) max = h;
}

check('heightmap contains no NaN or Infinity', nans === 0, `${nans} bad samples`);
check(
  'heights fall in a plausible range',
  min > -40 && max < WORLD.HEIGHT_SCALE * 3.5,
  `min=${min.toFixed(2)} max=${max.toFixed(2)}`,
);
check('terrain has real relief', max - min > WORLD.HEIGHT_SCALE * 0.5, `range=${(max - min).toFixed(2)}`);
console.log(`    (${RES}² raster in ${rasterMs} ms)`);

/* ── Determinism ─────────────────────────────────────────────────────────── */
const ctx2 = createHeightfieldContext(SEED, {
  rail: snap.railPolyline,
  brook: snap.brookPolyline,
  road: snap.roadPolyline,
});
const sampleA = sampleTerrain(ctx, 37.5, -62.25);
const sampleB = sampleTerrain(ctx2, 37.5, -62.25);
check('same seed produces identical terrain', Math.abs(sampleA - sampleB) < 1e-9);

const ctxOther = createHeightfieldContext('a-different-valley', {
  rail: snap.railPolyline,
  brook: snap.brookPolyline,
  road: snap.roadPolyline,
});
check(
  'different seed produces different terrain',
  Math.abs(sampleTerrain(ctxOther, 37.5, -62.25) - sampleA) > 0.05,
);

/* ═══════════════════════════════════════════════════════════════════════════
 * LAYOUT CARVING
 * ═══════════════════════════════════════════════════════════════════════════ */

section('Layout carving');

/* The village plaza must actually be flat, or the houses sit on a hillside. */
let plazaMin = Infinity;
let plazaMax = -Infinity;
for (let a = 0; a < 24; a++) {
  for (let r = 0; r <= 12; r += 4) {
    const angle = (a / 24) * Math.PI * 2;
    const h = sampleTerrain(ctx, Math.cos(angle) * r, Math.sin(angle) * r);
    plazaMin = Math.min(plazaMin, h);
    plazaMax = Math.max(plazaMax, h);
  }
}
check(
  'village plaza is flat enough to build on',
  plazaMax - plazaMin < 2.5,
  `variation=${(plazaMax - plazaMin).toFixed(2)}m`,
);
check(
  'plaza sits near the intended height',
  Math.abs((plazaMin + plazaMax) / 2 - TERRAIN_NOISE.VILLAGE_FLATTEN_HEIGHT) < 3,
  `got ${((plazaMin + plazaMax) / 2).toFixed(2)}, want ~${TERRAIN_NOISE.VILLAGE_FLATTEN_HEIGHT}`,
);

/* The railway must sit on its engineered grade, not follow the hills. */
let maxRailError = 0;
for (let i = 0; i <= 20; i++) {
  const along = (i / 20) * RAIL_QUERY.totalLength;
  const p = RAIL_QUERY.pointAtLength(along);
  if (Math.abs(p[0]) > WORLD.HALF - 5 || Math.abs(p[2]) > WORLD.HALF - 5) continue;
  const terrainHere = sampleTerrain(ctx, p[0], p[2]);
  const wantedGrade = railHeightAt(p[0]) - 0.55;
  maxRailError = Math.max(maxRailError, Math.abs(terrainHere - wantedGrade));
}
check(
  'railway formation follows the engineered grade',
  maxRailError < 2.0,
  `worst deviation ${maxRailError.toFixed(2)}m`,
);

/* The pond basin must be below the water line or the pond renders on dry land. */
const pondCentreHeight = sampleTerrain(ctx, POND.center[0], POND.center[1]);
check(
  'pond basin is carved below the water level',
  pondCentreHeight < WORLD.WATER_LEVEL,
  `basin=${pondCentreHeight.toFixed(2)} water=${WORLD.WATER_LEVEL}`,
);

/* The ridge must genuinely be the high point, or the viewpoint views nothing. */
const ridgeHeight = sampleTerrain(ctx, RIDGE.center[0], RIDGE.center[1]);
check(
  'the ridge is meaningfully elevated',
  ridgeHeight > TERRAIN_NOISE.VILLAGE_FLATTEN_HEIGHT + 18,
  `ridge=${ridgeHeight.toFixed(2)}m vs plaza ${TERRAIN_NOISE.VILLAGE_FLATTEN_HEIGHT}m`,
);

/* ═══════════════════════════════════════════════════════════════════════════
 * VEGETATION PLACEMENT
 * ═══════════════════════════════════════════════════════════════════════════ */

section('Vegetation placement');

const rng = new RandomSource(SEED, 'tree-placement');
const margin = WORLD.HALF - 14;
const points = blueNoise(
  rng.next,
  VEGETATION.TREE_COUNT,
  VEGETATION.MIN_TREE_SPACING,
  [-margin, -margin, margin, margin],
  (x, z) => {
    const h = sampleTerrain(ctx, x, z);
    if (h < WORLD.WATER_LEVEL + 0.8) return false;
    if (Math.hypot(x, z) < 20) return false;
    if (RAIL_QUERY.nearest(x, z).distance < 11) return false;
    return true;
  },
  30,
);

check(
  'blue-noise placement yields a usable number of trees',
  points.length > VEGETATION.TREE_COUNT * 0.5,
  `placed ${points.length} of ${VEGETATION.TREE_COUNT}`,
);

/* The whole point of blue noise is minimum spacing. Verify it actually holds. */
let minSpacing = Infinity;
for (let i = 0; i < points.length; i++) {
  for (let j = i + 1; j < points.length; j++) {
    const d = Math.hypot(points[i]![0] - points[j]![0], points[i]![1] - points[j]![1]);
    if (d < minSpacing) minSpacing = d;
  }
}
check(
  'no two trees are closer than the minimum spacing',
  minSpacing >= VEGETATION.MIN_TREE_SPACING - 1e-6,
  `closest pair ${minSpacing.toFixed(2)}m, limit ${VEGETATION.MIN_TREE_SPACING}m`,
);

let tooCloseToRail = 0;
for (const [x, z] of points) {
  if (RAIL_QUERY.nearest(x, z).distance < 11) tooCloseToRail++;
}
check('no trees obstruct the railway corridor', tooCloseToRail === 0, `${tooCloseToRail} offenders`);

/* ═══════════════════════════════════════════════════════════════════════════
 * PROCEDURAL GEOMETRY
 * ═══════════════════════════════════════════════════════════════════════════ */

section('Procedural geometry');

let totalTris = 0;
for (const species of TREE_SPECIES) {
  const tree = buildTree(species, 0, 'high', SEED);
  const trunkVerts = tree.trunk.attributes.position!.count;
  const foliageVerts = tree.foliage?.attributes.position?.count ?? 0;
  const tris = (trunkVerts + foliageVerts) / 3;
  totalTris += tris;

  const positions = tree.trunk.attributes.position!.array as Float32Array;
  let bad = 0;
  for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i]!)) bad++;

  check(
    `${species.padEnd(9)} geometry is finite and non-empty`,
    bad === 0 && trunkVerts > 0,
    bad > 0 ? `${bad} non-finite coords` : 'no vertices',
  );

  check(
    `${species.padEnd(9)} carries wind weights`,
    tree.trunk.attributes.aWindWeight !== undefined,
  );

  tree.trunk.dispose();
  tree.foliage?.dispose();
}
console.log(`    (~${Math.round(totalTris).toLocaleString()} triangles across all six species at high LOD)`);

/* ═══════════════════════════════════════════════════════════════════════════
 * PRNG
 * ═══════════════════════════════════════════════════════════════════════════ */

section('Determinism');

const a = createRng('test', 'salt');
const b = createRng('test', 'salt');
const c = createRng('test', 'different-salt');
check(
  'identical seed + salt produce identical streams',
  a() === b() && a() === b() && a() === b(),
);
check('different salts produce different streams', createRng('test', 'salt')() !== c());

/* A quick distribution sanity check — a broken PRNG usually shows up as a mean
 * far from 0.5 or as obvious banding. */
const rngDist = createRng('distribution', 'check');
let sum = 0;
const N = 100_000;
const buckets = new Array(10).fill(0);
for (let i = 0; i < N; i++) {
  const v = rngDist();
  sum += v;
  buckets[Math.min(9, Math.floor(v * 10))]++;
}
const mean = sum / N;
const maxBucketDeviation = Math.max(...buckets.map((n) => Math.abs(n / N - 0.1)));
check('PRNG mean is ~0.5', Math.abs(mean - 0.5) < 0.01, `mean=${mean.toFixed(4)}`);
check(
  'PRNG is uniformly distributed',
  maxBucketDeviation < 0.01,
  `worst decile deviation ${(maxBucketDeviation * 100).toFixed(2)}%`,
);

/* ═══════════════════════════════════════════════════════════════════════════ */

console.log(`\n${'═'.repeat(48)}`);
if (failures === 0) {
  console.log(`✅  All ${checks} checks passed.\n`);
  process.exit(0);
} else {
  console.log(`❌  ${failures} of ${checks} checks failed.\n`);
  process.exit(1);
}
