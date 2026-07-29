/**
 * Multiplayer presence state.
 *
 * Deliberately *not* networked physics. Remote players are ambient: you see
 * where they are and what they're doing, and that is all. There is no
 * authority, no reconciliation and no rollback, because there is nothing to
 * contest — you cannot push each other, and the world is read-only.
 *
 * Remote transforms arrive at 10 Hz and are interpolated locally toward the
 * latest sample (see `components/multiplayer/GhostAvatar.tsx`), which is
 * indistinguishable from smooth movement at walking speed.
 *
 * @module store/presenceStore
 */

'use client';

import { create } from 'zustand';
import { MULTIPLAYER, type EmoteId } from '@/config/game';

/** One remote player's last known state. */
export interface RemotePlayer {
  uid: string;
  displayName: string;
  x: number;
  y: number;
  z: number;
  /** Body yaw in radians. */
  rotY: number;
  emote: EmoteId | null;
  /** Timestamp the emote started, for local animation timing. */
  emoteAt: number;
  avatarColor: string;
  /** Server timestamp of the last update. */
  lastSeen: number;
  /** True while this player is holding a lit lantern. */
  lantern: boolean;
}

export interface PresenceState {
  /** UID → remote player. The local player is never in this map. */
  players: Record<string, RemotePlayer>;
  /** The world instance currently joined. */
  worldId: string | null;
  /** UID of the player who set the weather. */
  hostUid: string | null;
  connected: boolean;
  error: string | null;

  upsert: (player: RemotePlayer) => void;
  remove: (uid: string) => void;
  replaceAll: (players: Record<string, RemotePlayer>) => void;
  setWorld: (worldId: string | null, hostUid: string | null) => void;
  setConnected: (connected: boolean) => void;
  setError: (error: string | null) => void;
  /** Drops entries that have gone stale, e.g. after a hard client crash. */
  pruneStale: () => void;
  reset: () => void;
}

export const usePresenceStore = create<PresenceState>()((set, get) => ({
  players: {},
  worldId: null,
  hostUid: null,
  connected: false,
  error: null,

  upsert: (player) =>
    set((s) => {
      // Cap the room. Beyond MAX_PLAYERS we simply ignore late arrivals rather
      // than evicting someone already being rendered.
      if (!s.players[player.uid] && Object.keys(s.players).length >= MULTIPLAYER.MAX_PLAYERS) {
        return s;
      }
      return { players: { ...s.players, [player.uid]: player } };
    }),

  remove: (uid) =>
    set((s) => {
      if (!s.players[uid]) return s;
      const next = { ...s.players };
      delete next[uid];
      return { players: next };
    }),

  replaceAll: (players) => set({ players }),

  setWorld: (worldId, hostUid) => set({ worldId, hostUid }),
  setConnected: (connected) => set({ connected }),
  setError: (error) => set({ error }),

  pruneStale: () => {
    const cutoff = Date.now() - MULTIPLAYER.STALE_AFTER * 1000;
    const players = get().players;
    let changed = false;
    const next: Record<string, RemotePlayer> = {};
    for (const [uid, p] of Object.entries(players)) {
      if (p.lastSeen >= cutoff) next[uid] = p;
      else changed = true;
    }
    if (changed) set({ players: next });
  },

  reset: () => set({ players: {}, worldId: null, hostUid: null, connected: false, error: null }),
}));

/** Number of remote players currently visible. */
export function selectPlayerCount(s: PresenceState): number {
  return Object.keys(s.players).length;
}
