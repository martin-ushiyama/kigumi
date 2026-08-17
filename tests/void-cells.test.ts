import { describe, expect, it } from 'vitest';
import { CATALOG } from '../src/data/blocks';
import type { OwnerId } from '../src/core/cellref';
import { VOID_CATALOG_INDEX, VOID_CELL, isVoidCell, packCell, type Shape } from '../src/core/orientation';
import {
  assertValidRuntimeScene,
  buildSceneProjection,
  makeVoidHidesOwner,
  winnerOfStack,
  type ProjectionEntry,
} from '../src/core/sceneprojection';
import { OwnerVoxelStore, type EditorScene } from '../src/core/ownervoxels';
import { SceneTree, type GroupNode } from '../src/core/scenetree';
import { WorldIndex } from '../src/core/worldindex';
import { collectBlockUsage, totalBlockCount, type BlockUsageReader } from '../src/editor/blockusage';
import { countCellsInSubtree, directCellCount } from '../src/core/ownerlocal';
import { mirrorRaw, rotateRaw } from '../src/core/transform';
import { makeCellKey, type BlockDef } from '../src/core/types';
import { VOID_BLOCK_ID, serializeProjectV5, validateProjectV3 } from '../src/project/persistence';
import { DocumentFixture } from './helpers/document-fixture';

/**
 * Void cells — a non-destructive shape carve that layers over the front to make a hole.
 *
 * Established rule:
 * > A void never reaches outside the group it belongs to. What disappears is everything behind
 * > the void within its parent group's subtree (sibling groups / their descendants / the parent's
 * > own direct cells).
 * > If the parent is the root, it affects the whole scene (= a cuboid carve).
 */

describe('void cell representation', () => {
  it('the reserved index is comfortably larger than the catalog length (would break on collision)', () => {
    expect(CATALOG.length).toBeLessThan(VOID_CATALOG_INDEX);
    // Bedrock's data_items has 1342 entries. Pin down that there's headroom by orders of magnitude
    expect(VOID_CATALOG_INDEX).toBeGreaterThan(100_000);
  });

  it('the cell value stays positive (a negative value would ripple into sorting and palette keys)', () => {
    expect(VOID_CELL).toBeGreaterThan(0);
  });

  it('only the void value counts as void (not any out-of-catalog index in general)', () => {
    expect(isVoidCell(VOID_CELL)).toBe(true);
    expect(isVoidCell(packCell(0, 0))).toBe(false);
    expect(isVoidCell(packCell(CATALOG.length - 1, 0))).toBe(false);
    // out of catalog range but not the reserved index = corrupt data. Not to be confused with void
    expect(isVoidCell(packCell(CATALOG.length + 5, 0))).toBe(false);
  });
});

/** A tree holding only parent-child relations (id → parent). Direct root membership is null */
const treeOf = (parents: Record<string, OwnerId>) => (id: string): OwnerId => parents[id] ?? null;

const entry = (ownerId: OwnerId, raw: number, hidden = false): ProjectionEntry => ({
  ref: { ownerId, localCell: [0, 0, 0] },
  worldCell: [0, 0, 0],
  raw,
  effectiveHidden: hidden,
});

const BLOCK = packCell(0, 0);
const OTHER_BLOCK = packCell(1, 0);

describe('makeVoidHidesOwner — scope of effect', () => {
  // W ├─ hole / ├─ wall └─ deco (a child of wall), with outside sitting outside W
  const hides = makeVoidHidesOwner(treeOf({ hole: 'W', wall: 'W', deco: 'wall', outside: null, W: null }));

  it('hides a sibling under the same parent', () => {
    expect(hides('hole', 'wall')).toBe(true);
  });

  it('also hides a sibling\'s descendants (no depth limit)', () => {
    expect(hides('hole', 'deco')).toBe(true);
  });

  it('also hides the parent\'s own direct cells (the back of the subtree)', () => {
    expect(hides('hole', 'W')).toBe(true);
  });

  it('does not hide anything outside the parent group', () => {
    expect(hides('hole', 'outside')).toBe(false);
    expect(hides('hole', null)).toBe(false);
  });

  it('a void that is a direct root cell affects everything (= a cuboid carve)', () => {
    expect(hides(null, 'wall')).toBe(true);
    expect(hides(null, 'outside')).toBe(true);
    expect(hides(null, null)).toBe(true);
  });
});

describe('winnerOfStack — a void never becomes the winner, and hides what is behind it', () => {
  const hides = makeVoidHidesOwner(treeOf({ hole: 'W', wall: 'W', outside: null, W: null }));
  /** the stack goes back→front. The further-back element comes later in the array */
  const winnerIdOf = (stack: ProjectionEntry[]) => winnerOfStack(stack, hides)?.ref.ownerId ?? null;

  it('with no void present, the frontmost real block wins (as before)', () => {
    const stack = [entry('wall', BLOCK), entry('outside', OTHER_BLOCK)];
    expect(winnerIdOf(stack)).toBe('outside');
  });

  it('a block behind it within scope is hidden, becoming a hole (winner is null)', () => {
    const stack = [entry('wall', BLOCK), entry('hole', VOID_CELL)];
    expect(winnerOfStack(stack, hides)).toBeNull();
  });

  it('a block outside the scope is not hidden (the surrounding terrain remains)', () => {
    const stack = [entry('outside', BLOCK), entry('hole', VOID_CELL)];
    expect(winnerIdOf(stack)).toBe('outside');
  });

  it('a block in front of the void remains (which layer is above/below decides what gets carved)', () => {
    const stack = [entry('wall', BLOCK), entry('hole', VOID_CELL), entry('wall', OTHER_BLOCK)];
    // since the frontmost entry is a real block, it settles the result right there
    expect(winnerOfStack(stack, hides)?.raw).toBe(OTHER_BLOCK);
  });

  it('a hidden void has no effect (hiding the group also removes the hole)', () => {
    const stack = [entry('wall', BLOCK), entry('hole', VOID_CELL, true)];
    expect(winnerIdOf(stack)).toBe('wall');
  });

  it('a hidden block is skipped as before', () => {
    const stack = [entry('wall', BLOCK), entry('outside', OTHER_BLOCK, true)];
    expect(winnerIdOf(stack)).toBe('wall');
  });

  it('a void that is a direct root cell hides even outside blocks (a cuboid carve)', () => {
    const stack = [entry('outside', BLOCK), entry(null, VOID_CELL)];
    expect(winnerOfStack(stack, hides)).toBeNull();
  });

  it('a void within the scope of another void has no effect of its own', () => {
    // the front root-level void hides hole → hole can no longer establish its own scope →
    // outside underneath it (now inside the root void's scope) is hidden too, resulting in null
    const stack = [entry('outside', BLOCK), entry('hole', VOID_CELL), entry(null, VOID_CELL)];
    expect(winnerOfStack(stack, hides)).toBeNull();
  });

  it('a stack made up only of voids has no winner', () => {
    expect(winnerOfStack([entry('hole', VOID_CELL)], hides)).toBeNull();
  });
});

// ---- from here on, regression tests that **exercise the real entry points** ----
//
// The block above hand-assembles ProjectionEntry values and only exercises the winner rule in
// isolation. That alone didn't test "can we even reach this state" — which is how we missed that
// rotateRaw's unknown-catalog check meant the projection itself couldn't be built. Below, we build
// the projection from an actual EditorScene.

const SHAPES: Shape[] = ['full', 'slab', 'stairs'];
/** the void's reserved index naturally has no shape (it isn't a real catalog entry) */
const shapeOf = (catalogIndex: number): Shape | undefined => SHAPES[catalogIndex];

const groupNode = (id: string, parentId: string | null): GroupNode => ({
  id,
  name: id,
  parentId,
  childIds: [],
});

const emptyScene = (): EditorScene => ({ tree: new SceneTree(), cells: new OwnerVoxelStore() });

/** W ├─ hole (front) / └─ wall. Overlap at the same world coordinate (0,0,0) */
function sceneWithVoidOverWall(): EditorScene {
  const scene = emptyScene();
  scene.tree.insertNode(groupNode('W', null), 0);
  scene.tree.insertNode(groupNode('wall', 'W'), 0);
  scene.tree.insertNode(groupNode('hole', 'W'), 1); // later sibling = front
  scene.cells.set('wall', makeCellKey(0, 0, 0), packCell(0, 0));
  scene.cells.set('hole', makeCellKey(0, 0, 0), VOID_CELL);
  return scene;
}

describe('the canonical transform paths pass through void values', () => {
  it('rotateRaw returns void unchanged (does not throw as an unknown catalog value)', () => {
    for (const steps of [0, 1, 2, 3] as const) {
      expect(rotateRaw(VOID_CELL, steps, shapeOf)).toBe(VOID_CELL);
    }
  });

  it('mirrorRaw also returns void unchanged', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(mirrorRaw(VOID_CELL, axis, shapeOf)).toBe(VOID_CELL);
    }
  });

  it('an unknown catalogIndex that is not void still throws as before (corrupt data is not let through)', () => {
    const broken = packCell(SHAPES.length + 3, 0);
    expect(() => rotateRaw(broken, 0, shapeOf)).toThrow(/unknown catalogIndex/);
    expect(() => rotateRaw(broken, 1, shapeOf)).toThrow(/unknown catalogIndex/);
    expect(() => mirrorRaw(broken, 'x', shapeOf)).toThrow(/unknown catalogIndex/);
  });
});

describe('SceneProjection can build with a void present', () => {
  it('the projection for a scene containing a void can be built', () => {
    expect(() => buildSceneProjection(sceneWithVoidOverWall(), shapeOf)).not.toThrow();
  });

  it('the void remains in the stack, and the winner is null (a hole)', () => {
    const projection = buildSceneProjection(sceneWithVoidOverWall(), shapeOf);
    expect(projection.stackAt([0, 0, 0]).map((e) => e.ref.ownerId)).toEqual(['wall', 'hole']);
    expect(projection.winnerAt([0, 0, 0])).toBeNull();
    expect([...projection.winners()]).toHaveLength(0);
  });

  it('a void passes through even inside a rotated group (exercises the rotateRaw path)', () => {
    const scene = sceneWithVoidOverWall();
    scene.tree.setTransform('W', { angleSteps: 1, translate: [0, 0, 0], pivot2: [1, 1] });
    expect(() => buildSceneProjection(scene, shapeOf)).not.toThrow();
  });

  it('assertValidRuntimeScene also does not fail on a void', () => {
    expect(() => assertValidRuntimeScene(sceneWithVoidOverWall(), shapeOf)).not.toThrow();
  });

  it('a block outside the scope is not hidden in the projection either (the surrounding terrain remains)', () => {
    const scene = emptyScene();
    scene.tree.insertNode(groupNode('W', null), 0);
    scene.tree.insertNode(groupNode('hole', 'W'), 0);
    scene.tree.insertNode(groupNode('terrain', null), 1); // outside W, and a later sibling = front
    scene.cells.set('hole', makeCellKey(0, 0, 0), VOID_CELL);
    scene.cells.set('terrain', makeCellKey(0, 0, 0), packCell(0, 0));

    const projection = buildSceneProjection(scene, shapeOf);
    expect(projection.winnerAt([0, 0, 0])?.ref.ownerId).toBe('terrain');
  });

  it('a void that is a direct root cell hides even outside blocks (a cuboid carve)', () => {
    const scene = emptyScene();
    scene.tree.insertNode(groupNode('terrain', null), 0);
    scene.cells.set('terrain', makeCellKey(0, 0, 0), packCell(0, 0));
    scene.cells.set(null, makeCellKey(0, 0, 0), VOID_CELL);

    // a direct root cell is the very back of the paint order. The terrain in front of it is not hidden
    const projection = buildSceneProjection(scene, shapeOf);
    expect(projection.winnerAt([0, 0, 0])?.ref.ownerId).toBe('terrain');
  });
});

describe('WorldIndex can build and incrementally update with a void present', () => {
  it('an index can be built from a scene containing a void', () => {
    expect(() => WorldIndex.fromScene(sceneWithVoidOverWall(), shapeOf)).not.toThrow();
  });

  it('a carved-out coordinate reads as empty from world (the shape the renderer / export reads)', () => {
    const index = WorldIndex.fromScene(sceneWithVoidOverWall(), shapeOf);
    expect(index.winnerRefAt([0, 0, 0])).toBeNull();
    expect(index.get(0, 0, 0)).toBeNull();
    // it remains in the stack, so the pick-and-move path (stage 3) can still find the void
    expect(index.stackAt([0, 0, 0]).map((e) => e.ref.ownerId)).toEqual(['wall', 'hole']);
  });

  it('an incremental update can place / remove a void', () => {
    const scene = emptyScene();
    scene.tree.insertNode(groupNode('W', null), 0);
    scene.tree.insertNode(groupNode('wall', 'W'), 0);
    scene.tree.insertNode(groupNode('hole', 'W'), 1);
    scene.cells.set('wall', makeCellKey(0, 0, 0), packCell(0, 0));
    const index = WorldIndex.fromScene(scene, shapeOf);
    expect(index.get(0, 0, 0)).not.toBeNull();

    // placing a void afterward → becomes a hole
    scene.cells.set('hole', makeCellKey(0, 0, 0), VOID_CELL);
    expect(() =>
      index.applyVoxelChanges([{ owner: 'hole', localKey: makeCellKey(0, 0, 0), after: VOID_CELL }]),
    ).not.toThrow();
    expect(index.get(0, 0, 0)).toBeNull();

    // removing the void → the wall behind it comes back
    scene.cells.delete('hole', makeCellKey(0, 0, 0));
    index.applyVoxelChanges([{ owner: 'hole', localKey: makeCellKey(0, 0, 0), after: null }]);
    expect(index.get(0, 0, 0)).not.toBeNull();
  });
});

// ---- a void must not vanish across save → load ----
//
// Autosave runs on every Document change, so if the save format doesn't know about voids, we get
// data loss: "a placed void disappears on page reload." Close this off before making voids placeable.

describe('the save format does not drop voids', () => {
  const catalogFor = (): BlockDef[] => [
    { id: 'minecraft:stone', nameJa: '石', nameEn: 'Stone', category: 'stone', color: '#7d7d7d', shape: 'full', materialGroup: 'stone' },
  ];
  const indexOf = (blockId: string): number | undefined => (blockId === 'minecraft:stone' ? 0 : undefined);

  /** W ├─ wall (stone) / └─ hole (void) */
  function sceneToSave(): EditorScene {
    const scene = emptyScene();
    scene.tree.insertNode(groupNode('W', null), 0);
    scene.tree.insertNode(groupNode('wall', 'W'), 0);
    scene.tree.insertNode(groupNode('hole', 'W'), 1);
    scene.cells.set('wall', makeCellKey(0, 0, 0), packCell(0, 0));
    scene.cells.set('hole', makeCellKey(0, 0, 0), VOID_CELL);
    return scene;
  }

  it('on export, a void gets its own dedicated id (not discarded as out-of-catalog)', () => {
    const file = serializeProjectV5('save test', sceneToSave(), catalogFor(), []);
    const ids = file.cells.map((c) => c[4]);
    expect(ids).toContain(VOID_BLOCK_ID);
    expect(ids).toContain('minecraft:stone');
    expect(file.cells).toHaveLength(2);
  });

  it('does not claim the Mojang namespace', () => {
    expect(VOID_BLOCK_ID.startsWith('minecraft:')).toBe(false);
    expect(VOID_BLOCK_ID).toBe('blocksmith:void');
  });

  it('reloading brings back the void cell (the hole does not fill in)', () => {
    const file = serializeProjectV5('save test', sceneToSave(), catalogFor(), []);
    const validated = validateProjectV3(file, indexOf);

    expect(validated.skipped).toBe(0); // the void isn't discarded as an "unknown block"
    const voidCells = validated.cells.filter(([, , , , raw]) => isVoidCell(raw));
    expect(voidCells).toHaveLength(1);
  });

  it('the hole survives a round trip, and removing the void restores the wall', () => {
    const file = serializeProjectV5('save test', sceneToSave(), catalogFor(), []);
    const validated = validateProjectV3(file, indexOf);

    // reassemble a scene from the loaded content (group index → id is loadProject's job, so here
    // we restore the owner mapping by hand and just look at the winner result)
    const restored = emptyScene();
    restored.tree.insertNode(groupNode('W', null), 0);
    restored.tree.insertNode(groupNode('wall', 'W'), 0);
    restored.tree.insertNode(groupNode('hole', 'W'), 1);
    const ownerIds = ['W', 'wall', 'hole'];
    for (const [ownerIndex, x, y, z, raw] of validated.cells) {
      restored.cells.set(ownerIds[ownerIndex]!, makeCellKey(x, y, z), raw);
    }

    expect(WorldIndex.fromScene(restored, shapeOf).get(0, 0, 0)).toBeNull(); // still a hole
    restored.cells.delete('hole', makeCellKey(0, 0, 0));
    expect(WorldIndex.fromScene(restored, shapeOf).get(0, 0, 0)).not.toBeNull(); // the wall comes back
  });

  it('an unknown blockId other than void is still skipped as before', () => {
    const file = serializeProjectV5('save test', sceneToSave(), catalogFor(), []);
    const withUnknown = {
      ...file,
      cells: [...file.cells, [0, 5, 0, 0, 'minecraft:unknown_block', 0] as (typeof file.cells)[number]],
    };
    expect(validateProjectV3(withUnknown, indexOf).skipped).toBe(1);
  });

  it('even if the orientation code in the file is dirty, a void is collapsed to code 0', () => {
    const file = serializeProjectV5('save test', sceneToSave(), catalogFor(), []);
    const dirty = {
      ...file,
      cells: file.cells.map((c) => (c[4] === VOID_BLOCK_ID ? ([c[0], c[1], c[2], c[3], c[4], 7] as typeof c) : c)),
    };
    const validated = validateProjectV3(dirty, indexOf);
    const voidCell = validated.cells.find(([, , , , raw]) => isVoidCell(raw));
    expect(voidCell?.[4]).toBe(VOID_CELL);
  });
});

describe('creating a void group inside a rotated parent', () => {
  const catalogFor = (): BlockDef[] => [
    { id: 'minecraft:stone', nameJa: '石', nameEn: 'Stone', category: 'stone', color: '#7d7d7d', shape: 'full', materialGroup: 'stone' },
  ];

  /**
   * When a parent is rotated, world coordinates ≠ the parent's local coordinates. If a void group
   * is created inside the parent without transforming that coordinate, **the hole ends up in the
   * wrong place**. `applyEditsAsNewGroup` routes through `worldToOwnerCell` / `worldToOwnerRaw`, so
   * it stays correct even under rotation.
   */
  it('even inside a rotated parent, the hole appears at the specified world coordinate', () => {
    const doc = new DocumentFixture(() => 'full');
    // create a parent group, put one stone in it, and rotate it 90 degrees
    const wall = doc.applyEditsAsNewGroup(
      [{ kind: 'place', worldCell: [3, 0, 1], afterWorldRaw: packCell(0, 0) }],
      'wall',
    );
    expect(wall).not.toBeNull();
    doc.applyTransaction({
      ops: [
        {
          kind: 'setGroupTransform',
          id: wall!,
          before: undefined,
          after: { angleSteps: 1, translate: [0, 0, 0], pivot2: [1, 1] },
        },
      ],
    });

    // read back the world position after rotation, and lay a void there
    const [wx, wy, wz] = [...doc.world.entries()][0]!;
    expect(doc.world.get(wx, wy, wz)).not.toBeNull();

    const hole = doc.applyEditsAsNewGroup(
      [{ kind: 'place', worldCell: [wx, wy, wz], afterWorldRaw: VOID_CELL }],
      'cuboid: void',
      wall,
    );
    expect(hole).not.toBeNull();

    // check first **that it landed inside the parent**. If it were created directly under root,
    // the transform would not apply, so world = local and the coordinate offset would never surface
    // (the test would fail to distinguish the two cases)
    expect(doc.tree.getNode(hole!)?.parentId).toBe(wall);

    // and on top of that, the targeted world coordinate has actually become a hole
    // (a transform mistake would leave the stone in place)
    expect(doc.world.get(wx, wy, wz)).toBeNull();
  });

  it('specifying a nonexistent parent fails (never silently creates under root)', () => {
    const doc = new DocumentFixture(() => 'full');
    expect(() =>
      doc.applyEditsAsNewGroup([{ kind: 'place', worldCell: [0, 0, 0], afterWorldRaw: VOID_CELL }], 'x', 'missing'),
    ).toThrow(/parent group not found/);
  });

  void catalogFor;
});

// ---- how it's shown: a void never becomes the winner, so its coordinates are queried through a separate channel ----

describe('WorldIndex.voidCells — the enumeration the outline reads', () => {
  it('returns the coordinates of a placed void (does not show up in entries())', () => {
    const index = WorldIndex.fromScene(sceneWithVoidOverWall(), shapeOf);

    // entries(), bound by the winner contract, treats a hole as "nothing" = the rendering side has no way to know its coordinates
    expect([...index.entries()]).toHaveLength(0);
    expect([...index.voidCells()]).toEqual([[0, 0, 0]]);
  });

  it('does not report it once the group is hidden (collapsing it in the layer panel also hides the outline)', () => {
    const scene = sceneWithVoidOverWall();
    scene.tree.setHidden('hole', true);
    const index = WorldIndex.fromScene(scene, shapeOf);

    expect([...index.voidCells()]).toEqual([]);
    expect(index.get(0, 0, 0)).not.toBeNull(); // the wall comes back since the void no longer has an effect
  });

  it('also reports a void that has no effect (from the placer\'s own view, "it\'s there")', () => {
    // hole2 sits within hole1's scope and is preempted by hole1, so its placement has no effect
    const scene = emptyScene();
    scene.tree.insertNode(groupNode('W', null), 0);
    scene.tree.insertNode(groupNode('hole2', 'W'), 0);
    scene.tree.insertNode(groupNode('hole1', 'W'), 1); // later sibling = front
    scene.cells.set('hole2', makeCellKey(0, 0, 0), VOID_CELL);
    scene.cells.set('hole1', makeCellKey(0, 0, 0), VOID_CELL);
    const index = WorldIndex.fromScene(scene, shapeOf);

    // even with 2 stacked at the same coordinate, one outline is enough
    expect([...index.voidCells()]).toEqual([[0, 0, 0]]);
  });

  it('is empty when there is no void (does not false-positive on a scene of real blocks only)', () => {
    const scene = emptyScene();
    scene.tree.insertNode(groupNode('wall', null), 0);
    scene.cells.set('wall', makeCellKey(0, 0, 0), packCell(0, 0));
    const index = WorldIndex.fromScene(scene, shapeOf);

    expect([...index.voidCells()]).toEqual([]);
  });

  it('a void placed via incremental update also shows up (not limited to the full-rebuild path)', () => {
    const scene = emptyScene();
    scene.tree.insertNode(groupNode('W', null), 0);
    scene.tree.insertNode(groupNode('wall', 'W'), 0);
    scene.tree.insertNode(groupNode('hole', 'W'), 1);
    scene.cells.set('wall', makeCellKey(0, 0, 0), packCell(0, 0));
    const index = WorldIndex.fromScene(scene, shapeOf);
    expect([...index.voidCells()]).toEqual([]);

    scene.cells.set('hole', makeCellKey(0, 0, 0), VOID_CELL);
    index.applyVoxelChanges([{ owner: 'hole', localKey: makeCellKey(0, 0, 0), after: VOID_CELL }]);
    expect([...index.voidCells()]).toEqual([[0, 0, 0]]);

    scene.cells.delete('hole', makeCellKey(0, 0, 0));
    index.applyVoxelChanges([{ owner: 'hole', localKey: makeCellKey(0, 0, 0), after: null }]);
    expect([...index.voidCells()]).toEqual([]);
  });
});

// ---- how it's counted: a void does not count as a block ----
//
// The "how many placed" number exists to reflect the count that will line up in the world on
// export. A hole is not a thing that gets placed. The dropping happens on **the counting side** —
// leaving it to the display side's "don't show out-of-catalog entries" filter would let the
// counting and the display diverge (only the total would end up including the void).

describe('a void does not count toward the block total', () => {
  /** a minimal reader holding only per-owner cells */
  function usageReader(cells: Record<string, [string, number][]>): BlockUsageReader {
    return {
      entriesOf: (o) => cells[o ?? '@root'] ?? [],
      owners: () => Object.keys(cells).map((k) => (k === '@root' ? null : k)),
      ownersOfSubtree: (id) => [id],
    };
  }

  it('the usage tally has no row for a void', () => {
    const reader = usageReader({
      wall: [['0,0,0', packCell(0, 0)], ['1,0,0', packCell(0, 0)]],
      hole: [['0,0,0', VOID_CELL]],
    });

    expect(collectBlockUsage(reader, { kind: 'world' })).toEqual([{ catalogIndex: 0, count: 2 }]);
  });

  it('the total matches the sum of the row counts (only the total ends up wrong if a void sneaks in)', () => {
    const reader = usageReader({
      wall: [['0,0,0', packCell(0, 0)], ['1,0,0', packCell(0, 0)], ['2,0,0', packCell(0, 0)]],
      hole: [['0,0,0', VOID_CELL], ['1,0,0', VOID_CELL]],
    });
    const usage = collectBlockUsage(reader, { kind: 'world' });

    // if the row sum and the total disagree, you get "where did 2 of them go" (before the fix, 3 vs 5 were mismatched)
    expect(totalBlockCount(usage)).toBe(usage.reduce((sum, e) => sum + e.count, 0));
    expect(totalBlockCount(usage)).toBe(3);
  });

  it('when only voids exist, the tally is empty (no row is created for VOID_CATALOG_INDEX)', () => {
    const reader = usageReader({ hole: [['0,0,0', VOID_CELL]] });

    expect(collectBlockUsage(reader, { kind: 'world' })).toEqual([]);
  });

  it('countCellsInSubtree returns the count excluding voids', () => {
    const tree = new SceneTree();
    const cells = new OwnerVoxelStore();
    tree.insertNode(groupNode('wall', null), 0);
    tree.insertNode(groupNode('hole', 'wall'), 0);
    cells.set('wall', makeCellKey(0, 0, 0), packCell(0, 0));
    cells.set('wall', makeCellKey(1, 0, 0), packCell(0, 0));
    cells.set('hole', makeCellKey(0, 0, 0), VOID_CELL);

    expect(countCellsInSubtree({ tree, cells }, 'wall')).toBe(2);
  });

  it('directCellCount counts voids too (does not let it slip past the deletion guard)', () => {
    // this isn't "how many are displayed," it's "is there data here." Answering 0 would let a
    // void-only group slip past the deletion guard, and also get swept up in empty-group cleanup
    const tree = new SceneTree();
    const cells = new OwnerVoxelStore();
    tree.insertNode(groupNode('hole', null), 0);
    cells.set('hole', makeCellKey(0, 0, 0), VOID_CELL);

    expect(directCellCount({ tree, cells }, 'hole')).toBe(1);
  });
});
