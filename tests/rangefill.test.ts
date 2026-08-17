import { describe, expect, it } from 'vitest';
import type { Cell } from '../src/core/cell';
import { OP_MAX_CELLS, SHAPE_MAX_SCAN_CELLS } from '../src/core/limits';
import { resolveRangeCells, type RangeFillInput } from '../src/editor/rangefill';

/**
 * The contract for which cells a range operation (shape fill) touches.
 *
 * There used to be a mode (overlay / place / erase) that pinned down "which operation
 * passes the shape through," but it was removed along with the Shift+click bulk
 * operation. What remains is the contract that "the selected shape/parameters are correctly
 * passed through to generation" plus the limits.
 */

const key = (c: Cell): string => `${c[0]},${c[1]},${c[2]}`;

/** A 3x3x3 range. The minimum size where hollow makes a difference (if any axis has thickness 1, every cell is on the shell) */
const CUBE: Pick<RangeFillInput, 'anchor' | 'target'> = { anchor: [0, 0, 0], target: [2, 2, 2] };

function cells(input: Partial<RangeFillInput>): Cell[] {
  const result = resolveRangeCells({
    ...CUBE,
    shape: 'box',
    hollow: false,
    axis: 1,
    step: 1,
    ...input,
  });
  if (!result.ok) throw new Error(`resolveRangeCells failed: ${result.reason}`);
  return result.cells;
}

describe('resolveRangeCells — generates using the selected shape', () => {
  it('the shape takes effect (a dome loses its corners)', () => {
    const dome = cells({ shape: 'dome', hollow: false });
    const box = cells({ shape: 'box', hollow: false });
    expect(dome.length).toBeLessThan(box.length);
    expect(box).toHaveLength(27);
  });

  it('reflects the hollow setting (for 3x3x3, the center is removed)', () => {
    const solid = cells({ shape: 'box', hollow: false });
    const hollow = cells({ shape: 'box', hollow: true });
    expect(solid).toHaveLength(27);
    expect(hollow).toHaveLength(26);
    expect(new Set(hollow.map(key)).has('1,1,1')).toBe(false);
  });
});

describe('resolveRangeCells — parameter passthrough', () => {
  it('the cylinder axis takes effect', () => {
    // for a cube, changing the axis just mirrors it with no visible difference, so use a flat 5x3x5 range instead
    const range = { shape: 'cylinder' as const, target: [4, 2, 4] as Cell };
    const y = new Set(cells({ ...range, axis: 1 }).map(key));
    const x = new Set(cells({ ...range, axis: 0 }).map(key));

    // for the Y axis, the cross-section is an X-Z circle -> (2,0,0) falls inside it
    expect(y.has('2,0,0')).toBe(true);
    // for the X axis, the cross-section is a Y-Z ellipse -> the same cell falls outside
    expect(x.has('2,0,0')).toBe(false);
    expect(y.size).not.toBe(x.size);
  });

  it('the slope step height takes effect', () => {
    const step1 = cells({ shape: 'slope', target: [3, 3, 0], step: 1 });
    const step2 = cells({ shape: 'slope', target: [3, 3, 0], step: 2 });
    expect(step2.length).toBeGreaterThan(step1.length); // taller steps fill in more
  });

  it('the slope direction flips with the drag direction (does not get erased by bbox normalization)', () => {
    const forward = cells({ shape: 'slope', anchor: [0, 0, 0], target: [4, 4, 0] });
    const backward = cells({ shape: 'slope', anchor: [4, 0, 0], target: [0, 4, 0] });
    const topAt = (list: Cell[], x: number): number => Math.max(...list.filter((c) => c[0] === x).map((c) => c[1]));
    expect(topAt(forward, 0)).toBe(0);
    expect(topAt(forward, 4)).toBe(4);
    expect(topAt(backward, 0)).toBe(4);
    expect(topAt(backward, 4)).toBe(0);
  });
});

describe('resolveRangeCells — limits', () => {
  it('the scan-volume limit takes effect', () => {
    const result = resolveRangeCells({
      anchor: [0, 0, 0],
      target: [199, 199, 199],
      shape: 'box',
      hollow: false,
      axis: 1,
      step: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('bboxTooLarge');
      expect(result.max).toBe(SHAPE_MAX_SCAN_CELLS);
    }
  });

  it('the generated cell-count limit is also propagated', () => {
    const result = resolveRangeCells({
      anchor: [0, 0, 0],
      target: [39, 39, 39],
      shape: 'box',
      hollow: false,
      axis: 1,
      step: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('tooManyCells');
      expect(result.count).toBe(64000);
      expect(result.max).toBe(OP_MAX_CELLS);
    }
  });

  it('a hollow shape still passes even if the bbox volume exceeds the limit (judged by actual cell count)', () => {
    const range = { anchor: [0, 0, 0] as Cell, target: [39, 39, 39] as Cell, axis: 1 as const, step: 1 };
    expect(resolveRangeCells({ ...range, shape: 'box', hollow: true }).ok).toBe(true);
  });
});
