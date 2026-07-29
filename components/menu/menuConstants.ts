/**
 * Menu copy that isn't a tunable game constant.
 *
 * @module components/menu/menuConstants
 */

export type WorldMode = 'solo' | 'private' | 'public';

/** The three world visibility modes, with player-facing descriptions. */
export const WORLD_MODES: ReadonlyArray<{
  id: WorldMode;
  label: string;
  description: string;
}> = [
  { id: 'solo', label: 'Solo', description: 'Just you' },
  { id: 'private', label: 'Private', description: 'Share the seed' },
  { id: 'public', label: 'Public', description: 'Anyone may wander in' },
];

/** Kept so `MainMenu` can import a stable name; the real total lives in content. */
export const TOTAL_DISCOVERIES_PLACEHOLDER = 40;
