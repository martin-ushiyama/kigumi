import { describe, expect, it } from 'vitest';
import type { ComponentTemplate } from '../src/core/component';
import { layoutComponentThumb, THUMB_CELL_HEIGHT, THUMB_CELL_WIDTH } from '../src/core/componentthumb';
import { packCell } from '../src/core/orientation';
import { makeCellKey } from '../src/core/types';

/**
 * Thumbnail layout for lists (#69 Step 3).
 *
 * The key point here is **not taking a screenshot of the screen**. If the picture changes
 * with camera, selection, or lighting, the same shape looks different in the list every
 * time. If we build it from the cells at a fixed angle, the same shape always produces the
 * same picture.
 */

const RAW = packCell(0, 0);
const OTHER = packCell(1, 0);

const template = (cells: [number, number, number, number][]): ComponentTemplate => ({
  id: 'c1',
  name: 'Thumbnail',
  nodes: [{ name: 'Root', parent: null }],
  cells: cells.map(([x, y, z, raw]) => [0, makeCellKey(x, y, z), raw]),
  patterns: [],
});

describe('component thumbnail', () => {
  it('empty with no cells (caller can render "no image")', () => {
    const layout = layoutComponentThumb(template([]));
    expect(layout).toEqual({ cells: [], width: 0, height: 0 });
  });

  it('1 cell means the width/height of 1 cell', () => {
    const layout = layoutComponentThumb(template([[0, 0, 0, RAW]]));
    expect(layout.cells).toEqual([{ x: 0, y: 0, raw: RAW }]);
    expect(layout.width).toBe(THUMB_CELL_WIDTH);
    expect(layout.height).toBe(THUMB_CELL_HEIGHT * 2);
  });

  it('increasing x moves down-right, increasing z moves down-left', () => {
    const layout = layoutComponentThumb(
      template([
        [0, 0, 0, RAW],
        [1, 0, 0, OTHER],
      ]),
    );
    const [origin, plusX] = [layout.cells[0]!, layout.cells[1]!];
    expect(plusX.x, 'shifts right').toBeGreaterThan(origin.x);
    expect(plusX.y, 'shifts down').toBeGreaterThan(origin.y);

    const zLayout = layoutComponentThumb(
      template([
        [0, 0, 0, RAW],
        [0, 0, 1, OTHER],
      ]),
    );
    // re-anchored to the top-left, so the +Z cell ends up at the left edge (x=0) and the origin is to the right
    const zPlus = zLayout.cells.find((cell) => cell.raw === OTHER)!;
    const zOrigin = zLayout.cells.find((cell) => cell.raw === RAW)!;
    expect(zPlus.x, 'shifts left').toBeLessThan(zOrigin.x);
    expect(zPlus.y, 'shifts down').toBeGreaterThan(zOrigin.y);
  });

  it('increasing y moves up', () => {
    const layout = layoutComponentThumb(
      template([
        [0, 0, 0, RAW],
        [0, 1, 0, OTHER],
      ]),
    );
    const lower = layout.cells.find((cell) => cell.raw === RAW)!;
    const upper = layout.cells.find((cell) => cell.raw === OTHER)!;
    expect(upper.y).toBeLessThan(lower.y);
    expect(upper.x, 'directly above, so no horizontal shift').toBeCloseTo(lower.x, 10);
  });

  /** Painting in the order returned keeps front/back correct = the caller never has to judge depth */
  it('back cells come first, front cells come after', () => {
    const layout = layoutComponentThumb(
      template([
        [1, 0, 1, OTHER], // front
        [0, 0, 0, RAW], // back
      ]),
    );
    expect(layout.cells.map((cell) => cell.raw)).toEqual([RAW, OTHER]);
  });

  it('when cells overlap at the same height, the lower cell is painted after', () => {
    const layout = layoutComponentThumb(
      template([
        [0, 1, 0, OTHER], // above
        [0, 0, 0, RAW], // below (appears in front)
      ]),
    );
    expect(layout.cells.map((cell) => cell.raw)).toEqual([OTHER, RAW]);
  });

  it('anchors the top-left to the origin (so the caller can add its own margin)', () => {
    const layout = layoutComponentThumb(
      template([
        [5, 2, 5, RAW],
        [7, 0, 6, OTHER],
      ]),
    );
    expect(Math.min(...layout.cells.map((cell) => cell.x))).toBe(0);
    expect(Math.min(...layout.cells.map((cell) => cell.y))).toBe(0);
  });

  it('the same shape produces the same picture (independent of placement)', () => {
    const shape: [number, number, number, number][] = [
      [0, 0, 0, RAW],
      [0, 1, 0, RAW],
      [1, 0, 0, OTHER],
    ];
    const shifted = shape.map(([x, y, z, raw]) => [x + 10, y, z + 4, raw] as [number, number, number, number]);
    expect(layoutComponentThumb(template(shifted))).toEqual(layoutComponentThumb(template(shape)));
  });

  it('the width/height is sized to fit every cell', () => {
    const layout = layoutComponentThumb(
      template([
        [0, 0, 0, RAW],
        [3, 2, 1, OTHER],
      ]),
    );
    for (const cell of layout.cells) {
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.x + THUMB_CELL_WIDTH).toBeLessThanOrEqual(layout.width + 1e-9);
      expect(cell.y).toBeGreaterThanOrEqual(0);
      expect(cell.y + THUMB_CELL_HEIGHT * 2).toBeLessThanOrEqual(layout.height + 1e-9);
    }
  });
});
