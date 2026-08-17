import { describe, expect, it } from 'vitest';
import { COORD_LIMIT, OP_MAX_CELLS } from '../src/core/limits';
import type { GroupNode } from '../src/core/scenetree';
import { initialTransformOf, subtreeLocalBounds } from '../src/core/ownerlocal';
import { computePivot2 } from '../src/core/transform';
import { buildPaste, snapshotSelection } from '../src/editor/clipboard';
import { normalizeSelection } from '../src/editor/selection';
import { buildDeleteSelection } from '../src/editor/ops';
import { DocumentFixture } from './helpers/document-fixture';

function makeDoc(): DocumentFixture {
  return new DocumentFixture();
}

describe('snapshotSelection — cells', () => {
  it('holds coordinates relative to the bbox min, groups is empty, and ownerIndex is all -1 (fragment root)', () => {
    const doc = makeDoc();
    doc.setCells([
      [2, 3, 4, 1],
      [3, 3, 4, 2],
    ]);
    const clip = snapshotSelection(doc, doc.cellSelection([2, 3, 4], [3, 3, 4]));
    expect(clip).not.toBeNull();
    expect(clip!.origin).toEqual([2, 3, 4]);
    expect(clip!.groups).toEqual([]);
    expect(clip!.cells).toHaveLength(2);
    // #37 B1b: the cells tuple is [ownerIndex, x, y, z, value]. ownerIndex -1 = fragment root
    for (const [ownerIndex] of clip!.cells) expect(ownerIndex).toBe(-1);

    const byValue = new Map(clip!.cells.map((c) => [c[4], c]));
    expect(byValue.get(1)!.slice(1, 4)).toEqual([0, 0, 0]); // (2,3,4) is the origin itself → relative (0,0,0)
    expect(byValue.get(2)!.slice(1, 4)).toEqual([1, 0, 0]); // (3,3,4) is x+1 from the origin
  });

  it('returns null when the selection is empty (none, or no matching cells)', () => {
    const doc = makeDoc();
    expect(snapshotSelection(doc, doc.noneSelection())).toBeNull();
    expect(snapshotSelection(doc, doc.cellSelection())).toBeNull();
  });
});

describe('snapshotSelection — groups', () => {
  it('records a 2-level nested group in pre-order with the correct parent index', () => {
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

    const parentPivot = computePivot2(subtreeLocalBounds(doc.scene, 'p')!);
    const clip = snapshotSelection(doc, doc.groupSelection('p'));
    expect(clip).not.toBeNull();
    // the topmost entry always carries a "transform that collapses the original parent chain"
    // (pivot comes from subtree bounds, #37 B1b review P2). In this scene the parent chain is
    // identity, so translate stays 0
    expect(clip!.groups).toEqual([
      { name: 'parent', parent: -1, transform: { angleSteps: 0, translate: [0, 0, 0], pivot2: parentPivot } },
      { name: 'child', parent: 0 },
    ]);
    const byValue = new Map(clip!.cells.map((c) => [c[4], c]));
    expect(byValue.get(1)![0]).toBe(0); // the cell belonging directly to parent → the ownerIndex pointing at groups[0] (parent)
    expect(byValue.get(2)![0]).toBe(1); // the cell belonging directly to child → the ownerIndex pointing at groups[1] (child)
  });
});

describe('buildPaste', () => {
  it('pastes at the adjacent offset when it is within coordinate range', () => {
    const doc = makeDoc();
    doc.setCells([[0, 0, 0, 1]]);
    const clip = snapshotSelection(doc, doc.cellSelection([0, 0, 0]));
    expect(clip).not.toBeNull();
    const result = buildPaste(doc, clip!);
    if ('error' in result) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);
    expect(doc.world.get(0, 0, 0)).toBe(1); // the original stays
    expect(doc.world.get(1, 0, 0)).toBe(1); // pasted at the +X neighbor (bbox width 1)
  });

  it('returns an error for a clipboard exceeding OP_MAX_CELLS (review #8 finding)', () => {
    const doc = makeDoc();
    const cells: [number, number, number, number, number][] = [];
    for (let i = 0; i <= OP_MAX_CELLS; i++) cells.push([i, 0, 0, 1, -1]);
    const clip = { cells, groups: [], origin: [0, 0, 0] as [number, number, number], size: [OP_MAX_CELLS + 1, 1, 1] as [number, number, number] };
    const result = buildPaste(doc, clip);
    expect('error' in result).toBe(true);
  });

  it('round-trips a nested group snapshot (new ids + correct parent/child structure + membership), and undo removes the whole group', () => {
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

    const clip = snapshotSelection(doc, doc.groupSelection('p'));
    expect(clip).not.toBeNull();
    const result = buildPaste(doc, clip!);
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

    // the copy source is untouched
    expect(doc.tree.getNode('p')).toBeDefined();
    expect(doc.tree.getNode('c')).toBeDefined();
    expect(doc.world.get(0, 0, 0)).toBe(1);
    expect(doc.world.get(1, 0, 0)).toBe(2);

    doc.undo();
    expect(doc.tree.getNode(newParentId)).toBeUndefined();
    expect(doc.tree.getNode(newChildId)).toBeUndefined();
    expect(doc.world.has(2, 0, 0)).toBe(false);
    expect(doc.world.has(3, 0, 0)).toBe(false);
  });

  it('can paste self-contained even after the copy source has been deleted', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g', name: 'G', parentId: null, childIds: [] }, 0);
    doc.setCells([[0, 0, 0, 1]]);
    doc.setCellMembership('0,0,0', 'g');

    const clip = snapshotSelection(doc, doc.groupSelection('g'));
    expect(clip).not.toBeNull();

    // delete the copy source
    const del = buildDeleteSelection(doc, doc.groupSelection('g'));
    if (!('tx' in del)) throw new Error('unexpected error');
    doc.applyTransaction(del.tx);
    expect(doc.world.has(0, 0, 0)).toBe(false);
    expect(doc.tree.getNode('g')).toBeUndefined();

    // the clipboard is self-contained, so the paste succeeds
    // (findPasteOffset always prefers the +X candidate regardless of occupancy, so it pastes at
    // the +X neighbor rather than the original coordinates)
    const result = buildPaste(doc, clip!);
    if ('error' in result) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);
    expect(result.newSelection?.kind).toBe('groups');
    const newId = (result.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;
    expect(doc.tree.getNode(newId)?.name).toBe('G');
    expect(doc.world.get(1, 0, 0)).toBe(1);
  });

  it('falls through to the next candidate when the candidate offset is out of coordinate range', () => {
    const doc = makeDoc();
    doc.setCells([[COORD_LIMIT, 0, 0, 1]]);
    const clip = snapshotSelection(doc, doc.cellSelection([COORD_LIMIT, 0, 0]));
    expect(clip).not.toBeNull();
    const result = buildPaste(doc, clip!);
    if ('error' in result) throw new Error('unexpected error');
    doc.applyTransaction(result.tx);
    expect(doc.world.get(COORD_LIMIT - 1, 0, 0)).toBe(1); // falls through to the -X neighbor
  });

  it('returns an error for an empty clipboard', () => {
    const doc = makeDoc();
    const result = buildPaste(doc, { cells: [], groups: [], origin: [0, 0, 0], size: [0, 0, 0] });
    expect('error' in result).toBe(true);
  });
});

/**
 * Doesn't bake a pivot when copying a group with an unset transform (#37 B1b review P2).
 *
 * Root cause: the logic for "materializing an unset transform into numbers" had split into
 * two places, and only the clipboard side baked in `pivot2: [0, 0]`. The look right after
 * pasting was preserved, but the first rotation afterward would then center on the origin
 * instead of the true subtree center (inconsistent with the PR's own rule of "don't bake in
 * placeholders").
 *
 * Fixed by consolidating onto `initialTransformOf` (core/ownerlocal.ts).
 */
describe('snapshotSelection / buildPaste — pivot for an unset transform (review P2)', () => {
  /** P (translated) > C (transform unset, a 2x2 cell). C is taken out */
  function nestedUnset(): DocumentFixture {
    const doc = makeDoc();
    doc.insertGroup(
      { id: 'p', name: 'P', parentId: null, childIds: [], transform: { angleSteps: 0, translate: [7, 0, 0], pivot2: [0, 0] } },
      0,
    );
    doc.insertGroup({ id: 'c', name: 'C', parentId: 'p', childIds: [] }, 0);
    doc.setOwnerCells('c', [
      ['0,0,0', 1],
      ['1,0,1', 2],
    ]);
    return doc;
  }

  it("the pivot2 of the taken-out topmost group comes from subtree bounds (doesn't bake in [0,0])", () => {
    const doc = nestedUnset();
    const expectedPivot = computePivot2(subtreeLocalBounds(doc.scene, 'c')!);
    expect(expectedPivot).not.toEqual([0, 0]); // not origin-centered for this cell layout

    const clip = snapshotSelection(doc, doc.groupSelection('c'));
    expect(clip).not.toBeNull();
    expect(clip!.groups[0]!.transform?.pivot2).toEqual(expectedPivot);
  });

  it("the pasted group's initial pivot matches the original C (the future rotation center doesn't change)", () => {
    const doc = nestedUnset();
    const expectedPivot = computePivot2(subtreeLocalBounds(doc.scene, 'c')!);

    const clip = snapshotSelection(doc, doc.groupSelection('c'));
    const result = buildPaste(doc, clip!);
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);

    const pastedId = (result.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;
    expect(doc.tree.getNode(pastedId)?.transform?.pivot2).toEqual(expectedPivot);
    // also the same when derived from the post-paste subtree bounds (because local coordinates are copied as-is)
    expect(computePivot2(subtreeLocalBounds(doc.scene, pastedId)!)).toEqual(expectedPivot);
  });

  it('only a group with an empty subtree falls back to [0,0]', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'empty', name: 'E', parentId: null, childIds: [] }, 0);
    expect(initialTransformOf(doc.scene, 'empty').pivot2).toEqual([0, 0]);
  });
});

/**
 * Remaining paths of the same kind, found during self-directed investigation (an adjacent
 * case to the review finding).
 *
 * ① `snapshotSelection` left `transform: undefined` for a root-level group with an unset
 *    transform. Since pasting always loads a non-zero offset onto translate, `buildPaste`
 *    ends up filling in `pivot2: [0, 0]` — the same baking-in as finding P2, via a different path
 * ② `resolveSelectionRefs` double-collected even a simultaneous parent+child when given a raw
 *    Selection (e.g. one built directly from Layers)
 */
describe('clipboard / ops — adjacent paths from the same root cause (self-directed investigation)', () => {
  it('even a root-level group with an unset transform gets a post-paste pivot derived from subtree bounds', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g', name: 'G', parentId: null, childIds: [] }, 0);
    doc.setOwnerCells('g', [
      ['0,0,0', 1],
      ['1,0,1', 2],
    ]);
    const expectedPivot = computePivot2(subtreeLocalBounds(doc.scene, 'g')!);
    expect(expectedPivot).not.toEqual([0, 0]);

    const clip = snapshotSelection(doc, doc.groupSelection('g'));
    const result = buildPaste(doc, clip!);
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);

    const pastedId = (result.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;
    expect(doc.tree.getNode(pastedId)?.transform?.pivot2).toEqual(expectedPivot);
  });

  it("copying a simultaneous parent+child selection doesn't produce a doubled groups structure, and the hierarchy is preserved after paste", () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'p', name: 'P', parentId: null, childIds: [] }, 0);
    doc.insertGroup({ id: 'c', name: 'C', parentId: 'p', childIds: [] }, 0);
    doc.setOwnerCells('c', [['0,0,0', 1]]);

    const clip = snapshotSelection(doc, normalizeSelection(doc.tree, doc.groupSelection('p', 'c')));
    expect(clip).not.toBeNull();
    expect(clip!.cells).toHaveLength(1);
    // cell count alone can't detect this — pin down the groups structure too.
    // A normalization gap would produce 3 entries [p(-1), c(0), c(-1)], and groupIndexOf('c')
    // would get overwritten by the latter (an independent c), breaking the hierarchy after paste
    expect(clip!.groups).toHaveLength(2);
    expect(clip!.groups.map((g) => [g.name, g.parent])).toEqual([
      ['P', -1],
      ['C', 0],
    ]);
    // the cell's owner should point at "c, which is a child of p"
    expect(clip!.cells[0]![0]).toBe(1);

    const result = buildPaste(doc, clip!);
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);

    const pastedTopIds = (result.newSelection as { kind: 'groups'; ids: string[] }).ids;
    expect(pastedTopIds).toHaveLength(1); // no independent c' sprouted at the top level
    const pastedP = pastedTopIds[0]!;
    const pastedChildren = doc.tree.childrenOf(pastedP);
    expect(pastedChildren).toHaveLength(1);
    const pastedC = pastedChildren[0]!;
    expect(doc.tree.getNode(pastedC)?.name).toBe('C');
    // the cell is held by "the pasted c" (not directly under root or belonging directly to p')
    expect([...doc.scene.cells.entriesOf(pastedC)]).toHaveLength(1);
    expect([...doc.scene.cells.entriesOf(pastedP)]).toHaveLength(0);
  });
});
