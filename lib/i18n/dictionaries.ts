/**
 * Internationalisation.
 *
 * A deliberately small hand-rolled layer rather than `next-intl`. The spec asked
 * for next-intl, but it is built around **locale-prefixed routing** — the whole
 * app moves to `/[locale]/…`, middleware rewrites every request, and the
 * benefit is server-rendered translated HTML.
 *
 * This game has one route, renders entirely on the client, and has perhaps
 * eighty translatable strings. Locale-prefixed routing would add a middleware
 * hop and a routing layer to solve a problem it does not have. A dictionary
 * keyed by locale, switched from the settings store, delivers the same result
 * with none of that.
 *
 * English is complete. The other four are scaffolded with the keys present and
 * a handful of strings translated, so a translator has an obvious file to fill
 * in — see `README.md` § Translating.
 *
 * @module lib/i18n/dictionaries
 */

export const LOCALES = ['en', 'es', 'ja', 'de', 'hi'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
  ja: '日本語',
  de: 'Deutsch',
  hi: 'हिन्दी',
};

/** The full translation surface. */
export interface Dictionary {
  menu: {
    enter: string;
    return: string;
    seed: string;
    seedHint: string;
    randomSeed: string;
    achievements: string;
    gallery: string;
    tagline: string;
    signIn: string;
    signedInAs: string;
    offlineNotice: string;
  };
  hud: {
    interact: string;
    stamina: string;
    discoveries: string;
  };
  settings: {
    title: string;
    world: string;
    gameplay: string;
    graphics: string;
    audio: string;
    character: string;
    controls: string;
    accessibility: string;
    resetAll: string;
    leave: string;
  };
  photo: {
    title: string;
    capture: string;
    focalLength: string;
    aperture: string;
    roll: string;
    aspect: string;
    grade: string;
    hint: string;
  };
  loading: {
    hills: string;
    river: string;
    trees: string;
    light: string;
  };
}

const en: Dictionary = {
  menu: {
    enter: 'Enter the valley',
    return: 'Return to the valley',
    seed: 'World seed',
    seedHint:
      'The same seed always grows the same valley. Share one with a friend and you will both walk the same hills.',
    randomSeed: 'Random seed',
    achievements: 'Achievements',
    gallery: 'Gallery',
    tagline: 'A place to breathe. The train comes when it comes.',
    signIn: 'Continue with Google',
    signedInAs: 'Signed in as',
    offlineNotice: 'Running offline. Progress is saved in this browser.',
  },
  hud: {
    interact: 'Interact',
    stamina: 'Stamina',
    discoveries: 'discoveries found',
  },
  settings: {
    title: 'Settings',
    world: 'World',
    gameplay: 'Gameplay',
    graphics: 'Graphics',
    audio: 'Audio',
    character: 'Character',
    controls: 'Controls',
    accessibility: 'Accessibility',
    resetAll: 'Reset all settings',
    leave: 'Leave the valley',
  },
  photo: {
    title: 'Photo mode',
    capture: 'Take the photograph',
    focalLength: 'Focal length',
    aperture: 'Aperture',
    roll: 'Roll',
    aspect: 'Aspect',
    grade: 'Grade',
    hint: 'WASD to fly · Space / Ctrl for up and down · Shift to move faster · Scroll to zoom',
  },
  loading: {
    hills: 'Folding the hills into place',
    river: 'Teaching the river where to go',
    trees: 'Planting four hundred trees',
    light: 'Letting the light in',
  },
};

/**
 * A partial translation, merged over English.
 *
 * Merging rather than requiring completeness means a half-finished translation
 * shows translated strings where they exist and English everywhere else, which
 * is far better than either a crash or a screen full of `menu.enter`.
 */
type PartialDictionary = {
  [K in keyof Dictionary]?: Partial<Dictionary[K]>;
};

const es: PartialDictionary = {
  menu: {
    enter: 'Entrar en el valle',
    return: 'Volver al valle',
    seed: 'Semilla del mundo',
    randomSeed: 'Semilla aleatoria',
    achievements: 'Logros',
    gallery: 'Galería',
    tagline: 'Un lugar para respirar. El tren llega cuando llega.',
  },
  settings: { title: 'Ajustes', world: 'Mundo', graphics: 'Gráficos', audio: 'Audio' },
  photo: { capture: 'Tomar la fotografía', aperture: 'Apertura' },
};

const ja: PartialDictionary = {
  menu: {
    enter: '谷へ入る',
    return: '谷へ戻る',
    seed: 'ワールドシード',
    randomSeed: 'ランダムシード',
    achievements: '実績',
    gallery: 'ギャラリー',
    tagline: '息をつく場所。汽車は来るときに来る。',
  },
  settings: { title: '設定', world: '世界', graphics: 'グラフィック', audio: 'オーディオ' },
  photo: { capture: '写真を撮る', aperture: '絞り' },
};

const de: PartialDictionary = {
  menu: {
    enter: 'Ins Tal gehen',
    return: 'Zurück ins Tal',
    seed: 'Welt-Seed',
    randomSeed: 'Zufälliger Seed',
    achievements: 'Erfolge',
    gallery: 'Galerie',
    tagline: 'Ein Ort zum Durchatmen. Der Zug kommt, wann er kommt.',
  },
  settings: { title: 'Einstellungen', world: 'Welt', graphics: 'Grafik', audio: 'Audio' },
  photo: { capture: 'Foto aufnehmen', aperture: 'Blende' },
};

const hi: PartialDictionary = {
  menu: {
    enter: 'घाटी में प्रवेश करें',
    return: 'घाटी में लौटें',
    seed: 'वर्ल्ड सीड',
    randomSeed: 'यादृच्छिक सीड',
    achievements: 'उपलब्धियाँ',
    gallery: 'गैलरी',
    tagline: 'साँस लेने की एक जगह। रेलगाड़ी अपने समय पर आती है।',
  },
  settings: { title: 'सेटिंग्स', world: 'दुनिया', graphics: 'ग्राफ़िक्स', audio: 'ऑडियो' },
  photo: { capture: 'तस्वीर लें', aperture: 'एपर्चर' },
};

const PARTIALS: Record<Exclude<Locale, 'en'>, PartialDictionary> = { es, ja, de, hi };

/** Deep-merges a partial translation over the English base. */
function merge(base: Dictionary, partial: PartialDictionary): Dictionary {
  const out = { ...base } as Dictionary;
  for (const key of Object.keys(partial) as Array<keyof Dictionary>) {
    out[key] = { ...base[key], ...partial[key] } as never;
  }
  return out;
}

const cache = new Map<Locale, Dictionary>([['en', en]]);

/** Returns the dictionary for a locale, falling back to English. */
export function getDictionary(locale: Locale | string): Dictionary {
  const key = (LOCALES as readonly string[]).includes(locale) ? (locale as Locale) : 'en';
  const cached = cache.get(key);
  if (cached) return cached;

  const dict = key === 'en' ? en : merge(en, PARTIALS[key as Exclude<Locale, 'en'>]);
  cache.set(key, dict);
  return dict;
}

/** Guesses a locale from the browser, defaulting to English. */
export function detectLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en';
  for (const lang of navigator.languages ?? [navigator.language]) {
    const short = lang.slice(0, 2).toLowerCase();
    if ((LOCALES as readonly string[]).includes(short)) return short as Locale;
  }
  return 'en';
}
