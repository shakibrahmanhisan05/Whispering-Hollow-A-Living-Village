/**
 * Firestore persistence: profiles, settings, progression, saved worlds and
 * screenshot metadata.
 *
 * Everything here degrades to a no-op when Firebase is unconfigured, and every
 * write is debounced — progression can change several times in a single frame
 * (unlock an achievement, grant its reward, grant its coins) and that must be
 * one document write, not four.
 *
 * @module lib/firestore
 */

'use client';

import { getFirestoreDb } from './firebase';
import { getUid } from './auth';
import type { PersistedSettings } from '@/store/settingsStore';
import type { ProgressState, ScreenshotEntry } from '@/store/gameStore';
import type { AvatarConfig } from '@/config/game';
import { AUTOSAVE_INTERVAL } from '@/config/game';

/** The shape of a `users/{uid}` document. */
export interface UserDocument {
  profile: {
    displayName: string;
    avatarConfig: AvatarConfig;
    createdAt: number;
    updatedAt: number;
    totalPlaytime: number;
  };
  achievements: Record<string, number>;
  achievementProgress: Record<string, number>;
  discoveries: Record<string, number>;
  coins: number;
  unlocked: ProgressState['unlocked'];
  seasonsSeen: string[];
  trainsSeen: number;
  hasSeenEnding: boolean;
  settings: PersistedSettings;
  savedWorlds: SavedWorld[];
}

export interface SavedWorld {
  id: string;
  seed: string;
  name: string;
  createdAt: number;
  lastPlayed: number;
  thumbnailUrl?: string;
}

/** Loads the signed-in user's document. Returns `null` if none or offline. */
export async function loadUserDocument(): Promise<Partial<UserDocument> | null> {
  const uid = getUid();
  const db = await getFirestoreDb();
  if (!uid || !db) return null;

  try {
    const { doc, getDoc } = await import('firebase/firestore');
    const snapshot = await getDoc(doc(db, 'users', uid));
    if (!snapshot.exists()) return null;
    return snapshot.data() as Partial<UserDocument>;
  } catch (err) {
    console.warn('[firestore] Failed to load user document.', err);
    return null;
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * DEBOUNCED WRITES
 *
 * Progress and settings are both written through a shared debouncer. A single
 * pending payload is merged so that, for example, unlocking three achievements
 * in one frame produces one `setDoc` with all three, not three round-trips.
 * ─────────────────────────────────────────────────────────────────────────── */

let pending: Record<string, unknown> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastFlush = 0;

/**
 * Queues a partial update to the user document.
 *
 * @param patch - Fields to merge. Nested objects replace wholesale, which is
 *   what we want for maps like `achievements`.
 * @param immediate - Skip the debounce (used on page unload).
 */
export function queueUserUpdate(patch: Record<string, unknown>, immediate = false): void {
  pending = { ...pending, ...patch };

  if (immediate) {
    void flushUserUpdate();
    return;
  }

  if (flushTimer) return;

  /* Flush at most once every AUTOSAVE_INTERVAL seconds, but never leave a
   * change unwritten for longer than that. Firestore charges per write, and a
   * long session that saves every two seconds is both slow and expensive. */
  const sinceLast = Date.now() - lastFlush;
  const delay = Math.max(1500, AUTOSAVE_INTERVAL * 1000 - sinceLast);

  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushUserUpdate();
  }, delay);
}

/** Writes any queued changes immediately. */
export async function flushUserUpdate(): Promise<void> {
  if (Object.keys(pending).length === 0) return;

  const uid = getUid();
  const db = await getFirestoreDb();
  if (!uid || !db) {
    pending = {};
    return;
  }

  const payload = pending;
  pending = {};
  lastFlush = Date.now();

  try {
    const { doc, setDoc, serverTimestamp } = await import('firebase/firestore');
    await setDoc(
      doc(db, 'users', uid),
      { ...payload, 'profile.updatedAt': Date.now(), _serverUpdatedAt: serverTimestamp() },
      // `merge: true` is essential — a plain setDoc would wipe every field we
      // didn't happen to include in this particular patch.
      { merge: true },
    );
  } catch (err) {
    console.warn('[firestore] Write failed; changes remain local.', err);
    // Put the payload back so the next flush retries it.
    pending = { ...payload, ...pending };
  }
}

/** Saves the player's settings. */
export function saveSettings(settings: PersistedSettings): void {
  queueUserUpdate({ settings });
}

/** Saves progression. */
export function saveProgress(progress: ProgressState, displayName: string): void {
  queueUserUpdate({
    achievements: progress.achievements,
    achievementProgress: progress.achievementProgress,
    discoveries: progress.discoveries,
    coins: progress.coins,
    unlocked: progress.unlocked,
    seasonsSeen: progress.seasonsSeen,
    trainsSeen: progress.trainsSeen,
    hasSeenEnding: progress.hasSeenEnding,
    profile: {
      displayName,
      totalPlaytime: progress.totalPlaytime,
      updatedAt: Date.now(),
    },
  });
}

/** Saves the avatar configuration. */
export function saveAvatar(avatar: AvatarConfig): void {
  queueUserUpdate({ 'profile.avatarConfig': avatar });
}

/* ───────────────────────────────────────────────────────────────────────────
 * SAVED WORLDS
 * ─────────────────────────────────────────────────────────────────────────── */

/** Persists the player's list of saved worlds. */
export async function saveWorldList(worlds: SavedWorld[]): Promise<void> {
  queueUserUpdate({ savedWorlds: worlds }, true);
}

/* ───────────────────────────────────────────────────────────────────────────
 * SCREENSHOTS
 * ─────────────────────────────────────────────────────────────────────────── */

/** Writes screenshot metadata to the public `screenshots` collection. */
export async function saveScreenshotMetadata(entry: ScreenshotEntry): Promise<string | null> {
  const uid = getUid();
  const db = await getFirestoreDb();
  if (!uid || !db) return null;

  try {
    const { collection, addDoc, serverTimestamp } = await import('firebase/firestore');
    const ref = await addDoc(collection(db, 'screenshots'), {
      ownerUid: uid,
      worldSeed: entry.worldSeed,
      storagePath: entry.storagePath ?? null,
      publicUrl: entry.url,
      capturedAt: entry.capturedAt,
      createdAt: serverTimestamp(),
      timeOfDay: entry.timeOfDay,
      season: entry.season,
      weather: entry.weather,
      isPublic: entry.isPublic,
      likes: 0,
    });
    return ref.id;
  } catch (err) {
    console.warn('[firestore] Failed to save screenshot metadata.', err);
    return null;
  }
}

/** Updates a screenshot's public/private flag. */
export async function setScreenshotPublic(remoteId: string, isPublic: boolean): Promise<void> {
  const db = await getFirestoreDb();
  if (!db) return;
  try {
    const { doc, updateDoc } = await import('firebase/firestore');
    await updateDoc(doc(db, 'screenshots', remoteId), { isPublic });
  } catch (err) {
    console.warn('[firestore] Failed to update screenshot visibility.', err);
  }
}

/** Deletes a screenshot's metadata document. */
export async function deleteScreenshotMetadata(remoteId: string): Promise<void> {
  const db = await getFirestoreDb();
  if (!db) return;
  try {
    const { doc, deleteDoc } = await import('firebase/firestore');
    await deleteDoc(doc(db, 'screenshots', remoteId));
  } catch (err) {
    console.warn('[firestore] Failed to delete screenshot metadata.', err);
  }
}

/** Loads the signed-in user's screenshots, newest first. */
export async function loadUserScreenshots(max = 60): Promise<ScreenshotEntry[]> {
  const uid = getUid();
  const db = await getFirestoreDb();
  if (!uid || !db) return [];

  try {
    const { collection, query, where, orderBy, limit, getDocs } = await import(
      'firebase/firestore'
    );
    const q = query(
      collection(db, 'screenshots'),
      where('ownerUid', '==', uid),
      orderBy('capturedAt', 'desc'),
      limit(max),
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        remoteId: d.id,
        url: data.publicUrl as string,
        storagePath: data.storagePath as string | undefined,
        capturedAt: data.capturedAt as number,
        worldSeed: data.worldSeed as string,
        timeOfDay: data.timeOfDay as number,
        season: data.season,
        weather: data.weather,
        isPublic: Boolean(data.isPublic),
      } as ScreenshotEntry;
    });
  } catch (err) {
    // A missing composite index is the most likely cause here, and the error
    // message from Firestore contains a direct link to create it.
    console.warn('[firestore] Failed to load screenshots.', err);
    return [];
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * WORLD INSTANCES (multiplayer)
 * ─────────────────────────────────────────────────────────────────────────── */

export interface WorldInstance {
  id: string;
  seed: string;
  hostUid: string;
  weather: string;
  timeOfDay: number;
  season: string;
  playerCount: number;
  isPublic: boolean;
  createdAt: number;
}

/** Registers a public world so other players can find and join it. */
export async function publishWorld(
  world: Omit<WorldInstance, 'id' | 'createdAt'>,
): Promise<string | null> {
  const db = await getFirestoreDb();
  if (!db) return null;
  try {
    const { collection, addDoc, serverTimestamp } = await import('firebase/firestore');
    const ref = await addDoc(collection(db, 'worlds'), {
      ...world,
      createdAt: Date.now(),
      _serverCreatedAt: serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    console.warn('[firestore] Failed to publish world.', err);
    return null;
  }
}

/** Lists joinable public worlds. */
export async function listPublicWorlds(max = 20): Promise<WorldInstance[]> {
  const db = await getFirestoreDb();
  if (!db) return [];
  try {
    const { collection, query, where, orderBy, limit, getDocs } = await import(
      'firebase/firestore'
    );
    const q = query(
      collection(db, 'worlds'),
      where('isPublic', '==', true),
      orderBy('createdAt', 'desc'),
      limit(max),
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<WorldInstance, 'id'>) }));
  } catch (err) {
    console.warn('[firestore] Failed to list worlds.', err);
    return [];
  }
}

/** Flushes pending writes on page unload, so nothing is lost on a hard close. */
export function installUnloadFlush(): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = () => {
    void flushUserUpdate();
  };
  /* `pagehide` is more reliable than `beforeunload` on mobile Safari, where
   * `beforeunload` frequently never fires at all. */
  window.addEventListener('pagehide', handler);
  window.addEventListener('beforeunload', handler);
  return () => {
    window.removeEventListener('pagehide', handler);
    window.removeEventListener('beforeunload', handler);
  };
}
