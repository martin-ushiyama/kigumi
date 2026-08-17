import { describe, expect, it } from 'vitest';
import { SceneTree, type GroupNode } from '../src/core/scenetree';

function node(id: string, name: string, parentId: string | null): GroupNode {
  return { id, name, parentId, childIds: [] };
}

describe('SceneTree — insertNode / childrenOf / getNode', () => {
  it('inserting directly under root is reflected in rootChildIds', () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'A', null), 0);
    expect(tree.childrenOf(null)).toEqual(['g0']);
    expect(tree.getNode('g0')).toEqual({ id: 'g0', name: 'A', parentId: null, childIds: [] });
  });

  it("inserting a child node also registers it in the parent's childIds", () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'A', null), 0);
    tree.insertNode(node('g1', 'A-child', 'g0'), 0);
    expect(tree.childrenOf('g0')).toEqual(['g1']);
    expect(tree.childrenOf(null)).toEqual(['g0']);
  });

  it('sibling order can be controlled via index', () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'A', null), 0);
    tree.insertNode(node('g1', 'B', null), 0); // inserted at the front
    expect(tree.childrenOf(null)).toEqual(['g1', 'g0']);
    tree.insertNode(node('g2', 'C', null), 1); // between g1 and g0
    expect(tree.childrenOf(null)).toEqual(['g1', 'g2', 'g0']);
  });

  it('inserting with an unknown parentId throws', () => {
    const tree = new SceneTree();
    expect(() => tree.insertNode(node('g0', 'A', 'ghost'), 0)).toThrow();
  });
});

describe('SceneTree — removeNode', () => {
  // "deleting a group that holds cells throws" was moved to Document's invariant
  // (the tree no longer tracks cell ownership so it can't be judged standalone; document.test.ts covers it)

  it('deleting a group that has a child group throws', () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'A', null), 0);
    tree.insertNode(node('g1', 'child', 'g0'), 0);
    expect(() => tree.removeNode('g0')).toThrow();
  });

  it("an empty group (0 cells + 0 children) can be deleted, and is removed from the parent's childIds too", () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'A', null), 0);
    tree.insertNode(node('g1', 'child', 'g0'), 0);
    tree.removeNode('g1');
    tree.removeNode('g0');
    expect(tree.getNode('g0')).toBeUndefined();
    expect(tree.getNode('g1')).toBeUndefined();
    expect(tree.childrenOf(null)).toEqual([]);
  });

  it('deleting a nonexistent id throws', () => {
    const tree = new SceneTree();
    expect(() => tree.removeNode('ghost')).toThrow();
  });
});

describe('SceneTree — rename', () => {
  it('the name changes', () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'old', null), 0);
    tree.rename('g0', 'new');
    expect(tree.getNode('g0')?.name).toBe('new');
  });

  it('renaming a nonexistent id throws', () => {
    const tree = new SceneTree();
    expect(() => tree.rename('ghost', 'x')).toThrow();
  });
});

describe('SceneTree — reparent', () => {
  it('the parent and sibling order are updated', () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'A', null), 0);
    tree.insertNode(node('g1', 'B', null), 1);
    tree.insertNode(node('g2', 'child', 'g0'), 0);
    expect(tree.childrenOf('g0')).toEqual(['g2']);

    tree.reparent('g2', 'g1', 0);
    expect(tree.childrenOf('g0')).toEqual([]);
    expect(tree.childrenOf('g1')).toEqual(['g2']);
    expect(tree.getNode('g2')?.parentId).toBe('g1');
  });

  it('can be moved back to root', () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'A', null), 0);
    tree.insertNode(node('g1', 'child', 'g0'), 0);
    tree.reparent('g1', null, 1);
    expect(tree.childrenOf('g0')).toEqual([]);
    expect(tree.childrenOf(null)).toEqual(['g0', 'g1']);
  });

  it('reparenting a nonexistent id throws', () => {
    const tree = new SceneTree();
    expect(() => tree.reparent('ghost', null, 0)).toThrow();
  });
});

// setMembership / groupOfCell / cellsOf / collectCellsDeep / cellCountDeep were removed.
// "the cells a group holds" is now simply OwnerVoxelStore keyed by owner, and aggregation
// is handled by helpers in core/ownerlocal.ts (refsOfSubtree / countCellsInSubtree)
// (tests/ops.test.ts / document.test.ts verify the cross-group behavior together).

describe('SceneTree — clear / replaceAll', () => {
  it('clear wipes everything', () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'A', null), 0);
    tree.clear();
    expect(tree.getNode('g0')).toBeUndefined();
    expect(tree.childrenOf(null)).toEqual([]);
    expect([...tree.allNodesPreOrder()]).toEqual([]);
  });

  it('rebuilds childIds from pre-order nodes', () => {
    const tree = new SceneTree();
    const nodes: GroupNode[] = [
      { id: 'g0', name: 'root', parentId: null, childIds: [] },
      { id: 'g1', name: 'child', parentId: 'g0', childIds: [] },
      { id: 'g2', name: 'sibling', parentId: null, childIds: [] },
    ];
    tree.replaceAll(nodes);
    expect(tree.childrenOf(null)).toEqual(['g0', 'g2']);
    expect(tree.childrenOf('g0')).toEqual(['g1']);
  });

  it('clears existing state before rebuilding', () => {
    const tree = new SceneTree();
    tree.insertNode(node('old', 'old', null), 0);
    tree.replaceAll([]);
    expect(tree.getNode('old')).toBeUndefined();
  });
});

describe('SceneTree — outermostAncestor / isAncestor / commonAncestor', () => {
  it('outermostAncestor returns the ancestor up to directly under root', () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'root-group', null), 0);
    tree.insertNode(node('g1', 'mid', 'g0'), 0);
    tree.insertNode(node('g2', 'leaf', 'g1'), 0);
    expect(tree.outermostAncestor('g2')).toBe('g0');
    expect(tree.outermostAncestor('g1')).toBe('g0');
    expect(tree.outermostAncestor('g0')).toBe('g0'); // already directly under root, so it's returned unchanged
  });

  it('isAncestor is true only for a strict ancestor relationship (self is false)', () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'root-group', null), 0);
    tree.insertNode(node('g1', 'mid', 'g0'), 0);
    tree.insertNode(node('g2', 'leaf', 'g1'), 0);
    expect(tree.isAncestor('g0', 'g2')).toBe(true);
    expect(tree.isAncestor('g1', 'g2')).toBe(true);
    expect(tree.isAncestor('g2', 'g0')).toBe(false);
    expect(tree.isAncestor('g0', 'g0')).toBe(false);
  });

  it('commonAncestor: the LCA of two nodes sharing a parent is that parent', () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'parent', null), 0);
    tree.insertNode(node('g1', 'a', 'g0'), 0);
    tree.insertNode(node('g2', 'b', 'g0'), 1);
    expect(tree.commonAncestor(['g1', 'g2'])).toBe('g0');
  });

  it('commonAncestor: the LCA of the same node is itself', () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'a', null), 0);
    expect(tree.commonAncestor(['g0', 'g0'])).toBe('g0');
  });

  it('commonAncestor: LCA is null when the input includes null (root)', () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'a', null), 0);
    expect(tree.commonAncestor(['g0', null])).toBeNull();
  });

  it('commonAncestor: disjoint branches have root (null) as the LCA', () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'branchA', null), 0);
    tree.insertNode(node('g1', 'branchB', null), 1);
    expect(tree.commonAncestor(['g0', 'g1'])).toBeNull();
  });

  it('commonAncestor: returns the correct LCA even for nested ancestor relationships', () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'root-group', null), 0);
    tree.insertNode(node('g1', 'mid', 'g0'), 0);
    tree.insertNode(node('g2', 'leaf-a', 'g1'), 0);
    tree.insertNode(node('g3', 'leaf-b', 'g1'), 1);
    expect(tree.commonAncestor(['g2', 'g3'])).toBe('g1');
    expect(tree.commonAncestor(['g2', 'g1'])).toBe('g1'); // g1 is an ancestor of g2 → the LCA is g1 itself
  });

  it('commonAncestor: an empty array is null', () => {
    const tree = new SceneTree();
    expect(tree.commonAncestor([])).toBeNull();
  });
});

describe('SceneTree — setHidden / setLocked / isHiddenEffective / isLockedEffective', () => {
  it("effective is also true when the node's own hidden/locked flag is set", () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'A', null), 0);
    expect(tree.isHiddenEffective('g0')).toBe(false);
    expect(tree.isLockedEffective('g0')).toBe(false);
    tree.setHidden('g0', true);
    tree.setLocked('g0', true);
    expect(tree.isHiddenEffective('g0')).toBe(true);
    expect(tree.isLockedEffective('g0')).toBe(true);
  });

  it("an ancestor's hidden/locked is inherited by descendants (same as Figma)", () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'parent', null), 0);
    tree.insertNode(node('g1', 'child', 'g0'), 0);
    tree.insertNode(node('g2', 'grandchild', 'g1'), 0);
    tree.setHidden('g0', true);
    expect(tree.isHiddenEffective('g1')).toBe(true);
    expect(tree.isHiddenEffective('g2')).toBe(true);
    expect(tree.getNode('g1')?.hidden).toBeUndefined(); // the node's own flag doesn't change (inheritance only)
  });

  it('isHiddenEffective/isLockedEffective for root (null) is always false', () => {
    const tree = new SceneTree();
    expect(tree.isHiddenEffective(null)).toBe(false);
    expect(tree.isLockedEffective(null)).toBe(false);
  });

  it('setHidden/setLocked on a nonexistent id throws', () => {
    const tree = new SceneTree();
    expect(() => tree.setHidden('ghost', true)).toThrow();
    expect(() => tree.setLocked('ghost', true)).toThrow();
  });

  // isCellHidden / isCellLocked (judged by looking up ownership from a world key) were removed in
  // and moved to the WorldIndex facade (isWorldCellHidden / isWorldCellLocked), i.e.
  // "look at the ref's owner directly" (covered by worldindex.test.ts / selection.test.ts)
});

describe('SceneTree — allNodesPreOrder / nextId', () => {
  it('allNodesPreOrder returns all nodes in depth-first pre-order', () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'A', null), 0);
    tree.insertNode(node('g1', 'A-1', 'g0'), 0);
    tree.insertNode(node('g2', 'B', null), 1);
    const ids = [...tree.allNodesPreOrder()].map((n) => n.id);
    expect(ids).toEqual(['g0', 'g1', 'g2']);
  });

  it('nextId is monotonically increasing and unique', () => {
    const tree = new SceneTree();
    const ids = [tree.nextId(), tree.nextId(), tree.nextId()];
    expect(ids).toEqual(['g0', 'g1', 'g2']);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('SceneTree — no leaking mutable references (regression test, prevents recurrence of a review finding)', () => {
  it("insertNode makes a defensive copy — later mutating the caller's original object doesn't affect internal state", () => {
    const tree = new SceneTree();
    const original = node('g0', 'before', null);
    tree.insertNode(original, 0);

    // reproduces the attack of mutating the alias left on the caller's side, after applying once via Document
    original.name = 'after';
    original.childIds.push('injected-child');

    expect(tree.getNode('g0')).toEqual({ id: 'g0', name: 'before', parentId: null, childIds: [] });
  });
});

describe('SceneTree — transform', () => {
  it('transformChain: an unset node is identity, and null (root) is identity too', () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'A', null), 0);
    expect(tree.transformChain(null)).toEqual({ angleSteps: 0, offsetXZ2: [0, 0], offsetY: 0 });
    expect(tree.transformChain('g0')).toEqual({ angleSteps: 0, offsetXZ2: [0, 0], offsetY: 0 });
  });

  it('transformChain: parent and child transforms compose in parent→child order (angleSteps is the sum mod 4)', () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'Parent', null), 0);
    tree.insertNode(node('g1', 'Child', 'g0'), 0);
    tree.setTransform('g0', { angleSteps: 1, translate: [10, 0, 0], pivot2: [1, 1] });
    tree.setTransform('g1', { angleSteps: 2, translate: [0, 5, 0], pivot2: [3, 3] });
    const chain = tree.transformChain('g1');
    expect(chain.angleSteps).toBe(3);
    expect(chain.offsetY).toBe(5);
  });

  it('setTransform: throws for a nonexistent id / angleSteps out of range / non-safe-integer / pivot2 parity mismatch', () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'A', null), 0);
    const valid = { angleSteps: 1 as const, translate: [0, 0, 0] as const, pivot2: [1, 1] as const };
    expect(() => tree.setTransform('ghost', valid)).toThrow(/doesn't exist/);
    expect(() => tree.setTransform('g0', { ...valid, angleSteps: 5 as never })).toThrow(/angleSteps/);
    expect(() => tree.setTransform('g0', { ...valid, translate: [0.5, 0, 0] })).toThrow(/translate/);
    expect(() => tree.setTransform('g0', { ...valid, pivot2: [2, 1] })).toThrow(/parity/);
    expect(() => tree.setTransform('g0', valid)).not.toThrow();
  });

  it("setTransform: mutating the caller's transform object afterward doesn't change internal state (alias is severed)", () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'A', null), 0);
    const t = { angleSteps: 1 as const, translate: [3, 0, 0] as [number, number, number], pivot2: [1, 1] as [number, number] };
    tree.setTransform('g0', t);
    t.translate[0] = 999;
    t.pivot2[0] = 998;
    expect(tree.getNode('g0')?.transform?.translate).toEqual([3, 0, 0]);
    expect(tree.getNode('g0')?.transform?.pivot2).toEqual([1, 1]);
  });

  it('insertNode: node.transform is also defensive-copied, and an invalid transform throws on insert', () => {
    const tree = new SceneTree();
    const t = { angleSteps: 2 as const, translate: [1, 2, 3] as [number, number, number], pivot2: [0, 0] as [number, number] };
    tree.insertNode({ ...node('g0', 'A', null), transform: t }, 0);
    t.translate[1] = 777;
    expect(tree.getNode('g0')?.transform?.translate).toEqual([1, 2, 3]);

    expect(() => tree.insertNode({ ...node('g1', 'B', null), transform: { ...t, pivot2: [2, 1] } }, 0)).toThrow(/parity/);
  });

  it("getNode's transform is readonly at the type level (mutation is a compile error)", () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'A', null), 0);
    tree.setTransform('g0', { angleSteps: 1, translate: [0, 0, 0], pivot2: [1, 1] });
    const readonlyNode = tree.getNode('g0')!;
    // @ts-expect-error transform.translate is a readonly tuple; element assignment is a compile error
    readonlyNode.transform!.translate[0] = 999;
    // @ts-expect-error transform itself is also a readonly property
    readonlyNode.transform = undefined;
  });

  it('transform is preserved through replaceAll too, with validation and defensive copying applied (unified via insertNode)', () => {
    const tree = new SceneTree();
    const t = { angleSteps: 3 as const, translate: [0, 1, 0] as [number, number, number], pivot2: [5, 3] as [number, number] };
    tree.replaceAll([{ ...node('g0', 'A', null), transform: t }]);
    expect(tree.getNode('g0')?.transform?.angleSteps).toBe(3);
    t.translate[1] = 555;
    expect(tree.getNode('g0')?.transform?.translate).toEqual([0, 1, 0]);
  });
});

describe('SceneTree — setTransform(undefined) restores to unset', () => {
  it('passing undefined removes the transform property itself, and transformChain returns to identity', () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'A', null), 0);
    tree.setTransform('g0', { angleSteps: 1, translate: [3, 0, 0], pivot2: [1, 1] });
    expect(tree.getNode('g0')?.transform).toBeDefined();

    tree.setTransform('g0', undefined);
    expect(tree.getNode('g0')?.transform).toBeUndefined();
    expect('transform' in tree.getNode('g0')!).toBe(false); // property deletion, not replacement with identity
    expect(tree.transformChain('g0')).toEqual({ angleSteps: 0, offsetXZ2: [0, 0], offsetY: 0 });
  });

  it('setting undefined on a nonexistent id also throws', () => {
    const tree = new SceneTree();
    expect(() => tree.setTransform('ghost', undefined)).toThrow(/doesn't exist/);
  });
});
