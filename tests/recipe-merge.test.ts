import { describe, expect, it } from 'vitest';
import { Document } from '../src/core/document';
import { buildIndexOf, planRecipeMerge, RecipeStore, type MixRecipe } from '../src/core/mixpalette';
import { packCell } from '../src/core/orientation';
import { OwnerVoxelStore } from '../src/core/ownervoxels';
import { PatternPaintStore } from '../src/core/patternpaint';
import { SceneTree } from '../src/core/scenetree';
import { makeCellKey } from '../src/core/types';
import { CATALOG } from '../src/data/blocks';
import { loadProject, serializeProjectV5 } from '../src/project/persistence';

const indexOf = buildIndexOf(CATALOG);
const STONE = CATALOG[0]!.id;
const COBBLE = CATALOG[1]!.id;

const recipe = (id: string, name: string, blockId: string): MixRecipe => ({
  id,
  name,
  entries: [{ blockId, weight: 1 }],
});

/**
 * Recipes belong to the user, not the project file (#69, earlier stage).
 *
 * This test guards against "my recipes vanished after opening someone else's project."
 * Simply appending isn't enough because **cells reference a recipe by id** — when an
 * incoming recipe shares an id but has different contents, overwriting the existing one
 * breaks the user's recipe, while discarding the incoming one changes how the loaded
 * project looks. The only option is to give it a new id and re-point the reference.
 */
describe('recipe merge planning', () => {
  it('adds an id that does not exist in the existing set as-is', () => {
    const plan = planRecipeMerge([recipe('r1', 'Existing', STONE)], [recipe('r2', 'Imported', COBBLE)]);
    expect(plan.additions.map((r) => r.id)).toEqual(['r2']);
    expect(plan.remap.size).toBe(0);
  });

  it('does not add when the id and contents are identical (reopening the same project)', () => {
    const plan = planRecipeMerge([recipe('r1', 'Stone', STONE)], [recipe('r1', 'Stone', STONE)]);
    expect(plan.additions).toHaveLength(0);
    expect(plan.remap.size).toBe(0);
  });

  it('adds under a new id and records the remap when the id matches but contents differ', () => {
    const existing = [recipe('r1', 'Stone', STONE)];
    const plan = planRecipeMerge(existing, [recipe('r1', 'Cobblestone', COBBLE)]);

    expect(plan.additions).toHaveLength(1);
    const added = plan.additions[0]!;
    expect(added.id).not.toBe('r1');
    expect(added.name).toBe('Cobblestone');
    expect(plan.remap.get('r1')).toBe(added.id);
    // the existing side passes through untouched (the plan doesn't mutate the existing array)
    expect(existing[0]!.name).toBe('Stone');
  });

  it('reading a conflicting project twice does not duplicate the same recipe (#126 review P1)', () => {
    const own = recipe('r1', 'Stone', STONE);
    const incoming = recipe('r1', 'Cobblestone', COBBLE);

    const first = planRecipeMerge([own], [incoming]);
    const second = planRecipeMerge([own, ...first.additions], [incoming]);

    expect(second.additions).toEqual([]);
    expect(second.remap.get('r1')).toBe(first.additions[0]!.id);
  });

  it('a single addition is enough even if the conflict appears twice within the same file', () => {
    // even if the file is malformed and has the same id twice, it doesn't multiply
    const plan = planRecipeMerge([recipe('r1', 'Stone', STONE)], [recipe('r1', 'Cobblestone', COBBLE), recipe('r1', 'Cobblestone', COBBLE)]);
    expect(plan.additions).toHaveLength(1);
    expect(plan.remap.get('r1')).toBe(plan.additions[0]!.id);
  });

  it('merges into an existing entry with identical contents even when the id does not collide', () => {
    const plan = planRecipeMerge([recipe('r1', 'Stone', STONE)], [recipe('r2', 'Stone', STONE)]);
    expect(plan.additions).toEqual([]);
    expect(plan.remap.get('r2')).toBe('r1');
  });

  it('the plan does not mutate the input arrays', () => {
    const incoming = [recipe('r1', 'Cobblestone', COBBLE)];
    planRecipeMerge([recipe('r1', 'Stone', STONE)], incoming);
    expect(incoming[0]!.id).toBe('r1');
  });

  it('applyMerge appends after the existing entries', () => {
    const store = new RecipeStore(null);
    store.create('My Recipe');
    const plan = planRecipeMerge(store.recipes, [recipe('r9', 'Imported', COBBLE)]);
    store.applyMerge(plan);
    expect(store.recipes.map((r) => r.name)).toEqual(['My Recipe', 'Imported']);
  });
});

function sceneWithPattern(recipeId: string) {
  const cells = new OwnerVoxelStore();
  const patterns = new PatternPaintStore();
  const raw = packCell(0, 0);
  cells.set(null, makeCellKey(0, 0, 0), raw);
  patterns.write(null, makeCellKey(0, 0, 0), { recipeId, variant: 0, sourceRaw: raw, appliedRaw: raw });
  return { tree: new SceneTree(), cells, patterns };
}

function emptyDoc(): Document {
  return new Document(
    { tree: new SceneTree(), cells: new OwnerVoxelStore(), patterns: new PatternPaintStore() },
    () => 'full',
  );
}

function sceneWithoutPattern() {
  const cells = new OwnerVoxelStore();
  cells.set(null, makeCellKey(0, 0, 0), packCell(0, 0));
  return { tree: new SceneTree(), cells, patterns: new PatternPaintStore() };
}

/**
 * Keeping recipes on the account side risks the export turning into "an export of
 * the account's entire recipe library" (#126 review P1, round 2). A project should
 * only include **the recipes it actually references**.
 */
describe('recipes included when exporting a project', () => {
  it("a project that doesn't use any pattern excludes recipes even if the account has them", () => {
    const file = serializeProjectV5('Project', sceneWithoutPattern(), CATALOG, [recipe('r1', 'Unused', STONE)]);
    expect(file.recipes).toEqual([]);
  });

  it('when in-use and unused recipes are mixed, only the in-use ones are included', () => {
    const file = serializeProjectV5('Project', sceneWithPattern('r1'), CATALOG, [
      recipe('r1', 'In Use', STONE),
      recipe('r2', 'Unused', COBBLE),
    ]);
    expect(file.recipes.map((r) => r.id)).toEqual(['r1']);
  });

  it('a bundled recipe can restore the paint even when opened under a different account', () => {
    const file = serializeProjectV5('Project', sceneWithPattern('r1'), CATALOG, [
      recipe('r1', 'In Use', STONE),
      recipe('r2', 'Unused', COBBLE),
    ]);
    const other = new RecipeStore(null);
    other.create('Their Recipe');
    const doc = emptyDoc();

    loadProject(file, doc, indexOf, other);

    // the unused recipe doesn't leak in
    expect(other.recipes.map((r) => r.name)).toEqual(['Their Recipe', 'In Use']);
    // the paint is restored still pointing at the bundled recipe
    const painted = [...doc.scene.patterns!.allEntries()];
    expect(painted).toHaveLength(1);
    expect(other.recipes.some((r) => r.id === painted[0]![2].recipeId)).toBe(true);
  });
});

describe('loading a project and its recipes', () => {
  it("my own recipes aren't lost, and the file's recipes get added", () => {
    const store = new RecipeStore(null);
    store.create('My Recipe');
    const file = serializeProjectV5('Project', sceneWithPattern('r1'), CATALOG, [recipe('r1', 'Stone', STONE)]);

    loadProject(file, emptyDoc(), indexOf, store);

    expect(store.recipes.map((r) => r.name)).toEqual(['My Recipe', 'Stone']);
  });

  it('on id collision, adds under a new id and re-points the cell reference', () => {
    const store = new RecipeStore(null);
    store.applyMerge(planRecipeMerge([], [recipe('r1', 'My Stone', STONE)]));
    const file = serializeProjectV5('Project', sceneWithPattern('r1'), CATALOG, [recipe('r1', "Someone Else's Cobblestone", COBBLE)]);
    const doc = emptyDoc();

    loadProject(file, doc, indexOf, store);

    // the user's recipe stays as-is, the file's recipe coexists under a different id
    expect(store.recipes.map((r) => r.name)).toEqual(['My Stone', "Someone Else's Cobblestone"]);
    const added = store.recipes[1]!;
    expect(added.id).not.toBe('r1');

    // the cell points at the id after re-pointing (a swapped target changes what's shown)
    const painted = [...doc.scene.patterns!.allEntries()];
    expect(painted).toHaveLength(1);
    expect(painted[0]![2].recipeId).toBe(added.id);
  });

  it('loading the same project twice does not duplicate recipes', () => {
    const store = new RecipeStore(null);
    const file = serializeProjectV5('Project', sceneWithPattern('r1'), CATALOG, [recipe('r1', 'Stone', STONE)]);

    loadProject(file, emptyDoc(), indexOf, store);
    loadProject(file, emptyDoc(), indexOf, store);

    expect(store.recipes.map((r) => r.name)).toEqual(['Stone']);
  });

  it('loading a colliding project twice does not duplicate, and the cell reference keeps pointing at the same target (#126 review P1)', () => {
    const store = new RecipeStore(null);
    store.applyMerge(planRecipeMerge([], [recipe('r1', 'My Stone', STONE)]));
    const file = serializeProjectV5('Project', sceneWithPattern('r1'), CATALOG, [recipe('r1', "Someone Else's Cobblestone", COBBLE)]);

    const firstDoc = emptyDoc();
    loadProject(file, firstDoc, indexOf, store);
    const secondDoc = emptyDoc();
    loadProject(file, secondDoc, indexOf, store);

    expect(store.recipes.map((r) => r.name)).toEqual(['My Stone', "Someone Else's Cobblestone"]);
    const added = store.recipes[1]!;
    const refOf = (doc: Document) => [...doc.scene.patterns!.allEntries()][0]![2].recipeId;
    expect(refOf(firstDoc)).toBe(added.id);
    expect(refOf(secondDoc)).toBe(added.id);
  });
});
