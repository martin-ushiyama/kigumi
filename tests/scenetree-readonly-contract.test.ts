import { describe, expect, it } from 'vitest';
import { SceneTree, type GroupNode } from '../src/core/scenetree';

/**
 * A dedicated file that only verifies the ReadonlyGroupNode type contract (@ts-expect-error)
 *. Lines that intentionally break type resolution with `@ts-expect-error`
 * can cause typed-lint (no-unsafe-*) to misdetect the broken type as equivalent to "any"
 * (occurs in the CI environment; non-deterministic locally due to environment differences).
 * To minimize the blast radius, only this dedicated file disables that rule
 * (see eslint.config.js). Type-safety checks in scenetree.test.ts proper are kept intact.
 */

function node(id: string, name: string, parentId: string | null): GroupNode {
  return { id, name, parentId, childIds: [] };
}

describe('SceneTreeReader — ReadonlyGroupNode forbids writes at the type level', () => {
  it('assigning to / pushing on the ReadonlyGroupNode returned by getNode / allNodesPreOrder fails to compile (@ts-expect-error)', () => {
    const tree = new SceneTree();
    tree.insertNode(node('g0', 'A', null), 0);
    const got = tree.getNode('g0');
    expect(got).toBeDefined();
    if (!got) return;

    // @ts-expect-error ReadonlyGroupNode.name is readonly, so it cannot be assigned
    got.name = 'mutated outside Document';
    // @ts-expect-error ReadonlyGroupNode.childIds is a readonly string[], so push is not allowed
    got.childIds.push('injected-child');

    for (const item of tree.allNodesPreOrder()) {
      // @ts-expect-error allNodesPreOrder also returns ReadonlyGroupNode, so assigning to locked is not allowed
      item.locked = true;
    }
  });
});
