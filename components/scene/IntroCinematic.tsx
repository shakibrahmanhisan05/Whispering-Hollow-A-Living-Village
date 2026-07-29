/**
 * The opening flyover.
 *
 * Eight seconds from high above the valley, down over the rooftops, along the
 * dirt path, and finally settling into the player's eye position. Then control
 * hands over.
 *
 * Uses GSAP rather than a hand-rolled tween for one specific reason: the
 * `power2.inOut` easing on a *timeline* gives continuous velocity across the
 * waypoint boundaries. A naive lerp between four points visibly stops and
 * restarts at each one, which reads as a stutter and completely undermines the
 * shot.
 *
 * @module components/scene/IntroCinematic
 */

'use client';

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import gsap from 'gsap';
import * as THREE from 'three';

import { useGameStore } from '@/store/gameStore';
import { useSettingsStore } from '@/store/settingsStore';
import { playerState } from '../player/PlayerController';
import { INTRO } from '@/config/game';

export function IntroCinematic() {
  const { camera } = useThree();
  const phase = useGameStore((s) => s.phase);
  const setPhase = useGameStore((s) => s.setPhase);
  const markIntroSeen = useGameStore((s) => s.markIntroSeen);
  const reducedMotion = useSettingsStore((s) => s.accessibility.reducedMotion);

  /** Interpolated camera state the flyover writes into. */
  const rig = useRef({
    px: INTRO.FLYOVER_PATH[0]!.pos[0],
    py: INTRO.FLYOVER_PATH[0]!.pos[1],
    pz: INTRO.FLYOVER_PATH[0]!.pos[2],
    lx: INTRO.FLYOVER_PATH[0]!.look[0],
    ly: INTRO.FLYOVER_PATH[0]!.look[1],
    lz: INTRO.FLYOVER_PATH[0]!.look[2],
  });

  const running = useRef(false);
  const timeline = useRef<gsap.core.Timeline | null>(null);

  useEffect(() => {
    if (phase !== 'intro') return;

    /* Reduced motion skips the flyover entirely — a sweeping camera move the
     * player cannot control is exactly the kind of thing the setting exists
     * for. */
    if (reducedMotion) {
      markIntroSeen();
      setPhase('playing');
      return;
    }

    running.current = true;
    const r = rig.current;
    const path = INTRO.FLYOVER_PATH;

    // Start at the first waypoint.
    r.px = path[0]!.pos[0];
    r.py = path[0]!.pos[1];
    r.pz = path[0]!.pos[2];
    r.lx = path[0]!.look[0];
    r.ly = path[0]!.look[1];
    r.lz = path[0]!.look[2];

    const tl = gsap.timeline({
      onComplete: () => {
        running.current = false;
        markIntroSeen();
        setPhase('playing');
      },
    });

    /* Each leg gets a share of the total duration weighted toward the end —
     * the descent should feel like it settles, not like it arrives. */
    const weights = [0.32, 0.3, 0.24, 0.14];
    for (let i = 1; i < path.length; i++) {
      const wp = path[i]!;
      tl.to(
        r,
        {
          px: wp.pos[0],
          py: wp.pos[1],
          pz: wp.pos[2],
          lx: wp.look[0],
          ly: wp.look[1],
          lz: wp.look[2],
          duration: INTRO.FLYOVER_DURATION * weights[i - 1]!,
          /* `power2.inOut` on every leg but the last, `power2.out` on the last
           * so the camera decelerates into the final position rather than
           * easing in and then stopping abruptly at handover. */
          ease: i === path.length - 1 ? 'power2.out' : 'power1.inOut',
        },
        i === 1 ? 0 : '>-0.15', // Slight overlap blends the leg boundaries.
      );
    }

    timeline.current = tl;

    /* Skip on any key or click. Cinematics you cannot skip are a hostile
     * default, and this one plays on every fresh world. */
    const skip = () => {
      tl.progress(1);
      tl.kill();
      running.current = false;
      markIntroSeen();
      setPhase('playing');
    };
    window.addEventListener('keydown', skip, { once: true });
    window.addEventListener('mousedown', skip, { once: true });

    return () => {
      tl.kill();
      timeline.current = null;
      running.current = false;
      window.removeEventListener('keydown', skip);
      window.removeEventListener('mousedown', skip);
    };
  }, [phase, reducedMotion, setPhase, markIntroSeen]);

  useFrame(() => {
    if (!running.current || phase !== 'intro') return;
    const r = rig.current;
    camera.position.set(r.px, r.py, r.pz);
    camera.lookAt(r.lx, r.ly, r.lz);

    /* Keep the player's yaw in sync with the camera's final heading, so control
     * hands over without the view snapping to a different direction. */
    _dir.set(r.lx - r.px, 0, r.lz - r.pz).normalize();
    playerState.yaw = Math.atan2(-_dir.x, -_dir.z);
    playerState.pitch = 0;
  });

  return null;
}

const _dir = new THREE.Vector3();
