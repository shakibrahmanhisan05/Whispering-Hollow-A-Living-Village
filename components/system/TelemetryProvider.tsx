/**
 * Error reporting and i18n context.
 *
 * Sentry is loaded **lazily and only when a DSN is configured**, using
 * `@sentry/browser` rather than `@sentry/nextjs`. The Next.js SDK requires a
 * build-time plugin, a wizard-generated config, and source-map upload
 * credentials — none of which someone cloning this repo should have to deal
 * with before the game will run. The browser SDK gives the same client-side
 * error capture with a single dynamic import and no build step.
 *
 * @module components/system/TelemetryProvider
 */

'use client';

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';

import { useSettingsStore } from '@/store/settingsStore';
import { getDictionary, type Dictionary, type Locale } from '@/lib/i18n/dictionaries';

/* ───────────────────────────────────────────────────────────────────────────
 * SENTRY
 * ─────────────────────────────────────────────────────────────────────────── */

let sentryInitialised = false;

async function initSentry(): Promise<void> {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn || sentryInitialised) return;
  sentryInitialised = true;

  try {
    const Sentry = await import('@sentry/browser');
    Sentry.init({
      dsn,
      environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? 'production',
      /* 10% of sessions. A WebGL game generates a great deal of noise —
       * context-loss warnings, shader compile timings on old drivers — and
       * full sampling would swamp the quota without adding information. */
      tracesSampleRate: 0.1,
      beforeSend(event) {
        /* Drop WebGL context-loss errors. They are almost always the OS or
         * driver reclaiming the GPU (a laptop sleeping, a driver update), not
         * a bug in the game, and they are unactionable. */
        const message = event.exception?.values?.[0]?.value ?? '';
        if (/context lost|CONTEXT_LOST_WEBGL|WEBGL_lose_context/i.test(message)) return null;
        return event;
      },
    });
  } catch (err) {
    // Telemetry failing must never take the game down with it.
    console.warn('[telemetry] Sentry init failed.', err);
  }
}

/** Reports a handled error, if telemetry is configured. */
export function reportError(error: unknown, context?: Record<string, unknown>): void {
  console.error('[error]', error, context);
  if (!sentryInitialised) return;
  void import('@sentry/browser').then((Sentry) => {
    Sentry.captureException(error, context ? { extra: context } : undefined);
  });
}

/* ───────────────────────────────────────────────────────────────────────────
 * I18N
 * ─────────────────────────────────────────────────────────────────────────── */

const I18nContext = createContext<Dictionary | null>(null);

/** Returns the active translation dictionary. */
export function useT(): Dictionary {
  const dict = useContext(I18nContext);
  return dict ?? getDictionary('en');
}

/* ───────────────────────────────────────────────────────────────────────────
 * PROVIDER
 * ─────────────────────────────────────────────────────────────────────────── */

export function TelemetryProvider({ children }: { children: ReactNode }) {
  const locale = useSettingsStore((s) => s.locale);

  useEffect(() => {
    void initSentry();
  }, []);

  /* Global handlers for anything React's error boundaries don't catch —
   * notably async failures inside `useFrame`, which are outside React's
   * rendering lifecycle entirely. */
  useEffect(() => {
    const onError = (event: ErrorEvent) => reportError(event.error ?? event.message);
    const onRejection = (event: PromiseRejectionEvent) => reportError(event.reason);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  const dictionary = useMemo(() => getDictionary(locale as Locale), [locale]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return <I18nContext.Provider value={dictionary}>{children}</I18nContext.Provider>;
}
