import { describe, expect, it } from 'vitest';
import { SceneTree, type GroupNode } from '../src/core/scenetree';
import { OwnerVoxelStore, type EditorScene } from '../src/core/ownervoxels';
import { buildSceneProjection, type ProjectionEntry } from '../src/core/sceneprojection';
import { WorldIndex, type SceneBatchChange, type WorldIndexChange } from '../src/core/worldindex';
import { makeCellRefKey, parseCellRefKey, type CellRef, type CellRefRemap, type OwnerId } from '../src/core/cellref';
import { packCell, encodeOrientation, decodeOrientation, unpackCell, type Shape } from '../src/core/orientation';
import { makeCellKey, parseCellKey, type CellKey } from '../src/core/types';
import type { GroupTransform } from '../src/core/transform';

const SHAPES: Shape[] = ['full', 'slab', 'stairs'];
const shapeOf = (catalogIndex: number): Shape | undefined => SHAPES[catalogIndex];

const A = packCell(0, 0);
const B = packCell(1, 0);
const C = packCell(2, 0);

interface OwnerSpec {
  id: string;
  parent?: string | null;
  hidden?: boolean;
  locked?: boolean;
  transform?: GroupTransform;
}

function node(id: string, parentId: string | null): GroupNode {
  return { id, name: id, parentId, childIds: [] };
}

/** Build a scene from owner specs (parent/child, hidden, locked, transform). Cells are added by the caller. */
function sceneWith(specs: readonly OwnerSpec[]): EditorScene {
  const scene: EditorScene = { tree: new SceneTree(), cells: new OwnerVoxelStore() };
  for (const spec of specs) {
    const parent = spec.parent ?? null;
    scene.tree.insertNode(node(spec.id, parent), scene.tree.childrenOf(parent).length);
    if (spec.hidden) scene.tree.setHidden(spec.id, true);
    if (spec.locked) scene.tree.setLocked(spec.id, true);
    if (spec.transform) scene.tree.setTransform(spec.id, spec.transform);
  }
  return scene;
}

/** Apply the same voxel change to both the scene (source of truth) and the WorldIndex (derived). */
function writeVoxel(scene: EditorScene, index: WorldIndex, owner: OwnerId, localKey: CellKey, after: number | null): void {
  if (after === null) scene.cells.delete(owner, localKey);
  else scene.cells.set(owner, localKey, after);
  index.applyVoxelChanges([{ owner, localKey, after }]);
}

function ownersOf(stack: readonly ProjectionEntry[]): OwnerId[] {
  return stack.map((e) => e.ref.ownerId);
}

describe('WorldIndex — overlap and winner resolution (#37 B1a)', () => {
  interface StackCase {
    name: string;
    /** Expected owner order from back to front */
    expectStack: OwnerId[];
    expectWinner: OwnerId | null;
    specs: readonly OwnerSpec[];
    /** Place [owner, value] pairs at local (0,0,0) so they all project to world (0,0,0) */
    cells: readonly [OwnerId, number][];
  }

  const STACK_CASES: StackCase[] = [
    {
      name: 'root → child group → grandchild group, 3 levels (later = more in front)',
      specs: [{ id: 'g0' }, { id: 'g1', parent: 'g0' }],
      cells: [[null, A], ['g0', B], ['g1', C]],
      expectStack: [null, 'g0', 'g1'],
      expectWinner: 'g1',
    },
    {
      name: 'siblings: later in childIds = more in front',
      specs: [{ id: 'g0' }, { id: 'g1' }],
      cells: [['g0', A], ['g1', B]],
      expectStack: ['g0', 'g1'],
      expectWinner: 'g1',
    },
    {
      name: 'a hidden frontmost entry stays in the stack but is not the winner (next candidate takes over)',
      specs: [{ id: 'g0' }, { id: 'g1', hidden: true }],
      cells: [['g0', A], ['g1', B]],
      expectStack: ['g0', 'g1'],
      expectWinner: 'g0',
    },
    {
      name: "a hidden ancestor's child is also excluded from being the winner",
      specs: [{ id: 'g0', hidden: true }, { id: 'g1', parent: 'g0' }, { id: 'g2' }],
      cells: [['g1', A], ['g2', B]],
      expectStack: ['g1', 'g2'],
      expectWinner: 'g2',
    },
    {
      name: 'if all candidates are hidden, winner is null (stack remains)',
      specs: [{ id: 'g0', hidden: true }, { id: 'g1', hidden: true }],
      cells: [['g0', A], ['g1', B]],
      expectStack: ['g0', 'g1'],
      expectWinner: null,
    },
    {
      name: 'locked does not affect winner resolution (visible = becomes winner)',
      specs: [{ id: 'g0' }, { id: 'g1', locked: true }],
      cells: [['g0', A], ['g1', B]],
      expectStack: ['g0', 'g1'],
      expectWinner: 'g1',
    },
  ];

  for (const testCase of STACK_CASES) {
    it(`rebuild: ${testCase.name}`, () => {
      const scene = sceneWith(testCase.specs);
      for (const [owner, raw] of testCase.cells) scene.cells.set(owner, makeCellKey(0, 0, 0), raw);
      const index = WorldIndex.fromScene(scene, shapeOf);

      expect(ownersOf(index.stackAt([0, 0, 0]))).toEqual(testCase.expectStack);
      expect(index.winnerRefAt([0, 0, 0])?.ref.ownerId ?? null).toBe(testCase.expectWinner);
      expect(index.isWorldCellHidden([0, 0, 0])).toBe(testCase.expectWinner === null);
    });

    it(`reaches the same state via incremental update: ${testCase.name}`, () => {
      // Building up from an empty scene via applyVoxelChanges alone yields the same stack order as rebuild
      const scene = sceneWith(testCase.specs);
      const index = WorldIndex.fromScene(scene, shapeOf);
      // Even writing front-to-back first, entries still order by paint order (owner rank)
      for (const [owner, raw] of [...testCase.cells].reverse()) {
        writeVoxel(scene, index, owner, makeCellKey(0, 0, 0), raw);
      }

      expect(ownersOf(index.stackAt([0, 0, 0]))).toEqual(testCase.expectStack);
      expect(index.winnerRefAt([0, 0, 0])?.ref.ownerId ?? null).toBe(testCase.expectWinner);
    });
  }

  it('erase-reveals-below: erasing the front owner\'s cell makes the owner below the winner', () => {
    const scene = sceneWith([{ id: 'g0' }, { id: 'g1' }]);
    scene.cells.set('g0', makeCellKey(0, 0, 0), A);
    scene.cells.set('g1', makeCellKey(0, 0, 0), B);
    const index = WorldIndex.fromScene(scene, shapeOf);
    expect(index.get(0, 0, 0)).toBe(B);

    writeVoxel(scene, index, 'g1', makeCellKey(0, 0, 0), null);

    expect(index.get(0, 0, 0)).toBe(A); // the owner below is revealed
    expect(ownersOf(index.stackAt([0, 0, 0]))).toEqual(['g0']);
    expect(index.worldOf({ ownerId: 'g1', localCell: [0, 0, 0] })).toBeNull(); // an erased ref can no longer be reverse-looked-up
  });

  it('erasing the last entry removes the world key entirely (not left in size / has / bounds)', () => {
    const scene = sceneWith([]);
    scene.cells.set(null, makeCellKey(2, 3, 4), A);
    const index = WorldIndex.fromScene(scene, shapeOf);
    expect(index.size).toBe(1);

    writeVoxel(scene, index, null, makeCellKey(2, 3, 4), null);

    expect(index.size).toBe(0);
    expect(index.has(2, 3, 4)).toBe(false);
    expect(index.stackAt([2, 3, 4])).toEqual([]);
    expect(index.bounds()).toBeNull();
  });

  it("overwriting the same owner's same local cell replaces the value without growing the stack", () => {
    const scene = sceneWith([{ id: 'g0' }]);
    scene.cells.set('g0', makeCellKey(0, 0, 0), A);
    const index = WorldIndex.fromScene(scene, shapeOf);

    writeVoxel(scene, index, 'g0', makeCellKey(0, 0, 0), B);

    expect(index.stackAt([0, 0, 0])).toHaveLength(1);
    expect(index.get(0, 0, 0)).toBe(B);
  });
});

describe('WorldIndex — WorldReader-compatible reads (#37 B1a)', () => {
  it('get / has / entries / size / bounds only show the winner (non-hidden)', () => {
    const scene = sceneWith([{ id: 'g0', hidden: true }]);
    scene.cells.set(null, makeCellKey(1, 0, 1), A);
    scene.cells.set(null, makeCellKey(-3, 2, 5), B);
    scene.cells.set('g0', makeCellKey(9, 9, 9), C); // a world coordinate belonging only to a hidden owner
    const index = WorldIndex.fromScene(scene, shapeOf);

    expect(index.size).toBe(2);
    expect(index.get(1, 0, 1)).toBe(A);
    expect(index.get(9, 9, 9)).toBeNull(); // hidden is "invisible"
    expect(index.has(9, 9, 9)).toBe(false);
    expect(index.isWorldCellHidden([9, 9, 9])).toBe(true); // but the entry itself still exists
    expect(index.stackAt([9, 9, 9])).toHaveLength(1);
    expect([...index.entries()].map((e) => e.join(',')).sort()).toEqual([[1, 0, 1, A].join(','), [-3, 2, 5, B].join(',')].sort());
    expect(index.bounds()).toEqual({ min: [-3, 0, 1], max: [1, 2, 5] });
  });

  it('ownerAtWorld / isWorldCellLocked are facades that look at the winner', () => {
    const scene = sceneWith([{ id: 'g0', locked: true }, { id: 'g1' }]);
    scene.cells.set('g0', makeCellKey(0, 0, 0), A);
    scene.cells.set('g1', makeCellKey(1, 0, 0), B);
    const index = WorldIndex.fromScene(scene, shapeOf);

    expect(index.ownerAtWorld([0, 0, 0])).toBe('g0');
    expect(index.isWorldCellLocked([0, 0, 0])).toBe(true);
    expect(index.ownerAtWorld([1, 0, 0])).toBe('g1');
    expect(index.isWorldCellLocked([1, 0, 0])).toBe(false);
    expect(index.ownerAtWorld([5, 5, 5])).toBeNull(); // a coordinate with nothing at it
    expect(index.isWorldCellLocked([5, 5, 5])).toBe(false);
  });
});

describe('WorldIndex — selectableRefAt (locked pass-through) (#37 B1a rev.3)', () => {
  it('even when locked is frontmost, returns the unlocked lower ref at the same world coordinate', () => {
    const scene = sceneWith([{ id: 'g0' }, { id: 'g1', locked: true }]);
    scene.cells.set('g0', makeCellKey(0, 0, 0), A);
    scene.cells.set('g1', makeCellKey(0, 0, 0), B);
    const index = WorldIndex.fromScene(scene, shapeOf);

    expect(index.winnerRefAt([0, 0, 0])?.ref.ownerId).toBe('g1'); // place/erase/pick hit the locked entry
    const selectable = index.selectableRefAt([0, 0, 0]);
    expect(selectable?.ref.ownerId).toBe('g0'); // only selection passes through to below
    expect(selectable?.raw).toBe(A);
  });

  it('null when all candidates are locked (DDA can advance to the next cell)', () => {
    const scene = sceneWith([{ id: 'g0', locked: true }, { id: 'g1', locked: true }]);
    scene.cells.set('g0', makeCellKey(0, 0, 0), A);
    scene.cells.set('g1', makeCellKey(0, 0, 0), B);
    const index = WorldIndex.fromScene(scene, shapeOf);

    expect(index.winnerRefAt([0, 0, 0])).not.toBeNull();
    expect(index.selectableRefAt([0, 0, 0])).toBeNull();
  });

  it('even when the near cell is entirely locked, the far unlocked cell is independently selectable (judged per coordinate)', () => {
    const scene = sceneWith([{ id: 'g0', locked: true }, { id: 'g1' }]);
    scene.cells.set('g0', makeCellKey(0, 0, 0), A); // near
    scene.cells.set('g1', makeCellKey(0, 0, 3), B); // far
    const index = WorldIndex.fromScene(scene, shapeOf);

    expect(index.selectableRefAt([0, 0, 0])).toBeNull();
    expect(index.selectableRefAt([0, 0, 3])?.ref.ownerId).toBe('g1');
  });

  it('hidden is not selectable (an exclusion condition independent of locked)', () => {
    const scene = sceneWith([{ id: 'g0' }, { id: 'g1', hidden: true }]);
    scene.cells.set('g0', makeCellKey(0, 0, 0), A);
    scene.cells.set('g1', makeCellKey(0, 0, 0), B);
    const index = WorldIndex.fromScene(scene, shapeOf);

    expect(index.selectableRefAt([0, 0, 0])?.ref.ownerId).toBe('g0');
  });

  it('ancestor lock also applies (equivalent to isLockedEffective)', () => {
    const scene = sceneWith([{ id: 'g0', locked: true }, { id: 'g1', parent: 'g0' }]);
    scene.cells.set('g1', makeCellKey(0, 0, 0), A);
    const index = WorldIndex.fromScene(scene, shapeOf);

    expect(index.selectableRefAt([0, 0, 0])).toBeNull();
  });

  it('effectiveLocked is a snapshot at rebuild time (directly mutating the tree has no effect until rebuild)', () => {
    const scene = sceneWith([{ id: 'g0' }]);
    scene.cells.set('g0', makeCellKey(0, 0, 0), A);
    const index = WorldIndex.fromScene(scene, shapeOf);
    expect(index.selectableRefAt([0, 0, 0])?.ref.ownerId).toBe('g0');

    scene.tree.setLocked('g0', true); // direct change that bypasses the index

    expect(index.selectableRefAt([0, 0, 0])?.ref.ownerId).toBe('g0'); // keeps the same snapshot generation as stack/rank
    index.rebuildFromScene(scene);
    expect(index.selectableRefAt([0, 0, 0])).toBeNull();
  });
});

describe('WorldIndex — transform application and worldOf reverse lookup (#37 B1a)', () => {
  const ROT90: GroupTransform = { angleSteps: 1, translate: [0, 0, 0], pivot2: [1, 1] };

  it('writing to a rotated owner emits a cells event at the post-rotation world coordinate', () => {
    const scene = sceneWith([{ id: 'g0', transform: ROT90 }]);
    const index = WorldIndex.fromScene(scene, shapeOf);
    const events: WorldIndexChange[] = [];
    index.subscribe((e) => events.push(e));

    writeVoxel(scene, index, 'g0', makeCellKey(1, 0, 0), A);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: 'cells', cells: [[0, 0, -1]] }); // local +X → world -Z
    expect(index.get(0, 0, -1)).toBe(A);
    expect(index.get(1, 0, 0)).toBeNull();
  });

  it('writing to a rotated owner also rotates the raw orientation (rotateRaw applied)', () => {
    const scene = sceneWith([{ id: 'g0', transform: ROT90 }]);
    const index = WorldIndex.fromScene(scene, shapeOf);
    const stairs = packCell(2, encodeOrientation({ shape: 'stairs', weirdoDirection: 0, upsideDown: false }));

    writeVoxel(scene, index, 'g0', makeCellKey(1, 0, 0), stairs);

    const raw = index.get(0, 0, -1);
    expect(raw).not.toBeNull();
    // rotating 0=east by +Y 90 degrees gives north = 3 (from the measured table, #114)
    expect(decodeOrientation('stairs', unpackCell(raw!).code)).toEqual({ shape: 'stairs', weirdoDirection: 3, upsideDown: false });
  });

  it('worldOf returns ref → current projected location, and follows transform changes (rebuild)', () => {
    const scene = sceneWith([{ id: 'g0' }]);
    scene.cells.set('g0', makeCellKey(1, 0, 0), A);
    const index = WorldIndex.fromScene(scene, shapeOf);
    const ref: CellRef = { ownerId: 'g0', localCell: [1, 0, 0] };

    expect(index.worldOf(ref)).toEqual([1, 0, 0]);

    scene.tree.setTransform('g0', ROT90);
    index.rebuildFromScene(scene);

    expect(index.worldOf(ref)).toEqual([0, 0, -1]); // the same ref, only the projected location moves
    expect(index.worldOf({ ownerId: 'g0', localCell: [9, 9, 9] })).toBeNull();
    expect(index.worldOf({ ownerId: null, localCell: [1, 0, 0] })).toBeNull(); // different owner means a different ref
  });

  it('incremental update to an unknown owner throws (rebuild required after structural changes)', () => {
    const scene = sceneWith([]);
    const index = WorldIndex.fromScene(scene, shapeOf);
    expect(() => index.applyVoxelChanges([{ owner: 'ghost', localKey: makeCellKey(0, 0, 0), after: A }])).toThrow(/unknown owner/);
  });
});

describe('WorldIndex — 2-channel notifications (#37 B1a rev.7)', () => {
  it('content changes go through WorldIndexChange, lifecycle through SceneBatchChange — separate subscription channels', () => {
    const scene = sceneWith([]);
    const index = WorldIndex.fromScene(scene, shapeOf);
    const content: WorldIndexChange[] = [];
    const batch: SceneBatchChange[] = [];
    index.subscribe((e) => content.push(e));
    index.subscribeBatch((e) => batch.push(e));

    writeVoxel(scene, index, null, makeCellKey(0, 0, 0), A);
    index.notifyBatch({ phase: 'commit' });

    expect(content).toEqual([{ kind: 'cells', cells: [[0, 0, 0]] }]);
    expect(batch).toEqual([{ phase: 'commit' }]);
  });

  it('a commit that does not change content (equivalent to a staged voxel commit) can notify lifecycle only', () => {
    const scene = sceneWith([]);
    const index = WorldIndex.fromScene(scene, shapeOf);
    const content: WorldIndexChange[] = [];
    const batch: SceneBatchChange[] = [];
    index.subscribe((e) => content.push(e));
    index.subscribeBatch((e) => batch.push(e));

    const remap: CellRefRemap = new Map<string, CellRef>([
      [makeCellRefKey({ ownerId: null, localCell: [0, 0, 0] }), { ownerId: 'g0', localCell: [1, 1, 1] }],
    ]);
    index.notifyBatch({ phase: 'commit', refRemap: remap });

    expect(content).toEqual([]); // the renderer does not rebuild
    expect(batch).toHaveLength(1);
    const event = batch[0]!;
    expect(event.phase).toBe('commit');
    expect(event.phase === 'commit' ? event.refRemap : undefined).toBe(remap);
  });

  it('rebuildFromScene notifies replaceAll once, applyVoxelChanges notifies affected world coordinates together in one go', () => {
    const scene = sceneWith([{ id: 'g0' }]);
    const index = WorldIndex.fromScene(scene, shapeOf);
    const content: WorldIndexChange[] = [];
    index.subscribe((e) => content.push(e));

    index.rebuildFromScene(scene);
    scene.cells.set('g0', makeCellKey(0, 0, 0), A);
    scene.cells.set('g0', makeCellKey(1, 0, 0), B);
    index.applyVoxelChanges([
      { owner: 'g0', localKey: makeCellKey(0, 0, 0), after: A },
      { owner: 'g0', localKey: makeCellKey(1, 0, 0), after: B },
    ]);

    expect(content).toEqual([
      { kind: 'replaceAll' },
      { kind: 'cells', cells: [[0, 0, 0], [1, 0, 0]] },
    ]);
  });

  it('the 3 phases preview / restore / commit arrive on the same channel in order', () => {
    const scene = sceneWith([]);
    const index = WorldIndex.fromScene(scene, shapeOf);
    const batch: SceneBatchChange[] = [];
    index.subscribeBatch((e) => batch.push(e));

    index.notifyBatch({ phase: 'preview' });
    index.notifyBatch({ phase: 'restore' });
    index.notifyBatch({ phase: 'commit' });

    expect(batch.map((e) => e.phase)).toEqual(['preview', 'restore', 'commit']);
  });
});

describe('WorldIndex — swap-style updates and defensive copies (#37 B1a rev.5 P2)', () => {
  it("stackAt's return value is frozen; mutating it does not corrupt the internal stack", () => {
    const scene = sceneWith([{ id: 'g0' }]);
    scene.cells.set('g0', makeCellKey(0, 0, 0), A);
    const index = WorldIndex.fromScene(scene, shapeOf);

    const stack = index.stackAt([0, 0, 0]);
    expect(Object.isFrozen(stack)).toBe(true);
    expect(() => {
      (stack as unknown as unknown[]).push('injected');
    }).toThrow();
    expect(index.stackAt([0, 0, 0])).toHaveLength(1);
    expect(Object.isFrozen(stack[0]!)).toBe(true);
  });

  it("stackAt's snapshot does not change with subsequent incremental updates (no live reference is passed)", () => {
    const scene = sceneWith([{ id: 'g0' }, { id: 'g1' }]);
    scene.cells.set('g0', makeCellKey(0, 0, 0), A);
    const index = WorldIndex.fromScene(scene, shapeOf);
    const before = index.stackAt([0, 0, 0]);

    writeVoxel(scene, index, 'g1', makeCellKey(0, 0, 0), B);

    expect(before).toHaveLength(1); // unchanged from when it was retrieved
    expect(index.stackAt([0, 0, 0])).toHaveLength(2);
  });

  it('index is not partially modified even if an incremental update throws midway (unknown catalog)', () => {
    const scene = sceneWith([{ id: 'g0' }]);
    scene.cells.set('g0', makeCellKey(0, 0, 0), A);
    const index = WorldIndex.fromScene(scene, shapeOf);
    const content: WorldIndexChange[] = [];
    index.subscribe((e) => content.push(e));

    expect(() =>
      index.applyVoxelChanges([
        { owner: 'g0', localKey: makeCellKey(1, 0, 0), after: B }, // change that should have succeeded
        { owner: 'g0', localKey: makeCellKey(2, 0, 0), after: packCell(99, 0) }, // throws due to being outside the catalog
      ]),
    ).toThrow(/unknown catalogIndex/);

    expect(index.size).toBe(1); // the first entry was not applied either
    expect(index.get(1, 0, 0)).toBeNull();
    expect(content).toEqual([]); // no notification is emitted either
  });

  it('a non-canonical localKey is rejected before a touched stack is built, leaving index, reverse lookup, and notifications completely unchanged', () => {
    // Before the fix, "0,0,0,extra" was parsed as [0,0,0], and while it removed the
    // existing entry from the stack for a matching owner, only the reverse lookup was
    // stored under the non-canonical ref key.
    // As a result, the canonical ref's worldOf() could keep pointing at the old
    // coordinate while stack/winner changed, creating an inconsistency.
    const badKeys = ['0,0,0,extra', '1,NaN,0', '1,2.5,3', '999,0,0', '01,2,3', 'abc', '1,2'];
    for (const badKey of badKeys) {
      const scene = sceneWith([{ id: 'g0' }]);
      scene.cells.set('g0', makeCellKey(0, 0, 0), A);
      const index = WorldIndex.fromScene(scene, shapeOf);
      const content: WorldIndexChange[] = [];
      index.subscribe((e) => content.push(e));

      expect(() =>
        index.applyVoxelChanges([
          { owner: 'g0', localKey: makeCellKey(1, 0, 0), after: B }, // a normal first entry
          { owner: 'g0', localKey: badKey, after: C }, // rejected on the second entry
        ]),
      ).toThrow(/invalid CellKey/);

      expect(index.size).toBe(1); // the first entry was not applied either
      expect(index.get(1, 0, 0)).toBeNull();
      expect(index.worldOf({ ownerId: 'g0', localCell: [0, 0, 0] })).toEqual([0, 0, 0]); // reverse lookup also unaffected
      expect(ownersOf(index.stackAt([0, 0, 0]))).toEqual(['g0']);
      expect(content).toEqual([]); // no notification is emitted either
    }
  });

  it('an unknown owner is also rejected before a touched stack is built (even as the 2nd item in a batch, the 1st item is not applied)', () => {
    const scene = sceneWith([{ id: 'g0' }]);
    const index = WorldIndex.fromScene(scene, shapeOf);
    const content: WorldIndexChange[] = [];
    index.subscribe((e) => content.push(e));

    expect(() =>
      index.applyVoxelChanges([
        { owner: 'g0', localKey: makeCellKey(0, 0, 0), after: A },
        { owner: 'ghost', localKey: makeCellKey(1, 0, 0), after: B },
      ]),
    ).toThrow(/unknown owner/);

    expect(index.size).toBe(0);
    expect(content).toEqual([]);
  });

  it('existing index is unaffected even if rebuild throws (when attempting to project a broken scene)', () => {
    const scene = sceneWith([{ id: 'g0' }]);
    scene.cells.set('g0', makeCellKey(0, 0, 0), A);
    const index = WorldIndex.fromScene(scene, shapeOf);

    scene.cells.set('ghost', makeCellKey(5, 5, 5), B); // an owner not present in the tree
    expect(() => index.rebuildFromScene(scene)).toThrow(/owner consistency violation/);

    expect(index.size).toBe(1);
    expect(index.get(0, 0, 0)).toBe(A);
    expect(index.get(5, 5, 5)).toBeNull();
  });
});

describe('WorldIndex — equivalence with buildSceneProjection (#37 B1a)', () => {
  /** Pseudo-random number generator (fixed seed, reproducible) */
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Verify that WorldIndex exactly matches an immutable projection built from the same scene */
  function expectEquivalent(scene: EditorScene, index: WorldIndex): void {
    const projection = buildSceneProjection(scene, shapeOf);
    const projectedKeys = new Set<CellKey>();
    let winnerCount = 0;

    for (const [worldKey, stack] of projection.allStacks()) {
      projectedKeys.add(worldKey);
      const world = parseCellKey(worldKey);
      const indexStack = index.stackAt(world);
      expect(ownersOf(indexStack)).toEqual(ownersOf(stack));
      expect(indexStack.map((e) => e.raw)).toEqual(stack.map((e) => e.raw));
      expect(indexStack.map((e) => e.effectiveHidden)).toEqual(stack.map((e) => e.effectiveHidden));

      const winner: ProjectionEntry | null = projection.winnerAt(world);
      expect(index.winnerRefAt(world)?.ref).toEqual(winner?.ref);
      if (winner) winnerCount++;

      for (const entry of stack) {
        expect(index.worldOf(entry.ref)).toEqual(entry.worldCell);
      }
    }

    // no extra winner / world coordinates remain on the index side (detects missed deletions)
    expect(index.size).toBe(winnerCount);
    for (const [x, y, z] of index.entries()) {
      expect(projectedKeys.has(makeCellKey(x, y, z))).toBe(true);
    }
  }

  it('stays consistent with the projection even after a pseudo-random op sequence (mix of voxel diffs and structural rebuilds)', () => {
    const random = mulberry32(20260725);
    const scene = sceneWith([
      { id: 'g0' },
      { id: 'g1', parent: 'g0' },
      { id: 'g2' },
    ]);
    const index = WorldIndex.fromScene(scene, shapeOf);
    const owners: OwnerId[] = [null, 'g0', 'g1', 'g2'];
    const groups = ['g0', 'g1', 'g2'];
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;

    for (let step = 0; step < 300; step++) {
      const roll = random();
      if (roll < 0.55) {
        // voxel place (kept within a narrow local space so overlaps occur)
        const owner = pick(owners);
        const localKey = makeCellKey(Math.floor(random() * 3), Math.floor(random() * 2), Math.floor(random() * 3));
        writeVoxel(scene, index, owner, localKey, pick([A, B, C]));
      } else if (roll < 0.75) {
        // voxel erase (also mixes in erasing cells that don't exist)
        const owner = pick(owners);
        const localKey = makeCellKey(Math.floor(random() * 3), Math.floor(random() * 2), Math.floor(random() * 3));
        writeVoxel(scene, index, owner, localKey, null);
      } else if (roll < 0.85) {
        scene.tree.setHidden(pick(groups), random() < 0.5);
        index.rebuildFromScene(scene);
      } else if (roll < 0.92) {
        scene.tree.setLocked(pick(groups), random() < 0.5);
        index.rebuildFromScene(scene);
      } else {
        const angleSteps = Math.floor(random() * 4) as 0 | 1 | 2 | 3;
        scene.tree.setTransform(pick(groups), {
          angleSteps,
          translate: [Math.floor(random() * 5) - 2, Math.floor(random() * 3), Math.floor(random() * 5) - 2],
          pivot2: [1, 1],
        });
        index.rebuildFromScene(scene);
      }

      if (step % 10 === 0) expectEquivalent(scene, index);
    }

    expectEquivalent(scene, index);
    expect(index.size).toBeGreaterThan(0); // not a vacuous pass that would succeed on an empty scene
  });
});

describe('CellRefKey — injective encoding for all OwnerId values (#37 B1a, addressing PR #39 review)', () => {
  it('round-trips owner (root / group) and local coordinates', () => {
    const refs: CellRef[] = [
      { ownerId: null, localCell: [0, 0, 0] },
      { ownerId: 'g0', localCell: [-1, 2, -3] },
      { ownerId: 'g12', localCell: [512, -512, 0] },
    ];
    for (const ref of refs) {
      expect(parseCellRefKey(makeCellRefKey(ref))).toEqual(ref);
    }
  });

  it('null / empty string / ids containing the delimiter round-trip without colliding with each other', () => {
    // SceneTree currently does not reject empty-string ids or ids containing "|", so if
    // CellRefKey were not injective over the entire OwnerId value range, a derived index
    // could end up unable to read a valid EditorScene (or collide with another owner's ref).
    const owners: OwnerId[] = [null, '', 'g0', 'a|b', '|', '||', '0', '-', '3|a', '01'];
    const keys = owners.map((ownerId) => makeCellRefKey({ ownerId, localCell: [1, 2, 3] }));

    expect(new Set(keys).size).toBe(owners.length); // mutually non-colliding
    owners.forEach((ownerId, i) => {
      expect(parseCellRefKey(keys[i]!)).toEqual({ ownerId, localCell: [1, 2, 3] });
    });
  });

  it('a different owner / different local coordinate produces a different key (selection is not conflated by equivalence)', () => {
    const rootRef = makeCellRefKey({ ownerId: null, localCell: [1, 2, 3] });
    const groupRef = makeCellRefKey({ ownerId: 'g0', localCell: [1, 2, 3] });
    expect(rootRef).not.toBe(groupRef);
    expect(makeCellRefKey({ ownerId: 'g0', localCell: [1, 2, 3] })).not.toBe(makeCellRefKey({ ownerId: 'g0', localCell: [1, 2, 4] }));
  });

  it('a malformed key string is rejected at parse time (does not silently turn into a different ref)', () => {
    expect(() => parseCellRefKey('g0,0,0')).toThrow(/Invalid CellRefKey/); // no delimiter
    expect(() => parseCellRefKey('x|g0|1,2,3')).toThrow(/Invalid CellRefKey/); // length is not a number
    expect(() => parseCellRefKey('99|g0|1,2,3')).toThrow(/Invalid CellRefKey/); // length and actual content mismatch
  });
});
