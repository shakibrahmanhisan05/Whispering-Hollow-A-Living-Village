import type { NextConfig } from 'next';

/**
 * Next.js configuration for Whispering Hollow.
 *
 * Notes:
 * - `transpilePackages` includes `three` and the R3F ecosystem so that the
 *   ESM-only builds are processed correctly by both Turbopack (dev) and
 *   Webpack (production build).
 * - Rapier ships a base64-inlined WASM blob via `@dimforge/rapier3d-compat`,
 *   so no special asset handling is required for physics.
 * - All shaders live in `/shaders/*.glsl.ts` as tagged template literals rather
 *   than raw `.glsl` files. This keeps the toolchain loader-free and identical
 *   between Turbopack and Webpack. See `/shaders/README.md`.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,

  transpilePackages: [
    'three',
    '@react-three/fiber',
    '@react-three/drei',
    '@react-three/postprocessing',
    '@react-three/rapier',
    'postprocessing',
    'three-stdlib',
    'maath',
  ],

  eslint: {
    // Lint is run explicitly in CI via `npm run lint`; don't block builds on it.
    ignoreDuringBuilds: true,
  },

  experimental: {
    // Keeps the heavy 3D chunk out of the menu bundle.
    optimizePackageImports: ['lucide-react', 'framer-motion'],
  },

  async headers() {
    return [
      {
        // The service worker must be served from the root scope.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
