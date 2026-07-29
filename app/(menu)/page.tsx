/**
 * The application entry point.
 *
 * The whole game lives behind a single client component, loaded with
 * `ssr: false`. That is not laziness — three.js, Rapier and the Web Audio API
 * all touch browser-only globals at module scope, and pre-rendering them on the
 * server would fail. Dynamic import with SSR disabled is the correct pattern
 * here, and it also keeps the ~1 MB 3D bundle out of the initial HTML payload.
 *
 * @module app/(menu)/page
 */

'use client';

import dynamic from 'next/dynamic';

import { LoadingScreen } from '@/components/menu/LoadingScreen';

const GameShell = dynamic(
  () => import('@/components/game/GameShell').then((m) => m.GameShell),
  {
    ssr: false,
    loading: () => <LoadingScreen />,
  },
);

export default function Page() {
  return <GameShell />;
}
