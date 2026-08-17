import { describe, expect, it } from 'vitest';
import type { CellRef } from '../src/core/cellref';
import { OP_MAX_CELLS } from '../src/core/limits';
import { packCell } from '../src/core/orientation';
import type { Hit } from '../src/core/types';
import { makeCellKey } from '../src/core/types';
import type { Selection, SelectedCell } from '../src/editor/selection';
import { collectSelectableInBox, decideSelectAction, resolveClickSelection, type SelectPointerContext } from '../src/input/selecttool';
import { DocumentFixture } from './helpers/document-fixture';

const V = packCell(0, 0);

/**
 * root
 * ├─ g0 (root-group)
 * │   └─ g1 (mid) ← cell (2,0,0) belongs to it directly (2 levels deep from root)
 * └─ g2 (sibling, flat) ← cell (5,0,5) belongs to it directly (1 level deep)
 * cell (9,9,9) and (1,1,1) are unassigned (owner = null)
 *
 * Cell ownership is now literally "which owner holds this cell," so it's placed
 * directly into OwnerVoxelStore keyed owner-local instead of a membership index.
 * No group has a transform set (identity), so local coordinates = world coordinates.
 */
function buildDoc(): DocumentFixture {
  const doc = new DocumentFixture();
  doc.insertGroup({ id: 'g0', name: 'root-group', parentId: null, childIds: [] }, 0);
  doc.insertGroup({ id: 'g1', name: 'mid', parentId: 'g0', childIds: [] }, 0);
  doc.insertGroup({ id: 'g2', name: 'sibling', parentId: null, childIds: [] }, 1);
  doc.setOwnerCells('g1', [['2,0,0', V]]);
  doc.setOwnerCells('g2', [['5,0,5', V]]);
  doc.setOwnerCells(null, [
    ['9,9,9', V],
    ['1,1,1', V],
  ]);
  return doc;
}

const NONE: Selection = { kind: 'none' };

describe('resolveClickSelection — normal click', () => {
  it('an unassigned cell becomes a single-cell selection', () => {
    const doc = buildDoc();
    const next = resolveClickSelection(doc.tree, NONE, doc.cellAt(9, 9, 9), { ctrl: false, doubleClick: false });
    expect(next).toEqual(doc.cellSelection([9, 9, 9]));
  });

  it('a cell belonging to a group selects the outermost group regardless of the current selection', () => {
    const doc = buildDoc();
    const current: Selection = doc.groupSelection('g2'); // an unrelated existing selection
    const next = resolveClickSelection(doc.tree, current, doc.cellAt(2, 0, 0), { ctrl: false, doubleClick: false });
    expect(next).toEqual(doc.groupSelection('g0')); // the outermost ancestor of g1 is g0
  });

  it('a flat (non-nested) group is also selected directly by a normal click', () => {
    const doc = buildDoc();
    const next = resolveClickSelection(doc.tree, NONE, doc.cellAt(5, 0, 5), { ctrl: false, doubleClick: false });
    expect(next).toEqual(doc.groupSelection('g2'));
  });
});

describe('resolveClickSelection — Ctrl+click', () => {
  it('ctrl+click on an unassigned cell adds it to the cells kind', () => {
    const doc = buildDoc();
    const current: Selection = doc.cellSelection([1, 1, 1]);
    const next = resolveClickSelection(doc.tree, current, doc.cellAt(9, 9, 9), { ctrl: true, doubleClick: false });
    expect(next).toEqual(doc.cellSelection([1, 1, 1], [9, 9, 9]));
  });

  it('ctrl+click on an unassigned cell removes it if already selected (becomes none if it empties out)', () => {
    const doc = buildDoc();
    const current: Selection = doc.cellSelection([9, 9, 9]);
    const next = resolveClickSelection(doc.tree, current, doc.cellAt(9, 9, 9), { ctrl: true, doubleClick: false });
    expect(next).toEqual({ kind: 'none' });
  });

  it('crossing kinds (ctrl+clicking an unassigned cell while groups are selected) replaces the selection', () => {
    const doc = buildDoc();
    const current: Selection = doc.groupSelection('g2');
    const next = resolveClickSelection(doc.tree, current, doc.cellAt(9, 9, 9), { ctrl: true, doubleClick: false });
    expect(next).toEqual(doc.cellSelection([9, 9, 9]));
  });

  it('ctrl+click on a cell belonging to a group toggles its outermost group into the groups selection', () => {
    const doc = buildDoc();
    const current: Selection = doc.groupSelection('g2');
    const next = resolveClickSelection(doc.tree, current, doc.cellAt(2, 0, 0), { ctrl: true, doubleClick: false });
    expect(next).toEqual(doc.groupSelection('g2', 'g0'));
  });

  it('ctrl+click on a cell belonging to a group removes it if already selected (becomes none if it empties out)', () => {
    const doc = buildDoc();
    const current: Selection = doc.groupSelection('g0');
    const next = resolveClickSelection(doc.tree, current, doc.cellAt(2, 0, 0), { ctrl: true, doubleClick: false });
    expect(next).toEqual({ kind: 'none' });
  });

  it('crossing kinds (ctrl+clicking a grouped cell while cells are selected) replaces the selection', () => {
    const doc = buildDoc();
    const current: Selection = doc.cellSelection([9, 9, 9]);
    const next = resolveClickSelection(doc.tree, current, doc.cellAt(2, 0, 0), { ctrl: true, doubleClick: false });
    expect(next).toEqual(doc.groupSelection('g0'));
  });
});

describe('resolveClickSelection — double-click (drill in)', () => {
  it('double-clicking from an outermost selection drills in one level (g0 → g1)', () => {
    const doc = buildDoc();
    const current: Selection = doc.groupSelection('g0');
    const next = resolveClickSelection(doc.tree, current, doc.cellAt(2, 0, 0), { ctrl: false, doubleClick: true });
    expect(next).toEqual(doc.groupSelection('g1'));
  });

  it('double-clicking further from the innermost group (g1) selects the cell itself', () => {
    const doc = buildDoc();
    const current: Selection = doc.groupSelection('g1');
    const next = resolveClickSelection(doc.tree, current, doc.cellAt(2, 0, 0), { ctrl: false, doubleClick: true });
    expect(next).toEqual(doc.cellSelection([2, 0, 0]));
  });

  it('double-clicking again while the cell itself is selected is a no-op (returns the same reference)', () => {
    const doc = buildDoc();
    const current: Selection = doc.cellSelection([2, 0, 0]);
    const next = resolveClickSelection(doc.tree, current, doc.cellAt(2, 0, 0), { ctrl: false, doubleClick: true });
    expect(next).toBe(current);
  });

  it('double-clicking from an unrelated single-group selection behaves like a normal click (resets to outermost)', () => {
    const doc = buildDoc();
    const current: Selection = doc.groupSelection('g2'); // unrelated to the g0/g1 path
    const next = resolveClickSelection(doc.tree, current, doc.cellAt(2, 0, 0), { ctrl: false, doubleClick: true });
    expect(next).toEqual(doc.groupSelection('g0'));
  });

  it('double-clicking while multiple groups are selected is also treated as unrelated and resets to outermost (only a single selection can drill in)', () => {
    const doc = buildDoc();
    const current: Selection = doc.groupSelection('g0', 'g2');
    const next = resolveClickSelection(doc.tree, current, doc.cellAt(2, 0, 0), { ctrl: false, doubleClick: true });
    expect(next).toEqual(doc.groupSelection('g0'));
  });

  it('double-clicking from a cells selection (an unrelated cell) also resets to outermost', () => {
    const doc = buildDoc();
    const current: Selection = doc.cellSelection([9, 9, 9]);
    const next = resolveClickSelection(doc.tree, current, doc.cellAt(2, 0, 0), { ctrl: false, doubleClick: true });
    expect(next).toEqual(doc.groupSelection('g0'));
  });

  it('double-clicking a flat (1-level) group drills straight to the cell', () => {
    const doc = buildDoc();
    const current: Selection = doc.groupSelection('g2');
    const next = resolveClickSelection(doc.tree, current, doc.cellAt(5, 0, 5), { ctrl: false, doubleClick: true });
    expect(next).toEqual(doc.cellSelection([5, 0, 5]));
  });
});

describe('collectSelectableInBox', () => {
  function makeDoc(cells: Array<[number, number, number]>): DocumentFixture {
    const doc = new DocumentFixture();
    doc.setCells(cells.map(([x, y, z]) => [x, y, z, V] as [number, number, number, number]));
    return doc;
  }

  /** Turns the collected SelectedCell list into a Set of world keys (for order-independent comparison) */
  function worldKeys(cells: SelectedCell[]): Set<string> {
    return new Set(cells.map((c) => makeCellKey(c.worldCell[0], c.worldCell[1], c.worldCell[2])));
  }

  it('collects only the existing cells within range (ignores out-of-range and empty cells)', () => {
    const doc = makeDoc([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0], // expected to fall outside the range
    ]);
    const { cells, volume } = collectSelectableInBox(doc.index, [0, 0, 0], [1, 0, 0]);
    expect(volume).toBe(2);
    expect(worldKeys(cells)).toEqual(new Set(['0,0,0', '1,0,0']));
  });

  it('each collected cell carries a ref (owner + owner-local)', () => {
    const doc = makeDoc([[0, 0, 0]]);
    const { cells } = collectSelectableInBox(doc.index, [0, 0, 0], [0, 0, 0]);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.ref).toEqual({ ownerId: null, localCell: [0, 0, 0] });
  });

  it("doesn't collect cells from a locked group (selectableRefAt passes through it)", () => {
    const doc = new DocumentFixture();
    doc.insertGroup({ id: 'l', name: 'locked', parentId: null, childIds: [], locked: true }, 0);
    doc.setOwnerCells('l', [['0,0,0', V]]);
    doc.setOwnerCells(null, [['1,0,0', V]]);
    const { cells } = collectSelectableInBox(doc.index, [0, 0, 0], [1, 0, 0]);
    expect(worldKeys(cells)).toEqual(new Set(['1,0,0']));
  });

  it('gives the same result even with a/b reversed (min/max normalization)', () => {
    const doc = makeDoc([
      [0, 0, 0],
      [1, 0, 0],
    ]);
    const { cells } = collectSelectableInBox(doc.index, [1, 0, 0], [0, 0, 0]);
    expect(worldKeys(cells)).toEqual(new Set(['0,0,0', '1,0,0']));
  });

  it('scans a negative-coordinate box correctly too', () => {
    const doc = makeDoc([
      [-2, 0, -2],
      [-1, 0, -1],
      [0, 0, 0], // out of range
    ]);
    const { cells } = collectSelectableInBox(doc.index, [-2, 0, -2], [-1, 0, -1]);
    expect(worldKeys(cells)).toEqual(new Set(['-2,0,-2', '-1,0,-1']));
  });

  it('returns an empty set without scanning once the volume exceeds OP_MAX_CELLS (confirms the guard short-circuits)', () => {
    const doc = makeDoc([[0, 0, 0]]);
    const big = 40; // (40+1)^3 = 68921 > 32768
    const { cells, volume } = collectSelectableInBox(doc.index, [0, 0, 0], [big, big, big]);
    expect(volume).toBeGreaterThan(OP_MAX_CELLS);
    expect(cells).toHaveLength(0); // stays empty because it isn't scanned even though [0,0,0] is within range
  });
});

describe('decideSelectAction', () => {
  const refOf = (cell: [number, number, number]): CellRef => ({ ownerId: null, localCell: cell });

  function voxelHit(cell: [number, number, number]): Hit {
    return { kind: 'voxel', ref: refOf(cell), cell, normal: [0, 1, 0], t: 1 };
  }

  function groundHit(cell: [number, number, number]): Hit {
    return { kind: 'ground', cell, normal: [0, 1, 0], t: 1 };
  }

  function selectedCell(cell: [number, number, number]): SelectedCell {
    return { ref: refOf(cell), worldCell: cell };
  }

  /** Caller defaults: every cell is valid, resolveSelectCell passes hit.cell through as-is, nothing selected */
  function baseCtx(overrides: Partial<SelectPointerContext> = {}): SelectPointerContext {
    return {
      hit: null,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      detail: 1,
      rangeAnchor: null,
      isSelected: () => false,
      resolveSelectCell: (hit) => hit.cell,
      isValidCell: () => true,
      ...overrides,
    };
  }

  it('shift with no hit is shift-noop', () => {
    expect(decideSelectAction(baseCtx({ shiftKey: true, hit: null }))).toEqual({ kind: 'shift-noop' });
  });

  it('shift with an invalid cell is shift-noop', () => {
    const action = decideSelectAction(baseCtx({ shiftKey: true, hit: voxelHit([0, 0, 0]), isValidCell: () => false }));
    expect(action).toEqual({ kind: 'shift-noop' });
  });

  it('shift + first point (rangeAnchor unset) is shift-set-anchor', () => {
    const action = decideSelectAction(baseCtx({ shiftKey: true, hit: voxelHit([1, 2, 3]) }));
    expect(action).toEqual({ kind: 'shift-set-anchor', cell: [1, 2, 3] });
  });

  it('shift + second point (rangeAnchor already set) is shift-commit-range', () => {
    const action = decideSelectAction(baseCtx({ shiftKey: true, hit: voxelHit([1, 0, 0]), rangeAnchor: [0, 0, 0] }));
    expect(action).toEqual({ kind: 'shift-commit-range', from: [0, 0, 0], to: [1, 0, 0] });
  });

  it('a single click on an already-selected cell is begin-drag (judged by ref)', () => {
    const action = decideSelectAction(
      baseCtx({
        hit: voxelHit([2, 0, 0]),
        isSelected: (cell) => cell.ref.ownerId === null && cell.ref.localCell[0] === 2,
      }),
    );
    expect(action).toEqual({ kind: 'begin-drag' });
  });

  it('a single click on an unselected cell flows to a marquee candidate, not begin-drag', () => {
    const action = decideSelectAction(baseCtx({ hit: voxelHit([2, 0, 0]), isSelected: () => false }));
    expect(action.kind).toBe('begin-marquee');
  });

  it('Ctrl+click (voxel hit) is immediate-select', () => {
    const action = decideSelectAction(baseCtx({ hit: voxelHit([5, 0, 5]), ctrlKey: true }));
    expect(action).toEqual({ kind: 'immediate-select', cell: selectedCell([5, 0, 5]), ctrl: true, doubleClick: false });
  });

  it('double-click (voxel hit) is immediate-select', () => {
    const action = decideSelectAction(baseCtx({ hit: voxelHit([5, 0, 5]), detail: 2 }));
    expect(action).toEqual({ kind: 'immediate-select', cell: selectedCell([5, 0, 5]), ctrl: false, doubleClick: true });
  });

  it('Ctrl+click with no hit / non-voxel is noop (clear is limited to !ctrl && !meta)', () => {
    expect(decideSelectAction(baseCtx({ hit: null, ctrlKey: true })).kind).toBe('noop');
    expect(decideSelectAction(baseCtx({ hit: groundHit([0, 0, 0]), ctrlKey: true })).kind).toBe('noop');
  });

  it('double-click with no hit (non-Ctrl) is clear-empty', () => {
    expect(decideSelectAction(baseCtx({ hit: null, detail: 2 })).kind).toBe('clear-empty');
  });

  it("Ctrl+double-click with no hit is noop (clear is limited to !ctrl && !meta, preserving the original implementation's guard)", () => {
    const action = decideSelectAction(baseCtx({ hit: null, ctrlKey: true, detail: 2 }));
    expect(action).toEqual({ kind: 'noop' });
  });

  it('a non-Ctrl, single, hit-less click is clear', () => {
    expect(decideSelectAction(baseCtx({ hit: null })).kind).toBe('clear');
  });

  it('a non-Ctrl, single, ground-hit click is begin-marquee', () => {
    const action = decideSelectAction(baseCtx({ hit: groundHit([3, -1, 3]) }));
    expect(action).toEqual({ kind: 'begin-marquee', anchorCell: [3, -1, 3], cellIfVoxel: null });
  });

  it('a non-Ctrl, single, unselected voxel-hit click is begin-marquee (with cellIfVoxel)', () => {
    const action = decideSelectAction(baseCtx({ hit: voxelHit([1, 1, 1]) }));
    expect(action).toEqual({ kind: 'begin-marquee', anchorCell: [1, 1, 1], cellIfVoxel: selectedCell([1, 1, 1]) });
  });

  it('a marquee candidate with an invalid cell is noop', () => {
    const action = decideSelectAction(baseCtx({ hit: groundHit([0, 0, 0]), isValidCell: () => false }));
    expect(action).toEqual({ kind: 'noop' });
  });
});
