import type { Cell } from './types';
import {
  decodeOrientation,
  encodeOrientation,
  isVoidCell,
  packCell,
  rotateWeirdoDirection,
  stairsFacingXZ,
  unpackCell,
  xzToWeirdoDirection,
  type Shape,
} from './orientation';

/**
 * Coordinate transform for a group (rotation in 90-degree Y-axis steps + translation).
 *
 * Rotation is done in doubled coordinates (cell center = 2*cell+1, always odd), so a
 * half-cell-centered pivot can be represented as an exact integer. The rotation direction is
 * fixed to match Three.js's +Y rotation: step 1 = (x,z) → (z,-x). Since the meaning of
 * angleSteps is baked into the v3 persistence format, this mapping is never changed once
 * implemented (settled ahead of time in the design review).
 *
 * Stair orientation follows this same rotation, but **weirdo_direction must never be added
 * to or subtracted from** — its value is a label, not a rotation amount (0=east / 1=west /
 * 2=south / 3=north). The one and only place that rotates it is
 * `orientation.ts::rotateWeirdoDirection`.
 */

export type AngleSteps = 0 | 1 | 2 | 3;

/** A group's own transform (relative to its parent group's coordinate system). All fields readonly; internal storage must always be a deep copy */
export interface GroupTransform {
  readonly angleSteps: AngleSteps;
  /** Integer cell offset added after rotation */
  readonly translate: Cell;
  /** Doubled x/z coordinates of the rotation pivot (relative to the group's local origin). x and z parity must match (mixing them falls off the grid under a 90-degree rotation) */
  readonly pivot2: readonly [number, number];
}

export const IDENTITY_TRANSFORM: GroupTransform = Object.freeze({
  angleSteps: 0,
  translate: Object.freeze([0, 0, 0] as const),
  pivot2: Object.freeze([0, 0] as const),
});

/**
 * The discrete affine local→world transform obtained by folding down the ancestor chain.
 * Composing rotations around different pivots can always be normalized back into this same
 * form (R(angleSteps)·center2 + offset). A comparable, cacheable, invertible value type
 * (deliberately not a closure, per the design review).
 */
export interface ResolvedTransform {
  readonly angleSteps: AngleSteps;
  /** x/z offset in doubled coordinates (pivot already folded in) */
  readonly offsetXZ2: readonly [number, number];
  readonly offsetY: number;
}

export const IDENTITY_RESOLVED: ResolvedTransform = Object.freeze({
  angleSteps: 0,
  offsetXZ2: Object.freeze([0, 0] as const),
  offsetY: 0,
});

/** step 1 = (x,z)→(z,-x). Same rotation direction as the existing renderer's +Y rotation (weirdoDirectionToYRotation) */
function rotateXZ(x: number, z: number, steps: AngleSteps): [number, number] {
  switch (steps) {
    case 0:
      return [x, z];
    case 1:
      return [z, -x];
    case 2:
      return [-x, -z];
    case 3:
      return [-z, x];
  }
}

function sameParity(a: number, b: number): boolean {
  // Don't subtract: even if a and b are each individually safe integers, their difference could exceed the safe range
  return Math.abs(a % 2) === Math.abs(b % 2);
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} is not a safe integer: ${value}`);
  }
}

/** Validates the invariants of a GroupTransform (shared implementation for SceneTree.setTransform and the v3 validator) */
export function assertValidGroupTransform(t: GroupTransform): void {
  if (t.angleSteps !== 0 && t.angleSteps !== 1 && t.angleSteps !== 2 && t.angleSteps !== 3) {
    throw new Error(`angleSteps is out of the 0-3 range: ${String(t.angleSteps)}`);
  }
  assertSafeInteger(t.translate[0], 'translate.x');
  assertSafeInteger(t.translate[1], 'translate.y');
  assertSafeInteger(t.translate[2], 'translate.z');
  assertSafeInteger(t.pivot2[0], 'pivot2.x');
  assertSafeInteger(t.pivot2[1], 'pivot2.z');
  if (!sameParity(t.pivot2[0], t.pivot2[1])) {
    throw new Error(`pivot2's x/z parity doesn't match: [${t.pivot2[0]}, ${t.pivot2[1]}] (falls off the grid under a 90-degree rotation)`);
  }
}

export function cloneTransform(t: GroupTransform): GroupTransform {
  return {
    angleSteps: t.angleSteps,
    translate: [t.translate[0], t.translate[1], t.translate[2]],
    pivot2: [t.pivot2[0], t.pivot2[1]],
  };
}

/**
 * Composes a single node's transform onto the outside of an already-resolved transform
 * (folded down from its children). Since world = T_parent(T_child(local)), we walk the chain
 * node→root, multiplying the outer (parent) side in from the left each time:
 *   R_total = R_outer · R_inner
 *   offset_total = R_outer · offset_inner + offset_outer
 * offset_outer = pivot2 - R·pivot2 + 2*translate (doubled coordinates).
 */
export function composeTransform(outer: GroupTransform, inner: ResolvedTransform): ResolvedTransform {
  const steps = outer.angleSteps;
  const [px, pz] = outer.pivot2;
  const [rpx, rpz] = rotateXZ(px, pz, steps);
  const outerOffsetX = px - rpx + 2 * outer.translate[0];
  const outerOffsetZ = pz - rpz + 2 * outer.translate[2];
  const [rox, roz] = rotateXZ(inner.offsetXZ2[0], inner.offsetXZ2[1], steps);
  const offsetX = rox + outerOffsetX;
  const offsetZ = roz + outerOffsetZ;
  assertSafeInteger(offsetX, 'offsetXZ2.x after composition');
  assertSafeInteger(offsetZ, 'offsetXZ2.z after composition');
  const offsetY = inner.offsetY + outer.translate[1];
  assertSafeInteger(offsetY, 'offsetY after composition');
  return {
    angleSteps: ((steps + inner.angleSteps) % 4) as AngleSteps,
    offsetXZ2: [offsetX, offsetZ],
    offsetY,
  };
}

/**
 * Composes two already-resolved transforms together (world = outer(inner(local))).
 * Where `composeTransform` "multiplies a single node's GroupTransform onto the outside of a
 * resolved transform", this multiplies two resolved transforms together (used for
 * recomputing when the parent chain is reassigned B1b).
 */
export function composeResolved(outer: ResolvedTransform, inner: ResolvedTransform): ResolvedTransform {
  const [rx, rz] = rotateXZ(inner.offsetXZ2[0], inner.offsetXZ2[1], outer.angleSteps);
  const offsetX = rx + outer.offsetXZ2[0];
  const offsetZ = rz + outer.offsetXZ2[1];
  const offsetY = inner.offsetY + outer.offsetY;
  assertSafeInteger(offsetX, 'offsetXZ2.x after composition');
  assertSafeInteger(offsetZ, 'offsetXZ2.z after composition');
  assertSafeInteger(offsetY, 'offsetY after composition');
  return {
    angleSteps: ((outer.angleSteps + inner.angleSteps) % 4) as AngleSteps,
    offsetXZ2: [offsetX, offsetZ],
    offsetY,
  };
}

/**
 * Whether two resolved transforms are equal. Used when reassigning a parent, to
 * check "did the parent chain's effective transform actually change?" — if it didn't, the
 * child's transform doesn't need to be rebased (so we don't push a wasted `setGroupTransform`
 * op onto the history).
 */
export function resolvedEquals(a: ResolvedTransform, b: ResolvedTransform): boolean {
  return (
    a.angleSteps === b.angleSteps &&
    a.offsetXZ2[0] === b.offsetXZ2[0] &&
    a.offsetXZ2[1] === b.offsetXZ2[1] &&
    a.offsetY === b.offsetY
  );
}

/** The inverse transform such that `composeResolved(inverseResolved(r), r)` is the identity */
export function inverseResolved(r: ResolvedTransform): ResolvedTransform {
  const inverseSteps = ((4 - r.angleSteps) % 4) as AngleSteps;
  const [rx, rz] = rotateXZ(r.offsetXZ2[0], r.offsetXZ2[1], inverseSteps);
  return { angleSteps: inverseSteps, offsetXZ2: [-rx, -rz], offsetY: -r.offsetY };
}

/**
 * Finds the local transform that keeps the world-space appearance unchanged when the parent
 * chain is reassigned. Used by reparent (moving to a different parent) and by
 * ungroup's handling of child groups.
 *
 * Rewrites `world = oldParent ∘ child(local)` as `world = newParent ∘ child'(local)`:
 *   `child' = newParent⁻¹ ∘ oldParent ∘ child`
 *
 * **pivot2 keeps its original value** — if reparenting reset the pivot to the origin, the
 * group would jump the next time it's rotated after the move ("pivot doesn't move on content
 * or parent changes" is a contract, rev.2 blocker 5). As long as pivot2's x/z parity match,
 * translate is guaranteed to come out as an integer.
 */
export function rebaseTransform(
  child: GroupTransform,
  oldParentChain: ResolvedTransform,
  newParentChain: ResolvedTransform,
): GroupTransform {
  assertValidGroupTransform(child);
  const resolvedChild = composeTransform(child, IDENTITY_RESOLVED);
  const target = composeResolved(inverseResolved(newParentChain), composeResolved(oldParentChain, resolvedChild));

  // Solve for translate from offset = pivot2 - R(angleSteps)·pivot2 + 2·translate
  const [px, pz] = child.pivot2;
  const [rpx, rpz] = rotateXZ(px, pz, target.angleSteps);
  const doubledX = target.offsetXZ2[0] - px + rpx;
  const doubledZ = target.offsetXZ2[1] - pz + rpz;
  if (doubledX % 2 !== 0 || doubledZ % 2 !== 0) {
    throw new Error(`rebaseTransform: translate doesn't come out as an integer (doubled=(${doubledX}, ${doubledZ})) — possible pivot2 parity mismatch`);
  }
  return {
    angleSteps: target.angleSteps,
    translate: [doubledX / 2, target.offsetY, doubledZ / 2],
    pivot2: [px, pz],
  };
}

/**
 * Maps a **delta vector** in world coordinates to a delta vector in owner-local coordinates
 *.
 *
 * The inverse transform for a point (`applyInverseTransform`) subtracts an offset, but only
 * the rotation component matters for a delta (`R(a) - R(b) = R(a-b)`). There's also no need
 * to route through doubled coordinates — a delta's doubled value is always even, so applying
 * `rotateXZ` directly to the integer components gives the same result.
 *
 * Deltas produced by nudge / drag / inspector are in world coordinates, so this must always
 * be applied before physically moving something within an owner or adding to
 * `GroupTransform.translate` (which is in the parent's coordinate system).
 */
export function rotateDeltaToLocal(delta: Cell, r: ResolvedTransform): Cell {
  const inverseSteps = ((4 - r.angleSteps) % 4) as AngleSteps;
  const [dx, dz] = rotateXZ(delta[0], delta[2], inverseSteps);
  return [dx, delta[1], dz];
}

/** The inverse of `rotateDeltaToLocal` (owner-local delta vector → world delta vector) */
export function rotateDeltaToWorld(delta: Cell, r: ResolvedTransform): Cell {
  const [dx, dz] = rotateXZ(delta[0], delta[2], r.angleSteps);
  return [dx, delta[1], dz];
}

/** Maps a local cell to a world cell. Throws if the result falls off the integer grid (defensive runtime check) */
export function applyTransform(local: Cell, r: ResolvedTransform): Cell {
  const center2x = 2 * local[0] + 1;
  const center2z = 2 * local[2] + 1;
  const [rx, rz] = rotateXZ(center2x, center2z, r.angleSteps);
  const wx2 = rx + r.offsetXZ2[0];
  const wz2 = rz + r.offsetXZ2[1];
  if (Math.abs((wx2 - 1) % 2) !== 0 || Math.abs((wz2 - 1) % 2) !== 0) {
    throw new Error(`transform result doesn't land on an integer cell: doubled=(${wx2}, ${wz2}) — possible pivot2 parity mismatch`);
  }
  const wy = local[1] + r.offsetY;
  assertSafeInteger(wx2, 'x2 after transform');
  assertSafeInteger(wz2, 'z2 after transform');
  assertSafeInteger(wy, 'y after transform');
  return [(wx2 - 1) / 2, wy, (wz2 - 1) / 2];
}

/** Inverse-transforms a world cell to a local cell. Round-trips exactly with applyTransform */
export function applyInverseTransform(world: Cell, r: ResolvedTransform): Cell {
  const wc2x = 2 * world[0] + 1;
  const wc2z = 2 * world[2] + 1;
  const cx2 = wc2x - r.offsetXZ2[0];
  const cz2 = wc2z - r.offsetXZ2[1];
  const inverseSteps = ((4 - r.angleSteps) % 4) as AngleSteps;
  const [lx2, lz2] = rotateXZ(cx2, cz2, inverseSteps);
  if (Math.abs((lx2 - 1) % 2) !== 0 || Math.abs((lz2 - 1) % 2) !== 0) {
    throw new Error(`inverse transform result doesn't land on an integer cell: doubled=(${lx2}, ${lz2})`);
  }
  const ly = world[1] - r.offsetY;
  assertSafeInteger(lx2, 'x2 after inverse transform');
  assertSafeInteger(lz2, 'z2 after inverse transform');
  assertSafeInteger(ly, 'y after inverse transform');
  return [(lx2 - 1) / 2, ly, (lz2 - 1) / 2];
}

/**
 * Computes the rotation pivot for a group's local bounds.
 * min+max+1 = the geometric center of the closed interval [min,max] in doubled coordinates
 * (always an integer regardless of sign). When x/z parity matches (odd/odd = both odd-width,
 * even/even = both even-width), the true center is kept as-is. Only for mixed parity (e.g.
 * 2×3) is the even side shifted by 1 toward min to line them up (the tie-break is by design:
 * an even-width axis's pivot leans toward the lower-index cell's center).
 */
export function computePivot2(bounds: { minX: number; maxX: number; minZ: number; maxZ: number }): readonly [number, number] {
  const rawX = bounds.minX + bounds.maxX + 1;
  const rawZ = bounds.minZ + bounds.maxZ + 1;
  if (sameParity(rawX, rawZ)) return [rawX, rawZ];
  return Math.abs(rawX % 2) === 0 ? [rawX - 1, rawZ] : [rawX, rawZ - 1];
}

/**
 * Rotates a cell value's orientation (packCell'd raw) by angleSteps around Y.
 * Throws if shapeOf returns undefined (an unknown catalogIndex not in the catalog) —
 * never silently produce a wrong raw.
 */
export function rotateRaw(raw: number, steps: AngleSteps, shapeOf: (catalogIndex: number) => Shape | undefined): number {
  // Void cells have no orientation, so they're unaffected by rotation. **This check
  // returns before the shapeOf check** — void isn't a real catalog entry, so shapeOf would
  // always return undefined for it, which would get caught by the "unknown throws" check
  // below first and make it impossible to build the projection at all.
  // Unknown catalogIndex values other than void still throw as before (broken data is never let through silently)
  if (isVoidCell(raw)) return raw;
  const { catalogIndex, code } = unpackCell(raw);
  // Check that the catalog entry exists even when steps=0 — an early return here would let
  // an unknown catalog slip silently into the projection whenever the transform happens to
  // be identity, making the "unknown throws" contract only apply while actually rotating
  //
  const shape = shapeOf(catalogIndex);
  if (shape === undefined) {
    throw new Error(`rotateRaw: unknown catalogIndex ${catalogIndex} (shapeOf returned undefined)`);
  }
  if (steps === 0) return raw;
  const o = decodeOrientation(shape, code);
  if (o.shape === 'stairs') {
    // **weirdo_direction is a label, not a rotation amount** (0=east / 1=west / 2=south /
    // 3=north). Advancing it with `+steps` would produce 180-degree jumps like east→west.
    // The one place that rotates it is orientation.ts (the T-key orientation cycle goes
    // through the same code path)
    const next = rotateWeirdoDirection(o.weirdoDirection, steps);
    return packCell(catalogIndex, encodeOrientation({ ...o, weirdoDirection: next }));
  }
  if (o.shape === 'full' && o.axis !== 'y' && steps % 2 === 1) {
    return packCell(catalogIndex, encodeOrientation({ shape: 'full', axis: o.axis === 'x' ? 'z' : 'x' }));
  }
  return raw; // slab / full(axis=y) / full with an even step count are all unaffected
}

/** Mirror axis (only that axis's coordinate is sign-flipped = a mirror across the plane perpendicular to that axis) */
export type MirrorAxis = 'x' | 'y' | 'z';

/**
 * Mirrors a cell value's orientation (packCell'd raw) across a world axis. The raw
 * transform counterpart to `rotateRaw`.
 *
 * Mirroring is a determinant −1 transform, so it can't be represented by `GroupTransform`
 * (90-degree Y rotation + translation). Because of that, `buildMirror` is implemented as a
 * destructive op that physically replaces each cell, converting each cell's orientation
 * through this function as it goes.
 *
 * - **Stairs (horizontal mirror)**: flip the sign of the relevant component of the facing
 *   vector, then map back to d
 * - **Stairs (Y mirror)**: facing is unchanged, `upside_down_bit` flips
 * - **Slab**: unchanged under a horizontal mirror, top/bottom swap under a Y mirror
 * - **full (pillar_axis)**: the axis has no sign, so it's unaffected by any mirror
 *
 * If shapeOf returns undefined, this throws under the same contract as `rotateRaw`.
 */
export function mirrorRaw(raw: number, axis: MirrorAxis, shapeOf: (catalogIndex: number) => Shape | undefined): number {
  // Void cells have no orientation, so they're unaffected by mirroring too. Same
  // reasoning as rotateRaw — this check returns before the shapeOf check. Unknown
  // catalogIndex values other than void still throw as before.
  if (isVoidCell(raw)) return raw;
  const { catalogIndex, code } = unpackCell(raw);
  const shape = shapeOf(catalogIndex);
  if (shape === undefined) {
    throw new Error(`mirrorRaw: unknown catalogIndex ${catalogIndex} (shapeOf returned undefined)`);
  }
  const o = decodeOrientation(shape, code);
  if (o.shape === 'stairs') {
    if (axis === 'y') return packCell(catalogIndex, encodeOrientation({ ...o, upsideDown: !o.upsideDown }));
    const [dx, dz] = stairsFacingXZ(o.weirdoDirection);
    const next = axis === 'x' ? xzToWeirdoDirection(-dx, dz) : xzToWeirdoDirection(dx, -dz);
    return packCell(catalogIndex, encodeOrientation({ ...o, weirdoDirection: next }));
  }
  if (o.shape === 'slab' && axis === 'y') {
    return packCell(catalogIndex, encodeOrientation({ ...o, half: o.half === 'top' ? 'bottom' : 'top' }));
  }
  return raw; // slab (horizontal mirror) / full are unaffected
}
