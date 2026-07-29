/**
 * The settings panel — seven tabs, sliding in from the right.
 *
 * @module components/menu/SettingsPanel
 */

'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { X, RotateCcw, Globe, Gamepad2, Monitor, Volume2, User, Keyboard, Accessibility } from 'lucide-react';

import {
  Button,
  Slider,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  ScrollArea,
  SettingsGroup,
  ChipGroup,
} from '../ui/primitives';
import { CharacterPanel } from './CharacterPanel';
import { useSettingsStore } from '@/store/settingsStore';
import { useGameStore } from '@/store/gameStore';
import { formatKeyCode } from '@/hooks/useKeyboard';
import { TIME_PRESETS } from '@/hooks/useTimeOfDay';
import {
  QUALITY_PRESETS,
  COLOR_GRADES,
  COLORBLIND_MODES,
  WEATHER,
  WEATHER_IDS,
  SEASONS,
  SEASON_IDS,
  VILLAGE_SIZES,
  BINDING_LABELS,
  DEFAULT_BINDINGS,
  TRAIN,
  ACCESSIBILITY,
  AUDIO_BUSES,
  type BindingAction,
  type QualityPresetId,
  type ShadowQuality,
  type ColorGradeId,
  type ColorblindMode,
  type WeatherId,
  type SeasonId,
  type VillageSize,
} from '@/config/game';
import { formatTimeOfDay } from '@/lib/utils/math';
import { cn } from '@/lib/utils/cn';

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const settings = useSettingsStore();
  const [rebinding, setRebinding] = useState<BindingAction | null>(null);

  return (
    <motion.aside
      initial={{ x: '100%', opacity: 0.6 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: '100%', opacity: 0.6 }}
      transition={{ type: 'spring', stiffness: 320, damping: 34 }}
      className="glass pointer-events-auto fixed right-0 top-0 z-[120] flex h-full w-[min(94vw,30rem)] flex-col rounded-l-panel"
      role="dialog"
      aria-label="Settings"
    >
      <header className="flex shrink-0 items-center justify-between border-b border-hollow-600/30 px-5 py-4">
        <h2 className="font-display text-xl tracking-wide text-hollow-100">Settings</h2>
        <Button variant="ghost" size="icon" onClick={onClose} sound="back" aria-label="Close settings">
          <X className="h-4 w-4" />
        </Button>
      </header>

      <Tabs defaultValue="world" className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-3 pt-3">
          <TabsList className="w-full">
            <TabsTrigger value="world" className="flex-1"><Globe className="h-3.5 w-3.5" /></TabsTrigger>
            <TabsTrigger value="gameplay" className="flex-1"><Gamepad2 className="h-3.5 w-3.5" /></TabsTrigger>
            <TabsTrigger value="graphics" className="flex-1"><Monitor className="h-3.5 w-3.5" /></TabsTrigger>
            <TabsTrigger value="audio" className="flex-1"><Volume2 className="h-3.5 w-3.5" /></TabsTrigger>
            <TabsTrigger value="character" className="flex-1"><User className="h-3.5 w-3.5" /></TabsTrigger>
            <TabsTrigger value="controls" className="flex-1"><Keyboard className="h-3.5 w-3.5" /></TabsTrigger>
            <TabsTrigger value="access" className="flex-1"><Accessibility className="h-3.5 w-3.5" /></TabsTrigger>
          </TabsList>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="px-5 pb-8 pt-2">
            {/* ══════════════════════════════════════════════════════════════
                WORLD
                ══════════════════════════════════════════════════════════════ */}
            <TabsContent value="world">
              <SettingsGroup title="Time">
                <Switch
                  label="Time flows"
                  description="Pause the clock to hold a moment indefinitely."
                  checked={settings.world.timeFlowing}
                  onCheckedChange={(v) => settings.setWorld({ timeFlowing: v })}
                />
                <Slider
                  label="Time of day"
                  min={0}
                  max={1}
                  step={0.001}
                  value={[settings.world.timeOfDay]}
                  format={formatTimeOfDay}
                  onValueChange={([v]) => {
                    settings.setWorld({ timeOfDay: v! });
                    useGameStore.getState().setTimeOfDay(v!);
                  }}
                />
                <ChipGroup
                  options={TIME_PRESETS.map((p) => ({ id: p.id, label: p.label }))}
                  value={
                    TIME_PRESETS.reduce((closest, p) =>
                      Math.abs(p.t - settings.world.timeOfDay) <
                      Math.abs(closest.t - settings.world.timeOfDay)
                        ? p
                        : closest,
                    ).id
                  }
                  onChange={(id) => {
                    const preset = TIME_PRESETS.find((p) => p.id === id);
                    if (preset) {
                      settings.setWorld({ timeOfDay: preset.t });
                      useGameStore.getState().setTimeOfDay(preset.t);
                    }
                  }}
                />
                <Slider
                  label="Day length"
                  min={120}
                  max={3600}
                  step={30}
                  value={[settings.world.dayLength]}
                  format={(v) => `${Math.round(v / 60)} min`}
                  onValueChange={([v]) => settings.setWorld({ dayLength: v! })}
                />
              </SettingsGroup>

              <SettingsGroup title="Weather">
                <Switch
                  label="Weather drifts on its own"
                  description="Conditions evolve slowly rather than staying fixed."
                  checked={settings.world.weatherAuto}
                  onCheckedChange={(v) => settings.setWorld({ weatherAuto: v })}
                />
                {!settings.world.weatherAuto && (
                  <Select
                    value={settings.world.weather}
                    onValueChange={(v) => settings.setWorld({ weather: v as WeatherId })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEATHER_IDS.map((id) => (
                        <SelectItem key={id} value={id}>
                          {WEATHER[id].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Slider
                  label="Wind strength"
                  min={0}
                  max={2}
                  step={0.05}
                  value={[settings.world.windStrength]}
                  format={(v) => `${(v * 100).toFixed(0)}%`}
                  onValueChange={([v]) => settings.setWorld({ windStrength: v! })}
                />
                <Slider
                  label="Fog density"
                  min={0}
                  max={3}
                  step={0.05}
                  value={[settings.world.fogDensity]}
                  format={(v) => `${(v * 100).toFixed(0)}%`}
                  onValueChange={([v]) => settings.setWorld({ fogDensity: v! })}
                />
              </SettingsGroup>

              <SettingsGroup title="Season">
                <ChipGroup
                  options={SEASON_IDS.map((id) => ({ id, label: SEASONS[id].label }))}
                  value={settings.world.season}
                  onChange={(id) => {
                    settings.setWorld({ season: id as SeasonId, seasonAuto: false });
                    useGameStore.getState().setSeason(id as SeasonId);
                  }}
                />
              </SettingsGroup>

              <SettingsGroup title="The train">
                <Slider
                  label="Interval between passes"
                  min={TRAIN.INTERVAL_BOUNDS[0]}
                  max={TRAIN.INTERVAL_BOUNDS[1]}
                  step={10}
                  value={[settings.world.trainInterval]}
                  format={(v) => (v >= 60 ? `${(v / 60).toFixed(1)} min` : `${v}s`)}
                  onValueChange={([v]) => settings.setWorld({ trainInterval: v! })}
                />
              </SettingsGroup>

              <SettingsGroup
                title="World"
                description="Changing the seed or village size takes effect on the next world."
              >
                <div>
                  <label className="mb-2 block text-sm text-hollow-300">Seed</label>
                  <input
                    type="text"
                    value={settings.world.seed}
                    onChange={(e) => settings.setWorld({ seed: e.target.value })}
                    className="h-9 w-full rounded-lg border border-hollow-600/60 bg-hollow-800/70 px-3 font-mono text-sm text-hollow-100 focus:outline-none focus:ring-2 focus:ring-amber-glow"
                    spellCheck={false}
                  />
                </div>
                <ChipGroup
                  label="Village size"
                  options={VILLAGE_SIZES.map((id) => ({
                    id,
                    label: id.charAt(0).toUpperCase() + id.slice(1),
                  }))}
                  value={settings.world.villageSize}
                  onChange={(id) => settings.setWorld({ villageSize: id as VillageSize })}
                />
              </SettingsGroup>
            </TabsContent>

            {/* ══════════════════════════════════════════════════════════════
                GAMEPLAY
                ══════════════════════════════════════════════════════════════ */}
            <TabsContent value="gameplay">
              <SettingsGroup title="Movement">
                <Slider
                  label="Walk speed"
                  min={1.5}
                  max={8}
                  step={0.1}
                  value={[settings.gameplay.walkSpeed]}
                  format={(v) => `${v.toFixed(1)} m/s`}
                  onValueChange={([v]) => settings.setGameplay({ walkSpeed: v! })}
                />
                <Slider
                  label="Sprint multiplier"
                  min={1}
                  max={4}
                  step={0.05}
                  value={[settings.gameplay.sprintMultiplier]}
                  format={(v) => `${v.toFixed(2)}×`}
                  onValueChange={([v]) => settings.setGameplay({ sprintMultiplier: v! })}
                />
                <Slider
                  label="Jump height"
                  min={2}
                  max={9}
                  step={0.1}
                  value={[settings.gameplay.jumpHeight]}
                  format={(v) => v.toFixed(1)}
                  onValueChange={([v]) => settings.setGameplay({ jumpHeight: v! })}
                />
              </SettingsGroup>

              <SettingsGroup title="Camera">
                <Slider
                  label="Mouse sensitivity"
                  min={0.2}
                  max={3}
                  step={0.05}
                  value={[settings.gameplay.mouseSensitivity]}
                  format={(v) => v.toFixed(2)}
                  onValueChange={([v]) => settings.setGameplay({ mouseSensitivity: v! })}
                />
                <Slider
                  label="Field of view"
                  min={60}
                  max={100}
                  step={1}
                  value={[settings.gameplay.fov]}
                  format={(v) => `${v.toFixed(0)}°`}
                  onValueChange={([v]) => settings.setGameplay({ fov: v! })}
                />
                <Switch
                  label="Invert vertical look"
                  checked={settings.gameplay.invertY}
                  onCheckedChange={(v) => settings.setGameplay({ invertY: v })}
                />
                <Switch
                  label="Head-bob"
                  description="Subtle camera motion while walking."
                  checked={settings.gameplay.headBob}
                  onCheckedChange={(v) => settings.setGameplay({ headBob: v })}
                />
                <Switch
                  label="Third-person view"
                  description="Also toggled in-game with V."
                  checked={settings.gameplay.thirdPerson}
                  onCheckedChange={(v) => settings.setGameplay({ thirdPerson: v })}
                />
              </SettingsGroup>

              <SettingsGroup title="Interface">
                <Switch
                  label="Show reticle"
                  checked={settings.gameplay.showReticle}
                  onCheckedChange={(v) => settings.setGameplay({ showReticle: v })}
                />
                <Switch
                  label="Interaction prompts"
                  checked={settings.gameplay.interactionPrompts}
                  onCheckedChange={(v) => settings.setGameplay({ interactionPrompts: v })}
                />
                <Switch
                  label="Compass"
                  checked={settings.gameplay.showCompass}
                  onCheckedChange={(v) => settings.setGameplay({ showCompass: v })}
                />
              </SettingsGroup>
            </TabsContent>

            {/* ══════════════════════════════════════════════════════════════
                GRAPHICS
                ══════════════════════════════════════════════════════════════ */}
            <TabsContent value="graphics">
              <SettingsGroup title="Preset">
                <ChipGroup
                  options={[
                    ...(Object.keys(QUALITY_PRESETS) as Array<keyof typeof QUALITY_PRESETS>).map(
                      (id) => ({ id: id as string, label: QUALITY_PRESETS[id].label }),
                    ),
                    { id: 'custom', label: 'Custom' },
                  ]}
                  value={settings.graphics.preset}
                  onChange={(id) => {
                    if (id !== 'custom') {
                      settings.applyQualityPreset(id as Exclude<QualityPresetId, 'custom'>);
                    }
                  }}
                />
                <Switch
                  label="Adaptive quality"
                  description="Automatically lower settings if the framerate drops."
                  checked={settings.graphics.adaptiveQuality}
                  onCheckedChange={(v) => settings.setGraphics({ adaptiveQuality: v })}
                />
              </SettingsGroup>

              <SettingsGroup title="Rendering">
                <Slider
                  label="Resolution scale"
                  min={0.5}
                  max={1.5}
                  step={0.05}
                  value={[settings.graphics.resolutionScale]}
                  format={(v) => `${v.toFixed(2)}×`}
                  onValueChange={([v]) => settings.setGraphics({ resolutionScale: v! })}
                />
                <div>
                  <label className="mb-2 block text-sm text-hollow-300">Shadow quality</label>
                  <Select
                    value={settings.graphics.shadows}
                    onValueChange={(v) => settings.setGraphics({ shadows: v as ShadowQuality })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(['off', 'low', 'medium', 'high', 'ultra'] as ShadowQuality[]).map((s) => (
                        <SelectItem key={s} value={s}>
                          {s.charAt(0).toUpperCase() + s.slice(1)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Slider
                  label="Grass density"
                  min={0}
                  max={2}
                  step={0.05}
                  value={[settings.graphics.grassDensity]}
                  format={(v) => `${(v * 100).toFixed(0)}%`}
                  onValueChange={([v]) => settings.setGraphics({ grassDensity: v! })}
                />
                <Slider
                  label="Tree detail distance"
                  min={0.3}
                  max={2}
                  step={0.05}
                  value={[settings.graphics.treeLodDistance]}
                  format={(v) => `${(v * 100).toFixed(0)}%`}
                  onValueChange={([v]) => settings.setGraphics({ treeLodDistance: v! })}
                />
                <Slider
                  label="Exposure"
                  min={0.4}
                  max={2}
                  step={0.02}
                  value={[settings.graphics.exposure]}
                  format={(v) => v.toFixed(2)}
                  onValueChange={([v]) => settings.setGraphics({ exposure: v! })}
                />
              </SettingsGroup>

              <SettingsGroup title="Post-processing">
                <Switch label="Ambient occlusion" checked={settings.graphics.ssao} onCheckedChange={(v) => settings.setGraphics({ ssao: v })} />
                <Switch label="Bloom" checked={settings.graphics.bloom} onCheckedChange={(v) => settings.setGraphics({ bloom: v })} />
                <Switch label="God rays" checked={settings.graphics.godRays} onCheckedChange={(v) => settings.setGraphics({ godRays: v })} />
                <Switch label="Depth of field" description="Eases in when you stand still." checked={settings.graphics.depthOfField} onCheckedChange={(v) => settings.setGraphics({ depthOfField: v })} />
                <Switch label="Chromatic aberration" checked={settings.graphics.chromaticAberration} onCheckedChange={(v) => settings.setGraphics({ chromaticAberration: v })} />
                <Switch label="Vignette" checked={settings.graphics.vignette} onCheckedChange={(v) => settings.setGraphics({ vignette: v })} />
                <Switch label="Anti-aliasing (SMAA)" checked={settings.graphics.smaa} onCheckedChange={(v) => settings.setGraphics({ smaa: v })} />
                <Switch label="Water reflections" checked={settings.graphics.waterReflection} onCheckedChange={(v) => settings.setGraphics({ waterReflection: v })} />
              </SettingsGroup>

              <SettingsGroup title="Colour">
                <ChipGroup
                  options={(Object.keys(COLOR_GRADES) as ColorGradeId[]).map((id) => ({
                    id,
                    label: COLOR_GRADES[id].label,
                  }))}
                  value={settings.graphics.colorGrade}
                  onChange={(id) => settings.setGraphics({ colorGrade: id as ColorGradeId })}
                />
              </SettingsGroup>
            </TabsContent>

            {/* ══════════════════════════════════════════════════════════════
                AUDIO
                ══════════════════════════════════════════════════════════════ */}
            <TabsContent value="audio">
              <SettingsGroup title="Levels">
                {AUDIO_BUSES.map((bus) => (
                  <Slider
                    key={bus}
                    label={bus.charAt(0).toUpperCase() + bus.slice(1)}
                    min={0}
                    max={1}
                    step={0.01}
                    value={[settings.audio[bus]]}
                    format={(v) => `${(v * 100).toFixed(0)}%`}
                    onValueChange={([v]) => settings.setAudio({ [bus]: v! })}
                  />
                ))}
              </SettingsGroup>

              <SettingsGroup title="Options">
                <Switch
                  label="Ambient music"
                  description="A generative score in D mixolydian that shifts with the hour."
                  checked={settings.audio.ambientMusic}
                  onCheckedChange={(v) => settings.setAudio({ ambientMusic: v })}
                />
                <Switch
                  label="3D spatial audio (HRTF)"
                  description="More accurate positioning. Costs some CPU — turn off on weaker machines."
                  checked={settings.audio.hrtf}
                  onCheckedChange={(v) => settings.setAudio({ hrtf: v })}
                />
              </SettingsGroup>
            </TabsContent>

            {/* ══════════════════════════════════════════════════════════════
                CHARACTER
                ══════════════════════════════════════════════════════════════ */}
            <TabsContent value="character">
              <CharacterPanel />
            </TabsContent>

            {/* ══════════════════════════════════════════════════════════════
                CONTROLS
                ══════════════════════════════════════════════════════════════ */}
            <TabsContent value="controls">
              <SettingsGroup
                title="Key bindings"
                description="Click a binding, then press the key you want."
              >
                <div className="space-y-1">
                  {(Object.keys(DEFAULT_BINDINGS) as BindingAction[]).map((action) => (
                    <div
                      key={action}
                      className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-hollow-800/40"
                    >
                      <span className="text-sm text-hollow-200">{BINDING_LABELS[action]}</span>
                      <button
                        type="button"
                        onClick={() => setRebinding(action)}
                        onKeyDown={(e) => {
                          if (rebinding !== action) return;
                          e.preventDefault();
                          if (e.code === 'Escape') {
                            setRebinding(null);
                            return;
                          }
                          settings.setBinding(action, [e.code]);
                          setRebinding(null);
                        }}
                        className={cn(
                          'min-w-[5.5rem] rounded-md border px-2 py-1 font-mono text-xs transition-colors',
                          rebinding === action
                            ? 'animate-breathe border-amber-glow bg-amber-glow/15 text-amber-soft'
                            : 'border-hollow-600/60 bg-hollow-800/60 text-hollow-200 hover:border-hollow-500',
                        )}
                      >
                        {rebinding === action
                          ? 'Press a key…'
                          : settings.bindings[action].map(formatKeyCode).join(' / ')}
                      </button>
                    </div>
                  ))}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 w-full"
                  onClick={() => settings.resetSection('bindings')}
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Reset to defaults
                </Button>
              </SettingsGroup>
            </TabsContent>

            {/* ══════════════════════════════════════════════════════════════
                ACCESSIBILITY
                ══════════════════════════════════════════════════════════════ */}
            <TabsContent value="access">
              <SettingsGroup title="Motion">
                <Switch
                  label="Reduced motion"
                  description="Disables head-bob, camera shake, depth of field, lightning flashes and the intro flyover."
                  checked={settings.accessibility.reducedMotion}
                  onCheckedChange={(v) => settings.setAccessibility({ reducedMotion: v })}
                />
              </SettingsGroup>

              <SettingsGroup title="Visual">
                <Switch
                  label="High contrast HUD"
                  description="Solid backgrounds and stronger outlines on all interface elements."
                  checked={settings.accessibility.highContrastHud}
                  onCheckedChange={(v) => settings.setAccessibility({ highContrastHud: v })}
                />
                <div>
                  <label className="mb-2 block text-sm text-hollow-300">Colour vision</label>
                  <Select
                    value={settings.accessibility.colorblindMode}
                    onValueChange={(v) =>
                      settings.setAccessibility({ colorblindMode: v as ColorblindMode })
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {COLORBLIND_MODES.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {mode === 'none'
                            ? 'No filter'
                            : mode.charAt(0).toUpperCase() + mode.slice(1)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Slider
                  label="Interface scale"
                  min={ACCESSIBILITY.UI_SCALE[0]}
                  max={ACCESSIBILITY.UI_SCALE[1]}
                  step={0.05}
                  value={[settings.accessibility.uiScale]}
                  format={(v) => `${(v * 100).toFixed(0)}%`}
                  onValueChange={([v]) => settings.setAccessibility({ uiScale: v! })}
                />
              </SettingsGroup>

              <SettingsGroup title="Audio">
                <Switch
                  label="Audio subtitles"
                  description="Shows a label and direction for every significant sound — 🐦 bird sings ◀ left."
                  checked={settings.accessibility.audioSubtitles}
                  onCheckedChange={(v) => settings.setAccessibility({ audioSubtitles: v })}
                />
              </SettingsGroup>
            </TabsContent>
          </div>
        </ScrollArea>
      </Tabs>

      <footer className="shrink-0 border-t border-hollow-600/30 px-5 py-3">
        <Button variant="ghost" size="sm" onClick={() => settings.resetAll()} className="w-full">
          <RotateCcw className="h-3.5 w-3.5" /> Reset all settings
        </Button>
      </footer>
    </motion.aside>
  );
}
