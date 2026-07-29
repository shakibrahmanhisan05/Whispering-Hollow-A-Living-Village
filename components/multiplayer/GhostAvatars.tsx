/**
 * Remote players, rendered as translucent ghosts.
 *
 * ## Interpolation
 *
 * Transforms arrive at 10 Hz. Rendering them directly would give visibly
 * stepped movement, so each ghost keeps its own interpolated position and
 * chases the latest sample with an exponential damp. At walking speed the
 * result is indistinguishable from a 60 Hz feed, and it costs one `damp` call
 * per ghost per frame.
 *
 * Deliberately *not* extrapolated. Predicting ahead would hide the last few
 * milliseconds of latency but produces rubber-banding whenever someone stops
 * or turns — and in a game where nobody can be shot, latency simply does not
 * matter enough to trade smoothness for it.
 *
 * @module components/multiplayer/GhostAvatars
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { Avatar } from '../player/Avatar';
import { playerState } from '../player/PlayerController';
import { usePresenceStore } from '@/store/presenceStore';
import { useGameStore } from '@/store/gameStore';
import { broadcastTransform, isPresenceActive } from '@/lib/rtdb';
import { ui } from '@/store/uiState';
import { MULTIPLAYER, DEFAULT_AVATAR, PLAYER, type EmoteId } from '@/config/game';
import { damp, dampAngle } from '@/lib/utils/math';

export function GhostAvatars() {
  const players = usePresenceStore((s) => s.players);
  const connected = usePresenceStore((s) => s.connected);
  const lanternOn = useGameStore((s) => s.lanternOn);

  /* Broadcast our own transform. Doing it here rather than in the player
   * controller keeps all networking in the multiplayer module. */
  useFrame(() => {
    if (!isPresenceActive()) return;
    void broadcastTransform(
      playerState.position.x,
      playerState.position.y - PLAYER.HEIGHT * 0.5,
      playerState.position.z,
      playerState.yaw,
      lanternOn,
    );
  });

  useEffect(() => {
    ui.connectedPlayers = Object.keys(players).length;
    ui.multiplayerStatus = connected ? 'connected' : isPresenceActive() ? 'connecting' : 'off';
  }, [players, connected]);

  const uids = useMemo(() => Object.keys(players), [players]);

  return (
    <group name="ghosts">
      {uids.map((uid) => (
        <Ghost key={uid} uid={uid} />
      ))}
    </group>
  );
}

/** One remote player. */
function Ghost({ uid }: { uid: string }) {
  const player = usePresenceStore((s) => s.players[uid]);

  /** Interpolated transform, kept in a ref so updates don't re-render. */
  const smoothed = useRef({
    pos: new THREE.Vector3(),
    yaw: 0,
    speed: 0,
    initialised: false,
  });

  const emoteTime = useRef(0);

  useFrame((_, dt) => {
    if (!player) return;
    const s = smoothed.current;

    if (!s.initialised) {
      // Snap on first sight, or the ghost visibly flies in from the origin.
      s.pos.set(player.x, player.y, player.z);
      s.yaw = player.rotY;
      s.initialised = true;
      return;
    }

    const prevX = s.pos.x;
    const prevZ = s.pos.z;

    s.pos.x = damp(s.pos.x, player.x, MULTIPLAYER.GHOST_SMOOTHING, dt);
    s.pos.y = damp(s.pos.y, player.y, MULTIPLAYER.GHOST_SMOOTHING, dt);
    s.pos.z = damp(s.pos.z, player.z, MULTIPLAYER.GHOST_SMOOTHING, dt);
    // Angular damp takes the short way round, so turning past north doesn't
    // spin the ghost the long way.
    s.yaw = dampAngle(s.yaw, player.rotY, MULTIPLAYER.GHOST_SMOOTHING, dt);

    /* Derive speed from the *interpolated* motion rather than from the raw
     * samples. Using raw deltas would give a speed of zero between packets and
     * a spike on each one, making the walk animation stutter. */
    const moved = Math.hypot(s.pos.x - prevX, s.pos.z - prevZ);
    s.speed = damp(s.speed, dt > 0 ? moved / dt : 0, 0.12, dt);

    emoteTime.current = player.emoteAt > 0 ? (Date.now() - player.emoteAt) / 1000 : 0;
  });

  if (!player) return null;

  // Emotes expire locally rather than needing a clearing message.
  const emoteActive =
    player.emote && emoteTime.current < MULTIPLAYER.EMOTE_DURATION ? player.emote : null;

  return (
    <group>
      <Avatar
        config={{ ...DEFAULT_AVATAR, lantern: player.lantern, ghostColor: player.avatarColor }}
        position={smoothed.current.pos}
        yaw={smoothed.current.yaw + Math.PI}
        speed={smoothed.current.speed}
        emote={emoteActive as EmoteId | null}
        emoteTime={emoteTime.current}
        ghost
        ghostColor={player.avatarColor}
      />
      <GhostNameplate
        name={player.displayName}
        position={smoothed.current.pos}
        color={player.avatarColor}
      />
    </group>
  );
}

/**
 * A floating name above a ghost.
 *
 * Drawn as a canvas texture on a billboarded plane rather than using drei's
 * `<Html>`. `<Html>` mounts a real DOM node per label, which does not
 * depth-test against the scene — names would show through hills. A textured
 * quad is properly occluded and costs nothing.
 */
function GhostNameplate({
  name,
  position,
  color,
}: {
  name: string;
  position: THREE.Vector3;
  color: string;
}) {
  const meshRef = useRef<THREE.Mesh>(null);

  const { texture, aspect } = useMemo(() => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const fontSize = 44;
    ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
    const metrics = ctx.measureText(name);
    const padding = 28;
    canvas.width = Math.ceil(metrics.width + padding * 2);
    canvas.height = fontSize + padding;

    // Re-set after resizing — changing canvas dimensions resets the context.
    ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // A soft dark plate behind the text so it reads against the sky or grass.
    ctx.fillStyle = 'rgba(8, 14, 12, 0.55)';
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, canvas.height / 2);
    ctx.fill();

    ctx.fillStyle = color;
    ctx.fillText(name, canvas.width / 2, canvas.height / 2 + 1);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return { texture: tex, aspect: canvas.width / canvas.height };
  }, [name, color]);

  useEffect(() => () => texture.dispose(), [texture]);

  useFrame(({ camera }) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.position.set(position.x, position.y + 2.1, position.z);
    // Billboard: face the camera exactly.
    mesh.quaternion.copy(camera.quaternion);

    /* Fade with distance and hide when very far. Nameplates that stay
     * crisply readable across 200 m read as a HUD element rather than as
     * something in the world. */
    const dist = mesh.position.distanceTo(camera.position);
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.opacity = Math.max(0, 1 - Math.max(0, dist - 18) / 32);
    mesh.visible = mat.opacity > 0.02;
  });

  const height = 0.34;

  return (
    <mesh ref={meshRef} renderOrder={40}>
      <planeGeometry args={[height * aspect, height]} />
      <meshBasicMaterial
        map={texture}
        transparent
        depthWrite={false}
        opacity={1}
        toneMapped={false}
      />
    </mesh>
  );
}
