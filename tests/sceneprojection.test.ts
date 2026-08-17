import { describe, expect, it } from 'vitest';
import { SceneTree, type GroupNode } from '../src/core/scenetree';
import { OwnerVoxelStore, assertValidEditorScene, type EditorScene } from '../src/core/ownervoxels';
import { assertValidRuntimeScene, buildSceneProjection } from '../src/core/sceneprojection';
import { encodeOrientation, packCell, unpackCell, decodeOrientation, type Shape } from '../src/core/orientation';
import { makeCellKey } from '../src/core/types';

const SHAPES: Shape[] = ['full', 'slab', 'stairs'];
const shapeOf = (catalogIndex: number): Shape | undefined => SHAPES[catalogIndex];

function node(id: string, name: string, parentId: string | null): GroupNode {
  return { id, name, parentId, childIds: [] };
}

function makeScene(): EditorScene {
  return { tree: new SceneTree(), cells: new OwnerVoxelStore() };
}

const FULL = packCell(0, 0);

describe('SceneProjection — paint order (stackAt / winnerAt / winners) (#37)', () => {
  it('3-level paint order for a root-level cell → child group → grandchild group (later = more in front, winner is frontmost)', () => {
    const scene = makeScene();
    scene.tree.insertNode(node('g0', 'Child', null), 0);
    scene.tree.insertNode(node('g1', 'Grandchild', 'g0'), 0);
    // all owners, with identity transforms, project to the same world coordinate (0,0,0)
    scene.cells.set(null, makeCellKey(0, 0, 0), packCell(0, 0));
    scene.cells.set('g0', makeCellKey(0, 0, 0), packCell(1, 0));
    scene.cells.set('g1', makeCellKey(0, 0, 0), packCell(2, 0));

    const projection = buildSceneProjection(scene, shapeOf);
    const stack = projection.stackAt([0, 0, 0]);
    expect(stack.map((e) => e.ref.ownerId)).toEqual([null, 'g0', 'g1']); // back → front
    expect(projection.winnerAt([0, 0, 0])?.ref.ownerId).toBe('g1'); // the frontmost wins

    const winnerList = [...projection.winners()];
    expect(winnerList).toHaveLength(1); // one per world coordinate
    expect(winnerList[0]![1].ref.ownerId).toBe('g1');
  });

  it('sibling groups: later in childIds = more in front (matches Figma layer convention)', () => {
    const scene = makeScene();
    scene.tree.insertNode(node('g0', 'Back', null), 0);
    scene.tree.insertNode(node('g1', 'Front', null), 1);
    scene.cells.set('g0', makeCellKey(0, 0, 0), packCell(0, 0));
    scene.cells.set('g1', makeCellKey(0, 0, 0), packCell(1, 0));

    const projection = buildSceneProjection(scene, shapeOf);
    expect(projection.stackAt([0, 0, 0]).map((e) => e.ref.ownerId)).toEqual(['g0', 'g1']);
    expect(projection.winnerAt([0, 0, 0])?.ref.ownerId).toBe('g1');
  });

  it('a hidden owner stays in stackAt but is not the winner (the next candidate takes over)', () => {
    const scene = makeScene();
    scene.tree.insertNode(node('g0', 'Back', null), 0);
    scene.tree.insertNode(node('g1', 'FrontHidden', null), 1);
    scene.tree.setHidden('g1', true);
    scene.cells.set('g0', makeCellKey(0, 0, 0), packCell(0, 0));
    scene.cells.set('g1', makeCellKey(0, 0, 0), packCell(1, 0));

    const projection = buildSceneProjection(scene, shapeOf);
    const stack = projection.stackAt([0, 0, 0]);
    expect(stack).toHaveLength(2); // hidden stays in the stack too
    expect(stack[1]!.effectiveHidden).toBe(true);
    expect(projection.winnerAt([0, 0, 0])?.ref.ownerId).toBe('g0'); // the next candidate becomes winner
  });

  it('a hidden ancestor\'s child gets effectiveHidden=true and is excluded from being the winner even when overlapping with a different owner', () => {
    const scene = makeScene();
    scene.tree.insertNode(node('g0', 'AncestorHidden', null), 0);
    scene.tree.insertNode(node('g1', 'Child', 'g0'), 0);
    scene.tree.insertNode(node('g2', 'BackOtherOwner', null), 0); // index 0 = behind g0
    scene.tree.setHidden('g0', true);
    scene.cells.set('g1', makeCellKey(0, 0, 0), packCell(0, 0)); // child of the hidden ancestor (front side)
    scene.cells.set('g2', makeCellKey(0, 0, 0), packCell(1, 0)); // visible (back side)

    const projection = buildSceneProjection(scene, shapeOf);
    const stack = projection.stackAt([0, 0, 0]);
    expect(stack.map((e) => [e.ref.ownerId, e.effectiveHidden])).toEqual([
      ['g2', false],
      ['g1', true],
    ]);
    expect(projection.winnerAt([0, 0, 0])?.ref.ownerId).toBe('g2');
  });

  it('two different local cells within the same owner never project to the same world cell (transform is injective)', () => {
    const scene = makeScene();
    scene.tree.insertNode(node('g0', 'A', null), 0);
    scene.tree.setTransform('g0', { angleSteps: 1, translate: [0, 0, 0], pivot2: [1, 1] });
    scene.cells.set('g0', makeCellKey(1, 0, 0), FULL);
    scene.cells.set('g0', makeCellKey(0, 0, 1), FULL);
    const projection = buildSceneProjection(scene, shapeOf);
    // (1,0,0)→(0,0,-1) / (0,0,1)→(1,0,0): no collision
    expect(projection.winnerAt([0, 0, -1])).not.toBeNull();
    expect(projection.winnerAt([1, 0, 0])).not.toBeNull();
  });
});

describe('SceneProjection — worldCell and rotated raw (#37)', () => {
  it('stairs in a 90-degree-rotated group rotate position and orientation into the same world direction (+X position → -Z position, orientation also east → north)', () => {
    const scene = makeScene();
    scene.tree.insertNode(node('g0', 'Rotated', null), 0);
    scene.tree.setTransform('g0', { angleSteps: 1, translate: [0, 0, 0], pivot2: [1, 1] });
    const stairsRaw = packCell(2, encodeOrientation({ shape: 'stairs', weirdoDirection: 0, upsideDown: false }));
    scene.cells.set('g0', makeCellKey(1, 0, 0), stairsRaw);

    const projection = buildSceneProjection(scene, shapeOf);
    const entry = projection.winnerAt([0, 0, -1]); // the +X cell moves to -Z
    expect(entry).not.toBeNull();
    expect(entry!.worldCell).toEqual([0, 0, -1]);
    expect(entry!.ref).toEqual({ ownerId: 'g0', localCell: [1, 0, 0] });
    const o = decodeOrientation('stairs', unpackCell(entry!.raw).code);
    // rotating 0=east by +Y 90 degrees gives north = 3 (from the measured table, #114). The same
    // direction the position rotates from +X→-Z
    expect(o).toEqual({ shape: 'stairs', weirdoDirection: 3, upsideDown: false });
  });

  it('composed parent/child transforms affect both worldCell and raw (parent 90 degrees + child 90 degrees = 180 degrees)', () => {
    const scene = makeScene();
    scene.tree.insertNode(node('g0', 'Parent', null), 0);
    scene.tree.insertNode(node('g1', 'Child', 'g0'), 0);
    scene.tree.setTransform('g0', { angleSteps: 1, translate: [0, 0, 0], pivot2: [1, 1] });
    scene.tree.setTransform('g1', { angleSteps: 1, translate: [0, 0, 0], pivot2: [1, 1] });
    const stairsRaw = packCell(2, encodeOrientation({ shape: 'stairs', weirdoDirection: 0, upsideDown: false }));
    scene.cells.set('g1', makeCellKey(1, 0, 0), stairsRaw);

    const projection = buildSceneProjection(scene, shapeOf);
    const entry = projection.winnerAt([-1, 0, 0]); // 180 degrees: +X → -X
    expect(entry).not.toBeNull();
    const o = decodeOrientation('stairs', unpackCell(entry!.raw).code);
    // 180 degrees, so 0=east → 1=west (from the measured table, #114)
    expect(o).toEqual({ shape: 'stairs', weirdoDirection: 1, upsideDown: false });
  });

  it('a scene with identity transforms projects with local = world unchanged (compatible with existing projects)', () => {
    const scene = makeScene();
    scene.tree.insertNode(node('g0', 'A', null), 0);
    scene.cells.set(null, makeCellKey(3, 1, -2), packCell(0, 0));
    scene.cells.set('g0', makeCellKey(0, 5, 7), packCell(1, 1));

    const projection = buildSceneProjection(scene, shapeOf);
    expect(projection.winnerAt([3, 1, -2])?.raw).toBe(packCell(0, 0));
    expect(projection.winnerAt([0, 5, 7])?.raw).toBe(packCell(1, 1)); // raw is also unchanged with no rotation
    expect([...projection.winners()]).toHaveLength(2);
  });
});

describe('SceneProjection — immutable snapshot contract (#37)', () => {
  it('mutating the original EditorScene after construction does not change the projection result', () => {
    const scene = makeScene();
    scene.tree.insertNode(node('g0', 'A', null), 0);
    scene.cells.set('g0', makeCellKey(0, 0, 0), FULL);
    const projection = buildSceneProjection(scene, shapeOf);

    scene.cells.set('g0', makeCellKey(5, 5, 5), FULL); // add a cell afterward
    scene.tree.setTransform('g0', { angleSteps: 2, translate: [9, 9, 9], pivot2: [1, 1] }); // change transform afterward
    scene.tree.setHidden('g0', true); // hide afterward

    expect(projection.winnerAt([0, 0, 0])).not.toBeNull(); // unchanged from construction time
    expect(projection.winnerAt([5, 5, 5])).toBeNull(); // the added cell is not reflected
    expect([...projection.winners()]).toHaveLength(1);
  });

  it('stackAt\'s returned array and entries are frozen; attempting to write throws and cannot corrupt internal state', () => {
    const scene = makeScene();
    scene.tree.insertNode(node('g0', 'A', null), 0);
    scene.cells.set('g0', makeCellKey(0, 0, 0), FULL);
    const projection = buildSceneProjection(scene, shapeOf);

    const stack = projection.stackAt([0, 0, 0]);
    expect(Object.isFrozen(stack)).toBe(true);
    expect(() => {
      (stack as unknown as unknown[]).push('injected');
    }).toThrow();
    const entry = stack[0]!;
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.worldCell)).toBe(true);
    expect(Object.isFrozen(entry.ref.localCell)).toBe(true);
    expect(() => {
      (entry.worldCell as unknown as number[])[0] = 999;
    }).toThrow();
    // still intact when fetched again
    expect(projection.stackAt([0, 0, 0])[0]!.worldCell).toEqual([0, 0, 0]);
  });
});

describe('SceneProjection — rejecting invalid aggregates / unknown shapes (#37)', () => {
  it('throws at construction time if a cell has an owner group that does not exist in the tree (does not silently ignore it)', () => {
    const scene = makeScene();
    scene.cells.set('ghost', makeCellKey(0, 0, 0), FULL);
    expect(() => buildSceneProjection(scene, shapeOf)).toThrow(/owner consistency violation/);
    expect(() => assertValidEditorScene(scene)).toThrow(/ghost/);
  });

  it('owner=null (directly under root) is valid even without a node in the tree', () => {
    const scene = makeScene();
    scene.cells.set(null, makeCellKey(0, 0, 0), FULL);
    expect(() => buildSceneProjection(scene, shapeOf)).not.toThrow();
  });

  it('throws if a rotation is required but shapeOf returns undefined for a cell', () => {
    const scene = makeScene();
    scene.tree.insertNode(node('g0', 'A', null), 0);
    scene.tree.setTransform('g0', { angleSteps: 1, translate: [0, 0, 0], pivot2: [1, 1] });
    scene.cells.set('g0', makeCellKey(0, 0, 0), packCell(99, 0)); // outside the catalog
    expect(() => buildSceneProjection(scene, shapeOf)).toThrow(/unknown catalogIndex/);
  });

  it('throws for an unknown-catalog cell even with an identity transform (no rotation) (#38 review regression)', () => {
    const scene = makeScene();
    scene.cells.set(null, makeCellKey(0, 0, 0), packCell(99, 0)); // does not slip through even directly under root with no rotation
    expect(() => buildSceneProjection(scene, shapeOf)).toThrow(/unknown catalogIndex/);
  });

  it('assertValidRuntimeScene: passes when the projected world coordinate is within range', () => {
    const scene = makeScene();
    scene.tree.insertNode(node('g0', 'A', null), 0);
    scene.tree.setTransform('g0', { angleSteps: 1, translate: [5, 2, 5], pivot2: [1, 1] });
    scene.cells.set('g0', makeCellKey(0, 0, 0), FULL);
    scene.cells.set(null, makeCellKey(3, 1, -2), FULL);
    expect(() => assertValidRuntimeScene(scene, shapeOf)).not.toThrow();
  });

  it('assertValidRuntimeScene: a negative owner-local y is valid, but throws if it projects to world y < 0', () => {
    const scene = makeScene();
    scene.tree.insertNode(node('g0', 'A', null), 0);
    // local y=-3 is valid as an owner-local coordinate (isValidLocalCell), and projects to world y=-3 under identity
    scene.cells.set('g0', makeCellKey(0, -3, 0), FULL);
    expect(() => assertValidRuntimeScene(scene, shapeOf)).toThrow(/world-range violation/);
  });

  it('assertValidRuntimeScene: detects a cell pushed out of range by translate', () => {
    const scene = makeScene();
    scene.tree.insertNode(node('g0', 'A', null), 0);
    scene.tree.setTransform('g0', { angleSteps: 0, translate: [600, 0, 0], pivot2: [0, 0] });
    scene.cells.set('g0', makeCellKey(0, 0, 0), FULL); // world x=600 > COORD_LIMIT
    expect(() => assertValidRuntimeScene(scene, shapeOf)).toThrow(/world-range violation/);
  });

  it('assertValidRuntimeScene: throws even if only a hidden cell is out of range (does not look at winner alone)', () => {
    const scene = makeScene();
    scene.tree.insertNode(node('g0', 'Visible', null), 0);
    scene.tree.insertNode(node('g1', 'hidden', null), 1);
    scene.tree.setHidden('g1', true);
    scene.tree.setTransform('g1', { angleSteps: 0, translate: [0, -5, 0], pivot2: [0, 0] });
    scene.cells.set('g0', makeCellKey(0, 0, 0), FULL); // normal
    scene.cells.set('g1', makeCellKey(0, 0, 0), FULL); // hidden, world y=-5
    expect(() => assertValidRuntimeScene(scene, shapeOf)).toThrow(/world-range violation/);
  });

  it('assertValidRuntimeScene: detects an out-of-range condition even when multiple entries overlap the same world coordinate', () => {
    const scene = makeScene();
    scene.tree.insertNode(node('g0', 'Lower', null), 0);
    scene.tree.insertNode(node('g1', 'Front', null), 1);
    // project 2 owners into the same out-of-range spot (the stack becomes 2 deep, with g1 as winner)
    scene.tree.setTransform('g0', { angleSteps: 0, translate: [0, -5, 0], pivot2: [0, 0] });
    scene.tree.setTransform('g1', { angleSteps: 0, translate: [0, -5, 0], pivot2: [0, 0] });
    scene.cells.set('g0', makeCellKey(0, 0, 0), FULL);
    scene.cells.set('g1', makeCellKey(0, 0, 0), FULL);
    expect(() => assertValidRuntimeScene(scene, shapeOf)).toThrow(/world-range violation/);
  });

  it('assertValidRuntimeScene: also detects owner-consistency violations (via buildSceneProjection)', () => {
    const scene = makeScene();
    scene.cells.set('ghost', makeCellKey(0, 0, 0), FULL);
    expect(() => assertValidRuntimeScene(scene, shapeOf)).toThrow(/owner consistency violation/);
  });

  it('OwnerVoxelStore.set rejects an invalid CellKey at the entry point (#38 review regression)', () => {
    const scene = makeScene();
    expect(() => scene.cells.set(null, 'abc', 0)).toThrow(/invalid CellKey/);
    expect(() => scene.cells.set(null, '1,2', 0)).toThrow(/invalid CellKey/); // too few elements
    expect(() => scene.cells.set(null, '1,2.5,3', 0)).toThrow(/invalid CellKey/); // non-integer
    expect(() => scene.cells.set(null, '01,2,3', 0)).toThrow(/invalid CellKey/); // non-canonical notation
    expect(() => scene.cells.set(null, '999,0,0', 0)).toThrow(/invalid CellKey/); // exceeds COORD_LIMIT
    expect(() => scene.cells.set(null, makeCellKey(1, -2, 3), 0)).not.toThrow(); // negative y is valid as a local coordinate
  });
});
