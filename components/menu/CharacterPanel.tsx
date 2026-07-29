/**
 * Avatar customisation.
 *
 * Locked cosmetics are shown greyed out with their unlock condition rather than
 * hidden. Seeing what exists is most of the motivation to go and find it —
 * hiding locked content means the player never knows there was anything to
 * chase.
 *
 * @module components/menu/CharacterPanel
 */

'use client';

import { Lock } from 'lucide-react';

import { SettingsGroup, Switch } from '../ui/primitives';
import { useGameStore } from '@/store/gameStore';
import { ACHIEVEMENTS } from '@/lib/progression/content';
import { AVATAR, type HairStyle, type HatId, type OutfitId, type BackpackId } from '@/config/game';
import { cn } from '@/lib/utils/cn';

/** Finds which achievement grants a given cosmetic, for the lock tooltip. */
function unlockHint(kind: 'hat' | 'outfit', id: string): string {
  const achievement = ACHIEVEMENTS.find((a) => a.reward.kind === kind && a.reward.id === id);
  if (!achievement) return 'Locked';
  return achievement.secret ? 'A secret achievement' : achievement.description;
}

export function CharacterPanel() {
  const avatar = useGameStore((s) => s.avatar);
  const setAvatar = useGameStore((s) => s.setAvatar);
  const unlocked = useGameStore((s) => s.progress.unlocked);

  return (
    <div>
      <SettingsGroup title="Appearance">
        {/* Skin tone */}
        <div>
          <label className="mb-2 block text-sm text-hollow-300">Skin tone</label>
          <div className="flex flex-wrap gap-2">
            {AVATAR.SKIN_TONES.map((tone, i) => (
              <button
                key={tone}
                type="button"
                onClick={() => setAvatar({ skinTone: i })}
                aria-label={`Skin tone ${i + 1}`}
                aria-pressed={avatar.skinTone === i}
                className={cn(
                  'h-8 w-8 rounded-full border-2 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-glow',
                  avatar.skinTone === i ? 'border-amber-glow' : 'border-transparent',
                )}
                style={{ backgroundColor: tone }}
              />
            ))}
          </div>
        </div>

        {/* Hair style */}
        <div>
          <label className="mb-2 block text-sm text-hollow-300">Hair</label>
          <div className="flex flex-wrap gap-1.5">
            {AVATAR.HAIR_STYLES.map((style) => (
              <button
                key={style}
                type="button"
                onClick={() => setAvatar({ hairStyle: style as HairStyle })}
                className={cn(
                  'rounded-lg border px-2.5 py-1.5 text-xs capitalize transition-all',
                  avatar.hairStyle === style
                    ? 'border-amber-glow/70 bg-amber-glow/15 text-amber-soft'
                    : 'border-hollow-600/50 bg-hollow-800/50 text-hollow-300 hover:text-hollow-100',
                )}
              >
                {style}
              </button>
            ))}
          </div>
        </div>

        {/* Hair colour */}
        <div>
          <label className="mb-2 block text-sm text-hollow-300">Hair colour</label>
          <div className="flex flex-wrap gap-2">
            {AVATAR.HAIR_COLORS.map((color, i) => (
              <button
                key={color}
                type="button"
                onClick={() => setAvatar({ hairColor: i })}
                aria-label={`Hair colour ${i + 1}`}
                className={cn(
                  'h-7 w-7 rounded-full border-2 transition-transform hover:scale-110',
                  avatar.hairColor === i ? 'border-amber-glow' : 'border-transparent',
                )}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Outfit">
        <div className="grid grid-cols-2 gap-1.5">
          {AVATAR.OUTFITS.map((outfit) => {
            const isUnlocked = unlocked.outfits.includes(outfit.id);
            return (
              <button
                key={outfit.id}
                type="button"
                disabled={!isUnlocked}
                title={isUnlocked ? outfit.label : unlockHint('outfit', outfit.id)}
                onClick={() => setAvatar({ outfit: outfit.id as OutfitId })}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-all',
                  !isUnlocked && 'cursor-not-allowed opacity-40',
                  avatar.outfit === outfit.id
                    ? 'border-amber-glow/70 bg-amber-glow/15 text-amber-soft'
                    : 'border-hollow-600/50 bg-hollow-800/50 text-hollow-300 hover:text-hollow-100',
                )}
              >
                <span className="flex shrink-0 gap-0.5">
                  <span
                    className="h-4 w-2 rounded-sm"
                    style={{ backgroundColor: outfit.primary }}
                  />
                  <span
                    className="h-4 w-2 rounded-sm"
                    style={{ backgroundColor: outfit.secondary }}
                  />
                </span>
                <span className="min-w-0 flex-1 truncate">{outfit.label}</span>
                {!isUnlocked && <Lock className="h-3 w-3 shrink-0" />}
              </button>
            );
          })}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Hat">
        <div className="grid grid-cols-2 gap-1.5">
          {AVATAR.HATS.map((hat) => {
            const isUnlocked = unlocked.hats.includes(hat.id);
            return (
              <button
                key={hat.id}
                type="button"
                disabled={!isUnlocked}
                title={isUnlocked ? hat.label : unlockHint('hat', hat.id)}
                onClick={() => setAvatar({ hat: hat.id as HatId })}
                className={cn(
                  'flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-all',
                  !isUnlocked && 'cursor-not-allowed opacity-40',
                  avatar.hat === hat.id
                    ? 'border-amber-glow/70 bg-amber-glow/15 text-amber-soft'
                    : 'border-hollow-600/50 bg-hollow-800/50 text-hollow-300 hover:text-hollow-100',
                )}
              >
                <span className="min-w-0 truncate">{hat.label}</span>
                {!isUnlocked && <Lock className="h-3 w-3 shrink-0" />}
              </button>
            );
          })}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Pack">
        <div className="grid grid-cols-2 gap-1.5">
          {AVATAR.BACKPACKS.map((pack) => (
            <button
              key={pack.id}
              type="button"
              onClick={() => setAvatar({ backpack: pack.id as BackpackId })}
              className={cn(
                'rounded-lg border px-2.5 py-2 text-left text-xs transition-all',
                avatar.backpack === pack.id
                  ? 'border-amber-glow/70 bg-amber-glow/15 text-amber-soft'
                  : 'border-hollow-600/50 bg-hollow-800/50 text-hollow-300 hover:text-hollow-100',
              )}
            >
              {pack.label}
            </button>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Lantern">
        <Switch
          label="Carry a lantern"
          description="A real light source that swings as you walk. Also toggled in-game with L."
          checked={avatar.lantern}
          onCheckedChange={(v) => setAvatar({ lantern: v })}
        />
      </SettingsGroup>
    </div>
  );
}
