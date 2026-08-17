import { describe, expect, it } from 'vitest';
import type { Cell } from '../src/core/cell';
import { COORD_LIMIT, OP_MAX_CELLS, SHAPE_MAX_SCAN_CELLS } from '../src/core/limits';
import {
  bboxOfCorners,
  buildShape,
  defaultHollow,
  shapeFillsBbox,
  slopeDirectionFromCorners,
  type Bbox,
  type ShapeKind,
  type ShapeLimits,
  type ShapeParams,
} from '../src/core/shapes';

const key = (c: Cell): string => `${c[0]},${c[1]},${c[2]}`;

/** Extracts cells assuming ok (fails the test if the build failed) */
function cellsOf(kind: ShapeKind, bbox: Bbox, params: ShapeParams = {}, limits?: ShapeLimits): Cell[] {
  const result = buildShape(kind, bbox, params, limits);
  if (!result.ok) throw new Error(`buildShape(${kind}) failed: ${result.reason} ${result.count}/${result.max}`);
  return result.cells;
}

const setOf = (cells: Cell[]): Set<string> => new Set(cells.map(key));

/** A bbox starting at the origin (given a size) */
function box(sx: number, sy: number, sz: number, origin: Cell = [0, 0, 0]): Bbox {
  return {
    min: origin,
    max: [origin[0] + sx - 1, origin[1] + sy - 1, origin[2] + sz - 1],
  };
}

/** Cell count per y layer */
function countByY(cells: Cell[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const [, y] of cells) m.set(y, (m.get(y) ?? 0) + 1);
  return m;
}

/** Topmost y at each position along the run axis */
function topByRun(cells: Cell[], runAxis: 0 | 2): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of cells) {
    const at = c[runAxis];
    m.set(at, Math.max(m.get(at) ?? -Infinity, c[1]));
  }
  return m;
}

const KINDS: ShapeKind[] = ['box', 'sphere', 'cylinder', 'dome', 'slope'];

describe('buildShape — shared guarantees', () => {
  it('no shape ever spills outside the bbox', () => {
    const b = box(7, 5, 9, [-3, 2, -4]);
    for (const kind of KINDS) {
      for (const [x, y, z] of cellsOf(kind, b)) {
        expect(x).toBeGreaterThanOrEqual(b.min[0]);
        expect(x).toBeLessThanOrEqual(b.max[0]);
        expect(y).toBeGreaterThanOrEqual(b.min[1]);
        expect(y).toBeLessThanOrEqual(b.max[1]);
        expect(z).toBeGreaterThanOrEqual(b.min[2]);
        expect(z).toBeLessThanOrEqual(b.max[2]);
      }
    }
  });

  it('order is fixed ascending x → y → z (same order as the existing box fill)', () => {
    for (const kind of KINDS) {
      const cells = cellsOf(kind, box(5, 5, 5), { hollow: false });
      for (let i = 1; i < cells.length; i++) {
        const a = cells[i - 1]!;
        const c = cells[i]!;
        const cmp = a[0] !== c[0] ? a[0] - c[0] : a[1] !== c[1] ? a[1] - c[1] : a[2] - c[2];
        expect(cmp).toBeLessThan(0);
      }
    }
  });

  it('never returns duplicate cells', () => {
    for (const kind of KINDS) {
      for (const hollow of [true, false]) {
        const cells = cellsOf(kind, box(6, 6, 6), { hollow });
        expect(setOf(cells).size).toBe(cells.length);
      }
    }
  });

  it('1x1x1 is exactly 1 cell for every shape (does not vanish from a divide-by-zero)', () => {
    for (const kind of KINDS) {
      for (const hollow of [true, false]) {
        expect(cellsOf(kind, box(1, 1, 1), { hollow })).toEqual([[0, 0, 0]]);
      }
    }
  });

  it('the hollow default is true only for dome (roof use case)', () => {
    expect(defaultHollow('dome')).toBe(true);
    for (const kind of ['box', 'sphere', 'cylinder', 'slope'] as ShapeKind[]) {
      expect(defaultHollow(kind)).toBe(false);
    }
  });

  it('a flat bbox (a wall of thickness 1) is never empty', () => {
    for (const kind of KINDS) {
      expect(cellsOf(kind, box(5, 5, 1)).length).toBeGreaterThan(0);
      expect(cellsOf(kind, box(5, 1, 5)).length).toBeGreaterThan(0);
      expect(cellsOf(kind, box(1, 5, 5)).length).toBeGreaterThan(0);
    }
  });
});

/**
 * A limit doesn't work if "the caller judges from the result length".
 * The browser would freeze mid synchronous scan before the check is ever reached, so we bail at the entry point.
 */
describe('buildShape — limits (scan volume and cell count are tracked separately)', () => {
  it('when the bbox volume exceeds the scan limit, it fails without scanning', () => {
    const huge = box(200, 200, 200); // 8 million cells > SHAPE_MAX_SCAN_CELLS (2^21)
    for (const kind of KINDS) {
      const result = buildShape(kind, huge);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('bboxTooLarge');
      expect(result.count).toBe(200 * 200 * 200);
      expect(result.max).toBe(SHAPE_MAX_SCAN_CELLS);
    }
  });

  it('a bbox that fills the coordinate limit fails immediately (no synchronous freeze)', () => {
    const full: Bbox = {
      min: [-COORD_LIMIT, 0, -COORD_LIMIT],
      max: [COORD_LIMIT, COORD_LIMIT, COORD_LIMIT],
    };
    const started = Date.now();
    const result = buildShape('dome', full);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bboxTooLarge');
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('a flat bbox is also judged by volume (fails on total size even at height 2)', () => {
    // 1025 x 2 x 1025 = 2.1 million cells > SHAPE_MAX_SCAN_CELLS. Judged by total volume, not by any single edge length
    const flat: Bbox = { min: [-COORD_LIMIT, 0, -COORD_LIMIT], max: [COORD_LIMIT, 1, COORD_LIMIT] };
    const result = buildShape('box', flat);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bboxTooLarge');
  });

  it('within the scan limit, a flat bbox is scanned and judged by cell count (not short-circuited by volume)', () => {
    const flat: Bbox = { min: [0, 0, 0], max: [COORD_LIMIT, 3, COORD_LIMIT] }; // 1.05 million cells
    const result = buildShape('box', flat);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('tooManyCells');
  });

  it('even within the scan limit, exceeding the cell count limit fails (with the actual cell count attached)', () => {
    const b = box(40, 40, 40); // 64000 cells > OP_MAX_CELLS (32768), does not exceed the scan limit
    const result = buildShape('box', b, { hollow: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('tooManyCells');
    expect(result.count).toBe(64000); // returns the real count instead of truncating (so the toast number isn't a lie)
    expect(result.max).toBe(OP_MAX_CELLS);
  });

  it('when hollow, it passes even if the bbox volume exceeds the limit (judged by actual cell count)', () => {
    const b = box(40, 40, 40);
    expect(buildShape('box', b, { hollow: false }).ok).toBe(false);
    const hollow = buildShape('box', b, { hollow: true });
    expect(hollow.ok).toBe(true);
    if (hollow.ok) expect(hollow.cells.length).toBeLessThan(OP_MAX_CELLS);
  });

  it('the limit can be overridden by the caller', () => {
    const result = buildShape('box', box(4, 4, 4), {}, { maxCells: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.count).toBe(64);
      expect(result.max).toBe(10);
    }
    expect(buildShape('box', box(4, 4, 4), {}, { maxCells: 64 }).ok).toBe(true);
  });
});

describe('box', () => {
  it('solid is every cell in the bbox', () => {
    expect(cellsOf('box', box(3, 4, 5), { hollow: false })).toHaveLength(3 * 4 * 5);
  });

  it('hollow is just the outer shell (for 3x3x3, only the single center cell is missing)', () => {
    const cells = cellsOf('box', box(3, 3, 3), { hollow: true });
    expect(cells).toHaveLength(26);
    expect(setOf(cells).has('1,1,1')).toBe(false);
  });

  it('hollow 5x5x5 is 5^3 - 3^3', () => {
    expect(cellsOf('box', box(5, 5, 5), { hollow: true })).toHaveLength(125 - 27);
  });
});

describe('sphere / ellipsoid', () => {
  it('touches all 6 faces of the bbox (inscribed)', () => {
    const s = setOf(cellsOf('sphere', box(7, 7, 7), { hollow: false }));
    expect(s.has('0,3,3')).toBe(true); // -X face
    expect(s.has('6,3,3')).toBe(true); // +X face
    expect(s.has('3,0,3')).toBe(true); // -Y face
    expect(s.has('3,6,3')).toBe(true); // +Y face
    expect(s.has('3,3,0')).toBe(true); // -Z face
    expect(s.has('3,3,6')).toBe(true); // +Z face
  });

  it('never includes the corners (not just a box)', () => {
    const s = setOf(cellsOf('sphere', box(7, 7, 7), { hollow: false }));
    expect(s.has('0,0,0')).toBe(false);
    expect(s.has('6,6,6')).toBe(false);
  });

  it('the bbox edges do not vanish even at an even size (rounding error at the boundary is absorbed)', () => {
    const s = setOf(cellsOf('sphere', box(6, 6, 6), { hollow: false }));
    expect(s.has('0,2,2')).toBe(true);
    expect(s.has('5,3,3')).toBe(true);
  });

  it('becomes an ellipsoid with a different radius per axis (inscribed even when the bbox is not a cube)', () => {
    const s = setOf(cellsOf('sphere', box(9, 3, 5), { hollow: false }));
    expect(s.has('0,1,2')).toBe(true);
    expect(s.has('8,1,2')).toBe(true);
    expect(s.has('4,1,0')).toBe(true);
    expect(s.has('4,1,4')).toBe(true);
  });

  it('the solid result is symmetric across all 3 axes', () => {
    const s = setOf(cellsOf('sphere', box(9, 9, 9), { hollow: false }));
    for (const k of s) {
      const [x, y, z] = k.split(',').map(Number) as [number, number, number];
      expect(s.has(key([8 - x, y, z]))).toBe(true);
      expect(s.has(key([x, 8 - y, z]))).toBe(true);
      expect(s.has(key([x, y, 8 - z]))).toBe(true);
    }
  });

  it('hollow is a subset of solid, with the interior hollowed out', () => {
    const solid = setOf(cellsOf('sphere', box(9, 9, 9), { hollow: false }));
    const shell = cellsOf('sphere', box(9, 9, 9), { hollow: true });
    for (const c of shell) expect(solid.has(key(c))).toBe(true);
    expect(setOf(shell).has('4,4,4')).toBe(false);
    expect(shell.length).toBeLessThan(solid.size);
  });

  it('the hollow shell has no holes (does not leak from outside to inside via 6-neighbor flood fill)', () => {
    const b = box(11, 11, 11);
    const solid = setOf(cellsOf('sphere', b, { hollow: false }));
    const shell = setOf(cellsOf('sphere', b, { hollow: true }));
    const interior = [...solid].filter((k) => !shell.has(k));
    expect(interior.length).toBeGreaterThan(0);

    // flood-fill via 6-neighbor moves from 1 cell outside the bbox, passing only through cells
    // that are not the shell. If the shell has no hole, it should never reach the interior at all.
    const lo = -1;
    const hi = 11;
    const seen = new Set<string>([key([lo, lo, lo])]);
    const queue: Cell[] = [[lo, lo, lo]];
    const dirs: Cell[] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    while (queue.length) {
      const [x, y, z] = queue.pop()!;
      for (const [dx, dy, dz] of dirs) {
        const n: Cell = [x + dx, y + dy, z + dz];
        if (n[0] < lo || n[0] > hi || n[1] < lo || n[1] > hi || n[2] < lo || n[2] > hi) continue;
        const nk = key(n);
        if (seen.has(nk) || shell.has(nk)) continue;
        seen.add(nk);
        queue.push(n);
      }
    }
    for (const k of interior) expect(seen.has(k)).toBe(false);
  });
});

describe('cylinder', () => {
  it('the default axis is Y — every y layer has the same cross-section', () => {
    const cells = cellsOf('cylinder', box(7, 4, 7), { hollow: false });
    const layers = new Map<number, Set<string>>();
    for (const [x, y, z] of cells) {
      if (!layers.has(y)) layers.set(y, new Set());
      layers.get(y)!.add(`${x},${z}`);
    }
    expect(layers.size).toBe(4);
    const [first, ...rest] = [...layers.values()];
    for (const layer of rest) expect([...layer].sort()).toEqual([...first!].sort());
  });

  it('setting the axis to X makes the cross-section the YZ plane', () => {
    const cells = cellsOf('cylinder', box(4, 7, 7), { axis: 0, hollow: false });
    const layers = new Map<number, number>();
    for (const [x] of cells) layers.set(x, (layers.get(x) ?? 0) + 1);
    expect(layers.size).toBe(4);
    expect(new Set(layers.values()).size).toBe(1);
  });

  it('the cross-section is a circle — excludes the bbox corners but includes the edge midpoints', () => {
    const s = setOf(cellsOf('cylinder', box(7, 3, 7), { hollow: false }));
    expect(s.has('0,1,0')).toBe(false);
    expect(s.has('0,1,3')).toBe(true);
    expect(s.has('3,1,0')).toBe(true);
  });

  it('hollow is a tube — does not cap either end along the axis', () => {
    const b = box(7, 4, 7);
    const solid = setOf(cellsOf('cylinder', b, { hollow: false }));
    const shell = setOf(cellsOf('cylinder', b, { hollow: true }));
    expect(solid.has('3,3,3')).toBe(true);
    expect(shell.has('3,3,3')).toBe(false); // does not cap the top end
    expect(shell.has('0,3,3')).toBe(true); // the sides remain
    expect(shell.has('0,0,3')).toBe(true);
  });
});

describe('dome', () => {
  it('uses the full bbox height, narrowing as it goes up', () => {
    const cells = cellsOf('dome', box(9, 5, 9), { hollow: false });
    const byY = countByY(cells);
    expect(byY.size).toBe(5);
    const counts = [0, 1, 2, 3, 4].map((y) => byY.get(y)!);
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeLessThan(counts[i - 1]!);
  });

  /**
   * Raised in review: the topmost layer becomes a single point — 1 cell for an odd width.
   * Previously the vertical radius used sizeY, so the topmost layer only ever reached a height of
   * (sizeY-1)/sizeY < 1, leaving the topmost layer of a 9×5×9 dome as a flat 21-cell plane (a flat-topped dome).
   */
  it('the topmost layer becomes the apex — a single cell for odd widths', () => {
    for (const [sx, sy, sz] of [
      [9, 5, 9],
      [7, 3, 7],
      [11, 6, 11],
      [5, 9, 5],
    ] as const) {
      const cells = cellsOf('dome', box(sx, sy, sz), { hollow: false });
      const top = cells.filter(([, y]) => y === sy - 1);
      expect(top, `topmost layer of ${sx}x${sy}x${sz}`).toHaveLength(1);
      expect(top[0]).toEqual([(sx - 1) / 2, sy - 1, (sz - 1) / 2]);
    }
  });

  it('for an even width, the topmost layer is the smallest centrally-symmetric cap (never empty)', () => {
    const cells = cellsOf('dome', box(8, 5, 8), { hollow: false });
    const top = cells.filter(([, y]) => y === 4);
    expect(top).toHaveLength(4); // 2x2
    expect(setOf(top)).toEqual(new Set(['3,4,3', '3,4,4', '4,4,3', '4,4,4']));
  });

  it('the bottom layer is the largest circle, not a cross-section cut from a sphere (it\'s a half-ellipsoid)', () => {
    const s = setOf(cellsOf('dome', box(9, 5, 9), { hollow: false }));
    expect(s.has('0,0,4')).toBe(true);
    expect(s.has('8,0,4')).toBe(true);
    expect(s.has('4,0,0')).toBe(true);
  });

  it('never spills below the bottom edge or above the top edge', () => {
    const cells = cellsOf('dome', box(9, 5, 9, [0, 3, 0]), { hollow: false });
    for (const [, y] of cells) {
      expect(y).toBeGreaterThanOrEqual(3);
      expect(y).toBeLessThanOrEqual(7);
    }
  });

  it('hollow opens at the bottom (-Y) — the bottom layer is a ring, not a disc', () => {
    const b = box(9, 5, 9);
    const solid = setOf(cellsOf('dome', b, { hollow: false }));
    const shell = setOf(cellsOf('dome', b, { hollow: true }));
    expect(solid.has('4,0,4')).toBe(true);
    expect(shell.has('4,0,4')).toBe(false); // hollow does not lay a floor (it's meant to be placed on top as a roof)
    expect(shell.has('0,0,4')).toBe(true); // the rim remains
    expect(shell.has('4,4,4')).toBe(true); // the apex remains
  });

  it('even hollow with a shell thickness of 1 leaves no hole in the roof (fully covered when viewed from directly above)', () => {
    const b = box(11, 6, 11);
    const solid = cellsOf('dome', b, { hollow: false });
    const shell = cellsOf('dome', b, { hollow: true });
    const solidColumns = new Set(solid.map(([x, , z]) => `${x},${z}`));
    const shellColumns = new Set(shell.map(([x, , z]) => `${x},${z}`));
    for (const c of solidColumns) expect(shellColumns.has(c)).toBe(true);
  });
});

describe('slope hollow — only the sloped surface layer (roof use case)', () => {
  /** returns, per run-axis position, the "y values placed in that column," ascending */
  function columnsOf(cells: Cell[], runAxis: 0 | 2): Map<number, number[]> {
    const byRun = new Map<number, number[]>();
    for (const c of cells) {
      const run = c[runAxis];
      const ys = byRun.get(run) ?? [];
      ys.push(c[1]);
      byRun.set(run, ys);
    }
    for (const ys of byRun.values()) ys.sort((a, b) => a - b);
    return byRun;
  }

  it('step 1 is a diagonal line of 1 cell per column (the fill underneath disappears)', () => {
    const cells = cellsOf('slope', box(4, 4, 1), { hollow: true });
    expect(columnsOf(cells, 0)).toEqual(new Map([
      [0, [0]],
      [1, [1]],
      [2, [2]],
      [3, [3]],
    ]));
  });

  it('step 2 is 2 cells per column (only the vertical range each step occupies remains)', () => {
    // solid fills x=1 for y=0..3. hollow keeps only the step's range, y=2,3
    const cells = cellsOf('slope', box(3, 6, 1), { hollow: true, step: 2 });
    expect(columnsOf(cells, 0)).toEqual(new Map([
      [0, [0, 1]],
      [1, [2, 3]],
      [2, [4, 5]],
    ]));
  });

  it('the slope never has a hole — y stays contiguous even when a single column rises more than 2 steps', () => {
    // with run(4) < height(6), each column rises 1.67 steps. Keeping only "the top `step` cells"
    // leaves a gap between columns and it stops being a roof (a hole from the first implementation pass)
    const cells = cellsOf('slope', box(4, 6, 1), { hollow: true });
    const ys = [...cells].map(([, y]) => y).sort((a, b) => a - b);
    expect(ys).toEqual([0, 1, 2, 3, 4, 5]); // no gap
  });

  it('the surface layer remains even on a flat run where consecutive columns share the same height', () => {
    // once the top is reached, the difference from the previous column is 0. Deciding purely by
    // "one above the previous column" would leave it empty
    const columns = new Map<number, number[]>();
    for (const [x, y] of cellsOf('slope', box(4, 6, 1), { hollow: true, step: 2 })) {
      columns.set(x, [...(columns.get(x) ?? []), y].sort((a, b) => a - b));
    }
    expect(columns.get(2)).toEqual([4, 5]);
    expect(columns.get(3)).toEqual([4, 5]); // the flat run continues without a gap
  });

  it('is a subset of solid (never grows new cells)', () => {
    for (const step of [1, 2, 3]) {
      const solid = setOf(cellsOf('slope', box(6, 9, 4), { hollow: false, step }));
      for (const c of cellsOf('slope', box(6, 9, 4), { hollow: true, step })) {
        expect(solid.has(key(c))).toBe(true);
      }
    }
  });

  it('never gets squashed along the depth axis (the slope stays the full width)', () => {
    const cells = cellsOf('slope', box(3, 3, 4), { hollow: true });
    const zs = new Set(cells.map(([, , z]) => z));
    expect([...zs].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('the same shape results going downward (only the direction is flipped)', () => {
    const up = columnsOf(cellsOf('slope', box(4, 4, 1), { hollow: true, slope: { axis: 0, ascending: true } }), 0);
    const down = columnsOf(cellsOf('slope', box(4, 4, 1), { hollow: true, slope: { axis: 0, ascending: false } }), 0);
    expect(down).toEqual(new Map([
      [0, up.get(3)!],
      [1, up.get(2)!],
      [2, up.get(1)!],
      [3, up.get(0)!],
    ]));
  });
});

describe('slope', () => {
  it('the default (step 1) is a staircase rising one step at a time', () => {
    const cells = cellsOf('slope', box(4, 4, 4));
    const heightAt = new Map<number, number>();
    for (const [x] of cells) heightAt.set(x, (heightAt.get(x) ?? 0) + 1);
    expect(heightAt.get(0)).toBe(1 * 4);
    expect(heightAt.get(1)).toBe(2 * 4);
    expect(heightAt.get(2)).toBe(3 * 4);
    expect(heightAt.get(3)).toBe(4 * 4);
  });

  it('step changes how much each rise gains', () => {
    const cells = cellsOf('slope', box(4, 4, 4), { step: 2 });
    const heightAt = new Map<number, number>();
    for (const [x] of cells) heightAt.set(x, (heightAt.get(x) ?? 0) + 1);
    expect(heightAt.get(0)).toBe(2 * 4);
    expect(heightAt.get(1)).toBe(2 * 4);
    expect(heightAt.get(2)).toBe(4 * 4);
    expect(heightAt.get(3)).toBe(4 * 4);
  });

  it('rises along whichever horizontal axis is longer (Z direction if Z is longer)', () => {
    const cells = cellsOf('slope', box(2, 4, 8));
    const heightAtZ = new Map<number, number>();
    for (const [, , z] of cells) heightAtZ.set(z, (heightAtZ.get(z) ?? 0) + 1);
    expect(heightAtZ.get(0)!).toBeLessThan(heightAtZ.get(7)!);
    const heightAtX = new Map<number, number>();
    for (const [x] of cells) heightAtX.set(x, (heightAtX.get(x) ?? 0) + 1);
    expect(heightAtX.get(0)).toBe(heightAtX.get(1));
  });

  /**
   * Raised in review: pin the mapping at **both** ends.
   *
   * - The first version (dividing the step count evenly by run) never reached the topmost step
   *   at the far end (2×10 → stopped at y=5)
   * - The second version (`ceil(height*(i+1)/run)`) reached the far end but **the near end never
   *   started from the bottommost step** (2×10 → surface heights 5,10 / 3×20 → 7,14,20 — a wall
   *   springs up abruptly on the low side)
   *
   * The key is to look directly at `topByRun().get(nearEnd)`. Checking only "y=0 exists
   * somewhere" guarantees nothing, since every column includes the base layer (which is how
   * version 2 slipped through).
   */
  it('when run < height, both ends of the run still map to the bottommost / topmost step', () => {
    for (const [sx, sy, sz, runAxis] of [
      [2, 10, 2, 0],
      [3, 20, 1, 0],
      [1, 20, 3, 2],
      [4, 30, 1, 0],
    ] as const) {
      const label = `${sx}x${sy}x${sz}`;
      const run = runAxis === 0 ? sx : sz;
      for (const ascending of [true, false]) {
        const tops = topByRun(cellsOf('slope', box(sx, sy, sz), { slope: { axis: runAxis, ascending } }), runAxis);
        const lowEnd = ascending ? 0 : run - 1;
        const highEnd = ascending ? run - 1 : 0;
        expect(tops.get(lowEnd), `${label} ascending=${ascending} low end`).toBe(0); // one step's worth
        expect(tops.get(highEnd), `${label} ascending=${ascending} high end`).toBe(sy - 1);
        expect(Math.max(...tops.values()), `topmost layer of ${label}`).toBe(sy - 1);
      }
    }
  });

  it('run < height produces the surface heights shown in the review (2×10 → 1,10 / 3×20 → 1,11,20)', () => {
    expect([...topByRun(cellsOf('slope', box(2, 10, 1)), 0).values()]).toEqual([0, 9]);
    expect([...topByRun(cellsOf('slope', box(3, 20, 1)), 0).values()]).toEqual([0, 10, 19]);
  });

  it('run = 1 is a column the full height of the bbox', () => {
    const cells = cellsOf('slope', box(1, 5, 1));
    expect(cells).toHaveLength(5);
    expect(setOf(cells)).toEqual(new Set(['0,0,0', '0,1,0', '0,2,0', '0,3,0', '0,4,0']));
  });

  it('step > 1 still applies when run < height, and the near end is exactly one step tall', () => {
    const tops = topByRun(cellsOf('slope', box(3, 9, 1), { step: 3 }), 0);
    expect(tops.get(0)).toBe(2); // near end = 1 step (3 blocks) worth
    expect(tops.get(2)).toBe(8); // far end = topmost step
    expect(tops.get(1)).toBeGreaterThan(2);
    expect(tops.get(1)).toBeLessThan(8);
  });

  it('with step > 1, the near end is still exactly one step even when descending (both ends are pinned regardless of direction)', () => {
    const tops = topByRun(cellsOf('slope', box(3, 9, 1), { step: 3, slope: { axis: 0, ascending: false } }), 0);
    expect(tops.get(2)).toBe(2); // near end
    expect(tops.get(0)).toBe(8); // far end
  });

  it('the bottom layer is always fully filled and reaches the topmost layer', () => {
    const cells = cellsOf('slope', box(6, 3, 6));
    const byY = countByY(cells);
    expect(byY.get(0)).toBe(36);
    expect(byY.get(2)!).toBeGreaterThan(0);
  });

  it('hollow leaves only the sloped surface layer (always fewer cells than solid)', () => {
    // v1 ignored hollow and stayed solid. Spec changed since roof use cases only want the surface layer
    // (see the "slope hollow" describe block for details)
    const solid = cellsOf('slope', box(5, 5, 5), { hollow: false });
    const shell = cellsOf('slope', box(5, 5, 5), { hollow: true });
    expect(shell.length).toBeLessThan(solid.length);
  });
});

/**
 * Raised in review: bbox normalizes start/end points, which loses the direction.
 * Pin down that all 4 horizontal directions obtainable from a drag (±X / ±Z) can be represented.
 */
describe('slope orientation', () => {
  it('ascending=false rises in the opposite direction (a mirror image of ascending)', () => {
    const b = box(5, 5, 3);
    const up = cellsOf('slope', b, { slope: { axis: 0, ascending: true } });
    const down = cellsOf('slope', b, { slope: { axis: 0, ascending: false } });
    expect(down).toHaveLength(up.length);
    const mirrored = setOf(up.map(([x, y, z]) => [4 - x, y, z] as Cell));
    expect(setOf(down)).toEqual(mirrored);
  });

  it('can specify all 4 horizontal directions', () => {
    const b = box(5, 5, 5);
    const endsOf = (axis: 0 | 2, ascending: boolean): [number, number] => {
      const tops = topByRun(cellsOf('slope', b, { slope: { axis, ascending } }), axis);
      return [tops.get(0)!, tops.get(4)!];
    };
    expect(endsOf(0, true)).toEqual([0, 4]); // rises toward +X
    expect(endsOf(0, false)).toEqual([4, 0]); // rises toward -X
    expect(endsOf(2, true)).toEqual([0, 4]); // rises toward +Z
    expect(endsOf(2, false)).toEqual([4, 0]); // rises toward -Z
  });

  it('an explicit axis takes priority over auto-selection (can even point along the shorter edge)', () => {
    const cells = cellsOf('slope', box(2, 4, 8), { slope: { axis: 0, ascending: true } });
    const tops = topByRun(cells, 0);
    expect(tops.get(0)).toBeLessThan(tops.get(1)!);
  });

  it('slopeDirectionFromCorners: reads off the drag direction as-is', () => {
    expect(slopeDirectionFromCorners([0, 0, 0], [5, 0, 1])).toEqual({ axis: 0, ascending: true });
    expect(slopeDirectionFromCorners([5, 0, 0], [0, 0, 1])).toEqual({ axis: 0, ascending: false });
    expect(slopeDirectionFromCorners([0, 0, 0], [1, 0, 5])).toEqual({ axis: 2, ascending: true });
    expect(slopeDirectionFromCorners([0, 0, 5], [1, 0, 0])).toEqual({ axis: 2, ascending: false });
  });

  it('slopeDirectionFromCorners: picks X when the movement is equal on both axes / zero movement counts as ascending', () => {
    expect(slopeDirectionFromCorners([0, 0, 0], [3, 0, 3])).toEqual({ axis: 0, ascending: true });
    expect(slopeDirectionFromCorners([2, 0, 2], [2, 4, 2])).toEqual({ axis: 0, ascending: true });
  });

  it('2 drag points → bbox + direction can build a staircase in the reverse direction (the information is enough to reconstruct from the UI)', () => {
    const anchor: Cell = [8, 0, 0];
    const target: Cell = [4, 3, 2];
    const cells = cellsOf('slope', bboxOfCorners(anchor, target), {
      slope: slopeDirectionFromCorners(anchor, target),
    });
    const tops = topByRun(cells, 0);
    expect(tops.get(8)).toBe(0); // the anchor side is the bottommost step
    expect(tops.get(4)).toBe(3); // the target side is the topmost step
  });
});

describe('bboxOfCorners', () => {
  it('produces the same bbox regardless of the order of the 2 points', () => {
    const a: Cell = [5, -2, 9];
    const b: Cell = [-1, 4, 3];
    expect(bboxOfCorners(a, b)).toEqual({ min: [-1, -2, 3], max: [5, 4, 9] });
    expect(bboxOfCorners(b, a)).toEqual(bboxOfCorners(a, b));
  });

  it('is 1x1x1 for identical points', () => {
    expect(bboxOfCorners([2, 3, 4], [2, 3, 4])).toEqual({ min: [2, 3, 4], max: [2, 3, 4] });
  });
});

/**
 * `shapeFillsBbox` declares "whether a shape always produces a cell count equal to the bbox
 * volume." The dimension display checks this to decide whether it may assert a
 * limit-exceeded state before the shape is finalized.
 *
 * If the declaration and `buildShape`'s actual behavior drift apart, an operation that would go
 * through gets marked as "blocked" (or the reverse), so here we actually generate every shape ×
 * hollow combination and cross-check them.
 */
describe('shapeFillsBbox — declaration matches actual generation', () => {
  const KINDS: readonly ShapeKind[] = ['box', 'sphere', 'cylinder', 'dome', 'slope'];
  // cube / flat slab / thin rod. Representative shapes where inscribing and shell behavior differ
  const BOXES: readonly Bbox[] = [
    { min: [0, 0, 0], max: [6, 6, 6] },
    { min: [0, 0, 0], max: [8, 2, 8] },
    { min: [-3, 0, -3], max: [3, 9, 3] },
  ];

  const volumeOf = (b: Bbox): number =>
    (b.max[0] - b.min[0] + 1) * (b.max[1] - b.min[1] + 1) * (b.max[2] - b.min[2] + 1);

  it('combinations declared true generate exactly the volume\'s worth of cells for any bbox', () => {
    const filling = KINDS.flatMap((kind) =>
      [false, true].filter((hollow) => shapeFillsBbox(kind, hollow)).map((hollow) => ({ kind, hollow })),
    );
    // if the declaration list ends up empty, there's nowhere left to assert it — so fail on that alone
    expect(filling.length).toBeGreaterThan(0);
    for (const { kind, hollow } of filling) {
      for (const bbox of BOXES) {
        expect(cellsOf(kind, bbox, { hollow }).length, `${kind} hollow=${hollow}`).toBe(volumeOf(bbox));
      }
    }
  });

  it('combinations declared false actually have some bbox where the result is smaller than the volume', () => {
    const notFilling = KINDS.flatMap((kind) =>
      [false, true].filter((hollow) => !shapeFillsBbox(kind, hollow)).map((hollow) => ({ kind, hollow })),
    );
    for (const { kind, hollow } of notFilling) {
      const shrinks = BOXES.some((bbox) => cellsOf(kind, bbox, { hollow }).length < volumeOf(bbox));
      expect(shrinks, `${kind} hollow=${hollow} filled the volume for every bbox`).toBe(true);
    }
  });
});
