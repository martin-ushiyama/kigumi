/**
 * World axis numbering, and the rule for reading an axis from a face normal.
 *
 * Shared by shape-fill's face-relative operations (#101), the cylinder axis, and orientation codes.
 *
 * The `input` layer can't depend on the `services` layer, so the axis concept used by both is placed in core.
 */

/** 0 = X / 1 = Y / 2 = Z */
export type Axis = 0 | 1 | 2;

/**
 * The face that was touched. Axis alone isn't enough — the **sign** is needed too (#101).
 *
 * The face's plane sits on a block boundary: if the normal is positive it lands in front of
 * the placement cell (`anchor[axis]`), if negative it lands behind it (`anchor[axis] + 1`).
 * Substituting the cell center (+0.5) shifts it by half a cell, and viewing from an angle
 * would push the in-plane coordinate toward the neighboring cell by that same amount.
 */
export interface FaceRef {
  axis: Axis;
  sign: 1 | -1;
}

/**
 * Reads the axis and sign from a face normal. The position of the non-zero component is the axis number as-is.
 *
 * If the normal can't be read, treat it as an upward-facing face — matching the default
 * behavior including ground clicks.
 */
export function faceOf(normal: readonly number[] | null | undefined): FaceRef {
  if (normal) {
    for (const axis of [0, 1, 2] as const) {
      const v = normal[axis];
      if (v !== undefined && v !== 0) return { axis, sign: v > 0 ? 1 : -1 };
    }
  }
  return { axis: 1, sign: 1 };
}

/** Where the face's plane lands in world coordinates (relative to the placement cell) */
export function facePlaneAt(anchor: readonly number[], face: FaceRef): number {
  const base = anchor[face.axis] ?? 0;
  return face.sign > 0 ? base : base + 1;
}
