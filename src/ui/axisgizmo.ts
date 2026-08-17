import type { PerspectiveCamera, Vector3 } from 'three';
import * as THREE from 'three';

/**
 * The axis gizmo in the viewport corner (#148).
 *
 * **Always shows which way is +X and which way is +Z.** While building in 3D,
 * rotating the view makes it easy to lose track of which world axis "move right"
 * corresponds to. A ground-plane axis cross would scroll off-screen once the build
 * moves away from the origin, so this is **pinned to the screen** instead and
 * rotates to follow the camera's orientation.
 *
 * **Rendered in the DOM.** A separate small WebGL viewport would need the labels
 * baked as plane textures, which blur on every zoom. Since this is just lines and
 * text, DOM is the more straightforward fit.
 */

/**
 * The axes shown. **Y is never shown.**
 *
 * Height is always screen-up/down and doesn't change as the view rotates — showing
 * an axis that's obvious without looking would only make the two horizontal axes
 * that actually need reading harder to pick out.
 */
const AXES = [
  { label: '+X', dir: new THREE.Vector3(1, 0, 0) },
  { label: '−X', dir: new THREE.Vector3(-1, 0, 0) },
  { label: '+Z', dir: new THREE.Vector3(0, 0, 1) },
  { label: '−Z', dir: new THREE.Vector3(0, 0, -1) },
] as const;

/**
 * Threshold below which an axis is treated as facing away (normalized camera-space z).
 *
 * **Not cut at 0.** Looking straight down or straight from the side makes a
 * horizontal axis run parallel to the screen, pushing z to nearly 0. Cutting there
 * would dim both +X and −X simultaneously, falsely implying "both point away."
 */
const AWAY_THRESHOLD = -0.15;

/** Radius of the gizmo (px). Label centers are placed here */
const RADIUS = 26;

export interface AxisGizmo {
  /** Call whenever the camera moves */
  update: () => void;
}

/**
 * @param root Element containing the viewport (must have `position: relative`)
 */
export function initAxisGizmo(root: HTMLElement, camera: PerspectiveCamera): AxisGizmo {
  const box = document.createElement('div');
  box.className = 'axis-gizmo';
  box.setAttribute('aria-hidden', 'true'); // A purely visual cue; announcing it would just be noise

  const marks = AXES.map(({ label }) => {
    const el = document.createElement('span');
    el.className = 'axis-gizmo-label';
    el.textContent = label;
    box.appendChild(el);
    return el;
  });

  root.appendChild(box);

  const world = new THREE.Vector3();
  const origin = new THREE.Vector3();

  /**
   * Project a world-space direction down to a screen-space direction.
   *
   * Reads x / y after moving into camera space — running it through the full
   * projection would flip the sign whenever the origin sits off-screen (falling
   * behind the near plane). Since **only the direction is needed**, this stops short of perspective projection.
   */
  function screenDirection(dir: Vector3): { x: number; y: number; depth: number } {
    world.copy(dir).applyMatrix4(camera.matrixWorldInverse);
    origin.set(0, 0, 0).applyMatrix4(camera.matrixWorldInverse);
    const dx = world.x - origin.x;
    const dy = world.y - origin.y;
    const dz = world.z - origin.z;
    const flat = Math.hypot(dx, dy) || 1;
    const full = Math.hypot(dx, dy, dz) || 1;
    // Flipped because screen y points downward. depth is the normalized camera-space z
    // (the camera looks down -Z, so positive = toward the camera / negative = away)
    return { x: dx / flat, y: -dy / flat, depth: dz / full };
  }

  function update(): void {
    camera.updateMatrixWorld();
    for (const [i, axis] of AXES.entries()) {
      const { x, y, depth } = screenDirection(axis.dir);
      const mark = marks[i]!;
      mark.style.transform = `translate(-50%, -50%) translate(${(x * RADIUS).toFixed(1)}px, ${(y * RADIUS).toFixed(1)}px)`;
      // Dim only the axes facing away. When viewed from the side and two labels
      // overlap, being unable to tell which one is nearer leads to misreading the orientation
      mark.style.opacity = depth < AWAY_THRESHOLD ? '0.4' : '1';
    }
  }

  update();
  return { update };
}
