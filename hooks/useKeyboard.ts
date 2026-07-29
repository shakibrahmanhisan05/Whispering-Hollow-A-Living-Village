/**
 * Keyboard and pointer input.
 *
 * Input is read through a **mutable ref object**, never React state. A
 * `setState` on every keypress would re-render the tree mid-movement; the
 * player controller instead reads `input.current.forward` directly inside
 * `useFrame`.
 *
 * Bindings are resolved through the settings store, so rebinding a key takes
 * effect immediately with no listener churn.
 *
 * @module hooks/useKeyboard
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useSettingsStore, resolveBinding } from '@/store/settingsStore';
import type { BindingAction } from '@/config/game';
import { ui } from '@/store/uiState';

/** Continuous movement axes plus edge-triggered action flags. */
export interface InputState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
  crouch: boolean;
  /** Set for one frame when the key goes down. Consumers must clear it. */
  jumpPressed: boolean;
  interactPressed: boolean;
  /** Held state, for hold-to-interact prompts. */
  interactHeld: boolean;
  /** Mouse delta accumulated since the last frame, in radians of rotation. */
  mouseDeltaX: number;
  mouseDeltaY: number;
  /** Scroll wheel delta, used by photo mode for focal length. */
  wheelDelta: number;
  /** Any movement key currently down — used to dismiss the movement hint. */
  anyMovement: boolean;
}

const createInput = (): InputState => ({
  forward: false,
  backward: false,
  left: false,
  right: false,
  sprint: false,
  crouch: false,
  jumpPressed: false,
  interactPressed: false,
  interactHeld: false,
  mouseDeltaX: 0,
  mouseDeltaY: 0,
  wheelDelta: 0,
  anyMovement: false,
});

/** Actions that fire once per key-down rather than being held. */
export type EdgeAction = Extract<
  BindingAction,
  'photoMode' | 'thirdPerson' | 'character' | 'emote' | 'journal' | 'map' | 'lantern' | 'interact'
>;

/**
 * Installs global input listeners and returns the shared input ref.
 *
 * @param onEdgeAction - Called once per press for discrete actions (open a
 *   panel, toggle a mode). Movement is *not* routed through here.
 * @param enabled - When false, all input is ignored (e.g. while a menu is open).
 */
export function useKeyboard(
  onEdgeAction?: (action: EdgeAction, event: KeyboardEvent) => void,
  enabled = true,
): React.RefObject<InputState> {
  const input = useRef<InputState>(createInput());
  const bindings = useSettingsStore((s) => s.bindings);
  const sensitivity = useSettingsStore((s) => s.gameplay.mouseSensitivity);
  const invertY = useSettingsStore((s) => s.gameplay.invertY);

  // Keep the callback in a ref so re-binding doesn't tear down listeners.
  const edgeRef = useRef(onEdgeAction);
  edgeRef.current = onEdgeAction;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const edgeActions = useMemo(
    () =>
      new Set<BindingAction>([
        'photoMode',
        'thirdPerson',
        'character',
        'emote',
        'journal',
        'map',
        'lantern',
        'interact',
      ]),
    [],
  );

  useEffect(() => {
    const state = input.current;

    const applyMovement = () => {
      state.anyMovement = state.forward || state.backward || state.left || state.right;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // Never swallow typing in a text field (the seed input, world names).
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }

      const action = resolveBinding(bindings, e.code);
      if (!action) return;

      // Tab and Space would otherwise scroll or move focus.
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();

      if (edgeActions.has(action)) {
        // Edge actions fire on the transition only, not on auto-repeat.
        if (e.repeat) return;
        if (action === 'interact') {
          state.interactPressed = true;
          state.interactHeld = true;
        }
        edgeRef.current?.(action as EdgeAction, e);
        return;
      }

      if (!enabledRef.current) return;

      switch (action) {
        case 'forward':
          state.forward = true;
          break;
        case 'backward':
          state.backward = true;
          break;
        case 'left':
          state.left = true;
          break;
        case 'right':
          state.right = true;
          break;
        case 'sprint':
          state.sprint = true;
          break;
        case 'crouch':
          state.crouch = true;
          break;
        case 'jump':
          if (!e.repeat) state.jumpPressed = true;
          break;
        default:
          break;
      }
      applyMovement();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const action = resolveBinding(bindings, e.code);
      if (!action) return;

      switch (action) {
        case 'forward':
          state.forward = false;
          break;
        case 'backward':
          state.backward = false;
          break;
        case 'left':
          state.left = false;
          break;
        case 'right':
          state.right = false;
          break;
        case 'sprint':
          state.sprint = false;
          break;
        case 'crouch':
          state.crouch = false;
          break;
        case 'interact':
          state.interactHeld = false;
          break;
        default:
          break;
      }
      applyMovement();
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!enabledRef.current || !ui.pointerLocked) return;
      /* movementX/Y are already in device pixels of pointer travel. The 0.0022
       * factor converts to radians at sensitivity 1.0 — chosen so a 360° turn
       * takes roughly the same hand movement as most first-person games. */
      const scale = 0.0022 * sensitivity;
      state.mouseDeltaX += e.movementX * scale;
      state.mouseDeltaY += e.movementY * scale * (invertY ? -1 : 1);
    };

    const onWheel = (e: WheelEvent) => {
      if (!enabledRef.current) return;
      state.wheelDelta += e.deltaY;
    };

    /* Releasing every key on blur prevents the classic "player walks forever"
     * bug: alt-tabbing away while holding W means the keyup never arrives. */
    const onBlur = () => {
      Object.assign(state, createInput());
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('blur', onBlur);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('blur', onBlur);
    };
  }, [bindings, sensitivity, invertY, edgeActions]);

  return input;
}

/**
 * Consumes and clears the accumulated mouse delta.
 * Call once per frame from the camera controller.
 */
export function consumeMouseDelta(input: InputState): [number, number] {
  const dx = input.mouseDeltaX;
  const dy = input.mouseDeltaY;
  input.mouseDeltaX = 0;
  input.mouseDeltaY = 0;
  return [dx, dy];
}

/** Consumes and clears the wheel delta. */
export function consumeWheelDelta(input: InputState): number {
  const d = input.wheelDelta;
  input.wheelDelta = 0;
  return d;
}

/** Human-readable label for a `KeyboardEvent.code`, for the rebinding UI. */
export function formatKeyCode(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return `${code.slice(5)} Arrow`;
  const map: Record<string, string> = {
    Space: 'Space',
    ShiftLeft: 'L Shift',
    ShiftRight: 'R Shift',
    ControlLeft: 'L Ctrl',
    ControlRight: 'R Ctrl',
    AltLeft: 'L Alt',
    AltRight: 'R Alt',
    Tab: 'Tab',
    Escape: 'Esc',
    Enter: 'Enter',
    Backspace: 'Backspace',
    CapsLock: 'Caps',
  };
  return map[code] ?? code;
}
