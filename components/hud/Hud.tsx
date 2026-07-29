/**
 * The in-game HUD.
 *
 * Everything here is deliberately quiet. This is a game about looking at a
 * valley, and a HUD that competes with the valley is a HUD that has failed.
 * Elements fade in only when they have something to say and fade out again
 * when they don't.
 *
 * All components subscribe to the valtio proxy at property granularity — the
 * stamina bar re-renders on stamina, the compass on heading, and neither
 * disturbs the other. See `store/uiState.ts`.
 *
 * @module components/hud/Hud
 */

'use client';

import { useEffect, useMemo } from 'react';
import { useSnapshot } from 'valtio';
import { AnimatePresence, motion } from 'framer-motion';

import { ui, pruneToasts, pruneSubtitles, dismissToast } from '@/store/uiState';
import { useSettingsStore } from '@/store/settingsStore';
import { useGameStore } from '@/store/gameStore';
import { ZONES, PLAYER, INTRO } from '@/config/game';
import { formatTimeOfDay } from '@/lib/utils/math';
import { cn } from '@/lib/utils/cn';

export function Hud() {
  const snap = useSnapshot(ui);
  const gameplay = useSettingsStore((s) => s.gameplay);
  const accessibility = useSettingsStore((s) => s.accessibility);
  const phase = useGameStore((s) => s.phase);

  /* Expire toasts and subtitles on a low-rate interval rather than in the
   * frame loop — they only need second-level accuracy and this keeps them off
   * the render thread entirely. */
  useEffect(() => {
    const timer = setInterval(() => {
      pruneToasts();
      pruneSubtitles();
    }, 250);
    return () => clearInterval(timer);
  }, []);

  const hidden = phase === 'photo' && snap.photoHideHud;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-40 select-none"
      style={{ fontSize: `${accessibility.uiScale}rem` }}
      aria-live="polite"
    >
      {!hidden && (
        <>
          {gameplay.showReticle && <Crosshair />}
          <StaminaBar />
          {gameplay.showCompass && <Compass />}
          <InteractPrompt />
          <ZoneLabel />
          <TrainIndicator />
        </>
      )}

      {/* Toasts and subtitles stay visible in photo mode — they're feedback
          about things that just happened, not chrome. */}
      <Toasts />
      {accessibility.audioSubtitles && <Subtitles />}
      <OnboardingHint />
      <PhotoFlash />
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * CROSSHAIR
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The reticle.
 *
 * A dot, not a cross. It grows and warms when something is interactable, which
 * is the only feedback needed — a full crosshair implies aiming, and there is
 * nothing here to aim at.
 */
function Crosshair() {
  const snap = useSnapshot(ui);
  const highContrast = useSettingsStore((s) => s.accessibility.highContrastHud);
  const active = snap.interactTarget !== null;

  return (
    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
      <motion.div
        animate={{
          scale: active ? 1.9 : 1,
          opacity: active ? 1 : 0.45,
        }}
        transition={{ type: 'spring', stiffness: 380, damping: 26 }}
        className={cn(
          'rounded-full',
          highContrast ? 'h-2 w-2 bg-white ring-2 ring-black' : 'h-1.5 w-1.5',
        )}
        style={
          highContrast
            ? undefined
            : {
                background: active ? 'var(--color-amber-glow)' : 'rgba(255,255,255,0.9)',
                boxShadow: active
                  ? '0 0 12px 2px color-mix(in oklab, var(--color-amber-glow) 60%, transparent)'
                  : '0 0 4px rgba(0,0,0,0.8)',
              }
        }
      />
      {/* A thin ring that only appears on an interactable. */}
      <AnimatePresence>
        {active && (
          <motion.div
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 0.85 }}
            exit={{ scale: 1.4, opacity: 0 }}
            transition={{ duration: 0.22 }}
            className="absolute left-1/2 top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full border border-amber-glow/70"
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * STAMINA
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The stamina bar.
 *
 * Hidden entirely at full stamina. A permanently visible resource bar in a game
 * with no combat is pure noise; it should appear when it starts mattering and
 * disappear the moment it stops.
 */
function StaminaBar() {
  const snap = useSnapshot(ui);
  const visible = snap.stamina < 99 || snap.sprinting;
  const ratio = Math.max(0, Math.min(1, snap.stamina / PLAYER.MAX_STAMINA));

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.28 }}
          className="absolute bottom-10 left-1/2 -translate-x-1/2"
        >
          <div className="h-1 w-40 overflow-hidden rounded-full bg-black/45 backdrop-blur-sm">
            <motion.div
              className={cn(
                'h-full rounded-full transition-colors duration-300',
                snap.staminaExhausted
                  ? 'bg-poppy'
                  : 'bg-gradient-to-r from-amber-deep to-amber-glow',
              )}
              style={{ width: `${ratio * 100}%` }}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * COMPASS
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * A strip compass across the top of the screen.
 *
 * Shows the cardinal points and the named zones as markers, positioned by their
 * bearing relative to the player's heading. Far more useful in an exploration
 * game than a minimap, and far less of an intrusion — a minimap invites you to
 * look at the minimap instead of the world.
 */
function Compass() {
  const snap = useSnapshot(ui);

  const markers = useMemo(() => {
    const cardinals = [
      { label: 'N', bearing: 0, major: true },
      { label: 'NE', bearing: 45, major: false },
      { label: 'E', bearing: 90, major: true },
      { label: 'SE', bearing: 135, major: false },
      { label: 'S', bearing: 180, major: true },
      { label: 'SW', bearing: 225, major: false },
      { label: 'W', bearing: 270, major: true },
      { label: 'NW', bearing: 315, major: false },
    ];
    return cardinals;
  }, []);

  /* Convert the player's yaw into a compass bearing.
   * The camera looks down −Z at yaw 0, and −Z is north, so bearing = −yaw. */
  const bearing = ((-snap.heading * 180) / Math.PI + 360) % 360;

  /** Where a marker sits on the strip, or null if it's behind the player. */
  const offsetFor = (markerBearing: number): number | null => {
    let delta = markerBearing - bearing;
    // Wrap into (−180, 180].
    delta = ((delta + 540) % 360) - 180;
    // The strip shows ±60°.
    if (Math.abs(delta) > 60) return null;
    return delta / 60;
  };

  return (
    <div className="absolute left-1/2 top-5 w-[min(60vw,26rem)] -translate-x-1/2">
      <div className="relative h-7 overflow-hidden">
        {/* Fade the strip out at the edges so markers slide away rather than
            popping. */}
        <div
          className="absolute inset-0"
          style={{
            maskImage: 'linear-gradient(to right, transparent, black 18%, black 82%, transparent)',
            WebkitMaskImage:
              'linear-gradient(to right, transparent, black 18%, black 82%, transparent)',
          }}
        >
          {markers.map((marker) => {
            const offset = offsetFor(marker.bearing);
            if (offset === null) return null;
            return (
              <div
                key={marker.label}
                className="absolute top-0 -translate-x-1/2 text-center"
                style={{ left: `${50 + offset * 50}%` }}
              >
                <div
                  className={cn(
                    'mx-auto w-px bg-hollow-200/50',
                    marker.major ? 'h-2.5' : 'h-1.5',
                  )}
                />
                <span
                  className={cn(
                    'font-mono tracking-wider text-shadow-soft',
                    marker.major
                      ? 'text-[0.68rem] font-semibold text-hollow-100'
                      : 'text-[0.55rem] text-hollow-300/70',
                  )}
                >
                  {marker.label}
                </span>
              </div>
            );
          })}
        </div>

        {/* The centre index mark. */}
        <div className="absolute left-1/2 top-0 h-3 w-px -translate-x-1/2 bg-amber-glow" />
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * ZONE & CLOCK
 * ─────────────────────────────────────────────────────────────────────────── */

/** The name of the area the player has just entered, shown briefly. */
function ZoneLabel() {
  const snap = useSnapshot(ui);
  const timeOfDay = useGameStore((s) => s.timeOfDay);
  const zoneName = snap.zone ? ZONES[snap.zone].label : null;

  return (
    <div className="absolute right-6 top-5 text-right">
      <AnimatePresence mode="wait">
        {zoneName && (
          <motion.div
            key={zoneName}
            initial={{ opacity: 0, x: 14 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 14 }}
            transition={{ duration: 0.4 }}
            className="font-display text-base tracking-wide text-hollow-100/85 text-shadow-soft"
          >
            {zoneName}
          </motion.div>
        )}
      </AnimatePresence>
      <div className="mt-0.5 font-mono text-xs tabular-nums text-hollow-300/60 text-shadow-soft">
        {formatTimeOfDay(timeOfDay)}
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * INTERACT PROMPT
 * ─────────────────────────────────────────────────────────────────────────── */

function InteractPrompt() {
  const snap = useSnapshot(ui);
  const bindings = useSettingsStore((s) => s.bindings);
  const key = bindings.interact[0]?.replace('Key', '') ?? 'F';

  return (
    <AnimatePresence>
      {snap.interactTarget && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.18 }}
          className="absolute left-1/2 top-[calc(50%+2.6rem)] -translate-x-1/2"
        >
          <div className="glass-subtle flex items-center gap-2 rounded-full px-3 py-1.5">
            <kbd className="flex h-5 min-w-5 items-center justify-center rounded border border-hollow-400/50 bg-hollow-900/70 px-1.5 font-mono text-[0.65rem] font-semibold text-amber-soft">
              {key}
            </kbd>
            <span className="text-xs text-hollow-100">{snap.interactTarget.label}</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * TRAIN
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * A faint indicator during the train ritual.
 *
 * Shows only while the sequence is running, and says nothing about *when* — the
 * point of the ritual is that it approaches on its own schedule and you notice
 * it. A countdown timer would destroy that completely.
 */
function TrainIndicator() {
  const snap = useSnapshot(ui);

  return (
    <AnimatePresence>
      {snap.trainActive && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.65 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 1.2 }}
          className="absolute bottom-6 right-6 flex items-center gap-2"
        >
          <span className="animate-breathe text-lg">🚂</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * TOASTS
 * ─────────────────────────────────────────────────────────────────────────── */

const TOAST_STYLES: Record<string, string> = {
  discovery: 'border-amber-glow/45 bg-amber-glow/8',
  achievement: 'border-dusk-violet/50 bg-dusk-violet/10',
  coin: 'border-wheat/45 bg-wheat/8',
  info: 'border-hollow-500/45',
  error: 'border-poppy/55 bg-poppy/10',
};

function Toasts() {
  const snap = useSnapshot(ui);

  return (
    <div className="pointer-events-none absolute bottom-20 left-1/2 flex w-[min(90vw,26rem)] -translate-x-1/2 flex-col-reverse items-center gap-2">
      <AnimatePresence initial={false}>
        {snap.toasts.map((toast) => (
          <motion.div
            key={toast.id}
            layout
            initial={{ opacity: 0, y: 18, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
            className={cn(
              'glass pointer-events-auto flex w-full items-start gap-3 rounded-xl border px-3.5 py-2.5',
              TOAST_STYLES[toast.kind] ?? TOAST_STYLES.info,
            )}
            onClick={() => dismissToast(toast.id)}
            role="status"
          >
            {toast.icon && <span className="mt-0.5 text-lg leading-none">{toast.icon}</span>}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-hollow-100">{toast.title}</div>
              {toast.body && (
                <div className="mt-0.5 text-xs leading-relaxed text-hollow-300">{toast.body}</div>
              )}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * SUBTITLES
 * ─────────────────────────────────────────────────────────────────────────── */

const DIRECTION_ICONS: Record<string, string> = {
  left: '◀',
  right: '▶',
  ahead: '▲',
  behind: '▼',
};

/**
 * Audio subtitles for deaf and hard-of-hearing players.
 *
 * The direction indicator is the important part: this game's audio carries real
 * information (the train is coming, a fox is nearby, the birds have gone up)
 * and *where* a sound came from is often the whole message.
 */
function Subtitles() {
  const snap = useSnapshot(ui);

  return (
    <div className="pointer-events-none absolute bottom-32 left-1/2 flex w-[min(90vw,30rem)] -translate-x-1/2 flex-col gap-1">
      <AnimatePresence initial={false}>
        {snap.subtitles.map((sub) => (
          <motion.div
            key={sub.id}
            layout
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="mx-auto flex items-center gap-2 rounded-full bg-black/72 px-3 py-1"
          >
            <span className="text-sm">{sub.icon}</span>
            <span className="text-xs text-white">{sub.text}</span>
            <span className="font-mono text-[0.6rem] text-amber-soft" aria-label={sub.direction}>
              {DIRECTION_ICONS[sub.direction]} {sub.direction}
            </span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * ONBOARDING
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Onboarding hints.
 *
 * Each hint dismisses itself the first time the player does the thing it
 * describes, rather than on a timer. Someone who already knows WASD never sees
 * the WASD hint for longer than the half-second it takes them to press W.
 */
function OnboardingHint() {
  const dismissed = useGameStore((s) => s.dismissedHints);
  const dismissHint = useGameStore((s) => s.dismissHint);
  const phase = useGameStore((s) => s.phase);

  const activeHint = useMemo(
    () => INTRO.HINTS.find((h) => !dismissed.includes(h.id)),
    [dismissed],
  );

  /* Watch for the dismissing action. */
  useEffect(() => {
    if (!activeHint || phase !== 'playing') return;

    const check = setInterval(() => {
      switch (activeHint.dismissOn) {
        case 'pointerlock':
          if (ui.pointerLocked) dismissHint(activeHint.id);
          break;
        case 'move':
          if (ui.speed > 0.8) dismissHint(activeHint.id);
          break;
        case 'sprint':
          if (ui.sprinting) dismissHint(activeHint.id);
          break;
        case 'interact':
          if (Object.keys(useGameStore.getState().progress.discoveries).length > 0) {
            dismissHint(activeHint.id);
          }
          break;
        case 'photo':
          if (useGameStore.getState().gallery.length > 0) dismissHint(activeHint.id);
          break;
      }
    }, 400);

    /* A generous fallback timer so a hint can never get stuck — if the player
     * simply doesn't do the thing, it goes away on its own eventually. */
    const fallback = setTimeout(
      () => dismissHint(activeHint.id),
      INTRO.HINT_DURATION * 1000 * 4,
    );

    return () => {
      clearInterval(check);
      clearTimeout(fallback);
    };
  }, [activeHint, dismissHint, phase]);

  if (phase !== 'playing') return null;

  return (
    <AnimatePresence mode="wait">
      {activeHint && (
        <motion.div
          key={activeHint.id}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.45 }}
          className="absolute bottom-[7.5rem] left-1/2 -translate-x-1/2"
        >
          <div className="glass-subtle rounded-full px-4 py-2 text-sm text-hollow-200">
            {activeHint.text}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** A single white frame when a photo is taken. */
function PhotoFlash() {
  const snap = useSnapshot(ui);
  return (
    <AnimatePresence>
      {snap.photoFlash && (
        <motion.div
          initial={{ opacity: 0.85 }}
          animate={{ opacity: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.34 }}
          className="absolute inset-0 bg-white"
        />
      )}
    </AnimatePresence>
  );
}
