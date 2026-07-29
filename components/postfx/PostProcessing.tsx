/**
 * The postprocessing pipeline.
 *
 * Effect order is not arbitrary — it mirrors the order these things happen in a
 * real camera, and getting it wrong produces subtly wrong images:
 *
 * ```
 *  1. SSAO                 — contact shadows, applied to the lit scene
 *  2. God rays             — light scattered in the atmosphere, before bloom
 *  3. Bloom                — lens/sensor bleed from bright areas
 *  4. Depth of field       — optical, so it must come after scene lighting
 *  5. Chromatic aberration — a lens defect: it acts on the focused image
 *  6. Colour grade + LUT   — the "print" stage
 *  7. Vignette             — lens falloff
 *  8. Tone mapping         — sensor response curve, last before display
 *  9. SMAA                 — anti-aliasing, on the final image
 * ```
 *
 * Bloom *after* god rays matters in particular: rays are a scene-space
 * phenomenon and should themselves be able to bloom. Bloom before them would
 * leave the rays looking pasted on.
 *
 * @module components/postfx/PostProcessing
 */

'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { DepthOfFieldEffect } from 'postprocessing';
import {
  EffectComposer,
  Bloom,
  DepthOfField,
  Vignette,
  ChromaticAberration,
  SMAA,
  ToneMapping,
  N8AO,
  GodRays,
} from '@react-three/postprocessing';
import { BlendFunction, ToneMappingMode } from 'postprocessing';

import { useLighting } from '@/hooks/useTimeOfDay';
import { useSettingsStore, type GraphicsSettings } from '@/store/settingsStore';
import { useGameStore } from '@/store/gameStore';
import { ui } from '@/store/uiState';
import { playerState } from '../player/PlayerController';
import { POSTFX, COLOR_GRADES, TIME, type ColorblindMode } from '@/config/game';
import { clamp, damp } from '@/lib/utils/math';
import { ColorGradeEffect } from './ColorGradeEffect';

/**
 * The sun mesh the god-rays effect occludes against.
 *
 * God rays work by radially blurring an occlusion buffer outward from a light
 * source, so they need an actual object in the scene to sample. This is a small
 * emissive sphere placed at the sun's direction, rendered only to that pass.
 */
function GodRaySun({ onReady }: { onReady: (mesh: THREE.Mesh) => void }) {
  const lighting = useLighting();
  const ref = useRef<THREE.Mesh>(null);
  const { camera } = useThree();

  useEffect(() => {
    if (ref.current) onReady(ref.current);
  }, [onReady]);

  useFrame(() => {
    const mesh = ref.current;
    if (!mesh) return;
    // Follow the camera so the sun is always at a fixed apparent distance.
    mesh.position
      .copy(lighting.sunDirection)
      .multiplyScalar(TIME.CELESTIAL_DISTANCE * 0.85)
      .add(camera.position);
    // Hide it below the horizon, or the rays fire upward from the ground.
    mesh.visible = lighting.sunDirection.y > -0.05;
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.color.copy(lighting.sunColor);
  });

  return (
    <mesh ref={ref} frustumCulled={false}>
      <sphereGeometry args={[24, 16, 12]} />
      <meshBasicMaterial color="#ffd9a0" transparent opacity={1} depthWrite={false} />
    </mesh>
  );
}

export function PostProcessing() {
  const graphics = useSettingsStore((s) => s.graphics);
  const accessibility = useSettingsStore((s) => s.accessibility);
  const lighting = useLighting();
  const phase = useGameStore((s) => s.phase);
  const { gl } = useThree();

  const [sunMesh, setSunMesh] = useState<THREE.Mesh | null>(null);

  /* ── Depth of field ──────────────────────────────────────────────────────
   * Eases in after the player has stood still for five seconds. The idea is
   * that the game is "looking at" whatever the player is looking at once they
   * stop to appreciate it — and it means DoF never blurs anything during
   * active movement, where it would just read as motion sickness.
   *
   * The important part is `dofMounted`. Ramping `bokehScale` to zero makes DoF
   * *invisible* but not *free*: the pass still renders its circle-of-confusion
   * buffer and both bokeh blurs every single frame. Measured, that was the
   * single most expensive thing in the pipeline — it pushed frame times from
   * 17 ms to 33 ms, i.e. straight from 60 fps to a vsync-halved 30. So the
   * effect is unmounted entirely while moving and only mounted once the player
   * has actually stopped, at which point a one-off shader compile is
   * unnoticeable because nothing is moving. */
  const dofBlur = useRef(0);
  const idleTime = useRef(0);
  const [dofMounted, setDofMounted] = useState(false);
  const dofEffect = useRef<DepthOfFieldEffect>(null);

  useFrame((_, dt) => {
    // Photo mode drives DoF from its own aperture control, always on.
    if (phase === 'photo') {
      idleTime.current = POSTFX.DOF_IDLE_DELAY;
      /* Aperture → blur. Physically, a wider aperture (smaller f-number) means
       * a shallower depth of field, so the mapping is inverse. */
      const aperture = ui.photoAperture;
      dofBlur.current = damp(dofBlur.current, clamp(4.5 / aperture, 0.2, 4), 0.25, dt);
      if (!dofMounted && graphics.depthOfField) setDofMounted(true);
      return;
    }

    if (playerState.speed < 0.35) {
      idleTime.current += dt;
    } else {
      idleTime.current = 0;
    }

    const wantDof =
      graphics.depthOfField &&
      idleTime.current > POSTFX.DOF_IDLE_DELAY &&
      !accessibility.reducedMotion;

    dofBlur.current = damp(dofBlur.current, wantDof ? POSTFX.DOF.bokehScale : 0, 1.2, dt);

    /* Mount as soon as it's wanted; unmount only once it has fully faded out,
     * so the player never sees the blur snap off. */
    if (wantDof && !dofMounted) setDofMounted(true);
    else if (!wantDof && dofMounted && dofBlur.current < 0.02) setDofMounted(false);
  });

  /* Push the ramp straight onto the effect instead of passing it as a prop.
   * A changing prop would re-render {@link EffectStack} sixty times a second,
   * and every render of that subtree rebuilds the composer's pass chain. */
  useFrame(() => {
    if (dofEffect.current) dofEffect.current.bokehScale = dofBlur.current;
  });

  /* ── Tone mapping exposure ───────────────────────────────────────────── */
  useEffect(() => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = graphics.exposure;
  }, [gl, graphics.exposure]);

  useFrame(() => {
    // Time of day modulates exposure on top of the user's setting — the eye
    // adapting to the light, essentially.
    gl.toneMappingExposure = graphics.exposure * lighting.exposure;
  });

  /* ── Renderer liveness guard ─────────────────────────────────────────────
   * `EffectComposer`'s constructor reads
   * `renderer.getContext().getContextAttributes().alpha`, and
   * `getContextAttributes()` returns **null** on a lost context — so building
   * a composer against a dead renderer throws rather than degrading.
   *
   * That happens routinely in development: React StrictMode mounts the Canvas,
   * unmounts it (which force-loses the WebGL context) and mounts it again.
   * Anything constructed during the first, doomed mount hits the dead context.
   * Checking before we mount the composer costs one call and removes the whole
   * class of failure. */
  const contextAlive =
    gl.getContext() !== null && gl.getContext().getContextAttributes() !== null;

  if (!contextAlive) return null;

  /* Every effect is conditional, so a Potato-preset player gets no composer at
   * all rather than an empty one — which still costs a full-screen copy. */
  if (!graphics.ssao && !graphics.bloom && !graphics.godRays && !graphics.depthOfField &&
      !graphics.chromaticAberration && !graphics.vignette && !graphics.smaa &&
      graphics.colorGrade === 'goldenHour' && accessibility.colorblindMode === 'none') {
    return null;
  }

  return (
    <>
      {graphics.godRays && <GodRaySun onReady={setSunMesh} />}
      <EffectStack
        graphics={graphics}
        colorblindMode={accessibility.colorblindMode}
        sunMesh={sunMesh}
        dofMounted={dofMounted}
        dofRef={dofEffect}
      />
    </>
  );
}

interface EffectStackProps {
  graphics: GraphicsSettings;
  colorblindMode: ColorblindMode;
  sunMesh: THREE.Mesh | null;
  dofMounted: boolean;
  dofRef: React.RefObject<DepthOfFieldEffect | null>;
}

/**
 * The composer and its effects, isolated behind {@link memo}.
 *
 * `<EffectComposer>` rebuilds its entire pass chain whenever its `children`
 * array changes identity — and JSX produces a fresh array on every render of
 * the enclosing component. A rebuild means new `EffectPass` objects, which
 * means the combined effect shader is generated and compiled again and every
 * pass reallocates its render targets.
 *
 * That is ruinous if anything above re-renders on a timer: at six renders a
 * second the composer was compiling roughly thirty-five shader programs and
 * leaking as many textures every second, producing multi-second freezes and,
 * eventually, a lost context.
 *
 * So this subtree takes only values that are referentially stable between
 * renders, and anything that animates is written onto the effect instances
 * from `useFrame` instead of passed down as a prop.
 */
const EffectStack = memo(function EffectStack({
  graphics,
  colorblindMode,
  sunMesh,
  dofMounted,
  dofRef,
}: EffectStackProps) {
  const grade = COLOR_GRADES[graphics.colorGrade] ?? COLOR_GRADES.goldenHour;

  return (
    <>
      <EffectComposer
        // Half-float keeps HDR values above 1.0 alive through the chain, which
        // is what lets bloom pick out genuinely bright things rather than
        // anything merely white.
        frameBufferType={THREE.HalfFloatType}
        multisampling={0}
        /* No normal pass. N8AO reconstructs normals from the depth buffer, so
         * the extra full-resolution RGBA half-float normal target it would
         * allocate buys nothing — and on a 1440p display that target alone is
         * tens of megabytes of the video memory budget that a lost context is
         * measured against. */
        enableNormalPass={false}
      >
        {/* 1. Ambient occlusion. N8AO is used rather than the classic SSAO
            effect: it is both faster and far less prone to the halo artefacts
            that plague screen-space AO on terrain silhouettes. */}
        {graphics.ssao ? (
          <N8AO
            aoRadius={2.2}
            intensity={2.6}
            distanceFalloff={1.2}
            quality={graphics.preset === 'cinematic' ? 'high' : 'medium'}
            color="#0a1418"
            /* Always half resolution. AO is a low-frequency signal — it is a
             * soft darkening in creases — so the full-res buffer is spent on
             * detail nobody can see, at four times the memory. */
            halfRes
          />
        ) : (
          <></>
        )}

        {/* 2. God rays through the canopy. */}
        {graphics.godRays && sunMesh ? (
          <GodRays
            sun={sunMesh}
            blendFunction={BlendFunction.SCREEN}
            samples={POSTFX.GOD_RAYS.samples}
            density={POSTFX.GOD_RAYS.density}
            decay={POSTFX.GOD_RAYS.decay}
            weight={POSTFX.GOD_RAYS.weight}
            exposure={POSTFX.GOD_RAYS.exposure}
            clampMax={POSTFX.GOD_RAYS.clampMax}
            blur
          />
        ) : (
          <></>
        )}

        {/* 3. Bloom, thresholded so it only catches emissives and the sun. */}
        {graphics.bloom ? (
          <Bloom
            intensity={POSTFX.BLOOM.intensity}
            luminanceThreshold={POSTFX.BLOOM.luminanceThreshold}
            luminanceSmoothing={POSTFX.BLOOM.luminanceSmoothing}
            mipmapBlur={POSTFX.BLOOM.mipmapBlur}
            radius={0.72}
          />
        ) : (
          <></>
        )}

        {/* 4. Depth of field — mounted only while actually in use. */}
        {graphics.depthOfField && dofMounted ? (
          <DepthOfField
            ref={dofRef}
            focusDistance={POSTFX.DOF.focusDistance}
            focalLength={POSTFX.DOF.focalLength}
            /* `bokehScale` is deliberately absent: it ramps every frame and is
             * written straight onto the effect by the parent. As a prop it
             * would rebuild the whole chain sixty times a second. */
            /* Depth of field is by far the most memory-hungry effect in the
             * chain — it needs a circle-of-confusion target plus near and far
             * bokeh buffers. Running it at 480p and letting the upscale blur
             * it is not a compromise: the output is blurred by definition. */
            width={854}
            height={480}
          />
        ) : (
          <></>
        )}

        {/* 5. Chromatic aberration — deliberately tiny. At 0.0005 it is
            invisible as an effect and present only as a faint softness at the
            frame edges, which is exactly what a real lens does. */}
        {graphics.chromaticAberration ? (
          <ChromaticAberration
            offset={_caOffset.set(POSTFX.CHROMATIC_ABERRATION, POSTFX.CHROMATIC_ABERRATION)}
            radialModulation
            modulationOffset={0.35}
          />
        ) : (
          <></>
        )}

        {/* 6. Colour grade + colourblind assist. */}
        <ColorGradeEffect
          lift={grade.lift}
          gamma={grade.gamma}
          gain={grade.gain}
          saturation={grade.saturation}
          contrast={grade.contrast}
          grain={grade.grain}
          colorblindMode={colorblindMode}
        />

        {/* 7. Vignette. */}
        {graphics.vignette ? (
          <Vignette
            offset={POSTFX.VIGNETTE.offset}
            darkness={POSTFX.VIGNETTE.darkness}
            blendFunction={BlendFunction.NORMAL}
          />
        ) : (
          <></>
        )}

        {/* 8. Tone mapping. ACES Filmic: the film-emulation curve that rolls
            highlights off gracefully instead of clipping them to white, which
            matters enormously for a game whose signature shot is a low sun. */}
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />

        {/* 9. Anti-aliasing, last, on the finished image. */}
        {graphics.smaa ? <SMAA /> : <></>}
      </EffectComposer>
    </>
  );
});

const _caOffset = new THREE.Vector2();
