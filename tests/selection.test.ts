import { describe, expect, it, vi } from 'vitest';
import type { DocOp } from '../src/core/document';
import { buildTranslateGroup } from '../src/editor/ops';
import { SelectionStore } from '../src/editor/selection';
import { DocumentFixture } from './helpers/document-fixture';

function makeDoc(): DocumentFixture {
  return new DocumentFixture();
}

describe('SelectionStore — resolveCells', () => {
  it('cells kind returns (a copy of) itself as-is', () => {
    const doc = makeDoc();
    const sel = new SelectionStore(doc);
    sel.set(doc.cellSelection([0, 0, 0], [1, 0, 0]));
    expect(sel.resolveCells()).toEqual(new Set(['0,0,0', '1,0,0']));
  });

  it('groups kind returns the union via collectCellsDeep (including nesting)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'A', parentId: null, childIds: [] }, 0);
    doc.insertGroup({ id: 'g1', name: 'child', parentId: 'g0', childIds: [] }, 0);
    doc.setCellMembership('0,0,0', 'g0');
    doc.setCellMembership('1,0,0', 'g1');

    const sel = new SelectionStore(doc);
    sel.set(doc.groupSelection('g0'));
    expect(sel.resolveCells()).toEqual(new Set(['0,0,0', '1,0,0']));
  });

  it('the union across multiple group ids works too', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'A', parentId: null, childIds: [] }, 0);
    doc.insertGroup({ id: 'g1', name: 'B', parentId: null, childIds: [] }, 1);
    doc.setCellMembership('0,0,0', 'g0');
    doc.setCellMembership('1,0,0', 'g1');

    const sel = new SelectionStore(doc);
    sel.set(doc.groupSelection('g0', 'g1'));
    expect(sel.resolveCells()).toEqual(new Set(['0,0,0', '1,0,0']));
  });

  it('none kind is an empty set', () => {
    const doc = makeDoc();
    const sel = new SelectionStore(doc);
    expect(sel.resolveCells()).toEqual(new Set());
  });
});

describe('SelectionStore — toggleCell / toggleGroup', () => {
  it('toggleCell: adds from none, re-toggling the same key removes it and returns to none', () => {
    const doc = makeDoc();
    const sel = new SelectionStore(doc);
    sel.toggleCell(doc.cellAt(0, 0, 0));
    expect(sel.get()).toEqual(doc.cellSelection([0, 0, 0]));
    sel.toggleCell(doc.cellAt(0, 0, 0));
    expect(sel.get()).toEqual({ kind: 'none' });
  });

  it('toggleCell: can add another key while in cells kind (accumulates rather than replaces)', () => {
    const doc = makeDoc();
    const sel = new SelectionStore(doc);
    sel.toggleCell(doc.cellAt(0, 0, 0));
    sel.toggleCell(doc.cellAt(1, 0, 0));
    expect(sel.get()).toEqual(doc.cellSelection([0, 0, 0], [1, 0, 0]));
  });

  it('toggleCell: calling it during groups kind replaces across kinds', () => {
    const doc = makeDoc();
    const sel = new SelectionStore(doc);
    doc.insertGroup({ id: 'g0', name: 'A', parentId: null, childIds: [] }, 0);
    sel.set(doc.groupSelection('g0'));
    sel.toggleCell(doc.cellAt(0, 0, 0));
    expect(sel.get()).toEqual(doc.cellSelection([0, 0, 0]));
  });

  it('toggleGroup: replaces from a non-groups state, re-toggling the same id returns to none', () => {
    const doc = makeDoc();
    // #37 B1b: sanitize now requires "an id that exists in the tree", so provide a real one
    doc.insertGroup({ id: 'g0', name: 'G0', parentId: null, childIds: [] }, 0);
    const sel = new SelectionStore(doc);
    sel.set(doc.cellSelection([0, 0, 0]));
    sel.toggleGroup('g0');
    expect(sel.get()).toEqual(doc.groupSelection('g0'));
    sel.toggleGroup('g0');
    expect(sel.get()).toEqual({ kind: 'none' });
  });

  it('toggleGroup: can add an id while in groups kind', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'G0', parentId: null, childIds: [] }, 0);
    doc.insertGroup({ id: 'g1', name: 'G1', parentId: null, childIds: [] }, 1);
    const sel = new SelectionStore(doc);
    sel.toggleGroup('g0');
    sel.toggleGroup('g1');
    expect(sel.get()).toEqual(doc.groupSelection('g0', 'g1'));
  });
});

describe('SelectionStore — bbox', () => {
  it('cells kind bbox computes min/max', () => {
    const doc = makeDoc();
    const sel = new SelectionStore(doc);
    sel.set(doc.cellSelection([0, 0, 0], [2, 3, -1]));
    expect(sel.bbox()).toEqual({ min: [0, 0, -1], max: [2, 3, 0] });
  });

  it('groups kind bbox is computed via resolveCells', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'A', parentId: null, childIds: [] }, 0);
    doc.setCellMembership('5,1,5', 'g0');
    doc.setCellMembership('1,1,1', 'g0');

    const sel = new SelectionStore(doc);
    sel.set(doc.groupSelection('g0'));
    expect(sel.bbox()).toEqual({ min: [1, 1, 1], max: [5, 1, 5] });
  });

  it('none / empty selection is null', () => {
    const doc = makeDoc();
    const sel = new SelectionStore(doc);
    expect(sel.bbox()).toBeNull();
  });
});

describe('SelectionStore — validate (drops dead ids/cells)', () => {
  it("groups: drops a group id removed directly via doc.tree's removeNode, becoming none", () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'A', parentId: null, childIds: [] }, 0);
    const sel = new SelectionStore(doc);
    sel.set(doc.groupSelection('g0'));

    // reproduces a direct mutation bypassing Document's op path (destruction that never lands in undo history)
    doc.rawTree.removeNode('g0');
    // applyTransaction always pushes+notifies even when ops is empty (commitStroke/applyEdits are no-ops when empty).
    // used here as the minimal poke that "triggers doc.subscribe without changing state"
    doc.applyTransaction({ ops: [] });

    expect(sel.get()).toEqual({ kind: 'none' });
  });

  it('groups: when only some ids die while multiple are selected, only the living ids remain', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'A', parentId: null, childIds: [] }, 0);
    doc.insertGroup({ id: 'g1', name: 'B', parentId: null, childIds: [] }, 1);
    const sel = new SelectionStore(doc);
    sel.set(doc.groupSelection('g0', 'g1'));

    doc.rawTree.removeNode('g1');
    doc.applyTransaction({ ops: [] });

    expect(sel.get()).toEqual(doc.groupSelection('g0'));
  });

  it('cells: drops a cell removed directly from doc.world (the rest is kept)', () => {
    const doc = makeDoc();
    doc.setCells([
      [0, 0, 0, 1],
      [1, 0, 0, 2],
    ]);
    const sel = new SelectionStore(doc);
    sel.set(doc.cellSelection([0, 0, 0], [1, 0, 0]));

    // world.stage is a direct mutation that bypasses Document (VoxelWorld.subscribe isn't wired to Document,
    // so it never reaches doc.subscribe) → explicitly poke it to trigger validate()
    doc.stageRaw(null, '0,0,0', null);
    doc.applyTransaction({ ops: [] });

    expect(sel.get()).toEqual(doc.cellSelection([1, 0, 0]));
  });

  it('cells: becomes none once everything is gone', () => {
    const doc = makeDoc();
    doc.setCells([[0, 0, 0, 1]]);
    const sel = new SelectionStore(doc);
    sel.set(doc.cellSelection([0, 0, 0]));

    doc.stageRaw(null, '0,0,0', null);
    doc.applyTransaction({ ops: [] });

    expect(sel.get()).toEqual({ kind: 'none' });
  });

  it("doesn't touch a live selection (notify still fires but the value doesn't change)", () => {
    const doc = makeDoc();
    doc.setCells([[0, 0, 0, 1]]);
    const sel = new SelectionStore(doc);
    sel.set(doc.cellSelection([0, 0, 0]));

    let notifyCount = 0;
    sel.subscribe(() => notifyCount++);
    doc.applyTransaction({ ops: [] }); // it's alive, so validate() doesn't call set()

    expect(sel.get()).toEqual(doc.cellSelection([0, 0, 0]));
    expect(notifyCount).toBe(0);
  });
});

describe('SelectionStore — excluding hidden/locked (review #2 finding)', () => {
  it("set(): a hidden or locked group doesn't enter the selection", () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'h', name: 'hidden', parentId: null, childIds: [], hidden: true }, 0);
    doc.insertGroup({ id: 'l', name: 'locked', parentId: null, childIds: [], locked: true }, 1);
    doc.insertGroup({ id: 'f', name: 'free', parentId: null, childIds: [] }, 2);
    const sel = new SelectionStore(doc);

    sel.set(doc.groupSelection('h'));
    expect(sel.get()).toEqual({ kind: 'none' });
    sel.set(doc.groupSelection('l'));
    expect(sel.get()).toEqual({ kind: 'none' });
    sel.set(doc.groupSelection('h', 'l', 'f'));
    expect(sel.get()).toEqual(doc.groupSelection('f'));
  });

  it("set(): a cell under a hidden or locked group doesn't enter the selection", () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'l', name: 'locked', parentId: null, childIds: [], locked: true }, 0);
    doc.setCells([
      [0, 0, 0, 1],
      [5, 0, 0, 2],
    ]);
    doc.setCellMembership('0,0,0', 'l');
    const sel = new SelectionStore(doc);

    sel.set(doc.cellSelection([0, 0, 0], [5, 0, 0]));
    expect(sel.get()).toEqual(doc.cellSelection([5, 0, 0]));
  });

  it('locking a selected group afterward automatically drops it from the selection on the next doc change', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g', name: 'G', parentId: null, childIds: [] }, 0);
    const sel = new SelectionStore(doc);
    sel.set(doc.groupSelection('g'));
    expect(sel.get()).toEqual(doc.groupSelection('g'));

    doc.rawTree.setLocked('g', true);
    doc.applyTransaction({ ops: [] }); // poke (triggers validate())

    expect(sel.get()).toEqual({ kind: 'none' });
  });

  it("if an ancestor is locked/hidden, that's inherited and it drops out of the selection", () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'p', name: 'parent', parentId: null, childIds: [], hidden: true }, 0);
    doc.insertGroup({ id: 'c', name: 'child', parentId: 'p', childIds: [] }, 0);
    const sel = new SelectionStore(doc);
    sel.set(doc.groupSelection('c'));
    expect(sel.get()).toEqual({ kind: 'none' });
  });
});

describe('SelectionStore — subscribe/notify (#13)', () => {
  it('subscribe returns an unsubscribe function, and calling it stops further notifications', () => {
    const doc = makeDoc();
    const sel = new SelectionStore(doc);
    const fn = vi.fn();
    const unsubscribe = sel.subscribe(fn);
    sel.set(doc.cellSelection([0, 0, 0]));
    unsubscribe();
    sel.clear();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

/**
 * The invariant for group selection (#37 B1b review P1).
 *
 * Root cause: the `Selection` groups variant didn't guarantee "exists / unique / outermost
 * only." Ctrl/Shift selection in Layers can put both a parent and a child into `ids` at the
 * same time, so dragging / nudging a group in that state **puts the same delta into both the
 * parent's transform and the child's transform, moving descendant cells twice as far**.
 * `snapshotSelection` also double-collects the same subtree.
 *
 * The ops-side builders (buildGroup / buildUngroup / buildDeleteSelection / buildDuplicate)
 * ran everything through `dropDescendantIds`, but the paths crossing the selection boundary
 * (ghost drag / nudge / resolveRefs / snapshotSelection) let it pass through untouched.
 * **Enforcing the invariant at that one boundary protects every consumer.**
 */
describe('SelectionStore — group selection invariant (review P1)', () => {
  /** P (directly under root, translated) > C (child). C holds the cell */
  function nested(): DocumentFixture {
    const doc = new DocumentFixture();
    doc.insertGroup(
      { id: 'p', name: 'P', parentId: null, childIds: [], transform: { angleSteps: 0, translate: [3, 0, 0], pivot2: [0, 0] } },
      0,
    );
    doc.insertGroup({ id: 'c', name: 'C', parentId: 'p', childIds: [] }, 0);
    doc.setOwnerCells('c', [['0,0,0', 1]]);
    return doc;
  }

  it('setting an ancestor and descendant together drops the descendant (outermost only)', () => {
    const doc = nested();
    const sel = new SelectionStore(doc);
    sel.set(doc.groupSelection('p', 'c'));
    expect(sel.get()).toEqual(doc.groupSelection('p'));
  });

  it('only the outermost remains even with the selection order reversed (child first)', () => {
    const doc = nested();
    const sel = new SelectionStore(doc);
    sel.set(doc.groupSelection('c', 'p'));
    expect(sel.get()).toEqual(doc.groupSelection('p'));
  });

  it('a nonexistent id is dropped', () => {
    const doc = nested();
    const sel = new SelectionStore(doc);
    sel.set(doc.groupSelection('p', 'ghost'));
    expect(sel.get()).toEqual(doc.groupSelection('p'));
  });

  it('a duplicate id collapses into one', () => {
    const doc = nested();
    const sel = new SelectionStore(doc);
    sel.set(doc.groupSelection('p', 'p'));
    expect(sel.get()).toEqual(doc.groupSelection('p'));
  });

  it('siblings (no ancestor relationship) both remain', () => {
    const doc = nested();
    doc.insertGroup({ id: 'q', name: 'Q', parentId: null, childIds: [] }, 1);
    const sel = new SelectionStore(doc);
    sel.set(doc.groupSelection('p', 'q'));
    expect(sel.get()).toEqual(doc.groupSelection('p', 'q'));
  });

  it("resolveRefs / resolveCells don't double-collect the subtree", () => {
    const doc = nested();
    const sel = new SelectionStore(doc);
    sel.set(doc.groupSelection('p', 'c'));
    expect(sel.resolveRefs()).toHaveLength(1);
    expect(sel.resolveCells().size).toBe(1);
  });

  it('nudging a group while parent+child are selected moves descendant cells by exactly 1 cell in world space (no double application)', () => {
    const doc = nested();
    const sel = new SelectionStore(doc);
    sel.set(doc.groupSelection('p', 'c'));

    const before = doc.index.worldOf({ ownerId: 'c', localCell: [0, 0, 0] });
    expect(before).toEqual([3, 0, 0]); // P's translate is in effect

    // same shape as selecttool.handleNudge / commitDrag: buildTranslateGroup for each selected id
    const current = sel.get();
    if (current.kind !== 'groups') throw new Error('expected a groups selection');
    const ops: DocOp[] = [];
    for (const id of current.ids) {
      const result = buildTranslateGroup(doc, id, [1, 0, 0]);
      if ('error' in result) throw new Error(result.error);
      ops.push(...result.tx.ops);
    }
    doc.applyTransaction({ ops });

    expect(doc.index.worldOf({ ownerId: 'c', localCell: [0, 0, 0] })).toEqual([4, 0, 0]); // if it moved 2 cells it would be [5,0,0]
  });
});
