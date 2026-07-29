/**
 * Photo mode's on-screen controls.
 *
 * @module components/menu/PhotoModeUi
 */

'use client';

import { useSnapshot } from 'valtio';
import { motion } from 'framer-motion';
import { Camera, X, Eye, EyeOff } from 'lucide-react';

import { Button, Slider, ChipGroup } from '../ui/primitives';
import { ui } from '@/store/uiState';
import { useGameStore } from '@/store/gameStore';
import { useSettingsStore } from '@/store/settingsStore';
import { PHOTO, COLOR_GRADES, type ColorGradeId } from '@/config/game';

export function PhotoModeUi({ onCapture, onExit }: { onCapture: () => void; onExit: () => void }) {
  const snap = useSnapshot(ui);
  const grade = useSettingsStore((s) => s.graphics.colorGrade);
  const setGraphics = useSettingsStore((s) => s.setGraphics);
  const unlockedLuts = useGameStore((s) => s.progress.unlocked.luts);

  /* The framing guides are drawn even when the HUD is hidden — they are part of
   * composing the shot, not chrome. They are never captured, because the
   * capture reads the WebGL canvas rather than the DOM. */
  const aspect = snap.photoAspect;

  return (
    <>
      {/* Aspect-ratio letterbox guides. */}
      {aspect > 0 && <AspectGuides aspect={aspect} />}

      {/* Rule-of-thirds grid. */}
      <div className="pointer-events-none fixed inset-0 z-30 opacity-[0.16]">
        <div className="absolute left-1/3 top-0 h-full w-px bg-white" />
        <div className="absolute left-2/3 top-0 h-full w-px bg-white" />
        <div className="absolute left-0 top-1/3 h-px w-full bg-white" />
        <div className="absolute left-0 top-2/3 h-px w-full bg-white" />
      </div>

      {!snap.photoHideHud && (
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 24 }}
          className="glass pointer-events-auto fixed bottom-5 left-1/2 z-[110] w-[min(94vw,44rem)] -translate-x-1/2 rounded-panel p-4"
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <Slider
              label="Focal length"
              min={PHOTO.FOCAL_LENGTH[0]}
              max={PHOTO.FOCAL_LENGTH[1]}
              step={1}
              value={[snap.photoFocalLength]}
              format={(v) => `${Math.round(v)}mm`}
              onValueChange={([v]) => {
                ui.photoFocalLength = v!;
              }}
            />
            <Slider
              label="Aperture"
              min={PHOTO.APERTURE[0]}
              max={PHOTO.APERTURE[1]}
              step={0.1}
              value={[snap.photoAperture]}
              format={(v) => `f/${v.toFixed(1)}`}
              onValueChange={([v]) => {
                ui.photoAperture = v!;
              }}
            />
            <Slider
              label="Roll"
              min={PHOTO.ROLL[0]}
              max={PHOTO.ROLL[1]}
              step={0.5}
              value={[snap.photoRoll]}
              format={(v) => `${v.toFixed(1)}°`}
              onValueChange={([v]) => {
                ui.photoRoll = v!;
              }}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-4">
            <div className="min-w-0 flex-1">
              <ChipGroup
                label="Aspect"
                options={PHOTO.ASPECT_RATIOS.map((r) => ({ id: r.id, label: r.label }))}
                value={
                  PHOTO.ASPECT_RATIOS.find((r) => Math.abs(r.value - aspect) < 0.001)?.id ??
                  'native'
                }
                onChange={(id) => {
                  const ratio = PHOTO.ASPECT_RATIOS.find((r) => r.id === id);
                  ui.photoAspect = ratio?.value ?? 0;
                }}
              />
            </div>
            <div className="min-w-0 flex-1">
              <ChipGroup
                label="Grade"
                options={(Object.keys(COLOR_GRADES) as ColorGradeId[])
                  .filter((id) => unlockedLuts.includes(id))
                  .map((id) => ({ id, label: COLOR_GRADES[id].label }))}
                value={grade}
                onChange={(id) => setGraphics({ colorGrade: id as ColorGradeId })}
              />
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <Button variant="primary" className="flex-1" onClick={onCapture} sound="confirm">
              <Camera className="h-4 w-4" /> Take the photograph
            </Button>
            <Button
              variant="secondary"
              size="icon"
              onClick={() => {
                ui.photoHideHud = true;
              }}
              aria-label="Hide controls"
            >
              <EyeOff className="h-4 w-4" />
            </Button>
            <Button variant="secondary" size="icon" onClick={onExit} sound="back" aria-label="Exit photo mode">
              <X className="h-4 w-4" />
            </Button>
          </div>

          <p className="mt-2.5 text-center text-[0.62rem] text-hollow-500">
            Drag the scene to aim · WASD to fly · Space / Ctrl for up and down · Shift to move
            faster · Scroll to zoom
          </p>
        </motion.div>
      )}

      {/* A single restore button when the controls are hidden. */}
      {snap.photoHideHud && (
        <div className="pointer-events-auto fixed bottom-5 left-1/2 z-[110] -translate-x-1/2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              ui.photoHideHud = false;
            }}
          >
            <Eye className="h-3.5 w-3.5" /> Show controls
          </Button>
        </div>
      )}
    </>
  );
}

/**
 * Letterbox bars showing the crop for the selected aspect ratio.
 *
 * Drawn with two absolutely-positioned bars sized from the ratio, so the
 * player is composing inside the frame they will actually get.
 */
function AspectGuides({ aspect }: { aspect: number }) {
  return (
    <div className="pointer-events-none fixed inset-0 z-30">
      <style>{`
        .wh-aspect-frame {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .wh-aspect-inner {
          aspect-ratio: ${aspect};
          max-width: 100%;
          max-height: 100%;
          width: 100%;
          outline: 100vmax solid rgba(0, 0, 0, 0.72);
          border: 1px solid rgba(255, 255, 255, 0.18);
        }
      `}</style>
      <div className="wh-aspect-frame">
        <div className="wh-aspect-inner" />
      </div>
    </div>
  );
}
