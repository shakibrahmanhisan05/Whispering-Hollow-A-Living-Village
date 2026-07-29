/**
 * Authored content: lore fragments, bird codex entries, viewpoints,
 * achievements and their cosmetic rewards.
 *
 * Kept as data rather than scattered through components so the whole
 * progression surface can be reasoned about — and seeded into Firestore — in
 * one place. `scripts/seed.ts` imports directly from this module.
 *
 * @module lib/progression/content
 */

import { ZONES } from '@/config/game';
import { POND, RIDGE, STATION, LEVEL_CROSSING } from '@/lib/world/layout';

/* ───────────────────────────────────────────────────────────────────────────
 * JOURNAL FRAGMENTS
 * ─────────────────────────────────────────────────────────────────────────── */

export interface JournalFragment {
  id: string;
  /** Reading order once collected — not the order they're found in. */
  order: number;
  title: string;
  body: string;
  /** Where the page lies in the world. */
  position: [number, number];
  /** Zone hint shown in the journal for uncollected pages. */
  hint: string;
}

/**
 * Ten pages of a single voice, found out of order. Read together they resolve
 * into someone who left, and the person who stayed and kept writing anyway.
 * Deliberately unresolved — the ending narration lands harder for it.
 */
export const JOURNAL_FRAGMENTS: JournalFragment[] = [
  {
    id: 'journal-1',
    order: 1,
    title: 'First Page',
    body: "Mother says the valley was louder once. Two mills, a school, a Sunday market that spilled past the well. I have only ever known it like this — quiet, and enough.",
    position: [8, -12],
    hint: 'Near the village well',
  },
  {
    id: 'journal-2',
    order: 2,
    title: 'On the Timetable',
    body: "The 5:40 is never at 5:40. It is at whatever hour the light goes gold. I have stopped checking the clock and started checking the hedgerow — the birds know before I do.",
    position: [STATION.x - 3, STATION.z + 4],
    hint: 'The station shelter',
  },
  {
    id: 'journal-3',
    order: 3,
    title: 'The Grove',
    body: "There is a ring of mushrooms under the oldest oak that has not moved in eleven years. I measured it. I was a serious child. I am told I have not improved.",
    position: [ZONES.ANCIENT_GROVE.center[0] + 12, ZONES.ANCIENT_GROVE.center[1] - 8],
    hint: 'Beneath the oldest tree',
  },
  {
    id: 'journal-4',
    order: 4,
    title: 'What the Wind Does',
    body: "In August the wheat moves in one long body, like something breathing in its sleep. You can watch a gust arrive from half a mile off. Nothing else here gives you that much warning.",
    position: [ZONES.WHEAT_AND_WINDMILL.center[0] - 18, ZONES.WHEAT_AND_WINDMILL.center[1] + 14],
    hint: 'Among the wheat',
  },
  {
    id: 'journal-5',
    order: 5,
    title: 'The Argument',
    body: "He said there is nothing here. I said there is everything here, it is simply not in a hurry. Neither of us was lying. That is the trouble with the good arguments.",
    position: [RIDGE.center[0] + 9, RIDGE.center[1] - 6],
    hint: 'The ridge, near the bench',
  },
  {
    id: 'journal-6',
    order: 6,
    title: 'Pond, Late',
    body: "Threw a stone. Seven skips. Nobody saw. I am recording it here so that it happened.",
    position: [POND.center[0] + 16, POND.center[1] + 11],
    hint: "The pond's far shore",
  },
  {
    id: 'journal-7',
    order: 7,
    title: 'The Fox',
    body: "She comes down the path past eleven if you are very still. Not tame. Just unbothered. I think there is a difference and I think it matters.",
    position: [42, -30],
    hint: 'The dirt path, south',
  },
  {
    id: 'journal-8',
    order: 8,
    title: 'Letter, Unsent',
    body: "The lanterns went up for the festival and I stood at the ridge and watched them go, and I thought: I could write and say come home, the light is very good tonight. I did not. The light was very good.",
    position: [-24, 34],
    hint: 'Behind the church',
  },
  {
    id: 'journal-9',
    order: 9,
    title: 'Winter Note',
    body: "Pond froze. The ice makes a sound when it settles, a long low note like a door in another house. Mother would have called it the valley talking. I have started calling it that too.",
    position: [ZONES.MEADOW_FIELDS.center[0] + 22, ZONES.MEADOW_FIELDS.center[1] - 16],
    hint: 'Out in the meadow',
  },
  {
    id: 'journal-10',
    order: 10,
    title: 'Last Page',
    body: "If you are reading this you have walked further than most. Go up to the ridge at dusk. Wait for the train. That is the whole of it — that is what I stayed for. It is not nothing.",
    position: [LEVEL_CROSSING.x + 6, LEVEL_CROSSING.z - 9],
    hint: 'By the level crossing',
  },
];

/** Shown once every fragment has been read. */
export const ENDING_NARRATION = [
  'You have read every page.',
  'The valley does not change for it. The wheat still leans, the crossing bell still counts down the same handful of seconds, the light still goes gold and then goes.',
  'But you know now what the hours were for.',
  'Stay as long as you like.',
];

/* ───────────────────────────────────────────────────────────────────────────
 * BIRD CODEX
 * ─────────────────────────────────────────────────────────────────────────── */

export interface BirdSpecies {
  id: string;
  name: string;
  latin: string;
  /** Codex blurb, unlocked on first close approach. */
  description: string;
  /** Which synth voice in the audio engine sings for this bird. */
  voice: 'robin' | 'sparrow' | 'owl' | 'crow' | 'cuckoo';
  /** Normalised time-of-day window this species is active in. */
  active: [number, number];
  /** Preferred zones for perching. */
  zones: Array<keyof typeof ZONES>;
  /** Body and wing colours for the procedural bird mesh. */
  colors: { body: string; wing: string; accent: string };
  /** How close you must get before it counts as observed. */
  approachDistance: number;
}

/** Twelve species; five distinct synth voices shared between them. */
export const BIRD_SPECIES: BirdSpecies[] = [
  {
    id: 'robin',
    name: 'Hollow Robin',
    latin: 'Erithacus vallis',
    description:
      'Bold to the point of rudeness. Will follow a spade across a garden for the worms. Sings longest at the two edges of the day.',
    voice: 'robin',
    active: [0.18, 0.85],
    zones: ['VILLAGE_HEART', 'ANCIENT_GROVE'],
    colors: { body: '#7a6a52', wing: '#5c4f3c', accent: '#d4562f' },
    approachDistance: 6,
  },
  {
    id: 'sparrow',
    name: 'Hedgerow Sparrow',
    latin: 'Passer sepium',
    description:
      'Never alone. Where you find one you find nine more arguing in the same bush.',
    voice: 'sparrow',
    active: [0.2, 0.82],
    zones: ['VILLAGE_HEART', 'MEADOW_FIELDS'],
    colors: { body: '#8a7455', wing: '#6a5840', accent: '#c9b38a' },
    approachDistance: 5,
  },
  {
    id: 'barn-owl',
    name: 'Barn Owl',
    latin: 'Tyto alba',
    description:
      'Flies without sound. You will feel the air move before you see her. Nests in the windmill loft.',
    voice: 'owl',
    active: [0.82, 0.2],
    zones: ['WHEAT_AND_WINDMILL', 'ANCIENT_GROVE'],
    colors: { body: '#e8e0cf', wing: '#c4a878', accent: '#8a6f48' },
    approachDistance: 9,
  },
  {
    id: 'carrion-crow',
    name: 'Carrion Crow',
    latin: 'Corvus corone',
    description:
      'Holds a grudge for years and teaches it to its children. The dead tree by the grove is theirs; everyone accepts this.',
    voice: 'crow',
    active: [0.22, 0.8],
    zones: ['ANCIENT_GROVE', 'RAIL_CORRIDOR'],
    colors: { body: '#1e2024', wing: '#14161a', accent: '#3a4048' },
    approachDistance: 8,
  },
  {
    id: 'cuckoo',
    name: 'Common Cuckoo',
    latin: 'Cuculus canorus',
    description:
      'Two notes, a falling third, and then nothing for a quarter of an hour. Heard far more often than seen.',
    voice: 'cuckoo',
    active: [0.24, 0.62],
    zones: ['ANCIENT_GROVE', 'MEADOW_FIELDS'],
    colors: { body: '#8a9098', wing: '#6a7078', accent: '#e0e4e8' },
    approachDistance: 11,
  },
  {
    id: 'skylark',
    name: 'Skylark',
    latin: 'Alauda arvensis',
    description:
      'Climbs until it is a speck and sings the entire way up. The meadow is loudest directly overhead.',
    voice: 'robin',
    active: [0.26, 0.74],
    zones: ['MEADOW_FIELDS', 'WHEAT_AND_WINDMILL'],
    colors: { body: '#9a8a68', wing: '#7a6c50', accent: '#e8dcc0' },
    approachDistance: 7,
  },
  {
    id: 'wagtail',
    name: 'Grey Wagtail',
    latin: 'Motacilla cinerea',
    description:
      'Lives at the water. Cannot stand still; the tail keeps moving even when the bird does not.',
    voice: 'sparrow',
    active: [0.22, 0.8],
    zones: ['BROOK_AND_POND'],
    colors: { body: '#7a8290', wing: '#5a6270', accent: '#e8d858' },
    approachDistance: 5,
  },
  {
    id: 'kingfisher',
    name: 'Kingfisher',
    latin: 'Alcedo atthis',
    description:
      'A blue you will not believe until the second time. Sits on the same branch over the brook every morning.',
    voice: 'sparrow',
    active: [0.28, 0.7],
    zones: ['BROOK_AND_POND'],
    colors: { body: '#2a8fc4', wing: '#1c6f9c', accent: '#d4762f' },
    approachDistance: 6,
  },
  {
    id: 'swallow',
    name: 'Barn Swallow',
    latin: 'Hirundo rustica',
    description:
      'Arrives in spring and takes the summer with it when it leaves. Nests under the station eaves; nobody moves the nest.',
    voice: 'sparrow',
    active: [0.24, 0.79],
    zones: ['RAIL_CORRIDOR', 'VILLAGE_HEART'],
    colors: { body: '#2c3a5c', wing: '#1c2a44', accent: '#c4623c' },
    approachDistance: 8,
  },
  {
    id: 'wood-pigeon',
    name: 'Wood Pigeon',
    latin: 'Columba palumbus',
    description:
      'Leaves a branch with more noise than seems necessary for a bird of any size. Utterly unbothered by this.',
    voice: 'owl',
    active: [0.2, 0.84],
    zones: ['ANCIENT_GROVE', 'VILLAGE_HEART'],
    colors: { body: '#8a8c94', wing: '#6c6e78', accent: '#e8e8ec' },
    approachDistance: 7,
  },
  {
    id: 'pheasant',
    name: 'Ring-necked Pheasant',
    latin: 'Phasianus colchicus',
    description:
      'Would rather run than fly, and would rather stand in the middle of the road than do either.',
    voice: 'crow',
    active: [0.24, 0.78],
    zones: ['WHEAT_AND_WINDMILL', 'MEADOW_FIELDS'],
    colors: { body: '#8a4a28', wing: '#5c3018', accent: '#2c6a3c' },
    approachDistance: 9,
  },
  {
    id: 'nightjar',
    name: 'Nightjar',
    latin: 'Caprimulgus europaeus',
    description:
      'Churrs from the ridge after full dark — a sound like a distant engine that will not settle. Almost impossible to find.',
    voice: 'owl',
    active: [0.88, 0.14],
    zones: ['THE_RIDGE'],
    colors: { body: '#6a5c48', wing: '#4a4030', accent: '#8a7c64' },
    approachDistance: 12,
  },
];

/* ───────────────────────────────────────────────────────────────────────────
 * VIEWPOINTS
 * ─────────────────────────────────────────────────────────────────────────── */

export interface Viewpoint {
  id: string;
  name: string;
  description: string;
  position: [number, number];
  /** Camera yaw the auto-screenshot faces, radians. */
  yaw: number;
  /** Trigger radius. */
  radius: number;
}

/** Five hidden vistas. Standing in one auto-saves a photo to the gallery. */
export const VIEWPOINTS: Viewpoint[] = [
  {
    id: 'view-ridge',
    name: "The Ridge's Eye",
    description: 'The whole valley, the whole railway, the whole of it at once.',
    position: [RIDGE.center[0] + 2, RIDGE.center[1] + 8],
    yaw: Math.atan2(-RIDGE.center[1], -RIDGE.center[0]),
    radius: 7,
  },
  {
    id: 'view-crossing',
    name: 'Down the Line',
    description: 'Standing on the sleepers, looking west, where the rails converge.',
    position: [LEVEL_CROSSING.x - 4, LEVEL_CROSSING.z + 1],
    yaw: Math.PI,
    radius: 5,
  },
  {
    id: 'view-pond',
    name: 'Still Water',
    description: 'The pond at the exact angle where the sky doubles.',
    position: [POND.center[0] + 24, POND.center[1] - 4],
    yaw: Math.PI,
    radius: 6,
  },
  {
    id: 'view-windmill',
    name: 'Under the Sails',
    description: 'Directly beneath the turning sails, looking up through them at the sky.',
    position: [ZONES.WHEAT_AND_WINDMILL.center[0] - 6, ZONES.WHEAT_AND_WINDMILL.center[1] - 4],
    yaw: 0,
    radius: 5,
  },
  {
    id: 'view-grove',
    name: 'The Cathedral',
    description: 'Deep in the grove where the canopy closes and the light comes down in columns.',
    position: [ZONES.ANCIENT_GROVE.center[0] - 4, ZONES.ANCIENT_GROVE.center[1] + 6],
    yaw: Math.PI * 0.25,
    radius: 6,
  },
];

/* ───────────────────────────────────────────────────────────────────────────
 * SIGNPOSTS
 * ─────────────────────────────────────────────────────────────────────────── */

export interface Signpost {
  id: string;
  position: [number, number];
  yaw: number;
  /** Short text carved on the board itself. */
  sign: string;
  /** Longer note revealed when read. */
  note: string;
}

/** Eight readable signposts scattered along the paths. */
export const SIGNPOSTS: Signpost[] = [
  {
    id: 'sign-plaza',
    position: [4, 14],
    yaw: 0.4,
    sign: 'WHISPERING HOLLOW\npop. 41',
    note: 'Someone has scratched out the 41 and written 39, then 38, and then stopped.',
  },
  {
    id: 'sign-crossing',
    position: [LEVEL_CROSSING.x + 5, LEVEL_CROSSING.z - 6],
    yaw: -1.2,
    sign: 'STOP\nLOOK\nLISTEN',
    note: 'The paint is fresh. Somebody repaints it every spring, and has for longer than anyone remembers agreeing to.',
  },
  {
    id: 'sign-ridge',
    position: [RIDGE.center[0] - 10, RIDGE.center[1] + 14],
    yaw: 2.1,
    sign: 'THE RIDGE\n↑ 400 paces',
    note: 'Under the lettering, much smaller: worth it.',
  },
  {
    id: 'sign-pond',
    position: [POND.center[0] + 19, POND.center[1] + 6],
    yaw: -0.7,
    sign: 'NO SWIMMING\n(deeper than it looks)',
    note: 'It is not, in fact, deeper than it looks. The sign is a hundred years old and the pond has silted up since.',
  },
  {
    id: 'sign-grove',
    position: [ZONES.ANCIENT_GROVE.center[0] - 16, ZONES.ANCIENT_GROVE.center[1] + 18],
    yaw: 1.4,
    sign: 'ANCIENT GROVE\nplease keep to the path',
    note: 'There is no path. There has never been a path. The sign is much older than the request.',
  },
  {
    id: 'sign-windmill',
    position: [ZONES.WHEAT_AND_WINDMILL.center[0] - 20, ZONES.WHEAT_AND_WINDMILL.center[1] - 12],
    yaw: -2.4,
    sign: 'HOLLOW MILL\nflour · meal · grain',
    note: 'The mill has not ground anything in two generations. The sails still turn. Nobody has been able to explain why they were never taken down.',
  },
  {
    id: 'sign-meadow',
    position: [ZONES.MEADOW_FIELDS.center[0] + 14, ZONES.MEADOW_FIELDS.center[1] - 22],
    yaw: 0.9,
    sign: 'MIND THE BEES',
    note: 'There are no hives in sight. There is, however, a great deal of clover.',
  },
  {
    id: 'sign-cemetery',
    position: [-26, 30],
    yaw: -0.3,
    sign: 'ST. ANNE OF THE HOLLOW',
    note: 'Seven graves. Four surnames. Two of the surnames are still on mailboxes in the village.',
  },
];

/* ───────────────────────────────────────────────────────────────────────────
 * ACHIEVEMENTS
 * ─────────────────────────────────────────────────────────────────────────── */

/** What unlocking an achievement grants. */
export type RewardKind = 'hat' | 'outfit' | 'lut' | 'livery' | 'coins' | 'none';

export interface Achievement {
  id: string;
  name: string;
  description: string;
  /** Hidden achievements show as "???" until unlocked. */
  secret?: boolean;
  reward: { kind: RewardKind; id?: string; amount?: number; label: string };
  /** Progress target; 1 for binary achievements. */
  target: number;
}

/** Twenty achievements, each granting a cosmetic or currency. */
export const ACHIEVEMENTS: Achievement[] = [
  {
    id: 'golden-hour-wanderer',
    name: 'Golden Hour Wanderer',
    description: 'Spend ten minutes walking during golden hour or dusk.',
    reward: { kind: 'lut', id: 'goldenHour', label: 'Golden Hour colour grade' },
    target: 600,
  },
  {
    id: 'train-chaser',
    name: 'Train Chaser',
    description: 'Witness ten train passes.',
    reward: { kind: 'livery', id: 'emberRed', label: 'Ember Red livery' },
    target: 10,
  },
  {
    id: 'village-photographer',
    name: 'Village Photographer',
    description: 'Take twenty photographs.',
    reward: { kind: 'hat', id: 'bucket', label: 'Bucket Hat' },
    target: 20,
  },
  {
    id: 'silent-friend',
    name: 'Silent Friend',
    description: 'Get within three metres of the fox without startling her.',
    secret: true,
    reward: { kind: 'outfit', id: 'ranger', label: 'Ranger Green outfit' },
    target: 1,
  },
  {
    id: 'bellringer',
    name: 'Bellringer',
    description: 'Ring the church bell.',
    reward: { kind: 'coins', amount: 15, label: '15 coins' },
    target: 1,
  },
  {
    id: 'seven-skips',
    name: 'Seven Skips',
    description: 'Skip a stone seven times across the pond.',
    secret: true,
    reward: { kind: 'hat', id: 'straw', label: 'Farmer Straw hat' },
    target: 1,
  },
  {
    id: 'archivist',
    name: 'Archivist',
    description: 'Find all ten journal fragments.',
    reward: { kind: 'lut', id: 'nostalgicFilm', label: 'Nostalgic Film colour grade' },
    target: 10,
  },
  {
    id: 'ornithologist',
    name: 'Ornithologist',
    description: 'Observe all twelve bird species up close.',
    reward: { kind: 'hat', id: 'flowerCrown', label: 'Flower Crown' },
    target: 12,
  },
  {
    id: 'cartographer',
    name: 'Cartographer',
    description: 'Discover all five hidden viewpoints.',
    reward: { kind: 'lut', id: 'cinematic', label: 'Cinematic colour grade' },
    target: 5,
  },
  {
    id: 'four-seasons',
    name: 'Four Seasons',
    description: 'Experience the valley in spring, summer, autumn and winter.',
    reward: { kind: 'outfit', id: 'winter', label: 'Winter Knit outfit' },
    target: 4,
  },
  {
    id: 'storm-watcher',
    name: 'Storm Watcher',
    description: 'Stand on the ridge during a thunderstorm.',
    secret: true,
    reward: { kind: 'livery', id: 'midnightBlue', label: 'Midnight Blue livery' },
    target: 1,
  },
  {
    id: 'lantern-festival',
    name: 'Lantern Festival',
    description: 'Watch the sky lanterns rise from the ridge at dusk.',
    secret: true,
    reward: { kind: 'hat', id: 'lantern', label: 'Lantern Headband' },
    target: 1,
  },
  {
    id: 'message-in-a-bottle',
    name: 'Message in a Bottle',
    description: 'Find what is floating in the pond.',
    secret: true,
    reward: { kind: 'livery', id: 'brookTeal', label: 'Brook Teal livery' },
    target: 1,
  },
  {
    id: 'well-wisher',
    name: 'Well Wisher',
    description: 'Leave a bouquet of flowers on the village well.',
    reward: { kind: 'outfit', id: 'meadow', label: 'Meadow Dress' },
    target: 1,
  },
  {
    id: 'good-listener',
    name: 'Good Listener',
    description: 'Read all eight signposts.',
    reward: { kind: 'coins', amount: 25, label: '25 coins' },
    target: 8,
  },
  {
    id: 'stock-keeper',
    name: 'Stock Keeper',
    description: 'Feed every animal in the valley at least once.',
    reward: { kind: 'hat', id: 'conductor', label: "Conductor's Cap" },
    target: 3,
  },
  {
    id: 'night-walker',
    name: 'Night Walker',
    description: 'Walk five minutes between midnight and first light.',
    reward: { kind: 'livery', id: 'duskViolet', label: 'Dusk Violet livery' },
    target: 300,
  },
  {
    id: 'treasurer',
    name: 'Treasurer',
    description: 'Collect thirty coins from the valley’s quiet corners.',
    reward: { kind: 'hat', id: 'crown', label: 'Hollow Crown' },
    target: 30,
  },
  {
    id: 'sit-a-while',
    name: 'Sit a While',
    description: 'Watch a full sunrise from the ridge bench without standing up.',
    secret: true,
    reward: { kind: 'lut', id: 'storybook', label: 'Storybook colour grade' },
    target: 1,
  },
  {
    id: 'the-whole-of-it',
    name: 'The Whole of It',
    description: 'Unlock every other achievement.',
    reward: { kind: 'livery', id: 'snowAsh', label: 'Snow Ash livery' },
    target: 19,
  },
];

/* ───────────────────────────────────────────────────────────────────────────
 * DISCOVERIES
 * ─────────────────────────────────────────────────────────────────────────── */

export type DiscoveryKind = 'journal' | 'bird' | 'viewpoint' | 'signpost' | 'secret';

export interface Discovery {
  id: string;
  kind: DiscoveryKind;
  name: string;
}

/**
 * The full collectible list — 10 journal + 12 birds + 5 viewpoints + 8
 * signposts + 5 secrets = 40 discoveries.
 */
export const DISCOVERIES: Discovery[] = [
  ...JOURNAL_FRAGMENTS.map((f) => ({ id: f.id, kind: 'journal' as const, name: f.title })),
  ...BIRD_SPECIES.map((b) => ({ id: `bird-${b.id}`, kind: 'bird' as const, name: b.name })),
  ...VIEWPOINTS.map((v) => ({ id: v.id, kind: 'viewpoint' as const, name: v.name })),
  ...SIGNPOSTS.map((s) => ({ id: s.id, kind: 'signpost' as const, name: 'Signpost' })),
  { id: 'secret-fox', kind: 'secret', name: 'The Night Visitor' },
  { id: 'secret-bottle', kind: 'secret', name: 'Message in a Bottle' },
  { id: 'secret-lanterns', kind: 'secret', name: 'Sky Lantern Festival' },
  { id: 'secret-cat', kind: 'secret', name: 'The Windowsill Cat' },
  { id: 'secret-mushroom-ring', kind: 'secret', name: 'The Ring That Never Moves' },
];

export const TOTAL_DISCOVERIES = DISCOVERIES.length;

/** Fast lookup by ID. */
export const ACHIEVEMENT_BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));
export const JOURNAL_BY_ID = new Map(JOURNAL_FRAGMENTS.map((j) => [j.id, j]));
export const BIRD_BY_ID = new Map(BIRD_SPECIES.map((b) => [b.id, b]));
