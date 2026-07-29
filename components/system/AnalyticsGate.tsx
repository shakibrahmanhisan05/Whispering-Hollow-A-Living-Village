/**
 * Mounts Vercel Analytics only where it can actually work.
 *
 * `@vercel/analytics` fetches its script from `/_vercel/insights/script.js`,
 * a path served by Vercel's edge network and by nothing else. Running a
 * production build locally (`next start`) therefore produces a 404 and a
 * console error on every page load — noise that trains you to ignore the
 * console, which is the last thing you want while debugging a 3D scene.
 *
 * Gating on the hostname keeps local runs clean and changes nothing in
 * production.
 *
 * @module components/system/AnalyticsGate
 */

'use client';

import { useEffect, useState } from 'react';
import { Analytics } from '@vercel/analytics/react';

export function AnalyticsGate() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_ENABLE_ANALYTICS === 'false') return;
    const host = window.location.hostname;
    const isLocal =
      host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
    setEnabled(!isLocal);
  }, []);

  if (!enabled) return null;
  return <Analytics />;
}
