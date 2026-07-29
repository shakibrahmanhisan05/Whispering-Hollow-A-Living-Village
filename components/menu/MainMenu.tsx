/**
 * The main menu / world picker.
 *
 * @module components/menu/MainMenu
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Play, Shuffle, Trophy, Images, LogIn, Check } from 'lucide-react';

import { Button, Separator } from '../ui/primitives';
import { useGameStore } from '@/store/gameStore';
import { useSettingsStore } from '@/store/settingsStore';
import { subscribeAuth, upgradeToGoogle, getDisplayName, type AuthState } from '@/lib/auth';
import { isFirebaseConfigured, isMultiplayerEnabled } from '@/lib/firebase';
import { pushToast } from '@/store/uiState';
import { WORLD_MODES, type WorldMode } from './menuConstants';
import { TOTAL_DISCOVERIES, ACHIEVEMENTS } from '@/lib/progression/content';
import { RandomSource } from '@/lib/utils/random';
import { cn } from '@/lib/utils/cn';

/** Evocative seed words, so "Random" produces a name worth remembering. */
const SEED_WORDS = [
  'elderflower', 'hawthorn', 'meadowsweet', 'blackthorn', 'foxglove',
  'cornflower', 'yarrow', 'thistledown', 'bramble', 'willowherb',
  'harebell', 'ragwort', 'campion', 'speedwell', 'cowslip',
  'lark', 'kestrel', 'plover', 'curlew', 'redwing',
  'amber', 'ember', 'russet', 'ochre', 'saffron',
];

function randomSeed(): string {
  const rng = new RandomSource(String(Date.now() + Math.random()), 'seed-picker');
  return `${rng.pick(SEED_WORDS)}-${rng.pick(SEED_WORDS)}`;
}

export function MainMenu({ onOpenPanel }: { onOpenPanel: (panel: 'achievements' | 'gallery') => void }) {
  const startWorld = useGameStore((s) => s.startWorld);
  const progress = useGameStore((s) => s.progress);
  const settings = useSettingsStore();

  const [seed, setSeed] = useState(settings.world.seed);
  const [mode, setMode] = useState<WorldMode>('solo');
  const [auth, setAuth] = useState<AuthState>({
    user: null,
    loading: true,
    isLinked: false,
    error: null,
  });
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => subscribeAuth(setAuth), []);

  const unlockedCount = Object.keys(progress.achievements).length;
  const discoveryCount = Object.keys(progress.discoveries).length;
  const hasPlayed = progress.totalPlaytime > 0 || discoveryCount > 0;

  const handleStart = () => {
    const finalSeed = seed.trim() || 'whispering-hollow';
    settings.setWorld({ seed: finalSeed });
    startWorld({ seed: finalSeed, mode });
  };

  const handleSignIn = async () => {
    setSigningIn(true);
    const result = await upgradeToGoogle();
    setSigningIn(false);

    if (result.ok && result.merged) {
      pushToast({
        kind: 'info',
        title: 'Signed in',
        body: 'Your progress will follow you between devices now.',
        icon: '✅',
        ttl: 5000,
      });
    } else if (result.ok && !result.merged) {
      pushToast({
        kind: 'info',
        title: 'Signed in to an existing save',
        body: 'That Google account already had a Whispering Hollow save, so it was loaded. Progress from this device was not merged.',
        icon: 'ℹ️',
        ttl: 9000,
      });
    } else {
      pushToast({ kind: 'error', title: 'Sign-in failed', body: result.error, icon: '⚠️', ttl: 6000 });
    }
  };

  return (
    <div className="fixed inset-0 z-[100] overflow-y-auto bg-hollow-950">
      {/* Backdrop */}
      <div
        className="pointer-events-none fixed inset-0"
        style={{
          background:
            'radial-gradient(ellipse 130% 90% at 30% 110%, #3a2a1c 0%, #1a1512 40%, #080b0a 100%)',
        }}
      />
      <MenuAtmosphere />

      <div className="relative flex min-h-full items-center justify-center px-6 py-12">
        <div className="w-[min(92vw,42rem)]">
          {/* Title */}
          <motion.header
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
            className="mb-10 text-center"
          >
            <h1 className="font-display text-4xl tracking-[0.22em] text-amber-soft sm:text-5xl">
              WHISPERING
            </h1>
            <h2 className="font-display text-4xl tracking-[0.38em] text-amber-glow sm:text-5xl">
              HOLLOW
            </h2>
            <p className="mt-4 text-sm italic text-hollow-400">
              A place to breathe. The train comes when it comes.
            </p>
          </motion.header>

          {/* World setup */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.15 }}
            className="glass rounded-panel p-6"
          >
            <label className="mb-2 block text-xs uppercase tracking-widest text-hollow-400">
              World seed
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                placeholder="whispering-hollow"
                spellCheck={false}
                className="h-11 flex-1 rounded-lg border border-hollow-600/60 bg-hollow-900/70 px-3.5 font-mono text-sm text-hollow-100 placeholder:text-hollow-600 focus:outline-none focus:ring-2 focus:ring-amber-glow"
              />
              <Button
                variant="secondary"
                size="icon"
                className="h-11 w-11"
                onClick={() => setSeed(randomSeed())}
                aria-label="Random seed"
              >
                <Shuffle className="h-4 w-4" />
              </Button>
            </div>
            <p className="mt-2 text-[0.68rem] leading-relaxed text-hollow-500">
              The same seed always grows the same valley. Share one with a friend and you will
              both walk the same hills.
            </p>

            {/* Mode */}
            {isMultiplayerEnabled && (
              <>
                <Separator className="my-5" />
                <label className="mb-2 block text-xs uppercase tracking-widest text-hollow-400">
                  Who can join
                </label>
                <div className="flex gap-1.5">
                  {WORLD_MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setMode(m.id)}
                      className={cn(
                        'flex-1 rounded-lg border px-3 py-2 text-xs transition-all',
                        mode === m.id
                          ? 'border-amber-glow/70 bg-amber-glow/15 text-amber-soft'
                          : 'border-hollow-600/50 bg-hollow-800/50 text-hollow-300 hover:text-hollow-100',
                      )}
                    >
                      <div className="font-medium">{m.label}</div>
                      <div className="mt-0.5 text-[0.6rem] text-hollow-500">{m.description}</div>
                    </button>
                  ))}
                </div>
              </>
            )}

            <Button variant="primary" size="lg" className="mt-6 w-full" onClick={handleStart} sound="confirm">
              <Play className="h-4 w-4" />
              {hasPlayed ? 'Return to the valley' : 'Enter the valley'}
            </Button>
          </motion.div>

          {/* Secondary actions */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.3 }}
            className="mt-4 grid grid-cols-2 gap-3"
          >
            <Button variant="secondary" onClick={() => onOpenPanel('achievements')}>
              <Trophy className="h-4 w-4" />
              Achievements
              <span className="ml-auto font-mono text-xs text-hollow-400">
                {unlockedCount}/{ACHIEVEMENTS.length}
              </span>
            </Button>
            <Button variant="secondary" onClick={() => onOpenPanel('gallery')}>
              <Images className="h-4 w-4" />
              Gallery
            </Button>
          </motion.div>

          {/* Account */}
          <motion.footer
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.45 }}
            className="mt-6 text-center"
          >
            {!isFirebaseConfigured ? (
              <p className="text-[0.68rem] leading-relaxed text-hollow-600">
                Running offline. Progress is saved in this browser.
                <br />
                Add Firebase credentials to <code className="font-mono">.env.local</code> to sync
                across devices.
              </p>
            ) : auth.isLinked ? (
              <p className="flex items-center justify-center gap-1.5 text-xs text-hollow-400">
                <Check className="h-3.5 w-3.5 text-brook-teal" />
                Signed in as {getDisplayName()}
              </p>
            ) : (
              <div>
                <p className="mb-2 text-[0.68rem] text-hollow-500">
                  Progress is saved to this device. Sign in to carry it with you.
                </p>
                <Button variant="ghost" size="sm" onClick={handleSignIn} disabled={signingIn}>
                  <LogIn className="h-3.5 w-3.5" />
                  {signingIn ? 'Signing in…' : 'Continue with Google'}
                </Button>
              </div>
            )}

            <p className="mt-5 text-[0.6rem] text-hollow-700">
              {discoveryCount} of {TOTAL_DISCOVERIES} discoveries found
            </p>
          </motion.footer>
        </div>
      </div>
    </div>
  );
}

/**
 * Ambient motion behind the menu.
 *
 * Deliberately *not* a live 3D scene. Rendering the world behind the menu would
 * mean paying the full frame cost before the player has chosen anything, on a
 * screen they may sit on for thirty seconds. Layered CSS gradients cost nothing
 * and set the mood just as well.
 */
function MenuAtmosphere() {
  const motes = useMemo(
    () =>
      Array.from({ length: 30 }, (_, i) => ({
        id: i,
        left: (i * 37) % 100,
        top: (i * 53) % 100,
        size: 2 + ((i * 13) % 5),
        duration: 14 + ((i * 7) % 16),
        delay: (i * 3) % 12,
      })),
    [],
  );

  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden">
      {motes.map((mote) => (
        <motion.div
          key={mote.id}
          className="absolute rounded-full bg-amber-soft/20"
          style={{
            left: `${mote.left}%`,
            top: `${mote.top}%`,
            width: mote.size,
            height: mote.size,
            filter: 'blur(1px)',
          }}
          animate={{ y: [0, -180], opacity: [0, 0.55, 0] }}
          transition={{
            duration: mote.duration,
            delay: mote.delay,
            repeat: Infinity,
            ease: 'linear',
          }}
        />
      ))}
    </div>
  );
}
