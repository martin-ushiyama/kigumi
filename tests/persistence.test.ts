import { describe, expect, it } from 'vitest';
import { buildIndexOf, RecipeStore } from '../src/core/mixpalette';
import type { MixRecipe } from '../src/core/mixpalette';
import { MAX_ORIENTATION_CODE, packCell } from '../src/core/orientation';
import { CATALOG } from '../src/data/blocks';
import { loadProject, serializeProject } from '../src/project/persistence';
import { DocumentFixture } from './helpers/document-fixture';

const indexOf = buildIndexOf(CATALOG);

function setup() {
  const doc = new DocumentFixture();
  doc.setCells([
    [0, 0, 0, packCell(0, 0)],
    [1, 0, 0, packCell(2, 0)],
  ]);
  const store = new RecipeStore(null);
  store.create('Existing Recipe');
  return { doc, store };
}

const validProject = () => ({
  app: 'blocksmith',
  version: 1,
  name: 'Test',
  blocks: [[5, 0, 5, 'minecraft:stone_bricks']] as [number, number, number, string][],
  recipes: [{ id: 'r1', name: 'mix', entries: [{ blockId: 'minecraft:stone', weight: 2 }] }],
});

describe('Atomic load', () => {
  it('valid data replaces world, and recipes are appended to the existing ones', () => {
    const { doc, store } = setup();
    const result = loadProject(validProject(), doc, indexOf, store);
    expect(result).toMatchObject({ name: 'Test', loaded: 1, skipped: 0 });
    expect(doc.world.size).toBe(1);
    expect(store.recipes.map((r) => r.name)).toEqual(['Existing Recipe', 'mix']);
  });

  it('unknown blockId is skipped and processing continues', () => {
    const { doc, store } = setup();
    const data = validProject();
    data.blocks.push([6, 0, 5, 'minecraft:not_a_block']);
    const result = loadProject(data, doc, indexOf, store);
    expect(result.loaded).toBe(1);
    expect(result.skipped).toBe(1);
  });

  const invalidCases: [string, (d: ReturnType<typeof validProject>) => unknown][] = [
    ['app mismatch', (d) => ({ ...d, app: 'other' })],
    ['blocks is not an array', (d) => ({ ...d, blocks: 'x' })],
    ['blocks tuple has wrong length', (d) => ({ ...d, blocks: [[1, 2, 3]] })],
    ['coordinate is a string', (d) => ({ ...d, blocks: [['a', 0, 0, 'minecraft:stone']] })],
    ['coordinate is NaN', (d) => ({ ...d, blocks: [[Number.NaN, 0, 0, 'minecraft:stone']] })],
    ['coordinate is not an integer', (d) => ({ ...d, blocks: [[0.5, 0, 0, 'minecraft:stone']] })],
    ['coordinate is out of range', (d) => ({ ...d, blocks: [[100000, 0, 0, 'minecraft:stone']] })],
    ['y is negative', (d) => ({ ...d, blocks: [[0, -5, 0, 'minecraft:stone']] })],
    ['recipes is not an array', (d) => ({ ...d, recipes: {} })],
    ['recipe has no entries', (d) => ({ ...d, recipes: [{ id: 'r', name: 'x' }] })],
    ['entry weight is negative', (d) => ({ ...d, recipes: [{ id: 'r', name: 'x', entries: [{ blockId: 'minecraft:stone', weight: -1 }] }] })],
    ['entry weight is Infinity', (d) => ({ ...d, recipes: [{ id: 'r', name: 'x', entries: [{ blockId: 'minecraft:stone', weight: Infinity }] }] })],
    // take the upper bound from orientation's own contract (so the test doesn't keep a stale assumption if the width changes)
    ['orientation code is out of range', (d) => ({ ...d, blocks: [[5, 0, 5, 'minecraft:stone_bricks', MAX_ORIENTATION_CODE + 1]] })],
    ['orientation code is not an integer', (d) => ({ ...d, blocks: [[5, 0, 5, 'minecraft:stone_bricks', 1.5]] })],
    ['orientation code is a string', (d) => ({ ...d, blocks: [[5, 0, 5, 'minecraft:stone_bricks', '1']] })],
  ];

  for (const [label, mutate] of invalidCases) {
    it(`invalid data (${label}) throws + existing state is untouched`, () => {
      const { doc, store } = setup();
      expect(() => loadProject(mutate(validProject()), doc, indexOf, store)).toThrow();
      // existing world / recipes must not be touched at all
      expect(doc.world.size).toBe(2);
      expect(store.recipes).toHaveLength(1);
      expect(store.recipes[0]!.name).toBe('Existing Recipe');
    });
  }

  it('serialize → load round-trip (including group membership)', () => {
    const { doc, store } = setup();
    // put only one of the 2 cells into a group, to confirm both "has membership" and "has none" round-trip
    const groupId = doc.nextGroupId();
    doc.insertGroup({ id: groupId, name: 'Existing Group', parentId: null, childIds: [] }, 0);
    doc.setCellMembership('0,0,0', groupId);

    const project = serializeProject('Round Trip', doc, CATALOG, store.recipes);
    const doc2 = new DocumentFixture();
    const store2 = new RecipeStore(null);
    const result = loadProject(project, doc2, indexOf, store2);
    expect(result.loaded).toBe(2);
    expect(doc2.world.size).toBe(2);
    // a recipe not referenced by any painted cell in the project isn't bundled in, so it doesn't get added on the loading side
    expect(store2.recipes).toHaveLength(0);

    const loadedGroupId = doc2.ownerAt(0, 0, 0);
    expect(loadedGroupId).not.toBeNull();
    expect(doc2.tree.getNode(loadedGroupId!)?.name).toBe('Existing Group');
    expect(doc2.ownerAt(1, 0, 0)).toBeNull();
  });

  it('hidden/locked are preserved through the round trip', () => {
    const { doc, store } = setup();
    const groupId = doc.nextGroupId();
    doc.insertGroup({ id: groupId, name: 'Hidden Group', parentId: null, childIds: [] }, 0);
    doc.rawTree.setHidden(groupId, true);
    doc.rawTree.setLocked(groupId, true);
    doc.setCellMembership('0,0,0', groupId);

    const project = serializeProject('Round Trip', doc, CATALOG, store.recipes);
    expect(project.groups[0]).toEqual({ name: 'Hidden Group', parent: -1, hidden: true, locked: true });

    const doc2 = new DocumentFixture();
    loadProject(project, doc2, indexOf, new RecipeStore(null));
    // a hidden group does not show up as winner (WorldIndex excludes hidden), so
    // look it up from the tree side instead of ownerAt
    const loaded = [...doc2.tree.allNodesPreOrder()].find((n) => n.name === 'Hidden Group');
    expect(loaded?.hidden).toBe(true);
    expect(loaded?.locked).toBe(true);
  });

  it('orientation code is preserved through the round trip', () => {
    const doc = new DocumentFixture();
    const stoneIdx = indexOf('minecraft:stone')!;
    doc.setCells([[0, 0, 0, packCell(stoneIdx, 5)]]);
    const project = serializeProject('Orientation', doc, CATALOG, []);
    expect(project.version).toBe(5); // current format that preserves live pattern metadata (variant)
    expect(project.cells[0]).toEqual([-1, 0, 0, 0, 'minecraft:stone', 5]);

    const doc2 = new DocumentFixture();
    loadProject(project, doc2, indexOf, new RecipeStore(null));
    expect(doc2.world.get(0, 0, 0)).toBe(packCell(stoneIdx, 5));
  });

  it('the old format (5th element omitted) loads as orientation code 0', () => {
    const { doc, store } = setup();
    const data = { ...validProject(), blocks: [[9, 0, 9, 'minecraft:stone_bricks']] as [number, number, number, string][] };
    const result = loadProject(data, doc, indexOf, store);
    expect(result.loaded).toBe(1);
    expect(doc.world.get(9, 0, 9)).toBe(packCell(indexOf('minecraft:stone_bricks')!, 0));
  });
});

describe('version 2 (group tree)', () => {
  // 3-level nesting: parent(0) ← child(1) ← grandchild(2). The grandchild group has no cells (remains only via childIds)
  const nestedV2Project = () => ({
    app: 'blocksmith',
    version: 2,
    name: 'Nested',
    groups: [
      { name: 'Parent', parent: -1 },
      { name: 'Child', parent: 0 },
      { name: 'Grandchild', parent: 1 },
    ],
    blocks: [
      [0, 0, 0, 'minecraft:stone_bricks', 0, 0], // directly under the parent group
      [1, 0, 0, 'minecraft:stone_bricks', 0, 1], // child group
      [2, 0, 0, 'minecraft:stone_bricks', 0, -1], // unowned (root)
    ] as [number, number, number, string, number, number][],
    recipes: [] as MixRecipe[],
  });

  it('2-level nested groups load with parent/child relationships and membership intact', () => {
    const { doc, store } = setup();
    const result = loadProject(nestedV2Project(), doc, indexOf, store);
    expect(result.loaded).toBe(3);
    expect(result.skipped).toBe(0);

    const parentGroupId = doc.ownerAt(0, 0, 0);
    const childGroupId = doc.ownerAt(1, 0, 0);
    expect(parentGroupId).not.toBeNull();
    expect(childGroupId).not.toBeNull();
    expect(doc.ownerAt(2, 0, 0)).toBeNull();

    const parentNode = doc.tree.getNode(parentGroupId!);
    const childNode = doc.tree.getNode(childGroupId!);
    expect(parentNode?.name).toBe('Parent');
    expect(parentNode?.parentId).toBeNull();
    expect(parentNode?.hidden).toBe(false); // the old format (hidden/locked omitted) defaults to false (backward compat)
    expect(parentNode?.locked).toBe(false);
    expect(childNode?.name).toBe('Child');
    expect(childNode?.parentId).toBe(parentGroupId);

    expect(doc.tree.childrenOf(null)).toEqual([parentGroupId]);
    expect(doc.tree.childrenOf(parentGroupId)).toEqual([childGroupId]);
    // the grandchild group (index 2, no cells) remains via childIds (not pruned on load)
    expect(doc.tree.childrenOf(childGroupId).length).toBe(1);
  });

  it('loading into a Document that already has groups does not collide on id (nextId numbering is required)', () => {
    const { doc, store } = setup();
    // Pre-create 2 groups (equivalent to Ctrl+G) to advance the nextId counter (consumes g0, g1).
    // Since load replaces the whole Document, these 2 groups themselves disappear after load —
    // what we want to verify here is "does the counter roll back and reuse the freed ids".
    // If the loader implementation turned the file's group index (0,1,2) directly into the
    // id string ("g0"/"g1"/"g2"), the post-load group ids would collide with the pre-consumed g0/g1
    const preId1 = doc.nextGroupId();
    doc.insertGroup({ id: preId1, name: 'Existing1', parentId: null, childIds: [] }, 0);
    const preId2 = doc.nextGroupId();
    doc.insertGroup({ id: preId2, name: 'Existing2', parentId: null, childIds: [] }, 1);
    const preExistingIds = [preId1, preId2];

    loadProject(nestedV2Project(), doc, indexOf, store);

    const loadedIds = [...doc.tree.allNodesPreOrder()].map((n) => n.id);
    expect(loadedIds).toHaveLength(3); // the 2 existing groups disappear on load, leaving only the 3 groups from the file

    // Load now works by "importing an entire scene that was numbered in a separate
    // tree", so the imported id strings can coincidentally match the strings of the vanished
    // existing groups (they're different entities). The invariant we actually want to protect
    // is "nextId() after import doesn't collide with an imported id" —
    // SceneTree.replaceAll advances the numbering counter past the imported ids (reserveId).
    const freshId = doc.nextGroupId();
    expect(loadedIds).not.toContain(freshId);
    expect(preExistingIds).not.toContain(freshId);
  });

  const invalidGroupsCases: [string, (d: ReturnType<typeof nestedV2Project>) => unknown][] = [
    ['groups[i].parent is self-referential', (d) => ({ ...d, groups: d.groups.map((g, i) => (i === 2 ? { ...g, parent: 2 } : g)) })],
    ['groups[i].parent references forward', (d) => ({ ...d, groups: d.groups.map((g, i) => (i === 1 ? { ...g, parent: 2 } : g)) })],
    ['groups[i].parent is not an integer', (d) => ({ ...d, groups: d.groups.map((g, i) => (i === 1 ? { ...g, parent: 0.5 } : g)) })],
    ['groups[i].name is missing', (d) => ({ ...d, groups: d.groups.map((g, i) => (i === 1 ? { parent: g.parent } : g)) })],
    ['groups is not an array', (d) => ({ ...d, groups: {} })],
    ['groups[i].hidden is not a boolean', (d) => ({ ...d, groups: d.groups.map((g, i) => (i === 0 ? { ...g, hidden: 'yes' } : g)) })],
    ['groups[i].locked is not a boolean', (d) => ({ ...d, groups: d.groups.map((g, i) => (i === 0 ? { ...g, locked: 1 } : g)) })],
    ['blocks groupIndex is >= groups.length', (d) => ({ ...d, blocks: [[9, 0, 9, 'minecraft:stone_bricks', 0, 3]] })],
    ['blocks groupIndex is -2 (out of range)', (d) => ({ ...d, blocks: [[9, 0, 9, 'minecraft:stone_bricks', 0, -2]] })],
    [
      'blocks has the same coordinate appearing multiple times under different groups',
      (d) => ({ ...d, blocks: [...d.blocks, [0, 0, 0, 'minecraft:stone_bricks', 0, 1]] }), // (0,0,0) has already appeared under index0 (the parent group)
    ],
  ];

  for (const [label, mutate] of invalidGroupsCases) {
    it(`invalid v2 data (${label}) throws + existing state is untouched`, () => {
      const { doc, store } = setup();
      expect(() => loadProject(mutate(nestedV2Project()), doc, indexOf, store)).toThrow();
      // existing world / recipes / tree must not be touched at all (not even one group gets created)
      expect(doc.world.size).toBe(2);
      expect(store.recipes).toHaveLength(1);
      expect(store.recipes[0]!.name).toBe('Existing Recipe');
      expect([...doc.tree.allNodesPreOrder()]).toHaveLength(0);
    });
  }

  it('a v2 file with an empty groups array loads everything as root, same as v1', () => {
    const { doc, store } = setup();
    const data = {
      app: 'blocksmith',
      version: 2,
      name: 'Flat',
      groups: [] as { name: string; parent: number }[],
      blocks: [[9, 0, 9, 'minecraft:stone_bricks', 0, -1]] as [number, number, number, string, number, number][],
      recipes: [] as MixRecipe[],
    };
    const result = loadProject(data, doc, indexOf, store);
    expect(result.loaded).toBe(1);
    expect(doc.ownerAt(9, 0, 9)).toBeNull();
    expect([...doc.tree.allNodesPreOrder()]).toHaveLength(0); // zero wasted nextId() calls too
  });

  it('a cell with unknown blockId is skipped in v2 too, and its groupIndex is discarded along with it (no orphan membership)', () => {
    const { doc, store } = setup();
    const data = nestedV2Project();
    data.blocks.push([9, 0, 9, 'minecraft:not_a_block', 0, 0]); // unknown block claiming membership in the parent group
    const result = loadProject(data, doc, indexOf, store);
    expect(result.loaded).toBe(3);
    expect(result.skipped).toBe(1);
    // since the unknown block's coordinate doesn't exist in world, it shouldn't show up in membership either
    expect(doc.ownerAt(9, 0, 9)).toBeNull();
    expect(doc.world.get(9, 0, 9)).toBeNull();
  });
});
