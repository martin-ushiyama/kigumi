import { describe, expect, it } from 'vitest';
import { COORD_LIMIT, OP_MAX_CELLS } from '../src/core/limits';
import { decodeOrientation, encodeOrientation, packCell, unpackCell } from '../src/core/orientation';
import type { GroupNode } from '../src/core/scenetree';
import { parseCellKey } from '../src/core/types';
import {
  buildDeleteSelection,
  buildDuplicate,
  buildGroup,
  buildMirror,
  buildMove,
  buildMoveCellsToGroup,
  buildMoveCellToGroup,
  buildRename,
  buildReparentGroup,
  buildReparentGroups,
  buildRotateGroup90,
  buildSetCell,
  buildToggleHidden,
  buildToggleLocked,
  buildUngroup,
  clampDeltaToBounds,
  computeDropIndex,
  computeDropIndexFor,
  dragPayloadFor,
} from '../src/editor/ops';
import type { NormalizedSelection } from '../src/editor/selection';
import { DocumentFixture } from './helpers/document-fixture';

function makeDoc(): DocumentFixture {
  return new DocumentFixture();
}

describe('buildGroup — cells selection', () => {
  it('creates a new group directly under root and reassigns all selected cells to it. newSelection is the new group id', () => {
    const doc = makeDoc();
    doc.setCells([
      [0, 0, 0, 1],
      [1, 0, 0, 2],
    ]);

    const result = buildGroup(doc, doc.cellSelection([0, 0, 0], [1, 0, 0]), 'Group');
    if ('error' in result) throw new Error('unexpected error');
    expect(result.newSelection).toEqual({ kind: 'groups', ids: [expect.any(String)] });
    const newId = (result.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;

    doc.applyTransaction(result.tx);
    expect(doc.tree.getNode(newId)).toBeDefined();
    expect(doc.ownerAt(0, 0, 0)).toBe(newId);
    expect(doc.ownerAt(1, 0, 0)).toBe(newId);

    doc.undo();
    expect(doc.tree.getNode(newId)).toBeUndefined();
    expect(doc.ownerAt(0, 0, 0)).toBeNull();
    expect(doc.ownerAt(1, 0, 0)).toBeNull();
  });

  it('{kind: "none"} returns an error', () => {
    const doc = makeDoc();
    const result = buildGroup(doc, doc.noneSelection(), 'Group');
    expect('error' in result).toBe(true);
  });
});

describe('buildGroup — groups selection', () => {
  it('selecting 2 sibling groups directly under root creates the new group directly under root too, with both becoming its children', () => {
    const doc = makeDoc();
    const a: GroupNode = { id: 'a', name: 'A', parentId: null, childIds: [] };
    const b: GroupNode = { id: 'b', name: 'B', parentId: null, childIds: [] };
    doc.insertGroup(a, 0);
    doc.insertGroup(b, 1);

    const result = buildGroup(doc, doc.groupSelection('a', 'b'), 'Group');
    if ('error' in result) throw new Error('unexpected error');
    const newId = (result.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;
    doc.applyTransaction(result.tx);

    expect(doc.tree.getNode(newId)?.parentId).toBeNull();
    expect(doc.tree.childrenOf(newId)).toEqual(['a', 'b']);
    expect(doc.tree.getNode('a')?.parentId).toBe(newId);
    expect(doc.tree.getNode('b')?.parentId).toBe(newId);
  });

  it('selecting 2 groups under the same intermediate parent in a 3-level tree creates the new group under that intermediate parent (not root)', () => {
    const doc = makeDoc();
    const mid: GroupNode = { id: 'mid', name: 'mid', parentId: null, childIds: [] };
    const a: GroupNode = { id: 'a', name: 'A', parentId: 'mid', childIds: [] };
    const b: GroupNode = { id: 'b', name: 'B', parentId: 'mid', childIds: [] };
    doc.insertGroup(mid, 0);
    doc.insertGroup(a, 0);
    doc.insertGroup(b, 1);

    const result = buildGroup(doc, doc.groupSelection('a', 'b'), 'Group');
    if ('error' in result) throw new Error('unexpected error');
    const newId = (result.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;
    doc.applyTransaction(result.tx);

    expect(doc.tree.getNode(newId)?.parentId).toBe('mid');
    expect(doc.tree.childrenOf('mid')).toEqual([newId]);
    expect(doc.tree.getNode('a')?.parentId).toBe(newId);
    expect(doc.tree.getNode('b')?.parentId).toBe(newId);
  });
});

describe('buildUngroup', () => {
  it('ungrouping a group with 2 direct cells + 1 child group lifts the contents to the parent and removes itself. undo fully restores it', () => {
    const doc = makeDoc();
    // childIds starts as [] because insertNode(child, ...) splices it into the parent's array
    // (the group variable and the object in the tree are the same reference, so later toEqual comparisons match automatically)
    const group: GroupNode = { id: 'g', name: 'G', parentId: null, childIds: [] };
    const child: GroupNode = { id: 'child', name: 'child', parentId: 'g', childIds: [] };
    doc.insertGroup(group, 0);
    doc.insertGroup(child, 0);
    doc.setCells([
      [0, 0, 0, 1],
      [1, 0, 0, 2],
    ]);
    doc.setCellMembership('0,0,0', 'g');
    doc.setCellMembership('1,0,0', 'g');

    const result = buildUngroup(doc, ['g']);
    if ('error' in result) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);

    expect(doc.tree.getNode('g')).toBeUndefined();
    expect(doc.ownerAt(0, 0, 0)).toBeNull();
    expect(doc.ownerAt(1, 0, 0)).toBeNull();
    expect(doc.tree.getNode('child')?.parentId).toBeNull();
    expect(doc.tree.childrenOf(null)).toContain('child');

    doc.undo();
    // 'g' is rebuilt from insertNode(childIds:[]) by undo after being deleteGroup'd, and
    // 'child's reparent backward is spliced into it — since this doesn't match the original
    // group variable (a different object reference), the expected value is written explicitly (it is correct as a value)
    expect(doc.tree.getNode('g')).toEqual({ id: 'g', name: 'G', parentId: null, childIds: ['child'] });
    expect(doc.ownerAt(0, 0, 0)).toBe('g');
    expect(doc.ownerAt(1, 0, 0)).toBe('g');
    expect(doc.tree.getNode('child')?.parentId).toBe('g');
    expect(doc.tree.childrenOf('g')).toEqual(['child']);
  });
});

describe('buildDeleteSelection — cells', () => {
  it('deletes only the selected cells and clears membership too. undo restores', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g', name: 'G', parentId: null, childIds: [] }, 0);
    doc.setCells([[0, 0, 0, 1]]);
    doc.setCellMembership('0,0,0', 'g');

    const result = buildDeleteSelection(doc, doc.cellSelection([0, 0, 0]));
    if (!('tx' in result)) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);

    expect(doc.world.has(0, 0, 0)).toBe(false);
    expect(doc.ownerAt(0, 0, 0)).toBeNull();

    doc.undo();
    expect(doc.world.has(0, 0, 0)).toBe(true);
    expect(doc.ownerAt(0, 0, 0)).toBe('g');
  });
});

describe('buildDeleteSelection — groups', () => {
  it('deleting a 2-level nested group (parent 1 cell + child group 2 cells) removes all cells + both groups, and undo fully restores in 1 step', () => {
    const doc = makeDoc();
    // childIds starts as [] because insertNode(child, ...) splices it into the parent's array
    // (the parent variable and the object in the tree are the same reference, so later toEqual comparisons match automatically)
    const parent: GroupNode = { id: 'p', name: 'parent', parentId: null, childIds: [] };
    const child: GroupNode = { id: 'c', name: 'child', parentId: 'p', childIds: [] };
    doc.insertGroup(parent, 0);
    doc.insertGroup(child, 0);
    doc.setCells([
      [0, 0, 0, 1], // belongs directly to parent
      [1, 0, 0, 2], // belongs directly to child
      [2, 0, 0, 3], // belongs directly to child
    ]);
    doc.setCellMembership('0,0,0', 'p');
    doc.setCellMembership('1,0,0', 'c');
    doc.setCellMembership('2,0,0', 'c');

    const result = buildDeleteSelection(doc, doc.groupSelection('p'));
    if (!('tx' in result)) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);

    expect(doc.world.has(0, 0, 0)).toBe(false);
    expect(doc.world.has(1, 0, 0)).toBe(false);
    expect(doc.world.has(2, 0, 0)).toBe(false);
    expect(doc.tree.getNode('p')).toBeUndefined();
    expect(doc.tree.getNode('c')).toBeUndefined();

    doc.undo();
    expect(doc.world.has(0, 0, 0)).toBe(true);
    expect(doc.world.has(1, 0, 0)).toBe(true);
    expect(doc.world.has(2, 0, 0)).toBe(true);
    // 'p' is rebuilt from insertNode(childIds:[]) by undo after being deleteGroup'd, and
    // 'c's deleteGroup backward (insertNode) is spliced into it — since this doesn't match
    // the original parent variable (a different object reference), the expected value is written explicitly (it is correct as a value)
    expect(doc.tree.getNode('p')).toEqual({ id: 'p', name: 'parent', parentId: null, childIds: ['c'] });
    expect(doc.tree.getNode('c')).toEqual(child);
    expect(doc.tree.childrenOf('p')).toEqual(['c']);
    // confirm childIds has no duplicates (could duplicate if there were a rebuild bug from the deleteGroup snapshot as [])
    expect(doc.tree.childrenOf('p').length).toBe(1);
    expect(doc.tree.childrenOf(null)).toEqual(['p']);
    expect(doc.ownerAt(0, 0, 0)).toBe('p');
    expect(doc.ownerAt(1, 0, 0)).toBe('c');
    expect(doc.ownerAt(2, 0, 0)).toBe('c');
  });

  it('deleting a single completely empty group (0 cells, 0 children) removes only that group, with no issues in either apply/undo', () => {
    const doc = makeDoc();
    const empty: GroupNode = { id: 'e', name: 'empty', parentId: null, childIds: [] };
    doc.insertGroup(empty, 0);

    const result = buildDeleteSelection(doc, doc.groupSelection('e'));
    if (!('tx' in result)) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);
    expect(doc.tree.getNode('e')).toBeUndefined();

    doc.undo();
    expect(doc.tree.getNode('e')).toEqual(empty);
  });

  it('selecting parent and child at the same time does not throw from double-processing; both are deleted together in one pass', () => {
    const doc = makeDoc();
    const parent: GroupNode = { id: 'p', name: 'parent', parentId: null, childIds: [] };
    const child: GroupNode = { id: 'c', name: 'child', parentId: 'p', childIds: [] };
    doc.insertGroup(parent, 0);
    doc.insertGroup(child, 0);
    doc.setCells([
      [0, 0, 0, 1],
      [1, 0, 0, 2],
    ]);
    doc.setCellMembership('0,0,0', 'p');
    doc.setCellMembership('1,0,0', 'c');

    // select parent and child at the same time (the state that occurs with Ctrl+click in the layer panel)
    const result = buildDeleteSelection(doc, doc.groupSelection('p', 'c'));
    if (!('tx' in result)) throw new Error('unexpected error');
    expect(() => doc.applyTransaction(result.tx)).not.toThrow();
    expect(doc.world.has(0, 0, 0)).toBe(false);
    expect(doc.world.has(1, 0, 0)).toBe(false);
    expect(doc.tree.getNode('p')).toBeUndefined();
    expect(doc.tree.getNode('c')).toBeUndefined();
  });

  it('a locked group (including descendants) is excluded from deletion; the rest of the selection is deleted', () => {
    const doc = makeDoc();
    const locked: GroupNode = { id: 'l', name: 'locked', parentId: null, childIds: [], locked: true };
    const free: GroupNode = { id: 'f', name: 'free', parentId: null, childIds: [] };
    doc.insertGroup(locked, 0);
    doc.insertGroup(free, 1);
    doc.setCells([
      [0, 0, 0, 1],
      [5, 0, 0, 2],
    ]);
    doc.setCellMembership('0,0,0', 'l');
    doc.setCellMembership('5,0,0', 'f');

    const result = buildDeleteSelection(doc, doc.groupSelection('l', 'f'));
    if (!('tx' in result)) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);

    expect(doc.world.has(0, 0, 0)).toBe(true); // unaffected while locked
    expect(doc.tree.getNode('l')).toBeDefined();
    expect(doc.world.has(5, 0, 0)).toBe(false); // non-locked is deleted
    expect(doc.tree.getNode('f')).toBeUndefined();
  });
});

describe('buildRename', () => {
  it('is a no-op when the name does not change (ops: [])', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g', name: 'G', parentId: null, childIds: [] }, 0);
    const tx = buildRename(doc, 'g', 'G');
    expect(tx.ops).toEqual([]);
  });

  it('is a no-op for a nonexistent id (ops: [])', () => {
    const doc = makeDoc();
    const tx = buildRename(doc, 'ghost', 'something');
    expect(tx.ops).toEqual([]);
  });

  it('builds a renameGroup op that changes the name, and undo reverts it', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g', name: 'G', parentId: null, childIds: [] }, 0);
    const tx = buildRename(doc, 'g', 'new name');
    expect(tx.ops.length).toBe(1);
    doc.applyTransaction(tx);
    expect(doc.tree.getNode('g')?.name).toBe('new name');

    doc.undo();
    expect(doc.tree.getNode('g')?.name).toBe('G');
  });
});

describe('buildToggleHidden / buildToggleLocked', () => {
  it('is a no-op for a nonexistent id (ops: [])', () => {
    const doc = makeDoc();
    expect(buildToggleHidden(doc, 'ghost').ops).toEqual([]);
    expect(buildToggleLocked(doc, 'ghost').ops).toEqual([]);
  });

  it('toggles hidden false→true→false, and undo also flips it', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g', name: 'G', parentId: null, childIds: [] }, 0);

    const tx1 = buildToggleHidden(doc, 'g');
    expect(tx1.ops).toEqual([{ kind: 'setGroupHidden', id: 'g', before: false, after: true }]);
    doc.applyTransaction(tx1);
    expect(doc.tree.getNode('g')?.hidden).toBe(true);

    const tx2 = buildToggleHidden(doc, 'g');
    expect(tx2.ops).toEqual([{ kind: 'setGroupHidden', id: 'g', before: true, after: false }]);
    doc.applyTransaction(tx2);
    expect(doc.tree.getNode('g')?.hidden).toBe(false);

    doc.undo();
    expect(doc.tree.getNode('g')?.hidden).toBe(true);
  });

  it('toggles locked false→true→false, and undo also flips it', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g', name: 'G', parentId: null, childIds: [] }, 0);

    const tx1 = buildToggleLocked(doc, 'g');
    expect(tx1.ops).toEqual([{ kind: 'setGroupLocked', id: 'g', before: false, after: true }]);
    doc.applyTransaction(tx1);
    expect(doc.tree.getNode('g')?.locked).toBe(true);

    const tx2 = buildToggleLocked(doc, 'g');
    expect(tx2.ops).toEqual([{ kind: 'setGroupLocked', id: 'g', before: true, after: false }]);
    doc.applyTransaction(tx2);
    expect(doc.tree.getNode('g')?.locked).toBe(false);

    doc.undo();
    expect(doc.tree.getNode('g')?.locked).toBe(true);
  });
});

describe('buildSetCell', () => {
  it("replaces the cell's value with a single voxel op, and undo reverts it", () => {
    const doc = makeDoc();
    doc.setCells([[0, 0, 0, 1]]);
    const tx = buildSetCell(doc, doc.cellAt(0, 0, 0).ref, 5);
    expect(tx.ops).toEqual([{ kind: 'voxel', owner: null, key: '0,0,0', before: 1, after: 5 }]);

    doc.applyTransaction(tx);
    expect(doc.world.get(0, 0, 0)).toBe(5);

    doc.undo();
    expect(doc.world.get(0, 0, 0)).toBe(1);
  });

  it('is a no-op when after equals the current value (ops: [])', () => {
    const doc = makeDoc();
    doc.setCells([[0, 0, 0, 1]]);
    const tx = buildSetCell(doc, doc.cellAt(0, 0, 0).ref, 1);
    expect(tx.ops).toEqual([]);
  });

  it('is a no-op for a nonexistent cell (ops: [])', () => {
    const doc = makeDoc();
    const tx = buildSetCell(doc, doc.cellAt(0, 0, 0).ref, 5);
    expect(tx.ops).toEqual([]);
  });
});

describe('buildMove', () => {
  it('a simple move with no overlap (fully restored by undo)', () => {
    const doc = makeDoc();
    doc.setCells([[0, 0, 0, 1]]);
    const result = buildMove(doc, [doc.cellAt(0, 0, 0).ref], [1, 0, 0]);
    if ('error' in result) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);
    expect(doc.world.has(0, 0, 0)).toBe(false);
    expect(doc.world.get(1, 0, 0)).toBe(1);
    // Selection tracking goes through Transaction.remap, not newSelection
    // (SelectionStore applies old ref → new ref on the commit notification)
    expect([...(result.tx.remap ?? new Map())]).toEqual([[
      '-|0,0,0',
      { ownerId: null, localCell: [1, 0, 0] },
    ]]);

    doc.undo();
    expect(doc.world.get(0, 0, 0)).toBe(1);
    expect(doc.world.has(1, 0, 0)).toBe(false);
  });

  it('a move that overlaps a cell of a different owner coexists without destroying the other side (the winner is decided by paint order B1b)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'gv', name: 'victim-group', parentId: null, childIds: [] }, 0);
    doc.setCells([
      [0, 0, 0, 1], // the cell being moved (unowned = root)
      [1, 0, 0, 9], // a cell already at the destination (belongs to victim-group)
    ]);
    doc.setCellMembership('1,0,0', 'gv');

    const result = buildMove(doc, [doc.cellAt(0, 0, 0).ref], [1, 0, 0]);
    if ('error' in result) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);

    // even with the same world coordinate, both can exist if the owner differs (in the old
    // world-key model one side would disappear).
    // The visible winner is decided by paint order — a group renders in front of root, so gv's 9 is visible
    expect(doc.rawCells.get(null, '1,0,0')).toBe(1); // the root cell that moved in
    expect(doc.rawCells.get('gv', '1,0,0')).toBe(9); // the cell that was already there is unaffected
    expect(doc.world.get(1, 0, 0)).toBe(9);
    expect(doc.ownerAt(1, 0, 0)).toBe('gv');
    expect(doc.rawCells.has(null, '0,0,0')).toBe(false); // the source is now empty

    doc.undo();
    expect(doc.rawCells.has(null, '1,0,0')).toBe(false); // the move rolls back
    expect(doc.rawCells.get('gv', '1,0,0')).toBe(9);
    expect(doc.world.get(0, 0, 0)).toBe(1);
  });

  it('when 2 adjacent cells in the same group move so as to swap places, no extra erase is stacked at the shared position', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g', name: 'G', parentId: null, childIds: [] }, 0);
    doc.setCells([
      [0, 0, 0, 1], // A
      [1, 0, 0, 2], // B
    ]);
    doc.setCellMembership('0,0,0', 'g');
    doc.setCellMembership('1,0,0', 'g');

    const result = buildMove(doc, [doc.cellAt(0, 0, 0).ref, doc.cellAt(1, 0, 0).ref], [1, 0, 0]);
    if ('error' in result) throw new Error('unexpected error');
    const ops = result.tx.ops;

    // Membership is held by the owner-local store so there is no membership op.
    // Within the same owner, a move becomes "place at the landing spot → erase only the
    // original position that nobody lands on"
    const isVoxel = (op: (typeof ops)[number]): op is Extract<(typeof ops)[number], { kind: 'voxel' }> => op.kind === 'voxel';
    // "1,0,0" (A's landing spot and also B's original position) only gets a place, no erase
    expect(ops.filter(isVoxel).filter((op) => op.key === '1,0,0' && op.after === null)).toHaveLength(0);
    expect(ops.filter(isVoxel).some((op) => op.owner === 'g' && op.key === '1,0,0' && op.after === 1)).toBe(true);
    // place at "2,0,0" (B's landing spot, originally empty)
    expect(ops.filter(isVoxel).some((op) => op.owner === 'g' && op.key === '2,0,0' && op.after === 2)).toBe(true);
    // "0,0,0" (A's original position, nobody lands there) gets erased
    expect(ops.filter(isVoxel).some((op) => op.owner === 'g' && op.key === '0,0,0' && op.after === null)).toBe(true);

    doc.applyTransaction(result.tx);
    expect(doc.world.get(1, 0, 0)).toBe(1); // A's value
    expect(doc.world.get(2, 0, 0)).toBe(2); // B's value
    expect(doc.ownerAt(1, 0, 0)).toBe('g');
    expect(doc.ownerAt(2, 0, 0)).toBe('g');
    expect(doc.ownerAt(0, 0, 0)).toBeNull();

    doc.undo();
    expect(doc.world.get(0, 0, 0)).toBe(1);
    expect(doc.world.get(1, 0, 0)).toBe(2);
    expect(doc.ownerAt(0, 0, 0)).toBe('g');
    expect(doc.ownerAt(1, 0, 0)).toBe('g');
  });

  it('returns an empty transaction when delta is [0,0,0]', () => {
    const doc = makeDoc();
    doc.setCells([[0, 0, 0, 1]]);
    const result = buildMove(doc, [doc.cellAt(0, 0, 0).ref], [0, 0, 0]);
    expect(result).toEqual({ tx: { ops: [] } });
  });

  it('returns an error for a move out of range', () => {
    const doc = makeDoc();
    doc.setCells([[COORD_LIMIT, 0, 0, 1]]);
    const result = buildMove(doc, [], [1, 0, 0]);
    expect('error' in result).toBe(true);
  });

  it('returns an error for an empty selection', () => {
    const doc = makeDoc();
    const result = buildMove(doc, [], [1, 0, 0]);
    expect('error' in result).toBe(true);
  });

  it('returns an error for a selection exceeding OP_MAX_CELLS (guards the path where the caller does not pre-check, a review finding)', () => {
    const doc = makeDoc();
    const refs = Array.from({ length: OP_MAX_CELLS + 1 }, (_, i) => doc.cellAt(i, 0, 0).ref);
    const result = buildMove(doc, refs, [0, 1, 0]);
    expect('error' in result).toBe(true);
  });

  it('locked cells are excluded from the move target (only non-locked cells move)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'l', name: 'locked', parentId: null, childIds: [], locked: true }, 0);
    doc.setCells([
      [0, 0, 0, 1], // locked
      [5, 0, 0, 2], // non-locked
    ]);
    doc.setCellMembership('0,0,0', 'l');

    const result = buildMove(doc, [doc.cellAt(0, 0, 0).ref, doc.cellAt(5, 0, 0).ref], [1, 0, 0]);
    if ('error' in result) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);
    expect(doc.world.has(0, 0, 0)).toBe(true); // locked does not move
    expect(doc.world.has(1, 0, 0)).toBe(false);
    expect(doc.world.has(5, 0, 0)).toBe(false); // non-locked moves
    expect(doc.world.get(6, 0, 0)).toBe(2);
  });
});

describe('buildDuplicate — cells', () => {
  it('duplicates at the +X adjacent offset when it is within coordinate range', () => {
    const doc = makeDoc();
    doc.setCells([[0, 0, 0, 1]]);
    const result = buildDuplicate(doc, doc.cellSelection([0, 0, 0]));
    if ('error' in result) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);
    expect(doc.world.get(0, 0, 0)).toBe(1); // the original remains
    expect(doc.world.get(1, 0, 0)).toBe(1); // +X adjacent (x+1 since the bbox has width 1)
    // the projected destination of a newly created ref is only known after applying, so the selection is returned via newSelectionRefs
    expect(result.newSelectionRefs).toEqual([{ ownerId: null, localCell: [1, 0, 0] }]);
  });

  it('candidate offsets are judged only by coordinate range (isValidCell) — overwrites even an occupied cell (project spec "collisions overwrite, undo is possible")', () => {
    const doc = makeDoc();
    doc.setCells([
      [0, 0, 0, 1],
      [1, 0, 0, 9], // even if the +X adjacent spot is already occupied, it is adopted as a candidate since it is within coordinate range
    ]);
    const result = buildDuplicate(doc, doc.cellSelection([0, 0, 0]));
    if ('error' in result) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);
    expect(doc.world.get(1, 0, 0)).toBe(1); // overwrites the occupied destination

    doc.undo();
    expect(doc.world.get(1, 0, 0)).toBe(9); // the overwritten original value is restored by undo
  });

  it('falls through to the next candidate (-X) when the +X adjacent is out of coordinate range', () => {
    const doc = makeDoc();
    doc.setCells([[COORD_LIMIT, 0, 0, 1]]); // the +X adjacent (COORD_LIMIT+1) is out of range
    const result = buildDuplicate(doc, doc.cellSelection([COORD_LIMIT, 0, 0]));
    if ('error' in result) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);
    expect(doc.world.get(COORD_LIMIT - 1, 0, 0)).toBe(1); // duplicated to the -X adjacent
  });

  it('returns an error when the bbox is too large for the coordinate range so all 5 candidates are out of range', () => {
    const doc = makeDoc();
    // bbox min=(-256,0,-256) max=(256,256,256) → sx=513,sy=257,sz=513,
    // adding any of ±X/±Z/+Y offsets exceeds isValidCell (COORD_LIMIT=512)
    doc.setCells([
      [-256, 0, -256, 1],
      [256, 256, 256, 2],
    ]);
    const result = buildDuplicate(doc, doc.cellSelection([-256, 0, -256], [256, 256, 256]));
    expect('error' in result).toBe(true);
  });

  it('returns an error for a selection exceeding OP_MAX_CELLS', () => {
    const doc = makeDoc();
    const cells: Array<[number, number, number]> = Array.from({ length: OP_MAX_CELLS + 1 }, (_, i) => [i, 0, 0]);
    const result = buildDuplicate(doc, doc.cellSelection(...cells));
    expect('error' in result).toBe(true);
  });
});

describe('buildDuplicate — groups', () => {
  it('deep-copies a 2-level nested group under a new id (undo removes it wholesale)', () => {
    const doc = makeDoc();
    const parent: GroupNode = { id: 'p', name: 'parent', parentId: null, childIds: [] };
    const child: GroupNode = { id: 'c', name: 'child', parentId: 'p', childIds: [] };
    doc.insertGroup(parent, 0);
    doc.insertGroup(child, 0);
    doc.setCells([
      [0, 0, 0, 1], // belongs directly to parent
      [1, 0, 0, 2], // belongs directly to child
    ]);
    doc.setCellMembership('0,0,0', 'p');
    doc.setCellMembership('1,0,0', 'c');

    const result = buildDuplicate(doc, doc.groupSelection('p'));
    if ('error' in result) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);

    expect(result.newSelection?.kind).toBe('groups');
    const newParentId = (result.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;
    expect(newParentId).not.toBe('p');

    const newChildIds = doc.tree.childrenOf(newParentId);
    expect(newChildIds.length).toBe(1);
    const newChildId = newChildIds[0]!;
    expect(newChildId).not.toBe('c');
    expect(doc.tree.getNode(newParentId)?.name).toBe('parent');
    expect(doc.tree.getNode(newChildId)?.name).toBe('child');

    // bbox width 2 (x:0..1), so the +X adjacent offset is [2,0,0]
    expect(doc.ownerAt(2, 0, 0)).toBe(newParentId);
    expect(doc.ownerAt(3, 0, 0)).toBe(newChildId);
    expect(doc.world.get(2, 0, 0)).toBe(1);
    expect(doc.world.get(3, 0, 0)).toBe(2);

    // the original group and cells are untouched
    expect(doc.tree.getNode('p')).toBeDefined();
    expect(doc.tree.getNode('c')).toBeDefined();
    expect(doc.world.get(0, 0, 0)).toBe(1);
    expect(doc.world.get(1, 0, 0)).toBe(2);

    doc.undo();
    expect(doc.tree.getNode(newParentId)).toBeUndefined();
    expect(doc.tree.getNode(newChildId)).toBeUndefined();
    expect(doc.world.has(2, 0, 0)).toBe(false);
    expect(doc.world.has(3, 0, 0)).toBe(false);
    // the original is intact
    expect(doc.tree.getNode('p')).toBeDefined();
    expect(doc.world.get(0, 0, 0)).toBe(1);
  });

  it('selecting parent and child at the same time does not duplicate the child twice', () => {
    const doc = makeDoc();
    const parent: GroupNode = { id: 'p', name: 'parent', parentId: null, childIds: [] };
    const child: GroupNode = { id: 'c', name: 'child', parentId: 'p', childIds: [] };
    doc.insertGroup(parent, 0);
    doc.insertGroup(child, 0);
    doc.setCells([[0, 0, 0, 1]]);
    doc.setCellMembership('0,0,0', 'c');

    const result = buildDuplicate(doc, doc.groupSelection('p', 'c'));
    if ('error' in result) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);

    // after duplication, only 1 new group in the 'parent' lineage exists (the child was not duplicated separately as another one)
    const newIds = [...doc.tree.allNodesPreOrder()].map((n) => n.id).filter((id) => id !== 'p' && id !== 'c');
    expect(newIds).toHaveLength(2); // only the duplicated parent+child
  });
});

describe('clampDeltaToBounds', () => {
  it('returns delta as-is when it fits within range (no-op)', () => {
    const bbox = { min: [0, 0, 0] as const, max: [1, 1, 1] as const };
    expect(clampDeltaToBounds(bbox, [1, 1, 1])).toEqual([1, 1, 1]);
  });

  it('clamps a positive-direction overshoot on x/z', () => {
    const bbox = { min: [COORD_LIMIT - 1, 0, 0] as const, max: [COORD_LIMIT, 0, 0] as const };
    const [dx] = clampDeltaToBounds(bbox, [10, 0, 0]);
    expect(dx).toBe(0); // max is already COORD_LIMIT, so it cannot move in the + direction
  });

  it('clamps a negative-direction overshoot on x/z', () => {
    const bbox = { min: [-COORD_LIMIT, 0, 0] as const, max: [-COORD_LIMIT + 1, 0, 0] as const };
    const [dx] = clampDeltaToBounds(bbox, [-10, 0, 0]);
    expect(dx).toBe(0); // min is already -COORD_LIMIT, so it cannot move in the - direction
  });

  it('y has a floor at 0; no matter how far it tries to move negatively, it never goes below 0', () => {
    const bbox = { min: [0, 0, 0] as const, max: [0, 3, 0] as const };
    const [, dy] = clampDeltaToBounds(bbox, [0, -100, 0]);
    expect(dy).toBe(0); // min.y is already 0, so it cannot move in the - direction
  });
});

describe('computeDropIndex', () => {
  it('inserting into a different array (a different parent) finds no draggedId, so no adjustment', () => {
    expect(computeDropIndex(['x', 'y'], 'q', 'x', 'before')).toBe(0);
    expect(computeDropIndex(['x', 'y'], 'q', 'x', 'after')).toBe(1);
    expect(computeDropIndex(['x', 'y'], 'q', 'y', 'after')).toBe(2);
  });

  it('moving from front to back within the same array shifts up by the amount removed', () => {
    // in ['a','b','c'], moving a to after b: after removal it inserts into ['b','c'], so effectively index 1
    expect(computeDropIndex(['a', 'b', 'c'], 'a', 'b', 'after')).toBe(1);
  });

  it('moving from back to front within the same array needs no shift-up', () => {
    // in ['a','b','c'], moving c to before a: a's position stays index 0 even after removal
    expect(computeDropIndex(['a', 'b', 'c'], 'c', 'a', 'before')).toBe(0);
  });
});

describe('buildReparentGroup', () => {
  it('reordering siblings (within the same parent) generates a reparentGroup op with the correct index', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'a', name: 'A', parentId: null, childIds: [] }, 0);
    doc.insertGroup({ id: 'b', name: 'B', parentId: null, childIds: [] }, 1);
    doc.insertGroup({ id: 'c', name: 'C', parentId: null, childIds: [] }, 2);

    // move a to after b (['a','b','c'] → ['b','a','c'])
    const targetIndex = computeDropIndex(doc.tree.childrenOf(null), 'a', 'b', 'after');
    const result = buildReparentGroup(doc, 'a', null, targetIndex);
    if ('error' in result) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);
    expect(doc.tree.childrenOf(null)).toEqual(['b', 'a', 'c']);

    doc.undo();
    expect(doc.tree.childrenOf(null)).toEqual(['a', 'b', 'c']);
  });

  it('can move (reparent) to a different group', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'src', name: 'src', parentId: null, childIds: [] }, 0);
    doc.insertGroup({ id: 'dst', name: 'dst', parentId: null, childIds: [] }, 1);
    doc.insertGroup({ id: 'child', name: 'child', parentId: 'src', childIds: [] }, 0);

    const result = buildReparentGroup(doc, 'child', 'dst', 0);
    if ('error' in result) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);
    expect(doc.tree.childrenOf('src')).toEqual([]);
    expect(doc.tree.childrenOf('dst')).toEqual(['child']);
    expect(doc.tree.getNode('child')?.parentId).toBe('dst');
  });

  it('cannot move into itself (cycle prevention)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'a', name: 'A', parentId: null, childIds: [] }, 0);
    const result = buildReparentGroup(doc, 'a', 'a', 0);
    expect('error' in result).toBe(true);
  });

  it('cannot move into its own descendant (cycle prevention)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'p', name: 'parent', parentId: null, childIds: [] }, 0);
    doc.insertGroup({ id: 'c', name: 'child', parentId: 'p', childIds: [] }, 0);
    doc.insertGroup({ id: 'gc', name: 'grandchild', parentId: 'c', childIds: [] }, 0);
    const result = buildReparentGroup(doc, 'p', 'gc', 0);
    expect('error' in result).toBe(true);
  });

  it('a locked group itself cannot be moved', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'l', name: 'locked', parentId: null, childIds: [], locked: true }, 0);
    doc.insertGroup({ id: 'dst', name: 'dst', parentId: null, childIds: [] }, 1);
    const result = buildReparentGroup(doc, 'l', 'dst', 0);
    expect('error' in result).toBe(true);
  });

  it('cannot move into a locked group', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'a', name: 'A', parentId: null, childIds: [] }, 0);
    doc.insertGroup({ id: 'l', name: 'locked', parentId: null, childIds: [], locked: true }, 1);
    const result = buildReparentGroup(doc, 'a', 'l', 0);
    expect('error' in result).toBe(true);
  });

  it('returns an error for a nonexistent group', () => {
    const doc = makeDoc();
    const result = buildReparentGroup(doc, 'ghost', null, 0);
    expect('error' in result).toBe(true);
  });
});

describe('buildMoveCellToGroup', () => {
  it('moves a cell to a different group (membership op only, restored by undo)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g', name: 'G', parentId: null, childIds: [] }, 0);
    doc.setCells([[0, 0, 0, 1]]);

    const result = buildMoveCellToGroup(doc, doc.cellAt(0, 0, 0).ref, 'g');
    if ('error' in result) throw new Error('unexpected error');
    // a membership change is expressed as a pair "erase from the old owner + place into the new owner"
    expect(result.tx.ops).toEqual([
      { kind: 'voxel', owner: null, key: '0,0,0', before: 1, after: null },
      { kind: 'voxel', owner: 'g', key: '0,0,0', before: null, after: 1 },
    ]);
    doc.applyTransaction(result.tx);
    expect(doc.ownerAt(0, 0, 0)).toBe('g');

    doc.undo();
    expect(doc.ownerAt(0, 0, 0)).toBeNull();
  });

  it('passing null returns it to unclassified (root)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g', name: 'G', parentId: null, childIds: [] }, 0);
    doc.setCells([[0, 0, 0, 1]]);
    doc.setCellMembership('0,0,0', 'g');

    const result = buildMoveCellToGroup(doc, doc.cellAt(0, 0, 0).ref, null);
    if ('error' in result) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);
    expect(doc.ownerAt(0, 0, 0)).toBeNull();
  });

  it('moving to the same group is a no-op', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g', name: 'G', parentId: null, childIds: [] }, 0);
    doc.setCells([[0, 0, 0, 1]]);
    doc.setCellMembership('0,0,0', 'g');
    const result = buildMoveCellToGroup(doc, doc.cellAt(0, 0, 0).ref, 'g');
    if ('error' in result) throw new Error('unexpected error');
    expect(result.tx.ops).toEqual([]);
  });

  it('a locked cell cannot be moved', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'l', name: 'locked', parentId: null, childIds: [], locked: true }, 0);
    doc.insertGroup({ id: 'dst', name: 'dst', parentId: null, childIds: [] }, 1);
    doc.setCells([[0, 0, 0, 1]]);
    doc.setCellMembership('0,0,0', 'l');
    const result = buildMoveCellToGroup(doc, doc.cellAt(0, 0, 0).ref, 'dst');
    expect('error' in result).toBe(true);
  });

  it('cannot move into a locked group', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'l', name: 'locked', parentId: null, childIds: [], locked: true }, 0);
    doc.setCells([[0, 0, 0, 1]]);
    const result = buildMoveCellToGroup(doc, doc.cellAt(0, 0, 0).ref, 'l');
    expect('error' in result).toBe(true);
  });
});

/**
 * Rebasing a group with no transform set.
 *
 * Root cause: `transform === undefined` was interpreted as **world identity**.
 * In reality it is "identity **relative to the old parent**", so in operations that change
 * the parent chain, unless the unset group is also rebased, the position/rotation it
 * inherited from the old parent disappears.
 *
 * `buildUngroup` / `buildReparentGroup` rebased `?? initialTransformOf`, but `buildGroup`
 * (groups selection) alone bailed out early via `if (node.transform !== undefined)`.
 */
describe('buildGroup — merges transform-unset groups under different parents (review P1)', () => {
  function twoParents(): DocumentFixture {
    const doc = makeDoc();
    // P has 90-degree rotation + translate, Q has translate only. Neither child has a transform set
    doc.insertGroup(
      { id: 'p', name: 'P', parentId: null, childIds: [], transform: { angleSteps: 1, translate: [10, 0, 0], pivot2: [0, 0] } },
      0,
    );
    doc.insertGroup({ id: 'c', name: 'C', parentId: 'p', childIds: [] }, 0);
    doc.insertGroup(
      { id: 'q', name: 'Q', parentId: null, childIds: [], transform: { angleSteps: 0, translate: [0, 2, 5], pivot2: [0, 0] } },
      1,
    );
    doc.insertGroup({ id: 'd', name: 'D', parentId: 'q', childIds: [] }, 0);
    doc.setOwnerCells('c', [['0,0,0', 1]]);
    doc.setOwnerCells('d', [['0,0,0', 2]]);
    return doc;
  }

  it("merging C (under P) and D (under Q) directly under root keeps every ref's worldCell and world raw unchanged", () => {
    const doc = twoParents();
    const cRef = { ownerId: 'c', localCell: [0, 0, 0] as const };
    const dRef = { ownerId: 'd', localCell: [0, 0, 0] as const };
    const before = {
      cWorld: doc.index.worldOf(cRef),
      dWorld: doc.index.worldOf(dRef),
      cRaw: doc.index.winnerRefAt(doc.index.worldOf(cRef)!)!.raw,
      dRaw: doc.index.winnerRefAt(doc.index.worldOf(dRef)!)!.raw,
    };

    const result = buildGroup(doc, doc.groupSelection('c', 'd'), 'Group');
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);

    expect(doc.index.worldOf(cRef)).toEqual(before.cWorld);
    expect(doc.index.worldOf(dRef)).toEqual(before.dWorld);
    expect(doc.index.winnerRefAt(before.cWorld!)!.raw).toBe(before.cRaw);
    expect(doc.index.winnerRefAt(before.dWorld!)!.raw).toBe(before.dRaw);
  });

  it('undo returns to the original world placement', () => {
    const doc = twoParents();
    const cRef = { ownerId: 'c', localCell: [0, 0, 0] as const };
    const beforeWorld = doc.index.worldOf(cRef);

    const result = buildGroup(doc, doc.groupSelection('c', 'd'), 'Group');
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);
    doc.undo();

    expect(doc.index.worldOf(cRef)).toEqual(beforeWorld);
    expect(doc.tree.getNode('c')?.parentId).toBe('p');
    expect(doc.tree.getNode('c')?.transform).toBeUndefined(); // reverts to unset (not baking in identity)
  });

  it('does not stack a wasted setGroupTransform op when the parent chain does not change', () => {
    const doc = makeDoc();
    // both directly under root (= the new group's LCA is also directly under root), transform unset
    doc.insertGroup({ id: 'a', name: 'A', parentId: null, childIds: [] }, 0);
    doc.insertGroup({ id: 'b', name: 'B', parentId: null, childIds: [] }, 1);
    doc.setOwnerCells('a', [['0,0,0', 1]]);
    doc.setOwnerCells('b', [['1,0,0', 2]]);

    const result = buildGroup(doc, doc.groupSelection('a', 'b'), 'Group');
    if ('error' in result) throw new Error(result.error);
    expect(result.tx.ops.filter((op) => op.kind === 'setGroupTransform')).toHaveLength(0);
  });
});

/**
 * 90-degree rotation of a group.
 *
 * The main focus is whether the pivot rule (rev.2 blocker 5) is upheld:
 * an unset transform builds a pivot from the subtree bounds on the first rotation, and
 * thereafter **never re-derives the pivot even if the contents change or rotations stack
 * up**. Re-deriving it would mean an asymmetric group would not return after 4 rotations.
 */
describe('buildRotateGroup90', () => {
  /** An L-shaped (asymmetric) group. bounds are x=0..2 / z=0..1 so the center falls off the grid */
  function lShape(): DocumentFixture {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g', name: 'G', parentId: null, childIds: [] }, 0);
    doc.setOwnerCells('g', [
      ['0,0,0', 1],
      ['1,0,0', 1],
      ['2,0,0', 1],
      ['0,0,1', 1],
    ]);
    return doc;
  }

  function worldCellsOf(doc: DocumentFixture, owner: string): string[] {
    return [...doc.rawCells.entriesOf(owner)]
      .map(([key]) => doc.index.worldOf({ ownerId: owner, localCell: parseCellKey(key) })!.join(','))
      .sort();
  }

  function rotate(doc: DocumentFixture, id: string, turns: 1 | 2 | 3): void {
    const result = buildRotateGroup90(doc, id, turns);
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);
  }

  it('rotating 4 times returns to the original world placement (asymmetric group)', () => {
    const doc = lShape();
    const before = worldCellsOf(doc, 'g');
    for (let i = 0; i < 4; i++) rotate(doc, 'g', 1);
    expect(worldCellsOf(doc, 'g')).toEqual(before);
    expect(doc.tree.getNode('g')!.transform!.angleSteps).toBe(0);
  });

  it('1 clockwise turn and 3 counterclockwise turns end up at the same placement', () => {
    const cw = lShape();
    rotate(cw, 'g', 3);
    const ccw = lShape();
    for (let i = 0; i < 3; i++) rotate(ccw, 'g', 1);
    expect(worldCellsOf(cw, 'g')).toEqual(worldCellsOf(ccw, 'g'));
  });

  it('the first rotation of a transform-unset group bakes a pivot derived from the subtree bounds (does not place [0,0])', () => {
    const doc = lShape();
    rotate(doc, 'g', 1);
    // bounds x=0..2 (odd), z=0..1 (even) mixed parity → computePivot2 lowers the z side by 1
    expect(doc.tree.getNode('g')!.transform!.pivot2).toEqual([3, 1]);
  });

  it('the group stays roughly in its original position even after rotating (does not jump to origin-centered)', () => {
    const doc = lShape();
    rotate(doc, 'g', 1);
    // pivot [3,1] = rotation centered at world (1, 0.5). If rotated around the origin, all x would shift to 0 or below
    expect(worldCellsOf(doc, 'g').every((c) => Number(c.split(',')[0]) >= 0)).toBe(true);
  });

  it('adding cells to an already-rotated group does not move the pivot (does not re-derive the rotation center on content change)', () => {
    const doc = lShape();
    rotate(doc, 'g', 1);
    const pivotAfterFirst = doc.tree.getNode('g')!.transform!.pivot2;
    doc.setOwnerCells('g', [['20,0,20', 1]]);
    rotate(doc, 'g', 1);
    expect(doc.tree.getNode('g')!.transform!.pivot2).toEqual(pivotAfterFirst);
  });

  it('keeps the pivot even when angleSteps returns to 0 (so the next rotation is not origin-centered)', () => {
    const doc = lShape();
    for (let i = 0; i < 4; i++) rotate(doc, 'g', 1);
    const t = doc.tree.getNode('g')!.transform!;
    expect(t.angleSteps).toBe(0);
    expect(t.pivot2).toEqual([3, 1]);
  });

  it('a group with no cells at all rotates with pivot [0,0] (bounds cannot be defined)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'empty', name: 'Empty', parentId: null, childIds: [] }, 0);
    rotate(doc, 'empty', 1);
    expect(doc.tree.getNode('empty')!.transform!.pivot2).toEqual([0, 0]);
  });

  it('does not change translate (rotation only adds the angle)', () => {
    const doc = makeDoc();
    doc.insertGroup(
      { id: 'g', name: 'G', parentId: null, childIds: [], transform: { angleSteps: 0, translate: [5, 2, -3], pivot2: [1, 1] } },
      0,
    );
    doc.setOwnerCells('g', [['0,0,0', 1]]);
    rotate(doc, 'g', 1);
    const t = doc.tree.getNode('g')!.transform!;
    expect(t.translate).toEqual([5, 2, -3]);
    expect(t.pivot2).toEqual([1, 1]);
    expect(t.angleSteps).toBe(1);
  });

  it('rotating the parent rotates descendant cells with it (transform inheritance)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'p', name: 'P', parentId: null, childIds: [] }, 0);
    doc.insertGroup({ id: 'c', name: 'C', parentId: 'p', childIds: [] }, 0);
    // with only 1 cell the pivot equals that cell's own center and it would not move on rotation, so place 2 cells
    doc.setOwnerCells('c', [
      ['4,0,0', 1],
      ['5,0,0', 1],
    ]);
    const before = worldCellsOf(doc, 'c');
    rotate(doc, 'p', 1);
    expect(worldCellsOf(doc, 'c')).not.toEqual(before);
    for (let i = 0; i < 3; i++) rotate(doc, 'p', 1);
    expect(worldCellsOf(doc, 'c')).toEqual(before);
  });

  it('undo returns to transform-unset (does not leave identity baked in)', () => {
    const doc = lShape();
    const before = worldCellsOf(doc, 'g');
    rotate(doc, 'g', 1);
    doc.undo();
    expect(doc.tree.getNode('g')?.transform).toBeUndefined();
    expect(worldCellsOf(doc, 'g')).toEqual(before);
  });

  it('rejects a group that would go out of range on rotation (cannot clamp, so the whole transaction is rejected)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g', name: 'G', parentId: null, childIds: [] }, 0);
    // place a rod thin along x at the edge of z. Since the pivot is its center, rotating 90
    // degrees raises the rod along z and it exceeds COORD_LIMIT
    doc.setOwnerCells('g', [
      [`0,0,${COORD_LIMIT - 12}`, 1],
      [`${COORD_LIMIT},0,${COORD_LIMIT - 12}`, 1],
    ]);
    const result = buildRotateGroup90(doc, 'g', 1);
    expect('error' in result).toBe(true);
    expect(doc.tree.getNode('g')?.transform).toBeUndefined();
  });

  it('a locked group cannot be rotated', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g', name: 'G', parentId: null, childIds: [], locked: true }, 0);
    doc.setOwnerCells('g', [['0,0,0', 1]]);
    expect('error' in buildRotateGroup90(doc, 'g', 1)).toBe(true);
  });

  it('a nonexistent id is an error', () => {
    expect('error' in buildRotateGroup90(makeDoc(), 'nope', 1)).toBe(true);
  });

  it('the projected raw orientation also rotates (the stairs orientation rotates the same direction as the group)', () => {
    const doc = new DocumentFixture(() => 'stairs');
    doc.insertGroup({ id: 'g', name: 'G', parentId: null, childIds: [] }, 0);
    const stairs = packCell(2, encodeOrientation({ shape: 'stairs', weirdoDirection: 0, upsideDown: false }));
    doc.setOwnerCells('g', [['0,0,0', stairs]]);
    rotate(doc, 'g', 1);
    const world = doc.index.worldOf({ ownerId: 'g', localCell: [0, 0, 0] })!;
    const raw = doc.index.winnerRefAt(world)!.raw;
    // rotating 0=east by +Y 90 degrees gives north = 3 (measured on-device table)
    expect(decodeOrientation('stairs', unpackCell(raw).code)).toEqual({
      shape: 'stairs',
      weirdoDirection: 3,
      upsideDown: false,
    });
  });
});

describe('computeDropIndexFor — multiple targets', () => {
  it('returns the position in the array with all move targets removed (the single-item version is a special case of 1)', () => {
    // grabbing b and d from ['a','b','c','d'] and dropping before c: after removal it is ['a','c'], so index 1
    expect(computeDropIndexFor(['a', 'b', 'c', 'd'], ['b', 'd'], 'c', 'before')).toBe(1);
    expect(computeDropIndexFor(['a', 'b', 'c', 'd'], ['b', 'd'], 'c', 'after')).toBe(2);
  });

  it('for a parent that does not contain the move targets, it is simply before/after the target', () => {
    expect(computeDropIndexFor(['x', 'y'], ['p', 'q'], 'x', 'before')).toBe(0);
    expect(computeDropIndexFor(['x', 'y'], ['p', 'q'], 'y', 'after')).toBe(2);
  });

  it('falls back to the end when the target has disappeared', () => {
    expect(computeDropIndexFor(['a', 'b'], ['a'], 'ghost', 'before')).toBe(1);
  });
});

describe('buildReparentGroups — multiple groups', () => {
  function fourRootGroups(): DocumentFixture {
    const doc = makeDoc();
    for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) {
      doc.insertGroup({ id, name: id.toUpperCase(), parentId: null, childIds: [] }, i);
    }
    return doc;
  }

  it('reordering within the same parent inserts them consecutively in selection order (1 transaction = 1 undo)', () => {
    const doc = fourRootGroups();
    const index = computeDropIndexFor(doc.tree.childrenOf(null), ['b', 'd'], 'a', 'before');
    const result = buildReparentGroups(doc, ['b', 'd'], null, index);
    if ('error' in result) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);
    expect(doc.tree.childrenOf(null)).toEqual(['b', 'd', 'a', 'c']);

    doc.undo();
    expect(doc.tree.childrenOf(null)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('moving them all to the end together does not break the order', () => {
    const doc = fourRootGroups();
    const index = computeDropIndexFor(doc.tree.childrenOf(null), ['a', 'b'], 'd', 'after');
    const result = buildReparentGroups(doc, ['a', 'b'], null, index);
    if ('error' in result) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);
    expect(doc.tree.childrenOf(null)).toEqual(['c', 'd', 'a', 'b']);
  });

  it('can move them all together to a different group', () => {
    const doc = fourRootGroups();
    doc.insertGroup({ id: 'dst', name: 'dst', parentId: null, childIds: [] }, 4);
    const result = buildReparentGroups(doc, ['a', 'c'], 'dst', doc.tree.childrenOf('dst').length);
    if ('error' in result) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);
    expect(doc.tree.childrenOf('dst')).toEqual(['a', 'c']);
    expect(doc.tree.childrenOf(null)).toEqual(['b', 'd', 'dst']);

    doc.undo();
    expect(doc.tree.childrenOf(null)).toEqual(['a', 'b', 'c', 'd', 'dst']);
    expect(doc.tree.childrenOf('dst')).toEqual([]);
  });

  it('a drop that does not change position does not pollute history (empty tx)', () => {
    const doc = fourRootGroups();
    const index = computeDropIndexFor(doc.tree.childrenOf(null), ['a', 'b'], 'c', 'before');
    const result = buildReparentGroups(doc, ['a', 'b'], null, index);
    if ('error' in result) throw new Error('unexpected error');
    expect(result.tx.ops).toEqual([]);
  });

  it('rejects the whole operation if even one item is locked / would cycle (no partial application)', () => {
    const doc = fourRootGroups();
    doc.insertGroup({ id: 'l', name: 'locked', parentId: null, childIds: [], locked: true }, 4);
    expect('error' in buildReparentGroups(doc, ['a', 'l'], null, 0)).toBe(true);

    doc.insertGroup({ id: 'gc', name: 'gc', parentId: 'a', childIds: [] }, 0);
    expect('error' in buildReparentGroups(doc, ['b', 'a'], 'gc', 0)).toBe(true);
  });

  it('an empty array is an error', () => {
    expect('error' in buildReparentGroups(makeDoc(), [], null, 0)).toBe(true);
  });
});

describe('buildMoveCellsToGroup — multiple cells', () => {
  it('moves multiple cells together in 1 transaction (1 undo reverts everything)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g', name: 'G', parentId: null, childIds: [] }, 0);
    doc.setCells([
      [0, 0, 0, 1],
      [1, 0, 0, 2],
    ]);
    const refs = [doc.cellAt(0, 0, 0).ref, doc.cellAt(1, 0, 0).ref];

    const result = buildMoveCellsToGroup(doc, refs, 'g');
    if ('error' in result) throw new Error('unexpected error');
    // stacks all the erases before placing (so a move within the same owner does not collide with itself)
    expect(result.tx.ops.map((op) => (op.kind === 'voxel' ? op.after : op.kind))).toEqual([null, null, 1, 2]);
    doc.applyTransaction(result.tx);
    expect(doc.ownerAt(0, 0, 0)).toBe('g');
    expect(doc.ownerAt(1, 0, 0)).toBe('g');

    doc.undo();
    expect(doc.ownerAt(0, 0, 0)).toBeNull();
    expect(doc.ownerAt(1, 0, 0)).toBeNull();
  });

  it('skips cells that already belong to the destination (empty tx if all of them do)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g', name: 'G', parentId: null, childIds: [] }, 0);
    doc.setOwnerCells('g', [['0,0,0', 1]]);
    const result = buildMoveCellsToGroup(doc, [doc.cellAt(0, 0, 0).ref], 'g');
    if ('error' in result) throw new Error('unexpected error');
    expect(result.tx.ops).toEqual([]);
  });

  it('an empty array is an error', () => {
    expect('error' in buildMoveCellsToGroup(makeDoc(), [], null)).toBe(true);
  });
});

describe('dragPayloadFor — relationship between the grabbed row and the selection', () => {
  it('returns the whole selection if the grabbed group is included in it', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'a', name: 'A', parentId: null, childIds: [] }, 0);
    doc.insertGroup({ id: 'b', name: 'B', parentId: null, childIds: [] }, 1);
    const payload = dragPayloadFor(doc.groupSelection('a', 'b'), { kind: 'groups', ids: ['b'] });
    expect(payload).toEqual({ kind: 'groups', ids: ['a', 'b'] });
  });

  it('grabbing a row outside the selection returns just that 1 item (does not rewrite the selection)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'a', name: 'A', parentId: null, childIds: [] }, 0);
    doc.insertGroup({ id: 'b', name: 'B', parentId: null, childIds: [] }, 1);
    const payload = dragPayloadFor(doc.groupSelection('a'), { kind: 'groups', ids: ['b'] });
    expect(payload).toEqual({ kind: 'groups', ids: ['b'] });
  });

  it('if kind spans different types, only the 1 grabbed item (mixed selection is a separate concern)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'a', name: 'A', parentId: null, childIds: [] }, 0);
    doc.setCells([[0, 0, 0, 1]]);
    const ref = doc.cellAt(0, 0, 0).ref;
    expect(dragPayloadFor(doc.groupSelection('a'), { kind: 'cells', refs: [ref] })).toEqual({
      kind: 'cells',
      refs: [ref],
    });
  });

  it('returns all selected cells if the grabbed cell is included in the selection', () => {
    const doc = makeDoc();
    doc.setCells([
      [0, 0, 0, 1],
      [1, 0, 0, 2],
    ]);
    const payload = dragPayloadFor(doc.cellSelection([0, 0, 0], [1, 0, 0]), {
      kind: 'cells',
      refs: [doc.cellAt(1, 0, 0).ref],
    });
    if (payload.kind !== 'cells') throw new Error('unexpected kind');
    expect(payload.refs).toHaveLength(2);
  });
});

describe('buildMirror', () => {
  /** A catalog with a stairs shape (0=full, 1=slab, 2=stairs) */
  function stairsDoc(): DocumentFixture {
    const shapes: Array<'full' | 'slab' | 'stairs'> = ['full', 'slab', 'stairs'];
    return new DocumentFixture((i) => shapes[i]);
  }

  function worldCells(doc: DocumentFixture, owner: string | null): string[] {
    return [...doc.rawCells.entriesOf(owner)]
      .map(([key]) => doc.index.worldOf({ ownerId: owner, localCell: parseCellKey(key) })!.join(','))
      .sort();
  }

  function mirror(doc: DocumentFixture, sel: NormalizedSelection, axis: 'x' | 'y' | 'z'): void {
    const result = buildMirror(doc, sel, axis);
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);
  }

  it('mirrors around the center of the selection bbox (does not go outside the bbox)', () => {
    const doc = makeDoc();
    // an L shape at x = 3,4,6. bbox is x=3..6 so mirrorSum = 9
    doc.setCells([
      [3, 0, 0, 1],
      [4, 0, 0, 1],
      [6, 0, 0, 1],
    ]);
    mirror(doc, doc.cellSelection([3, 0, 0], [4, 0, 0], [6, 0, 0]), 'x');
    expect(worldCells(doc, null)).toEqual(['3,0,0', '5,0,0', '6,0,0']);
  });

  it('applying it twice on the same axis returns to the original placement', () => {
    const doc = makeDoc();
    doc.setCells([
      [0, 0, 0, 1],
      [1, 0, 0, 1],
      [2, 0, 0, 1],
      [0, 0, 1, 1],
    ]);
    const before = worldCells(doc, null);
    // coordinates move on the first pass, so the second pass rebuilds the selection from **the cells currently present**
    const selectAll = (): NormalizedSelection =>
      doc.cellSelection(...worldCells(doc, null).map((c) => c.split(',').map(Number) as [number, number, number]));

    mirror(doc, selectAll(), 'z');
    expect(worldCells(doc, null)).not.toEqual(before); // always changes since the shape is asymmetric
    mirror(doc, selectAll(), 'z');
    expect(worldCells(doc, null)).toEqual(before);
  });

  it('the stairs orientation is also mirrored (does not just move coordinates and leave raw alone)', () => {
    const doc = stairsDoc();
    // weirdoDirection 1 = the step faces west (-X). Mirroring on X should give east (+X) facing = 0 (measured on-device table)
    const raw = packCell(2, encodeOrientation({ shape: 'stairs', weirdoDirection: 1, upsideDown: false }));
    doc.setCells([
      [0, 0, 0, raw],
      [1, 0, 0, raw],
    ]);
    mirror(doc, doc.cellSelection([0, 0, 0], [1, 0, 0]), 'x');
    for (const x of [0, 1]) {
      const worldRaw = doc.index.winnerRefAt([x, 0, 0])!.raw;
      expect(decodeOrientation('stairs', unpackCell(worldRaw).code)).toEqual({
        shape: 'stairs',
        weirdoDirection: 0,
        upsideDown: false,
      });
    }
  });

  it("Y mirroring swaps the slab's top/bottom", () => {
    const doc = stairsDoc();
    const top = packCell(1, encodeOrientation({ shape: 'slab', half: 'top' }));
    doc.setCells([
      [0, 0, 0, top],
      [0, 1, 0, top],
    ]);
    mirror(doc, doc.cellSelection([0, 0, 0], [0, 1, 0]), 'y');
    for (const y of [0, 1]) {
      const worldRaw = doc.index.winnerRefAt([0, y, 0])!.raw;
      expect(decodeOrientation('slab', unpackCell(worldRaw).code)).toEqual({ shape: 'slab', half: 'bottom' });
    }
  });

  it("is mirrored correctly from world's point of view even for a rotated group (converts to local and re-places)", () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g', name: 'G', parentId: null, childIds: [] }, 0);
    doc.setOwnerCells('g', [
      ['0,0,0', 1],
      ['1,0,0', 1],
      ['2,0,0', 1],
      ['0,0,1', 1],
    ]);
    const rotateResult = buildRotateGroup90(doc, 'g', 1);
    if ('error' in rotateResult) throw new Error(rotateResult.error);
    doc.applyTransaction(rotateResult.tx);

    const rotated = worldCells(doc, 'g');
    const sel = doc.groupSelection('g');
    mirror(doc, sel, 'x');
    const mirrored = worldCells(doc, 'g');

    // the world bbox is unchanged (a bijection within the bbox), and the placement changes (asymmetric shape)
    const bboxX = (cells: string[]) => cells.map((c) => Number(c.split(',')[0]));
    expect(Math.min(...bboxX(mirrored))).toBe(Math.min(...bboxX(rotated)));
    expect(Math.max(...bboxX(mirrored))).toBe(Math.max(...bboxX(rotated)));
    expect(mirrored).not.toEqual(rotated);
    // does not touch the group's transform (mirroring is expressed on the entity side)
    expect(doc.tree.getNode('g')!.transform!.angleSteps).toBe(1);
    // returns after 2 passes
    mirror(doc, doc.groupSelection('g'), 'x');
    expect(worldCells(doc, 'g')).toEqual(rotated);
  });

  it('a selection including a locked descendant is not flipped (does not break the shape with a partial flip)', () => {
    // the parent itself is not locked so it passes through normalizeSelection.
    // the lock check needs to look at the subtree per-cell (looking only at the parent lets it slip through)
    const doc = makeDoc();
    doc.insertGroup({ id: 'parent', name: 'parent', parentId: null, childIds: [] }, 0);
    doc.insertGroup({ id: 'child', name: 'child', parentId: 'parent', childIds: [], locked: true }, 0);
    doc.setOwnerCells('parent', [['0,0,0', 1]]);
    doc.setOwnerCells('child', [['2,0,0', 1]]);

    const sel = doc.groupSelection('parent');
    expect(sel.kind).toBe('groups'); // the selection is still alive since the parent is not locked
    expect(buildMirror(doc, sel, 'x')).toEqual({ error: 'lockedInMirror' });
  });

  it('no selection is an error', () => {
    const doc = makeDoc();
    expect(buildMirror(doc, doc.noneSelection(), 'x')).toEqual({ error: 'noSelection' });
  });
});

describe('buildMirror — an effective no-op does not pollute history', () => {
  function mirrorResult(doc: DocumentFixture, sel: NormalizedSelection, axis: 'x' | 'y' | 'z') {
    return buildMirror(doc, sel, axis);
  }

  it('X-flipping a single full block yields empty ops (neither dest nor raw changes)', () => {
    const doc = makeDoc();
    doc.setCells([[3, 0, 0, 1]]);
    const result = mirrorResult(doc, doc.cellSelection([3, 0, 0]), 'x');
    if ('error' in result) throw new Error(result.error);
    expect(result.tx.ops).toEqual([]);
  });

  it('X-flipping a left-right symmetric row of full blocks also yields empty ops', () => {
    const doc = makeDoc();
    // a straight line at x=0..2. X-flipping swaps 0↔2 but since raw is the same the final state is unchanged
    doc.setCells([
      [0, 0, 0, 1],
      [1, 0, 0, 1],
      [2, 0, 0, 1],
    ]);
    const result = mirrorResult(doc, doc.cellSelection([0, 0, 0], [1, 0, 0], [2, 0, 0]), 'x');
    if ('error' in result) throw new Error(result.error);
    expect(result.tx.ops).toEqual([]);
  });

  it('emits ops even for a symmetric placement if raw differs (the final state changes, so it is recorded in history)', () => {
    const doc = makeDoc();
    doc.setCells([
      [0, 0, 0, 1],
      [2, 0, 0, 2], // a different block
    ]);
    const result = mirrorResult(doc, doc.cellSelection([0, 0, 0], [2, 0, 0]), 'x');
    if ('error' in result) throw new Error(result.error);
    expect(result.tx.ops.length).toBeGreaterThan(0);
  });

  it('emits ops when only the orientation changes (X-flipping a single stairs block)', () => {
    const shapes: Array<'full' | 'slab' | 'stairs'> = ['full', 'slab', 'stairs'];
    const doc = new DocumentFixture((i) => shapes[i]);
    doc.setCells([[0, 0, 0, packCell(2, encodeOrientation({ shape: 'stairs', weirdoDirection: 1, upsideDown: false }))]]);
    const result = mirrorResult(doc, doc.cellSelection([0, 0, 0]), 'x');
    if ('error' in result) throw new Error(result.error);
    expect(result.tx.ops.length).toBeGreaterThan(0);
  });

  it('a Ctrl+Z right after a no-op flip undoes the edit before it (does not whiff)', () => {
    // exactly the symptom flagged in review: if a flip consumes 1 history entry, undo consumes 1 without changing anything
    const doc = makeDoc();
    doc.setCells([[3, 0, 0, 1]]);
    const before = [...doc.rawCells.entriesOf(null)].map(([k, v]) => `${k}=${v}`).sort();

    // the "real edit" right before = placing 1 different cell
    doc.applyTransaction({ ops: [{ kind: 'voxel', owner: null, key: '9,0,0', before: null, after: 1 }] });
    expect(doc.scene.cells.get(null, '9,0,0')).toBe(1);

    const result = buildMirror(doc, doc.cellSelection([3, 0, 0]), 'x');
    if ('error' in result) throw new Error(result.error);
    expect(result.tx.ops).toEqual([]); // empty, so commitOpResult does not call applyTransaction

    doc.undo();
    expect([...doc.rawCells.entriesOf(null)].map(([k, v]) => `${k}=${v}`).sort()).toEqual(before);
  });
});

describe('buildDuplicate — array duplication', () => {
  function worldCells(doc: DocumentFixture, owner: string | null): string[] {
    return [...doc.rawCells.entriesOf(owner)]
      .map(([key]) => doc.index.worldOf({ ownerId: owner, localCell: parseCellKey(key) })!.join(','))
      .sort();
  }

  it('arranges a cells selection into 3 evenly spaced copies along +X', () => {
    const doc = makeDoc();
    doc.setCells([[0, 0, 0, 1]]);
    const result = buildDuplicate(doc, doc.cellSelection([0, 0, 0]), { delta: [2, 0, 0], count: 3 });
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);
    expect(worldCells(doc, null)).toEqual(['0,0,0', '2,0,0', '4,0,0', '6,0,0']);
    expect(result.newSelectionRefs).toHaveLength(3); // excludes the original, only the copies are selected
  });

  it('negative-direction and Y-direction deltas also work', () => {
    const doc = makeDoc();
    doc.setCells([[5, 0, 0, 1]]);
    const down = buildDuplicate(doc, doc.cellSelection([5, 0, 0]), { delta: [-2, 0, 0], count: 2 });
    if ('error' in down) throw new Error(down.error);
    doc.applyTransaction(down.tx);
    expect(worldCells(doc, null)).toEqual(['1,0,0', '3,0,0', '5,0,0']);

    const up = buildDuplicate(doc, doc.cellSelection([5, 0, 0]), { delta: [0, 3, 0], count: 2 });
    if ('error' in up) throw new Error(up.error);
    doc.applyTransaction(up.tx);
    expect(doc.scene.cells.has(null, '5,3,0')).toBe(true);
    expect(doc.scene.cells.has(null, '5,6,0')).toBe(true);
  });

  it('a groups selection makes N clones, with sibling order [original, copy1, copy2]', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g', name: 'wall', parentId: null, childIds: [] }, 0);
    doc.setOwnerCells('g', [
      ['0,0,0', 1],
      ['0,1,0', 1],
    ]);
    const result = buildDuplicate(doc, doc.groupSelection('g'), { delta: [3, 0, 0], count: 2 });
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);

    const siblings = doc.tree.childrenOf(null);
    expect(siblings).toHaveLength(3);
    expect(siblings[0]).toBe('g');
    const [, copy1, copy2] = siblings;
    // world position is shifted by delta * i
    expect(worldCells(doc, copy1!)).toEqual(['3,0,0', '3,1,0']);
    expect(worldCells(doc, copy2!)).toEqual(['6,0,0', '6,1,0']);
    expect(result.newSelection).toEqual({ kind: 'groups', ids: [copy1, copy2] });
  });

  it('array duplication of a rotated group does not break the shape (carried on translate)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g', name: 'L', parentId: null, childIds: [] }, 0);
    doc.setOwnerCells('g', [
      ['0,0,0', 1],
      ['1,0,0', 1],
      ['0,0,1', 1],
    ]);
    const rotate = buildRotateGroup90(doc, 'g', 1);
    if ('error' in rotate) throw new Error(rotate.error);
    doc.applyTransaction(rotate.tx);
    const shape = worldCells(doc, 'g');

    const result = buildDuplicate(doc, doc.groupSelection('g'), { delta: [5, 0, 0], count: 2 });
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);

    const [, copy1, copy2] = doc.tree.childrenOf(null);
    // the shape (relative placement) matches, and in world space it is only translated by delta * i
    const shifted = (n: number) =>
      shape.map((c) => {
        const [x, y, z] = c.split(',').map(Number);
        return [x! + 5 * n, y, z].join(',');
      }).sort();
    expect(worldCells(doc, copy1!)).toEqual(shifted(1));
    expect(worldCells(doc, copy2!)).toEqual(shifted(2));
  });

  it('without opts, 1 adjacent copy as before (does not change the behavior of existing callers)', () => {
    const doc = makeDoc();
    doc.setCells([[0, 0, 0, 1]]);
    const result = buildDuplicate(doc, doc.cellSelection([0, 0, 0]));
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);
    expect(worldCells(doc, null)).toEqual(['0,0,0', '1,0,0']);
  });

  it('count must be an integer of 1 or more', () => {
    const doc = makeDoc();
    doc.setCells([[0, 0, 0, 1]]);
    const sel = doc.cellSelection([0, 0, 0]);
    expect(buildDuplicate(doc, sel, { count: 0 })).toEqual({ error: 'duplicateCountInvalid' });
    expect(buildDuplicate(doc, sel, { count: -1 })).toEqual({ error: 'duplicateCountInvalid' });
    expect(buildDuplicate(doc, sel, { count: 1.5 })).toEqual({ error: 'duplicateCountInvalid' });
  });

  it('rejects a zero-vector delta (does not stack copies at the same place)', () => {
    const doc = makeDoc();
    doc.setCells([[0, 0, 0, 1]]);
    const result = buildDuplicate(doc, doc.cellSelection([0, 0, 0]), { delta: [0, 0, 0], count: 3 });
    expect(result).toEqual({ error: 'duplicateGapZero' });
  });

  it('rejects before building ops when total cell count (selection × count) exceeds the limit', () => {
    const doc = makeDoc();
    doc.setCells([[0, 0, 0, 1]]);
    const result = buildDuplicate(doc, doc.cellSelection([0, 0, 0]), { delta: [1, 0, 0], count: OP_MAX_CELLS + 1 });
    if (!('error' in result)) throw new Error('exceeded the limit but was accepted');
    expect(result.error).toContain('tooLargeAfterDuplicate');
  });

  it('places none at all if any intermediate copy would go out of range', () => {
    const doc = makeDoc();
    doc.setCells([[COORD_LIMIT - 1, 0, 0, 1]]);
    const result = buildDuplicate(doc, doc.cellSelection([COORD_LIMIT - 1, 0, 0]), { delta: [1, 0, 0], count: 5 });
    if (!('error' in result)) throw new Error('out of range but was accepted');
    expect(result.error).toContain('outOfRangeDuplicate');
  });
});

describe('buildDuplicate — array-duplicating multiple groups with the same parent', () => {
  /** Lines up g1..gN directly under parent null, placing 1 cell in each group */
  function siblingsDoc(names: string[]): DocumentFixture {
    const doc = makeDoc();
    names.forEach((id, i) => {
      doc.insertGroup({ id, name: id, parentId: null, childIds: [] }, i);
      doc.setOwnerCells(id, [[`${i * 10},0,0`, 1]]);
    });
    return doc;
  }

  it('array-duplicating 2 adjacent groups at once keeps the order [A, A1, A2, B, B1, B2]', () => {
    const doc = siblingsDoc(['A', 'B']);
    const result = buildDuplicate(doc, doc.groupSelection('A', 'B'), { delta: [0, 5, 0], count: 2 });
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);

    const order = doc.tree.childrenOf(null);
    expect(order).toHaveLength(6);
    expect(order[0]).toBe('A');
    expect(order[3]).toBe('B');
    // A's 2 copies cluster right after A, B's 2 copies cluster right after B
    const aCopies = order.slice(1, 3);
    const bCopies = order.slice(4, 6);
    expect(aCopies).not.toContain('B');
    expect(bCopies).not.toContain('A');
    // whether each copy's contents originate from the same owner as the original (A's copies are the x=0 family, B's copies are the x=10 family)
    const xOf = (id: string) =>
      [...doc.rawCells.entriesOf(id)].map(([k]) => doc.index.worldOf({ ownerId: id, localCell: parseCellKey(k) })![0]);
    expect(aCopies.flatMap((id) => xOf(id))).toEqual([0, 0]);
    expect(bCopies.flatMap((id) => xOf(id))).toEqual([10, 10]);
  });

  it('the order is not broken even when an unselected group sits between the selected ones', () => {
    const doc = siblingsDoc(['A', 'MID', 'B']);
    const result = buildDuplicate(doc, doc.groupSelection('A', 'B'), { delta: [0, 5, 0], count: 1 });
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);

    const order = doc.tree.childrenOf(null);
    expect(order).toHaveLength(5);
    expect(order[0]).toBe('A');
    expect(order[2]).toBe('MID');
    expect(order[3]).toBe('B');
  });

  it("newSelection returns in selection order (A's copies → B's copies)", () => {
    const doc = siblingsDoc(['A', 'B']);
    const result = buildDuplicate(doc, doc.groupSelection('A', 'B'), { delta: [0, 5, 0], count: 2 });
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);

    const ids = (result.newSelection as { kind: 'groups'; ids: string[] }).ids;
    const order = doc.tree.childrenOf(null);
    expect(ids).toEqual([order[1], order[2], order[4], order[5]]);
  });

  it('reverts in exactly 1 undo, and the sibling array also reverts', () => {
    const doc = siblingsDoc(['A', 'B']);
    const before = doc.tree.childrenOf(null);
    const result = buildDuplicate(doc, doc.groupSelection('A', 'B'), { delta: [0, 5, 0], count: 2 });
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);
    doc.undo();
    expect(doc.tree.childrenOf(null)).toEqual(before);
  });
});
