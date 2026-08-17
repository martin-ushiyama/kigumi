import type { Cell } from '../core/cell';
import type { Axis } from '../core/axis';
import {
  bboxOfCorners,
  buildShape,
  slopeDirectionFromCorners,
  type ShapeKind,
  type ShapeLimits,
  type ShapeResult,
} from '../core/shapes';

/**
 * Determines the cells touched by a range operation (shape fill) (#64).
 *
 * Writing this as a conditional branch inside `controls.ts`'s DOM handler would bury
 * the contract somewhere untestable. This factors it out as a pure function, pinned
 * down by types and unit tests.
 *
 * It used to have a `mode` (overlay / place / erase), with a branch for Shift+click
 * range place / erase that bypassed shapes entirely, but that whole operation family
 * was removed in #103. The entry point for range operations is shape fill alone, always
 * generating from the currently selected shape.
 */
export type RangeFillInput = {
  /** The drag's start and end points (before normalization — order is needed to determine slope direction) */
  readonly anchor: Cell;
  readonly target: Cell;
  /** Currently selected shape */
  readonly shape: ShapeKind;
  /** Hollow flag (resolved) */
  readonly hollow: boolean;
  /** Cylinder axis */
  readonly axis: Axis;
  /** Slope step height */
  readonly step: number;
};

/**
 * The limit check happens at the entry point in `buildShape` (two tiers: scan volume /
 * generated cell count). Checking the bbox volume here first would reject cases like
 * hollow shapes, where the actual cell count is much smaller.
 */
export function resolveRangeCells(input: RangeFillInput, limits?: ShapeLimits): ShapeResult {
  const bbox = bboxOfCorners(input.anchor, input.target);
  return buildShape(
    input.shape,
    bbox,
    {
      hollow: input.hollow,
      axis: input.axis,
      step: input.step,
      slope: slopeDirectionFromCorners(input.anchor, input.target),
    },
    limits,
  );
}
