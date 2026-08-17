import { describe, expect, it } from 'vitest';
import { OP_MAX_CELLS, SHAPE_MAX_SCAN_CELLS } from '../src/core/limits';
import { rangeSizeOf, formatRangeSize, type RangeShape } from '../src/core/rangesize';

/**
 * The dimensions displayed during a range operation.
 *
 * bbox normalization lives in `bboxOfCorners`, so this only decides "how many blocks is
 * that." Computing it inline in `controls.ts` would mean writing the same min/max in 3
 * places (preview, commit, and display) — and it actually was duplicated in 2 of them.
 */

/** A solid cuboid = the only shape that fills the bbox without leaving anything out */
const SOLID_BOX: RangeShape = { kind: 'box', hollow: false };
const HOLLOW_BOX: RangeShape = { kind: 'box', hollow: true };
const SOLID_SPHERE: RangeShape = { kind: 'sphere', hollow: false };

describe('rangeSizeOf — derives X × Y × Z from 2 points', () => {
  it('the same cell yields 1 × 1 × 1', () => {
    const r = rangeSizeOf([3, 4, 5], [3, 4, 5], SOLID_BOX);
    expect(r.size).toEqual([1, 1, 1]);
    expect(r.cells).toBe(1);
  });

  it('counts inclusively on both ends (5 to 7 is 3 blocks)', () => {
    const r = rangeSizeOf([5, 0, 0], [7, 0, 0], SOLID_BOX);
    expect(r.size).toEqual([3, 1, 1]);
  });

  it('is the same regardless of which direction it was drawn (bbox is normalized)', () => {
    expect(rangeSizeOf([7, 2, 9], [5, 0, 4], SOLID_BOX)).toEqual(
      rangeSizeOf([5, 0, 4], [7, 2, 9], SOLID_BOX),
    );
  });

  it('still counts inclusively on both ends when crossing negative coordinates', () => {
    const r = rangeSizeOf([-2, 0, 0], [2, 0, 0], SOLID_BOX);
    expect(r.size).toEqual([5, 1, 1]);
  });

  it('the cell count is the product of the 3 side lengths', () => {
    const r = rangeSizeOf([0, 0, 0], [4, 2, 4], SOLID_BOX);
    expect(r.size).toEqual([5, 3, 5]);
    expect(r.cells).toBe(75);
  });
});

describe('rangeSizeOf — only flags rejection when it can be asserted for certain', () => {
  it('for a shape that fills the bbox, the generation limit can be asserted from the bbox volume', () => {
    // OP_MAX_CELLS = 32768 = 32^3, so exactly 32^3 passes and a 33-cube side exceeds it
    expect(rangeSizeOf([0, 0, 0], [31, 31, 31], SOLID_BOX).cells).toBe(OP_MAX_CELLS);
    expect(rangeSizeOf([0, 0, 0], [31, 31, 31], SOLID_BOX).certainlyRejected).toBe(false);
    expect(rangeSizeOf([0, 0, 0], [32, 31, 31], SOLID_BOX).certainlyRejected).toBe(true);
  });

  it('for a shape that does not fill the bbox, the same bbox does not warrant an assertion (actual cell count is smaller)', () => {
    // hollow / sphere / etc. only build a shell or inscribed shape, so they can still pass even if the bbox exceeds the generation limit
    expect(rangeSizeOf([0, 0, 0], [32, 31, 31], HOLLOW_BOX).certainlyRejected).toBe(false);
    expect(rangeSizeOf([0, 0, 0], [32, 31, 31], SOLID_SPHERE).certainlyRejected).toBe(false);
  });

  it('the scan limit can be asserted regardless of shape (the bbox volume itself is the ceiling)', () => {
    // SHAPE_MAX_SCAN_CELLS = 2^21 = 128^3. A 129-cube side fails before scanning for any shape
    const under = rangeSizeOf([0, 0, 0], [127, 127, 127], HOLLOW_BOX);
    expect(under.cells).toBe(SHAPE_MAX_SCAN_CELLS);
    expect(under.certainlyRejected).toBe(false);
    expect(rangeSizeOf([0, 0, 0], [128, 127, 127], HOLLOW_BOX).certainlyRejected).toBe(true);
    expect(rangeSizeOf([0, 0, 0], [128, 127, 127], SOLID_SPHERE).certainlyRejected).toBe(true);
  });
});

describe('formatRangeSize — the display string', () => {
  it('outputs the 3 side lengths and the cell count', () => {
    expect(formatRangeSize(rangeSizeOf([0, 0, 0], [4, 2, 4], SOLID_BOX))).toBe('5 × 3 × 5 = 75');
  });

  it('does not abbreviate even for 1 × 1 × 1 (never called when nothing is being operated on)', () => {
    expect(formatRangeSize(rangeSizeOf([0, 0, 0], [0, 0, 0], SOLID_BOX))).toBe('1 × 1 × 1 = 1');
  });

  it('adds thousands separators for large numbers', () => {
    const r = rangeSizeOf([0, 0, 0], [19, 19, 19], SOLID_BOX);
    expect(formatRangeSize(r)).toBe('20 × 20 × 20 = 8,000');
  });

  it('only marks it when rejection is known for certain', () => {
    const rejected = rangeSizeOf([0, 0, 0], [32, 31, 31], SOLID_BOX);
    expect(formatRangeSize(rejected)).toContain('!');
    // even with the same bbox, a hollow shape could still pass, so no mark is shown
    const unknown = rangeSizeOf([0, 0, 0], [32, 31, 31], HOLLOW_BOX);
    expect(formatRangeSize(unknown)).not.toContain('!');
  });
});
