# 🌄 ULTRA-DETAILED BUILD PROMPT — "Whispering Hollow: A Living Village"

## 🎯 Role & Mandate

You are a **senior full-stack creative engineer** with deep expertise in **Next.js 15 (App Router) + React 19**, **React Three Fiber (R3F) + drei + react-three/postprocessing**, **GLSL shaders**, **Web Audio API procedural synthesis**, **Firebase (Auth + Firestore + Realtime Database + Storage)**, and **Zustand** state management. You are building a **portfolio-grade, cinematic, deeply immersive first-person 3D village experience** called **"Whispering Hollow"** — a living, breathing, customizable countryside world where a train ritually passes through a golden-hour valley.

Ship this as a **production-ready Next.js application** — not a single HTML file. Optimize aggressively for 60 FPS on mid-range laptops and 30+ FPS on modern mobile. Every technical decision must serve **immersion, beauty, and playability**.

---

## 🧱 TECH STACK (locked)

**Frontend**
- **Next.js 15.x** (App Router, TypeScript, Turbopack dev)
- **React 19**
- **@react-three/fiber** (latest) — declarative Three.js
- **@react-three/drei** — helpers (Sky, Environment, Instances, PointerLockControls, useTexture, Html, KeyboardControls, Stats, PerformanceMonitor)
- **@react-three/postprocessing** — Bloom, SSAO, DepthOfField, Vignette, ChromaticAberration, ToneMapping, GodRays, SMAA
- **three** (peer, latest stable) with **WebGPU renderer** where supported, WebGL2 fallback
- **three-stdlib**, **maath** (math utils), **simplex-noise** (terrain), **leva** (dev-only debug HUD, tree-shaken in prod)
- **Zustand** (game state), **valtio** (proxied ui state for HUD)
- **framer-motion** for HUD/menu transitions
- **Tailwind CSS v4** + **shadcn/ui** for menu/settings UI
- **GSAP** for cinematic camera intros
- **Howler.js is FORBIDDEN** — all audio must be raw **Web Audio API** (procedural)

**Backend (Firebase)**
- **Firebase Auth** — anonymous + Google sign-in
- **Firestore** — user profiles, saved worlds, unlocked cosmetics, screenshot gallery metadata
- **Realtime Database** — optional lightweight multiplayer (see §11) — presence, ghost avatars, shared time-of-day
- **Firebase Storage** — user screenshot uploads
- **Firebase App Check** (reCAPTCHA v3) for abuse protection
- **Firebase Hosting** for the static/edge deployment (or Vercel if user prefers — support both)

**Extra**
- **@vercel/analytics** + **Sentry** for prod telemetry
- **PWA** via `next-pwa` — installable, offline-capable core scene
- **i18n**: next-intl (English default; scaffold for ES/JA/DE/HI)

---

## 🗺️ 1. WORLD DESIGN — "The Living Valley"

Not just terrain — an ecosystem with **7 distinct biome pockets** in one seamless map (~400×400 world units, expanded from 200):

| Zone | Character |
|---|---|
| **Village Heart** | 8–10 cozy houses, cobblestone plaza, working water well, hanging lanterns, market stalls with fluttering cloth awnings |
| **Meadow Fields** | Waist-high wind-animated grass shader (GPU instanced, 500k+ blades via `InstancedBufferGeometry`), poppy + daisy + lavender patches |
| **Ancient Grove** | 8–12 large gnarled trees with hand-authored twisted trunks, hanging moss, mushroom rings, firefly swarms at dusk |
| **The Ridge** | Elevated viewpoint with a stone bench, wind-chime that reacts to wind speed, panoramic vista, a lone flag |
| **Rail Corridor** | Curving railway, level crossing, small station shelter with bench and vintage clock, telegraph poles with sagging wires |
| **Brook & Pond** | Flowing procedural stream (custom flow-map shader) feeding a reflective pond (real-time cubemap reflection, water caustics), lily pads, dragonflies, jumping fish particles |
| **Wheatfield & Windmill** | Golden wheat swaying in coherent wind gusts, a spinning windmill with creaking rotational sound |

**Terrain generation**
- Base heightmap: **fBm simplex noise** (5 octaves) + domain warping for organic curves
- Overlaid **hydraulic erosion pass** (baked at build time via web-worker, cached to Firestore per seed) for realistic ridges and gullies
- **Triplanar splatmap shader** blends 4 textures: grass, dirt, rock, sand (near brook) — no visible tiling, blended by slope + altitude + noise
- **Vertex-colored** for cheap AO in valleys

**Vegetation system**
- 400+ trees via **InstancedMesh with per-instance frustum culling + LOD** (3 tiers: high-poly ≤30m, medium 30–80m, billboard >80m)
- 6 tree species (oak, birch, pine, willow, cherry-in-bloom, dead-tree-with-crows) each with 3 shape variations and per-instance hue/scale jitter
- **Wind shader** — global uniform `uWindDirection` + `uWindStrength` — every plant sways coherently; strong gusts propagate as a visible ripple across the field
- Grass, flowers, mushrooms, fallen leaves: **instanced quads with alpha-tested textures** procedurally generated on the GPU at load

**Sky & atmosphere**
- **Custom shader sky** with time-of-day system (see §4) — Rayleigh + Mie scattering approximation
- **Volumetric fog** (exponential + height-based) tinted by sun color
- **God rays** through trees via `GodRays` post-effect
- **8–12 low-poly clouds** drifting on real wind vector, casting soft shadows on terrain via projected texture

---

## 🚂 2. THE TRAIN — Emotional Centerpiece

Reimagined as a **ritual event** every 90–120 seconds (configurable), not a background prop:

**Approach sequence (fully cinematic, 25-second arc)**
1. **T-20s**: Distant birds startle and scatter from trees near the track. Cattle-like low mooing (if you add cows — yes, add 3–4 cows in a fenced paddock)
2. **T-15s**: First distant horn — deep, plaintive two-tone chord (major 3rd, ~110Hz + 138Hz), heavy reverb, panned centrally, low-pass filtered heavily
3. **T-10s**: Level crossing awakens — **ding-ding-ding bell**, red LED lights blink alternately, striped barrier lowers smoothly with servo-like easing + creak sound
4. **T-8s**: Rails begin to hum (subtle sine sweep in bass)
5. **T-6s**: Ground trembles — camera shake amplitude grows with proximity (perlin-noise driven, gentle)
6. **T-3s**: Steam column visible on horizon, silhouette emerges from fog
7. **T-0**: Locomotive bursts past — **chuff-chuff** rhythm (filtered noise bursts synced to piston frequency), whistle scream, sparks (particle system) from wheels on rails
8. **Wagons**: 5–8 varied cars — passenger coach with glowing windows and silhouetted passengers, cargo container with graffiti, flatbed with logs, oil tank, cattle car, mail car with lantern
9. **Doppler pass**: Full HRTF PannerNode — pitch shifts down as it recedes (real Doppler effect via `Math.abs(velocity)` projection onto listener vector)
10. **T+8s**: Departing horn, quieter, mournful
11. **T+15s**: Barrier raises, bell stops, birds return
12. **T+20s**: World falls quiet again — only wind and crickets

**Train visual details**
- Locomotive: authored low-poly with boiler, funnel (chimney), cab, driving wheels, connecting rods that **rotate correctly** with wheel angular velocity, emissive firebox glow, animated steam plume (billboard particles)
- Headlight: **SpotLight with volumetric cone shader** (raymarched or additive cone geometry) — cuts through fog beautifully at night
- Wheels spin at correct linear-velocity ratio, sleepers pass beneath at matching cadence
- Slight bogie bounce and side-sway (2 sines out of phase)
- Each wagon has unique livery — **7 wagon color palettes** unlockable via achievements

**Track**
- Bezier-curve path through world; use `CatmullRomCurve3` for smooth train motion
- Twin rails: extruded shapes along curve, glossy metallic material
- ~120 wooden sleepers instanced along curve, gravel bed with instanced pebble geometry

---

## 🎮 3. PLAYER, CONTROLS & CUSTOMIZATION

**First-person controller (physics-lite)**
- Custom controller (do NOT use FirstPersonControls — build with PointerLockControls + capsule collider via `@react-three/rapier`)
- **Rapier physics** for terrain following, tree/house collision, stair-stepping over rocks
- WASD walk, Shift sprint (stamina bar drains, recovers when idle), Space jump (with landing dust puff particle), C crouch (reduces height + slows), F to interact (see below)
- **Head-bob**: dual-sine (vertical + horizontal Lissajous), amplitude scales with speed, damped when sprinting
- **Footstep system**: 4 surface types (grass, dirt path, cobblestone, wooden bridge) each with unique synth pattern; detects surface via raycast to terrain material ID
- Camera FOV breathes when sprinting (70° → 78°, GSAP eased)
- Optional **third-person shoulder view** (toggle V) with over-the-shoulder camera + visible avatar

**Third-person avatar (customizable)**
- Simple low-poly stylized character (blocky Zelda-Wind-Waker vibe)
- **Customization panel** (opens with Tab):
  - Skin tone (5 options), hair style (6) + color (10), outfit (8 sets), hat (12 including farmer straw, adventurer cap, wizard, none), backpack (5), lantern held in hand (toggle — actual PointLight that swings while walking)
- Persisted to Firestore per user

**Interactables** (press F when reticle highlights)
- Ring the church bell → triggers birds to scatter across map
- Sit on ridge bench → cinematic camera locks, player POV lowers, time speeds up 3× until player stands
- Read signposts → floating readable notes with village lore (write 8 short lore fragments — mysterious, wistful)
- Pick flowers → adds to inventory, can be placed as a bouquet on well or graves in the tiny cemetery behind the church
- Feed cows/chickens (buy grain from a stall for coins earned by exploration achievements)
- Skip stones at the pond (mini-game with power meter, up to 7 skips, ripples generated on water shader)
- Feed the fish → fish surface, splash particles + Foley
- Wake the sleeping cat on a windowsill → it stretches and meows

---

## 🌅 4. DYNAMIC TIME, WEATHER & SEASONS (killer differentiator)

**24-hour cycle** compressed to 12 real minutes (configurable, or pause on any time). Sun + moon on separate orbits, star field emerges after dusk (**3000+ instanced stars** with subtle twinkle shader, Milky Way band texture procedurally generated).

**5 lighting states** blend smoothly:
1. **Dawn** — pink-orange, mist hugs valleys, roosters crow
2. **Golden Morning** — long warm shadows, dewy shader on grass (specular sparkles)
3. **Bright Noon** — high sun, sharp shadows, cicadas
4. **Golden Hour** ⭐ default — the money shot
5. **Dusk → Night** — house windows glow warmer, lanterns ignite, fireflies appear, moonlight cool-blue, crickets swell

**Weather system** (Perlin-driven or user-selected):
- **Clear** / **Cloudy** / **Light Rain** (particle rain + wet material shader boost + ripples on puddles + rain-on-leaves audio) / **Heavy Rain + Thunder** (screen flash + delayed thunder crack synth) / **Snow** (in Winter) / **Fog Dense** (mysterious mode) / **Autumn Wind** (leaves swirl)

**4 seasons** (user toggle, or auto-rotate over sessions):
- **Spring**: cherry blossoms, baby lambs, flower blooms, warm greens
- **Summer**: golden wheat, butterflies, brighter light, dry-grass texture blend
- **Autumn**: orange/red/yellow tree color swap, falling leaves swirl on wind, pumpkins by houses
- **Winter**: snow accumulation shader on all upward-facing polygons, icicles on eaves, frozen pond, breath-vapor from player's mouth, muted colors, dry-wood smoke rises higher

Each season also swaps the ambient audio bed accordingly.

---

## 🔊 5. AUDIO — Procedural, Spatial, Cinematic

**Absolute rule: zero audio files.** All synthesized via Web Audio API graph nodes. Build a modular `SynthEngine` class with reusable voice presets.

**Master graph**
```
[Sources] → [3D PannerNode (HRTF)] → [Per-source lowpass] → [Bus mixer] 
         → [ConvolverNode with procedural IR (village outdoor reverb)] 
         → [Master compressor] → [Master gain] → [Destination]
```

**Sound library (all procedural)**
- **Wind**: pink noise → bandpass (300–1500Hz swept by slow LFO) → gain modulated by wind speed uniform
- **Leaves rustling**: filtered white noise bursts, density tied to wind
- **Birds**: 5 species, each with characteristic pitch envelope (robin=trilling, sparrow=short chirps, owl=long low hoots after dusk, crow=harsh sawtooth caw, cuckoo=famous 2-note interval). Randomized timing, positioned in trees, HRTF panned
- **Crickets**: dense cluster of narrow-band noise pulses at ~4kHz, phase-offset
- **Frogs**: at pond only, low croaks with formant filter
- **Church bell**: additive synth (fundamental + inharmonic partials for real bell timbre) with long exponential decay + reverb
- **Windmill**: creaking wood (filtered impulse train) synced to rotation
- **Water stream**: layered filtered pink noise + high bubbling sines
- **Footsteps**: per-surface — grass (soft high noise burst), dirt (mid burst + subtle thud), cobble (short click + reverb tail), wood (resonant thump)
- **Train horn**: two detuned sawtooth oscillators (110Hz + 138Hz, +0.5% detune each for beating) → lowpass → distortion → long reverb
- **Chugging**: gated pink noise pulses at BPM tied to wheel RPM, plus a steam hiss between chugs
- **Rolling rumble**: filtered brown noise, cutoff proportional to speed
- **Sparks**: short bright noise transients
- **Crossing bell**: bright square wave 880Hz → envelope → repeated
- **Thunder**: pink noise + slow amplitude envelope + pitch-shifted rumble tail
- **Rain**: dense filtered white noise (rain-on-leaves = brighter, rain-on-water = wetter mid-range)
- **Interaction UI**: soft marimba-like FM plinks for menu clicks

**Spatial audio**
- Every source uses `PannerNode` with `panningModel: 'HRTF'`, `distanceModel: 'inverse'`, custom refDistance and rolloff per source
- Listener updates with camera position + forward + up every frame
- Velocity-based Doppler for train

**Adaptive music (bonus)**
- Generative ambient music layer using tonal FM synthesis — a slow arpeggiator in D-mixolydian, chords shift with time-of-day (morning=bright major, night=minor 7ths). Volume duck when train arrives.
- Toggle in settings.

**Volume UI**
- Master, ambient, wildlife, train, footsteps, music — six sliders in settings menu

---

## ✨ 6. VISUAL POLISH — Postprocessing Pipeline

Stack (in order, all via `@react-three/postprocessing`):
1. **SSAO** (Screen Space Ambient Occlusion) — grounds objects, deepens crevices
2. **Bloom** — selective on emissive materials (windows, lanterns, sun, firebox, fireflies, LED crossing lights)
3. **God Rays** — from sun through tree canopies
4. **Depth of Field** — subtle, focuses on reticle target when standing still (5s idle timer)
5. **Chromatic Aberration** — very subtle (0.0005) at screen edges
6. **Vignette** — soft dark corners
7. **ACES Filmic Tone Mapping** in renderer, exposure adjustable in settings
8. **SMAA** anti-aliasing
9. **Color LUT** — 4 presets: "Golden Hour" (default warm), "Storybook" (saturated pastel), "Cinematic" (teal/orange), "Nostalgic Film" (desaturated + slight grain)

Optional: **motion blur** on train wheels, **screen-space reflections** on pond only.

---

## ⚙️ 7. CUSTOMIZATION & SETTINGS PANEL

Elegant slide-in panel (right side, framer-motion, glassmorphism, Tailwind + shadcn) — press **Esc** or menu button.

**Tabs**:

**🌍 World**
- Time of day (slider + presets)
- Weather (dropdown)
- Season (4 buttons)
- Wind strength (slider)
- Fog density (slider)
- Train frequency (30s → 5min)
- World seed (regenerates terrain)
- Village size (small/medium/large)

**🎮 Gameplay**
- Walk speed, sprint multiplier, jump height, mouse sensitivity, invert Y, FOV (60–100)
- Enable/disable head-bob
- Third-person toggle
- Show reticle
- Interaction prompts on/off

**🎨 Graphics**
- Presets: Potato / Low / Medium / High / Cinematic / Custom
- Resolution scale (0.5×–1.5×)
- Shadow quality (off / low / medium / high / ultra with PCSS)
- Grass density, tree LOD distance
- Post-processing individual toggles
- Color LUT
- Target FPS (30/60/120/unlimited)
- **Auto-adaptive quality** via `PerformanceMonitor` — dynamically downscale when FPS drops

**🔊 Audio**
- 6 volume sliders, ambient music toggle, HRTF toggle

**👤 Character**
- Full avatar customization

**🕹️ Controls**
- Rebindable keys (persisted to Firestore)

**♿ Accessibility**
- Reduced motion (disables head-bob, camera shake, DoF)
- High contrast HUD
- Subtitle-style audio labels for deaf players ("🐦 bird chirps to your left")
- Colorblind LUT filters
- Adjustable UI scale

---

## 🎯 8. PROGRESSION, DISCOVERIES & PLAYABILITY

Turn ambient wandering into a **soft-goal exploration loop** — no fail states, but rich reward.

**Discoveries (30+ hidden collectibles)**
- 10 **journal fragments** scattered — reading all unlocks a bittersweet ending narration
- 12 **birdwatching entries** — approach each species without startling them, unlocks species in Codex
- 5 **hidden viewpoints** — panoramic screenshots auto-saved to gallery
- **The night visitor** — a fox that appears only past 11pm on the dirt path if the player is silent
- **The message in a bottle** in the pond
- **Sky lanterns festival** — happens once per real hour if player is at the ridge at dusk

**Achievements (Firestore-synced)**
- "Golden Hour Wanderer" — 10 min walking at dusk
- "Train Chaser" — witness 10 train passes
- "Village Photographer" — take 20 screenshots
- "Silent Friend" — get within 3m of the fox
- ~20 total, each unlocks a cosmetic (hats, avatar outfits, custom LUTs, secret wagon liveries)

**Screenshot mode** (press **P**)
- Camera detaches, free-fly with hidden HUD
- Filters, aspect ratio, focal length, aperture (real DoF), roll angle
- Save to Firebase Storage, browse personal gallery, share via public link
- Optional in-world **camera prop** the avatar holds

**Coins & lore**
- Explore corners → find coins → spend at stalls on trinkets that appear on hut window sills (persisted world decoration per user)

---

## 🌐 9. OPTIONAL LIGHTWEIGHT MULTIPLAYER (Firebase Realtime Database)

Don't build full networked physics — build **ambient presence**:
- Up to **8 players per shared world instance**
- Each sees others as **ghost avatars** (semi-transparent, colored per-user) walking around
- Position + rotation synced at 10Hz (throttled) via Realtime Database ephemeral nodes
- Shared world state: time-of-day democratically averaged, weather set by "host" (first joiner)
- **Emote wheel** (E key): wave, sit, point, cheer, shrug — visible to others
- **Proximity spatial voice chat** disabled by default; scaffold WebRTC via Firestore signaling as optional module (behind feature flag)
- **Public / Private / Solo** modes selectable at world creation

Presence uses `.onDisconnect()` handlers for clean removal.

---

## 🔒 10. FIREBASE ARCHITECTURE

**Firestore schema**
```
users/{uid}
  profile: { displayName, avatarConfig, createdAt, totalPlaytime }
  achievements: { [id]: unlockedAt }
  discoveries: { [id]: foundAt }
  settings: { graphics, audio, controls, ... }
  savedWorlds: [{ id, seed, name, thumbnailUrl }]

screenshots/{screenshotId}
  ownerUid, worldSeed, storagePath, publicUrl, capturedAt, likes, isPublic

worlds/{worldId}
  seed, hostUid, weather, timeOfDay, season, playerCount, isPublic, createdAt

worldPresence/{worldId}/players/{uid}   [Realtime DB]
  x, y, z, rotY, emote, avatarColor, lastSeen
```

**Security rules**: user-scoped writes, public reads for opted-in screenshots, presence auto-expires 30s after `lastSeen`.

**Auth flow**: anonymous auto-signin on first load → offer Google upgrade to preserve progress across devices.

---

## 📁 11. PROJECT STRUCTURE

```
/app
  layout.tsx, page.tsx, globals.css
  (game)/play/page.tsx           ← the R3F canvas
  (menu)/page.tsx                ← main menu / world select
  (auth)/login/page.tsx
  api/                           ← server actions if needed
/components
  /scene
    World.tsx, Terrain.tsx, Sky.tsx, Water.tsx, Trees.tsx, Grass.tsx,
    Village/House.tsx, Village/Well.tsx, Village/Windmill.tsx,
    Train/Locomotive.tsx, Train/Wagon.tsx, Train/Track.tsx, Train/Crossing.tsx,
    Wildlife/Birds.tsx, Wildlife/Butterflies.tsx, Wildlife/Fireflies.tsx, Wildlife/Fox.tsx,
    Weather/Rain.tsx, Weather/Snow.tsx, Weather/Clouds.tsx
  /player
    PlayerController.tsx, Avatar.tsx, HeadBob.tsx, Stamina.ts
  /audio
    SynthEngine.ts, sources/*.ts, useSpatialAudio.ts
  /postfx
    PostProcessing.tsx
  /hud
    Crosshair.tsx, StaminaBar.tsx, InteractPrompt.tsx, Compass.tsx, Subtitles.tsx
  /menu
    SettingsPanel.tsx, CharacterPanel.tsx, WorldPicker.tsx, Achievements.tsx, ScreenshotGallery.tsx
/lib
  firebase.ts, auth.ts, firestore.ts, rtdb.ts, storage.ts
  terrain/generate.ts, terrain/erosion.worker.ts
  utils/curve.ts, utils/random.ts, utils/perf.ts
/hooks
  useKeyboard.ts, usePointerLock.ts, useTimeOfDay.ts, useWeather.ts, useAchievement.ts
/store
  gameStore.ts (zustand), settingsStore.ts, presenceStore.ts
/shaders
  grass.vert, grass.frag, water.vert, water.frag, sky.frag, wind.glsl, triplanar.glsl
/public
  favicon, manifest.json (PWA)
```

---

## 🎬 12. FIRST-RUN CINEMATIC & ONBOARDING

- Loading screen: animated logo (blowing dandelion seeds), progress bar (real asset-load progress), rotating village silhouette in background
- On ready: 8-second GSAP camera flyover of the village (over rooftops → down the dirt path → land into first-person)
- Overlay hints fade in sequentially and dismiss on use: "Click to explore", "WASD / Mouse", "Shift to run", "F to interact", "P for screenshot"
- Skippable

---

## 📊 13. PERFORMANCE MANDATES

- Target 60 FPS on Apple M1 / GTX 1650 / integrated Iris Xe
- Instance EVERYTHING repeated (grass, trees, rocks, sleepers, stars, particles)
- **Frustum culling** on custom InstancedMesh via spatial hash grid
- **LOD** on trees, houses, train wagons
- Shadow map: cascaded (CSM via drei) with tight frustums, 2048² max
- Reflection cubemap on pond updated at 15 Hz max, quarter-resolution
- Offload terrain + erosion to **Web Workers**
- Use **`useFrame` throttling** for non-critical animations (bird flap = 30Hz, cloud drift = 10Hz)
- Baked static shadows for houses onto terrain (cheap decal)
- **PerformanceMonitor** from drei auto-downshifts quality tier
- Ship < 500KB initial JS (code-split scene from menu), < 3s TTI on cable

---

## ✅ 14. DELIVERY CHECKLIST — What Claude Code must output

1. Complete Next.js 15 App Router project, TypeScript strict mode, all files above
2. Working ESLint + Prettier + Tailwind + shadcn init
3. Fully typed Zustand + valtio stores
4. Firebase client + admin config placeholders (`.env.example`)
5. Working procedural terrain, all 7 biome zones, train loop, day/night, weather, seasons, audio engine, HUD, settings panel, avatar customization, screenshot mode, achievements
6. Multiplayer scaffolded and toggleable via feature flag (fully functional presence)
7. PWA manifest + service worker
8. `README.md` with setup, Firebase console steps, deployment guide (Vercel + Firebase Hosting both)
9. Rich JSDoc on every exported symbol; inline comments explaining shader math and audio DSP
10. All tunable numbers in a **central `/config/game.ts`** with grouped, documented constants
11. **No console errors, no memory leaks** — validate with 20-minute stress test
12. Debug HUD (leva) auto-hidden in production build
13. Graceful fallbacks: no WebGPU → WebGL2; no pointer lock → warn; no WebAudio → silent mode; slow device → auto-low preset
14. Full accessibility pass

---

## 📋 15. FINAL "HAND-OFF" REPORT — Claude Code MUST output this at the end

After building, Claude Code must print a clearly formatted **"What You Need To Do From Your Side"** section covering:

1. **Firebase setup**: create project, enable Auth (anonymous + Google), Firestore, Realtime DB, Storage, App Check; paste config into `.env.local` (list every env var needed)
2. **Firebase security rules**: paste rules → Firestore + RTDB + Storage consoles
3. **Google OAuth**: authorized domains
4. **Deployment**: `npm run build`, deploy commands for Vercel AND Firebase Hosting
5. **Domain / DNS** steps if custom domain
6. **Sentry DSN** + Vercel Analytics token entry
7. **PWA icons**: sizes & how to replace placeholder icons
8. **Any manual asset drops** (none expected — everything procedural — but confirm)
9. **How to seed initial achievements/lore JSON** into Firestore (provide a `scripts/seed.ts` command)
10. **Testing checklist**: 20-min stress test, mobile viewport check, low-end preset check, offline PWA check
11. **Known limitations** on Safari (WebGPU, HRTF quirks) and workarounds

---

## 🎨 TONE & CREATIVE DIRECTION (do not compromise)

Every decision defers to this vibe: **"A Studio Ghibli storyboard rendered in real-time — nostalgic, quiet, slightly magical, deeply peaceful, but always alive."** No dark themes, no violence, no jump scares. The train is not menacing — it is **ritual**, a moment of awe. The world is a place to breathe.

**Now build it. Ship the entire codebase. End with the hand-off report.**
