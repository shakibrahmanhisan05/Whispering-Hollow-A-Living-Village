/**
 * Pointer Lock management.
 *
 * Pointer lock is the browser feature that hides the cursor and delivers raw
 * mouse deltas — without it there is no first-person camera. It can only be
 * requested from a user gesture, can be silently refused, and is exited by the
 * browser (not by us) whenever the user presses Escape.
 *
 * That last point drives the whole design here: **Escape is not ours to
 * handle.** The browser always exits pointer lock on Escape and there is no way
 * to prevent it. So rather than fighting it, the game treats "pointer lock
 * lost" as the canonical signal to open the pause menu, and "pointer lock
 * gained" as the signal to close it. The result is that Escape does exactly
 * what players expect, using the browser's own behaviour rather than working
 * around it.
 *
 * @module hooks/usePointerLock
 */

'use client';

import { useCallback, useEffect, useRef } from 'react';
import { ui } from '@/store/uiState';
import { supportsPointerLock } from '@/lib/utils/perf';

export interface PointerLockApi {
  /** Requests lock on the canvas. Must be called from a user gesture. */
  request: () => void;
  /** Releases lock, which opens the pause menu via the change handler. */
  release: () => void;
  /** Whether the API exists in this browser at all. */
  supported: boolean;
}

/**
 * @param onLock - Fired when lock is acquired.
 * @param onUnlock - Fired when lock is lost, for any reason.
 * @param canvasSelector - Element to lock. Defaults to the R3F canvas.
 */
export function usePointerLock(
  onLock?: () => void,
  onUnlock?: () => void,
  canvasSelector = 'canvas',
): PointerLockApi {
  const onLockRef = useRef(onLock);
  const onUnlockRef = useRef(onUnlock);
  onLockRef.current = onLock;
  onUnlockRef.current = onUnlock;

  const supported = supportsPointerLock();

  useEffect(() => {
    if (!supported) {
      ui.pointerLockUnsupported = true;
      return;
    }

    const onChange = () => {
      const locked = document.pointerLockElement !== null;
      ui.pointerLocked = locked;
      if (locked) onLockRef.current?.();
      else onUnlockRef.current?.();
    };

    const onError = () => {
      /* Fires when the request is denied — most often because it wasn't from a
       * user gesture, or the document isn't focused. Not fatal: the player can
       * simply click again. */
      ui.pointerLocked = false;
      console.warn('[pointerlock] Request denied. Click the scene to try again.');
    };

    document.addEventListener('pointerlockchange', onChange);
    document.addEventListener('pointerlockerror', onError);
    return () => {
      document.removeEventListener('pointerlockchange', onChange);
      document.removeEventListener('pointerlockerror', onError);
    };
  }, [supported]);

  const request = useCallback(() => {
    if (!supported) return;
    const el = document.querySelector(canvasSelector) as HTMLElement | null;
    if (!el) return;
    try {
      /* `unadjustedMovement` disables OS-level pointer acceleration, giving
       * consistent aim across platforms. It is Chromium-only and returns a
       * promise that rejects elsewhere — the catch falls back to plain lock. */
      const result = (
        el.requestPointerLock as unknown as (
          opts?: { unadjustedMovement?: boolean },
        ) => Promise<void> | void
      ).call(el, { unadjustedMovement: true });

      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => {
          try {
            el.requestPointerLock();
          } catch {
            /* Give up quietly; onError has already warned. */
          }
        });
      }
    } catch {
      try {
        el.requestPointerLock();
      } catch {
        /* Unsupported. */
      }
    }
  }, [supported, canvasSelector]);

  const release = useCallback(() => {
    if (document.pointerLockElement) document.exitPointerLock();
  }, []);

  return { request, release, supported };
}
