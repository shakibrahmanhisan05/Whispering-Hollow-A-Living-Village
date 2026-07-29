/**
 * Service worker registration.
 *
 * Registered manually rather than via `next-pwa`, which has not kept pace with
 * the App Router and injects a Workbox build step this project does not need.
 * The service worker in `public/sw.js` is hand-written and small enough to read
 * in one sitting.
 *
 * Registration is deferred until after `load` so it never competes with the
 * first paint or the terrain worker for bandwidth.
 *
 * @module components/system/ServiceWorkerRegistrar
 */

'use client';

import { useEffect } from 'react';

export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    /* Never register in development. A cached dev bundle is a genuinely
     * miserable debugging experience, and the offline benefit is nil. */
    if (process.env.NODE_ENV !== 'production') return;

    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then((registration) => {
          /* Check for an updated worker on each load. Without this, a returning
           * player can sit on a cached build until the browser decides to
           * revalidate, which may be a day. */
          registration.update().catch(() => {
            /* Offline — nothing to do. */
          });
        })
        .catch((err) => {
          console.warn('[pwa] Service worker registration failed.', err);
        });
    };

    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });

    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
