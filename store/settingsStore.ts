/**
 * Player settings: graphics, audio, gameplay, controls, accessibility.
 *
 * Persisted to `localStorage` immediately (so a refresh never loses a slider)
 * and mirrored to Firestore when signed in (so the player's setup follows them
 * between devices). The local copy is authoritative on load; the cloud copy is
 * merged in once auth resolves, which avoids a flash of default settings on
 * every page load.
 *
 * @module store/settingsStore
 */

'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  AUDIO,
  DEFAULT_BINDINGS,
  PLAYER,
  POSTFX,
  QUALITY_PRESETS,
  STORAGE_KEYS,
  TIME,
  TRAIN,
  WIND,
  WORLD,
  type AudioBus,
  type BindingAction,
  type ColorGradeId,
  type ColorblindMode,
  type KeyBindings,
  type QualityPresetId,
  type SeasonId,
  type ShadowQuality,
  type VillageSize,
  type WeatherId,
} from '@/config/game';

/* ───────────────────────────────────────────────────────────────────────────
 * SHAPE
 * ─────────────────────────────────────────────────────────────────────────── */

export interface WorldSettings {
  /** Normalised time of day, 0..1. */
  timeOfDay: number;
  /** When false, time is frozen at `timeOfDay`. */
  timeFlowing: boolean;
  /** Real seconds per in-game day. */
  dayLength: number;
  weather: WeatherId;
  /** When true, weather drifts on its own Perlin schedule. */
  weatherAuto: boolean;
  season: SeasonId;
  /** When true, the season advances one step per session. */
  seasonAuto: boolean;
  windStrength: number;
  fogDensity: number;
  /** Seconds between train events. */
  trainInterval: number;
  seed: string;
  villageSize: VillageSize;
}

export interface GameplaySettings {
  walkSpeed: number;
  sprintMultiplier: number;
  jumpHeight: number;
  mouseSensitivity: number;
  invertY: boolean;
  fov: number;
  headBob: boolean;
  thirdPerson: boolean;
  showReticle: boolean;
  interactionPrompts: boolean;
  showCompass: boolean;
}

export interface GraphicsSettings {
  preset: QualityPresetId;
  resolutionScale: number;
  shadows: ShadowQuality;
  grassDensity: number;
  treeLodDistance: number;
  ssao: boolean;
  bloom: boolean;
  godRays: boolean;
  depthOfField: boolean;
  chromaticAberration: boolean;
  vignette: boolean;
  smaa: boolean;
  motionBlur: boolean;
  waterReflection: boolean;
  colorGrade: ColorGradeId;
  exposure: number;
  /** 0 = unlimited. */
  targetFps: number;
  adaptiveQuality: boolean;
}

export type AudioSettings = Record<AudioBus, number> & {
  ambientMusic: boolean;
  hrtf: boolean;
};

export interface AccessibilitySettings {
  reducedMotion: boolean;
  highContrastHud: boolean;
  audioSubtitles: boolean;
  colorblindMode: ColorblindMode;
  uiScale: number;
}

export interface SettingsState {
  world: WorldSettings;
  gameplay: GameplaySettings;
  graphics: GraphicsSettings;
  audio: AudioSettings;
  accessibility: AccessibilitySettings;
  bindings: KeyBindings;
  locale: string;

  /** Bumped whenever settings arrive from the cloud, to avoid write loops. */
  hydratedFromCloud: boolean;

  setWorld: (patch: Partial<WorldSettings>) => void;
  setGameplay: (patch: Partial<GameplaySettings>) => void;
  setGraphics: (patch: Partial<GraphicsSettings>) => void;
  setAudio: (patch: Partial<AudioSettings>) => void;
  setAccessibility: (patch: Partial<AccessibilitySettings>) => void;
  setBinding: (action: BindingAction, keys: string[]) => void;
  setLocale: (locale: string) => void;

  /** Applies a named quality preset, overwriting the individual toggles. */
  applyQualityPreset: (preset: Exclude<QualityPresetId, 'custom'>) => void;
  /** Marks the preset as `custom` — called by any individual graphics toggle. */
  markCustomPreset: () => void;

  resetSection: (section: keyof Omit<SettingsState, 'hydratedFromCloud'>) => void;
  resetAll: () => void;
  /** Merges a cloud snapshot over the local state. */
  hydrate: (remote: Partial<PersistedSettings>) => void;
}

/** The serialisable subset written to storage and Firestore. */
export type PersistedSettings = Pick<
  SettingsState,
  'world' | 'gameplay' | 'graphics' | 'audio' | 'accessibility' | 'bindings' | 'locale'
>;

/* ───────────────────────────────────────────────────────────────────────────
 * DEFAULTS
 * ─────────────────────────────────────────────────────────────────────────── */

const defaultWorld = (): WorldSettings => ({
  timeOfDay: TIME.DEFAULT_TIME,
  timeFlowing: true,
  dayLength: TIME.SECONDS_PER_DAY,
  weather: 'clear',
  weatherAuto: true,
  season: 'summer',
  seasonAuto: false,
  windStrength: WIND.BASE_STRENGTH,
  fogDensity: 1,
  trainInterval: TRAIN.INTERVAL[0],
  seed: WORLD.DEFAULT_SEED,
  villageSize: 'medium',
});

const defaultGameplay = (): GameplaySettings => ({
  walkSpeed: PLAYER.WALK_SPEED,
  sprintMultiplier: PLAYER.SPRINT_MULTIPLIER,
  jumpHeight: PLAYER.JUMP_VELOCITY,
  mouseSensitivity: PLAYER.MOUSE_SENSITIVITY,
  invertY: false,
  fov: PLAYER.FOV,
  headBob: true,
  thirdPerson: false,
  showReticle: true,
  interactionPrompts: true,
  showCompass: true,
});

const defaultGraphics = (): GraphicsSettings => {
  const p = QUALITY_PRESETS.high;
  return {
    preset: 'high',
    resolutionScale: p.resolutionScale,
    shadows: p.shadows as ShadowQuality,
    grassDensity: p.grassDensity,
    treeLodDistance: 1,
    ssao: p.ssao,
    bloom: p.bloom,
    godRays: p.godRays,
    depthOfField: p.depthOfField,
    chromaticAberration: p.chromaticAberration,
    vignette: p.vignette,
    smaa: p.smaa,
    motionBlur: false,
    waterReflection: p.waterReflection,
    colorGrade: 'goldenHour',
    exposure: POSTFX.TONE_MAPPING_EXPOSURE,
    targetFps: 0,
    adaptiveQuality: true,
  };
};

const defaultAudio = (): AudioSettings => ({
  ...AUDIO.DEFAULT_VOLUMES,
  ambientMusic: true,
  hrtf: true,
});

const defaultAccessibility = (): AccessibilitySettings => ({
  reducedMotion: false,
  highContrastHud: false,
  audioSubtitles: false,
  colorblindMode: 'none',
  uiScale: 1,
});

const defaultBindings = (): KeyBindings =>
  Object.fromEntries(
    Object.entries(DEFAULT_BINDINGS).map(([k, v]) => [k, [...v]]),
  ) as KeyBindings;

/* ───────────────────────────────────────────────────────────────────────────
 * STORE
 * ─────────────────────────────────────────────────────────────────────────── */

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      world: defaultWorld(),
      gameplay: defaultGameplay(),
      graphics: defaultGraphics(),
      audio: defaultAudio(),
      accessibility: defaultAccessibility(),
      bindings: defaultBindings(),
      locale: 'en',
      hydratedFromCloud: false,

      setWorld: (patch) => set((s) => ({ world: { ...s.world, ...patch } })),
      setGameplay: (patch) => set((s) => ({ gameplay: { ...s.gameplay, ...patch } })),
      setGraphics: (patch) =>
        set((s) => {
          const next = { ...s.graphics, ...patch };
          /* Any change to an individual graphics control (as opposed to
           * `applyQualityPreset`) means the configuration no longer matches a
           * named preset. Flip the label to "Custom" so the UI stays honest. */
          const isPresetChange = 'preset' in patch;
          if (!isPresetChange) next.preset = 'custom';
          return { graphics: next };
        }),
      setAudio: (patch) => set((s) => ({ audio: { ...s.audio, ...patch } })),
      setAccessibility: (patch) =>
        set((s) => ({ accessibility: { ...s.accessibility, ...patch } })),
      setBinding: (action, keys) =>
        set((s) => ({ bindings: { ...s.bindings, [action]: keys } })),
      setLocale: (locale) => set({ locale }),

      applyQualityPreset: (preset) => {
        const p = QUALITY_PRESETS[preset];
        set((s) => ({
          graphics: {
            ...s.graphics,
            preset,
            resolutionScale: p.resolutionScale,
            shadows: p.shadows as ShadowQuality,
            grassDensity: p.grassDensity,
            treeLodDistance: p.lodDistanceScale,
            ssao: p.ssao,
            bloom: p.bloom,
            godRays: p.godRays,
            depthOfField: p.depthOfField,
            chromaticAberration: p.chromaticAberration,
            vignette: p.vignette,
            smaa: p.smaa,
            waterReflection: p.waterReflection,
          },
        }));
      },

      markCustomPreset: () => set((s) => ({ graphics: { ...s.graphics, preset: 'custom' } })),

      resetSection: (section) => {
        switch (section) {
          case 'world':
            set({ world: defaultWorld() });
            break;
          case 'gameplay':
            set({ gameplay: defaultGameplay() });
            break;
          case 'graphics':
            set({ graphics: defaultGraphics() });
            break;
          case 'audio':
            set({ audio: defaultAudio() });
            break;
          case 'accessibility':
            set({ accessibility: defaultAccessibility() });
            break;
          case 'bindings':
            set({ bindings: defaultBindings() });
            break;
          default:
            break;
        }
      },

      resetAll: () =>
        set({
          world: defaultWorld(),
          gameplay: defaultGameplay(),
          graphics: defaultGraphics(),
          audio: defaultAudio(),
          accessibility: defaultAccessibility(),
          bindings: defaultBindings(),
          locale: get().locale,
        }),

      hydrate: (remote) =>
        set((s) => ({
          world: { ...s.world, ...remote.world },
          gameplay: { ...s.gameplay, ...remote.gameplay },
          graphics: { ...s.graphics, ...remote.graphics },
          audio: { ...s.audio, ...remote.audio },
          accessibility: { ...s.accessibility, ...remote.accessibility },
          bindings: { ...s.bindings, ...remote.bindings },
          locale: remote.locale ?? s.locale,
          hydratedFromCloud: true,
        })),
    }),
    {
      name: STORAGE_KEYS.SETTINGS,
      storage: createJSONStorage(() => localStorage),
      version: 1,
      // `hydratedFromCloud` is session state, not a setting — don't persist it.
      partialize: (s): PersistedSettings => ({
        world: s.world,
        gameplay: s.gameplay,
        graphics: s.graphics,
        audio: s.audio,
        accessibility: s.accessibility,
        bindings: s.bindings,
        locale: s.locale,
      }),
      /* Merging rather than replacing guards against a stored blob from an
       * older build missing a key that newer code reads unconditionally. */
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PersistedSettings>;
        return {
          ...current,
          world: { ...current.world, ...p.world },
          gameplay: { ...current.gameplay, ...p.gameplay },
          graphics: { ...current.graphics, ...p.graphics },
          audio: { ...current.audio, ...p.audio },
          accessibility: { ...current.accessibility, ...p.accessibility },
          bindings: { ...current.bindings, ...p.bindings },
          locale: p.locale ?? current.locale,
        };
      },
    },
  ),
);

/** Extracts the cloud-syncable slice of the current settings. */
export function getPersistedSettings(): PersistedSettings {
  const s = useSettingsStore.getState();
  return {
    world: s.world,
    gameplay: s.gameplay,
    graphics: s.graphics,
    audio: s.audio,
    accessibility: s.accessibility,
    bindings: s.bindings,
    locale: s.locale,
  };
}

/**
 * Resolves a raw `KeyboardEvent.code` to the game action it is bound to.
 * Returns `null` for unbound keys.
 */
export function resolveBinding(bindings: KeyBindings, code: string): BindingAction | null {
  for (const [action, keys] of Object.entries(bindings) as [BindingAction, string[]][]) {
    if (keys.includes(code)) return action;
  }
  return null;
}
