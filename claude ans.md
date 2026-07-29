🌄 Whispering Hollow — Build Complete

112 files · ~33,000 lines · committed to main at E:\ROUGH CODING\Whispering Hollow A Living Village

┌─────────────────────┬───────────────────────────────────────────────┐
│        Gate         │                    Result                     │
├─────────────────────┼───────────────────────────────────────────────┤
│ tsc --noEmit        │ ✅ 0 errors                                   │
├─────────────────────┼───────────────────────────────────────────────┤
│ eslint              │ ✅ 0 errors (1 style warning)                 │
├─────────────────────┼───────────────────────────────────────────────┤
│ next build          │ ✅ 164 kB first-load JS (target was < 500 kB) │
├─────────────────────┼───────────────────────────────────────────────┤
│ npm run verify      │ ✅ 29/29 world-gen checks                     │
├─────────────────────┼───────────────────────────────────────────────┤
│ Live browser render │ ✅ Verified in real Chrome + GPU              │
└─────────────────────┴───────────────────────────────────────────────┘

I verified the running game in headless Chromium and real GPU Chrome, which caught five bugs that a build alone would not have:

1. <Trees /> rendered 400 Rapier colliders outside <Physics> — hard crash on load.
2. WIND_DISPLACEMENT declared uniforms the grass shader also declared — GLSL redefinition error.
3. TreeSpeciesGroup read instances[cursor] before wrapping the cursor — out-of-bounds after any quality downshift.
4. detectWebGL2() leaked a WebGL context on every call (browsers cap these at 16 and evict the oldest).
5. Grass blades were 1 metre wide — I'd built the strip in normalised space and never applied GRASS_BLADE_WIDTH.

I also found and fixed two world-gen bugs via the self-test: the world-edge rim was applied after the railway grading (burying the track under a hill near the map edges), and mergeGeometries crashed on willows because IcosahedronGeometry is non-indexed while CylinderGeometry is indexed.

---
✅ What You Need To Do From Your Side

1. Push to GitHub

cd "E:\ROUGH CODING\Whispering Hollow A Living Village"
gh repo create whispering-hollow --private --source=. --push
# or: git remote add origin <url> && git push -u origin main

2. Deploy to Vercel

npx vercel          # first deploy
npx vercel --prod   # production

Or import the repo at https://vercel.com/new — Next.js is auto-detected, no build config needed. It will deploy and play correctly with no environment variables at all.

3. Firebase — entirely optional

The game is fully playable offline; progress saves to localStorage. Add Firebase only if you want cross-device sync, multiplayer or cloud screenshots.

- Create a project → add a Web app → copy the config
- Enable: Auth (Anonymous + Google), Firestore, Realtime Database, Storage, App Check (reCAPTCHA v3)
- cp .env.example .env.local and fill in — every variable is documented inline
- Add the same vars in Vercel → Settings → Environment Variables, then redeploy (NEXT_PUBLIC_* is inlined at build time)

Deploy the security rules — do not skip this. They're written and ready:

firebase deploy --only firestore:rules,firestore:indexes,database,storage

A Firestore database left in test mode is world-writable.

4. Google OAuth

Firebase → Authentication → Settings → Authorized domains → add your-app.vercel.app and any custom domain, or Google sign-in fails silently in production.

5. Optional extras

┌─────────────┬──────────────────────────────────────────────────────────────────────────────┐
│    Thing    │                                    Action                                    │
├─────────────┼──────────────────────────────────────────────────────────────────────────────┤
│ Sentry      │ Set NEXT_PUBLIC_SENTRY_DSN. Uses @sentry/browser — no wizard, no build       │
│             │ plugin.                                                                      │
├─────────────┼──────────────────────────────────────────────────────────────────────────────┤
│ Vercel      │ No token. Enable in Vercel → Project → Analytics.                            │
│ Analytics   │                                                                              │
├─────────────┼──────────────────────────────────────────────────────────────────────────────┤
│ PWA icons   │ Real PNGs already generated. npm run gen:icons to regenerate; replace        │
│             │ scripts/gen-icons.mjs's drawIcon() for your own art.                         │
├─────────────┼──────────────────────────────────────────────────────────────────────────────┤
│ Seed        │ export GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json && npm run    │
│ Firestore   │ seed                                                                         │
├─────────────┼──────────────────────────────────────────────────────────────────────────────┤
│ Manual      │ None. Confirmed — everything is procedural.                                  │
│ assets      │                                                                              │
└─────────────┴──────────────────────────────────────────────────────────────────────────────┘

6. Testing checklist

- 20-minute session watching for leaks — every one-shot audio voice routes teardown through SynthEngine.scheduleTeardown, and every geometry/material has a disposal effect
- Mobile viewport (playable, but no touch controls — see below)
- Potato preset on a low-end machine
- Offline: load once, go offline, reload — the core scene works because nothing is fetched

---
⚠️ Known limitations

- WebGPU is not enabled. Detection is in place behind NEXT_PUBLIC_ENABLE_WEBGPU, but the game runs on WebGL2 — the R3F WebGPU renderer doesn't yet support GodRays, N8AO or custom Effect subclasses.
- Safari: HRTF panning is expensive (toggle it off in Settings → Audio); AudioContext needs a user gesture, which is why it's created in the "click to explore" handler — keep that if you restructure the entry flow. No pointer lock on iOS.
- Firefox: no unadjustedMovement pointer lock, so mouse feel differs slightly.
- Mobile: playable but there are no touch controls — a virtual stick is the obvious next addition.
- Software rendering (headless CI, no GPU): the scene is heavy enough to lose the WebGL context after ~30s. Doesn't affect real hardware.

---
Four deliberate deviations from the spec

Each documented in README.md § Deviations, with reasoning:

┌─────────────────┬──────────────────────┬───────────────────────────────────────────────────┐
│      Spec       │        Built         │                        Why                        │
├─────────────────┼──────────────────────┼───────────────────────────────────────────────────┤
│ next-pwa        │ Hand-written         │ Hasn't kept pace with App Router; injects a       │
│                 │ public/sw.js         │ Workbox build step                                │
├─────────────────┼──────────────────────┼───────────────────────────────────────────────────┤
│                 │                      │ Built around locale-prefixed routing — machinery  │
│ next-intl       │ Dictionary layer     │ for a problem a single-route client app doesn't   │
│                 │                      │ have                                              │
├─────────────────┼──────────────────────┼───────────────────────────────────────────────────┤
│ @sentry/nextjs  │ @sentry/browser      │ Needs a build plugin + wizard config before the   │
│                 │                      │ project will build                                │
├─────────────────┼──────────────────────┼───────────────────────────────────────────────────┤
│ /shaders/*.glsl │ /shaders/*.glsl.ts   │ Raw shader imports need separate Turbopack and    │
│                 │                      │ Webpack loaders                                   │
└─────────────────┴──────────────────────┴───────────────────────────────────────────────────┘

Everything else is implemented as written — including the full 40-second train ritual, the zero-file audio engine, all four seasons, seven weather states, 40 discoveries, 20 achievements, photo mode and ambient multiplayer.

Start here: config/game.ts holds every tunable number in the game, grouped and documented. Change something there, then run npm run verify to confirm you haven't broken world generation.

✻ Worked for 56m 0s

※ recap: Whispering Hollow is fully built, verified, and committed to git — typecheck, lint, build, and browser rendering all pass. Next action is yours: push to GitHub and deploy to Vercel, which works with no environment variables. (disable recaps in /config)