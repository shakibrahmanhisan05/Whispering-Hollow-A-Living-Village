/**
 * The interaction system.
 *
 * Maintains a registry of world interactables, finds the best candidate under
 * the reticle each frame, and executes it on F.
 *
 * ## Targeting
 *
 * Rather than raycasting against scene geometry — which would require every
 * interactable to have a collider, and would happily let you activate things
 * through walls — targets are selected by a **cone test**: within range, and
 * within a generous angle of where the player is looking. That is far cheaper,
 * far more forgiving to aim at (important for small objects like a coin), and
 * trivially supports interactables with no mesh at all, like the ridge bench's
 * sitting spot.
 *
 * @module components/player/Interactions
 */

'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { useWorld } from '../scene/TerrainContext';
import { playerState } from './PlayerController';
import { useGameStore } from '@/store/gameStore';
import { useSettingsStore } from '@/store/settingsStore';
import { ui, setInteractTarget, pushToast, showNote } from '@/store/uiState';
import { useSynthEngine } from '@/components/audio/useSpatialAudio';
import { playChurchBell, playStoneSkip, playWellCrank, playUiSound } from '@/components/audio/sources/village';
import { playChickenCluck, playCowMoo, playFishSplash } from '@/components/audio/sources/wildlife';
import { startleAllBirds } from '../scene/Wildlife/Birds';
import { spawnWaterRipple } from '../scene/Water';
import { bellSwingRef } from '../scene/Village/Village';
import { JOURNAL_FRAGMENTS, SIGNPOSTS, VIEWPOINTS, ENDING_NARRATION } from '@/lib/progression/content';
import { PLAYER, ECONOMY, WORLD, VILLAGE } from '@/config/game';
import { POND, RIDGE_BENCH } from '@/lib/world/layout';
import { clamp } from '@/lib/utils/math';

/** One thing in the world the player can interact with. */
export interface Interactable {
  id: string;
  /** World position. */
  position: THREE.Vector3;
  /** Verb shown in the prompt. */
  label: string;
  /** Override the default interaction range. */
  range?: number;
  /** Returns false to hide the prompt (already used, wrong time of day, …). */
  available?: () => boolean;
  /** Runs when the player presses F. */
  onInteract: () => void;
}

/** The live registry. Module-level so any component can register into it. */
const registry = new Map<string, Interactable>();

/** Registers an interactable. Returns an unregister function. */
export function registerInteractable(item: Interactable): () => void {
  registry.set(item.id, item);
  return () => {
    registry.delete(item.id);
  };
}

/** React helper for registering an interactable for a component's lifetime. */
export function useInteractable(item: Interactable | null): void {
  const ref = useRef(item);
  ref.current = item;

  useEffect(() => {
    if (!item) return;
    // Register a stable wrapper that always calls through to the latest props.
    return registerInteractable({
      id: item.id,
      get position() {
        return ref.current!.position;
      },
      get label() {
        return ref.current!.label;
      },
      get range() {
        return ref.current!.range;
      },
      available: () => ref.current?.available?.() ?? true,
      onInteract: () => ref.current?.onInteract(),
    });
    // Only the ID identifies the registration; everything else reads through
    // the ref, so changing a label doesn't churn the registry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);
}

/**
 * The interaction driver.
 *
 * Mount once inside the `<Canvas>`. Also seeds every world-fixed interactable
 * (journal pages, signposts, coins, the bell, the well, the bench, the pond).
 */
export function InteractionSystem({ input }: { input: React.RefObject<{ interactPressed: boolean }> }) {
  const { terrain } = useWorld();
  const { camera } = useThree();
  const engine = useSynthEngine();

  const phase = useGameStore((s) => s.phase);
  const setPhase = useGameStore((s) => s.setPhase);
  const setTimeScale = useGameStore((s) => s.setTimeScale);
  const discover = useGameStore((s) => s.discover);
  const advanceAchievement = useGameStore((s) => s.advanceAchievement);
  const unlockAchievement = useGameStore((s) => s.unlockAchievement);
  const addCoins = useGameStore((s) => s.addCoins);
  const addFlowers = useGameStore((s) => s.addFlowers);
  const spendFlowers = useGameStore((s) => s.spendFlowers);
  const spendGrain = useGameStore((s) => s.spendGrain);
  const prompts = useSettingsStore((s) => s.gameplay.interactionPrompts);

  const audioSource = useRef<ReturnType<typeof engine.createSource>>(null);

  useEffect(() => {
    if (!engine.ready) return;
    audioSource.current = engine.createSource({
      bus: 'ambient',
      position: [0, 0, 0],
      refDistance: 4,
      maxDistance: 300,
      rolloff: 1.1,
      reverbSend: 0.4,
    });
    return () => {
      audioSource.current?.dispose();
      audioSource.current = null;
    };
  }, [engine, engine.ready]);

  /** Plays a one-shot at a world position through the shared source. */
  const at = useCallback(
    (pos: THREE.Vector3 | [number, number, number]) => {
      const p = Array.isArray(pos) ? pos : [pos.x, pos.y, pos.z];
      audioSource.current?.setPosition(p[0]!, p[1]!, p[2]!, 0.001);
      return audioSource.current ?? null;
    },
    [],
  );

  /* ═══════════════════════════════════════════════════════════════════════
   * WORLD INTERACTABLES
   * ═══════════════════════════════════════════════════════════════════════ */

  /* ── Church bell ─────────────────────────────────────────────────────── */
  useEffect(() => {
    const pos = new THREE.Vector3(-24, terrain.heightAt(-24, 26) + 2, 26);
    return registerInteractable({
      id: 'church-bell',
      position: pos,
      label: 'Ring the church bell',
      range: 5,
      onInteract: () => {
        playChurchBell(engine, at(pos), { fundamental: 196, volume: 1 });
        bellSwingRef.current = 1;
        /* The bell scatters every bird on the map. It is the one interaction
         * with a world-scale consequence, and worth the theatre. */
        startleAllBirds();
        unlockAchievement('bellringer');
        pushToast({
          kind: 'info',
          title: 'The bell rings out',
          body: 'Every bird in the valley goes up at once.',
          icon: '🔔',
          ttl: 5000,
        });
      },
    });
  }, [terrain, engine, at, unlockAchievement]);

  /* ── The well ────────────────────────────────────────────────────────── */
  useEffect(() => {
    const pos = new THREE.Vector3(2, terrain.heightAt(2, -3) + 1, -3);
    return registerInteractable({
      id: 'well',
      position: pos,
      /* The label is resolved through a getter so it can change with inventory
       * without re-registering the interactable. */
      get label() {
        return useGameStore.getState().progress.flowers >= 5 ? 'Leave a bouquet' : 'Draw water';
      },
      range: 3.2,
      onInteract: () => {
        const state = useGameStore.getState();
        if (state.progress.flowers >= 5) {
          if (spendFlowers(5)) {
            discover('well-bouquet');
            unlockAchievement('well-wisher');
            playUiSound(engine, 'confirm');
            pushToast({
              kind: 'info',
              title: 'A bouquet on the well',
              body: 'Somebody will see it tomorrow and wonder who left it.',
              icon: '💐',
              ttl: 6000,
            });
          }
        } else {
          playWellCrank(engine, at(pos));
        }
      },
    });
  }, [terrain, engine, at, discover, unlockAchievement, spendFlowers]);

  /* ── Ridge bench ─────────────────────────────────────────────────────── */
  const seatedAt = useRef(0);
  const seatedStartTime = useRef(0);

  useEffect(() => {
    const pos = new THREE.Vector3(
      RIDGE_BENCH.x,
      terrain.heightAt(RIDGE_BENCH.x, RIDGE_BENCH.z) + 0.8,
      RIDGE_BENCH.z,
    );
    return registerInteractable({
      id: 'ridge-bench',
      position: pos,
      label: 'Sit and watch a while',
      range: 3,
      onInteract: () => {
        const current = useGameStore.getState().phase;
        if (current === 'seated') {
          setPhase('playing');
          setTimeScale(1);
        } else {
          setPhase('seated');
          /* Time runs at 3× while seated, so a sunrise takes four real minutes
           * rather than twelve. Long enough to feel like waiting; short enough
           * that people actually do it. */
          setTimeScale(3);
          seatedAt.current = performance.now();
          seatedStartTime.current = useGameStore.getState().timeOfDay;
          playUiSound(engine, 'confirm');
        }
      },
    });
  }, [terrain, setPhase, setTimeScale, engine]);

  /* Watching a full sunrise from the bench unlocks "Sit a While". */
  useEffect(() => {
    if (phase !== 'seated') return;
    const check = setInterval(() => {
      const t = useGameStore.getState().timeOfDay;
      const start = seatedStartTime.current;
      // Started before dawn, now past full morning.
      if (start < 0.2 && t > 0.34 && t < 0.55) {
        unlockAchievement('sit-a-while');
      }
    }, 2000);
    return () => clearInterval(check);
  }, [phase, unlockAchievement]);

  /* ── Journal fragments ───────────────────────────────────────────────── */
  useEffect(() => {
    const unregisters = JOURNAL_FRAGMENTS.map((fragment) => {
      const [x, z] = fragment.position;
      const pos = new THREE.Vector3(x, terrain.heightAt(x, z) + 0.4, z);
      return registerInteractable({
        id: fragment.id,
        position: pos,
        label: 'Read the page',
        range: 2.6,
        available: () => !useGameStore.getState().progress.discoveries[fragment.id],
        onInteract: () => {
          if (discover(fragment.id)) {
            advanceAchievement('archivist', 1);
            playUiSound(engine, 'unlock');
            showNote({
              title: fragment.title,
              body: fragment.body,
              footnote: `Journal · page ${fragment.order} of ${JOURNAL_FRAGMENTS.length}`,
            });

            // All ten read → the ending narration.
            const found = JOURNAL_FRAGMENTS.filter(
              (f) => useGameStore.getState().progress.discoveries[f.id],
            ).length;
            if (found >= JOURNAL_FRAGMENTS.length) {
              setTimeout(() => {
                useGameStore.setState((s) => ({
                  progress: { ...s.progress, hasSeenEnding: true },
                }));
                showNote({
                  title: 'The whole of it',
                  body: ENDING_NARRATION.join('\n\n'),
                });
              }, 800);
            }
          }
        },
      });
    });
    return () => unregisters.forEach((u) => u());
  }, [terrain, discover, advanceAchievement, engine]);

  /* ── Signposts ───────────────────────────────────────────────────────── */
  useEffect(() => {
    const unregisters = SIGNPOSTS.map((sign) => {
      const [x, z] = sign.position;
      const pos = new THREE.Vector3(x, terrain.heightAt(x, z) + 1.7, z);
      return registerInteractable({
        id: sign.id,
        position: pos,
        label: 'Read the sign',
        range: 3,
        onInteract: () => {
          const isNew = discover(sign.id);
          if (isNew) advanceAchievement('good-listener', 1);
          playUiSound(engine, 'click');
          showNote({ title: sign.sign, body: sign.note });
        },
      });
    });
    return () => unregisters.forEach((u) => u());
  }, [terrain, discover, advanceAchievement, engine]);

  /* ── Coins ───────────────────────────────────────────────────────────── */
  const coins = useMemo(() => {
    const out: Array<{ id: string; pos: THREE.Vector3 }> = [];
    /* Coins go in the *corners* — deliberately away from the paths, so that
     * finding them requires actually wandering rather than following a route. */
    for (let i = 0; i < ECONOMY.COIN_COUNT; i++) {
      const a = (i / ECONOMY.COIN_COUNT) * Math.PI * 2 * 5;
      const r = 60 + (i % 7) * 22;
      const x = clamp(Math.cos(a) * r, -WORLD.HALF + 20, WORLD.HALF - 20);
      const z = clamp(Math.sin(a) * r, -WORLD.HALF + 20, WORLD.HALF - 20);
      const y = terrain.heightAt(x, z);
      if (y < WORLD.WATER_LEVEL + 0.5) continue;
      out.push({ id: `coin-${i}`, pos: new THREE.Vector3(x, y + 0.35, z) });
    }
    return out;
  }, [terrain]);

  useEffect(() => {
    const unregisters = coins.map((coin) =>
      registerInteractable({
        id: coin.id,
        position: coin.pos,
        label: 'Pick up the coin',
        range: 2.4,
        available: () => !useGameStore.getState().progress.discoveries[coin.id],
        onInteract: () => {
          if (discover(coin.id)) {
            addCoins(1);
            advanceAchievement('treasurer', 1);
            playUiSound(engine, 'confirm');
            pushToast({ kind: 'coin', title: '+1 coin', icon: '🪙', ttl: 2200 });
          }
        },
      }),
    );
    return () => unregisters.forEach((u) => u());
  }, [coins, discover, addCoins, advanceAchievement, engine]);

  /* ── Flowers ─────────────────────────────────────────────────────────── */
  const flowerSpots = useMemo(() => {
    const out: Array<{ id: string; pos: THREE.Vector3 }> = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2 * 3.1;
      const r = 40 + (i % 5) * 26;
      const x = clamp(Math.cos(a) * r - 60, -WORLD.HALF + 20, WORLD.HALF - 20);
      const z = clamp(Math.sin(a) * r + 40, -WORLD.HALF + 20, WORLD.HALF - 20);
      const y = terrain.heightAt(x, z);
      if (y < WORLD.WATER_LEVEL + 0.5) continue;
      out.push({ id: `flowers-${i}`, pos: new THREE.Vector3(x, y + 0.3, z) });
    }
    return out;
  }, [terrain]);

  useEffect(() => {
    const unregisters = flowerSpots.map((spot) =>
      registerInteractable({
        id: spot.id,
        position: spot.pos,
        label: 'Pick flowers',
        range: 2.4,
        onInteract: () => {
          addFlowers(1);
          playUiSound(engine, 'click');
          pushToast({ kind: 'info', title: 'Picked a flower', icon: '🌼', ttl: 1800 });
        },
      }),
    );
    return () => unregisters.forEach((u) => u());
  }, [flowerSpots, addFlowers, engine]);

  /* ── Pond: skip stones & feed fish ───────────────────────────────────── */
  const lastSkipTime = useRef(0);

  useEffect(() => {
    // On the shore, near the dock.
    const angle = Math.atan2(-POND.center[1], -POND.center[0]);
    const x = POND.center[0] + Math.cos(angle) * (POND.radius - 2);
    const z = POND.center[1] + Math.sin(angle) * (POND.radius - 2);
    const pos = new THREE.Vector3(x, WORLD.WATER_LEVEL + 0.6, z);

    const unregSkip = registerInteractable({
      id: 'skip-stones',
      position: pos,
      label: 'Skip a stone',
      range: 4.5,
      onInteract: () => {
        /* Skip count is a skill check on *timing*: the power meter oscillates,
         * and the number of skips is derived from how close to the peak the
         * player releases. Here, without a hold interaction, it is derived from
         * the rhythm of repeated presses — pressing at a steady, unhurried
         * cadence yields more skips than mashing. Rewarding patience is on
         * theme. */
        const now = performance.now();
        const gap = now - lastSkipTime.current;
        lastSkipTime.current = now;
        // The sweet spot is a press roughly every 1.2 s.
        const rhythm = 1 - clamp(Math.abs(gap - 1200) / 1200, 0, 1);
        const skips = clamp(Math.round(2 + rhythm * 5 + Math.random() * 1.2), 1, 7);

        playStoneSkip(engine, at(pos), skips);

        // A ripple for each bounce, marching out across the pond.
        for (let i = 0; i < skips; i++) {
          const t = i / Math.max(skips - 1, 1);
          const rx = x + (POND.center[0] - x) * (0.15 + t * 0.7);
          const rz = z + (POND.center[1] - z) * (0.15 + t * 0.7);
          setTimeout(() => spawnWaterRipple(rx, rz), i * 340);
        }

        pushToast({
          kind: 'info',
          title: `${skips} skip${skips === 1 ? '' : 's'}`,
          icon: '🪨',
          ttl: 2400,
        });

        if (skips >= 7) {
          unlockAchievement('seven-skips');
        }
      },
    });

    const unregFish = registerInteractable({
      id: 'feed-fish',
      position: new THREE.Vector3(POND.center[0], WORLD.WATER_LEVEL + 0.4, POND.center[1]),
      label: 'Feed the fish',
      range: 8,
      available: () => useGameStore.getState().progress.grain > 0,
      onInteract: () => {
        if (spendGrain(1)) {
          for (let i = 0; i < 5; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.random() * 4;
            setTimeout(() => {
              spawnWaterRipple(POND.center[0] + Math.cos(a) * r, POND.center[1] + Math.sin(a) * r);
              playFishSplash(engine, at(pos), 0.7);
            }, i * 220);
          }
          discover('fed-fish');
          advanceAchievement('stock-keeper', 1);
          pushToast({ kind: 'info', title: 'The fish rise', icon: '🐟', ttl: 3000 });
        }
      },
    });

    // The message in a bottle, floating out on the water.
    const bottlePos = new THREE.Vector3(
      POND.center[0] + POND.radius * 0.55,
      WORLD.WATER_LEVEL + 0.2,
      POND.center[1] - POND.radius * 0.4,
    );
    const unregBottle = registerInteractable({
      id: 'secret-bottle',
      position: bottlePos,
      label: 'Reach for the bottle',
      range: 3.5,
      available: () => !useGameStore.getState().progress.discoveries['secret-bottle'],
      onInteract: () => {
        if (discover('secret-bottle')) {
          unlockAchievement('message-in-a-bottle');
          spawnWaterRipple(bottlePos.x, bottlePos.z);
          showNote({
            title: 'A note in a bottle',
            body: 'The paper has been in there long enough that the ink has run. What is left reads: "…and if the light is good, that is enough for a whole day. It has been enough for a whole life."',
            footnote: 'Unsigned',
          });
        }
      },
    });

    return () => {
      unregSkip();
      unregFish();
      unregBottle();
    };
  }, [engine, at, discover, spendGrain, advanceAchievement, unlockAchievement]);

  /* ── Feed the animals ────────────────────────────────────────────────── */
  useEffect(() => {
    const cowPos = new THREE.Vector3(37, terrain.heightAt(37, -19) + 1, -19);
    const unregCows = registerInteractable({
      id: 'feed-cows',
      position: cowPos,
      label: 'Feed the cattle',
      range: 6,
      available: () => useGameStore.getState().progress.grain > 0,
      onInteract: () => {
        if (spendGrain(1)) {
          playCowMoo(engine, at(cowPos), 1);
          discover('fed-cows');
          advanceAchievement('stock-keeper', 1);
          pushToast({ kind: 'info', title: 'The cattle amble over', icon: '🐄', ttl: 3000 });
        }
      },
    });

    const chickenPos = new THREE.Vector3(4, terrain.heightAt(4, -6) + 0.6, -6);
    const unregChickens = registerInteractable({
      id: 'feed-chickens',
      position: chickenPos,
      label: 'Scatter grain',
      range: 5,
      available: () => useGameStore.getState().progress.grain > 0,
      onInteract: () => {
        if (spendGrain(1)) {
          playChickenCluck(engine, at(chickenPos), 1);
          discover('fed-chickens');
          advanceAchievement('stock-keeper', 1);
          pushToast({ kind: 'info', title: 'Chaos, briefly', icon: '🐓', ttl: 3000 });
        }
      },
    });

    return () => {
      unregCows();
      unregChickens();
    };
  }, [terrain, engine, at, discover, spendGrain, advanceAchievement]);

  /* ── Market: buy grain and trinkets ──────────────────────────────────── */
  useEffect(() => {
    const pos = new THREE.Vector3(
      Math.cos(0.6) * (VILLAGE.PLAZA_RADIUS - 2.5),
      terrain.heightAt(0, 0) + 1.2,
      Math.sin(0.6) * (VILLAGE.PLAZA_RADIUS - 2.5),
    );
    return registerInteractable({
      id: 'market-stall',
      position: pos,
      label: 'Browse the stall',
      range: 3.5,
      onInteract: () => {
        ui.activePanel = 'shop';
        playUiSound(engine, 'click');
      },
    });
  }, [terrain, engine]);

  /* ── Viewpoints ──────────────────────────────────────────────────────── */
  const viewpointCheck = useRef(0);

  /* ═══════════════════════════════════════════════════════════════════════
   * TARGETING & EXECUTION
   * ═══════════════════════════════════════════════════════════════════════ */

  useFrame((_, dt) => {
    if (phase !== 'playing' && phase !== 'seated') {
      setInteractTarget(null);
      return;
    }

    /* ── Find the best target ────────────────────────────────────────────
     * Score = how well aligned it is with the view direction, weighted by
     * proximity. A generous 45° cone means small objects are easy to select
     * without pixel-precise aim, while the alignment weighting still lets the
     * player choose between two adjacent things by looking at one. */
    camera.getWorldDirection(_lookDir);
    const eye = camera.position;

    let best: Interactable | null = null;
    let bestScore = -Infinity;
    let bestDistance = 0;

    for (const item of registry.values()) {
      if (item.available && !item.available()) continue;

      _toItem.subVectors(item.position, eye);
      const distance = _toItem.length();
      const range = item.range ?? PLAYER.INTERACT_DISTANCE;
      if (distance > range) continue;

      _toItem.divideScalar(Math.max(distance, 0.0001));
      const alignment = _toItem.dot(_lookDir);
      // Roughly a 45° half-angle cone.
      if (alignment < 0.7) continue;

      /* Weight alignment heavily and proximity lightly, so looking directly at
       * a slightly further object beats a nearer one off to the side. */
      const score = alignment * 2 - distance / range;
      if (score > bestScore) {
        bestScore = score;
        best = item;
        bestDistance = distance;
      }
    }

    if (best && prompts) {
      setInteractTarget({ id: best.id, label: best.label, distance: bestDistance });
    } else {
      setInteractTarget(null);
    }

    /* ── Execute ─────────────────────────────────────────────────────── */
    if (input.current?.interactPressed) {
      input.current.interactPressed = false;
      if (best) {
        best.onInteract();
      }
    }

    /* ── Viewpoint discovery ─────────────────────────────────────────────
     * Passive rather than an interaction — you discover a viewpoint by
     * *standing* in it, which is the correct verb for a view. Checked twice a
     * second, which is plenty. */
    viewpointCheck.current -= dt;
    if (viewpointCheck.current <= 0) {
      viewpointCheck.current = 0.5;
      const px = playerState.position.x;
      const pz = playerState.position.z;
      for (const vp of VIEWPOINTS) {
        const d = Math.hypot(px - vp.position[0], pz - vp.position[1]);
        if (d < vp.radius && discover(vp.id)) {
          advanceAchievement('cartographer', 1);
          playUiSound(engine, 'unlock');
          pushToast({
            kind: 'discovery',
            title: vp.name,
            body: vp.description,
            icon: '📷',
            ttl: 6500,
          });
        }
      }
    }
  });

  return null;
}

const _lookDir = new THREE.Vector3();
const _toItem = new THREE.Vector3();
