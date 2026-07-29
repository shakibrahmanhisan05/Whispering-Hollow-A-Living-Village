/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE PLAYER CONTROLLER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Physics-lite first-person movement on Rapier's kinematic character
 * controller, with head-bob, stamina, surface-aware footsteps, crouch, jump,
 * and a third-person mode.
 *
 * ## Why a kinematic character controller and not a dynamic rigid body
 *
 * A dynamic capsule under a physics solver gives you a *ragdoll*, not a
 * character: it slides down slopes, bounces off ledges, tips over, and
 * accumulates angular momentum you then have to fight. Rapier's
 * `KinematicCharacterController` instead answers a much better question —
 * "I want to move by this vector; what movement is actually possible?" — and
 * returns a corrected translation that already accounts for slopes, steps and
 * walls. Everything about how the character *feels* stays in our hands.
 *
 * The controller gives us three things almost for free, each of which is
 * fiddly to write by hand:
 *
 * - **Slope handling** — walk up gentle ground, slide off anything too steep.
 * - **Auto-stepping** — walk over a 40 cm rock or a kerb without jumping.
 * - **Snap-to-ground** — stay glued to the surface when walking downhill,
 *   instead of launching off every convexity.
 *
 * ## Frame order
 *
 * ```
 *  input → look → wish direction → acceleration → gravity
 *        → controller.computeColliderMovement()
 *        → apply corrected translation
 *        → camera: eye height + head-bob + train shake + FOV
 *        → publish telemetry to the HUD proxy
 * ```
 *
 * @module components/player/PlayerController
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { RigidBody, CapsuleCollider, useRapier, type RapierRigidBody } from '@react-three/rapier';
import * as THREE from 'three';

import { useWorld } from '../scene/TerrainContext';
import { consumeMouseDelta, type InputState } from '@/hooks/useKeyboard';
import { useSettingsStore } from '@/store/settingsStore';
import { useGameStore } from '@/store/gameStore';
import {
  ui,
  setStamina,
  setHeading,
  setPosition,
  setSpeed,
} from '@/store/uiState';
import { useSynthEngine } from '@/components/audio/useSpatialAudio';
import { playFootstep, playLanding, playClothRustle } from '@/components/audio/sources/village';
import { trainShake } from '../scene/Train/TrainDirector';
import { PLAYER, FOOTSTEPS, ZONES, type ZoneId } from '@/config/game';
import { clamp, damp, wrap } from '@/lib/utils/math';

/** Everything the rest of the app needs to know about the player, per frame. */
export interface PlayerState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  yaw: number;
  pitch: number;
  grounded: boolean;
  crouching: boolean;
  sprinting: boolean;
  stamina: number;
  /** Horizontal speed. */
  speed: number;
}

/**
 * Module-level player state.
 *
 * Read every frame by the avatar, the interaction system, multiplayer presence
 * and photo mode. A module singleton rather than context because none of those
 * consumers should re-render when the player takes a step.
 */
export const playerState: PlayerState = {
  position: new THREE.Vector3(...PLAYER.SPAWN),
  velocity: new THREE.Vector3(),
  yaw: PLAYER.SPAWN_YAW,
  pitch: 0,
  grounded: true,
  crouching: false,
  sprinting: false,
  stamina: PLAYER.MAX_STAMINA,
  speed: 0,
};

export interface PlayerControllerProps {
  /** Disables all input — used while a menu is open or during the intro. */
  enabled: boolean;
  /** Input state from `useKeyboard`, shared with the interaction system. */
  input: React.RefObject<InputState>;
}

export function PlayerController({ enabled, input }: PlayerControllerProps) {
  const { terrain } = useWorld();
  const { camera } = useThree();
  const { world } = useRapier();
  const engine = useSynthEngine();

  const bodyRef = useRef<RapierRigidBody>(null);
  const gameplay = useSettingsStore((s) => s.gameplay);
  const reducedMotion = useSettingsStore((s) => s.accessibility.reducedMotion);
  const phase = useGameStore((s) => s.phase);


  /* ── Controller ──────────────────────────────────────────────────────────
   * Created once. `offset` is the skin width — the gap the controller keeps
   * between the capsule and geometry. Too small and the capsule jitters as it
   * repeatedly touches and separates; too large and the player visibly floats
   * away from walls. 2 cm is the sweet spot for a 34 cm-radius capsule. */
  const controller = useMemo(() => {
    const c = world.createCharacterController(PLAYER.COLLIDER_OFFSET);

    // Slide along walls rather than stopping dead against them.
    c.setSlideEnabled(true);

    /* Auto-step over small obstacles. The three arguments are: maximum step
     * height, minimum width of the surface stepped onto (so we don't try to
     * balance on a knife edge), and whether to step onto dynamic bodies. */
    c.enableAutostep(PLAYER.STEP_HEIGHT, PLAYER.RADIUS * 0.5, true);

    /* Snap-to-ground. Without this, walking down any convex slope launches the
     * player into a series of small hops — the classic "bunny down the hill"
     * artefact — because the controller's forward motion carries them off the
     * edge before gravity catches up. */
    c.enableSnapToGround(PLAYER.SNAP_TO_GROUND);

    // Refuse to climb anything steeper than ~53°, and slide off ~65°+.
    c.setMaxSlopeClimbAngle(PLAYER.MAX_SLOPE);
    c.setMinSlopeSlideAngle(PLAYER.MAX_SLOPE * 1.15);

    // The player can nudge dynamic objects (there are few, but it's correct).
    c.setApplyImpulsesToDynamicBodies(true);

    /* Characters should not be pushed by the platforms they stand on in this
     * game — there are none — and disabling it avoids a whole class of jitter. */
    c.setCharacterMass(78);

    return c;
  }, [world]);

  useEffect(() => {
    return () => {
      try {
        world.removeCharacterController(controller);
      } catch {
        /* World already disposed. */
      }
    };
  }, [world, controller]);

  /* ── Mutable per-frame state ─────────────────────────────────────────── */
  const state = useRef<{
    velocityY: number;
    coyote: number;
    jumpBuffer: number;
    bobPhase: number;
    bobAmount: number;
    footstepTimer: number;
    staminaRecoverDelay: number;
    currentEyeHeight: number;
    currentFov: number;
    strafeRoll: number;
    lastFallSpeed: number;
    wasGrounded: boolean;
    smoothSpeed: number;
  }>({
    velocityY: 0,
    coyote: 0,
    jumpBuffer: 0,
    bobPhase: 0,
    bobAmount: 0,
    footstepTimer: 0,
    staminaRecoverDelay: 0,
    currentEyeHeight: PLAYER.EYE_HEIGHT,
    currentFov: gameplay.fov,
    strafeRoll: 0,
    /** Fall speed on the previous grounded frame, for landing impact. */
    lastFallSpeed: 0,
    wasGrounded: true,
    /** Smoothed horizontal speed, for bob and FOV. */
    smoothSpeed: 0,
  });

  const audioSource = useRef<ReturnType<typeof engine.createSource>>(null);

  useEffect(() => {
    if (!engine.ready) return;
    /* Footsteps are positional but always adjacent, so a very small reference
     * distance and near-zero reverb keeps them dry and present rather than
     * sounding like they're happening across the room. */
    audioSource.current = engine.createSource({
      bus: 'footsteps',
      position: [0, 0, 0],
      refDistance: 1,
      maxDistance: 20,
      rolloff: 2.2,
      reverbSend: 0.08,
    });
    return () => {
      audioSource.current?.dispose();
      audioSource.current = null;
    };
  }, [engine, engine.ready]);

  /* ── Initial placement ───────────────────────────────────────────────── */
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const [sx, , sz] = PLAYER.SPAWN;
    const y = terrain.heightAt(sx, sz) + PLAYER.HEIGHT;
    body.setNextKinematicTranslation({ x: sx, y, z: sz });
    playerState.position.set(sx, y, sz);
    playerState.yaw = PLAYER.SPAWN_YAW;
    playerState.pitch = 0;
    state.current.velocityY = 0;
  }, [terrain]);

  useFrame((_, rawDt) => {
    const body = bodyRef.current;
    if (!body) return;

    // Clamp the timestep. A tab-switch produces a multi-second delta that would
    // teleport the player through the world in one step.
    const dt = Math.min(rawDt, 1 / 20);
    const s = state.current;
    const inp = input.current;
    const active = enabled && phase === 'playing';

    /* ── Look ──────────────────────────────────────────────────────────── */
    if (active && ui.pointerLocked) {
      const [dx, dy] = consumeMouseDelta(inp);
      playerState.yaw -= dx;
      playerState.pitch = clamp(playerState.pitch - dy, -PLAYER.MAX_PITCH, PLAYER.MAX_PITCH);
    } else {
      // Drain any accumulated delta so the view doesn't lurch on re-focus.
      consumeMouseDelta(inp);
    }
    playerState.yaw = wrap(playerState.yaw, Math.PI * 2);

    /* ── Wish direction ────────────────────────────────────────────────── */
    let wishX = 0;
    let wishZ = 0;
    if (active) {
      const forward = (inp.forward ? 1 : 0) - (inp.backward ? 1 : 0);
      const strafe = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);

      if (forward !== 0 || strafe !== 0) {
        /* Rotate the input into world space by the camera yaw. Note the sign
         * convention: in three.js, -Z is "forward" for a default camera. */
        const sinY = Math.sin(playerState.yaw);
        const cosY = Math.cos(playerState.yaw);
        wishX = -sinY * forward + cosY * strafe;
        wishZ = -cosY * forward - sinY * strafe;

        // Normalise so diagonal movement isn't 41% faster.
        const len = Math.hypot(wishX, wishZ);
        wishX /= len;
        wishZ /= len;
      }
    }

    /* ── Crouch ────────────────────────────────────────────────────────── */
    const wantsCrouch = active && inp.crouch;
    playerState.crouching = wantsCrouch;
    const targetEye = wantsCrouch ? PLAYER.CROUCH_EYE_HEIGHT : PLAYER.EYE_HEIGHT;
    s.currentEyeHeight = damp(s.currentEyeHeight, targetEye, 0.07, dt);

    /* ── Sprint & stamina ───────────────────────────────────────────────── */
    const movingForward = wishX !== 0 || wishZ !== 0;
    /* Sprinting requires a stamina *threshold* to start, not just any stamina.
     * Without it, the player stutter-sprints on and off at zero stamina, which
     * feels broken. Once running, they can drain to nothing. */
    const canStartSprint = playerState.stamina > PLAYER.STAMINA_SPRINT_THRESHOLD;
    const wantsSprint = active && inp.sprint && movingForward && !wantsCrouch;
    const sprinting =
      wantsSprint && (playerState.sprinting ? playerState.stamina > 0 : canStartSprint);
    playerState.sprinting = sprinting;

    if (sprinting) {
      playerState.stamina = Math.max(0, playerState.stamina - PLAYER.STAMINA_DRAIN * dt);
      s.staminaRecoverDelay = PLAYER.STAMINA_RECOVER_DELAY;
    } else {
      s.staminaRecoverDelay = Math.max(0, s.staminaRecoverDelay - dt);
      if (s.staminaRecoverDelay <= 0) {
        playerState.stamina = Math.min(
          PLAYER.MAX_STAMINA,
          playerState.stamina + PLAYER.STAMINA_RECOVER * dt,
        );
      }
    }

    /* ── Horizontal velocity ────────────────────────────────────────────── */
    const speedMultiplier = sprinting
      ? gameplay.sprintMultiplier
      : wantsCrouch
        ? PLAYER.CROUCH_MULTIPLIER
        : 1;
    const targetSpeed = gameplay.walkSpeed * speedMultiplier;

    const grounded = controller.computedGrounded();
    /* Air control is deliberately partial. Full air control makes jumping feel
     * like flying; none at all makes it feel like ice. 28% lets the player
     * adjust a jump without removing the commitment. */
    const control = grounded ? 1 : PLAYER.AIR_CONTROL;

    const desiredVX = wishX * targetSpeed;
    const desiredVZ = wishZ * targetSpeed;

    const accel = movingForward ? PLAYER.ACCELERATION : PLAYER.DECELERATION;
    playerState.velocity.x = approach(
      playerState.velocity.x,
      desiredVX,
      accel * control * dt,
    );
    playerState.velocity.z = approach(
      playerState.velocity.z,
      desiredVZ,
      accel * control * dt,
    );

    /* ── Jump ──────────────────────────────────────────────────────────── */
    if (active && inp.jumpPressed) {
      inp.jumpPressed = false;
      s.jumpBuffer = PLAYER.JUMP_BUFFER;
    }
    s.jumpBuffer = Math.max(0, s.jumpBuffer - dt);

    if (grounded) {
      s.coyote = PLAYER.COYOTE_TIME;
      if (s.velocityY < 0) s.velocityY = 0;
    } else {
      s.coyote = Math.max(0, s.coyote - dt);
    }

    /* Coyote time + jump buffering. Together these are the difference between
     * a jump that feels responsive and one that feels like it "ate" the input:
     * the buffer forgives pressing slightly early, coyote time forgives
     * pressing slightly late. */
    if (s.jumpBuffer > 0 && s.coyote > 0 && !wantsCrouch) {
      s.velocityY = gameplay.jumpHeight;
      s.jumpBuffer = 0;
      s.coyote = 0;
      playClothRustle(engine, audioSource.current ?? null, 0.8);
    }

    /* ── Gravity ───────────────────────────────────────────────────────── */
    s.velocityY = Math.max(s.velocityY - PLAYER.GRAVITY * dt, -PLAYER.MAX_FALL_SPEED);
    playerState.velocity.y = s.velocityY;

    /* ── Solve the movement ─────────────────────────────────────────────── */
    const collider = body.collider(0);
    if (!collider) return;

    const desired = {
      x: playerState.velocity.x * dt,
      y: s.velocityY * dt,
      z: playerState.velocity.z * dt,
    };

    controller.computeColliderMovement(collider, desired);
    const corrected = controller.computedMovement();

    const current = body.translation();
    const next = {
      x: current.x + corrected.x,
      y: current.y + corrected.y,
      z: current.z + corrected.z,
    };

    /* Safety net. If the player ever ends up below the terrain — a physics
     * tunnelling event, a bad spawn, a collider that failed to build — lift
     * them back to the surface rather than letting them fall forever. This
     * costs one heightmap lookup per frame and has saved more debugging time
     * than any other six lines in this file. */
    const groundHere = terrain.heightAt(next.x, next.z);
    if (next.y < groundHere - 1) {
      next.y = groundHere + PLAYER.HEIGHT * 0.5;
      s.velocityY = 0;
    }

    body.setNextKinematicTranslation(next);
    playerState.position.set(next.x, next.y, next.z);
    playerState.grounded = grounded;

    /* If the controller stopped us dead against a wall, zero the velocity in
     * that direction — otherwise the player keeps "pressing into" the wall and
     * the head-bob continues as though they were walking. */
    if (Math.abs(corrected.x) < Math.abs(desired.x) * 0.15) playerState.velocity.x *= 0.2;
    if (Math.abs(corrected.z) < Math.abs(desired.z) * 0.15) playerState.velocity.z *= 0.2;

    const horizontalSpeed = Math.hypot(playerState.velocity.x, playerState.velocity.z);
    playerState.speed = horizontalSpeed;
    s.smoothSpeed = damp(s.smoothSpeed, horizontalSpeed, 0.08, dt);

    /* ── Landing ───────────────────────────────────────────────────────── */
    if (grounded && !s.wasGrounded) {
      const impact = clamp(Math.abs(s.lastFallSpeed) / 12, 0.2, 1.6);
      const surface = terrain.surfaceAt(next.x, next.z);
      audioSource.current?.setPosition(next.x, next.y - s.currentEyeHeight, next.z, 0.001);
      playLanding(engine, audioSource.current ?? null, surface, impact);
      // A landing dip in the camera, scaled by impact.
      s.bobAmount = Math.min(s.bobAmount + impact * 0.06, 0.12);
    }
    s.wasGrounded = grounded;
    if (!grounded) s.lastFallSpeed = s.velocityY;

    /* ── Footsteps ─────────────────────────────────────────────────────── */
    if (grounded && horizontalSpeed > FOOTSTEPS.MIN_SPEED) {
      const interval = sprinting
        ? FOOTSTEPS.INTERVAL_SPRINT
        : wantsCrouch
          ? FOOTSTEPS.INTERVAL_CROUCH
          : FOOTSTEPS.INTERVAL_WALK;
      /* Scale the interval by actual speed, so decelerating produces
       * progressively slower footfalls rather than an abrupt stop. */
      const speedRatio = clamp(horizontalSpeed / gameplay.walkSpeed, 0.4, 2.2);
      s.footstepTimer -= dt * speedRatio;

      if (s.footstepTimer <= 0) {
        s.footstepTimer = interval;
        const surface = terrain.surfaceAt(next.x, next.z);
        audioSource.current?.setPosition(next.x, next.y - s.currentEyeHeight, next.z, 0.001);
        const intensity = wantsCrouch ? 0.45 : sprinting ? 1.25 : 0.85;
        playFootstep(engine, audioSource.current ?? null, surface, intensity);
        ui.surface = surface;
      }
    } else {
      // Reset so the first step after stopping lands immediately.
      s.footstepTimer = Math.min(s.footstepTimer, 0.12);
    }

    /* ── Head-bob ───────────────────────────────────────────────────────
     * A Lissajous figure: the vertical component runs at twice the frequency
     * of the horizontal one, which traces a figure-of-eight. That is what
     * walking actually does to your head — a single sine reads as a bounce,
     * the figure-of-eight reads as a gait.
     *
     * The amplitude is damped while sprinting, per the design spec: at speed,
     * a large bob is nauseating rather than immersive. */
    let bobX = 0;
    let bobY = 0;

    if (gameplay.headBob && !reducedMotion) {
      const speedRatio = clamp(s.smoothSpeed / gameplay.walkSpeed, 0, 2.2);
      const targetBob = grounded ? speedRatio : 0;
      s.bobAmount = damp(s.bobAmount, targetBob, 0.09, dt);

      if (s.bobAmount > 0.001) {
        s.bobPhase += dt * PLAYER.BOB_FREQUENCY * Math.PI * 2 * clamp(speedRatio, 0.5, 2);
        const damping = sprinting ? PLAYER.BOB_SPRINT_DAMP : 1;
        bobY = Math.sin(s.bobPhase * 2) * PLAYER.BOB_AMPLITUDE_Y * s.bobAmount * damping;
        bobX = Math.sin(s.bobPhase) * PLAYER.BOB_AMPLITUDE_X * s.bobAmount * damping;
      }
    }

    /* ── Strafe roll ─────────────────────────────────────────────────────
     * A small camera roll when moving sideways. Almost subliminal, but it is
     * one of the strongest "this is a body, not a floating camera" cues. */
    const strafeInput = active ? (inp.right ? 1 : 0) - (inp.left ? 1 : 0) : 0;
    const targetRoll = reducedMotion ? 0 : -strafeInput * PLAYER.STRAFE_ROLL;
    s.strafeRoll = damp(s.strafeRoll, targetRoll, 0.14, dt);

    /* ── Camera ────────────────────────────────────────────────────────── */
    if (!gameplay.thirdPerson) {
      camera.position.set(
        next.x + bobX * Math.cos(playerState.yaw),
        next.y - PLAYER.HEIGHT * 0.5 + s.currentEyeHeight + bobY,
        next.z - bobX * Math.sin(playerState.yaw),
      );
    } else {
      /* Third person: an over-the-shoulder orbit. The camera sits behind and
       * slightly to the side, looking at a point just above the avatar's head
       * so the character doesn't occlude the centre of the screen. */
      const shoulderX = Math.cos(playerState.yaw) * PLAYER.TP_SHOULDER;
      const shoulderZ = -Math.sin(playerState.yaw) * PLAYER.TP_SHOULDER;

      const backX = Math.sin(playerState.yaw) * PLAYER.TP_DISTANCE;
      const backZ = Math.cos(playerState.yaw) * PLAYER.TP_DISTANCE;

      const pitchLift = -Math.sin(playerState.pitch) * PLAYER.TP_DISTANCE;

      const targetPos = _tmpVec.set(
        next.x + backX + shoulderX,
        next.y - PLAYER.HEIGHT * 0.5 + PLAYER.TP_HEIGHT + pitchLift,
        next.z + backZ + shoulderZ,
      );

      camera.position.x = damp(camera.position.x, targetPos.x, PLAYER.TP_SMOOTHING, dt);
      camera.position.y = damp(camera.position.y, targetPos.y, PLAYER.TP_SMOOTHING, dt);
      camera.position.z = damp(camera.position.z, targetPos.z, PLAYER.TP_SMOOTHING, dt);
    }

    // Camera shake from the passing train, added after everything else so it
    // composes with the bob rather than being smoothed away by it.
    if (!reducedMotion) {
      camera.position.add(trainShake);
    }

    /* Orientation. Applying yaw then pitch as an Euler in YXZ order is the
     * standard FPS camera formulation — it prevents the roll that a naive
     * XYZ order introduces when looking up while turning. */
    _tmpEuler.set(playerState.pitch, playerState.yaw, s.strafeRoll, 'YXZ');
    camera.quaternion.setFromEuler(_tmpEuler);

    /* ── FOV ────────────────────────────────────────────────────────────
     * Widening the field of view while sprinting is one of the oldest tricks
     * in first-person design and still the most effective: it produces
     * peripheral motion the eye reads directly as speed. */
    const perspectiveCamera = camera as THREE.PerspectiveCamera;
    if (perspectiveCamera.isPerspectiveCamera) {
      const targetFov = sprinting && !reducedMotion ? PLAYER.SPRINT_FOV : gameplay.fov;
      const nextFov = damp(s.currentFov, targetFov, PLAYER.FOV_EASE / 3, dt);
      if (Math.abs(nextFov - s.currentFov) > 0.01) {
        s.currentFov = nextFov;
        perspectiveCamera.fov = nextFov;
        perspectiveCamera.updateProjectionMatrix();
      }
    }

    /* ── Telemetry ───────────────────────────────────────────────────────
     * All of these writers threshold internally, so this is not 60 React
     * renders a second — see store/uiState.ts. */
    setStamina(playerState.stamina, playerState.stamina < PLAYER.STAMINA_SPRINT_THRESHOLD);
    setHeading(playerState.yaw);
    setPosition(next.x, next.y, next.z);
    setSpeed(horizontalSpeed);
    if (ui.grounded !== grounded) ui.grounded = grounded;
    if (ui.crouching !== wantsCrouch) ui.crouching = wantsCrouch;
    if (ui.sprinting !== sprinting) ui.sprinting = sprinting;

    const zone = zoneAt(next.x, next.z);
    if (ui.zone !== zone) ui.zone = zone;
  });

  const capsuleHalfHeight = (PLAYER.HEIGHT - PLAYER.RADIUS * 2) / 2;

  return (
    <RigidBody
      ref={bodyRef}
      type="kinematicPosition"
      colliders={false}
      position={PLAYER.SPAWN}
      enabledRotations={[false, false, false]}
      name="player"
    >
      <CapsuleCollider args={[capsuleHalfHeight, PLAYER.RADIUS]} />
    </RigidBody>
  );
}

/**
 * Moves `current` toward `target` by at most `maxDelta`.
 * Used instead of `damp` for velocity because acceleration should be constant,
 * not exponential — a car does not approach its top speed asymptotically from
 * the driver's point of view.
 */
function approach(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/** Which named zone a position falls in, or null if none. */
export function zoneAt(x: number, z: number): ZoneId | null {
  let best: ZoneId | null = null;
  let bestScore = 0;
  for (const [id, zone] of Object.entries(ZONES) as [ZoneId, (typeof ZONES)[ZoneId]][]) {
    const d = Math.hypot(x - zone.center[0], z - zone.center[1]);
    const score = 1 - d / zone.radius;
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

const _tmpEuler = new THREE.Euler();
const _tmpVec = new THREE.Vector3();
