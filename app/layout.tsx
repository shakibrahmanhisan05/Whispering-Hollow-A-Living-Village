/**
 * Root layout.
 *
 * @module app/layout
 */

import type { Metadata, Viewport } from 'next';
import './globals.css';
import { TelemetryProvider } from '@/components/system/TelemetryProvider';
import { ServiceWorkerRegistrar } from '@/components/system/ServiceWorkerRegistrar';
import { AnalyticsGate } from '@/components/system/AnalyticsGate';

export const metadata: Metadata = {
  title: 'Whispering Hollow — A Living Village',
  description:
    'A quiet, living countryside valley you can walk through. Real-time weather, seasons, day and night, and a train that passes like a ritual.',
  applicationName: 'Whispering Hollow',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Whispering Hollow',
  },
  formatDetection: { telephone: false },
  openGraph: {
    title: 'Whispering Hollow — A Living Village',
    description:
      'A quiet, living countryside valley you can walk through. The train comes when it comes.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Whispering Hollow',
    description: 'A quiet, living countryside valley you can walk through.',
  },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/icon-192.png', sizes: '192x192' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#0c110f',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  // The game is a fixed-viewport experience; zooming would break pointer lock.
  userScalable: false,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      {/* Browser extensions (password managers, ad blockers, security suites)
          routinely stamp attributes onto <body> before React hydrates —
          `bis_register`, `__processed_*`, `cz-shortcut-listen` and friends.
          React sees the server HTML and the live DOM disagree and logs a
          hydration mismatch that the developer can do nothing about. Body is
          the standard place to suppress it. */}
      <body suppressHydrationWarning>
        <TelemetryProvider>{children}</TelemetryProvider>
        <ServiceWorkerRegistrar />
        <AnalyticsGate />
      </body>
    </html>
  );
}
