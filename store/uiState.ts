/**
 * High-frequency HUD state, as a valtio proxy.
 *
 * ## Why valtio and not zustand here
 *
 * These values change *continuously* — stamina drains every frame, the compass
 * heading updates every mouse movement, the interact target changes as the
 * reticle sweeps the world. With a zustand store, every one of those writes
 * would notify every subscriber and React would diff the whole HUD 60 times a
 * second.
 *
 * valtio's `useSnapshot` tracks which properties a component actually *read*
 * during render and only re-renders when those specific properties change. The
 * stamina bar re-renders on stamina; the compass re-renders on heading; neither
 * knows or cares about the other. That property-level granularity is the entire
 * reason for the second state library.
 *
 * Writers additionally apply a change threshold (see {@link setStamina}) so a
 * value drifting by 0.01 per frame doesn't trigger 60 renders per second for a
 * bar that is 200 pixels wide.
 *
 * @module store/uiState
 */

'use client';

import { proxy } from 'valtio';
import { ACCESSIBILITY, type EmoteId, type SurfaceId, type ZoneId } from '@/config/game';

/** An interactable currently under the reticle. */
export interface InteractTarget {
  id: string;
  /** Verb shown in the prompt, e.g. "Ring the bell". */
  label: string;
  /** Distance from the player, metres. */
  distance: number;
  /** True while the interaction is on cooldown or otherwise unavailable. */
  disabled?: boolean;
}

/** A transient on-screen message. */
export interface Toast {
  id: string;
  kind: 'discovery' | 'achievement' | 'info' | 'coin' | 'error';
  title: string;
  body?: string;
  icon?: string;
  createdAt: number;
  /** Milliseconds before auto-dismissal. */
  ttl: number;
}

/** An accessibility subtitle describing a sound and its direction. */
export interface AudioSubtitle {
  id: string;
  icon: string;
  text: string;
  /** Screen-relative direction the sound came from. */
  direction: 'left' | 'right' | 'ahead' | 'behind';
  createdAt: number;
}

/** A floating readable note (signpost, journal page). */
export interface ReadableNote {
  title: string;
  body: string;
  /** Optional attribution line, e.g. "Journal, page 4". */
  footnote?: string;
}

/** Which overlay panel currently owns the screen, if any. */
export type ActivePanel =
  | null
  | 'settings'
  | 'character'
  | 'achievements'
  | 'gallery'
  | 'journal'
  | 'codex'
  | 'note'
  | 'emote'
  | 'shop';

export interface UiState {
  /* ── Player telemetry ─────────────────────────────────────────────────── */
  stamina: number;
  /** True while stamina is too low to start a sprint. */
  staminaExhausted: boolean;
  /** Camera heading in radians, 0 = north (−Z). */
  heading: number;
  /** Player world position, for the compass and minimap. */
  position: { x: number; y: number; z: number };
  /** Horizontal speed, m/s. */
  speed: number;
  /** Ground material under the player. */
  surface: SurfaceId;
  /** Zone the player is currently standing in. */
  zone: ZoneId | null;
  grounded: boolean;
  crouching: boolean;
  sprinting: boolean;

  /* ── Interaction ──────────────────────────────────────────────────────── */
  interactTarget: InteractTarget | null;
  /** Progress of a held interaction, 0..1. */
  interactProgress: number;

  /* ── Overlays ─────────────────────────────────────────────────────────── */
  activePanel: ActivePanel;
  note: ReadableNote | null;
  emoteWheelOpen: boolean;
  selectedEmote: EmoteId | null;

  /* ── Messaging ────────────────────────────────────────────────────────── */
  toasts: Toast[];
  subtitles: AudioSubtitle[];
  /** The onboarding hint currently showing, if any. */
  activeHint: string | null;

  /* ── Train ────────────────────────────────────────────────────────────── */
  /** Seconds until the next train passes; negative once it has. */
  trainCountdown: number;
  /** True during the full T-20 → T+20 ritual window. */
  trainActive: boolean;

  /* ── Diagnostics ──────────────────────────────────────────────────────── */
  fps: number;
  drawCalls: number;
  triangles: number;
  /** Quality tier the adaptive monitor has settled on. */
  effectiveQuality: string;

  /* ── Photo mode ───────────────────────────────────────────────────────── */
  photoAspect: number;
  photoFocalLength: number;
  photoAperture: number;
  photoRoll: number;
  photoHideHud: boolean;
  /** Flashes white for a frame when a photo is taken. */
  photoFlash: boolean;

  /* ── Multiplayer ──────────────────────────────────────────────────────── */
  connectedPlayers: number;
  multiplayerStatus: 'off' | 'connecting' | 'connected' | 'error';

  /* ── Pointer lock ─────────────────────────────────────────────────────── */
  pointerLocked: boolean;
  /** Set when pointer lock is unavailable, so the HUD can warn once. */
  pointerLockUnsupported: boolean;
}

/** The single shared HUD proxy. */
export const ui = proxy<UiState>({
  stamina: 100,
  staminaExhausted: false,
  heading: 0,
  position: { x: 0, y: 0, z: 0 },
  speed: 0,
  surface: 'grass',
  zone: null,
  grounded: true,
  crouching: false,
  sprinting: false,

  interactTarget: null,
  interactProgress: 0,

  activePanel: null,
  note: null,
  emoteWheelOpen: false,
  selectedEmote: null,

  toasts: [],
  subtitles: [],
  activeHint: null,

  trainCountdown: 0,
  trainActive: false,

  fps: 0,
  drawCalls: 0,
  triangles: 0,
  effectiveQuality: 'high',

  photoAspect: 0,
  photoFocalLength: 35,
  photoAperture: 5.6,
  photoRoll: 0,
  photoHideHud: true,
  photoFlash: false,

  connectedPlayers: 0,
  multiplayerStatus: 'off',

  pointerLocked: false,
  pointerLockUnsupported: false,
});

/* ───────────────────────────────────────────────────────────────────────────
 * THRESHOLDED WRITERS
 *
 * Every setter below exists to stop a per-frame write from becoming a
 * per-frame React render. They are called from `useFrame`, so they must be
 * cheap and must not allocate.
 * ─────────────────────────────────────────────────────────────────────────── */

/** Writes stamina only when it moves by at least half a percentage point. */
export function setStamina(value: number, exhausted: boolean): void {
  if (Math.abs(ui.stamina - value) > 0.5) ui.stamina = value;
  if (ui.staminaExhausted !== exhausted) ui.staminaExhausted = exhausted;
}

/** Writes heading only when it moves by more than ~0.6°. */
export function setHeading(radians: number): void {
  if (Math.abs(ui.heading - radians) > 0.01) ui.heading = radians;
}

/** Writes position only when the player has moved a quarter metre. */
export function setPosition(x: number, y: number, z: number): void {
  const p = ui.position;
  if (Math.abs(p.x - x) + Math.abs(p.y - y) + Math.abs(p.z - z) > 0.25) {
    p.x = x;
    p.y = y;
    p.z = z;
  }
}

/** Writes speed at 0.1 m/s granularity. */
export function setSpeed(value: number): void {
  if (Math.abs(ui.speed - value) > 0.1) ui.speed = value;
}

/**
 * Sets the reticle's interact target.
 * Compares by ID so re-pointing at the same object doesn't churn.
 */
export function setInteractTarget(target: InteractTarget | null): void {
  const current = ui.interactTarget;
  if (!target && !current) return;
  if (target && current && target.id === current.id && target.disabled === current.disabled) {
    // Same object — only the distance changed, which the prompt doesn't show.
    return;
  }
  ui.interactTarget = target;
}

let toastSeq = 0;

/**
 * Pushes a toast. Returns its ID so callers can dismiss it early.
 *
 * @param toast - Everything except `id` and `createdAt`.
 */
export function pushToast(toast: Omit<Toast, 'id' | 'createdAt'>): string {
  const id = `toast-${++toastSeq}`;
  ui.toasts.push({ ...toast, id, createdAt: Date.now() });
  // Keep the stack bounded; oldest falls off.
  if (ui.toasts.length > 5) ui.toasts.shift();
  return id;
}

export function dismissToast(id: string): void {
  const idx = ui.toasts.findIndex((t) => t.id === id);
  if (idx >= 0) ui.toasts.splice(idx, 1);
}

/** Expires toasts whose TTL has elapsed. Driven from a low-rate interval. */
export function pruneToasts(now = Date.now()): void {
  for (let i = ui.toasts.length - 1; i >= 0; i--) {
    const t = ui.toasts[i]!;
    if (now - t.createdAt > t.ttl) ui.toasts.splice(i, 1);
  }
}

let subtitleSeq = 0;

/**
 * Pushes an accessibility subtitle for a sound event.
 *
 * @param icon - Emoji shorthand shown before the text.
 * @param text - Description, e.g. "bird chirps".
 * @param direction - Where the sound came from relative to the camera.
 */
export function pushSubtitle(
  icon: string,
  text: string,
  direction: AudioSubtitle['direction'],
): void {
  // Collapse repeats: the same sound from the same direction refreshes the
  // existing line rather than stacking five identical rows.
  const existing = ui.subtitles.find((s) => s.text === text && s.direction === direction);
  if (existing) {
    existing.createdAt = Date.now();
    return;
  }
  ui.subtitles.push({
    id: `sub-${++subtitleSeq}`,
    icon,
    text,
    direction,
    createdAt: Date.now(),
  });
  if (ui.subtitles.length > ACCESSIBILITY.SUBTITLE_MAX) ui.subtitles.shift();
}

/** Expires subtitles past their display duration. */
export function pruneSubtitles(now = Date.now()): void {
  const ttl = ACCESSIBILITY.SUBTITLE_DURATION * 1000;
  for (let i = ui.subtitles.length - 1; i >= 0; i--) {
    if (now - ui.subtitles[i]!.createdAt > ttl) ui.subtitles.splice(i, 1);
  }
}

/** Opens a panel, closing whatever was open. Passing the same panel toggles it. */
export function togglePanel(panel: Exclude<ActivePanel, null>): void {
  ui.activePanel = ui.activePanel === panel ? null : panel;
}

export function closePanel(): void {
  ui.activePanel = null;
  ui.note = null;
}

/** Shows a floating readable note and opens the note panel. */
export function showNote(note: ReadableNote): void {
  ui.note = note;
  ui.activePanel = 'note';
}

/** Resets everything that should not survive leaving a world. */
export function resetUiForNewWorld(): void {
  ui.stamina = 100;
  ui.staminaExhausted = false;
  ui.interactTarget = null;
  ui.interactProgress = 0;
  ui.activePanel = null;
  ui.note = null;
  ui.toasts.length = 0;
  ui.subtitles.length = 0;
  ui.trainCountdown = 0;
  ui.trainActive = false;
  ui.photoFlash = false;
  ui.emoteWheelOpen = false;
  ui.selectedEmote = null;
  ui.activeHint = null;
}
