/**
 * The loading screen.
 *
 * Shows *real* progress from the terrain worker, not a fake animation. The
 * dandelion seeds drifting across it are pure CSS, so they keep moving at a
 * smooth 60 FPS even while the main thread is busy meshing terrain — which is
 * the whole reason generation runs in a worker.
 *
 * @module components/menu/LoadingScreen
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';

import { useGameStore } from '@/store/gameStore';
import { mulberry32 } from '@/lib/utils/random';

/** Rotating flavour lines, so a long load isn't a blank wait. */
const FLAVOUR = [
  'Folding the hills into place',
  'Teaching the river where to go',
  'Planting four hundred trees',
  'Winding the station clock',
  'Tuning the church bell',
  'Waking the birds',
  'Laying the track',
  'Letting the light in',
];

export function LoadingScreen() {
  const progress = useGameStore((s) => s.loadProgress);
  const label = useGameStore((s) => s.loadLabel);
  const error = useGameStore((s) => s.error);
  const [flavourIndex, setFlavourIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setFlavourIndex((i) => (i + 1) % FLAVOUR.length), 2400);
    return () => clearInterval(timer);
  }, []);

  /* Seeds are generated once with a fixed seed so their layout is stable
   * across re-renders — otherwise they'd jump every time progress ticks. */
  const seeds = useMemo(() => {
    const rand = mulberry32(0xda1de);
    return Array.from({ length: 22 }, (_, i) => ({
      id: i,
      left: rand() * 100,
      top: rand() * 100,
      size: 4 + rand() * 8,
      duration: 9 + rand() * 12,
      delay: rand() * 8,
      drift: (rand() - 0.5) * 160,
    }));
  }, []);

  return (
    <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center overflow-hidden bg-hollow-950">
      {/* A warm gradient standing in for the sky behind the silhouette. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 120% 80% at 50% 100%, #2a1f18 0%, #14100e 45%, #080b0a 100%)',
        }}
      />

      {/* Drifting dandelion seeds. */}
      {seeds.map((seed) => (
        <motion.div
          key={seed.id}
          className="pointer-events-none absolute rounded-full bg-amber-soft/25"
          style={{
            left: `${seed.left}%`,
            top: `${seed.top}%`,
            width: seed.size,
            height: seed.size,
            filter: 'blur(1px)',
          }}
          animate={{
            x: [0, seed.drift, seed.drift * 0.4],
            y: [0, -120, -260],
            opacity: [0, 0.7, 0],
          }}
          transition={{
            duration: seed.duration,
            delay: seed.delay,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />
      ))}

      {/* The village silhouette, slowly rotating. */}
      <motion.div
        className="pointer-events-none absolute bottom-0 h-40 w-full opacity-[0.13]"
        animate={{ x: [-40, 40, -40] }}
        transition={{ duration: 60, repeat: Infinity, ease: 'linear' }}
      >
        <VillageSilhouette />
      </motion.div>

      <div className="relative z-10 flex w-[min(88vw,26rem)] flex-col items-center">
        <motion.h1
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
          className="font-display text-3xl tracking-[0.2em] text-amber-soft"
        >
          WHISPERING
        </motion.h1>
        <motion.h2
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.15 }}
          className="mb-10 font-display text-3xl tracking-[0.35em] text-amber-glow"
        >
          HOLLOW
        </motion.h2>

        {error ? (
          <div className="text-center">
            <p className="mb-2 text-sm text-poppy">The valley could not be woken.</p>
            <p className="text-xs text-hollow-400">{error}</p>
          </div>
        ) : (
          <>
            <div className="relative h-1 w-full overflow-hidden rounded-full bg-hollow-800">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-amber-deep to-amber-glow"
                animate={{ width: `${Math.round(progress * 100)}%` }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
              />
              <div className="shimmer absolute inset-0" />
            </div>

            <div className="mt-4 flex w-full items-baseline justify-between gap-4">
              <motion.span
                key={label || flavourIndex}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-xs text-hollow-400"
              >
                {label || FLAVOUR[flavourIndex]}
              </motion.span>
              <span className="font-mono text-xs tabular-nums text-amber-soft/70">
                {Math.round(progress * 100)}%
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** A simple SVG skyline of the village, for the loading backdrop. */
function VillageSilhouette() {
  return (
    <svg
      viewBox="0 0 1200 200"
      preserveAspectRatio="none"
      className="h-full w-full"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        className="text-amber-soft"
        d="M0,200 L0,150 L60,150 L60,120 L90,95 L120,120 L120,150 L180,150 L180,110
           L210,80 L240,110 L240,150 L300,150 L300,60 L320,60 L320,30 L340,60 L340,150
           L400,150 L400,125 L430,100 L460,125 L460,150 L540,150 L540,115 L575,85
           L610,115 L610,150 L700,150 L700,135 L730,105 L760,135 L760,150 L820,150
           L820,90 L840,90 L850,55 L860,90 L880,90 L880,150 L960,150 L960,125
           L990,100 L1020,125 L1020,150 L1090,150 L1090,118 L1120,92 L1150,118
           L1150,150 L1200,150 L1200,200 Z"
      />
    </svg>
  );
}
