/**
 * The player avatar — a low-poly stylised character, fully customisable.
 *
 * Visible in third-person mode and as a semi-transparent ghost for remote
 * players. Built entirely from primitives so every part can be recoloured
 * independently at runtime with no asset pipeline.
 *
 * The walk cycle is procedural: limbs swing on a sine driven by *distance
 * travelled* rather than time, so the character's feet stay planted at any
 * speed instead of skating.
 *
 * @module components/player/Avatar
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { playerState } from './PlayerController';
import { useGameStore } from '@/store/gameStore';
import { useWindField } from '@/hooks/useWind';
import { mergeGeometries, transformGeometry } from '@/lib/geometry/merge';
import { AVATAR, PLAYER, MULTIPLAYER, type AvatarConfig, type EmoteId } from '@/config/game';
import { clamp, damp, lerp } from '@/lib/utils/math';

export interface AvatarProps {
  config: AvatarConfig;
  /** World position of the feet. */
  position: THREE.Vector3 | [number, number, number];
  /** Body yaw in radians. */
  yaw: number;
  /** Horizontal speed, drives the walk cycle. */
  speed: number;
  /** Whether the character is on the ground. */
  grounded?: boolean;
  crouching?: boolean;
  /** Playing emote, if any. */
  emote?: EmoteId | null;
  /** Seconds since the emote started. */
  emoteTime?: number;
  /** Renders semi-transparent and unlit, for remote players. */
  ghost?: boolean;
  /** Ghost tint. */
  ghostColor?: string;
}

/** Builds the reusable body-part geometries. Shared across every avatar. */
function useAvatarGeometry() {
  return useMemo(() => {
    /* ── Torso ─────────────────────────────────────────────────────────────
     * A slightly tapered box. The taper alone — narrower at the waist than the
     * shoulders — is most of what separates "a character" from "a crate". */
    const torso = new THREE.CylinderGeometry(0.19, 0.15, 0.52, 8, 1);
    transformGeometry(torso, { scale: [1.35, 1, 0.8] });

    const head = new THREE.SphereGeometry(0.155, 12, 10);
    transformGeometry(head, { scale: [1, 1.08, 0.95] });

    // Limbs. Capsules rather than boxes so joints don't show gaps when bent.
    const upperArm = new THREE.CapsuleGeometry(0.052, 0.2, 3, 6);
    const lowerArm = new THREE.CapsuleGeometry(0.045, 0.19, 3, 6);
    const upperLeg = new THREE.CapsuleGeometry(0.068, 0.24, 3, 6);
    const lowerLeg = new THREE.CapsuleGeometry(0.058, 0.24, 3, 6);

    const foot = new THREE.BoxGeometry(0.11, 0.06, 0.2);
    transformGeometry(foot, { position: [0, 0, 0.03] });

    const hand = new THREE.SphereGeometry(0.052, 7, 6);

    return { torso, head, upperArm, lowerArm, upperLeg, lowerLeg, foot, hand };
  }, []);
}

/** Builds the hat geometry for a given hat ID. */
function useHatGeometry(hat: string) {
  return useMemo(() => {
    if (hat === 'none') return null;
    const parts: THREE.BufferGeometry[] = [];

    switch (hat) {
      case 'straw': {
        const brim = new THREE.CylinderGeometry(0.32, 0.34, 0.02, 14);
        transformGeometry(brim, { position: [0, 0.02, 0] });
        parts.push(brim);
        const crown = new THREE.CylinderGeometry(0.14, 0.17, 0.15, 12);
        transformGeometry(crown, { position: [0, 0.09, 0] });
        parts.push(crown);
        break;
      }
      case 'cap': {
        const dome = new THREE.SphereGeometry(0.17, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
        parts.push(dome);
        const peak = new THREE.BoxGeometry(0.24, 0.02, 0.16);
        transformGeometry(peak, { position: [0, 0.005, 0.18], rotation: [-0.12, 0, 0] });
        parts.push(peak);
        break;
      }
      case 'wizard': {
        const cone = new THREE.ConeGeometry(0.21, 0.52, 10);
        transformGeometry(cone, { position: [0, 0.26, 0], rotation: [0.12, 0, 0.06] });
        parts.push(cone);
        const brim = new THREE.CylinderGeometry(0.3, 0.32, 0.02, 14);
        parts.push(brim);
        break;
      }
      case 'beanie': {
        const dome = new THREE.SphereGeometry(0.175, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.62);
        parts.push(dome);
        const band = new THREE.TorusGeometry(0.168, 0.028, 6, 14);
        transformGeometry(band, { position: [0, 0.01, 0], rotation: [Math.PI / 2, 0, 0] });
        parts.push(band);
        const bobble = new THREE.SphereGeometry(0.055, 8, 6);
        transformGeometry(bobble, { position: [0, 0.19, 0] });
        parts.push(bobble);
        break;
      }
      case 'bucket': {
        const crown = new THREE.CylinderGeometry(0.17, 0.175, 0.14, 12);
        transformGeometry(crown, { position: [0, 0.06, 0] });
        parts.push(crown);
        const brim = new THREE.ConeGeometry(0.27, 0.08, 14, 1, true);
        transformGeometry(brim, { position: [0, 0.01, 0], rotation: [Math.PI, 0, 0] });
        parts.push(brim);
        break;
      }
      case 'flowerCrown': {
        const ring = new THREE.TorusGeometry(0.165, 0.018, 6, 16);
        transformGeometry(ring, { position: [0, 0.02, 0], rotation: [Math.PI / 2, 0, 0] });
        parts.push(ring);
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2;
          const flower = new THREE.SphereGeometry(0.038, 6, 5);
          transformGeometry(flower, {
            position: [Math.cos(a) * 0.165, 0.045, Math.sin(a) * 0.165],
          });
          parts.push(flower);
        }
        break;
      }
      case 'conductor': {
        const crown = new THREE.CylinderGeometry(0.175, 0.175, 0.11, 12);
        transformGeometry(crown, { position: [0, 0.055, 0] });
        parts.push(crown);
        const top = new THREE.CylinderGeometry(0.175, 0.175, 0.015, 12);
        transformGeometry(top, { position: [0, 0.115, 0] });
        parts.push(top);
        const peak = new THREE.BoxGeometry(0.26, 0.018, 0.14);
        transformGeometry(peak, { position: [0, 0.005, 0.18], rotation: [-0.1, 0, 0] });
        parts.push(peak);
        break;
      }
      case 'scarf': {
        const hood = new THREE.SphereGeometry(0.2, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55);
        transformGeometry(hood, { position: [0, -0.02, -0.02] });
        parts.push(hood);
        const trail = new THREE.BoxGeometry(0.12, 0.34, 0.04);
        transformGeometry(trail, { position: [0, -0.24, -0.16], rotation: [0.3, 0, 0] });
        parts.push(trail);
        break;
      }
      case 'lantern': {
        const band = new THREE.TorusGeometry(0.17, 0.022, 6, 14);
        transformGeometry(band, { position: [0, 0.02, 0], rotation: [Math.PI / 2, 0, 0] });
        parts.push(band);
        const lamp = new THREE.CylinderGeometry(0.05, 0.055, 0.09, 8);
        transformGeometry(lamp, { position: [0, 0.06, 0.17] });
        parts.push(lamp);
        break;
      }
      case 'antlers': {
        for (const side of [-1, 1]) {
          const main = new THREE.CylinderGeometry(0.014, 0.022, 0.3, 5);
          transformGeometry(main, {
            position: [side * 0.09, 0.16, -0.02],
            rotation: [0.2, 0, side * 0.35],
          });
          parts.push(main);
          for (let b = 0; b < 3; b++) {
            const branch = new THREE.CylinderGeometry(0.009, 0.013, 0.13, 4);
            transformGeometry(branch, {
              position: [side * (0.13 + b * 0.02), 0.18 + b * 0.07, -0.02],
              rotation: [0.3, 0, side * (0.9 + b * 0.15)],
            });
            parts.push(branch);
          }
        }
        break;
      }
      case 'crown': {
        const band = new THREE.CylinderGeometry(0.17, 0.17, 0.07, 12, 1, true);
        transformGeometry(band, { position: [0, 0.05, 0] });
        parts.push(band);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          const point = new THREE.ConeGeometry(0.035, 0.09, 4);
          transformGeometry(point, {
            position: [Math.cos(a) * 0.17, 0.125, Math.sin(a) * 0.17],
          });
          parts.push(point);
        }
        break;
      }
      default:
        return null;
    }

    return parts.length > 0 ? mergeGeometries(parts, true) : null;
  }, [hat]);
}

/** Builds hair geometry for a given style. */
function useHairGeometry(style: string) {
  return useMemo(() => {
    if (style === 'bald') return null;
    const parts: THREE.BufferGeometry[] = [];

    // A cap of hair over the skull, common to every style.
    const cap = new THREE.SphereGeometry(0.163, 12, 9, 0, Math.PI * 2, 0, Math.PI * 0.58);
    transformGeometry(cap, { position: [0, 0.008, -0.005] });
    parts.push(cap);

    switch (style) {
      case 'bob': {
        const sides = new THREE.CylinderGeometry(0.168, 0.175, 0.16, 12, 1, true);
        transformGeometry(sides, { position: [0, -0.06, -0.01] });
        parts.push(sides);
        break;
      }
      case 'ponytail': {
        const tail = new THREE.CapsuleGeometry(0.05, 0.24, 3, 6);
        transformGeometry(tail, { position: [0, -0.06, -0.2], rotation: [0.5, 0, 0] });
        parts.push(tail);
        break;
      }
      case 'braids': {
        for (const side of [-1, 1]) {
          const braid = new THREE.CapsuleGeometry(0.04, 0.26, 3, 6);
          transformGeometry(braid, {
            position: [side * 0.15, -0.12, -0.05],
            rotation: [0.15, 0, side * 0.15],
          });
          parts.push(braid);
        }
        break;
      }
      case 'curly': {
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          const r = 0.15;
          const curl = new THREE.SphereGeometry(0.055, 6, 5);
          transformGeometry(curl, {
            position: [Math.cos(a) * r, 0.05 + Math.sin(i * 2.3) * 0.05, Math.sin(a) * r],
          });
          parts.push(curl);
        }
        break;
      }
      default:
        break;
    }

    return mergeGeometries(parts, true);
  }, [style]);
}

/** Builds backpack geometry. */
function useBackpackGeometry(kind: string) {
  return useMemo(() => {
    if (kind === 'none') return null;
    const parts: THREE.BufferGeometry[] = [];

    switch (kind) {
      case 'satchel': {
        const bag = new THREE.BoxGeometry(0.22, 0.2, 0.1);
        transformGeometry(bag, { position: [0.16, -0.05, 0] });
        parts.push(bag);
        const strap = new THREE.TorusGeometry(0.19, 0.018, 5, 12, Math.PI);
        transformGeometry(strap, { position: [0, 0.05, 0], rotation: [0, 0, -0.6] });
        parts.push(strap);
        break;
      }
      case 'rucksack': {
        const bag = new THREE.BoxGeometry(0.28, 0.34, 0.16);
        transformGeometry(bag, { position: [0, 0.02, -0.17] });
        parts.push(bag);
        const flap = new THREE.BoxGeometry(0.29, 0.12, 0.17);
        transformGeometry(flap, { position: [0, 0.16, -0.17], rotation: [0.2, 0, 0] });
        parts.push(flap);
        break;
      }
      case 'basket': {
        const basket = new THREE.CylinderGeometry(0.15, 0.12, 0.24, 10, 1, true);
        transformGeometry(basket, { position: [0, 0.02, -0.19] });
        parts.push(basket);
        const rim = new THREE.TorusGeometry(0.15, 0.016, 5, 12);
        transformGeometry(rim, { position: [0, 0.14, -0.19], rotation: [Math.PI / 2, 0, 0] });
        parts.push(rim);
        break;
      }
      case 'bedroll': {
        const roll = new THREE.CapsuleGeometry(0.075, 0.34, 4, 8);
        transformGeometry(roll, { position: [0, 0.05, -0.19], rotation: [0, 0, Math.PI / 2] });
        parts.push(roll);
        break;
      }
      default:
        return null;
    }

    return mergeGeometries(parts, true);
  }, [kind]);
}

export function Avatar({
  config,
  position,
  yaw,
  speed,
  grounded = true,
  crouching = false,
  emote = null,
  emoteTime = 0,
  ghost = false,
  ghostColor = '#8fd0ff',
}: AvatarProps) {
  const geo = useAvatarGeometry();
  const hatGeo = useHatGeometry(config.hat);
  const hairGeo = useHairGeometry(config.hairStyle);
  const packGeo = useBackpackGeometry(config.backpack);
  const wind = useWindField();

  const groupRef = useRef<THREE.Group>(null);
  const rootRef = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Group>(null);
  const lanternRef = useRef<THREE.Group>(null);

  /** Cycle phase, advanced by distance travelled rather than by time. */
  const cyclePhase = useRef(0);
  const lastPos = useRef(new THREE.Vector3());

  const outfit = useMemo(
    () => AVATAR.OUTFITS.find((o) => o.id === config.outfit) ?? AVATAR.OUTFITS[0],
    [config.outfit],
  );

  const materials = useMemo(() => {
    const make = (color: string) =>
      ghost
        ? new THREE.MeshBasicMaterial({
            color: ghostColor,
            transparent: true,
            opacity: MULTIPLAYER.GHOST_OPACITY,
            depthWrite: false,
          })
        : new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 });

    return {
      skin: make(AVATAR.SKIN_TONES[config.skinTone] ?? AVATAR.SKIN_TONES[0]!),
      hair: make(AVATAR.HAIR_COLORS[config.hairColor] ?? AVATAR.HAIR_COLORS[0]!),
      primary: make(outfit!.primary),
      secondary: make(outfit!.secondary),
      accessory: make('#8a6a4a'),
    };
  }, [config.skinTone, config.hairColor, outfit, ghost, ghostColor]);

  useEffect(
    () => () => {
      Object.values(materials).forEach((m) => m.dispose());
    },
    [materials],
  );

  useEffect(
    () => () => {
      hatGeo?.dispose();
      hairGeo?.dispose();
      packGeo?.dispose();
    },
    [hatGeo, hairGeo, packGeo],
  );

  useFrame((_, dt) => {
    const group = groupRef.current;
    const root = rootRef.current;
    if (!group || !root) return;

    const pos = Array.isArray(position) ? _avPos.set(...position) : position;
    group.position.copy(pos);
    group.rotation.y = yaw;

    /* ── Walk cycle ──────────────────────────────────────────────────────
     * Advancing the phase by distance rather than by time is the key
     * detail. It means the stride length is constant: the character takes
     * the same size step whether walking or sprinting, just more of them.
     * Time-driven cycles produce the classic "moonwalking" artefact where
     * feet slide because the animation and the movement disagree. */
    const distance = pos.distanceTo(lastPos.current);
    lastPos.current.copy(pos);
    // ~0.85 m per stride.
    cyclePhase.current += (distance / 0.85) * Math.PI * 2;

    const moving = speed > 0.3;
    const intensity = clamp(speed / PLAYER.WALK_SPEED, 0, 2);
    const swing = moving ? Math.sin(cyclePhase.current) : 0;
    const swingAmount = clamp(intensity * 0.55, 0, 0.85);

    /* ── Emotes override the walk ──────────────────────────────────────── */
    let emoteArmL = 0;
    let emoteArmR = 0;
    let emoteBodyY = 0;
    let emoteBodyTilt = 0;

    if (emote) {
      const t = emoteTime;
      switch (emote) {
        case 'wave':
          // Arm up and waving side to side.
          emoteArmR = -2.4;
          emoteArmL = 0;
          break;
        case 'cheer':
          emoteArmL = -2.7;
          emoteArmR = -2.7;
          // A little hop on each beat.
          emoteBodyY = Math.abs(Math.sin(t * 6)) * 0.12;
          break;
        case 'point':
          emoteArmR = -1.5;
          break;
        case 'shrug':
          emoteArmL = -0.55;
          emoteArmR = -0.55;
          break;
        case 'sit':
          emoteBodyY = -0.42;
          emoteBodyTilt = 0.1;
          break;
      }
    }

    // Crouch lowers the whole body and bends the legs.
    const crouchAmount = crouching ? 1 : 0;
    root.position.y = lerp(0, -0.35, crouchAmount) + emoteBodyY;
    root.rotation.x = emoteBodyTilt;

    /* Arms swing opposite the legs — the counter-rotation that makes bipedal
     * walking balance, and immediately wrong-looking if you get it backwards. */
    if (armL.current) {
      const base = emote ? emoteArmL : swing * swingAmount;
      const wave = emote === 'wave' ? 0 : 0;
      armL.current.rotation.x = damp(armL.current.rotation.x, base + wave, 0.06, dt);
    }
    if (armR.current) {
      let base = emote ? emoteArmR : -swing * swingAmount;
      if (emote === 'wave') {
        // The actual waving motion, on top of the raised arm.
        base = emoteArmR;
        armR.current.rotation.z = Math.sin(emoteTime * 9) * 0.45;
      } else {
        armR.current.rotation.z = damp(armR.current.rotation.z, 0, 0.08, dt);
      }
      armR.current.rotation.x = damp(armR.current.rotation.x, base, 0.06, dt);
    }
    if (legL.current) {
      const base = emote === 'sit' ? -1.4 : -swing * swingAmount * 0.85;
      legL.current.rotation.x = damp(legL.current.rotation.x, base, 0.05, dt);
    }
    if (legR.current) {
      const base = emote === 'sit' ? -1.4 : swing * swingAmount * 0.85;
      legR.current.rotation.x = damp(legR.current.rotation.x, base, 0.05, dt);
    }

    /* Body bob and lean. Two bobs per stride (one per footfall), and a forward
     * lean proportional to speed — you lean into a run. */
    if (moving) {
      root.position.y += Math.abs(Math.sin(cyclePhase.current)) * 0.035 * intensity;
      root.rotation.x = emoteBodyTilt + clamp(intensity * 0.06, 0, 0.14);
    }

    // Airborne: tuck the legs.
    if (!grounded) {
      if (legL.current) legL.current.rotation.x = damp(legL.current.rotation.x, -0.6, 0.08, dt);
      if (legR.current) legR.current.rotation.x = damp(legR.current.rotation.x, -0.3, 0.08, dt);
    }

    // Head counter-rotates slightly against the body sway — people look where
    // they're going, not where their shoulders are pointing.
    if (headRef.current) {
      headRef.current.rotation.y = -Math.sin(cyclePhase.current) * 0.08 * intensity;
      headRef.current.rotation.z = Math.sin(cyclePhase.current) * 0.04 * intensity;
    }

    /* The lantern swings from the hand with a pendulum lag, and is pushed
     * around by the wind. */
    if (lanternRef.current && config.lantern) {
      const t = performance.now() * 0.001;
      const swingAmp = AVATAR.LANTERN.swayAmplitude * (0.4 + intensity);
      lanternRef.current.rotation.z =
        Math.sin(cyclePhase.current - 0.7) * swingAmp + Math.sin(t * 1.3) * wind.strength * 0.06;
      lanternRef.current.rotation.x = Math.sin(cyclePhase.current * 0.5 - 0.4) * swingAmp * 0.6;
    }
  });

  const M = materials;

  return (
    <group ref={groupRef} name="avatar">
      <group ref={rootRef}>
        {/* Torso */}
        <mesh geometry={geo.torso} material={M.primary} position={[0, 1.12, 0]} castShadow />
        {/* Hips */}
        <mesh geometry={geo.torso} material={M.secondary} position={[0, 0.84, 0]} scale={[0.85, 0.5, 0.85]} castShadow />

        {/* Head */}
        <group ref={headRef} position={[0, 1.53, 0]}>
          <mesh geometry={geo.head} material={M.skin} castShadow />
          {hairGeo && <mesh geometry={hairGeo} material={M.hair} castShadow />}
          {hatGeo && <mesh geometry={hatGeo} material={M.secondary} position={[0, 0.11, 0]} castShadow />}
          {/* Eyes — two dark dots. Anything more detailed fights the style. */}
          {!ghost &&
            [-0.058, 0.058].map((x) => (
              <mesh key={x} position={[x, 0.02, 0.14]}>
                <sphereGeometry args={[0.021, 6, 5]} />
                <meshBasicMaterial color="#1a1614" />
              </mesh>
            ))}
        </group>

        {/* Arms — pivot at the shoulder. */}
        <group ref={armL} position={[-0.245, 1.32, 0]}>
          <mesh geometry={geo.upperArm} material={M.primary} position={[0, -0.14, 0]} castShadow />
          <mesh geometry={geo.lowerArm} material={M.skin} position={[0, -0.4, 0]} castShadow />
          <mesh geometry={geo.hand} material={M.skin} position={[0, -0.56, 0]} castShadow />
        </group>

        <group ref={armR} position={[0.245, 1.32, 0]}>
          <mesh geometry={geo.upperArm} material={M.primary} position={[0, -0.14, 0]} castShadow />
          <mesh geometry={geo.lowerArm} material={M.skin} position={[0, -0.4, 0]} castShadow />
          <mesh geometry={geo.hand} material={M.skin} position={[0, -0.56, 0]} castShadow />

          {/* Hand-held lantern. */}
          {config.lantern && (
            <group ref={lanternRef} position={[0, -0.58, 0]}>
              <mesh position={[0, -0.12, 0]}>
                <cylinderGeometry args={[0.017, 0.017, 0.16, 4]} />
                <meshStandardMaterial color="#3a2f22" />
              </mesh>
              <mesh position={[0, -0.26, 0]} castShadow>
                <cylinderGeometry args={[0.062, 0.075, 0.14, 8]} />
                <meshStandardMaterial
                  color="#2a2418"
                  emissive={new THREE.Color(AVATAR.LANTERN.color)}
                  emissiveIntensity={2.4}
                />
              </mesh>
              {!ghost && (
                <pointLight
                  position={[0, -0.26, 0]}
                  color={AVATAR.LANTERN.color}
                  intensity={AVATAR.LANTERN.intensity}
                  distance={AVATAR.LANTERN.distance}
                  decay={2}
                  castShadow={false}
                />
              )}
            </group>
          )}
        </group>

        {/* Legs — pivot at the hip. */}
        <group ref={legL} position={[-0.1, 0.78, 0]}>
          <mesh geometry={geo.upperLeg} material={M.secondary} position={[0, -0.18, 0]} castShadow />
          <mesh geometry={geo.lowerLeg} material={M.secondary} position={[0, -0.5, 0]} castShadow />
          <mesh geometry={geo.foot} material={M.accessory} position={[0, -0.7, 0]} castShadow />
        </group>

        <group ref={legR} position={[0.1, 0.78, 0]}>
          <mesh geometry={geo.upperLeg} material={M.secondary} position={[0, -0.18, 0]} castShadow />
          <mesh geometry={geo.lowerLeg} material={M.secondary} position={[0, -0.5, 0]} castShadow />
          <mesh geometry={geo.foot} material={M.accessory} position={[0, -0.7, 0]} castShadow />
        </group>

        {/* Backpack */}
        {packGeo && (
          <mesh geometry={packGeo} material={M.accessory} position={[0, 1.16, 0]} castShadow />
        )}
      </group>
    </group>
  );
}

/**
 * The local player's avatar, driven by `playerState` and shown only in
 * third-person mode.
 */
export function LocalAvatar({ visible }: { visible: boolean }) {
  const config = useGameStore((s) => s.avatar);
  const activeEmote = useGameStore((s) => s.activeEmote);
  const emoteStart = useRef(0);
  const emoteTime = useRef(0);
  const pos = useRef(new THREE.Vector3());

  useEffect(() => {
    if (activeEmote) emoteStart.current = performance.now();
  }, [activeEmote]);

  useFrame(() => {
    emoteTime.current = (performance.now() - emoteStart.current) / 1000;
    // The avatar's feet are at the capsule's base, half a height below centre.
    pos.current.set(
      playerState.position.x,
      playerState.position.y - PLAYER.HEIGHT * 0.5,
      playerState.position.z,
    );
  });

  if (!visible) return null;

  return (
    <Avatar
      config={config}
      position={pos.current}
      yaw={playerState.yaw + Math.PI}
      speed={playerState.speed}
      grounded={playerState.grounded}
      crouching={playerState.crouching}
      emote={activeEmote}
      emoteTime={emoteTime.current}
    />
  );
}

const _avPos = new THREE.Vector3();
