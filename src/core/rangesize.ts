import type { Cell } from './cell';
import { OP_MAX_CELLS, SHAPE_MAX_SCAN_CELLS } from './limits';
import { bboxOfCorners, shapeFillsBbox, type ShapeKind } from './shapes';

/**
 * Dimensions shown during a range operation.
 *
 * Even with the preview solid visible, there's no way to tell how many blocks it covers
 * without counting. Shows X × Y × Z while dragging and while extruding.
 *
 * This calculation is pulled out here because `controls.ts` was duplicating the same
 * min/max logic in **two places — the preview update and the commit**. Adding the display
 * would have made it a third.
 */

/** Shape info needed to determine whether the dimensions exceed the limit */
export interface RangeShape {
  readonly kind: ShapeKind;
  readonly hollow: boolean;
}

export interface RangeSize {
  /** Block count, inclusive of both ends */
  readonly size: readonly [number, number, number];
  /** Volume of the bbox (not the actual cell count for hollow shapes) */
  readonly cells: number;
  /**
   * Will this **definitely** be rejected if committed?
   *
   * false when unknown. `buildShape`'s limit has two tiers: "bbox volume allowed to scan"
   * and "cell count allowed to generate" — the latter can be much smaller than the bbox
   * volume for hollow shapes. A side that only sees the bbox can only assert "over the
   * limit" for the scan limit, and for shapes that fill the bbox completely.
   */
  readonly certainlyRejected: boolean;
}

export function rangeSizeOf(anchor: Cell, target: Cell, shape: RangeShape): RangeSize {
  const { min, max } = bboxOfCorners(anchor, target);
  const size: [number, number, number] = [
    max[0] - min[0] + 1,
    max[1] - min[1] + 1,
    max[2] - min[2] + 1,
  ];
  const cells = size[0] * size[1] * size[2];
  // The scan limit always trips on bbox volume regardless of shape. The generation limit
  // can only be asserted up front for shapes where the generated cell count equals the bbox volume (shapeFillsBbox)
  const certainlyRejected =
    cells > SHAPE_MAX_SCAN_CELLS ||
    (shapeFillsBbox(shape.kind, shape.hollow) && cells > OP_MAX_CELLS);
  return { size, cells, certainlyRejected };
}

/**
 * String shown in the status bar.
 *
 * No units or axis names are attached — the three-number sequence being X / Y / Z is
 * obvious from the solid on screen, and adding labels would make it stand out more than
 * the other status bar items.
 *
 * `!` is only appended when "committing this as-is will be rejected". Attaching it to
 * operations that would go through would misleadingly suggest they can't be applied.
 */
export function formatRangeSize(range: RangeSize): string {
  const [x, y, z] = range.size;
  const body = `${x} × ${y} × ${z} = ${range.cells.toLocaleString('en-US')}`;
  return range.certainlyRejected ? `${body} !` : body;
}
