/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHISPERING HOLLOW — CENTRAL TUNING CONSTANTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every tunable number in the game lives here, grouped by system and
 * documented. Nothing in `/components` or `/lib` should contain a bare magic
 * number that a designer might reasonably want to change — it belongs in this
 * file instead.
 *
 * Units:
 *   - Distance  : world units (1 wu ≈ 1 metre)
 *   - Time      : seconds unless suffixed `Ms`
 *   - Angles    : radians unless suffixed `Deg`
 *   - Frequency : Hz
 *
 * @module config/game
 */

import type { Vector3Tuple } from 'three';

/* ───────────────────────────────────────────────────────────────────────────
 * WORLD
 * ─────────────────────────────────────────────────────────────────────────── */

/** Overall world dimensions and terrain sampling resolution. */
export const WORLD = {
  /** Edge length of the square world in world units. The playable area. */
  SIZE: 400,
  /** Half-extent — convenience, always SIZE / 2. */
  get HALF() {
    return this.SIZE / 2;
  },
  /** Visual terrain mesh subdivisions per axis. 256 → 65k verts / 131k tris. */
  MESH_SEGMENTS: 256,
  /** Physics collision mesh subdivisions. Lower = cheaper BVH, coarser steps. */
  COLLIDER_SEGMENTS: 128,
  /** Heightmap raster resolution used for erosion + runtime height queries. */
  HEIGHTMAP_RESOLUTION: 512,
  /** Peak terrain amplitude in world units (before erosion). */
  HEIGHT_SCALE: 34,
  /** Sea/pond reference level. Terrain below this is underwater. */
  WATER_LEVEL: 1.6,
  /** Invisible wall inset from the world edge, keeps the player on-map. */
  BOUNDARY_MARGIN: 12,
  /** Default procedural seed when the player hasn't chosen one. */
  DEFAULT_SEED: 'whispering-hollow',
} as const;

/** fBm + domain-warp parameters for the base heightfield. */
export const TERRAIN_NOISE = {
  /** Number of fBm octaves. 5 gives ridges without excessive high-frequency noise. */
  OCTAVES: 5,
  /** Frequency multiplier between octaves. */
  LACUNARITY: 2.03,
  /** Amplitude multiplier between octaves. <0.5 = smoother, >0.5 = rougher. */
  GAIN: 0.47,
  /** Base frequency — smaller = larger landforms. */
  BASE_FREQUENCY: 0.0042,
  /** Strength of the domain-warp offset that breaks up noise regularity. */
  WARP_STRENGTH: 46,
  /** Frequency of the warp field itself. */
  WARP_FREQUENCY: 0.0031,
  /**
   * Exponent applied to normalised height. >1 flattens valleys and sharpens
   * peaks, which reads as "carved" rather than "blobby".
   */
  RIDGE_EXPONENT: 1.35,
  /** Radius of the flattened basin at the village centre. */
  VILLAGE_FLATTEN_RADIUS: 46,
  /** Falloff distance beyond the flatten radius over which terrain resumes. */
  VILLAGE_FLATTEN_FALLOFF: 40,
  /** Target altitude of the flattened village plaza. */
  VILLAGE_FLATTEN_HEIGHT: 6.5,
  /** Half-width of the flattened corridor carved for the railway. */
  RAIL_FLATTEN_WIDTH: 9,
  /** Falloff either side of the rail corridor. */
  RAIL_FLATTEN_FALLOFF: 18,
} as const;

/** Droplet-based hydraulic erosion, run once in a Web Worker at world-gen. */
export const EROSION = {
  /** Total simulated droplets. 60k over a 512² map ≈ 700 ms on a laptop core. */
  DROPLETS: 60_000,
  /** Maximum steps a single droplet may take before it is retired. */
  MAX_LIFETIME: 34,
  /** Radius (in cells) over which a droplet's erosion is distributed. */
  EROSION_RADIUS: 3,
  /** How strongly slope direction overrides existing momentum. 0..1 */
  INERTIA: 0.045,
  /** Sediment carried per unit of slope × speed × water. */
  SEDIMENT_CAPACITY_FACTOR: 3.6,
  /** Floor on capacity so flat areas still deposit. */
  MIN_SEDIMENT_CAPACITY: 0.008,
  /** Fraction of the capacity deficit eroded per step. 0..1 */
  ERODE_SPEED: 0.28,
  /** Fraction of excess sediment deposited per step. 0..1 */
  DEPOSIT_SPEED: 0.28,
  /** Per-step water loss. Higher = shorter, more local channels. */
  EVAPORATE_SPEED: 0.017,
  /** Downhill acceleration. */
  GRAVITY: 4,
  /** Starting water volume of each droplet. */
  INITIAL_WATER: 1,
  /** Starting speed of each droplet. */
  INITIAL_SPEED: 1,
} as const;

/**
 * The seven biome pockets. `center` is XZ in world units, `radius` is the
 * influence radius used for vegetation weighting, audio zones and the compass.
 */
export const ZONES = {
  VILLAGE_HEART: { center: [0, 0] as [number, number], radius: 52, label: 'Village Heart' },
  MEADOW_FIELDS: { center: [-118, 74] as [number, number], radius: 78, label: 'Meadow Fields' },
  ANCIENT_GROVE: { center: [112, -96] as [number, number], radius: 62, label: 'Ancient Grove' },
  THE_RIDGE: { center: [-142, -132] as [number, number], radius: 46, label: 'The Ridge' },
  RAIL_CORRIDOR: { center: [40, 118] as [number, number], radius: 58, label: 'Rail Corridor' },
  BROOK_AND_POND: { center: [-64, -58] as [number, number], radius: 54, label: 'Brook & Pond' },
  WHEAT_AND_WINDMILL: { center: [136, 62] as [number, number], radius: 66, label: 'Wheatfield' },
} as const;

export type ZoneId = keyof typeof ZONES;

/* ───────────────────────────────────────────────────────────────────────────
 * VEGETATION
 * ─────────────────────────────────────────────────────────────────────────── */

export const VEGETATION = {
  /** Total tree instances across all species at High quality. */
  TREE_COUNT: 420,
  /** Distance under which the high-detail tree LOD is used. */
  LOD_HIGH_DISTANCE: 30,
  /** Distance under which the medium tree LOD is used. */
  LOD_MEDIUM_DISTANCE: 80,
  /** Beyond this, trees render as camera-facing billboards. */
  LOD_BILLBOARD_DISTANCE: 220,
  /** Per-instance uniform scale jitter, ± this fraction. */
  SCALE_JITTER: 0.28,
  /** Per-instance hue rotation applied to foliage, ± this many degrees. */
  HUE_JITTER_DEG: 14,
  /** Minimum spacing between two trees. */
  MIN_TREE_SPACING: 5.2,
  /** Trees are not placed on terrain steeper than this. */
  MAX_TREE_SLOPE: 0.62,

  /**
   * Buffer capacity per grass chunk.
   *
   * This is the *allocation* size, not the draw count. Chunk buffers are
   * allocated once at this capacity and never resized; changing the quality
   * preset only varies `instanceCount`. Reallocating the whole pool on every
   * density change used to spike GPU memory hard enough to lose the WebGL
   * context outright (`GL_OUT_OF_MEMORY` on D3D11) when the player switched
   * presets mid-session.
   *
   * 81 chunks × 10 000 blades × 40 bytes ≈ 32 MB, constant.
   */
  GRASS_BLADES_PER_CHUNK: 10000,
  /** Grass is instanced in square chunks of this edge length. */
  GRASS_CHUNK_SIZE: 20,
  /** Radius in chunks around the player that stays populated with grass. */
  GRASS_CHUNK_RADIUS: 4,
  /**
   * Height of a grass blade before per-instance jitter, in metres.
   * With the ±35 % jitter applied this tops out around 1.05 m against a
   * 1.68 m eye height — thigh-to-waist high, which is what "meadow" looks
   * like. Taller than this and the player is wading through it.
   */
  GRASS_BLADE_HEIGHT: 0.78,
  /**
   * Width of a grass blade at its base, in metres.
   * Real grass is 3–6 mm across. 3 cm is already a generous stylisation that
   * keeps blades readable at distance; anything wider reads as reeds.
   */
  GRASS_BLADE_WIDTH: 0.03,
  /** Segments per blade — more segments = smoother bend under wind. */
  GRASS_BLADE_SEGMENTS: 4,
  /**
   * Blades closer than this to the camera shrink away.
   * Without it, standing still plants a dozen blades directly across the lens
   * and the player appears to be inside a bush rather than standing in a field.
   */
  GRASS_NEAR_FADE: 0.85,

  /** Flower instances scattered through the meadow zone. */
  FLOWER_COUNT: 2600,
  /** Mushroom instances, concentrated in the Ancient Grove. */
  MUSHROOM_COUNT: 340,
  /** Wheat stalk instances in the windmill field. */
  WHEAT_COUNT: 42_000,
  /** Ground-clutter rocks/pebbles across the map. */
  ROCK_COUNT: 520,
} as const;

/** Global wind field driving every plant, cloth, cloud and wind-chime. */
export const WIND = {
  /** Baseline wind speed multiplier (0..1 nominal, can exceed for storms). */
  BASE_STRENGTH: 0.42,
  /** Wind heading in radians; 0 = +X. Drifts slowly at runtime. */
  BASE_DIRECTION: 0.7,
  /** How fast the heading wanders, radians/second. */
  DIRECTION_DRIFT: 0.012,
  /** Amplitude of the gust envelope on top of BASE_STRENGTH. */
  GUST_AMPLITUDE: 0.38,
  /** Period of the primary gust cycle. */
  GUST_PERIOD: 11.5,
  /** Secondary, faster gust layer for texture. */
  GUST_PERIOD_FAST: 3.7,
  /** Spatial wavelength of the visible gust ripple travelling across fields. */
  RIPPLE_WAVELENGTH: 34,
  /** Speed the gust ripple travels across the world, wu/s. */
  RIPPLE_SPEED: 12,
} as const;

/* ───────────────────────────────────────────────────────────────────────────
 * TIME OF DAY / SEASONS / WEATHER
 * ─────────────────────────────────────────────────────────────────────────── */

export const TIME = {
  /** Real-world seconds for one full in-game 24 h cycle. 720 s = 12 min. */
  SECONDS_PER_DAY: 720,
  /** Normalised time-of-day the world starts at. 0.72 ≈ 17:17 — golden hour. */
  DEFAULT_TIME: 0.72,
  /** Sun orbit tilt from vertical, radians. Gives seasonal-looking arcs. */
  SUN_ORBIT_TILT: 0.42,
  /** Distance of the sun/moon billboards from the world origin. */
  CELESTIAL_DISTANCE: 900,
  /** Multiplier applied to time flow while seated on the ridge bench. */
  BENCH_TIME_SCALE: 3,
  /** Number of instanced stars in the night sky. */
  STAR_COUNT: 3200,
  /** Normalised time at which stars begin to fade in. */
  STARS_FADE_IN: 0.78,
  /** Normalised time at which stars are fully faded out. */
  STARS_FADE_OUT: 0.24,
} as const;

/** Key frames of the day. Colours blend smoothly between adjacent entries. */
export const LIGHTING_STATES = [
  {
    id: 'dawn',
    /** Normalised time-of-day this state peaks at. */
    t: 0.22,
    label: 'Dawn',
    sunColor: '#ff9d6e',
    sunIntensity: 1.1,
    ambientColor: '#7d8ec4',
    ambientIntensity: 0.42,
    fogColor: '#d8b9c4',
    fogDensity: 0.0105,
    skyTint: '#ffb0a0',
    exposure: 1.05,
  },
  {
    id: 'goldenMorning',
    t: 0.32,
    label: 'Golden Morning',
    sunColor: '#ffd39b',
    sunIntensity: 2.2,
    ambientColor: '#9fb5d8',
    ambientIntensity: 0.55,
    fogColor: '#dfe4e0',
    fogDensity: 0.0058,
    skyTint: '#cfe0f5',
    exposure: 1.0,
  },
  {
    id: 'noon',
    t: 0.5,
    label: 'Bright Noon',
    sunColor: '#fff6e2',
    sunIntensity: 3.0,
    ambientColor: '#b9cfe8',
    ambientIntensity: 0.68,
    fogColor: '#dceaf2',
    fogDensity: 0.0032,
    skyTint: '#8fc3f0',
    exposure: 0.92,
  },
  {
    id: 'goldenHour',
    t: 0.74,
    label: 'Golden Hour',
    sunColor: '#ffb457',
    sunIntensity: 2.35,
    ambientColor: '#9a95c8',
    ambientIntensity: 0.5,
    fogColor: '#f0c99a',
    fogDensity: 0.0082,
    skyTint: '#ffc98a',
    exposure: 1.08,
  },
  {
    id: 'night',
    t: 0.94,
    label: 'Night',
    sunColor: '#8fa6d8',
    sunIntensity: 0.28,
    ambientColor: '#2b3a63',
    ambientIntensity: 0.22,
    fogColor: '#1b2440',
    fogDensity: 0.0125,
    skyTint: '#111d3a',
    exposure: 1.22,
  },
] as const;

export type LightingStateId = (typeof LIGHTING_STATES)[number]['id'];

export const SEASONS = {
  spring: {
    label: 'Spring',
    /** Multiplicative tint applied to foliage albedo. */
    foliageTint: '#8fd06a',
    grassTint: '#7fc95e',
    /** Fraction of trees that render as cherry blossom. */
    blossomChance: 0.22,
    /** Snow accumulation on upward faces, 0..1. */
    snowCoverage: 0,
    /** Density multiplier for the ambient wildlife bed. */
    wildlifeDensity: 1.15,
    fogTint: '#e6f2df',
  },
  summer: {
    label: 'Summer',
    foliageTint: '#63a844',
    grassTint: '#9dbe4e',
    blossomChance: 0,
    snowCoverage: 0,
    wildlifeDensity: 1.0,
    fogTint: '#f2ecd8',
  },
  autumn: {
    label: 'Autumn',
    foliageTint: '#d4802f',
    grassTint: '#b5a054',
    blossomChance: 0,
    snowCoverage: 0,
    wildlifeDensity: 0.75,
    fogTint: '#efd6b0',
  },
  winter: {
    label: 'Winter',
    foliageTint: '#7d8a7a',
    grassTint: '#9aa89c',
    blossomChance: 0,
    snowCoverage: 0.92,
    wildlifeDensity: 0.35,
    fogTint: '#dfe8f2',
  },
} as const;

export type SeasonId = keyof typeof SEASONS;
export const SEASON_IDS = ['spring', 'summer', 'autumn', 'winter'] as const;

export const WEATHER = {
  clear: { label: 'Clear', cloudCover: 0.18, rain: 0, snow: 0, fogBoost: 1.0, windBoost: 1.0 },
  cloudy: { label: 'Cloudy', cloudCover: 0.72, rain: 0, snow: 0, fogBoost: 1.35, windBoost: 1.25 },
  lightRain: {
    label: 'Light Rain',
    cloudCover: 0.85,
    rain: 0.4,
    snow: 0,
    fogBoost: 1.8,
    windBoost: 1.35,
  },
  storm: {
    label: 'Heavy Rain & Thunder',
    cloudCover: 1.0,
    rain: 1.0,
    snow: 0,
    fogBoost: 2.6,
    windBoost: 2.1,
  },
  snow: { label: 'Snow', cloudCover: 0.9, rain: 0, snow: 1, fogBoost: 2.0, windBoost: 0.85 },
  fog: { label: 'Dense Fog', cloudCover: 0.55, rain: 0, snow: 0, fogBoost: 5.5, windBoost: 0.5 },
  autumnWind: {
    label: 'Autumn Wind',
    cloudCover: 0.45,
    rain: 0,
    snow: 0,
    fogBoost: 1.1,
    windBoost: 2.4,
  },
} as const;

export type WeatherId = keyof typeof WEATHER;
export const WEATHER_IDS = Object.keys(WEATHER) as WeatherId[];

export const PRECIPITATION = {
  /** Rain particle count at full intensity. */
  RAIN_PARTICLES: 14_000,
  /** Radius of the rain column that follows the camera. */
  RAIN_RADIUS: 34,
  /** Height of the rain column. */
  RAIN_HEIGHT: 26,
  /** Fall speed in wu/s. */
  RAIN_SPEED: 26,
  /** Snow particle count at full intensity. */
  SNOW_PARTICLES: 6000,
  SNOW_RADIUS: 40,
  SNOW_HEIGHT: 30,
  SNOW_SPEED: 2.4,
  /** Seconds between lightning strikes during a storm, randomised ±50%. */
  THUNDER_INTERVAL: 22,
  /** Seconds of delay per world unit of distance, for the thunder clap. */
  THUNDER_DELAY_PER_UNIT: 0.0029,
} as const;

export const CLOUDS = {
  COUNT: 11,
  /** Altitude band the cloud billboards occupy. */
  ALTITUDE: [78, 118] as [number, number],
  /** Scale range for individual cloud puffs. */
  SCALE: [42, 96] as [number, number],
  /** Cloud drift speed as a fraction of the wind vector. */
  DRIFT_FACTOR: 2.4,
  /** Hz at which cloud transforms are recomputed (throttled). */
  UPDATE_HZ: 10,
} as const;

/* ───────────────────────────────────────────────────────────────────────────
 * PLAYER
 * ─────────────────────────────────────────────────────────────────────────── */

export const PLAYER = {
  /** Eye height above the feet while standing. */
  EYE_HEIGHT: 1.68,
  /** Eye height while crouching. */
  CROUCH_EYE_HEIGHT: 1.02,
  /** Radius of the capsule collider. */
  RADIUS: 0.34,
  /** Total capsule height while standing (feet to crown). */
  HEIGHT: 1.8,
  /** Capsule height while crouching. */
  CROUCH_HEIGHT: 1.12,

  /** Base walking speed, wu/s. */
  WALK_SPEED: 3.4,
  /** Multiplier applied while sprinting. */
  SPRINT_MULTIPLIER: 2.05,
  /** Multiplier applied while crouching. */
  CROUCH_MULTIPLIER: 0.45,
  /** Ground acceleration, wu/s². Higher = snappier. */
  ACCELERATION: 42,
  /** Ground deceleration when no input, wu/s². */
  DECELERATION: 34,
  /** Fraction of ground control retained mid-air. */
  AIR_CONTROL: 0.28,
  /** Upward velocity imparted by a jump, wu/s. */
  JUMP_VELOCITY: 4.6,
  /** Downward acceleration, wu/s². Slightly stronger than Earth for game feel. */
  GRAVITY: 19.6,
  /** Terminal falling speed. */
  MAX_FALL_SPEED: 42,
  /** Grace period after leaving ground during which a jump still registers. */
  COYOTE_TIME: 0.12,
  /** Jump input buffered this long before landing. */
  JUMP_BUFFER: 0.14,

  /** Steepest slope (radians) the player can walk up. */
  MAX_SLOPE: 0.92,
  /** Maximum ledge height auto-stepped over. */
  STEP_HEIGHT: 0.42,
  /** Character-controller skin width; prevents jitter against colliders. */
  COLLIDER_OFFSET: 0.02,
  /** Distance the controller snaps down to keep contact on descents. */
  SNAP_TO_GROUND: 0.6,

  /** Stamina pool, in seconds of sprinting. */
  MAX_STAMINA: 100,
  /** Stamina drained per second of sprinting. */
  STAMINA_DRAIN: 14,
  /** Stamina recovered per second while not sprinting. */
  STAMINA_RECOVER: 19,
  /** Delay before stamina begins recovering after sprinting stops. */
  STAMINA_RECOVER_DELAY: 0.85,
  /** Stamina required to *start* a sprint (prevents stutter-sprinting). */
  STAMINA_SPRINT_THRESHOLD: 12,

  /** Vertical head-bob amplitude at full walking speed. */
  BOB_AMPLITUDE_Y: 0.048,
  /** Horizontal head-bob amplitude (the Lissajous partner). */
  BOB_AMPLITUDE_X: 0.032,
  /** Head-bob base frequency in Hz at walking speed. */
  BOB_FREQUENCY: 1.85,
  /** Bob amplitude multiplier while sprinting (damped, per spec). */
  BOB_SPRINT_DAMP: 0.72,
  /** Camera roll induced by strafing, radians. */
  STRAFE_ROLL: 0.022,

  /** Default vertical field of view, degrees. */
  FOV: 70,
  /** FOV while sprinting. */
  SPRINT_FOV: 78,
  /** Seconds for the FOV to ease between the two. */
  FOV_EASE: 0.35,
  /** Mouse sensitivity multiplier. */
  MOUSE_SENSITIVITY: 1.0,
  /** Hard clamp on pitch so the camera can't flip. */
  MAX_PITCH: Math.PI / 2 - 0.02,

  /** Maximum distance at which interactables can be targeted. */
  INTERACT_DISTANCE: 3.6,
  /** Player spawn point. */
  SPAWN: [6, 12, 26] as Vector3Tuple,
  /** Initial yaw at spawn, radians. */
  SPAWN_YAW: Math.PI * 0.86,

  /** Third-person camera distance behind the avatar. */
  TP_DISTANCE: 3.4,
  /** Third-person camera lateral shoulder offset. */
  TP_SHOULDER: 0.65,
  /** Third-person camera height above the avatar's feet. */
  TP_HEIGHT: 1.62,
  /** Third-person camera smoothing half-life, seconds. */
  TP_SMOOTHING: 0.09,
} as const;

/** Footstep timing and the surface classifications the raycast can return. */
export const FOOTSTEPS = {
  /** Seconds between steps at base walking speed. */
  INTERVAL_WALK: 0.52,
  /** Seconds between steps while sprinting. */
  INTERVAL_SPRINT: 0.32,
  /** Seconds between steps while crouching. */
  INTERVAL_CROUCH: 0.78,
  /** Minimum horizontal speed before footsteps trigger. */
  MIN_SPEED: 0.6,
} as const;

export const SURFACES = ['grass', 'dirt', 'cobblestone', 'wood'] as const;
export type SurfaceId = (typeof SURFACES)[number];

/* ───────────────────────────────────────────────────────────────────────────
 * TRAIN
 * ─────────────────────────────────────────────────────────────────────────── */

export const TRAIN = {
  /** Seconds between train events, min/max. Player-configurable in settings. */
  INTERVAL: [90, 120] as [number, number],
  /** Absolute bounds exposed to the settings slider. */
  INTERVAL_BOUNDS: [30, 300] as [number, number],
  /** Cruising speed along the track, wu/s. */
  SPEED: 27,
  /** Locomotive driving-wheel radius; drives rotation and chuff rate. */
  WHEEL_RADIUS: 0.82,
  /** Radius of the smaller bogie wheels on wagons. */
  WAGON_WHEEL_RADIUS: 0.52,
  /** Number of wagons behind the locomotive. */
  WAGON_COUNT: 7,
  /** Longitudinal gap between coupled cars. */
  WAGON_GAP: 1.1,
  /** Length of a standard wagon body. */
  WAGON_LENGTH: 8.4,
  /** Length of the locomotive body. */
  LOCO_LENGTH: 11.2,
  /** Number of instanced sleepers laid along the track curve. */
  SLEEPER_COUNT: 640,
  /** Half the distance between the two rails (standard-ish gauge). */
  RAIL_GAUGE: 0.72,
  /** Track curve samples used for the extruded rail geometry. */
  CURVE_SAMPLES: 900,

  /** Peak camera-shake amplitude when the train is closest. */
  SHAKE_AMPLITUDE: 0.055,
  /** Distance at which camera shake begins to be felt. */
  SHAKE_RADIUS: 46,
  /** Perlin frequency of the shake, Hz. */
  SHAKE_FREQUENCY: 13,

  /** Bogie bounce amplitude (vertical). */
  BOUNCE_AMPLITUDE: 0.022,
  /** Body side-sway amplitude (roll, radians). */
  SWAY_AMPLITUDE: 0.017,

  /** Steam puff particles per plume. */
  STEAM_PARTICLES: 90,
  /** Spark particles kicked up at the wheel/rail contact. */
  SPARK_PARTICLES: 60,
} as const;

/**
 * The cinematic ritual. Offsets are seconds relative to T-0, the moment the
 * locomotive passes the level crossing. Negative = before.
 * @see components/scene/Train/TrainDirector.tsx
 */
export const TRAIN_SEQUENCE = [
  { at: -20, id: 'birdsStartle', label: 'Birds scatter from trackside trees' },
  { at: -15, id: 'distantHorn', label: 'First distant two-tone horn' },
  { at: -10, id: 'crossingActivate', label: 'Crossing bell, lights, barrier lowers' },
  { at: -8, id: 'railHum', label: 'Rails begin to hum' },
  { at: -6, id: 'groundTremble', label: 'Ground trembles, camera shake begins' },
  { at: -3, id: 'steamVisible', label: 'Steam column on the horizon' },
  { at: 0, id: 'pass', label: 'Locomotive bursts past' },
  { at: 8, id: 'departingHorn', label: 'Departing horn, mournful' },
  { at: 15, id: 'crossingRelease', label: 'Barrier raises, bell stops, birds return' },
  { at: 20, id: 'quiet', label: 'The world falls quiet' },
] as const;

export type TrainCueId = (typeof TRAIN_SEQUENCE)[number]['id'];

/** Seven unlockable wagon liveries. Index 0 is available from the start. */
export const WAGON_LIVERIES = [
  { id: 'hollowGreen', label: 'Hollow Green', body: '#3f5f4a', trim: '#c8a24a', roof: '#2b3b32' },
  { id: 'emberRed', label: 'Ember Red', body: '#8e3a30', trim: '#e0b35e', roof: '#3a2320' },
  { id: 'harvestGold', label: 'Harvest Gold', body: '#b8843a', trim: '#f2e0b0', roof: '#4a3520' },
  { id: 'duskViolet', label: 'Dusk Violet', body: '#4a3f68', trim: '#b6a4dc', roof: '#2a2340' },
  { id: 'brookTeal', label: 'Brook Teal', body: '#2f5f63', trim: '#a8d8cf', roof: '#1e3a3d' },
  { id: 'snowAsh', label: 'Snow Ash', body: '#9aa2a8', trim: '#e8eef2', roof: '#4d565c' },
  { id: 'midnightBlue', label: 'Midnight Blue', body: '#25355c', trim: '#8fb4e8', roof: '#161f38' },
] as const;

export type WagonLiveryId = (typeof WAGON_LIVERIES)[number]['id'];

/** The wagon types drawn from, in order, behind the locomotive. */
export const WAGON_TYPES = [
  'tender',
  'passenger',
  'cargo',
  'flatbedLogs',
  'oilTank',
  'cattle',
  'mail',
] as const;

export type WagonType = (typeof WAGON_TYPES)[number];

/* ───────────────────────────────────────────────────────────────────────────
 * VILLAGE
 * ─────────────────────────────────────────────────────────────────────────── */

export const VILLAGE = {
  /** House counts by village-size setting. */
  HOUSE_COUNT: { small: 6, medium: 9, large: 13 } as Record<VillageSize, number>,
  /** Radius of the ring the houses are arranged around. */
  HOUSE_RING_RADIUS: 30,
  /** Random radial jitter applied to each house position. */
  HOUSE_RING_JITTER: 11,
  /** Radius of the cobblestone plaza at the village centre. */
  PLAZA_RADIUS: 15,
  /** Number of instanced cobblestones in the plaza. */
  COBBLE_COUNT: 2400,
  /** Market stalls around the plaza edge. */
  STALL_COUNT: 5,
  /** Hanging lanterns strung across the plaza. */
  LANTERN_COUNT: 22,
  /** Time-of-day at which window and lantern emissives ignite. */
  LIGHTS_ON_TIME: 0.79,
  /** Time-of-day at which they extinguish. */
  LIGHTS_OFF_TIME: 0.26,
  /** Fence posts around the cattle paddock. */
  PADDOCK_POSTS: 34,
  /** Cows in the paddock. */
  COW_COUNT: 4,
  /** Chickens pecking around the village. */
  CHICKEN_COUNT: 6,
  /** Graves in the small cemetery behind the church. */
  GRAVE_COUNT: 7,
  /** Telegraph poles along the rail corridor. */
  TELEGRAPH_POLES: 14,
} as const;

export const VILLAGE_SIZES = ['small', 'medium', 'large'] as const;
export type VillageSize = (typeof VILLAGE_SIZES)[number];

/* ───────────────────────────────────────────────────────────────────────────
 * WILDLIFE
 * ─────────────────────────────────────────────────────────────────────────── */

export const WILDLIFE = {
  BIRD_COUNT: 46,
  /** Radius within which a bird notices the player and startles. */
  BIRD_STARTLE_RADIUS: 7,
  /** Seconds a startled bird stays airborne before re-perching. */
  BIRD_FLIGHT_DURATION: 11,
  /** Wing-flap animation update rate, Hz (throttled for perf). */
  BIRD_FLAP_HZ: 30,

  BUTTERFLY_COUNT: 90,
  /** Butterflies only appear between these normalised times of day. */
  BUTTERFLY_ACTIVE: [0.28, 0.78] as [number, number],

  FIREFLY_COUNT: 420,
  /** Fireflies only appear between these normalised times of day. */
  FIREFLY_ACTIVE: [0.8, 0.22] as [number, number],
  /** Firefly blink period, seconds. */
  FIREFLY_BLINK_PERIOD: 2.6,

  DRAGONFLY_COUNT: 26,
  FISH_COUNT: 14,
  /** Seconds between spontaneous fish jumps. */
  FISH_JUMP_INTERVAL: 17,

  /** The fox only spawns after this normalised time (≈23:00). */
  FOX_SPAWN_TIME: 0.958,
  /** Player must stay under this speed for the fox not to flee. */
  FOX_SILENCE_SPEED: 1.2,
  /** Distance at which the fox flees if the player is moving too fast. */
  FOX_FLEE_DISTANCE: 12,
  /** Getting this close unlocks "Silent Friend". */
  FOX_FRIEND_DISTANCE: 3,
} as const;

/* ───────────────────────────────────────────────────────────────────────────
 * AUDIO
 * ─────────────────────────────────────────────────────────────────────────── */

export const AUDIO = {
  /** Default bus volumes, 0..1. Mirrored by the six settings sliders. */
  DEFAULT_VOLUMES: {
    master: 0.8,
    ambient: 0.7,
    wildlife: 0.6,
    train: 0.85,
    footsteps: 0.5,
    music: 0.35,
  },
  /** Length of the procedurally-rendered convolution reverb impulse, seconds. */
  IR_DURATION: 2.6,
  /** Exponential decay constant of that impulse. */
  IR_DECAY: 2.4,
  /** Pre-delay of the reverb send, seconds — sells the open-valley size. */
  IR_PREDELAY: 0.035,
  /** Master compressor settings; tames the horn without pumping the ambience. */
  COMPRESSOR: { threshold: -18, knee: 26, ratio: 6, attack: 0.006, release: 0.28 },
  /** Default HRTF panner rolloff. */
  PANNER: { refDistance: 4, maxDistance: 320, rolloffFactor: 1.05 },
  /** Speed of sound used for the Doppler calculation, wu/s. */
  SPEED_OF_SOUND: 343,
  /** Doppler effect is clamped to this pitch ratio range. */
  DOPPLER_CLAMP: [0.72, 1.34] as [number, number],
  /** Ambient music arpeggio tempo, BPM. */
  MUSIC_BPM: 52,
  /** Root frequency of the D-mixolydian bed. D3 ≈ 146.83 Hz. */
  MUSIC_ROOT_HZ: 146.83,
  /** Music duck amount (gain multiplier) while the train passes. */
  MUSIC_DUCK: 0.25,
} as const;

export const AUDIO_BUSES = [
  'master',
  'ambient',
  'wildlife',
  'train',
  'footsteps',
  'music',
] as const;
export type AudioBus = (typeof AUDIO_BUSES)[number];

/* ───────────────────────────────────────────────────────────────────────────
 * GRAPHICS QUALITY
 * ─────────────────────────────────────────────────────────────────────────── */

export const QUALITY_PRESETS = {
  potato: {
    label: 'Potato',
    resolutionScale: 0.5,
    shadows: 'off',
    shadowMapSize: 512,
    grassDensity: 0,
    treeCount: 90,
    lodDistanceScale: 0.4,
    postProcessing: false,
    ssao: false,
    bloom: false,
    godRays: false,
    depthOfField: false,
    chromaticAberration: false,
    vignette: true,
    smaa: false,
    waterReflection: false,
    maxParticles: 0.15,
    anisotropy: 1,
  },
  low: {
    label: 'Low',
    resolutionScale: 0.7,
    shadows: 'low',
    shadowMapSize: 1024,
    grassDensity: 0.25,
    treeCount: 170,
    lodDistanceScale: 0.6,
    postProcessing: true,
    ssao: false,
    bloom: true,
    godRays: false,
    depthOfField: false,
    chromaticAberration: false,
    vignette: true,
    smaa: false,
    waterReflection: false,
    maxParticles: 0.35,
    anisotropy: 2,
  },
  medium: {
    label: 'Medium',
    resolutionScale: 0.85,
    shadows: 'medium',
    shadowMapSize: 1024,
    grassDensity: 0.55,
    treeCount: 260,
    lodDistanceScale: 0.8,
    postProcessing: true,
    ssao: false,
    bloom: true,
    godRays: true,
    depthOfField: false,
    chromaticAberration: true,
    vignette: true,
    smaa: true,
    waterReflection: true,
    maxParticles: 0.6,
    anisotropy: 4,
  },
  high: {
    label: 'High',
    resolutionScale: 1.0,
    shadows: 'high',
    shadowMapSize: 2048,
    grassDensity: 1.0,
    treeCount: 420,
    lodDistanceScale: 1.0,
    postProcessing: true,
    ssao: true,
    bloom: true,
    godRays: true,
    depthOfField: true,
    chromaticAberration: true,
    vignette: true,
    smaa: true,
    waterReflection: true,
    maxParticles: 1.0,
    anisotropy: 8,
  },
  cinematic: {
    label: 'Cinematic',
    resolutionScale: 1.25,
    shadows: 'ultra',
    shadowMapSize: 2048,
    grassDensity: 1.6,
    treeCount: 520,
    lodDistanceScale: 1.35,
    postProcessing: true,
    ssao: true,
    bloom: true,
    godRays: true,
    depthOfField: true,
    chromaticAberration: true,
    vignette: true,
    smaa: true,
    waterReflection: true,
    maxParticles: 1.5,
    anisotropy: 16,
  },
} as const;

export type QualityPresetId = keyof typeof QUALITY_PRESETS | 'custom';
export type QualitySettings = (typeof QUALITY_PRESETS)['high'];
export type ShadowQuality = 'off' | 'low' | 'medium' | 'high' | 'ultra';

export const SHADOW_CONFIG: Record<
  ShadowQuality,
  { enabled: boolean; mapSize: number; cascades: number; far: number; bias: number }
> = {
  off: { enabled: false, mapSize: 512, cascades: 1, far: 60, bias: -0.0006 },
  low: { enabled: true, mapSize: 1024, cascades: 1, far: 80, bias: -0.0008 },
  medium: { enabled: true, mapSize: 1024, cascades: 2, far: 130, bias: -0.0006 },
  high: { enabled: true, mapSize: 2048, cascades: 3, far: 190, bias: -0.0004 },
  ultra: { enabled: true, mapSize: 2048, cascades: 4, far: 260, bias: -0.0003 },
};

/** The four grade presets plus the colourblind-assist filters. */
export const COLOR_GRADES = {
  goldenHour: {
    label: 'Golden Hour',
    lift: [0.012, 0.004, -0.008] as Vector3Tuple,
    gamma: [1.0, 0.99, 1.03] as Vector3Tuple,
    gain: [1.08, 1.02, 0.93] as Vector3Tuple,
    saturation: 1.08,
    contrast: 1.04,
    grain: 0.0,
  },
  storybook: {
    label: 'Storybook',
    lift: [0.03, 0.028, 0.026] as Vector3Tuple,
    gamma: [0.95, 0.95, 0.95] as Vector3Tuple,
    gain: [1.04, 1.05, 1.02] as Vector3Tuple,
    saturation: 1.34,
    contrast: 0.96,
    grain: 0.0,
  },
  cinematic: {
    label: 'Cinematic',
    lift: [-0.01, 0.002, 0.02] as Vector3Tuple,
    gamma: [1.02, 1.0, 0.98] as Vector3Tuple,
    gain: [1.1, 1.0, 0.9] as Vector3Tuple,
    saturation: 1.02,
    contrast: 1.14,
    grain: 0.012,
  },
  nostalgicFilm: {
    label: 'Nostalgic Film',
    lift: [0.028, 0.024, 0.016] as Vector3Tuple,
    gamma: [1.04, 1.02, 1.0] as Vector3Tuple,
    gain: [1.02, 0.99, 0.95] as Vector3Tuple,
    saturation: 0.78,
    contrast: 0.98,
    grain: 0.045,
  },
} as const;

export type ColorGradeId = keyof typeof COLOR_GRADES;

export const COLORBLIND_MODES = ['none', 'protanopia', 'deuteranopia', 'tritanopia'] as const;
export type ColorblindMode = (typeof COLORBLIND_MODES)[number];

export const POSTFX = {
  BLOOM: { intensity: 0.62, luminanceThreshold: 0.72, luminanceSmoothing: 0.28, mipmapBlur: true },
  SSAO: { samples: 16, radius: 0.28, intensity: 22, luminanceInfluence: 0.55, bias: 0.03 },
  GOD_RAYS: { density: 0.82, decay: 0.93, weight: 0.42, exposure: 0.5, samples: 48, clampMax: 1.0 },
  DOF: { focusDistance: 0.012, focalLength: 0.028, bokehScale: 2.6 },
  /** Seconds the player must stand still before depth-of-field eases in. */
  DOF_IDLE_DELAY: 5,
  CHROMATIC_ABERRATION: 0.0005,
  VIGNETTE: { offset: 0.28, darkness: 0.62 },
  /** Renderer tone-mapping exposure; the settings slider scales this. */
  TONE_MAPPING_EXPOSURE: 1.0,
} as const;

export const PERFORMANCE = {
  /** FPS below which the adaptive quality controller downshifts a tier. */
  DOWNSHIFT_FPS: 42,
  /** FPS above which it may upshift again. */
  UPSHIFT_FPS: 58,
  /** Seconds of sustained low FPS required before downshifting. */
  DOWNSHIFT_HOLD: 3.5,
  /** Seconds of sustained high FPS required before upshifting. */
  UPSHIFT_HOLD: 12,
  /** Pond reflection probe refresh rate, Hz. */
  REFLECTION_HZ: 15,
  /** Cheap animations (clouds, distant wildlife) update at this rate. */
  LOW_PRIORITY_HZ: 10,
  /** Spatial hash cell size used for instance culling and obstacle lookup. */
  SPATIAL_HASH_CELL: 16,
  /**
   * Hard cap on device pixel ratio regardless of resolution scale.
   *
   * 1.5, not 2. The postprocessing chain allocates roughly a dozen half-float
   * render targets at the drawing-buffer size; at DPR 2 on a 1440p display
   * that is four times the pixels of DPR 1 and several hundred megabytes of
   * GPU memory, which is enough to lose the context on modest hardware. The
   * visual difference between 1.5 and 2 with SMAA enabled is very hard to see.
   */
  MAX_DPR: 1.5,
} as const;

/* ───────────────────────────────────────────────────────────────────────────
 * MULTIPLAYER
 * ─────────────────────────────────────────────────────────────────────────── */

export const MULTIPLAYER = {
  /** Hard cap on players sharing one world instance. */
  MAX_PLAYERS: 8,
  /** Position/rotation broadcast rate, Hz. */
  SYNC_HZ: 10,
  /** Minimum movement before a position update is worth sending. */
  SYNC_MIN_DELTA: 0.08,
  /** Presence entries older than this are treated as disconnected. */
  STALE_AFTER: 30,
  /** Seconds an emote animation plays for. */
  EMOTE_DURATION: 3.2,
  /** Interpolation half-life for remote ghost avatars, seconds. */
  GHOST_SMOOTHING: 0.12,
  /** Opacity of remote ghost avatars. */
  GHOST_OPACITY: 0.45,
} as const;

export const EMOTES = [
  { id: 'wave', label: 'Wave', icon: '👋' },
  { id: 'sit', label: 'Sit', icon: '🪑' },
  { id: 'point', label: 'Point', icon: '👉' },
  { id: 'cheer', label: 'Cheer', icon: '🎉' },
  { id: 'shrug', label: 'Shrug', icon: '🤷' },
] as const;

export type EmoteId = (typeof EMOTES)[number]['id'];

export const WORLD_MODES = ['solo', 'private', 'public'] as const;
export type WorldMode = (typeof WORLD_MODES)[number];

/* ───────────────────────────────────────────────────────────────────────────
 * PHOTO MODE
 * ─────────────────────────────────────────────────────────────────────────── */

export const PHOTO = {
  /** Free-fly movement speed, wu/s. */
  FLY_SPEED: 8,
  /** Speed multiplier while holding shift. */
  FLY_BOOST: 3.2,
  /** Focal length range exposed to the slider, mm-equivalent. */
  FOCAL_LENGTH: [14, 135] as [number, number],
  /** Aperture range, f-stops. Lower = shallower depth of field. */
  APERTURE: [1.4, 22] as [number, number],
  /** Roll angle range, degrees. */
  ROLL: [-30, 30] as [number, number],
  /** Aspect-ratio presets offered in photo mode. */
  ASPECT_RATIOS: [
    { id: 'native', label: 'Native', value: 0 },
    { id: '16:9', label: '16:9', value: 16 / 9 },
    { id: '21:9', label: '21:9 Cinema', value: 21 / 9 },
    { id: '4:3', label: '4:3', value: 4 / 3 },
    { id: '1:1', label: '1:1 Square', value: 1 },
    { id: '9:16', label: '9:16 Vertical', value: 9 / 16 },
  ] as const,
  /** Max screenshots kept in the local gallery when signed out. */
  LOCAL_GALLERY_LIMIT: 24,
  /** JPEG quality for uploaded screenshots. */
  JPEG_QUALITY: 0.92,
} as const;

/* ───────────────────────────────────────────────────────────────────────────
 * ONBOARDING
 * ─────────────────────────────────────────────────────────────────────────── */

export const INTRO = {
  /** Duration of the GSAP flyover before control is handed to the player. */
  FLYOVER_DURATION: 8,
  /** Waypoints the intro camera passes through: [position, lookAt]. */
  FLYOVER_PATH: [
    { pos: [-62, 58, 96] as Vector3Tuple, look: [0, 8, 0] as Vector3Tuple },
    { pos: [-18, 26, 54] as Vector3Tuple, look: [4, 6, 4] as Vector3Tuple },
    { pos: [8, 9, 38] as Vector3Tuple, look: [2, 5, 6] as Vector3Tuple },
    { pos: [6, 3.2, 28] as Vector3Tuple, look: [2, 3, 10] as Vector3Tuple },
  ],
  /** Onboarding hints, shown in sequence and dismissed on first use. */
  HINTS: [
    { id: 'click', text: 'Click to explore', dismissOn: 'pointerlock' },
    { id: 'move', text: 'WASD to walk · Mouse to look', dismissOn: 'move' },
    { id: 'sprint', text: 'Shift to run', dismissOn: 'sprint' },
    { id: 'interact', text: 'F to interact', dismissOn: 'interact' },
    { id: 'photo', text: 'P for photo mode · Esc for settings', dismissOn: 'photo' },
  ] as const,
  /** Seconds each hint remains before the next one appears. */
  HINT_DURATION: 6,
} as const;

/* ───────────────────────────────────────────────────────────────────────────
 * DEFAULT KEY BINDINGS
 * ─────────────────────────────────────────────────────────────────────────── */

export const DEFAULT_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  backward: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['KeyC', 'ControlLeft'],
  interact: ['KeyF'],
  photoMode: ['KeyP'],
  thirdPerson: ['KeyV'],
  character: ['Tab'],
  emote: ['KeyE'],
  journal: ['KeyJ'],
  map: ['KeyM'],
  lantern: ['KeyL'],
} as const;

export type BindingAction = keyof typeof DEFAULT_BINDINGS;
export type KeyBindings = Record<BindingAction, string[]>;

/** Human-readable labels for the rebinding UI. */
export const BINDING_LABELS: Record<BindingAction, string> = {
  forward: 'Walk forward',
  backward: 'Walk backward',
  left: 'Strafe left',
  right: 'Strafe right',
  jump: 'Jump',
  sprint: 'Sprint',
  crouch: 'Crouch',
  interact: 'Interact',
  photoMode: 'Photo mode',
  thirdPerson: 'Toggle third person',
  character: 'Character panel',
  emote: 'Emote wheel',
  journal: 'Journal',
  map: 'Map / compass',
  lantern: 'Toggle lantern',
};

/* ───────────────────────────────────────────────────────────────────────────
 * AVATAR CUSTOMISATION
 * ─────────────────────────────────────────────────────────────────────────── */

export const AVATAR = {
  SKIN_TONES: ['#f2d5bd', '#e0b490', '#c68e64', '#96603c', '#5d3a25'],
  HAIR_STYLES: ['short', 'bob', 'ponytail', 'braids', 'curly', 'bald'] as const,
  HAIR_COLORS: [
    '#2b2018',
    '#4a3527',
    '#7a5230',
    '#a8742f',
    '#d8b26a',
    '#e8d9a8',
    '#8c3a2a',
    '#b0563c',
    '#6a6f78',
    '#d8dde2',
  ],
  OUTFITS: [
    { id: 'linen', label: 'Linen Shirt', primary: '#e6ddc8', secondary: '#7b6a52' },
    { id: 'farmer', label: 'Farmer Overalls', primary: '#4a6a8c', secondary: '#c8b98e' },
    { id: 'traveller', label: 'Traveller Coat', primary: '#6a5340', secondary: '#3d3128' },
    { id: 'meadow', label: 'Meadow Dress', primary: '#a8c46a', secondary: '#e8e0c0' },
    { id: 'dusk', label: 'Dusk Cloak', primary: '#4a3f68', secondary: '#8f80b8' },
    { id: 'baker', label: 'Baker Apron', primary: '#f0eae0', secondary: '#c26a4a' },
    { id: 'ranger', label: 'Ranger Green', primary: '#3f5f4a', secondary: '#8a6a3c' },
    { id: 'winter', label: 'Winter Knit', primary: '#b8c8d8', secondary: '#6a7a8c' },
  ] as const,
  HATS: [
    { id: 'none', label: 'None' },
    { id: 'straw', label: 'Farmer Straw' },
    { id: 'cap', label: 'Adventurer Cap' },
    { id: 'wizard', label: 'Wizard Hat' },
    { id: 'beanie', label: 'Wool Beanie' },
    { id: 'bucket', label: 'Bucket Hat' },
    { id: 'flowerCrown', label: 'Flower Crown' },
    { id: 'conductor', label: "Conductor's Cap" },
    { id: 'scarf', label: 'Hooded Scarf' },
    { id: 'lantern', label: 'Lantern Headband' },
    { id: 'antlers', label: 'Autumn Antlers' },
    { id: 'crown', label: 'Hollow Crown' },
  ] as const,
  BACKPACKS: [
    { id: 'none', label: 'None' },
    { id: 'satchel', label: 'Leather Satchel' },
    { id: 'rucksack', label: 'Canvas Rucksack' },
    { id: 'basket', label: 'Wicker Basket' },
    { id: 'bedroll', label: 'Bedroll Pack' },
  ] as const,
  /** Point-light parameters for the hand-held lantern. */
  LANTERN: { color: '#ffb964', intensity: 5.2, distance: 14, swayAmplitude: 0.14 },
} as const;

export type HairStyle = (typeof AVATAR.HAIR_STYLES)[number];
export type OutfitId = (typeof AVATAR.OUTFITS)[number]['id'];
export type HatId = (typeof AVATAR.HATS)[number]['id'];
export type BackpackId = (typeof AVATAR.BACKPACKS)[number]['id'];

export interface AvatarConfig {
  skinTone: number;
  hairStyle: HairStyle;
  hairColor: number;
  outfit: OutfitId;
  hat: HatId;
  backpack: BackpackId;
  lantern: boolean;
  /** Hex colour used to tint this player's ghost avatar for others. */
  ghostColor: string;
}

export const DEFAULT_AVATAR: AvatarConfig = {
  skinTone: 1,
  hairStyle: 'short',
  hairColor: 1,
  outfit: 'linen',
  hat: 'none',
  backpack: 'satchel',
  lantern: false,
  ghostColor: '#8fd0ff',
};

/* ───────────────────────────────────────────────────────────────────────────
 * ECONOMY
 * ─────────────────────────────────────────────────────────────────────────── */

export const ECONOMY = {
  /** Coins scattered around the map's quiet corners. */
  COIN_COUNT: 40,
  /** Coins granted per achievement unlocked. */
  COINS_PER_ACHIEVEMENT: 15,
  /** Trinket prices at the market stalls. */
  TRINKET_PRICES: { pinwheel: 20, birdhouse: 35, chime: 45, gnome: 30, sundial: 60 },
  /** Cost of a bag of grain for feeding animals. */
  GRAIN_PRICE: 5,
} as const;

/* ───────────────────────────────────────────────────────────────────────────
 * ACCESSIBILITY
 * ─────────────────────────────────────────────────────────────────────────── */

export const ACCESSIBILITY = {
  /** UI scale slider bounds. */
  UI_SCALE: [0.75, 1.6] as [number, number],
  /** Seconds an audio subtitle stays on screen. */
  SUBTITLE_DURATION: 3.2,
  /** Maximum simultaneous subtitles. */
  SUBTITLE_MAX: 4,
} as const;

/* ───────────────────────────────────────────────────────────────────────────
 * PERSISTENCE
 * ─────────────────────────────────────────────────────────────────────────── */

export const STORAGE_KEYS = {
  SETTINGS: 'wh.settings.v1',
  PROGRESS: 'wh.progress.v1',
  AVATAR: 'wh.avatar.v1',
  GALLERY: 'wh.gallery.v1',
  WORLDS: 'wh.worlds.v1',
  ONBOARDING: 'wh.onboarding.v1',
} as const;

/** Seconds between automatic cloud syncs of progress. */
export const AUTOSAVE_INTERVAL = 30;
