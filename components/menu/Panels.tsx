/**
 * The remaining overlay panels: achievements, gallery, journal, codex, the
 * note reader, the emote wheel and the market shop.
 *
 * @module components/menu/Panels
 */

'use client';

import { useMemo, useState } from 'react';
import { useSnapshot } from 'valtio';
import { motion } from 'framer-motion';
import { X, Lock, Trash2, Download, Globe2, Coins } from 'lucide-react';

import { Button, ScrollArea, Separator } from '../ui/primitives';
import { ui, closePanel, pushToast } from '@/store/uiState';
import { useGameStore } from '@/store/gameStore';
import { broadcastEmote } from '@/lib/rtdb';
import { downloadDataUrl } from '@/lib/storage';
import { deleteScreenshotMetadata, setScreenshotPublic } from '@/lib/firestore';
import { deleteScreenshot } from '@/lib/storage';
import { ACHIEVEMENTS, JOURNAL_FRAGMENTS, BIRD_SPECIES, TOTAL_DISCOVERIES } from '@/lib/progression/content';
import { EMOTES, ECONOMY, VILLAGE, type EmoteId } from '@/config/game';
import { formatDuration } from '@/lib/utils/math';
import { cn } from '@/lib/utils/cn';

/** A shared frame for every centred overlay panel. */
function PanelShell({
  title,
  subtitle,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96, y: 12 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, y: 8 }}
      transition={{ type: 'spring', stiffness: 340, damping: 32 }}
      className={cn(
        'glass pointer-events-auto fixed left-1/2 top-1/2 z-[120] flex max-h-[86vh] -translate-x-1/2 -translate-y-1/2 flex-col rounded-panel',
        wide ? 'w-[min(94vw,58rem)]' : 'w-[min(94vw,40rem)]',
      )}
      role="dialog"
      aria-label={title}
    >
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-hollow-600/30 px-6 py-4">
        <div>
          <h2 className="font-display text-xl tracking-wide text-hollow-100">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-hollow-400">{subtitle}</p>}
        </div>
        <Button variant="ghost" size="icon" onClick={closePanel} sound="back" aria-label="Close">
          <X className="h-4 w-4" />
        </Button>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-6 py-5">{children}</div>
      </ScrollArea>
    </motion.div>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * ACHIEVEMENTS
 * ─────────────────────────────────────────────────────────────────────────── */

export function AchievementsPanel() {
  const progress = useGameStore((s) => s.progress);
  const unlockedCount = Object.keys(progress.achievements).length;
  const discoveryCount = Object.keys(progress.discoveries).length;

  return (
    <PanelShell
      title="Achievements"
      subtitle={`${unlockedCount} of ${ACHIEVEMENTS.length} · ${discoveryCount} of ${TOTAL_DISCOVERIES} discoveries · ${formatDuration(progress.totalPlaytime)} played`}
      wide
    >
      {/* Progress summary */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Coins', value: progress.coins, icon: '🪙' },
          { label: 'Trains seen', value: progress.trainsSeen, icon: '🚂' },
          { label: 'Journal', value: `${Object.keys(progress.discoveries).filter((d) => d.startsWith('journal')).length}/10`, icon: '📖' },
          { label: 'Birds', value: `${Object.keys(progress.discoveries).filter((d) => d.startsWith('bird-')).length}/12`, icon: '🐦' },
        ].map((stat) => (
          <div key={stat.label} className="rounded-xl bg-hollow-900/45 px-3 py-2.5 text-center">
            <div className="text-lg">{stat.icon}</div>
            <div className="mt-0.5 font-mono text-base tabular-nums text-amber-soft">
              {stat.value}
            </div>
            <div className="text-[0.65rem] uppercase tracking-wider text-hollow-400">
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {ACHIEVEMENTS.map((achievement) => {
          const unlockedAt = progress.achievements[achievement.id];
          const isUnlocked = Boolean(unlockedAt);
          const current = progress.achievementProgress[achievement.id] ?? 0;
          const ratio = Math.min(1, current / achievement.target);
          // Secret achievements stay hidden until earned.
          const hidden = achievement.secret && !isUnlocked;

          return (
            <div
              key={achievement.id}
              className={cn(
                'rounded-xl border p-3 transition-colors',
                isUnlocked
                  ? 'border-amber-glow/40 bg-amber-glow/8'
                  : 'border-hollow-600/40 bg-hollow-900/40',
              )}
            >
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 text-base">
                  {isUnlocked ? '🏆' : hidden ? '❔' : <Lock className="h-3.5 w-3.5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      'text-sm font-medium',
                      isUnlocked ? 'text-amber-soft' : 'text-hollow-200',
                    )}
                  >
                    {hidden ? 'A secret' : achievement.name}
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-hollow-400">
                    {hidden ? 'Keep exploring.' : achievement.description}
                  </p>

                  {!isUnlocked && !hidden && achievement.target > 1 && (
                    <div className="mt-2">
                      <div className="h-1 overflow-hidden rounded-full bg-hollow-700">
                        <div
                          className="h-full rounded-full bg-amber-deep"
                          style={{ width: `${ratio * 100}%` }}
                        />
                      </div>
                      <div className="mt-1 font-mono text-[0.62rem] text-hollow-500">
                        {Math.floor(current)} / {achievement.target}
                      </div>
                    </div>
                  )}

                  {!hidden && (
                    <div className="mt-1.5 text-[0.65rem] text-dusk-violet">
                      Reward: {achievement.reward.label}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </PanelShell>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * GALLERY
 * ─────────────────────────────────────────────────────────────────────────── */

export function GalleryPanel() {
  const gallery = useGameStore((s) => s.gallery);
  const removeScreenshot = useGameStore((s) => s.removeScreenshot);
  const updateScreenshot = useGameStore((s) => s.updateScreenshot);
  const [selected, setSelected] = useState<string | null>(null);

  const selectedEntry = gallery.find((g) => g.id === selected);

  return (
    <PanelShell
      title="Gallery"
      subtitle={gallery.length === 0 ? 'No photographs yet — press P in-game.' : `${gallery.length} photograph${gallery.length === 1 ? '' : 's'}`}
      wide
    >
      {gallery.length === 0 ? (
        <div className="py-12 text-center text-sm text-hollow-400">
          <div className="mb-3 text-3xl">📷</div>
          Press <kbd className="rounded border border-hollow-500 px-1.5 py-0.5 font-mono text-xs">P</kbd> while
          playing to enter photo mode.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {gallery.map((shot) => (
              <button
                key={shot.id}
                type="button"
                onClick={() => setSelected(shot.id === selected ? null : shot.id)}
                className={cn(
                  'group relative aspect-video overflow-hidden rounded-lg border transition-all',
                  selected === shot.id
                    ? 'border-amber-glow ring-2 ring-amber-glow/40'
                    : 'border-hollow-600/40 hover:border-hollow-400',
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={shot.url}
                  alt={`Whispering Hollow, ${new Date(shot.capturedAt).toLocaleString()}`}
                  className="h-full w-full object-cover transition-transform group-hover:scale-105"
                  loading="lazy"
                />
                {shot.isPublic && (
                  <span className="absolute right-1 top-1 rounded bg-black/60 px-1 py-0.5 text-[0.55rem] text-brook-teal">
                    <Globe2 className="inline h-2.5 w-2.5" /> public
                  </span>
                )}
              </button>
            ))}
          </div>

          {selectedEntry && (
            <>
              <Separator className="my-4" />
              <div className="flex flex-wrap items-center gap-2">
                <span className="mr-auto text-xs text-hollow-400">
                  {new Date(selectedEntry.capturedAt).toLocaleString()} · seed{' '}
                  <span className="font-mono">{selectedEntry.worldSeed}</span>
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    downloadDataUrl(
                      selectedEntry.url,
                      `whispering-hollow-${selectedEntry.capturedAt}.jpg`,
                    )
                  }
                >
                  <Download className="h-3.5 w-3.5" /> Save
                </Button>
                {selectedEntry.remoteId && (
                  <Button
                    size="sm"
                    variant={selectedEntry.isPublic ? 'outline' : 'secondary'}
                    onClick={() => {
                      const next = !selectedEntry.isPublic;
                      updateScreenshot(selectedEntry.id, { isPublic: next });
                      void setScreenshotPublic(selectedEntry.remoteId!, next);
                      pushToast({
                        kind: 'info',
                        title: next ? 'Shared publicly' : 'Made private',
                        ttl: 2600,
                      });
                    }}
                  >
                    <Globe2 className="h-3.5 w-3.5" />
                    {selectedEntry.isPublic ? 'Make private' : 'Share'}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    if (selectedEntry.remoteId) void deleteScreenshotMetadata(selectedEntry.remoteId);
                    if (selectedEntry.storagePath) void deleteScreenshot(selectedEntry.storagePath);
                    removeScreenshot(selectedEntry.id);
                    setSelected(null);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </PanelShell>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * JOURNAL & CODEX
 * ─────────────────────────────────────────────────────────────────────────── */

export function JournalPanel() {
  const discoveries = useGameStore((s) => s.progress.discoveries);
  const found = JOURNAL_FRAGMENTS.filter((f) => discoveries[f.id]);

  return (
    <PanelShell
      title="The Journal"
      subtitle={`${found.length} of ${JOURNAL_FRAGMENTS.length} pages recovered`}
    >
      <div className="space-y-3">
        {JOURNAL_FRAGMENTS.map((fragment) => {
          const isFound = Boolean(discoveries[fragment.id]);
          return (
            <article
              key={fragment.id}
              className={cn(
                'rounded-xl border p-4',
                isFound
                  ? 'border-hollow-600/50 bg-hollow-900/45'
                  : 'border-dashed border-hollow-700/60 bg-transparent',
              )}
            >
              <header className="mb-1.5 flex items-baseline justify-between gap-3">
                <h3 className="font-display text-base text-amber-soft/90">
                  {isFound ? fragment.title : `Page ${fragment.order}`}
                </h3>
                <span className="shrink-0 font-mono text-[0.6rem] uppercase tracking-wider text-hollow-500">
                  {isFound ? 'recovered' : fragment.hint}
                </span>
              </header>
              {isFound ? (
                <p className="text-sm leading-relaxed text-hollow-200">{fragment.body}</p>
              ) : (
                <p className="text-sm italic text-hollow-600">Not yet found.</p>
              )}
            </article>
          );
        })}
      </div>
    </PanelShell>
  );
}

export function CodexPanel() {
  const discoveries = useGameStore((s) => s.progress.discoveries);
  const seen = BIRD_SPECIES.filter((b) => discoveries[`bird-${b.id}`]);

  return (
    <PanelShell title="Bird Codex" subtitle={`${seen.length} of ${BIRD_SPECIES.length} species observed`} wide>
      <p className="mb-4 text-xs leading-relaxed text-hollow-400">
        A species is logged by approaching it closely without startling it. Move slowly — different
        birds have different tolerances, and some can only be watched from a distance.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {BIRD_SPECIES.map((bird) => {
          const observed = Boolean(discoveries[`bird-${bird.id}`]);
          return (
            <div
              key={bird.id}
              className={cn(
                'rounded-xl border p-3',
                observed
                  ? 'border-hollow-600/50 bg-hollow-900/45'
                  : 'border-dashed border-hollow-700/60',
              )}
            >
              <div className="flex items-start gap-3">
                <span
                  className="mt-1 h-6 w-6 shrink-0 rounded-full"
                  style={{
                    backgroundColor: observed ? bird.colors.body : '#2c3a33',
                    boxShadow: observed ? `inset -2px -2px 4px ${bird.colors.wing}` : undefined,
                  }}
                />
                <div className="min-w-0">
                  <h3 className="text-sm font-medium text-hollow-100">
                    {observed ? bird.name : '???'}
                  </h3>
                  <p className="text-[0.65rem] italic text-hollow-500">
                    {observed ? bird.latin : 'Unobserved'}
                  </p>
                  {observed && (
                    <p className="mt-1.5 text-xs leading-relaxed text-hollow-300">
                      {bird.description}
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </PanelShell>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * NOTE READER
 * ─────────────────────────────────────────────────────────────────────────── */

/** The floating readable — signposts, journal pages, the bottle. */
export function NotePanel() {
  const snap = useSnapshot(ui);
  if (!snap.note) return null;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95, y: 16 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      className="glass pointer-events-auto fixed left-1/2 top-1/2 z-[130] w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 rounded-panel p-7"
      role="dialog"
      aria-label="Note"
    >
      <h2 className="mb-3 whitespace-pre-line font-display text-lg leading-snug tracking-wide text-amber-soft">
        {snap.note.title}
      </h2>
      <p className="whitespace-pre-line text-sm leading-relaxed text-hollow-200">
        {snap.note.body}
      </p>
      {snap.note.footnote && (
        <p className="mt-4 font-mono text-[0.65rem] uppercase tracking-wider text-hollow-500">
          {snap.note.footnote}
        </p>
      )}
      <Button variant="ghost" size="sm" className="mt-5 w-full" onClick={closePanel} sound="back">
        Close
      </Button>
    </motion.div>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * EMOTE WHEEL
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The radial emote picker.
 *
 * Options are laid out on a circle because a radial menu is selected by
 * *direction*, not by reading — after two uses the player picks "wave" by
 * flicking up-left without looking. A list would never become muscle memory.
 */
export function EmoteWheel() {
  const setActiveEmote = useGameStore((s) => s.setActiveEmote);

  const pick = (emote: EmoteId) => {
    setActiveEmote(emote);
    void broadcastEmote(emote);
    closePanel();
    ui.emoteWheelOpen = false;
    // Emotes clear themselves so the avatar returns to idle.
    setTimeout(() => setActiveEmote(null), 3200);
  };

  const radius = 96;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.16 }}
      className="pointer-events-auto fixed left-1/2 top-1/2 z-[130] -translate-x-1/2 -translate-y-1/2"
    >
      <div className="relative h-64 w-64">
        <div className="absolute inset-0 rounded-full border border-hollow-500/25 bg-hollow-950/45 backdrop-blur-md" />
        {EMOTES.map((emote, i) => {
          // Start at the top and go clockwise.
          const angle = (i / EMOTES.length) * Math.PI * 2 - Math.PI / 2;
          const x = Math.cos(angle) * radius;
          const y = Math.sin(angle) * radius;
          return (
            <button
              key={emote.id}
              type="button"
              onClick={() => pick(emote.id)}
              className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full border border-hollow-500/40 bg-hollow-800/85 transition-all hover:scale-110 hover:border-amber-glow hover:bg-hollow-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-glow"
              style={{ marginLeft: x, marginTop: y }}
            >
              <span className="text-xl">{emote.icon}</span>
              <span className="mt-0.5 text-[0.6rem] text-hollow-300">{emote.label}</span>
            </button>
          );
        })}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center text-[0.65rem] text-hollow-500">
          Emote
        </div>
      </div>
    </motion.div>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * SHOP
 * ─────────────────────────────────────────────────────────────────────────── */

export function ShopPanel() {
  const coins = useGameStore((s) => s.progress.coins);
  const spendCoins = useGameStore((s) => s.spendCoins);
  const addGrain = useGameStore((s) => s.addGrain);
  const placeTrinket = useGameStore((s) => s.placeTrinket);
  const grain = useGameStore((s) => s.progress.grain);

  const trinkets = useGameStore((s) => s.progress.trinkets);

  const items = useMemo(
    () =>
      (
        Object.entries(ECONOMY.TRINKET_PRICES) as Array<
          [keyof typeof ECONOMY.TRINKET_PRICES, number]
        >
      ).map(([kind, price]) => ({ kind, price })),
    [],
  );

  return (
    <PanelShell title="The Market" subtitle={`You have ${coins} coin${coins === 1 ? '' : 's'}`}>
      <div className="mb-5 rounded-xl border border-hollow-600/40 bg-hollow-900/40 p-3.5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm text-hollow-100">Bag of grain</div>
            <p className="text-xs text-hollow-400">
              For the cattle, the chickens and the fish. You have {grain}.
            </p>
          </div>
          <Button
            size="sm"
            variant="primary"
            disabled={coins < ECONOMY.GRAIN_PRICE}
            onClick={() => {
              if (spendCoins(ECONOMY.GRAIN_PRICE)) {
                addGrain(1);
                pushToast({ kind: 'info', title: 'Bought grain', icon: '🌾', ttl: 2400 });
              }
            }}
          >
            <Coins className="h-3.5 w-3.5" /> {ECONOMY.GRAIN_PRICE}
          </Button>
        </div>
      </div>

      <h3 className="mb-2 font-display text-sm uppercase tracking-widest text-amber-soft/70">
        Trinkets
      </h3>
      <p className="mb-3 text-xs text-hollow-400">
        Bought trinkets appear on a village windowsill and stay there.
      </p>

      <div className="space-y-2">
        {items.map((item) => {
          const owned = trinkets.filter((t) => t.kind === item.kind).length;
          return (
            <div
              key={item.kind}
              className="flex items-center justify-between gap-3 rounded-xl border border-hollow-600/40 bg-hollow-900/40 p-3"
            >
              <div className="min-w-0">
                <div className="text-sm capitalize text-hollow-100">{item.kind}</div>
                {owned > 0 && (
                  <p className="text-[0.65rem] text-hollow-500">
                    {owned} placed in the village
                  </p>
                )}
              </div>
              <Button
                size="sm"
                variant={coins >= item.price ? 'primary' : 'secondary'}
                disabled={coins < item.price}
                onClick={() => {
                  if (spendCoins(item.price)) {
                    placeTrinket({
                      id: `${item.kind}-${Date.now()}`,
                      kind: item.kind,
                      // Spread purchases across the houses.
                      houseIndex: trinkets.length % VILLAGE.HOUSE_COUNT.medium,
                      placedAt: Date.now(),
                    });
                    pushToast({
                      kind: 'info',
                      title: 'Placed on a windowsill',
                      body: 'Go and find it.',
                      icon: '🏡',
                      ttl: 4000,
                    });
                  }
                }}
              >
                <Coins className="h-3.5 w-3.5" /> {item.price}
              </Button>
            </div>
          );
        })}
      </div>
    </PanelShell>
  );
}
