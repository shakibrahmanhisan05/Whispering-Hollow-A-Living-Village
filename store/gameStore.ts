/**
 * Core game state: session lifecycle, world simulation clock, progression and
 * inventory.
 *
 * This store holds **durable, low-frequency** state. Anything that changes
 * every frame — player position, stamina, the current interact target — lives
 * in `store/uiState.ts` (a valtio proxy) or in refs inside the R3F tree, so
 * that a 60 Hz update never triggers a React re-render of the whole app.
 *
 * @module store/gameStore
 */

'use client';

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import {
  ECONOMY,
  STORAGE_KEYS,
  DEFAULT_AVATAR,
  type AvatarConfig,
  type SeasonId,
  type WeatherId,
  type WorldMode,
  type EmoteId,
} from '@/config/game';
import {
  ACHIEVEMENTS,
  ACHIEVEMENT_BY_ID,
  TOTAL_DISCOVERIES,
  type Achievement,
} from '@/lib/progression/content';

/** Where the player currently is in the app lifecycle. */
export type GamePhase =
  | 'menu'
  | 'loading'
  | 'intro'
  | 'playing'
  | 'paused'
  | 'photo'
  | 'seated'
  | 'error';

export interface ScreenshotEntry {
  id: string;
  /** Data URL when local-only, or a Firebase Storage download URL. */
  url: string;
  capturedAt: number;
  worldSeed: string;
  timeOfDay: number;
  season: SeasonId;
  weather: WeatherId;
  isPublic: boolean;
  /** Set once uploaded; absent for local-only shots. */
  remoteId?: string;
  storagePath?: string;
}

/** A trinket bought from a stall and placed on a windowsill. */
export interface PlacedTrinket {
  id: string;
  kind: keyof typeof ECONOMY.TRINKET_PRICES;
  houseIndex: number;
  placedAt: number;
}

export interface ProgressState {
  /** Achievement ID → unlock timestamp. */
  achievements: Record<string, number>;
  /** Achievement ID → current progress toward `target`. */
  achievementProgress: Record<string, number>;
  /** Discovery ID → found timestamp. */
  discoveries: Record<string, number>;
  coins: number;
  /** Unlocked cosmetic IDs by category. */
  unlocked: { hats: string[]; outfits: string[]; luts: string[]; liveries: string[] };
  /** Flower stems currently carried. */
  flowers: number;
  /** Bags of grain currently carried. */
  grain: number;
  trinkets: PlacedTrinket[];
  /** Total seconds played across all sessions. */
  totalPlaytime: number;
  /** Seasons experienced, for the Four Seasons achievement. */
  seasonsSeen: SeasonId[];
  /** Number of train passes witnessed. */
  trainsSeen: number;
  hasSeenEnding: boolean;
}

export interface GameState {
  phase: GamePhase;
  /** Non-null once terrain generation has failed irrecoverably. */
  error: string | null;
  /** 0..1 loading progress, plus a human-readable label. */
  loadProgress: number;
  loadLabel: string;

  /** Active world identity. */
  seed: string;
  worldId: string | null;
  worldMode: WorldMode;

  /** Simulation clock, normalised 0..1 across a day. Advanced by TimeSystem. */
  timeOfDay: number;
  /** Multiplier on time flow — 3× while seated on the ridge bench. */
  timeScale: number;
  /** Current weather, which may differ from the setting when auto is on. */
  weather: WeatherId;
  season: SeasonId;

  avatar: AvatarConfig;
  progress: ProgressState;
  gallery: ScreenshotEntry[];

  /** Emote currently playing on the local player, if any. */
  activeEmote: EmoteId | null;
  /** Whether the hand-held lantern is lit. */
  lanternOn: boolean;

  /** Onboarding hint IDs already dismissed. */
  dismissedHints: string[];
  /** True once the intro flyover has played at least once this device. */
  introSeen: boolean;

  /* ── Actions ──────────────────────────────────────────────────────────── */
  setPhase: (phase: GamePhase) => void;
  setError: (message: string | null) => void;
  setLoadProgress: (value: number, label?: string) => void;
  startWorld: (opts: { seed: string; mode: WorldMode; worldId?: string | null }) => void;
  returnToMenu: () => void;

  setTimeOfDay: (t: number) => void;
  setTimeScale: (scale: number) => void;
  setWeather: (w: WeatherId) => void;
  setSeason: (s: SeasonId) => void;

  setAvatar: (patch: Partial<AvatarConfig>) => void;
  setActiveEmote: (emote: EmoteId | null) => void;
  toggleLantern: () => void;

  /** Records a discovery. No-op if already found. Returns true if it was new. */
  discover: (id: string) => boolean;
  /** Adds progress toward an achievement, unlocking it when the target is met. */
  advanceAchievement: (id: string, amount?: number) => void;
  /** Directly unlocks an achievement. */
  unlockAchievement: (id: string) => void;
  addCoins: (n: number) => void;
  spendCoins: (n: number) => boolean;
  addFlowers: (n: number) => void;
  spendFlowers: (n: number) => boolean;
  addGrain: (n: number) => void;
  spendGrain: (n: number) => boolean;
  placeTrinket: (t: PlacedTrinket) => void;
  recordTrainPass: () => void;
  addPlaytime: (seconds: number) => void;
  noteSeason: (s: SeasonId) => void;

  addScreenshot: (entry: ScreenshotEntry) => void;
  removeScreenshot: (id: string) => void;
  updateScreenshot: (id: string, patch: Partial<ScreenshotEntry>) => void;

  dismissHint: (id: string) => void;
  markIntroSeen: () => void;

  /** Replaces progression with a cloud snapshot. */
  hydrateProgress: (progress: Partial<ProgressState>, gallery?: ScreenshotEntry[]) => void;
  /** Wipes local progression — used by "Reset progress" in settings. */
  resetProgress: () => void;
}

const emptyProgress = (): ProgressState => ({
  achievements: {},
  achievementProgress: {},
  discoveries: {},
  coins: 0,
  unlocked: { hats: ['none'], outfits: ['linen'], luts: ['goldenHour'], liveries: ['hollowGreen'] },
  flowers: 0,
  grain: 0,
  trinkets: [],
  totalPlaytime: 0,
  seasonsSeen: [],
  trainsSeen: 0,
  hasSeenEnding: false,
});

/**
 * Applies an achievement's reward to the progression state.
 * Pure — returns the mutated draft so callers can compose it.
 */
function grantReward(progress: ProgressState, achievement: Achievement): ProgressState {
  const { reward } = achievement;
  const unlocked = {
    hats: [...progress.unlocked.hats],
    outfits: [...progress.unlocked.outfits],
    luts: [...progress.unlocked.luts],
    liveries: [...progress.unlocked.liveries],
  };
  let coins = progress.coins + ECONOMY.COINS_PER_ACHIEVEMENT;

  switch (reward.kind) {
    case 'hat':
      if (reward.id && !unlocked.hats.includes(reward.id)) unlocked.hats.push(reward.id);
      break;
    case 'outfit':
      if (reward.id && !unlocked.outfits.includes(reward.id)) unlocked.outfits.push(reward.id);
      break;
    case 'lut':
      if (reward.id && !unlocked.luts.includes(reward.id)) unlocked.luts.push(reward.id);
      break;
    case 'livery':
      if (reward.id && !unlocked.liveries.includes(reward.id)) unlocked.liveries.push(reward.id);
      break;
    case 'coins':
      coins += reward.amount ?? 0;
      break;
    default:
      break;
  }

  return { ...progress, unlocked, coins };
}

export const useGameStore = create<GameState>()(
  subscribeWithSelector((set, get) => ({
    phase: 'menu',
    error: null,
    loadProgress: 0,
    loadLabel: '',

    seed: 'whispering-hollow',
    worldId: null,
    worldMode: 'solo',

    timeOfDay: 0.72,
    timeScale: 1,
    weather: 'clear',
    season: 'summer',

    avatar: { ...DEFAULT_AVATAR },
    progress: emptyProgress(),
    gallery: [],

    activeEmote: null,
    lanternOn: false,

    dismissedHints: [],
    introSeen: false,

    setPhase: (phase) => set({ phase }),
    setError: (error) => set({ error, phase: error ? 'error' : get().phase }),
    setLoadProgress: (loadProgress, loadLabel) =>
      set((s) => ({ loadProgress, loadLabel: loadLabel ?? s.loadLabel })),

    startWorld: ({ seed, mode, worldId = null }) =>
      set({
        seed,
        worldMode: mode,
        worldId,
        phase: 'loading',
        loadProgress: 0,
        loadLabel: 'Waking the valley',
        error: null,
      }),

    returnToMenu: () => set({ phase: 'menu', loadProgress: 0, error: null, timeScale: 1 }),

    setTimeOfDay: (timeOfDay) => set({ timeOfDay }),
    setTimeScale: (timeScale) => set({ timeScale }),
    setWeather: (weather) => set({ weather }),
    setSeason: (season) => {
      set({ season });
      get().noteSeason(season);
    },

    setAvatar: (patch) => set((s) => ({ avatar: { ...s.avatar, ...patch } })),
    setActiveEmote: (activeEmote) => set({ activeEmote }),
    toggleLantern: () => set((s) => ({ lanternOn: !s.lanternOn })),

    discover: (id) => {
      if (get().progress.discoveries[id]) return false;
      set((s) => ({
        progress: {
          ...s.progress,
          discoveries: { ...s.progress.discoveries, [id]: Date.now() },
        },
      }));
      return true;
    },

    advanceAchievement: (id, amount = 1) => {
      const state = get();
      if (state.progress.achievements[id]) return;
      const def = ACHIEVEMENT_BY_ID.get(id);
      if (!def) return;

      const current = (state.progress.achievementProgress[id] ?? 0) + amount;
      if (current >= def.target) {
        get().unlockAchievement(id);
        return;
      }
      set((s) => ({
        progress: {
          ...s.progress,
          achievementProgress: { ...s.progress.achievementProgress, [id]: current },
        },
      }));
    },

    unlockAchievement: (id) => {
      const state = get();
      if (state.progress.achievements[id]) return;
      const def = ACHIEVEMENT_BY_ID.get(id);
      if (!def) return;

      let progress: ProgressState = {
        ...state.progress,
        achievements: { ...state.progress.achievements, [id]: Date.now() },
        achievementProgress: { ...state.progress.achievementProgress, [id]: def.target },
      };
      progress = grantReward(progress, def);
      set({ progress });

      /* The meta-achievement counts every *other* unlock. Checking it here —
       * rather than polling — means it fires on the same frame as the final
       * prerequisite, so the two toasts stack naturally. */
      if (id !== 'the-whole-of-it') {
        const unlockedCount = Object.keys(progress.achievements).filter(
          (a) => a !== 'the-whole-of-it',
        ).length;
        if (unlockedCount >= ACHIEVEMENTS.length - 1) {
          get().unlockAchievement('the-whole-of-it');
        }
      }
    },

    addCoins: (n) =>
      set((s) => ({ progress: { ...s.progress, coins: Math.max(0, s.progress.coins + n) } })),

    spendCoins: (n) => {
      if (get().progress.coins < n) return false;
      set((s) => ({ progress: { ...s.progress, coins: s.progress.coins - n } }));
      return true;
    },

    addFlowers: (n) =>
      set((s) => ({ progress: { ...s.progress, flowers: s.progress.flowers + n } })),

    spendFlowers: (n) => {
      if (get().progress.flowers < n) return false;
      set((s) => ({ progress: { ...s.progress, flowers: s.progress.flowers - n } }));
      return true;
    },

    addGrain: (n) => set((s) => ({ progress: { ...s.progress, grain: s.progress.grain + n } })),

    spendGrain: (n) => {
      if (get().progress.grain < n) return false;
      set((s) => ({ progress: { ...s.progress, grain: s.progress.grain - n } }));
      return true;
    },

    placeTrinket: (t) =>
      set((s) => ({ progress: { ...s.progress, trinkets: [...s.progress.trinkets, t] } })),

    recordTrainPass: () => {
      set((s) => ({ progress: { ...s.progress, trainsSeen: s.progress.trainsSeen + 1 } }));
      get().advanceAchievement('train-chaser', 1);
    },

    addPlaytime: (seconds) =>
      set((s) => ({
        progress: { ...s.progress, totalPlaytime: s.progress.totalPlaytime + seconds },
      })),

    noteSeason: (season) => {
      const seen = get().progress.seasonsSeen;
      if (seen.includes(season)) return;
      const next = [...seen, season];
      set((s) => ({ progress: { ...s.progress, seasonsSeen: next } }));
      get().advanceAchievement('four-seasons', 1);
    },

    addScreenshot: (entry) => {
      set((s) => ({ gallery: [entry, ...s.gallery] }));
      get().advanceAchievement('village-photographer', 1);
    },

    removeScreenshot: (id) => set((s) => ({ gallery: s.gallery.filter((g) => g.id !== id) })),

    updateScreenshot: (id, patch) =>
      set((s) => ({ gallery: s.gallery.map((g) => (g.id === id ? { ...g, ...patch } : g)) })),

    dismissHint: (id) =>
      set((s) =>
        s.dismissedHints.includes(id) ? s : { dismissedHints: [...s.dismissedHints, id] },
      ),

    markIntroSeen: () => set({ introSeen: true }),

    hydrateProgress: (progress, gallery) =>
      set((s) => ({
        progress: { ...s.progress, ...progress },
        gallery: gallery ?? s.gallery,
      })),

    resetProgress: () => set({ progress: emptyProgress(), gallery: [] }),
  })),
);

/* ───────────────────────────────────────────────────────────────────────────
 * LOCAL PERSISTENCE
 *
 * Progression is persisted manually rather than through zustand's `persist`
 * middleware because writes are debounced: unlocking an achievement can cascade
 * into several set() calls in one frame, and we want exactly one localStorage
 * write for the lot.
 * ─────────────────────────────────────────────────────────────────────────── */

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Reads progression + gallery + avatar back out of localStorage. */
export function loadLocalProgress(): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.PROGRESS);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        progress?: Partial<ProgressState>;
        dismissedHints?: string[];
        introSeen?: boolean;
      };
      useGameStore.setState((s) => ({
        progress: { ...s.progress, ...parsed.progress },
        dismissedHints: parsed.dismissedHints ?? s.dismissedHints,
        introSeen: parsed.introSeen ?? s.introSeen,
      }));
    }

    const avatarRaw = localStorage.getItem(STORAGE_KEYS.AVATAR);
    if (avatarRaw) {
      useGameStore.setState((s) => ({
        avatar: { ...s.avatar, ...(JSON.parse(avatarRaw) as Partial<AvatarConfig>) },
      }));
    }

    const galleryRaw = localStorage.getItem(STORAGE_KEYS.GALLERY);
    if (galleryRaw) {
      useGameStore.setState({ gallery: JSON.parse(galleryRaw) as ScreenshotEntry[] });
    }
  } catch (err) {
    console.warn('[gameStore] Failed to restore local progress', err);
  }
}

/** Writes progression to localStorage, debounced to one write per 400 ms. */
export function saveLocalProgress(): void {
  if (typeof window === 'undefined') return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const s = useGameStore.getState();
      localStorage.setItem(
        STORAGE_KEYS.PROGRESS,
        JSON.stringify({
          progress: s.progress,
          dismissedHints: s.dismissedHints,
          introSeen: s.introSeen,
        }),
      );
      localStorage.setItem(STORAGE_KEYS.AVATAR, JSON.stringify(s.avatar));
      /* Data-URL screenshots are large; only the most recent handful are kept
       * locally, and only when the player is signed out. Anything uploaded to
       * Storage is referenced by URL and costs almost nothing to keep. */
      localStorage.setItem(STORAGE_KEYS.GALLERY, JSON.stringify(s.gallery.slice(0, 24)));
    } catch (err) {
      // QuotaExceededError is the expected failure here — the gallery is the
      // only unbounded thing we store, so drop it and retry once.
      console.warn('[gameStore] Local save failed; trimming gallery.', err);
      try {
        localStorage.setItem(STORAGE_KEYS.GALLERY, JSON.stringify([]));
      } catch {
        /* Storage is unavailable entirely (private mode). Nothing to do. */
      }
    }
  }, 400);
}

/** Wires the debounced save to every progression-affecting mutation. */
export function startProgressAutosave(): () => void {
  const unsubProgress = useGameStore.subscribe((s) => s.progress, saveLocalProgress);
  const unsubAvatar = useGameStore.subscribe((s) => s.avatar, saveLocalProgress);
  const unsubGallery = useGameStore.subscribe((s) => s.gallery, saveLocalProgress);
  const unsubHints = useGameStore.subscribe((s) => s.dismissedHints, saveLocalProgress);
  return () => {
    unsubProgress();
    unsubAvatar();
    unsubGallery();
    unsubHints();
  };
}

/** Convenience selector: fraction of all discoveries found, 0..1. */
export function selectDiscoveryRatio(s: GameState): number {
  return Object.keys(s.progress.discoveries).length / TOTAL_DISCOVERIES;
}
