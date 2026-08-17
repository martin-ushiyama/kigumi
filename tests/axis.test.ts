import { describe, expect, it } from 'vitest';
import { facePlaneAt, faceOf } from '../src/core/axis';

/**
 * Face normal -> axis and sign (#101).
 *
 * Shape fill works on a "the touched face is the reference" basis, so this decides both how
 * the plane is taken and which direction to extrude. **The sign is needed** because the
 * face's plane sits on the block boundary — the axis alone doesn't determine which side of
 * the boundary, so we project onto a plane offset by half a cell to grab the neighboring cell.
 */
describe('faceOf', () => {
  it('top/bottom faces are Y. Sign preserves direction', () => {
    expect(faceOf([0, 1, 0])).toEqual({ axis: 1, sign: 1 });
    expect(faceOf([0, -1, 0])).toEqual({ axis: 1, sign: -1 });
  });

  it('X-facing side faces are X', () => {
    expect(faceOf([1, 0, 0])).toEqual({ axis: 0, sign: 1 });
    expect(faceOf([-1, 0, 0])).toEqual({ axis: 0, sign: -1 });
  });

  it('Z-facing side faces are Z', () => {
    expect(faceOf([0, 0, 1])).toEqual({ axis: 2, sign: 1 });
    expect(faceOf([0, 0, -1])).toEqual({ axis: 2, sign: -1 });
  });

  it('when the normal is missing / unreadable, treat it as an upward-facing face (same as clicking the ground)', () => {
    expect(faceOf(null)).toEqual({ axis: 1, sign: 1 });
    expect(faceOf(undefined)).toEqual({ axis: 1, sign: 1 });
    expect(faceOf([0, 0, 0])).toEqual({ axis: 1, sign: 1 });
  });
});

describe('facePlaneAt — the face plane sits on the block boundary', () => {
  it('a positive normal means the near side of the placement cell (y=0 for a ground click)', () => {
    expect(facePlaneAt([3, 0, 4], { axis: 1, sign: 1 })).toBe(0);
    expect(facePlaneAt([5, 2, 1], { axis: 0, sign: 1 })).toBe(5);
  });

  it('a negative normal means the far side of the placement cell (+1)', () => {
    // e.g. touching the -X face of the block at x=4 places at x=3, boundary at x=4
    expect(facePlaneAt([3, 2, 1], { axis: 0, sign: -1 })).toBe(4);
    expect(facePlaneAt([0, 5, 0], { axis: 1, sign: -1 })).toBe(6);
  });

  it('never lands on the cell center (+0.5) — a half-cell offset would push in-plane coordinates toward the neighboring cell', () => {
    expect(facePlaneAt([2, 0, 2], { axis: 1, sign: 1 })).not.toBe(0.5);
  });
});
