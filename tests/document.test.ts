import { describe, expect, it, vi } from 'vitest';
import type { OwnerId } from '../src/core/cellref';
import type { DocOp, DocumentChange, Transaction } from '../src/core/document';
import { OwnerVoxelStore, type EditorScene } from '../src/core/ownervoxels';
import { SceneTree, type GroupNode } from '../src/core/scenetree';
import type { GroupTransform } from '../src/core/transform';
import { DocumentFixture, erase, place } from './helpers/document-fixture';

function makeDoc(): DocumentFixture {
  return new DocumentFixture();
}

/**
 * Build a standalone EditorScene to pass to `Document.replaceAll`.
 * Same shape as what v3 load returns — the load unit is now a pair of
 * "owner-local cells + tree", not a "world-coordinate cell array + tree".
 */
function sceneOf(cells: Array<[OwnerId, string, number]>, nodes: GroupNode[] = []): EditorScene {
  const tree = new SceneTree();
  tree.replaceAll(nodes);
  const store = new OwnerVoxelStore();
  for (const [owner, key, value] of cells) store.set(owner, key, value);
  return { tree, cells: store };
}

describe('Document — EditSession / applyEdits owner-local resolution rules', () => {
  it('erase removes the visible winner ref (same even for cells with an owner)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'G', parentId: null, childIds: [] }, 0);
    doc.setCells([[0, 0, 0, 1]]);
    doc.setCellMembership('0,0,0', 'g0');

    const session = doc.beginSession();
    session.stagePreview([erase(0, 0, 0)]);
    session.commit();

    expect(doc.world.has(0, 0, 0)).toBe(false);
    expect(doc.rawCells.has('g0', '0,0,0')).toBe(false);
  });

  it('placing into empty space becomes a cell of the session placement owner', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'G', parentId: null, childIds: [] }, 0);

    const session = doc.beginSession('g0');
    session.stagePreview([place(1, 0, 0, 2)]);
    session.commit();

    expect(doc.ownerAt(1, 0, 0)).toBe('g0');
    expect(doc.rawCells.get('g0', '1,0,0')).toBe(2);
  });

  it('a null placement owner (root) becomes an unassigned cell', () => {
    const doc = makeDoc();
    const session = doc.beginSession(null);
    session.stagePreview([place(1, 0, 0, 2)]);
    session.commit();

    expect(doc.ownerAt(1, 0, 0)).toBeNull();
  });

  it('overwrite keeps the winner\'s owner and only swaps the value (membership does not move to the active group)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'G', parentId: null, childIds: [] }, 0);
    doc.insertGroup({ id: 'g1', name: 'active', parentId: null, childIds: [] }, 1);
    doc.setCells([[0, 0, 0, 1]]);
    doc.setCellMembership('0,0,0', 'g0');

    // placement owner is g1, but since this is an overwrite, membership stays g0
    const session = doc.beginSession('g1');
    session.stagePreview([{ kind: 'overwrite', worldCell: [0, 0, 0], afterWorldRaw: 3 }]);
    session.commit();

    expect(doc.ownerAt(0, 0, 0)).toBe('g0');
    expect(doc.world.get(0, 0, 0)).toBe(3);
    expect(doc.rawCells.has('g1', '0,0,0')).toBe(false);
  });

  it('placing over another owner\'s winner does not destroy that owner\'s cell', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'a', name: 'A', parentId: null, childIds: [] }, 0);
    doc.insertGroup({ id: 'b', name: 'B', parentId: null, childIds: [] }, 1);
    doc.setCells([[0, 0, 0, 1]]);
    doc.setCellMembership('0,0,0', 'b'); // b is the winner (later in paint order)

    const session = doc.beginSession('a');
    session.stagePreview([place(0, 0, 0, 7)]);
    session.commit();

    expect(doc.rawCells.get('b', '0,0,0')).toBe(1); // not destroyed
    expect(doc.rawCells.get('a', '0,0,0')).toBe(7); // added on a's side
    expect(doc.world.get(0, 0, 0)).toBe(1); // winner is still b (later in paint order)
  });

  it('applyEdits also performs the voxel write itself (fill/range path)', () => {
    const doc = makeDoc();
    doc.applyEdits([place(0, 0, 0, 5), place(1, 0, 0, 6)], null);
    expect(doc.world.get(0, 0, 0)).toBe(5);
    expect(doc.world.get(1, 0, 0)).toBe(6);
  });
});

describe('Document — undo/redo', () => {
  it('a voxel-only place → undo empties it, redo restores it', () => {
    const doc = makeDoc();
    doc.applyEdits([place(0, 0, 0, 7)], null);
    expect(doc.world.has(0, 0, 0)).toBe(true);

    doc.undo();
    expect(doc.world.has(0, 0, 0)).toBe(false);

    doc.redo();
    expect(doc.world.has(0, 0, 0)).toBe(true);
    expect(doc.world.get(0, 0, 0)).toBe(7);
  });

  it('undo is a no-op when the stack is empty (notify does not fire either)', () => {
    const doc = makeDoc();
    let notified = 0;
    doc.subscribe(() => notified++);
    doc.undo();
    expect(notified).toBe(0);
  });

  it('redo is a no-op when the stack is empty (notify does not fire either)', () => {
    const doc = makeDoc();
    let notified = 0;
    doc.subscribe(() => notified++);
    doc.redo();
    expect(notified).toBe(0);
  });

  it('a compound transaction of createGroup + membership move (erase+place pair) reverses correctly on undo/redo', () => {
    const doc = makeDoc();
    doc.setCells([[2, 0, 0, 4]]);
    const node: GroupNode = { id: 'g0', name: 'New Group', parentId: null, childIds: [] };
    const tx: Transaction = {
      ops: [
        { kind: 'createGroup', node, index: 0 },
        { kind: 'voxel', owner: null, key: '2,0,0', before: 4, after: null },
        { kind: 'voxel', owner: 'g0', key: '2,0,0', before: null, after: 4 },
      ],
    };
    doc.applyTransaction(tx);
    expect(doc.tree.getNode('g0')).toEqual(node);
    expect(doc.ownerAt(2, 0, 0)).toBe('g0');

    doc.undo();
    // undo applies in reverse order: membership is cleared first, then createGroup is undone (removeNode)
    expect(doc.ownerAt(2, 0, 0)).toBeNull();
    expect(doc.tree.getNode('g0')).toBeUndefined();

    doc.redo();
    expect(doc.tree.getNode('g0')).toEqual(node);
    expect(doc.ownerAt(2, 0, 0)).toBe('g0');
  });

  it('setGroupHidden/setGroupLocked ops reverse correctly on undo/redo', () => {
    const doc = makeDoc();
    const node: GroupNode = { id: 'g0', name: 'A', parentId: null, childIds: [] };
    doc.applyTransaction({ ops: [{ kind: 'createGroup', node, index: 0 }] });

    doc.applyTransaction({ ops: [{ kind: 'setGroupHidden', id: 'g0', before: false, after: true }] });
    expect(doc.tree.getNode('g0')?.hidden).toBe(true);
    doc.undo();
    expect(doc.tree.getNode('g0')?.hidden).toBe(false);
    doc.redo();
    expect(doc.tree.getNode('g0')?.hidden).toBe(true);

    doc.applyTransaction({ ops: [{ kind: 'setGroupLocked', id: 'g0', before: false, after: true }] });
    expect(doc.tree.getNode('g0')?.locked).toBe(true);
    doc.undo();
    expect(doc.tree.getNode('g0')?.locked).toBe(false);
    doc.redo();
    expect(doc.tree.getNode('g0')?.locked).toBe(true);
  });
});

describe('Document — replaceAll / clearAll', () => {
  it('replaceAll clears history (an immediate undo is a no-op)', () => {
    const doc = makeDoc();
    doc.applyEdits([place(0, 0, 0, 1)], null);

    doc.replaceAll(sceneOf([[null, '5,0,5', 9]]));
    expect(doc.world.size).toBe(1);
    expect(doc.world.get(5, 0, 5)).toBe(9);

    let notified = 0;
    doc.subscribe(() => notified++);
    doc.undo();
    expect(notified).toBe(0);
    expect(doc.world.size).toBe(1); // unchanged = no-op confirmed
  });

  it('replaceAll also replaces the tree (an empty tree if omitted)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'stale', name: 'old', parentId: null, childIds: [] }, 0);

    const node: GroupNode = { id: 'g0', name: 'new', parentId: null, childIds: [] };
    doc.replaceAll(sceneOf([], [node]));
    expect(doc.tree.getNode('stale')).toBeUndefined();
    expect(doc.tree.getNode('g0')).toEqual(node);

    doc.replaceAll(sceneOf([])); // empty scene → becomes an empty tree
    expect(doc.tree.getNode('g0')).toBeUndefined();
  });

  it('clearAll wipes world + tree + history entirely', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'G', parentId: null, childIds: [] }, 0);
    doc.applyEdits([place(0, 0, 0, 1)], null);

    doc.clearAll();
    expect(doc.world.size).toBe(0);
    expect(doc.tree.getNode('g0')).toBeUndefined();

    let notified = 0;
    doc.subscribe(() => notified++);
    doc.undo();
    expect(notified).toBe(0);
  });
});

describe('Document — atomicity of replaceAll/clearAll (a review finding, discovered while investigating similar root-cause paths)', () => {
  it('replaceAll: if tree.replaceAll fails on a pre-order violation, world/tree/history stay exactly as they were before the load', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'old', name: 'OLD', parentId: null, childIds: [] }, 0);
    doc.setCells([[9, 0, 9, 7]]);
    doc.setCellMembership('9,0,9', 'old');
    doc.applyEdits([place(1, 0, 1, 2)], null); // build up some history in the undo/redo stack
    const undoLenBefore = doc.undoDepth;

    // parentId 'missing' never appears anywhere in the nodes array = a pre-order violation,
    // so SceneTree.replaceAll throws on ingest. We pass broken input directly, bypassing sceneOf
    const brokenScene = {
      tree: {
        allNodesPreOrder: () => [{ id: 'child', name: 'C', parentId: 'missing', childIds: [] }].values(),
      },
      cells: new OwnerVoxelStore(),
    } as unknown as EditorScene;

    expect(() => doc.replaceAll(brokenScene)).toThrow();

    // the pre-load world/tree/history remain untouched (no partial application of new data, no loss of old data)
    expect(doc.world.get(9, 0, 9)).toBe(7);
    expect(doc.world.get(5, 0, 5)).toBeNull(); // none of the new data got in, even partially
    expect(doc.tree.getNode('old')).toBeDefined();
    expect(doc.ownerAt(9, 0, 9)).toBe('old');
    expect(doc.tree.getNode('child')).toBeUndefined(); // no fragment of the failed new data remains either
    expect(doc.undoDepth).toBe(undoLenBefore);
  });

  it('clearAll: even if world.onChange throws, clearAll itself still succeeds and world/tree are cleared (observer failure is independent of operation success, design unified in review)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'G', parentId: null, childIds: [] }, 0);
    doc.setCells([[0, 0, 0, 1]]);
    doc.setCellMembership('0,0,0', 'g0');

    // the observer is WorldIndex's content notification (the source of mesh updates). Whether it throws is independent of whether the operation succeeds
    const unsubscribe = doc.index.subscribe(() => {
      throw new Error('mesh rebuild failed');
    });

    try {
      expect(() => doc.clearAll()).not.toThrow();

      expect(doc.world.get(0, 0, 0)).toBeNull(); // the clear itself succeeded
      expect(doc.tree.getNode('g0')).toBeUndefined();
      expect(doc.undoDepth).toBe(0);
    } finally {
      unsubscribe();
    }
  });
});

describe('Document — auto-prune of empty groups', () => {
  it('erasing a group\'s last cell via applyEdits prunes the group', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'G', parentId: null, childIds: [] }, 0);
    doc.setCells([[0, 0, 0, 1]]);
    doc.setCellMembership('0,0,0', 'g0');

    doc.applyEdits([erase(0, 0, 0)], null);

    expect(doc.tree.getNode('g0')).toBeUndefined();
    expect(doc.world.has(0, 0, 0)).toBe(false);
  });

  it('prune cascades to ancestors (a parent left empty by its child also disappears in the same transaction)', () => {
    const doc = makeDoc();
    // childIds starts as [] because insertNode(child, ...) splices it into the parent's array
    // (the parent variable and the tree's internal object share the same reference, so the later toEqual comparison matches automatically)
    const parent: GroupNode = { id: 'p', name: 'parent', parentId: null, childIds: [] };
    const child: GroupNode = { id: 'c', name: 'child', parentId: 'p', childIds: [] };
    doc.insertGroup(parent, 0);
    doc.insertGroup(child, 0);
    doc.setCells([[3, 0, 3, 2]]);
    doc.setCellMembership('3,0,3', 'c');

    doc.applyEdits([erase(3, 0, 3)], null);

    expect(doc.tree.getNode('c')).toBeUndefined();
    expect(doc.tree.getNode('p')).toBeUndefined();
  });

  it('undo restores multiple cascade-pruned groups + a cell in one step, and redo prunes them again', () => {
    const doc = makeDoc();
    // childIds starts as [] because insertNode(child, ...) splices it into the parent's array
    // (the parent variable and the tree's internal object share the same reference, so the later toEqual comparison matches automatically)
    const parent: GroupNode = { id: 'p', name: 'parent', parentId: null, childIds: [] };
    const child: GroupNode = { id: 'c', name: 'child', parentId: 'p', childIds: [] };
    doc.insertGroup(parent, 0);
    doc.insertGroup(child, 0);
    doc.setCells([[3, 0, 3, 2]]);
    doc.setCellMembership('3,0,3', 'c');

    doc.applyEdits([erase(3, 0, 3)], null);
    expect(doc.tree.getNode('c')).toBeUndefined();
    expect(doc.tree.getNode('p')).toBeUndefined();

    doc.undo();
    expect(doc.world.has(3, 0, 3)).toBe(true);
    expect(doc.tree.getNode('c')).toEqual(child);
    // after 'p' was deleteGroup'd by prune, undo's insertNode(node, index) restores it as a fresh
    // object with childIds:[], and then 'c''s deleteGroup backward (insertNode) splices 'c' into
    // that childIds — the restored instance is a different object reference than the original
    // parent variable, so the expected value is written out explicitly (the value itself is correct)
    expect(doc.tree.getNode('p')).toEqual({ id: 'p', name: 'parent', parentId: null, childIds: ['c'] });
    expect(doc.ownerAt(3, 0, 3)).toBe('c');

    doc.redo();
    expect(doc.world.has(3, 0, 3)).toBe(false);
    expect(doc.tree.getNode('c')).toBeUndefined();
    expect(doc.tree.getNode('p')).toBeUndefined();
  });

  it('a transaction that does not touch membership does not prune an unrelated empty group', () => {
    const doc = makeDoc();
    // an unrelated pre-existing empty group (created via direct tree operations, untouched by any op)
    doc.insertGroup({ id: 'stale-empty', name: 'stale', parentId: null, childIds: [] }, 0);

    doc.applyEdits([place(8, 0, 8, 4)], null);

    expect(doc.tree.getNode('stale-empty')).toEqual({
      id: 'stale-empty',
      name: 'stale',
      parentId: null,
      childIds: [],
    });
  });
});

describe('Document — no-op on empty edits', () => {
  it('applyEdits neither pushes nor notifies when intents is empty', () => {
    const doc = makeDoc();
    let notified = 0;
    doc.subscribe(() => notified++);

    doc.applyEdits([], null);
    expect(notified).toBe(0);

    // if nothing was pushed onto the stack, undo/redo also stay no-ops (no notify)
    doc.undo();
    expect(notified).toBe(0);
    doc.redo();
    expect(notified).toBe(0);
  });
});

describe('Document — the undo stack does not hold aliases to caller-owned objects (regression test)', () => {
  it('an external mutation to the node passed into applyTransaction is not reflected after undo→redo', () => {
    const doc = makeDoc();
    const node: GroupNode = { id: 'g0', name: 'before', parentId: null, childIds: [] };
    doc.applyTransaction({ ops: [{ kind: 'createGroup', node, index: 0 }] });

    // reproduces an attack where, after applying once through Document, the caller mutates the alias it still holds
    node.name = 'after';
    node.childIds.push('injected');
    expect(doc.tree.getNode('g0')?.name).toBe('before'); // the current tree is untouched thanks to insertNode's defensive copy

    doc.undo();
    doc.redo();

    // if the Transaction pushed onto the undo stack does not itself hold the alias,
    // 'after'/'injected' will not reappear on redo
    expect(doc.tree.getNode('g0')?.name).toBe('before');
    expect(doc.tree.getNode('g0')?.childIds).toEqual([]);
  });

  it('an external mutation to the voxel op passed into applyTransaction is not reflected after undo→redo', () => {
    const doc = makeDoc();
    const op: DocOp = { kind: 'voxel', owner: null, key: '0,0,0', before: null, after: 5 };
    doc.applyTransaction({ ops: [op] });

    (op as { after: number | null }).after = 99; // reproduces an attack where the caller mutates the alias it still holds
    expect(doc.world.get(0, 0, 0)).toBe(5);

    doc.undo();
    doc.redo();

    expect(doc.world.get(0, 0, 0)).toBe(5); // 99 does not reappear
  });

  it('commitStaged (the commitStroke path) likewise does not hold an alias', () => {
    const doc = makeDoc();
    const node: GroupNode = { id: 'g0', name: 'before', parentId: null, childIds: [] };
    doc.commitStaged({ ops: [{ kind: 'createGroup', node, index: 0 }] });

    node.name = 'after';
    doc.undo();
    doc.redo();

    expect(doc.tree.getNode('g0')?.name).toBe('before');
  });

  it('a primitives-only op (renameGroup) also does not hold an alias to the op object itself (a recurrence: a missing default branch in cloneOp)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'A', parentId: null, childIds: [] }, 0);
    const op = { kind: 'renameGroup' as const, id: 'g0', before: 'A', after: 'B' };
    doc.applyTransaction({ ops: [op] });
    expect(doc.tree.getNode('g0')?.name).toBe('B');

    op.after = 'HACKED'; // reproduces an attack where the caller mutates the alias it still holds to the op object
    doc.undo();
    doc.redo();

    expect(doc.tree.getNode('g0')?.name).toBe('B'); // 'HACKED' does not reappear
  });
});

describe('Document — atomicity of applyTransaction/commitStaged', () => {
  it('applyTransaction: a transaction containing an invalid op (reparentGroup on a nonexistent group) leaves no partial application', () => {
    const doc = makeDoc();
    expect(() =>
      doc.applyTransaction({
        ops: [
          { kind: 'voxel', owner: null, key: '0,0,0', before: null, after: 1 }, // this one succeeds
          { kind: 'reparentGroup', id: 'ghost', beforeParent: null, beforeIndex: 0, afterParent: null, afterIndex: 0 }, // nonexistent node → throws
        ],
      }),
    ).toThrow();

    // the voxel op would have succeeded, but the reparentGroup failure rolls everything back
    expect(doc.world.get(0, 0, 0)).toBeNull();
    expect(doc.undoDepth).toBe(0);
  });

  it('applyTransaction: does not trust a stale before claimed by an op, and rolls back to the actual pre-transaction state (reproduces a review finding)', () => {
    const doc = makeDoc();
    doc.setCells([[0, 0, 0, 5]]); // the actual pre-transaction value is 5

    expect(() =>
      doc.applyTransaction({
        ops: [
          { kind: 'voxel', owner: null, key: '0,0,0', before: null, after: 1 }, // stale before (claims null when it's actually 5)
          { kind: 'renameGroup', id: 'ghost', before: 'a', after: 'b' }, // nonexistent → throws
        ],
      }),
    ).toThrow();

    // after rollback it returns to the actual pre-transaction value (5), not the stale before (null) claimed by the op
    expect(doc.world.get(0, 0, 0)).toBe(5);
    expect(doc.undoDepth).toBe(0);
  });

  it('applyTransaction: membership/renameGroup/setGroupHidden/setGroupLocked/reparentGroup also do not trust a stale before', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'p', name: 'P', parentId: null, childIds: [] }, 0);
    doc.insertGroup({ id: 'g0', name: 'real-name', parentId: 'p', childIds: [] }, 0);
    doc.setCells([[0, 0, 0, 1]]);
    doc.setCellMembership('0,0,0', 'g0');
    doc.rawTree.setHidden('g0', true);
    doc.rawTree.setLocked('g0', true);

    expect(() =>
      doc.applyTransaction({
        ops: [
          { kind: 'voxel', owner: 'g0', key: '0,0,0', before: 999, after: null }, // before is stale (actually 1)
          { kind: 'renameGroup', id: 'g0', before: 'stale-name', after: 'renamed' }, // stale (actually real-name)
          { kind: 'setGroupHidden', id: 'g0', before: false, after: false }, // stale (actually true)
          { kind: 'setGroupLocked', id: 'g0', before: false, after: false }, // stale (actually true)
          { kind: 'reparentGroup', id: 'g0', beforeParent: null, beforeIndex: 0, afterParent: null, afterIndex: 0 }, // the actual parent is p
          { kind: 'renameGroup', id: 'ghost', before: 'x', after: 'y' }, // nonexistent → throws, everything up to here rolls back
        ],
      }),
    ).toThrow();

    expect(doc.ownerAt(0, 0, 0)).toBe('g0'); // not mistakenly restored to 'stale-group' due to the stale before
    expect(doc.tree.getNode('g0')?.name).toBe('real-name');
    expect(doc.tree.getNode('g0')?.hidden).toBe(true);
    expect(doc.tree.getNode('g0')?.locked).toBe(true);
    expect(doc.tree.getNode('g0')?.parentId).toBe('p');
    expect(doc.undoDepth).toBe(0);
  });

  it('applyTransaction: an onChange throw after a voxel write does not affect whether the transaction succeeds (design unified in review)', () => {
    // Up through the 2nd review round, "onChange throw = subject to rollback" was the rule, but the
    // 3rd review round pointed out that "treating a notification failure to an observer as an
    // operation failure will make state and history diverge unless every path — undo/redo,
    // Document.notify, etc. — follows the same convention," and the design was unified around
    // VoxelWorld.safeNotify (always neutralized at the source). An onChange throw no longer
    // fails the transaction — it commits normally
    const doc = makeDoc();
    doc.setCells([[0, 0, 0, 5]]);
    // the observer is WorldIndex's content notification (the source of mesh updates). Whether it throws is independent of whether the operation succeeds
    const unsubscribe = doc.index.subscribe(() => {
      throw new Error('mesh rebuild failed');
    });

    try {
      expect(() =>
        doc.applyTransaction({ ops: [{ kind: 'voxel', owner: null, key: '0,0,0', before: 5, after: 1 }] }),
      ).not.toThrow();

      expect(doc.world.get(0, 0, 0)).toBe(1); // committed normally
      expect(doc.undoDepth).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  it('applyTransaction: a mixed voxel + tree op transaction also commits both without being affected by an onChange throw', () => {
    const doc = makeDoc();
    // the observer is WorldIndex's content notification (the source of mesh updates). Whether it throws is independent of whether the operation succeeds
    const unsubscribe = doc.index.subscribe(() => {
      throw new Error('mesh rebuild failed');
    });

    try {
      expect(() =>
        doc.applyTransaction({
          ops: [
            { kind: 'createGroup', node: { id: 'g0', name: 'G', parentId: null, childIds: [] }, index: 0 },
            { kind: 'voxel', owner: null, key: '0,0,0', before: null, after: 1 },
          ],
        }),
      ).not.toThrow();

      expect(doc.world.get(0, 0, 0)).toBe(1);
      expect(doc.tree.getNode('g0')).toBeDefined();
      expect(doc.undoDepth).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  it('applyTransaction: an invalid deleteGroup (deleting a non-empty group) leaves no partial application on the voxel side either', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'G', parentId: null, childIds: [] }, 0);
    doc.setCells([[0, 0, 0, 1]]);
    doc.setCellMembership('0,0,0', 'g0'); // g0 has a cell = not empty

    expect(() =>
      doc.applyTransaction({
        ops: [
          { kind: 'voxel', owner: null, key: '5,0,0', before: null, after: 2 },
          { kind: 'deleteGroup', node: { id: 'g0', name: 'G', parentId: null, childIds: [] }, index: 0 }, // has a cell, so this throws
        ],
      }),
    ).toThrow();

    expect(doc.world.get(5, 0, 0)).toBeNull(); // the voxel op rolls back too
    expect(doc.tree.getNode('g0')).toBeDefined(); // g0 remains too
    expect(doc.undoDepth).toBe(0);
  });

  it('commitStaged: leaves an already-staged voxel as-is, and rolls back only the invalid tree op', () => {
    const doc = makeDoc();
    doc.stageRaw(null, '0,0,0', 1); // reproduces the immediate reflection during a drag (commitStaged assumes it does not forward-apply voxels)

    expect(() =>
      doc.commitStaged({
        ops: [
          { kind: 'voxel', owner: null, key: '0,0,0', before: null, after: 1 },
          { kind: 'renameGroup', id: 'ghost', before: 'a', after: 'b' }, // nonexistent → throws
        ],
      }),
    ).toThrow();

    expect(doc.undoDepth).toBe(0); // the transaction itself was not committed
  });
});

describe('Document.beginSession() — EditSession', () => {
  it('stagePreview reflects into world immediately but does not push undo history', () => {
    const doc = makeDoc();
    const session = doc.beginSession();
    session.stagePreview([place(0, 0, 0, 1)]);

    expect(doc.world.get(0, 0, 0)).toBe(1);
    expect(doc.undoDepth).toBe(0);
  });

  it('commit records the diff against baseline as a single undo unit', () => {
    const doc = makeDoc();
    const session = doc.beginSession();
    session.stagePreview([
      place(0, 0, 0, 1),
      place(1, 0, 0, 2),
    ]);
    session.commit();

    expect(doc.undoDepth).toBe(1);
    expect(doc.world.get(0, 0, 0)).toBe(1);
    expect(doc.world.get(1, 0, 0)).toBe(2);

    doc.undo();
    expect(doc.world.get(0, 0, 0)).toBeNull();
    expect(doc.world.get(1, 0, 0)).toBeNull();
  });

  it('commit does not pollute undo history when there is no diff (equivalent to a zero-offset drag)', () => {
    const doc = makeDoc();
    doc.setCells([[0, 0, 0, 1]]);
    const session = doc.beginSession();
    session.stagePreview([place(0, 0, 0, 1)]); // effectively no change
    session.commit();

    expect(doc.undoDepth).toBe(0);
  });

  it('commit includes extraOps (structural ops) in the same transaction', () => {
    const doc = makeDoc();
    // the session holds the placement owner, so membership is decided by the session, not extraOps.
    // extraOps only carries "structural changes we want in the same undo unit" (e.g. creating a group at the same time as placing)
    const session = doc.beginSession('g0');
    doc.insertGroup({ id: 'g0', name: 'G', parentId: null, childIds: [] }, 0);
    session.stagePreview([place(0, 0, 0, 1)]);
    session.commit([{ kind: 'renameGroup', id: 'g0', before: 'G', after: 'renamed while placing' }]);

    expect(doc.undoDepth).toBe(1);
    expect(doc.ownerAt(0, 0, 0)).toBe('g0');
    expect(doc.tree.getNode('g0')?.name).toBe('renamed while placing');

    doc.undo();
    expect(doc.world.get(0, 0, 0)).toBeNull();
    expect(doc.tree.getNode('g0')?.name).toBe('G');
  });

  it('cancel restores to baseline, and both world/undo history match the pre-session state', () => {
    const doc = makeDoc();
    doc.setCells([[0, 0, 0, 1]]);
    const baselineUndoLen = doc.undoDepth;

    const session = doc.beginSession();
    session.stagePreview([
      erase(0, 0, 0), // try erasing
      place(1, 0, 0, 2), // try placing something new
    ]);
    expect(doc.world.get(0, 0, 0)).toBeNull();
    expect(doc.world.get(1, 0, 0)).toBe(2);

    session.cancel();

    expect(doc.world.get(0, 0, 0)).toBe(1); // restored to the pre-session state
    expect(doc.world.get(1, 0, 0)).toBeNull();
    expect(doc.undoDepth).toBe(baselineUndoLen); // undo history did not grow
  });

  it('only one of commit/cancel can take effect (a call after close is ignored, safety against double-termination)', () => {
    const doc = makeDoc();
    const session = doc.beginSession();
    session.stagePreview([place(0, 0, 0, 1)]);
    session.commit();
    expect(doc.undoDepth).toBe(1);

    session.cancel(); // already closed, nothing happens
    expect(doc.undoDepth).toBe(1);
    expect(doc.world.get(0, 0, 0)).toBe(1);
  });

  it('even if commit fails due to an invalid extraOps entry (renaming a nonexistent group), it restores to baseline (reproduces a review finding)', () => {
    const doc = makeDoc();
    const session = doc.beginSession();
    session.stagePreview([place(0, 0, 0, 1)]);

    expect(() => session.commit([{ kind: 'renameGroup', id: 'ghost', before: 'a', after: 'b' }])).toThrow();

    // previously, commit() set closed=true right at the start, so after a failure world would
    // still hold 1 while cancel() had already become a no-op — a "stuck" state. After the fix,
    // a commit failure restores to baseline
    expect(doc.world.get(0, 0, 0)).toBeNull();
    expect(doc.undoDepth).toBe(0);

    session.cancel(); // already closed (closed even on failure), so calling it again is a safe no-op
    expect(doc.world.get(0, 0, 0)).toBeNull();
  });

  it('commit: rejects at runtime even if a voxel op sneaks into extraOps by bypassing the type system (reproduces a review finding)', () => {
    const doc = makeDoc();
    const session = doc.beginSession();
    session.stagePreview([place(0, 0, 0, 1)]);

    // reproduces, via `any` (a caller that slips past type checking), a contamination that
    // would normally be a compile error against the NonVoxelDocOp[] type
    const sneaky: unknown = [{ kind: 'voxel', owner: null, key: '9,0,0', before: null, after: 99 }];
    expect(() => session.commit(sneaky as Parameters<typeof session.commit>[0])).toThrow();

    // the contaminating voxel op does not end up "pushed into history without touching world, then suddenly applied on redo"
    expect(doc.world.get(9, 0, 0)).toBeNull();
    expect(doc.undoDepth).toBe(0);
  });
});

describe('Document — notify exceptions and state/history consistency (reproduces a review finding, root cause A)', () => {
  it('undo: a throw in world.onChange used to skip the push onto redoStack, making redo impossible', () => {
    const doc = makeDoc();
    doc.applyTransaction({ ops: [{ kind: 'voxel', owner: null, key: '0,0,0', before: null, after: 1 }] });

    const unsubscribe = doc.index.subscribe(() => {
      throw new Error('observer failed');
    });
    try {
      doc.undo(); // after the fix, an observer failure no longer affects whether undo succeeds (it does not throw)
    } finally {
      unsubscribe();
    }

    expect(doc.world.get(0, 0, 0)).toBeNull(); // undo itself completed
    doc.redo();
    expect(doc.world.get(0, 0, 0)).toBe(1); // redo works (the old implementation left redoStack empty and could not go back)
  });

  it('applyTransaction: a throw in a Document listener does not propagate to the caller, and state/history match the visible result', () => {
    const doc = makeDoc();
    doc.subscribe(() => {
      throw new Error('document observer failed');
    });

    expect(() =>
      doc.applyTransaction({ ops: [{ kind: 'voxel', owner: null, key: '0,0,0', before: null, after: 1 }] }),
    ).not.toThrow();

    expect(doc.world.get(0, 0, 0)).toBe(1);
    expect(doc.undoDepth).toBe(1);
  });

  it('EditSession.commit: does not mistake a Document listener throw for a commit failure, keeping world and history consistent', () => {
    const doc = makeDoc();
    doc.subscribe(() => {
      throw new Error('document observer failed');
    });

    const session = doc.beginSession();
    session.stagePreview([place(0, 0, 0, 1)]);

    expect(() => session.commit()).not.toThrow();

    // the old implementation mistook a notify() throw inside commitStaged for a "commit
    // failure," reverting only world to baseline while history stayed committed — a split state
    expect(doc.world.get(0, 0, 0)).toBe(1);
    expect(doc.undoDepth).toBe(1);
  });
});

describe('Document/SceneTree — core-side invariant validation (reproduces a review finding, root cause B)', () => {
  it('applyTransaction: a createGroup with a duplicate id is rejected, and rollback does not destroy the existing group', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'original', parentId: null, childIds: [] }, 0);

    expect(() =>
      doc.applyTransaction({
        ops: [
          { kind: 'createGroup', node: { id: 'g0', name: 'replacement', parentId: null, childIds: [] }, index: 0 },
          { kind: 'renameGroup', id: 'ghost', before: 'x', after: 'y' }, // nonexistent → throws, triggers rollback
        ],
      }),
    ).toThrow();

    expect(doc.tree.getNode('g0')?.name).toBe('original'); // neither overwritten nor lost
  });

  it('applyTransaction: a voxel op whose owner is a nonexistent group is rejected (owner consistency)', () => {
    const doc = makeDoc();
    doc.setCells([[0, 0, 0, 1]]);

    // the membership op has been removed. Since membership is "that owner having a cell,"
    // an op writing to an owner absent from the tree represents the same violation
    // (rejected by assertValidRuntimeScene's owner-consistency check)
    expect(() =>
      doc.applyTransaction({
        ops: [
          { kind: 'voxel', owner: 'nonexistent', key: '9,0,0', before: null, after: 1 },
          { kind: 'renameGroup', id: 'ghost', before: 'a', after: 'b' }, // mix in a structural op to route through the full-entry validation
        ],
      }),
    ).toThrow();

    expect(doc.rawCells.has('nonexistent', '9,0,0')).toBe(false);
    expect(doc.undoDepth).toBe(0);
  });

  it('applyTransaction: a reparentGroup operation that would create a parent-child cycle is rejected', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'p', name: 'P', parentId: null, childIds: [] }, 0);
    doc.insertGroup({ id: 'c', name: 'C', parentId: 'p', childIds: [] }, 0);

    expect(() =>
      doc.applyTransaction({
        ops: [{ kind: 'reparentGroup', id: 'p', beforeParent: null, beforeIndex: 0, afterParent: 'c', afterIndex: 0 }],
      }),
    ).toThrow();

    expect(doc.tree.getNode('p')?.parentId).toBeNull(); // no cycle was created
    expect(doc.tree.getNode('c')?.parentId).toBe('p');
  });
});

describe('Document/SceneTree — invariant validation from a different entry point (reproduces a review finding, a path independent of insertNode/setMembership)', () => {
  it('applyTransaction: passing non-empty childIds (self-cycle) to createGroup is rejected', () => {
    const doc = makeDoc();

    expect(() =>
      doc.applyTransaction({
        ops: [{ kind: 'createGroup', node: { id: 'g0', name: 'G', parentId: null, childIds: ['g0'] }, index: 0 }],
      }),
    ).toThrow();

    expect(doc.tree.getNode('g0')).toBeUndefined();
  });

  it('replaceAll: is rejected when nodes contains a duplicate id (missed because it was a standalone implementation that did not go through insertNode)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'old', name: 'OLD', parentId: null, childIds: [] }, 0);

    const dupNodes: GroupNode[] = [
      { id: 'g0', name: 'first', parentId: null, childIds: [] },
      { id: 'g0', name: 'second', parentId: null, childIds: [] },
    ];

    expect(() => doc.replaceAll(sceneOf([], dupNodes))).toThrow();

    // the pre-load data is preserved (thanks to replaceAll's atomicity)
    expect(doc.tree.getNode('old')).toBeDefined();
  });

  it('replaceAll: is rejected when a cell\'s owner is absent from the tree (owner consistency)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'old', name: 'OLD', parentId: null, childIds: [] }, 0);

    expect(() => doc.replaceAll(sceneOf([['nonexistent', '0,0,0', 1]]))).toThrow();

    expect(doc.tree.getNode('old')).toBeDefined();
    expect(doc.world.get(0, 0, 0)).toBeNull();
  });
});

describe('Document — subscribe/notify', () => {
  it('subscribe returns an unsubscribe function, and calling it stops further notifications', () => {
    const doc = makeDoc();
    const fn = vi.fn();
    const unsubscribe = doc.subscribe(fn);
    doc.applyTransaction({ ops: [{ kind: 'voxel', owner: null, key: '0,0,0', before: null, after: 1 }] });
    unsubscribe();
    doc.applyTransaction({ ops: [{ kind: 'voxel', owner: null, key: '1,0,0', before: null, after: 1 }] });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('the change kind (DocumentChange.kind) is notified correctly for each change path', () => {
    const doc = makeDoc();
    const events: DocumentChange[] = [];
    doc.subscribe((e) => events.push(e));

    doc.applyTransaction({ ops: [{ kind: 'voxel', owner: null, key: '0,0,0', before: null, after: 1 }] }); // 'edit'
    doc.undo();
    doc.redo();
    doc.replaceAll(sceneOf([[null, '1,0,0', 2]]));
    doc.clearAll();

    expect(events.map((e) => e.kind)).toEqual(['edit', 'undo', 'redo', 'replaceAll', 'clear']);
  });
});

describe('Document — setGroupTransform op', () => {
  const T1: GroupTransform = { angleSteps: 1, translate: [2, 0, -3], pivot2: [1, 1] };
  const T2: GroupTransform = { angleSteps: 2, translate: [0, 5, 0], pivot2: [3, 3] };

  it('transform round-trips through apply → undo → redo', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'G', parentId: null, childIds: [] }, 0);
    doc.rawTree.setTransform('g0', T1);

    doc.applyTransaction({ ops: [{ kind: 'setGroupTransform', id: 'g0', before: T1, after: T2 }] });
    expect(doc.tree.getNode('g0')?.transform).toEqual(T2);

    doc.undo();
    expect(doc.tree.getNode('g0')?.transform).toEqual(T1);

    doc.redo();
    expect(doc.tree.getNode('g0')?.transform).toEqual(T2);
  });

  it('before uses the live measured value (even if the caller passes a stale before, undo returns the correct value)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'G', parentId: null, childIds: [] }, 0);
    doc.rawTree.setTransform('g0', T1); // the live value is T1

    // the caller incorrectly claims "before is unset"
    doc.applyTransaction({ ops: [{ kind: 'setGroupTransform', id: 'g0', before: undefined, after: T2 }] });
    doc.undo();

    expect(doc.tree.getNode('g0')?.transform).toEqual(T1); // reverts to the measured value, not the claimed one
  });

  it('undoing the first-ever set reverts to "unset," not identity (honors the v2 migration\'s pivot initialization contract)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'G', parentId: null, childIds: [] }, 0);
    expect(doc.tree.getNode('g0')?.transform).toBeUndefined();

    doc.applyTransaction({ ops: [{ kind: 'setGroupTransform', id: 'g0', before: undefined, after: T1 }] });
    expect(doc.tree.getNode('g0')?.transform).toEqual(T1);

    doc.undo();
    expect(doc.tree.getNode('g0')?.transform).toBeUndefined(); // the property disappears entirely, rather than becoming identity
  });

  it('is notified with voxelOnly=false (a transform change moves the display position of cells it never touched)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'G', parentId: null, childIds: [] }, 0);
    const events: DocumentChange[] = [];
    doc.subscribe((e) => events.push(e));

    doc.applyTransaction({ ops: [{ kind: 'setGroupTransform', id: 'g0', before: undefined, after: T1 }] });

    expect(events).toEqual([{ kind: 'edit', voxelOnly: false }]);
  });

  it('applying to a nonexistent group throws, and other ops in the same transaction also roll back', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'G', parentId: null, childIds: [] }, 0);

    expect(() =>
      doc.applyTransaction({
        ops: [
          { kind: 'renameGroup', id: 'g0', before: 'G', after: 'renamed' },
          { kind: 'setGroupTransform', id: 'ghost', before: undefined, after: T1 },
        ],
      }),
    ).toThrow();

    expect(doc.tree.getNode('g0')?.name).toBe('G'); // the first entry rolls back too
    expect(doc.undoDepth).toBe(0);
  });

  it('the undo stack does not alias the caller\'s transform object', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'G', parentId: null, childIds: [] }, 0);
    const mutable = { angleSteps: 1 as const, translate: [1, 0, 1] as [number, number, number], pivot2: [1, 1] as [number, number] };

    doc.applyTransaction({ ops: [{ kind: 'setGroupTransform', id: 'g0', before: undefined, after: mutable }] });
    mutable.translate[0] = 999; // mutate the reference still held by the caller
    doc.undo();
    doc.redo();

    expect(doc.tree.getNode('g0')?.transform?.translate).toEqual([1, 0, 1]); // history is not contaminated
  });

  it('createGroup deep-clones node.transform too (regression for a gap where only childIds was cloned)', () => {
    const doc = makeDoc();
    const mutable = { angleSteps: 1 as const, translate: [1, 0, 1] as [number, number, number], pivot2: [1, 1] as [number, number] };
    const node: GroupNode = { id: 'g0', name: 'G', parentId: null, childIds: [], transform: mutable };

    doc.applyTransaction({ ops: [{ kind: 'createGroup', node, index: 0 }] });
    mutable.translate[0] = 999;
    doc.undo();
    doc.redo();

    expect(doc.tree.getNode('g0')?.transform?.translate).toEqual([1, 0, 1]);
  });
});

/**
 * Atomicity of EditSession preview (raised in code review).
 *
 * Root cause: `stageLocal` went "range validation → write into scene first → update index," and
 * **had no rollback for when the index update throws**. Only scene would advance incorrectly,
 * leaving index and notifications in the old state (applyTransaction has a rollback, but the
 * preview path had none).
 *
 * Reproduction: making an owner absent from the tree the placement owner causes
 * `worldToOwnerCell` to return identity, so range validation passes; `writeCell` then creates a
 * cell for the unknown owner, and `WorldIndex.applyVoxelChanges` throws on "unknown owner."
 */
describe('Document — atomicity of EditSession preview (code review P1)', () => {
  it('if the index update fails, scene / index / notifications remain completely unchanged', () => {
    const doc = makeDoc();
    doc.setCells([[0, 0, 0, 1]]);
    let contentNotified = 0;
    let batchNotified = 0;
    doc.index.subscribe(() => contentNotified++);
    doc.index.subscribeBatch(() => batchNotified++);

    const session = doc.beginSession('missing-owner');
    expect(() => session.stagePreview([place(5, 0, 0, 7)])).toThrow();

    expect(doc.rawCells.has('missing-owner', '5,0,0')).toBe(false); // not left in scene
    expect(doc.world.has(5, 0, 0)).toBe(false);
    expect(doc.rawCells.get(null, '0,0,0')).toBe(1); // the existing cell is untouched too
    expect(contentNotified).toBe(0);
    expect(batchNotified).toBe(0);
  });

  it('even if a later change among several fails, the earlier scene writes do not remain', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'G', parentId: null, childIds: [] }, 0);
    const session = doc.beginSession('g0');
    // the first entry has a valid owner; to trigger an unknown owner on the second, mix them in directly via stageMoveRefs
    expect(() =>
      session.stagePreview([place(1, 0, 0, 5), { kind: 'place', worldCell: [2, 0, 0], afterWorldRaw: 6 }]),
    ).not.toThrow();
    expect(doc.rawCells.get('g0', '1,0,0')).toBe(5);

    // in a session with an unknown owner, even the first entry fails and nothing remains
    const broken = doc.beginSession('ghost');
    expect(() => broken.stagePreview([place(3, 0, 0, 7), place(4, 0, 0, 8)])).toThrow();
    expect(doc.rawCells.has('ghost', '3,0,0')).toBe(false);
    expect(doc.rawCells.has('ghost', '4,0,0')).toBe(false);
  });

  it('cancel on the same session still works normally after a failure (does not get stuck)', () => {
    const doc = makeDoc();
    doc.insertGroup({ id: 'g0', name: 'G', parentId: null, childIds: [] }, 0);
    const session = doc.beginSession('g0');
    session.stagePreview([place(1, 0, 0, 5)]);
    expect(doc.world.get(1, 0, 0)).toBe(5);

    session.cancel();
    expect(doc.world.has(1, 0, 0)).toBe(false);
    expect(doc.undoDepth).toBe(0);
  });
});
