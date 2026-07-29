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
  /**
   * StrictMode is off, deliberately.
   *
   * In development React StrictMode mounts every component twice to surface
   * impure effects. For an ordinary app that is a good trade. For this one it
   * means the entire `<Canvas>` — terrain mesh, 420 trees, 81 grass chunks,
   * every procedural texture, the shadow map and the whole postprocessing
   * chain — is built, torn down, and built again. Peak GPU memory doubles,
   * and on modest hardware that reliably exhausted the video memory budget
   * and lost the WebGL context about eleven seconds into every dev session.
   *
   * There is nothing the app can do about it: the second allocation happens
   * before the first is released, and three.js has no way to defer it. The
   * production build never double-mounts, so this only ever affected `npm run
   * dev` — which is precisely where it hurt most.
   */
  reactStrictMode: false,

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
