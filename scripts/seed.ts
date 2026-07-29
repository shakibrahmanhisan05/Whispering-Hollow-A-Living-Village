/**
 * Seeds reference data into Firestore.
 *
 * Writes achievement definitions, lore fragments, bird species and viewpoints
 * into a read-only `gameData` collection. The game does not *need* this — it
 * reads all of it from `lib/progression/content.ts` at build time — but having
 * it in Firestore means you can query progression from the console, build an
 * admin dashboard, or run analytics on which discoveries people actually find,
 * without shipping a new build.
 *
 * ## Usage
 *
 * ```bash
 * # Point at a service account key…
 * export GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json
 * # …or paste the JSON inline (useful in CI):
 * export FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
 *
 * npm run seed
 * ```
 *
 * Get a key from: Firebase console → Project settings → Service accounts →
 * Generate new private key. **Never commit it** — it is already in .gitignore.
 *
 * @module scripts/seed
 */

import { readFileSync } from 'node:fs';
import { cert, initializeApp, type ServiceAccount } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

import {
  ACHIEVEMENTS,
  JOURNAL_FRAGMENTS,
  BIRD_SPECIES,
  VIEWPOINTS,
  SIGNPOSTS,
  DISCOVERIES,
} from '../lib/progression/content';

/** Resolves service-account credentials from either supported source. */
function loadCredentials(): ServiceAccount {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (inline) {
    try {
      return JSON.parse(inline) as ServiceAccount;
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is set but is not valid JSON.');
    }
  }

  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!path) {
    throw new Error(
      'No credentials found.\n' +
        '  Set GOOGLE_APPLICATION_CREDENTIALS to the path of your service account key,\n' +
        '  or FIREBASE_SERVICE_ACCOUNT_JSON to the key JSON itself.\n\n' +
        '  Firebase console → Project settings → Service accounts → Generate new private key',
    );
  }

  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ServiceAccount;
  } catch (err) {
    throw new Error(`Could not read the service account key at "${path}": ${String(err)}`);
  }
}

/**
 * Writes a collection in batches.
 *
 * Firestore caps a write batch at 500 operations. Chunking here means the
 * script scales to a much larger content set without anyone having to remember
 * that limit.
 */
async function seedCollection(
  db: Firestore,
  collectionPath: string,
  documents: Array<{ id: string; data: Record<string, unknown> }>,
): Promise<void> {
  const CHUNK = 400;

  for (let i = 0; i < documents.length; i += CHUNK) {
    const batch = db.batch();
    for (const doc of documents.slice(i, i + CHUNK)) {
      batch.set(db.collection(collectionPath).doc(doc.id), doc.data, { merge: true });
    }
    await batch.commit();
  }

  console.log(`  ✓ ${collectionPath.padEnd(28)} ${documents.length} documents`);
}

async function main(): Promise<void> {
  console.log('\n🌄  Whispering Hollow — seeding reference data\n');

  const credentials = loadCredentials();
  initializeApp({ credential: cert(credentials) });
  const db = getFirestore();

  await seedCollection(
    db,
    'gameData/definitions/achievements',
    ACHIEVEMENTS.map((a) => ({
      id: a.id,
      data: {
        name: a.name,
        description: a.description,
        secret: a.secret ?? false,
        target: a.target,
        reward: a.reward,
      },
    })),
  );

  await seedCollection(
    db,
    'gameData/definitions/journal',
    JOURNAL_FRAGMENTS.map((f) => ({
      id: f.id,
      data: {
        order: f.order,
        title: f.title,
        body: f.body,
        hint: f.hint,
        position: { x: f.position[0], z: f.position[1] },
      },
    })),
  );

  await seedCollection(
    db,
    'gameData/definitions/birds',
    BIRD_SPECIES.map((b) => ({
      id: b.id,
      data: {
        name: b.name,
        latin: b.latin,
        description: b.description,
        voice: b.voice,
        activeFrom: b.active[0],
        activeTo: b.active[1],
        zones: b.zones,
        colors: b.colors,
        approachDistance: b.approachDistance,
      },
    })),
  );

  await seedCollection(
    db,
    'gameData/definitions/viewpoints',
    VIEWPOINTS.map((v) => ({
      id: v.id,
      data: {
        name: v.name,
        description: v.description,
        position: { x: v.position[0], z: v.position[1] },
        yaw: v.yaw,
        radius: v.radius,
      },
    })),
  );

  await seedCollection(
    db,
    'gameData/definitions/signposts',
    SIGNPOSTS.map((s) => ({
      id: s.id,
      data: {
        sign: s.sign,
        note: s.note,
        position: { x: s.position[0], z: s.position[1] },
        yaw: s.yaw,
      },
    })),
  );

  // A manifest so a dashboard can enumerate everything without five queries.
  await db.doc('gameData/manifest').set(
    {
      totalAchievements: ACHIEVEMENTS.length,
      totalDiscoveries: DISCOVERIES.length,
      totalJournalPages: JOURNAL_FRAGMENTS.length,
      totalBirdSpecies: BIRD_SPECIES.length,
      totalViewpoints: VIEWPOINTS.length,
      totalSignposts: SIGNPOSTS.length,
      seededAt: new Date().toISOString(),
      version: 1,
    },
    { merge: true },
  );
  console.log(`  ✓ ${'gameData/manifest'.padEnd(28)} 1 document`);

  console.log('\n✅  Done.\n');
}

main().catch((err) => {
  console.error('\n❌  Seeding failed:\n');
  console.error(err instanceof Error ? err.message : err);
  console.error('');
  process.exit(1);
});
