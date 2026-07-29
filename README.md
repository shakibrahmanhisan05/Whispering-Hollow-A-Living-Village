# 🌄 Whispering Hollow — A Living Village

A quiet, living countryside valley you can walk through, rendered in real time in the browser.
Real-time weather, a full day/night cycle, four seasons, procedurally generated terrain — and a
train that passes through the golden-hour valley like a ritual.

**Zero art assets.** Every texture, every sound, every piece of geometry in this project is
generated at runtime from code. There is not a single `.png`, `.glb` or `.mp3` in the repository.

---

## Contents

- [Quick start](#quick-start)
- [What's in the box](#whats-in-the-box)
- [Controls](#controls)
- [Project structure](#project-structure)
- [Architecture notes](#architecture-notes)
- [Firebase setup](#firebase-setup) *(optional)*
- **[SETUP.md](./SETUP.md) — step-by-step setup guide**
- [Deploying](#deploying)
- [Performance](#performance)
- [Accessibility](#accessibility)
- [Translating](#translating)
- [Known limitations](#known-limitations)
- [Deviations from the original spec](#deviations-from-the-original-spec)

---

## Quick start

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. That's it — **no configuration is required**. The game runs
completely offline; progress, settings and screenshots are saved to `localStorage`.

Adding Firebase credentials later upgrades that to cloud sync and multiplayer without any
code changes. See [Firebase setup](#firebase-setup).

### Other commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server (Turbopack) |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm run verify` | **World-generation self-test** — see below |
| `npm run gen:icons` | Regenerate the PWA icons |
| `npm run seed` | Seed reference data into Firestore |

### `npm run verify`

A headless self-test for everything that doesn't need a GPU: terrain generation, layout
carving, vegetation placement, procedural geometry and the PRNG. Run it after changing
anything in `config/game.ts` — a bad tuning constant almost always shows up here as a NaN or
an out-of-range height long before it shows up as a visual glitch.

```
✅  All 29 checks passed.
```

---

## What's in the box

### The world

- **Procedural terrain** — 400 × 400 units, 5-octave fBm simplex noise with domain warping,
  followed by a **hydraulic erosion pass** (60 000 simulated water droplets) that carves
  connected drainage networks. Runs in a Web Worker so the loading screen stays at 60 FPS.
- **Seven biome pockets** — Village Heart, Meadow Fields, Ancient Grove, The Ridge, Rail
  Corridor, Brook & Pond, Wheatfield & Windmill.
- **Triplanar splatmap terrain shader** blending grass / dirt / rock / sand with no visible
  tiling, plus snow accumulation and rain wetness.
- **GPU-instanced grass** — streamed in 20 m chunks around the player, with two-sided
  translucent shading that makes the meadow glow when you look toward a low sun.
- **420 trees** across six species, three shape variations and three LOD tiers, all
  procedurally generated with recursive branching.
- **Reflective pond** with a real-time planar reflection probe, caustics, foam and ice in
  winter; plus a **flowing brook** driven by a flow map.

### The train

A 40-second staged event, not a background prop. Twenty seconds before it arrives the birds
by the track go up — before you have heard anything.

```
 T−20  Birds scatter. Cattle low.
 T−15  The first horn — distant, heavily low-passed, drenched in reverb.
 T−10  The crossing wakes: bell, alternating lamps, barrier descends.
 T−8   The rails begin to hum.
 T−6   The ground trembles.
 T−3   Steam on the horizon.
 T−0   It passes.
 T+8   The departing horn.
 T+15  The barrier lifts. Birds return.
 T+20  Quiet.
```

The locomotive's **connecting rods are driven by the wheel angle**, the chuff rate *is* the
wheel angular velocity, and the whole thing Dopplers correctly as it goes past.

### Everything else

- **Day/night cycle** — 24 h compressed to 12 real minutes, five blended lighting states,
  3200 instanced stars with a procedurally generated Milky Way band.
- **Weather** — seven states that drift on a continuous noise walk, so conditions always
  evolve through their neighbours rather than teleporting from sunshine to thunderstorm.
- **Four seasons** with foliage colour, snow, ice, wildlife density and audio changes.
- **Procedural audio** — a complete Web Audio synthesis engine. Five bird species, crickets,
  frogs, wind, water, a church bell built from inharmonic partials, footsteps that change with
  the ground under your feet, and a generative ambient score in D mixolydian.
- **Wildlife** — birds with a real startle/flight/landing state machine, fireflies, butterflies,
  dragonflies, jumping fish, cattle, chickens, a windowsill cat and a fox that only appears
  after 23:00 if you move quietly.
- **40 discoveries**, 20 achievements with cosmetic unlocks, 10 journal fragments, a bird codex.
- **Photo mode** with focal length, aperture, roll and aspect-ratio controls.
- **Ambient multiplayer** — up to 8 ghost avatars, emotes, presence over Realtime Database.

---

## Controls

| Key | Action |
|---|---|
| `W` `A` `S` `D` | Walk |
| Mouse | Look |
| `Shift` | Sprint (drains stamina) |
| `Space` | Jump |
| `C` / `Ctrl` | Crouch |
| `F` | Interact |
| `V` | Toggle third-person |
| `P` | Photo mode |
| `Tab` | Character panel |
| `E` | Emote wheel |
| `J` | Journal |
| `M` | Bird codex |
| `L` | Toggle lantern |
| `Esc` | Settings / pause |

All bindings are rebindable in **Settings → Controls**.

---

## Project structure

```
app/
  (menu)/page.tsx        Entry point — loads the game client-side only
  layout.tsx             Root layout, metadata, PWA wiring
  globals.css            Design tokens + Tailwind v4 theme
components/
  audio/                 SynthEngine + voice modules (zero audio files)
  game/GameShell.tsx     Phase machine, canvas, input routing, panels
  hud/                   Crosshair, stamina, compass, toasts, subtitles
  menu/                  Main menu, settings, achievements, gallery, photo UI
  multiplayer/           Ghost avatars + nameplates
  player/                Controller, avatar, interactions, photo mode
  postfx/                Effect pipeline + custom colour-grade effect
  scene/                 Terrain, sky, water, vegetation, weather, village, train
  system/                Telemetry, service worker registration
  ui/primitives.tsx      Radix-based UI primitives
config/game.ts           ⭐ Every tunable number in the game
hooks/                   Wind, time of day, weather, keyboard, pointer lock
lib/
  terrain/               Heightfield synthesis + erosion worker
  geometry/              Procedural trees, geometry merging
  textures/              Procedural texture synthesis
  world/layout.ts        Hand-authored landmarks (railway, pond, ridge, roads)
  progression/content.ts Lore, birds, achievements, viewpoints, signposts
  firebase.ts auth.ts firestore.ts rtdb.ts storage.ts
shaders/                 GLSL as tagged template literals
store/                   zustand (durable state) + valtio (HUD state)
scripts/                 Icon generator, Firestore seeder, world self-test
```

**`config/game.ts` is the file to open first.** Every tunable number in the game lives there,
grouped and documented — world size, erosion parameters, the train timeline, player movement
feel, audio levels, quality presets. Nothing elsewhere contains a bare magic number.

---

## Architecture notes

A few decisions worth knowing about before you change things.

**Two state libraries, on purpose.** `zustand` holds durable, low-frequency state
(progression, settings, session). `valtio` holds the HUD state that changes every frame
(stamina, heading, interact target). valtio tracks which properties a component actually
*read* and only re-renders on those — so the stamina bar re-renders on stamina and the compass
on heading, and neither disturbs the other. With one store, every per-frame write would
re-render the whole HUD 60 times a second.

**Simulation state lives outside React.** Wind, lighting and player state are module-level
mutable singletons read directly inside `useFrame`. Publishing them through React state would
mean re-rendering the tree at 60 Hz to communicate a float.

**One wind field drives everything.** Grass, wheat, trees, cloth awnings, the windmill, cloud
drift, the wind chime and the wind audio all read the same vector. That is why a gust crossing
the wheatfield also moves the trees and brightens the wind — the world responds as one place.

**GLSL lives in `.glsl.ts` files** as tagged template literals rather than raw `.glsl`.
Raw shader imports need a bundler loader, and Turbopack (dev) and Webpack (build) would each
need their own. Template literals work identically in both, survive HMR, and still get syntax
highlighting from the `glsl` tag.

**Firebase is entirely optional** and every service is lazily imported. With no credentials the
game is fully playable and saves locally; adding credentials lights up cloud sync and
multiplayer with no code changes.

---

## Firebase setup

**Everything below is optional.** Skip it and the game saves to `localStorage`.

### 1. Create the project

1. <https://console.firebase.google.com> → **Add project**
2. Add a **Web app** (`</>` icon). Copy the config object it shows you.

### 2. Enable the services you want

| Service | Where | Needed for |
|---|---|---|
| **Authentication** → Anonymous | Build → Authentication → Sign-in method | Any cloud saving |
| **Authentication** → Google | same page | Cross-device progress |
| **Firestore** | Build → Firestore Database → Create (production mode) | Progress, settings, screenshot metadata |
| **Realtime Database** | Build → Realtime Database → Create | Multiplayer presence |
| **Storage** | Build → Storage → Get started | Screenshot uploads |
| **App Check** | Build → App Check → Register with reCAPTCHA v3 | Abuse protection |

### 3. Fill in `.env.local`

```bash
cp .env.example .env.local
```

Then paste your values. Every variable is documented in `.env.example`.

```env
NEXT_PUBLIC_FIREBASE_API_KEY=…
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=…
NEXT_PUBLIC_FIREBASE_APP_ID=…
NEXT_PUBLIC_FIREBASE_DATABASE_URL=https://your-project-default-rtdb.europe-west1.firebasedatabase.app
NEXT_PUBLIC_FIREBASE_APPCHECK_SITE_KEY=…
NEXT_PUBLIC_ENABLE_MULTIPLAYER=true
```

### 4. Deploy the security rules

The rules are written and ready in this repo. **Do not skip this** — a Firestore database left
in test mode is world-writable.

```bash
npm i -g firebase-tools
firebase login
firebase use --add            # pick your project

firebase deploy --only firestore:rules,firestore:indexes,database,storage
```

Or paste them by hand:

| File | Where to paste it |
|---|---|
| `firestore.rules` | Firestore → Rules |
| `firestore.indexes.json` | Firestore → Indexes *(or let the console link create them)* |
| `database.rules.json` | Realtime Database → Rules |
| `storage.rules` | Storage → Rules |

### 5. Authorised domains for Google sign-in

Authentication → Settings → **Authorized domains** → add your production domain
(`your-app.vercel.app`, and any custom domain). `localhost` is there by default.

### 6. Seed the reference data *(optional)*

Puts achievement/lore definitions into a read-only `gameData` collection so you can query
progression from the console or build a dashboard.

```bash
# Project settings → Service accounts → Generate new private key
export GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json
npm run seed
```

---

## Deploying

### Vercel (recommended)

```bash
npm i -g vercel
vercel            # first deploy, follow the prompts
vercel --prod     # production
```

Or connect the GitHub repo at <https://vercel.com/new> — it detects Next.js automatically.

**Add your environment variables** in Project → Settings → Environment Variables (paste the
same values as `.env.local`). Redeploy after adding them; `NEXT_PUBLIC_*` variables are
inlined at build time, so changing them requires a rebuild.

Vercel Analytics needs no token — enable it in Project → Analytics.

### Firebase Hosting

Next.js App Router needs a static export for Firebase Hosting. Add to `next.config.ts`:

```ts
const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  // …
};
```

Then:

```bash
npm run build
firebase deploy --only hosting
```

`firebase.json` is already configured to serve `out/` with correct cache headers.

> The game is entirely client-side, so the static export loses nothing.

### Custom domain

- **Vercel** — Project → Settings → Domains → add, then set the `A` / `CNAME` records it shows.
- **Firebase** — Hosting → Add custom domain, then add the `TXT` and `A` records.

Add the new domain to Firebase **Authentication → Authorized domains** or Google sign-in will
fail on it.

---

## Performance

Targets 60 FPS on an M1 / GTX 1650 / Iris Xe, and 30+ on modern mobile.

- **164 kB first-load JS.** The entire 3D engine is code-split behind a dynamic import, so the
  menu loads before any of it is fetched.
- Everything repeated is instanced: grass, trees, sleepers, stars, rocks, cobbles, particles.
- Trees use three LOD tiers with a **round-robin update** — a slice of the instance list is
  re-evaluated each frame rather than all 420.
- Grass is **chunked and recycled**: crossing a chunk boundary re-fills the buffers that just
  went out of range rather than allocating new ones, so walking never triggers GC.
- Cloud drift, reflection probes and distant wildlife run on throttles (10–15 Hz).
- **Adaptive quality** steps the preset down after sustained low FPS and back up when there's
  headroom, with enough hysteresis that it never oscillates.

Quality presets: Potato / Low / Medium / High / Cinematic / Custom, all in
**Settings → Graphics**.

---

## Accessibility

- **Reduced motion** — disables head-bob, camera shake, depth of field, lightning flashes and
  the intro flyover. Also honours the OS `prefers-reduced-motion` setting.
- **Audio subtitles** — every significant sound gets a caption *with its direction*
  (`🐦 A robin sings ◀ left`). This matters more than usual here: the game's audio carries real
  information, like the birds going up before the train arrives.
- **High-contrast HUD** — solid backgrounds, no blur, stronger outlines.
- **Colourblind filters** — protanopia, deuteranopia and tritanopia, using daltonisation
  matrices that redistribute lost colour information into channels you *can* see rather than
  merely simulating the deficiency.
- **UI scale** from 75 % to 160 %.
- Full keyboard navigation and correct ARIA throughout, via Radix primitives.

---

## Translating

English is complete. Spanish, Japanese, German and Hindi are scaffolded in
`lib/i18n/dictionaries.ts` with a partial translation each.

Partial translations are **merged over English**, so you can translate a few strings at a time
and everything else falls back gracefully. To add a language, add its code to `LOCALES` and a
partial dictionary to `PARTIALS`.

---

## Known limitations

**WebGPU is not enabled.** `NEXT_PUBLIC_ENABLE_WEBGPU` exists and support is detected, but the
game runs on WebGL2. The R3F WebGPU renderer does not yet support the postprocessing stack this
project depends on (`GodRays`, `N8AO` and custom `Effect` subclasses are all WebGL-only). The
detection is in place for when that changes.

**Safari**

- HRTF panning is noticeably more expensive than on Chromium. If audio stutters, turn off
  **Settings → Audio → 3D spatial audio**; it falls back to equal-power panning.
- Safari requires a user gesture before *any* `AudioContext` will start. The game creates the
  context inside the "click to explore" handler for exactly this reason — if you restructure
  the entry flow, keep that.
- Pointer lock on iOS Safari does not exist. The game detects this and warns rather than
  silently breaking.

**Firefox** — `unadjustedMovement` pointer lock (which disables OS mouse acceleration) is
Chromium-only. Firefox gets standard pointer lock; aim feel will differ slightly.

**Mobile** — playable but there are no touch controls. The device tier detector opens on
Potato/Low. Adding a virtual stick would be the obvious next step.

**Software rendering** — under SwiftShader (headless CI, or a machine with no GPU
acceleration) the scene is heavy enough to lose the WebGL context after ~30 seconds. This does
not affect real hardware.

---

## Deviations from the original spec

Four, each for a concrete reason.

| Spec asked for | What was built | Why |
|---|---|---|
| `next-pwa` | Hand-written service worker (`public/sw.js`) | `next-pwa` has not kept pace with the App Router and injects a Workbox build step. The hand-written worker is ~120 lines, readable in one sitting, and does exactly what this app needs. |
| `next-intl` | Lightweight dictionary layer | `next-intl` is built around locale-prefixed routing — the whole app moves to `/[locale]/…` with middleware rewrites, to gain server-rendered translated HTML. This game has one route and renders entirely client-side, so that machinery solves a problem it does not have. |
| `@sentry/nextjs` | `@sentry/browser`, lazily imported | The Next SDK needs a build plugin, wizard-generated config and source-map upload credentials before the project will build. The browser SDK gives identical client-side error capture with one dynamic import and no build step. |
| `/shaders/*.glsl` | `/shaders/*.glsl.ts` | Raw `.glsl` imports need a bundler loader, and Turbopack and Webpack would each need their own configuration. Tagged template literals work identically in both and survive HMR. |

Everything else in the spec is implemented as written.

---

## Licence

Not specified — add one before publishing.
