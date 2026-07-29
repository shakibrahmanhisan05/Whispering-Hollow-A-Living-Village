/**
 * Photo mode.
 *
 * Detaches the camera from the player and lets it fly freely, with real
 * photographic controls: focal length, aperture (which drives the depth-of-
 * field pass), roll and aspect ratio.
 *
 * The controls are deliberately expressed in photographic units rather than
 * game units — 35 mm and f/2.8, not "FOV 54" and "blur 1.4" — because anyone
 * who has held a camera already knows what those do, and it makes the mode feel
 * like an instrument instead of a debug menu.
 *
 * @module components/player/PhotoMode
 */

'use client';

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { playerState } from './PlayerController';
import { useGameStore } from '@/store/gameStore';
import { ui } from '@/store/uiState';
import { consumeMouseDelta, consumeWheelDelta, type InputState } from '@/hooks/useKeyboard';
import { PHOTO, WORLD } from '@/config/game';
import { clamp, damp, focalLengthToFov } from '@/lib/utils/math';

export function PhotoModeCamera({ input }: { input: React.RefObject<InputState> }) {
  const { camera } = useThree();
  const phase = useGameStore((s) => s.phase);


  const state = useRef({
    yaw: playerState.yaw,
    pitch: playerState.pitch,
    pos: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    initialised: false,
  });

  /* Entering photo mode starts the camera exactly where the player's eyes were,
   * so the transition is a continuation rather than a cut. */
  useEffect(() => {
    if (phase !== 'photo') {
      state.current.initialised = false;
      return;
    }
    const s = state.current;
    s.pos.copy(camera.position);
    s.yaw = playerState.yaw;
    s.pitch = playerState.pitch;
    s.velocity.set(0, 0, 0);
    s.initialised = true;
  }, [phase, camera]);

  useFrame((_, rawDt) => {
    if (phase !== 'photo' || !state.current.initialised) return;
    const dt = Math.min(rawDt, 1 / 20);
    const s = state.current;
    const inp = input.current;

    /* ── Look ───────────────────────────────────────────────────────────── */
    if (ui.pointerLocked) {
      const [dx, dy] = consumeMouseDelta(inp);
      s.yaw -= dx;
      s.pitch = clamp(s.pitch - dy, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    } else {
      consumeMouseDelta(inp);
    }

    /* ── Focal length on the scroll wheel ────────────────────────────────
     * Multiplicative rather than additive, so a click of the wheel changes the
     * framing by the same *proportion* at 14 mm as at 135 mm — which is how
     * zoom actually feels. */
    const wheel = consumeWheelDelta(inp);
    if (wheel !== 0) {
      ui.photoFocalLength = clamp(
        ui.photoFocalLength * (1 - wheel * 0.0012),
        PHOTO.FOCAL_LENGTH[0],
        PHOTO.FOCAL_LENGTH[1],
      );
    }

    /* ── Free flight ─────────────────────────────────────────────────────── */
    const forward = (inp.forward ? 1 : 0) - (inp.backward ? 1 : 0);
    const strafe = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    const vertical = (inp.jumpPressed || inp.interactHeld ? 1 : 0) - (inp.crouch ? 1 : 0);
    inp.jumpPressed = false;

    const speed = PHOTO.FLY_SPEED * (inp.sprint ? PHOTO.FLY_BOOST : 1);

    _fwd.set(0, 0, -1).applyEuler(_euler.set(s.pitch, s.yaw, 0, 'YXZ'));
    _right.set(1, 0, 0).applyEuler(_euler.set(0, s.yaw, 0, 'YXZ'));

    _target
      .set(0, 0, 0)
      .addScaledVector(_fwd, forward)
      .addScaledVector(_right, strafe);
    _target.y += vertical;
    if (_target.lengthSq() > 0) _target.normalize().multiplyScalar(speed);

    /* Smooth the velocity rather than the position. Damping position directly
     * makes the camera feel like it is on elastic; damping velocity gives the
     * weighty, gliding feel of a real camera crane. */
    s.velocity.x = damp(s.velocity.x, _target.x, 0.12, dt);
    s.velocity.y = damp(s.velocity.y, _target.y, 0.12, dt);
    s.velocity.z = damp(s.velocity.z, _target.z, 0.12, dt);
    s.pos.addScaledVector(s.velocity, dt);

    // Keep the camera inside the world, and above ground.
    const limit = WORLD.HALF - 6;
    s.pos.x = clamp(s.pos.x, -limit, limit);
    s.pos.z = clamp(s.pos.z, -limit, limit);
    s.pos.y = clamp(s.pos.y, 0.4, 220);

    camera.position.copy(s.pos);
    _euler.set(s.pitch, s.yaw, (ui.photoRoll * Math.PI) / 180, 'YXZ');
    camera.quaternion.setFromEuler(_euler);

    /* ── Focal length → FOV ─────────────────────────────────────────────── */
    const perspective = camera as THREE.PerspectiveCamera;
    if (perspective.isPerspectiveCamera) {
      const fov = focalLengthToFov(ui.photoFocalLength);
      if (Math.abs(perspective.fov - fov) > 0.01) {
        perspective.fov = fov;
        perspective.updateProjectionMatrix();
      }
    }
  });

  return null;
}

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _target = new THREE.Vector3();
const _euler = new THREE.Euler();

/**
 * Captures the current frame as a JPEG data URL.
 *
 * ## Why it re-renders before reading
 *
 * WebGL clears its drawing buffer after compositing unless
 * `preserveDrawingBuffer` is set — and setting that permanently costs
 * performance on every frame of the whole game. Instead we force one fresh
 * render immediately before `toDataURL`, so the buffer is guaranteed populated
 * at the moment we read it. This is the standard technique and costs nothing
 * outside of the capture itself.
 *
 * @param gl - The renderer.
 * @param scene - Scene to render.
 * @param camera - Camera to render from.
 * @param aspect - Target aspect ratio, or 0 for native.
 */
export function captureScreenshot(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  aspect = 0,
): string | null {
  try {
    gl.render(scene, camera);
    const source = gl.domElement;

    if (aspect <= 0) {
      return source.toDataURL('image/jpeg', PHOTO.JPEG_QUALITY);
    }

    /* Crop to the requested aspect ratio. Cropping rather than letterboxing
     * means the saved image has no black bars — the player gets the picture
     * they framed, at the shape they chose. */
    const sw = source.width;
    const sh = source.height;
    const sourceAspect = sw / sh;

    let cw = sw;
    let ch = sh;
    if (sourceAspect > aspect) {
      cw = Math.round(sh * aspect);
    } else {
      ch = Math.round(sw / aspect);
    }
    const ox = Math.round((sw - cw) / 2);
    const oy = Math.round((sh - ch) / 2);

    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return source.toDataURL('image/jpeg', PHOTO.JPEG_QUALITY);
    ctx.drawImage(source, ox, oy, cw, ch, 0, 0, cw, ch);
    return canvas.toDataURL('image/jpeg', PHOTO.JPEG_QUALITY);
  } catch (err) {
    console.warn('[photo] Capture failed', err);
    return null;
  }
}
