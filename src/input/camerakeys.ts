import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { isTypingTarget } from './typing';

export interface CameraKeysOpts {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** The focus target for the F key (build's center and radius). null if none */
  getFocus: () => { center: THREE.Vector3; radius: number } | null;
  /**
   * Whether to yield the arrow keys instead of using them for camera movement
   * (from a second review pass).
   *
   * **A single hook for the predicate that decides key ownership.** Previously the
   * shortcut table and this module judged it separately, which could produce a state
   * where "the table rejected nudge, but camerakeys also yielded" — nobody claims the
   * key and nothing happens. The caller (main.ts) passes the same function to both.
   *
   * The currently-held modifier keys are tracked and passed in by camerakeys itself —
   * update() runs every frame and doesn't have a KeyboardEvent to read from.
   */
  isArrowClaimed?: (modifiers: ArrowModifiers) => boolean;
}

/** Modifier key state passed to the arrow-key ownership check */
export interface ArrowModifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

const NO_MODIFIERS: ArrowModifiers = { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false };

const ROTATE_SPEED = 1.6; // rad/s
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Keyboard camera controls.
 * WASD/arrows = pan (relative to camera facing) / Z/C = up/down / Q/E = rotate /
 * F = focus on the build / R = reset view.
 * Space is not shared with ascend; following the industry standard set by Figma etc.,
 * it's dedicated to "hold to pan with left-drag" (achieved by switching
 * OrbitControls.mouseButtons.LEFT to PAN only while held).
 * Call the returned update(dt) every frame. isSpaceHeld() exposes whether Space is
 * currently held to other modules.
 */
export interface CameraKeysHandle {
  update: (dt: number) => void;
  isSpaceHeld: () => boolean;
  /** Receives window keydown forwarded from InputRouter (fallback for when the SHORTCUTS table lookup misses) */
  onKeyDown: (e: KeyboardEvent) => void;
  onKeyUp: (e: KeyboardEvent) => void;
  onBlur: () => void;
}

export function initCameraKeys(opts: CameraKeysOpts): CameraKeysHandle {
  const { camera, controls, getFocus, isArrowClaimed } = opts;
  const pressed = new Set<string>();
  // Space's held state is tracked separately from pressed. Space isn't a movement key
  // — it's a modifier state where "left-drag becomes pan while held" — so it's kept out
  // of the movement key set
  let spaceHeld = false;
  // Currently-held modifier keys. update() has no KeyboardEvent, so this is copied on every key event
  let modifiers: ArrowModifiers = NO_MODIFIERS;
  const homePos = camera.position.clone();
  const homeTarget = controls.target.clone();

  // The old window keydown/keyup/blur listeners are consolidated into InputRouter
  //, with the logic unchanged, and exposed as onKeyDown/onKeyUp/onBlur (called by
  // the router as a fallback when the SHORTCUTS table lookup misses).
  function onKeyDown(e: KeyboardEvent): void {
    if (isTypingTarget(e.target)) return;
    modifiers = { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey };
    // Ctrl / Meta / Alt combos conflict with browser/OS shortcuts, so they're not used for camera control
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'r') {
      camera.position.copy(homePos);
      controls.target.copy(homeTarget);
      return;
    }
    if (k === 'f') {
      const focus = getFocus();
      if (focus) {
        const dir = camera.position.clone().sub(controls.target).normalize();
        const dist = Math.max(8, focus.radius * 2.4);
        controls.target.copy(focus.center);
        camera.position.copy(focus.center).add(dir.multiplyScalar(dist));
      }
      return;
    }
    if (k === ' ') {
      e.preventDefault();
      spaceHeld = true;
      controls.mouseButtons.LEFT = THREE.MOUSE.PAN; // left-drag pans while held (suspends the default tool operation until released)
      return; // don't add to pressed (the movement key set)
    }
    pressed.add(k);
  }

  function onKeyUp(e: KeyboardEvent): void {
    modifiers = { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey };
    const k = e.key.toLowerCase();
    if (k === ' ') {
      spaceHeld = false;
      controls.mouseButtons.LEFT = null; // restore default (left-click is a tool operation)
      return;
    }
    pressed.delete(k);
  }

  // So held keys don't get stuck on focus loss
  function onBlur(): void {
    modifiers = NO_MODIFIERS;
    pressed.clear();
    spaceHeld = false;
    controls.mouseButtons.LEFT = null;
  }

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const move = new THREE.Vector3();

  const update = (dt: number): void => {
    if (!pressed.size) return;

    const dist = camera.position.distanceTo(controls.target);
    const speed = Math.max(10, dist * 0.9);

    forward.subVectors(controls.target, camera.position);
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
    forward.normalize();
    right.crossVectors(forward, UP);

    move.set(0, 0, 0);
    const arrowClaimed = isArrowClaimed?.(modifiers) ?? false;
    if (pressed.has('w') || (!arrowClaimed && pressed.has('arrowup'))) move.add(forward);
    if (pressed.has('s') || (!arrowClaimed && pressed.has('arrowdown'))) move.sub(forward);
    if (pressed.has('d') || (!arrowClaimed && pressed.has('arrowright'))) move.add(right);
    if (pressed.has('a') || (!arrowClaimed && pressed.has('arrowleft'))) move.sub(right);
    if (pressed.has('z')) move.y += 1;
    if (pressed.has('c')) move.y -= 1;
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed * dt);
      camera.position.add(move);
      controls.target.add(move);
    }

    const rotate = (pressed.has('q') ? 1 : 0) - (pressed.has('e') ? 1 : 0);
    if (rotate !== 0) {
      const offset = camera.position.clone().sub(controls.target);
      offset.applyAxisAngle(UP, rotate * ROTATE_SPEED * dt);
      camera.position.copy(controls.target).add(offset);
    }
  };

  return { update, isSpaceHeld: () => spaceHeld, onKeyDown, onKeyUp, onBlur };
}
