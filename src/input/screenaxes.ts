/**
 * Makes arrow-key movement relative to **the currently visible screen** (#147).
 *
 * If it were fixed to world X / Z, "which way does the screen move when you press ->"
 * would change every time the view rotates. That forces the user to mentally convert
 * axes while pressing, which is costly for the frequent operation of nudging a
 * selection with the arrows.
 *
 * **Never moves diagonally.** Since cells are on a grid, it moves 1 cell along whichever
 * world axis is closest to the screen's right.
 */

export type Vec3 = readonly [number, number, number];

/** The camera's local axes as seen in world space (the basis of `matrixWorld`) */
export interface CameraBasis {
  /** Camera's +X = screen right */
  readonly right: Vec3;
  /** The direction the camera faces = screen far/back */
  readonly forward: Vec3;
  /** Camera's +Y = screen up */
  readonly up: Vec3;
}

const EPSILON = 1e-6;

/** A unit vector projected onto the horizontal plane and snapped to the nearest axis. null if it doesn't project onto the ground */
function snapToHorizontalAxis(v: Vec3): Vec3 | null {
  const [x, , z] = v;
  if (Math.abs(x) < EPSILON && Math.abs(z) < EPSILON) return null;
  // when they're the same magnitude (exactly 45 degrees), take X. Fixed by order, to avoid flip-flopping
  return Math.abs(x) >= Math.abs(z) ? [Math.sign(x), 0, 0] : [0, 0, Math.sign(z)];
}

function negate(v: Vec3): Vec3 {
  return [-v[0], -v[1], -v[2]];
}

function sameAxis(a: Vec3, b: Vec3): boolean {
  return (a[0] !== 0) === (b[0] !== 0);
}

/** Snaps to the axis `taken` isn't using. null if that component is absent */
function snapToRemainingAxis(v: Vec3, taken: Vec3): Vec3 | null {
  const [x, , z] = v;
  if (taken[0] !== 0) return Math.abs(z) < EPSILON ? null : [0, 0, Math.sign(z)];
  return Math.abs(x) < EPSILON ? null : [Math.sign(x), 0, 0];
}

/**
 * Resolves the pressed key into a 1-cell move relative to the current viewpoint.
 *
 * - Arrow keys: screen left/right and near/far
 * - PageUp / PageDown: height. Always up/down regardless of viewpoint (matches the
 *   screen's up/down, so it's never confusing)
 *
 * "Far" is determined by **projecting the camera's facing direction onto the ground**.
 * Only when looking straight down is the camera's facing perpendicular to the ground
 * and therefore undeterminable — in that case the direction the screen's "up" points
 * to (the camera's up direction) is used instead.
 *
 * @returns the move vector, or null if this key isn't handled
 */
export function screenAlignedNudge(key: string, basis: CameraBasis): Vec3 | null {
  if (key === 'PageUp') return [0, 1, 0];
  if (key === 'PageDown') return [0, -1, 0];
  if (key !== 'ArrowRight' && key !== 'ArrowLeft' && key !== 'ArrowUp' && key !== 'ArrowDown') return null;

  const right = snapToHorizontalAxis(basis.right);
  // Looking straight down makes forward perpendicular to the ground, so up is substituted only in that case
  const awaySource = snapToHorizontalAxis(basis.forward) ? basis.forward : basis.up;
  let away = snapToHorizontalAxis(awaySource);
  if (!right || !away) return null;
  // **Both can snap to the same axis.** At a horizontal 45 degrees, right and away both
  // have equal X and Z magnitude, so the snapping rule (ties go to X) puts both onto X.
  // Giving up here would disable movement in every direction, so **right is kept as
  // priority and away is pushed onto the remaining axis** (left/right is easier to read
  // from the screen)
  if (sameAxis(right, away)) {
    away = snapToRemainingAxis(awaySource, right);
    if (!away) return null;
  }

  switch (key) {
    case 'ArrowRight':
      return right;
    case 'ArrowLeft':
      return negate(right);
    case 'ArrowUp':
      return away;
    default:
      return negate(away);
  }
}
