/**
 * Multiplayer presence, over Firebase Realtime Database.
 *
 * ## Why Realtime Database and not Firestore
 *
 * Firestore is a document store optimised for queries and durability. Presence
 * is the opposite workload: tiny, extremely frequent, entirely disposable
 * writes. Realtime Database is the right tool for two specific reasons:
 *
 * 1. **`onDisconnect()`.** The server registers a delete operation *at
 *    connection time* and executes it when the socket drops — including on a
 *    crash, a closed laptop, or a lost connection. Firestore has no equivalent,
 *    so ghosts would linger until a timeout swept them up.
 * 2. **Cost and latency.** A 10 Hz position write per player is 36 000 writes
 *    per player-hour. That is unremarkable for RTDB and financially ruinous on
 *    Firestore.
 *
 * ## Bandwidth
 *
 * Positions are throttled to 10 Hz *and* gated on movement — a player standing
 * still sends nothing at all. Remote positions are interpolated client-side,
 * so 10 Hz looks identical to 60 at walking speed.
 *
 * @module lib/rtdb
 */

'use client';

import { getRealtimeDb, isMultiplayerEnabled } from './firebase';
import { getUid, getDisplayName } from './auth';
import { usePresenceStore, type RemotePlayer } from '@/store/presenceStore';
import { MULTIPLAYER, type EmoteId } from '@/config/game';

/** Handles for an active presence session. */
interface PresenceSession {
  worldId: string;
  detach: () => void;
}

let session: PresenceSession | null = null;
let lastSent = { x: 0, y: 0, z: 0, rotY: 0, time: 0 };

/**
 * Joins a world's presence channel.
 *
 * @param worldId - The shared world instance ID.
 * @param avatarColor - This player's ghost tint.
 * @returns A leave function, or `null` when multiplayer is unavailable.
 */
export async function joinPresence(
  worldId: string,
  avatarColor: string,
): Promise<(() => void) | null> {
  if (!isMultiplayerEnabled) return null;

  const uid = getUid();
  const db = await getRealtimeDb();
  if (!uid || !db) return null;

  const store = usePresenceStore.getState();
  store.setConnected(false);
  store.setError(null);

  try {
    const { ref, onValue, onDisconnect, set, remove, serverTimestamp } =
      await import('firebase/database');

    const playersRef = ref(db, `worldPresence/${worldId}/players`);
    const meRef = ref(db, `worldPresence/${worldId}/players/${uid}`);

    /* Register the cleanup with the *server* before writing anything. If the
     * client dies between these two operations, there is nothing to clean up;
     * if we wrote first and the client died before registering, the ghost
     * would be permanent. Order matters. */
    await onDisconnect(meRef).remove();

    await set(meRef, {
      displayName: getDisplayName(),
      x: 0,
      y: 0,
      z: 0,
      rotY: 0,
      emote: null,
      emoteAt: 0,
      avatarColor,
      lantern: false,
      lastSeen: serverTimestamp(),
    });

    /* Subscribe to the whole player list. With a hard cap of eight players the
     * payload is trivial, and a single listener is far simpler than managing
     * per-child subscriptions. */
    const unsubscribe = onValue(
      playersRef,
      (snapshot) => {
        const value = (snapshot.val() ?? {}) as Record<string, Record<string, unknown>>;
        const players: Record<string, RemotePlayer> = {};
        const now = Date.now();

        for (const [otherUid, data] of Object.entries(value)) {
          // Never render yourself as a ghost.
          if (otherUid === uid) continue;

          const lastSeen = typeof data.lastSeen === 'number' ? data.lastSeen : now;
          // Belt and braces: skip anything onDisconnect somehow missed.
          if (now - lastSeen > MULTIPLAYER.STALE_AFTER * 1000) continue;

          players[otherUid] = {
            uid: otherUid,
            displayName: String(data.displayName ?? 'Wanderer'),
            x: Number(data.x ?? 0),
            y: Number(data.y ?? 0),
            z: Number(data.z ?? 0),
            rotY: Number(data.rotY ?? 0),
            emote: (data.emote as EmoteId | null) ?? null,
            emoteAt: Number(data.emoteAt ?? 0),
            avatarColor: String(data.avatarColor ?? '#8fd0ff'),
            lantern: Boolean(data.lantern),
            lastSeen,
          };
        }

        usePresenceStore.getState().replaceAll(players);
        usePresenceStore.getState().setConnected(true);
      },
      (err) => {
        console.warn('[rtdb] Presence subscription failed.', err);
        usePresenceStore.getState().setError(err.message);
        usePresenceStore.getState().setConnected(false);
      },
    );

    const leave = () => {
      unsubscribe();
      void remove(meRef).catch(() => {
        /* Already gone, or offline. onDisconnect will handle it. */
      });
      usePresenceStore.getState().reset();
      session = null;
    };

    session = { worldId, detach: leave };
    usePresenceStore.getState().setWorld(worldId, uid);
    return leave;
  } catch (err) {
    console.warn('[rtdb] Could not join presence.', err);
    usePresenceStore.getState().setError((err as Error).message);
    return null;
  }
}

/**
 * Broadcasts the local player's transform.
 *
 * Rate-limited to {@link MULTIPLAYER.SYNC_HZ} and gated on actual movement, so
 * a player admiring the view generates no traffic at all.
 */
export async function broadcastTransform(
  x: number,
  y: number,
  z: number,
  rotY: number,
  lantern: boolean,
): Promise<void> {
  if (!session) return;
  const uid = getUid();
  if (!uid) return;

  const now = performance.now();
  const interval = 1000 / MULTIPLAYER.SYNC_HZ;
  if (now - lastSent.time < interval) return;

  const moved =
    Math.abs(x - lastSent.x) +
      Math.abs(y - lastSent.y) +
      Math.abs(z - lastSent.z) >
      MULTIPLAYER.SYNC_MIN_DELTA || Math.abs(rotY - lastSent.rotY) > 0.05;

  if (!moved) return;

  lastSent = { x, y, z, rotY, time: now };

  try {
    const db = await getRealtimeDb();
    if (!db) return;
    const { ref, update, serverTimestamp } = await import('firebase/database');
    await update(ref(db, `worldPresence/${session.worldId}/players/${uid}`), {
      x: round(x),
      y: round(y),
      z: round(z),
      rotY: round(rotY, 3),
      lantern,
      lastSeen: serverTimestamp(),
    });
  } catch {
    /* Transient network failure. The next tick will retry; presence is
     * disposable by design and there is nothing worth surfacing to the user. */
  }
}

/** Broadcasts an emote to everyone in the world. */
export async function broadcastEmote(emote: EmoteId | null): Promise<void> {
  if (!session) return;
  const uid = getUid();
  if (!uid) return;
  try {
    const db = await getRealtimeDb();
    if (!db) return;
    const { ref, update } = await import('firebase/database');
    await update(ref(db, `worldPresence/${session.worldId}/players/${uid}`), {
      emote,
      emoteAt: Date.now(),
    });
  } catch {
    /* Non-critical. */
  }
}

/** Leaves the current presence channel, if any. */
export function leavePresence(): void {
  session?.detach();
  session = null;
}

/** Whether a presence session is currently active. */
export function isPresenceActive(): boolean {
  return session !== null;
}

/** Rounds to a fixed precision to keep payloads small. */
function round(value: number, decimals = 2): number {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

/**
 * Averages the time-of-day across everyone in the world.
 *
 * The spec calls for a "democratically averaged" clock. Doing it naively would
 * fight: each client would pull toward the average, changing the average,
 * forever. Instead each client nudges its own clock a small fraction toward the
 * mean each second, which converges smoothly and settles.
 *
 * Note this must use circular averaging — time-of-day wraps, so the mean of
 * 0.99 and 0.01 is midnight, not midday.
 */
export function averageTimeOfDay(local: number, remotes: number[]): number {
  if (remotes.length === 0) return local;

  // Circular mean: average the unit vectors, then take the angle back.
  let sinSum = Math.sin(local * Math.PI * 2);
  let cosSum = Math.cos(local * Math.PI * 2);
  for (const t of remotes) {
    sinSum += Math.sin(t * Math.PI * 2);
    cosSum += Math.cos(t * Math.PI * 2);
  }
  const mean = Math.atan2(sinSum, cosSum) / (Math.PI * 2);
  return ((mean % 1) + 1) % 1;
}
