# 🛠️ What You Need To Do From Your Side

Everything below is written so you can follow it top to bottom without prior context.

**The game already works.** You can run it right now with `npm run dev` — no accounts, no keys,
no configuration. Progress saves to your browser. Every section below is an *upgrade*, and each
one is independently optional.

---

## Contents

| # | Task | Required? | Time |
|---|---|---|---|
| [0](#0-run-it-locally) | Run it locally | — | 2 min |
| [1](#1-push-to-github) | Push to GitHub | For deploying | 5 min |
| [2](#2-deploy-to-vercel) | Deploy to Vercel | To go live | 5 min |
| [3](#3-firebase--the-backend) | Firebase backend | **Optional** | 25 min |
| [4](#4-security-rules--do-not-skip-if-you-did-step-3) | Security rules | **If you did 3** | 5 min |
| [5](#5-google-sign-in) | Google sign-in | Optional | 3 min |
| [6](#6-seed-reference-data) | Seed Firestore | Optional | 5 min |
| [7](#7-custom-domain) | Custom domain | Optional | 15 min |
| [8](#8-error-tracking--analytics) | Sentry + Analytics | Optional | 10 min |
| [9](#9-pwa-icons) | Replace PWA icons | Optional | 10 min |
| [10](#10-testing-checklist) | Testing checklist | Recommended | 30 min |

---

## 0. Run it locally

```bash
cd "E:\ROUGH CODING\Whispering Hollow A Living Village"
npm install
npm run dev
```

Open <http://localhost:3000>.

### Useful commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Production build |
| `npm start` | Serve the production build (run `build` first) |
| `npm run verify` | **World-generation self-test** — 29 checks |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint |
| `npm run gen:icons` | Regenerate PWA icons |
| `npm run seed` | Seed reference data into Firestore |

> **Run `npm run verify` after changing anything in `config/game.ts`.** It catches bad tuning
> constants (NaN heights, terrain that buries the railway, trees in the track corridor) in about
> two seconds, long before they'd show up as a visual glitch.

### Controls

| Key | Action |
|---|---|
| `W A S D` | Walk · `Shift` sprint · `Space` jump · `C` crouch |
| Mouse | Look (click once to capture the cursor) |
| `F` | Interact |
| `V` | Third-person · `L` lantern |
| `P` | Photo mode (drag to aim) |
| `Tab` | Character · `J` journal · `M` bird codex · `E` emotes |
| `Esc` | Settings |

---

## 1. Push to GitHub

```bash
cd "E:\ROUGH CODING\Whispering Hollow A Living Village"

# Easiest, if you have the GitHub CLI:
gh repo create whispering-hollow --private --source=. --push

# Or manually — create an empty repo on github.com first, then:
git remote add origin https://github.com/YOUR-USERNAME/whispering-hollow.git
git push -u origin main
```

The repo is already initialised with commits. `.gitignore` already excludes `node_modules`,
`.next`, `.env.local` and `serviceAccountKey.json`.

> ⚠️ **Never commit `.env.local` or `serviceAccountKey.json`.** Both are gitignored — leave it
> that way.

---

## 2. Deploy to Vercel

### Option A — dashboard (easiest)

1. Go to <https://vercel.com/new>
2. **Import** your GitHub repo
3. Vercel detects Next.js automatically — **change nothing**
4. Click **Deploy**

Roughly 90 seconds later you'll have a live URL. **It works with no environment variables** —
the game runs fully offline-capable and saves to the browser.

### Option B — CLI

```bash
npm i -g vercel
vercel          # first deploy — answer the prompts
vercel --prod   # promote to production
```

### If you add Firebase later

Add the same variables from `.env.local` in **Project → Settings → Environment Variables**,
then **redeploy**.

> Variables starting with `NEXT_PUBLIC_` are baked in at *build* time, not read at runtime.
> Adding one without redeploying does nothing.

---

## 3. Firebase — the backend

**Skip this entire section if you don't need cloud features.** Without Firebase the game
still: saves progress, saves settings, saves screenshots, unlocks achievements, and works
offline. What you *gain* by adding it:

| Feature | Needs |
|---|---|
| Progress syncs across devices | Auth + Firestore |
| Screenshots stored in the cloud & shareable | Storage |
| Ghost avatars — see other players | Realtime Database |
| Abuse protection | App Check |

### 3.1 Create the project

1. <https://console.firebase.google.com> → **Add project**
2. Name it (e.g. `whispering-hollow`) → Continue
3. Google Analytics is optional — either is fine
4. Wait for provisioning, then **Continue**

### 3.2 Register a Web app

1. On the project overview, click the **`</>`** (Web) icon
2. Nickname: `whispering-hollow-web`
3. **Do not** tick "Also set up Firebase Hosting" (you're using Vercel)
4. Click **Register app**
5. **Copy the `firebaseConfig` object it shows you** — you need these values next

It looks like this:

```js
const firebaseConfig = {
  apiKey: "AIzaSy…",
  authDomain: "whispering-hollow.firebaseapp.com",
  projectId: "whispering-hollow",
  storageBucket: "whispering-hollow.firebasestorage.app",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:abc123def456"
};
```

### 3.3 Enable Authentication

1. Left sidebar → **Build → Authentication** → **Get started**
2. **Sign-in method** tab
3. Enable **Anonymous** → Save
4. Enable **Google** → pick a support email → Save

> **Anonymous is the important one.** Players are signed in silently on first load and never
> see a login wall. Google is only for carrying progress between devices.

### 3.4 Enable Firestore

1. **Build → Firestore Database** → **Create database**
2. Choose a location **close to your players** (this cannot be changed later)
3. Start in **production mode** — you'll deploy proper rules in step 4

### 3.5 Enable Realtime Database *(only if you want multiplayer)*

1. **Build → Realtime Database** → **Create Database**
2. Pick a region → Start in **locked mode**
3. **Copy the URL** at the top — looks like
   `https://whispering-hollow-default-rtdb.europe-west1.firebasedatabase.app`

> Firestore and Realtime Database are two different products. The game uses both, deliberately:
> Firestore for durable progress, Realtime Database for 10 Hz presence, because it has
> `onDisconnect()` (which removes a player's ghost the instant their connection drops) and
> because 36 000 writes per player-hour on Firestore would be financially painful.

### 3.6 Enable Storage *(only if you want cloud screenshots)*

1. **Build → Storage** → **Get started**
2. Start in **production mode** → pick the same location as Firestore

### 3.7 Enable App Check *(recommended)*

1. **Build → App Check** → **Apps** tab → click your web app
2. Choose **reCAPTCHA v3** → **Register**
3. It will ask you to create a reCAPTCHA site key — follow the link, create one for your domain
4. **Copy the site key**

### 3.8 Fill in `.env.local`

```bash
cp .env.example .env.local
```

Open `.env.local` and paste your values:

```env
NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSy…
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=whispering-hollow.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=whispering-hollow
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=whispering-hollow.firebasestorage.app
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=123456789012
NEXT_PUBLIC_FIREBASE_APP_ID=1:123456789012:web:abc123def456

# Only if you enabled Realtime Database:
NEXT_PUBLIC_FIREBASE_DATABASE_URL=https://whispering-hollow-default-rtdb.europe-west1.firebasedatabase.app

# Only if you set up App Check:
NEXT_PUBLIC_FIREBASE_APPCHECK_SITE_KEY=6Lc…

# Turn multiplayer on:
NEXT_PUBLIC_ENABLE_MULTIPLAYER=true
```

Restart the dev server. **Then add the same variables to Vercel** (Project → Settings →
Environment Variables) and redeploy.

> These values are **public by design** — they ship in the browser bundle. Access is controlled
> by security rules (step 4), not by keeping the key secret. This is normal for Firebase.

---

## 4. Security rules — **do not skip if you did step 3**

A Firestore database left open is world-writable by anyone who finds your project ID.
The rules are already written and sitting in the repo.

### Easiest: deploy with the CLI

```bash
npm i -g firebase-tools
firebase login
cd "E:\ROUGH CODING\Whispering Hollow A Living Village"
firebase use --add        # select your project, give it the alias "default"

firebase deploy --only firestore:rules,firestore:indexes,database,storage
```

### Or paste manually

| File in repo | Paste into |
|---|---|
| `firestore.rules` | Firestore Database → **Rules** tab |
| `database.rules.json` | Realtime Database → **Rules** tab |
| `storage.rules` | Storage → **Rules** tab |

Click **Publish** on each.

### Firestore indexes

Two queries need composite indexes. Either:

- Run `firebase deploy --only firestore:indexes` (uses `firestore.indexes.json`), **or**
- Just use the app — when a query needs an index, Firestore logs an error to the browser
  console containing a **direct link** that creates it in one click.

### What the rules actually enforce

- A user can only read and write **their own** `users/{uid}` document
- Screenshots are readable by anyone **only** when explicitly marked public
- Nobody can create a screenshot or world attributed to a different user
- Presence entries are validated field by field — a tampered client can't inject a 10 MB
  display name or teleport to coordinate 1e9
- `lastSeen` must be the **server** timestamp, so a client can't claim to be online forever
- Uploads are capped at 8 MB and must be images
- Everything not explicitly allowed is denied

---

## 5. Google sign-in

If you deployed and Google sign-in fails with *"unauthorized domain"*:

1. Firebase Console → **Authentication → Settings → Authorized domains**
2. **Add domain** → `your-app.vercel.app`
3. Add any custom domain too

`localhost` is authorised by default.

---

## 6. Seed reference data

**Entirely optional.** This copies achievement definitions, lore fragments, bird species and
viewpoints into a read-only `gameData` collection in Firestore. The game doesn't read from it —
it has all of this compiled in. It's useful if you want to query progression from the console
or build an admin dashboard later.

1. Firebase Console → ⚙️ **Project settings → Service accounts**
2. **Generate new private key** → downloads a JSON file
3. Save it as `serviceAccountKey.json` in the project root (it's gitignored)

```bash
# PowerShell
$env:GOOGLE_APPLICATION_CREDENTIALS = ".\serviceAccountKey.json"
npm run seed

# bash / macOS / Linux
export GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json
npm run seed
```

> 🔒 **That key is a full-access admin credential.** Never commit it, never put it in a
> `NEXT_PUBLIC_` variable, never paste it anywhere public.

---

## 7. Custom domain

### On Vercel

1. Project → **Settings → Domains** → add your domain
2. Vercel shows the DNS records to create at your registrar:
   - Apex (`example.com`) → an **A** record to `76.76.21.21`
   - Subdomain (`www`) → a **CNAME** to `cname.vercel-dns.com`
3. DNS propagation takes minutes to a few hours. HTTPS is automatic.

### Then

Add the new domain to Firebase → **Authentication → Settings → Authorized domains**, or Google
sign-in will fail on it.

---

## 8. Error tracking & analytics

### Sentry *(optional)*

1. <https://sentry.io> → create a project → choose **Browser JavaScript**
2. Copy the **DSN**
3. Add to `.env.local` **and** Vercel:

```env
NEXT_PUBLIC_SENTRY_DSN=https://abc123@o12345.ingest.sentry.io/67890
NEXT_PUBLIC_SENTRY_ENVIRONMENT=production
```

Leave the DSN blank and Sentry is never loaded at all.

> Uses `@sentry/browser`, not `@sentry/nextjs` — no wizard, no build plugin, no source-map
> upload credentials needed. WebGL context-loss errors are filtered out because they're caused
> by drivers and sleeping laptops, not by bugs.

### Vercel Analytics

**No token needed.** Vercel → Project → **Analytics** → Enable.

It's automatically disabled on `localhost`, so running a production build locally won't spam
your console with 404s.

To disable it entirely: `NEXT_PUBLIC_ENABLE_ANALYTICS=false`

---

## 9. PWA icons

Real PNG icons are already generated and committed in `public/icons/`. They're drawn by code —
a golden-hour sky, a hill silhouette and a small train.

To use your own artwork, either:

- **Replace the files directly** — keep the same names and sizes:
  - `icon-192.png` (192×192)
  - `icon-512.png` (512×512)
  - `icon-maskable-192.png`, `icon-maskable-512.png` — these need ~14% padding on all sides,
    because Android crops maskable icons to a circle
  - `favicon-32.png` (32×32)

- **Or edit the generator** — change `drawIcon()` in `scripts/gen-icons.mjs`, then
  `npm run gen:icons`

---

## 10. Testing checklist

Before you call it shipped:

- [ ] **`npm run verify`** — should print `✅ All 29 checks passed`
- [ ] **`npm run build`** — should compile with no errors
- [ ] **20-minute session** — walk around, watch for slowdown or a rising memory graph in
      DevTools → Performance
- [ ] **Watch a full train pass** — birds should scatter ~20 s before you hear anything
- [ ] **Change graphics preset mid-session** (Settings → Graphics) — should not stutter or
      go black
- [ ] **Photo mode** — press `P`, drag to aim, take a shot, check it appears in the Gallery
- [ ] **Every panel** — `Tab`, `J`, `M`, `E`, `Esc`
- [ ] **Alt-tab away and back** — should show "Click to look around", *not* jump into Settings
- [ ] **Mobile viewport** — loads and renders (there are no touch controls yet, see below)
- [ ] **Potato preset** on the weakest machine you have
- [ ] **Offline** — load once, disconnect, reload. The core scene should still work
- [ ] **If you set up Firebase** — sign in with Google, check the `users/{uid}` document appears
      in Firestore, take a screenshot and confirm it lands in Storage

---

## Things you should know

### No art assets — at all

There isn't a single `.png`, `.glb`, `.mp3` or `.wav` in this project. Every texture, every
sound, every mesh is generated at runtime from code. That's why:

- The whole game is a **164 kB** initial JavaScript payload
- Offline mode genuinely works — there's nothing left to download
- Seasons, weather and species variants cost almost nothing to add

### The file to open first

**`config/game.ts`.** Every tunable number lives there, grouped and documented — world size,
erosion parameters, the train timeline, player movement feel, audio levels, quality presets.
Change something there and run `npm run verify`.

### Known limitations

| Thing | Detail |
|---|---|
| **Mobile touch controls** | None yet. Mobile loads and renders, but you can't move. A virtual stick is the obvious next feature. |
| **WebGPU** | Not enabled. Detection exists behind `NEXT_PUBLIC_ENABLE_WEBGPU`, but the R3F WebGPU renderer doesn't yet support the postprocessing effects this game uses. |
| **Safari** | Spatial audio (HRTF) is expensive — turn it off in Settings → Audio if audio stutters. No pointer lock on iOS. |
| **Firefox** | Mouse feel differs slightly (no `unadjustedMovement` pointer lock). |
| **Software rendering** | Machines with no GPU acceleration will struggle. The game detects this and opens on a low preset. |

### If the screen goes black

You'll get a "The valley slipped away" screen with a Reload button. That means the browser lost
the WebGL context — usually the GPU being reclaimed by the system, or running out of video
memory. Lower **Settings → Graphics → Preset** to Medium or Low. Your progress is safe.

---

## Costs

Firebase's free (Spark) tier comfortably covers a personal project:

| Service | Free tier | This game's usage |
|---|---|---|
| Firestore | 50k reads, 20k writes/day | ~1 read + a few writes per session (writes are debounced to one every 30 s) |
| Realtime DB | 100 simultaneous connections, 1 GB/month | Only while multiplayer is on; positions are throttled to 10 Hz *and* gated on movement |
| Storage | 5 GB | ~300 KB per screenshot |
| Auth | Unlimited | — |
| Hosting (Vercel) | 100 GB bandwidth/month | The game is ~1 MB total |

Multiplayer is the only thing with real scaling cost. It's off by default
(`NEXT_PUBLIC_ENABLE_MULTIPLAYER=false`).

---

## Quick reference — all environment variables

| Variable | Required? | Where to get it |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Cloud features | Firebase → Project settings → Web app config |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Cloud features | ditto |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Cloud features | ditto |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | Screenshots | ditto |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Cloud features | ditto |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Cloud features | ditto |
| `NEXT_PUBLIC_FIREBASE_DATABASE_URL` | Multiplayer | Realtime Database → URL at top |
| `NEXT_PUBLIC_FIREBASE_APPCHECK_SITE_KEY` | Optional | App Check → reCAPTCHA v3 |
| `NEXT_PUBLIC_ENABLE_MULTIPLAYER` | Optional | `true` / `false` |
| `NEXT_PUBLIC_ENABLE_VOICE_CHAT` | Optional | `true` / `false` (experimental) |
| `NEXT_PUBLIC_ENABLE_WEBGPU` | Optional | `true` / `false` (see limitations) |
| `NEXT_PUBLIC_SENTRY_DSN` | Optional | Sentry → Client Keys |
| `NEXT_PUBLIC_ENABLE_ANALYTICS` | Optional | `false` to disable |
| `GOOGLE_APPLICATION_CREDENTIALS` | Seed script only | Service account JSON path — **server-side only, never public** |

---

## Verification already done

The game was driven end to end in a real Chrome browser with GPU acceleration, roaming every
screen and panel: **44 of 44 steps clean, zero console errors.**

That process found and fixed seven bugs a build alone would never have caught — including
metre-wide grass blades, GPU memory exhaustion when switching graphics presets, pointer-lock
loss force-opening the Settings menu, an unrendered character panel, and photo mode holding the
cursor so its own buttons couldn't be clicked.

Static gates all pass too: `tsc --noEmit` (0 errors), `eslint` (0 problems), `npm run verify`
(29/29 checks), `next build` (164 kB first-load JS).
