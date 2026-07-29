/**
 * Firebase initialisation.
 *
 * ## The central design decision: Firebase is optional
 *
 * The game must run perfectly with **no Firebase project at all**. Someone who
 * clones the repo and runs `npm run dev` gets a complete, playable game that
 * saves to `localStorage`; adding credentials later upgrades that to cloud sync
 * and multiplayer without changing any code.
 *
 * Every export here therefore returns `null` when unconfigured, and every
 * consumer is written to handle that. This is not defensive programming for its
 * own sake — it is what makes the project actually shippable to someone else.
 *
 * Services are also **lazily initialised**. The Firebase SDK is roughly 200 KB
 * gzipped across auth + firestore + database + storage; loading it on the menu
 * screen would dominate the initial bundle for a feature most players never
 * touch. Each `get*` function dynamically imports its own module on first use.
 *
 * @module lib/firebase
 */

import type { FirebaseApp } from 'firebase/app';
import type { Auth } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import type { Database } from 'firebase/database';
import type { FirebaseStorage } from 'firebase/storage';

/** The client config, read from `NEXT_PUBLIC_*` environment variables. */
const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

/**
 * Whether Firebase is configured well enough to initialise.
 *
 * Requires the three fields with no sensible default. Everything else can be
 * absent and only disables the corresponding service.
 */
export const isFirebaseConfigured: boolean = Boolean(
  config.apiKey && config.projectId && config.appId,
);

/** Whether the Realtime Database (and therefore multiplayer) is available. */
export const isRealtimeDbConfigured: boolean = Boolean(
  isFirebaseConfigured && config.databaseURL,
);

/** Whether Cloud Storage (and therefore screenshot upload) is available. */
export const isStorageConfigured: boolean = Boolean(
  isFirebaseConfigured && config.storageBucket,
);

/** Whether multiplayer is switched on, both by config and by feature flag. */
export const isMultiplayerEnabled: boolean =
  isRealtimeDbConfigured && process.env.NEXT_PUBLIC_ENABLE_MULTIPLAYER === 'true';

let appPromise: Promise<FirebaseApp | null> | null = null;

/**
 * Returns the Firebase app, initialising it on first call.
 * Returns `null` when unconfigured.
 */
export async function getFirebaseApp(): Promise<FirebaseApp | null> {
  if (!isFirebaseConfigured) return null;
  if (typeof window === 'undefined') return null;

  if (!appPromise) {
    appPromise = (async () => {
      try {
        const { initializeApp, getApps, getApp } = await import('firebase/app');
        // Re-use an existing app across HMR reloads rather than throwing.
        const app = getApps().length > 0 ? getApp() : initializeApp(config);
        await initAppCheck(app);
        return app;
      } catch (err) {
        console.warn('[firebase] Initialisation failed; running offline.', err);
        return null;
      }
    })();
  }
  return appPromise;
}

/**
 * Initialises App Check with reCAPTCHA v3, if a site key is configured.
 *
 * App Check attests that requests come from your genuine app rather than a
 * script hitting the API directly. Without it, a public Firestore rule that
 * allows anonymous writes is an open invitation.
 */
async function initAppCheck(app: FirebaseApp): Promise<void> {
  const siteKey = process.env.NEXT_PUBLIC_FIREBASE_APPCHECK_SITE_KEY;
  if (!siteKey) return;

  try {
    const { initializeAppCheck, ReCaptchaV3Provider } = await import('firebase/app-check');

    /* In development, App Check needs a debug token or every request is
     * rejected. Setting this global makes the SDK print one to the console,
     * which you then register in the Firebase console. */
    if (process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_APPCHECK_DEBUG_TOKEN) {
      (
        window as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean }
      ).FIREBASE_APPCHECK_DEBUG_TOKEN = process.env.NEXT_PUBLIC_APPCHECK_DEBUG_TOKEN;
    }

    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (err) {
    console.warn('[firebase] App Check setup failed; continuing without it.', err);
  }
}

let authPromise: Promise<Auth | null> | null = null;

/** Returns the Auth instance, or `null` when unconfigured. */
export async function getFirebaseAuth(): Promise<Auth | null> {
  if (!authPromise) {
    authPromise = (async () => {
      const app = await getFirebaseApp();
      if (!app) return null;
      try {
        const { getAuth } = await import('firebase/auth');
        return getAuth(app);
      } catch (err) {
        console.warn('[firebase] Auth unavailable.', err);
        return null;
      }
    })();
  }
  return authPromise;
}

let firestorePromise: Promise<Firestore | null> | null = null;

/** Returns Firestore, or `null` when unconfigured. */
export async function getFirestoreDb(): Promise<Firestore | null> {
  if (!firestorePromise) {
    firestorePromise = (async () => {
      const app = await getFirebaseApp();
      if (!app) return null;
      try {
        const { getFirestore } = await import('firebase/firestore');
        return getFirestore(app);
      } catch (err) {
        console.warn('[firebase] Firestore unavailable.', err);
        return null;
      }
    })();
  }
  return firestorePromise;
}

let databasePromise: Promise<Database | null> | null = null;

/** Returns the Realtime Database, or `null` when unconfigured. */
export async function getRealtimeDb(): Promise<Database | null> {
  if (!isRealtimeDbConfigured) return null;
  if (!databasePromise) {
    databasePromise = (async () => {
      const app = await getFirebaseApp();
      if (!app) return null;
      try {
        const { getDatabase } = await import('firebase/database');
        return getDatabase(app);
      } catch (err) {
        console.warn('[firebase] Realtime Database unavailable.', err);
        return null;
      }
    })();
  }
  return databasePromise;
}

let storagePromise: Promise<FirebaseStorage | null> | null = null;

/** Returns Cloud Storage, or `null` when unconfigured. */
export async function getFirebaseStorage(): Promise<FirebaseStorage | null> {
  if (!isStorageConfigured) return null;
  if (!storagePromise) {
    storagePromise = (async () => {
      const app = await getFirebaseApp();
      if (!app) return null;
      try {
        const { getStorage } = await import('firebase/storage');
        return getStorage(app);
      } catch (err) {
        console.warn('[firebase] Storage unavailable.', err);
        return null;
      }
    })();
  }
  return storagePromise;
}
