/**
 * Root layout.
 *
 * @module app/layout
 */

import type { Metadata, Viewport } from 'next';
import { Analytics } from '@vercel/analytics/react';

import './globals.css';
import { TelemetryProvider } from '@/components/system/TelemetryProvider';
import { ServiceWorkerRegistrar } from '@/components/system/ServiceWorkerRegistrar';

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
  const analyticsEnabled = process.env.NEXT_PUBLIC_ENABLE_ANALYTICS !== 'false';

  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <TelemetryProvider>{children}</TelemetryProvider>
        <ServiceWorkerRegistrar />
        {analyticsEnabled && <Analytics />}
      </body>
    </html>
  );
}
