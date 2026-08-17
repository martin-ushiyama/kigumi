import { describe, expect, it } from 'vitest';
import {
  loadProjectV3,
  migrateV2ToV3,
  serializeProjectV3,
  validateProject,
  validateProjectV3,
  type ProjectFileV2,
  type ProjectFileV3,
} from '../src/project/persistence';
import { CATALOG } from '../src/data/blocks';
import { buildSceneProjection } from '../src/core/sceneprojection';
import { unpackCell, type Shape } from '../src/core/orientation';
import { makeCellKey } from '../src/core/types';
import { SceneTree } from '../src/core/scenetree';
import { OwnerVoxelStore, type EditorScene } from '../src/core/ownervoxels';

const indexOf = (blockId: string): number | undefined => {
  const i = CATALOG.findIndex((d) => d.id === blockId);
  return i === -1 ? undefined : i;
};
const shapeOf = (catalogIndex: number): Shape | undefined => CATALOG[catalogIndex]?.shape;

const STONE = CATALOG[0]!.id;

function v3File(partial: Partial<ProjectFileV3>): ProjectFileV3 {
  return { app: 'blocksmith', version: 3, name: 'Test', groups: [], cells: [], recipes: [], ...partial };
}

describe('persistence v3 — migration from v2', () => {
  it('migrateV2ToV3: all group transforms are omitted (treated as identity), local coordinates stay = world coordinates', () => {
    const v2: ProjectFileV2 = {
      app: 'blocksmith',
      version: 2,
      name: 'Migration test',
      blocks: [
        [0, 0, 0, STONE, 0, -1],
        [1, 2, 3, STONE, 0, 0],
      ],
      groups: [{ name: 'G', parent: -1, hidden: true }],
      recipes: [],
    };
    const migrated = migrateV2ToV3(validateProject(v2, indexOf));
    expect(migrated.groups).toHaveLength(1);
    expect(migrated.groups[0]!.transform).toBeUndefined(); // don't bake in a fixed pivot (contract: initialize at bounds center on first rotation)
    expect(migrated.groups[0]!.hidden).toBe(true);
    expect(migrated.cells).toEqual([
      [-1, 0, 0, 0, expect.any(Number)],
      [0, 1, 2, 3, expect.any(Number)],
    ]);
  });

  it('validateProjectV3 accepts v1/v2 too and normalizes them to v3 format', () => {
    const v1 = { app: 'blocksmith', version: 1, name: 'v1', blocks: [[0, 0, 0, STONE]], recipes: [] };
    const validated = validateProjectV3(v1, indexOf);
    expect(validated.cells).toEqual([[-1, 0, 0, 0, expect.any(Number)]]);
    expect(validated.groups).toEqual([]);
  });

  it('an existing project migrated with identity transform shows the same world display after projection', () => {
    const v2: ProjectFileV2 = {
      app: 'blocksmith',
      version: 2,
      name: 'Compat check',
      blocks: [
        [0, 0, 0, STONE, 0, -1],
        [5, 1, -3, STONE, 0, 0],
        [2, 4, 2, STONE, 0, 1],
      ],
      groups: [
        { name: 'Parent', parent: -1 },
        { name: 'Child', parent: 0 },
      ],
      recipes: [],
    };
    const { scene } = loadProjectV3(v2, indexOf);
    const projection = buildSceneProjection(scene, shapeOf);
    // the original world coordinates become the winner as-is, and every stack has depth 1
    for (const [x, y, z] of [
      [0, 0, 0],
      [5, 1, -3],
      [2, 4, 2],
    ] as const) {
      expect(projection.winnerAt([x, y, z])).not.toBeNull();
      expect(projection.stackAt([x, y, z])).toHaveLength(1);
    }
    expect([...projection.winners()]).toHaveLength(3);
  });
});

describe('persistence v3 — round-trip', () => {
  it('preserves an overlap where multiple owners project to the same world coordinate through a round-trip', () => {
    // g0 is projected via translate to the same world coordinate (0,0,0) as g1's cell
    const file = v3File({
      groups: [
        { name: 'Back', parent: -1, transform: { angleSteps: 0, translate: [-5, 0, 0], pivot2: [0, 0] } },
        { name: 'Front', parent: -1 },
      ],
      cells: [
        [0, 5, 0, 0, STONE, 0], // g0 local (5,0,0) → world (0,0,0)
        [1, 0, 0, 0, STONE, 0], // g1 local (0,0,0) → world (0,0,0)
      ],
    });
    const { scene, name } = loadProjectV3(file, indexOf);
    expect(name).toBe('Test');

    const projection = buildSceneProjection(scene, shapeOf);
    expect(projection.stackAt([0, 0, 0])).toHaveLength(2); // the overlap is preserved
    expect(projection.winnerAt([0, 0, 0])?.ref.ownerId).toBe(scene.tree.childrenOf(null)[1]!); // the later sibling is in front

    // serialize → validate → reload keeps the same structure
    const reserialized = serializeProjectV3('Test', scene, CATALOG, []);
    expect(reserialized.version).toBe(3);
    expect(reserialized.cells).toHaveLength(2);
    const { scene: scene2 } = loadProjectV3(reserialized, indexOf);
    const projection2 = buildSceneProjection(scene2, shapeOf);
    expect(projection2.stackAt([0, 0, 0])).toHaveLength(2);
    expect([...projection2.winners()]).toHaveLength(1);
  });

  it('transform (angleSteps/translate/pivot2) and hidden/locked round-trip', () => {
    const file = v3File({
      groups: [
        {
          name: 'Rotated group',
          parent: -1,
          hidden: true,
          locked: true,
          transform: { angleSteps: 3, translate: [1, -2, 3], pivot2: [5, 7] },
        },
      ],
      cells: [[0, 0, 0, 0, STONE, 0]],
    });
    const { scene } = loadProjectV3(file, indexOf);
    const reserialized = serializeProjectV3('Test', scene, CATALOG, []);
    expect(reserialized.groups[0]).toEqual({
      name: 'Rotated group',
      parent: -1,
      hidden: true,
      locked: true,
      transform: { angleSteps: 3, translate: [1, -2, 3], pivot2: [5, 7] },
    });
  });

  it('owner-local coordinates allow negative y (no y>=0 constraint like world coordinates have)', () => {
    const file = v3File({
      groups: [{ name: 'G', parent: -1, transform: { angleSteps: 0, translate: [0, 10, 0], pivot2: [0, 0] } }],
      cells: [[0, 0, -3, 0, STONE, 0]], // local y = -3 (projects to world y = 7)
    });
    const { scene } = loadProjectV3(file, indexOf);
    const projection = buildSceneProjection(scene, shapeOf);
    expect(projection.winnerAt([0, 7, 0])).not.toBeNull();
  });
});

describe('persistence v3 — rejecting malformed data', () => {
  const cases: [string, (f: ProjectFileV3) => unknown][] = [
    ['unknown ownerIndex', (f) => ({ ...f, cells: [[5, 0, 0, 0, STONE, 0]] })],
    ['ownerIndex is -2', (f) => ({ ...f, cells: [[-2, 0, 0, 0, STONE, 0]] })],
    [
      'duplicate local coordinate within the same owner',
      (f) => ({
        ...f,
        groups: [{ name: 'G', parent: -1 }],
        cells: [
          [0, 1, 1, 1, STONE, 0],
          [0, 1, 1, 1, STONE, 1],
        ],
      }),
    ],
    ['angleSteps out of range', (f) => ({ ...f, groups: [{ name: 'G', parent: -1, transform: { angleSteps: 4, translate: [0, 0, 0], pivot2: [0, 0] } }] })],
    ['translate is non-integer', (f) => ({ ...f, groups: [{ name: 'G', parent: -1, transform: { angleSteps: 0, translate: [0.5, 0, 0], pivot2: [0, 0] } }] })],
    ['pivot2 parity mismatch', (f) => ({ ...f, groups: [{ name: 'G', parent: -1, transform: { angleSteps: 0, translate: [0, 0, 0], pivot2: [2, 1] } }] })],
    ['pivot2 has too few elements', (f) => ({ ...f, groups: [{ name: 'G', parent: -1, transform: { angleSteps: 0, translate: [0, 0, 0], pivot2: [0] } }] })],
    ['non-pre-order parent', (f) => ({ ...f, groups: [{ name: 'A', parent: 1 }, { name: 'B', parent: -1 }] })],
    ['local coordinate out of range', (f) => ({ ...f, cells: [[-1, 999, 0, 0, STONE, 0]] })],
    ['cells element count is not 6', (f) => ({ ...f, cells: [[-1, 0, 0, 0, STONE]] })],
  ];
  for (const [label, mutate] of cases) {
    it(`${label} throws`, () => {
      expect(() => validateProjectV3(mutate(v3File({})), indexOf)).toThrow();
    });
  }

  it('the same local coordinate across different owners is allowed', () => {
    const file = v3File({
      groups: [
        { name: 'A', parent: -1 },
        { name: 'B', parent: -1 },
      ],
      cells: [
        [0, 1, 1, 1, STONE, 0],
        [1, 1, 1, 1, STONE, 0],
        [-1, 1, 1, 1, STONE, 0], // root is treated as a separate owner too
      ],
    });
    expect(() => validateProjectV3(file, indexOf)).not.toThrow();
    const validated = validateProjectV3(file, indexOf);
    expect(validated.cells).toHaveLength(3);
  });

  it('an unknown blockId is skipped, and the count shows up in skipped', () => {
    const file = v3File({ cells: [[-1, 0, 0, 0, 'minecraft:not_a_real_block', 0]] });
    const validated = validateProjectV3(file, indexOf);
    expect(validated.cells).toHaveLength(0);
    expect(validated.skipped).toBe(1);
  });
});

describe('persistence v3 — owner consistency on serialize', () => {
  it('serializing a scene containing an owner absent from the tree throws (no fallback demotion to root)', () => {
    const scene: EditorScene = { tree: new SceneTree(), cells: new OwnerVoxelStore() };
    scene.cells.set('ghost', makeCellKey(0, 0, 0), 0);
    expect(() => serializeProjectV3('x', scene, CATALOG, [])).toThrow(/owner consistency violation/);
  });

  it('loadProjectV3 returns correct loaded/skipped/recipes', () => {
    const file = v3File({
      cells: [
        [-1, 0, 0, 0, STONE, 0],
        [-1, 1, 0, 0, 'minecraft:not_a_real_block', 0],
      ],
      recipes: [{ id: 'r1', name: 'Mix', entries: [{ blockId: STONE, weight: 1 }] }],
    });
    const result = loadProjectV3(file, indexOf);
    expect(result.loaded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.recipes).toHaveLength(1);
    expect(result.scene.cells.has(null, makeCellKey(0, 0, 0))).toBe(true);
  });

  it('a serialized cell value keeps the original catalogIndex/code', () => {
    const file = v3File({ cells: [[-1, 2, 3, 4, STONE, 5]] });
    const { scene } = loadProjectV3(file, indexOf);
    const raw = scene.cells.get(null, makeCellKey(2, 3, 4))!;
    expect(unpackCell(raw)).toEqual({ catalogIndex: 0, code: 5 });
    const reserialized = serializeProjectV3('x', scene, CATALOG, []);
    expect(reserialized.cells).toEqual([[-1, 2, 3, 4, STONE, 5]]);
  });
});

describe('persistence v3 — setTransform(undefined) and defense against invalid CellKey', () => {
  it('a group that was set then cleared has transform go back to omitted on serialize (preserves the migration contract)', () => {
    const file = v3File({ groups: [{ name: 'G', parent: -1 }], cells: [[0, 0, 0, 0, STONE, 0]] });
    const { scene } = loadProjectV3(file, indexOf);
    const id = scene.tree.childrenOf(null)[0]!;

    scene.tree.setTransform(id, { angleSteps: 1, translate: [0, 0, 0], pivot2: [1, 1] });
    expect(serializeProjectV3('x', scene, CATALOG, []).groups[0]!.transform).toBeDefined();

    scene.tree.setTransform(id, undefined); // equivalent to undoing the first rotation
    const reserialized = serializeProjectV3('x', scene, CATALOG, []);
    expect(reserialized.groups[0]!.transform).toBeUndefined();
    expect('transform' in reserialized.groups[0]!).toBe(false);
  });

  it('an invalid CellKey is rejected at the entry point of OwnerVoxelStore.set, so a v3 with NaN coordinates can never be written', () => {
    const scene: EditorScene = { tree: new SceneTree(), cells: new OwnerVoxelStore() };
    expect(() => scene.cells.set(null, 'not-a-key', 0)).toThrow(/invalid CellKey/);
    // rejected at the entry point, so there is no path where serialize produces a v3 with NaN/null coordinates
    const serialized = serializeProjectV3('x', scene, CATALOG, []);
    expect(serialized.cells).toEqual([]);
  });
});
