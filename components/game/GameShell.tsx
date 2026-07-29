/**
 * The game shell.
 *
 * Owns the phase machine, the R3F canvas, input routing, panel state and the
 * bridge between the DOM UI and the 3D scene. Everything the player interacts
 * with passes through here.
 *
 * @module components/game/GameShell
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { AnimatePresence } from 'framer-motion';
import { useSnapshot } from 'valtio';
import * as THREE from 'three';

import { World } from '../scene/World';
import { Hud } from '../hud/Hud';
import { MainMenu } from '../menu/MainMenu';
import { LoadingScreen } from '../menu/LoadingScreen';
import { SettingsPanel } from '../menu/SettingsPanel';
import {
  AchievementsPanel,
  GalleryPanel,
  JournalPanel,
  CodexPanel,
  NotePanel,
  EmoteWheel,
  ShopPanel,
  CharacterOverlay,
} from '../menu/Panels';
import { PhotoModeUi } from '../menu/PhotoModeUi';
import { captureScreenshot } from '../player/PhotoMode';

import { useKeyboard, type EdgeAction } from '@/hooks/useKeyboard';
import { usePointerLock } from '@/hooks/usePointerLock';
import { useGameStore, loadLocalProgress, startProgressAutosave } from '@/store/gameStore';
import { useSettingsStore, getPersistedSettings } from '@/store/settingsStore';
import { ui, closePanel, togglePanel, resetUiForNewWorld, pushToast } from '@/store/uiState';
import { getSynthEngine } from '../audio/SynthEngine';
import { playUiSound } from '../audio/sources/village';
import { generateTerrain, pickDropletBudget, type TerrainData } from '@/lib/terrain/generate';
import { initAuth, subscribeAuth, getDisplayName } from '@/lib/auth';
import { loadUserDocument, saveProgress, saveSettings, saveAvatar, installUnloadFlush, flushUserUpdate } from '@/lib/firestore';
import { joinPresence, leavePresence } from '@/lib/rtdb';
import { uploadScreenshot } from '@/lib/storage';
import { saveScreenshotMetadata } from '@/lib/firestore';
import { isMultiplayerEnabled } from '@/lib/firebase';
import { detectWebGL2, computeDpr } from '@/lib/utils/perf';
import { EROSION, WORLD } from '@/config/game';
import { disposeTextureCache } from '@/lib/textures/procedural';

export function GameShell() {
  const phase = useGameStore((s) => s.phase);
  const seed = useGameStore((s) => s.seed);
  const worldMode = useGameStore((s) => s.worldMode);
  const setPhase = useGameStore((s) => s.setPhase);
  const setError = useGameStore((s) => s.setError);
  const setLoadProgress = useGameStore((s) => s.setLoadProgress);
  const returnToMenu = useGameStore((s) => s.returnToMenu);
  const introSeen = useGameStore((s) => s.introSeen);
  const avatar = useGameStore((s) => s.avatar);

  const graphics = useSettingsStore((s) => s.graphics);
  const accessibility = useSettingsStore((s) => s.accessibility);
  const gameplay = useSettingsStore((s) => s.gameplay);
  const setGameplay = useSettingsStore((s) => s.setGameplay);

  const snap = useSnapshot(ui);

  const [terrain, setTerrain] = useState<TerrainData | null>(null);
  const [webglSupported, setWebglSupported] = useState(true);
  const [contextLost, setContextLost] = useState(false);
  /** True while we are deliberately unmounting the renderer. */
  const tearingDown = useRef(false);

  /* ── Startup ──────────────────────────────────────────────────────────── */
  useEffect(() => {
    setWebglSupported(detectWebGL2());
    loadLocalProgress();
    const stopAutosave = startProgressAutosave();
    const stopUnload = installUnloadFlush();
    void initAuth();
    return () => {
      stopAutosave();
      stopUnload();
      void flushUserUpdate();
      disposeTextureCache();
    };
  }, []);

  /* ── Cloud hydration ──────────────────────────────────────────────────── */
  useEffect(() => {
    return subscribeAuth(async (auth) => {
      if (!auth.user) return;
      const doc = await loadUserDocument();
      if (!doc) return;

      /* The cloud copy is merged *over* the local one only for progression —
       * settings stay local-first, because a player adjusting graphics on a
       * weak laptop should not have a desktop's Cinematic preset pushed back
       * onto them the moment auth resolves. */
      useGameStore.getState().hydrateProgress({
        achievements: doc.achievements ?? {},
        achievementProgress: doc.achievementProgress ?? {},
        discoveries: doc.discoveries ?? {},
        coins: doc.coins ?? 0,
        unlocked: doc.unlocked,
        seasonsSeen: (doc.seasonsSeen as never) ?? [],
        trainsSeen: doc.trainsSeen ?? 0,
        hasSeenEnding: doc.hasSeenEnding ?? false,
        totalPlaytime: doc.profile?.totalPlaytime ?? 0,
      });

      if (doc.profile?.avatarConfig) {
        useGameStore.getState().setAvatar(doc.profile.avatarConfig);
      }
    });
  }, []);

  /* ── Cloud saves ──────────────────────────────────────────────────────── */
  useEffect(() => {
    const unsubProgress = useGameStore.subscribe(
      (s) => s.progress,
      (progress) => saveProgress(progress, getDisplayName()),
    );
    const unsubAvatar = useGameStore.subscribe((s) => s.avatar, saveAvatar);
    const unsubSettings = useSettingsStore.subscribe(() => saveSettings(getPersistedSettings()));
    return () => {
      unsubProgress();
      unsubAvatar();
      unsubSettings();
    };
  }, []);

  /* ── Playtime ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (phase !== 'playing' && phase !== 'seated' && phase !== 'photo') return;
    const timer = setInterval(() => useGameStore.getState().addPlaytime(5), 5000);
    return () => clearInterval(timer);
  }, [phase]);

  /* ── Accessibility classes on <html> ──────────────────────────────────── */
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('reduced-motion', accessibility.reducedMotion);
    root.classList.toggle('hud-high-contrast', accessibility.highContrastHud);
    root.style.setProperty('--ui-scale', String(accessibility.uiScale));
  }, [accessibility.reducedMotion, accessibility.highContrastHud, accessibility.uiScale]);

  /* ── World generation ─────────────────────────────────────────────────── */
  useEffect(() => {
    if (phase !== 'loading') return;

    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        resetUiForNewWorld();
        setLoadProgress(0, 'Folding the hills into place');

        const data = await generateTerrain({
          seed,
          resolution: WORLD.HEIGHTMAP_RESOLUTION,
          droplets: pickDropletBudget(EROSION.DROPLETS),
          signal: controller.signal,
          onProgress: (genPhase, value) => {
            if (cancelled) return;
            /* Weight the phases by how long they actually take, so the bar
             * moves at a roughly constant rate rather than sitting at 40% for
             * a second and then jumping. */
            if (genPhase === 'noise') {
              setLoadProgress(value * 0.45, 'Folding the hills into place');
            } else if (genPhase === 'erosion') {
              setLoadProgress(0.45 + value * 0.4, 'Teaching the river where to go');
            } else {
              setLoadProgress(0.88, 'Planting four hundred trees');
            }
          },
        });

        if (cancelled) return;

        setTerrain(data);
        setLoadProgress(1, 'Letting the light in');

        /* A beat before handing over, so the completed bar is actually seen —
         * a loading screen that vanishes the instant it hits 100% reads as a
         * glitch rather than as completion. */
        setTimeout(() => {
          if (cancelled) return;
          setPhase(introSeen ? 'playing' : 'intro');
        }, 420);
      } catch (err) {
        if (cancelled || (err as Error).name === 'AbortError') return;
        console.error('[world] Generation failed', err);
        setError(
          err instanceof Error ? err.message : 'The terrain could not be generated.',
        );
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [phase, seed, setPhase, setError, setLoadProgress, introSeen]);

  /* ── Multiplayer presence ─────────────────────────────────────────────── */
  useEffect(() => {
    if (!isMultiplayerEnabled) return;
    if (phase !== 'playing' && phase !== 'seated' && phase !== 'photo') return;
    if (worldMode === 'solo') return;

    let leave: (() => void) | null = null;
    void joinPresence(seed, avatar.ghostColor).then((fn) => {
      leave = fn;
    });

    return () => {
      leave?.();
      leavePresence();
    };
  }, [phase, seed, worldMode, avatar.ghostColor]);

  /* ── Pointer lock ─────────────────────────────────────────────────────────
   * The browser exits pointer lock on Escape and there is no way to intercept
   * that — but it *also* exits on window blur, alt-tab, a notification, or the
   * user clicking another monitor. Treating every exit as "open the menu" means
   * tabbing away for a second dumps the player into Settings when they come
   * back, which is genuinely irritating.
   *
   * So we record intent: a real Escape keypress sets a short-lived flag, and
   * only an unlock that follows it opens Settings. Every other unlock simply
   * shows the existing "Click to look around" overlay. */
  const escapeIntent = useRef(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Escape') return;
      escapeIntent.current = true;
      // The flag only needs to survive until the pointerlockchange event fires,
      // which is the same tick. Clearing it quickly stops a stale Escape from
      // hijacking an unrelated unlock later on.
      window.setTimeout(() => {
        escapeIntent.current = false;
      }, 400);

      /* When pointer lock is *not* held, no unlock event will ever arrive — so
       * Escape has to act directly, or there is no keyboard route out of a
       * panel or out of photo mode once the player has clicked away. */
      if (!document.pointerLockElement) {
        const current = useGameStore.getState().phase;

        // Photo mode: Escape leaves it. Universally expected.
        if (current === 'photo') {
          setPhase('playing');
          ui.photoHideHud = true;
          ui.photoDragging = false;
          return;
        }

        if (current === 'playing' || current === 'seated' || current === 'paused') {
          if (ui.activePanel === null) {
            setPhase('paused');
            ui.activePanel = 'settings';
          } else {
            closePanel();
            if (current === 'paused') setPhase('playing');
          }
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setPhase]);

  const pointerLock = usePointerLock(
    // Locked: close any panel and resume play.
    useCallback(() => {
      if (ui.activePanel !== null) closePanel();
      const current = useGameStore.getState().phase;
      if (current === 'paused') setPhase('playing');
      void getSynthEngine().init();
    }, [setPhase]),
    // Unlocked: only open Settings if the player actually asked for it.
    useCallback(() => {
      const current = useGameStore.getState().phase;
      if (current !== 'playing' && current !== 'seated') return;

      if (escapeIntent.current) {
        escapeIntent.current = false;
        setPhase('paused');
        ui.activePanel = 'settings';
      }
      // Otherwise: stay in 'playing'. `ui.pointerLocked` is already false, so
      // the ClickToPlay overlay appears and the player resumes with one click.
    }, [setPhase]),
  );

  /* ── Input ────────────────────────────────────────────────────────────── */
  const handleEdgeAction = useCallback(
    (action: EdgeAction) => {
      const current = useGameStore.getState().phase;
      const engine = getSynthEngine();

      switch (action) {
        case 'photoMode':
          if (current === 'photo') {
            setPhase('playing');
            ui.photoHideHud = true;
            ui.photoDragging = false;
          } else if (current === 'playing' || current === 'seated') {
            setPhase('photo');
            ui.photoHideHud = false;
            /* Hand the cursor back. Photo mode's whole interface is sliders
             * and buttons; keeping pointer lock would leave every one of them
             * unclickable. Aiming is drag-based instead. */
            pointerLock.release();
          }
          break;

        case 'thirdPerson':
          setGameplay({ thirdPerson: !useSettingsStore.getState().gameplay.thirdPerson });
          if (engine.ready) playUiSound(engine, 'click');
          break;

        case 'character':
          togglePanel('character');
          if (ui.activePanel) pointerLock.release();
          break;

        case 'journal':
          togglePanel('journal');
          if (ui.activePanel) pointerLock.release();
          break;

        case 'map':
          togglePanel('codex');
          if (ui.activePanel) pointerLock.release();
          break;

        case 'emote':
          if (current === 'playing') {
            ui.emoteWheelOpen = !ui.emoteWheelOpen;
            ui.activePanel = ui.emoteWheelOpen ? 'emote' : null;
            if (ui.emoteWheelOpen) pointerLock.release();
          }
          break;

        case 'lantern':
          useGameStore.getState().toggleLantern();
          useGameStore
            .getState()
            .setAvatar({ lantern: !useGameStore.getState().avatar.lantern });
          break;

        default:
          break;
      }
    },
    [setPhase, setGameplay, pointerLock],
  );

  const inputEnabled = phase === 'playing' || phase === 'photo' || phase === 'seated';
  const input = useKeyboard(handleEdgeAction, inputEnabled && snap.activePanel === null);

  /* Ending a photo-mode drag has to be watched on the window, not the canvas —
   * the player will frequently release the button after dragging off the edge
   * of the viewport, and a canvas-scoped listener never sees that. */
  useEffect(() => {
    const endDrag = () => {
      ui.photoDragging = false;
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('blur', endDrag);
    return () => {
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      window.removeEventListener('blur', endDrag);
    };
  }, []);

  /* ── Screenshot capture ───────────────────────────────────────────────── */
  const captureRef = useRef<(() => void) | null>(null);

  const handleCapture = useCallback(() => {
    captureRef.current?.();
  }, []);

  /* ── Menu / canvas gating ─────────────────────────────────────────────── */
  const showCanvas = phase !== 'menu' && terrain !== null;
  const showLoading = phase === 'loading' || (phase !== 'menu' && !terrain);

  if (!webglSupported) {
    return <WebGlUnsupported />;
  }

  if (contextLost) {
    return <ContextLost />;
  }

  return (
    <div className="fixed inset-0 overflow-hidden bg-hollow-950">
      {showCanvas && (
        <Canvas
          /* Explicit shadow type: R3F's bare `shadows` prop selects
             `PCFSoftShadowMap`, which three deprecated in r182 and now warns
             about on every renderer configuration. */
          shadows={{ type: THREE.PCFShadowMap }}
          dpr={computeDpr(graphics.resolutionScale)}
          gl={{
            antialias: false,
            alpha: false,
            powerPreference: 'high-performance',
            stencil: false,
            /* Left off deliberately: keeping the drawing buffer alive costs
             * performance on every frame. Photo capture forces a render right
             * before reading instead. See `captureScreenshot`. */
            preserveDrawingBuffer: false,
            failIfMajorPerformanceCaveat: false,
          }}
          camera={{ fov: gameplay.fov, near: 0.1, far: 1400, position: [6, 12, 26] }}
          onCreated={({ gl }) => {
            gl.toneMapping = THREE.ACESFilmicToneMapping;
            gl.toneMappingExposure = graphics.exposure;

            /* A lost context leaves a permanently black canvas — three cannot
             * recover one, and every texture, buffer and program has to be
             * rebuilt from scratch. Rather than let the player stare at
             * nothing, surface it and offer a reload. Usually caused by the
             * GPU being reclaimed (driver update, laptop sleeping) or by
             * running out of video memory. */
            gl.domElement.addEventListener(
              'webglcontextlost',
              (event) => {
                event.preventDefault();
                /* Leaving the valley unmounts the Canvas, and three's own
                 * dispose calls `forceContextLoss()` — which fires this exact
                 * event. Without the guard, returning to the menu would throw
                 * up a "the valley slipped away" error screen every time. */
                if (tearingDown.current) return;
                console.warn('[render] WebGL context lost.');
                setContextLost(true);
              },
              { once: true },
            );
          }}
          onPointerDown={() => {
            if (phase === 'photo') {
              // Drag-to-aim; released by the window-level pointerup below.
              ui.photoDragging = true;
              return;
            }
            if (phase === 'playing' || phase === 'seated') {
              if (!ui.pointerLocked && ui.activePanel === null) pointerLock.request();
            }
          }}
        >
          <World terrain={terrain} input={input} inputEnabled={inputEnabled && snap.activePanel === null} />
          <CaptureBridge captureRef={captureRef} />
        </Canvas>
      )}

      {showCanvas && phase !== 'intro' && <Hud />}

      {phase === 'photo' && (
        <PhotoModeUi
          onCapture={handleCapture}
          onExit={() => {
            setPhase('playing');
            ui.photoHideHud = true;
          }}
        />
      )}

      {/* Click-to-play overlay when pointer lock has been lost. */}
      {showCanvas &&
        phase === 'playing' &&
        !snap.pointerLocked &&
        snap.activePanel === null && <ClickToPlay onClick={() => pointerLock.request()} />}

      {showLoading && <LoadingScreen />}

      {phase === 'menu' && (
        <MainMenu onOpenPanel={(panel) => togglePanel(panel)} />
      )}

      {/* Overlay panels */}
      <AnimatePresence>
        {snap.activePanel === 'settings' && (
          <SettingsPanel
            key="settings"
            onClose={() => {
              closePanel();
              if (phase === 'paused') setPhase('playing');
            }}
          />
        )}
        {snap.activePanel === 'character' && <CharacterOverlay key="character" />}
        {snap.activePanel === 'achievements' && <AchievementsPanel key="achievements" />}
        {snap.activePanel === 'gallery' && <GalleryPanel key="gallery" />}
        {snap.activePanel === 'journal' && <JournalPanel key="journal" />}
        {snap.activePanel === 'codex' && <CodexPanel key="codex" />}
        {snap.activePanel === 'note' && <NotePanel key="note" />}
        {snap.activePanel === 'shop' && <ShopPanel key="shop" />}
        {snap.activePanel === 'emote' && <EmoteWheel key="emote" />}
      </AnimatePresence>

      {/* A dimming scrim behind any open panel. */}
      <AnimatePresence>
        {snap.activePanel !== null && phase !== 'menu' && (
          <div
            className="fixed inset-0 z-[110] bg-black/45 backdrop-blur-[2px]"
            onClick={() => {
              closePanel();
              if (phase === 'paused') setPhase('playing');
            }}
            aria-hidden="true"
          />
        )}
      </AnimatePresence>

      {/* Escape hatch back to the menu, only while paused. */}
      {phase === 'paused' && snap.activePanel === 'settings' && (
        <button
          type="button"
          onClick={() => {
            tearingDown.current = true;
            leavePresence();
            setTerrain(null);
            returnToMenu();
            // Re-arm once React has finished unmounting the canvas.
            window.setTimeout(() => {
              tearingDown.current = false;
            }, 1500);
          }}
          className="fixed bottom-5 left-5 z-[130] rounded-lg border border-hollow-600/50 bg-hollow-900/85 px-3.5 py-2 text-xs text-hollow-300 backdrop-blur transition-colors hover:border-poppy/60 hover:text-poppy"
        >
          Leave the valley
        </button>
      )}
    </div>
  );
}

/**
 * Bridges the DOM's capture button to the WebGL renderer.
 *
 * Lives inside the `<Canvas>` so it can reach `gl`, `scene` and `camera`, and
 * publishes a capture function upward through a ref. This is the standard way
 * to pull renderer internals out to the DOM layer without lifting the whole
 * canvas into state.
 */
function CaptureBridge({ captureRef }: { captureRef: React.RefObject<(() => void) | null> }) {
  const { gl, scene, camera } = useThree();
  const addScreenshot = useGameStore((s) => s.addScreenshot);
  const seed = useGameStore((s) => s.seed);

  useEffect(() => {
    captureRef.current = () => {
      ui.photoFlash = true;
      setTimeout(() => {
        ui.photoFlash = false;
      }, 340);

      const dataUrl = captureScreenshot(gl, scene, camera, ui.photoAspect);
      if (!dataUrl) {
        pushToast({ kind: 'error', title: 'Could not capture', icon: '⚠️', ttl: 3500 });
        return;
      }

      const state = useGameStore.getState();
      const entry = {
        id: `shot-${Date.now()}`,
        url: dataUrl,
        capturedAt: Date.now(),
        worldSeed: seed,
        timeOfDay: state.timeOfDay,
        season: state.season,
        weather: state.weather,
        isPublic: false,
      };
      addScreenshot(entry);

      pushToast({ kind: 'info', title: 'Photograph saved', icon: '📷', ttl: 2800 });

      /* Upload in the background. The local copy is already in the gallery, so
       * a failed upload costs the player nothing — it just stays local. */
      void uploadScreenshot(dataUrl, seed).then(async (result) => {
        if (!result) return;
        const remoteId = await saveScreenshotMetadata({
          ...entry,
          url: result.url,
          storagePath: result.path,
        });
        useGameStore.getState().updateScreenshot(entry.id, {
          url: result.url,
          storagePath: result.path,
          remoteId: remoteId ?? undefined,
        });
      });
    };

    return () => {
      captureRef.current = null;
    };
  }, [gl, scene, camera, addScreenshot, seed, captureRef]);

  return null;
}

/** Shown when pointer lock has been released mid-session. */
function ClickToPlay({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/25 backdrop-blur-[1px] transition-colors hover:bg-black/15"
    >
      <span className="glass rounded-full px-5 py-2.5 text-sm text-hollow-100">
        Click to look around
      </span>
    </button>
  );
}

/** Shown when the GPU has taken the WebGL context away. */
function ContextLost() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-hollow-950 p-8">
      <div className="glass max-w-md rounded-panel p-8 text-center">
        <div className="mb-4 text-4xl">🌫️</div>
        <h1 className="mb-3 font-display text-2xl tracking-wide text-amber-soft">
          The valley slipped away
        </h1>
        <p className="mb-5 text-sm leading-relaxed text-hollow-300">
          The browser lost its connection to your graphics card. This usually means the GPU was
          reclaimed by the system, or the scene ran out of video memory.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg bg-gradient-to-b from-amber-glow to-amber-deep px-5 py-2.5 text-sm font-semibold text-hollow-950 transition-all hover:brightness-110"
        >
          Reload
        </button>
        <p className="mt-5 text-xs leading-relaxed text-hollow-500">
          If it keeps happening, lower <strong>Settings → Graphics → Preset</strong> to Medium or
          Low. Your progress is saved.
        </p>
      </div>
    </div>
  );
}

/** The hard-failure screen for browsers without WebGL2. */
function WebGlUnsupported() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-hollow-950 p-8">
      <div className="glass max-w-md rounded-panel p-8 text-center">
        <div className="mb-4 text-4xl">🌄</div>
        <h1 className="mb-3 font-display text-2xl tracking-wide text-amber-soft">
          Whispering Hollow
        </h1>
        <p className="mb-4 text-sm leading-relaxed text-hollow-300">
          This browser does not support WebGL2, which the valley needs in order to exist.
        </p>
        <p className="text-xs leading-relaxed text-hollow-500">
          Try a recent version of Chrome, Edge, Firefox or Safari. If you are already using one,
          hardware acceleration may be disabled in your browser&apos;s settings.
        </p>
      </div>
    </div>
  );
}
