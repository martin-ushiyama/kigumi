import { describe, expect, it } from 'vitest';
import {
  ComponentStore,
  planComponentMerge,
  sameComponent,
  type ComponentTemplate,
} from '../src/core/component';
import { Document } from '../src/core/document';
import { packCell, unpackCell } from '../src/core/orientation';
import { OwnerVoxelStore } from '../src/core/ownervoxels';
import { patternSampleAt, PatternPaintStore } from '../src/core/patternpaint';
import { SceneTree } from '../src/core/scenetree';
import { COORD_LIMIT } from '../src/core/limits';
import { makeCellKey, type CellKey } from '../src/core/types';
import {
  buildCreateComponent,
  buildDetachInstance,
  buildDetachInstancesOf,
  beginComponentEdit,
  endComponentEdit,
  buildPlaceComponent,
  buildSyncInstancesOf,
  componentMinCorner,
  componentWorldCells,
  isCreateComponentError,
} from '../src/editor/componentops';
import { buildIndexOf, RecipeStore } from '../src/core/mixpalette';
import {
  loadProject,
  serializeComponentTemplate,
  serializeProject,
  validateComponents,
} from '../src/project/persistence';
import { CATALOG } from '../src/data/blocks';
import { normalizeSelection } from '../src/editor/selection';


const RAW = packCell(0, 0);
const indexOf = buildIndexOf(CATALOG);

/** Build a branded NormalizedSelection from a test */
function groupsSel(doc: Document, ...ids: string[]) {
  return normalizeSelection(doc.tree, { kind: 'groups', ids });
}

function newDoc(): Document {
  return new Document(
    { tree: new SceneTree(), cells: new OwnerVoxelStore(), patterns: new PatternPaintStore() },
    () => 'full',
  );
}

/** Equivalent of "pillar": 1 group + 3 vertically stacked cells */
function docWithPillar(): { doc: Document; groupId: string } {
  const doc = newDoc();
  const groupId = doc.nextGroupId();
  doc.applyTransaction({
    ops: [
      { kind: 'createGroup', node: { id: groupId, name: 'pillar', parentId: null, childIds: [] }, index: 0 },
      { kind: 'voxel', owner: groupId, key: makeCellKey(0, 0, 0), before: null, after: RAW },
      { kind: 'voxel', owner: groupId, key: makeCellKey(0, 1, 0), before: null, after: RAW },
      { kind: 'voxel', owner: groupId, key: makeCellKey(0, 2, 0), before: null, after: RAW },
    ],
  });
  return { doc, groupId };
}

const template = (id: string, name: string): ComponentTemplate => ({
  id,
  name,
  nodes: [{ name, parent: null }],
  cells: [[0, makeCellKey(0, 0, 0), RAW]],
  patterns: [],
});

describe('Component list (account-side)', () => {
  it('can look up by the id it was registered with', () => {
    const store = new ComponentStore(null);
    const id = store.nextId();
    store.add(template(id, 'window'));
    expect(store.get(id)?.name).toBe('window');
  });

  it('nextId does not collide with existing ids', () => {
    const store = new ComponentStore(null);
    const first = store.nextId();
    store.add(template(first, 'window'));
    expect(store.nextId()).not.toBe(first);
  });

  it('registering clones the contents (caller-side changes do not leak in)', () => {
    const store = new ComponentStore(null);
    const source = template(store.nextId(), 'window');
    store.add(source);
    source.nodes[0]!.name = 'overwritten';
    expect(store.get(source.id)?.nodes[0]!.name).toBe('window');
  });

  it('cannot be looked up after removal', () => {
    const store = new ComponentStore(null);
    const id = store.nextId();
    store.add(template(id, 'window'));
    store.remove(id);
    expect(store.get(id)).toBeUndefined();
  });
});

describe('Component merging (same rule as recipe mixing)', () => {
  it('merges without adding when contents are identical', () => {
    const own = template('c1', 'window');
    const incoming = template('c2', 'window');
    const plan = planComponentMerge([own], [incoming]);
    expect(plan.additions).toEqual([]);
    expect(plan.remap.get('c2')).toBe('c1');
  });

  it('adds under a new id when the id matches but contents differ', () => {
    const plan = planComponentMerge([template('c1', 'window')], [template('c1', 'door')]);
    expect(plan.additions).toHaveLength(1);
    expect(plan.additions[0]!.id).not.toBe('c1');
    expect(plan.remap.get('c1')).toBe(plan.additions[0]!.id);
  });

  it('reading a colliding work twice does not add duplicates', () => {
    const own = template('c1', 'window');
    const incoming = template('c1', 'door');
    const first = planComponentMerge([own], [incoming]);
    const second = planComponentMerge([own, ...first.additions], [incoming]);
    expect(second.additions).toEqual([]);
    expect(second.remap.get('c1')).toBe(first.additions[0]!.id);
  });

  it('treats components as different if even one cell differs', () => {
    const a = template('c1', 'window');
    const b: ComponentTemplate = { ...template('c1', 'window'), cells: [[0, makeCellKey(9, 9, 9), RAW]] };
    expect(sameComponent(a, b)).toBe(false);
  });
});

describe('Turning a group into a component', () => {
  it('extracts the subtree, and the original group becomes an instance', () => {
    const { doc, groupId } = docWithPillar();
    const result = buildCreateComponent(doc, groupsSel(doc, groupId), 'c1');
    if (isCreateComponentError(result)) throw new Error(`failed: ${JSON.stringify(result)}`);

    expect(result.template.name).toBe('pillar');
    expect(result.template.nodes).toHaveLength(1);
    expect(result.template.cells).toHaveLength(3);

    doc.applyTransaction(result.tx);
    expect(doc.tree.getNode(groupId)?.templateId).toBe('c1');
  });

  it('undo removes the instance mark', () => {
    const { doc, groupId } = docWithPillar();
    const result = buildCreateComponent(doc, groupsSel(doc, groupId), 'c1');
    if (isCreateComponentError(result)) throw new Error('failed');
    doc.applyTransaction(result.tx);
    doc.undo();
    expect(doc.tree.getNode(groupId)?.templateId).toBeUndefined();
    doc.redo();
    expect(doc.tree.getNode(groupId)?.templateId).toBe('c1');
  });

  it('rejects a group that is already an instance', () => {
    const { doc, groupId } = docWithPillar();
    const first = buildCreateComponent(doc, groupsSel(doc, groupId), 'c1');
    if (isCreateComponentError(first)) throw new Error('failed');
    doc.applyTransaction(first.tx);

    const second = buildCreateComponent(doc, groupsSel(doc, groupId), 'c2');
    expect(second).toEqual({ error: 'componentAlreadyInstance' });
  });

  it('rejects a group with no blocks', () => {
    const doc = newDoc();
    const groupId = doc.nextGroupId();
    doc.applyTransaction({
      ops: [{ kind: 'createGroup', node: { id: groupId, name: 'empty', parentId: null, childIds: [] }, index: 0 }],
    });
    expect(buildCreateComponent(doc, groupsSel(doc, groupId), 'c1')).toEqual({ error: 'componentEmpty' });
  });

  it('rejects when a descendant is an instance (nesting is out of initial scope)', () => {
    const store = new ComponentStore(null);
    const doc = new Document(
      { tree: new SceneTree(), cells: new OwnerVoxelStore(), patterns: new PatternPaintStore() },
      () => 'full',
      undefined,
      store,
    );
    // place one instance under the parent group
    const parentId = doc.nextGroupId();
    doc.applyTransaction({
      ops: [
        { kind: 'createGroup', node: { id: parentId, name: 'parent', parentId: null, childIds: [] }, index: 0 },
        { kind: 'voxel', owner: parentId, key: makeCellKey(9, 0, 9), before: null, after: RAW },
      ],
    });
    const tpl = template('c1', 'pillar');
    store.add(tpl);
    const placedResult = buildPlaceComponent(doc, tpl, [0, 0, 0]);
    if ('error' in placedResult) throw new Error('failed');
    doc.applyTransaction(placedResult.tx);
    const instanceId = (placedResult.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;
    doc.applyTransaction({
      ops: [{ kind: 'reparentGroup', id: instanceId, beforeParent: null, beforeIndex: 1, afterParent: parentId, afterIndex: 0 }],
    });
    expect(doc.templateIdOf(instanceId), 'precondition: child is an instance').toBe('c1');

    const result = buildCreateComponent(doc, groupsSel(doc, parentId), 'c2');

    expect(result).toEqual({ error: 'componentNestedInstance' });
    expect(doc.templateIdOf(instanceId), 'does not drop the mark (does not detach on its own)').toBe('c1');
  });

  it('can extract when the descendant mark is dead (nothing to lose since it is just a group)', () => {
    const store = new ComponentStore(null);
    const doc = new Document(
      { tree: new SceneTree(), cells: new OwnerVoxelStore(), patterns: new PatternPaintStore() },
      () => 'full',
      undefined,
      store,
    );
    const parentId = doc.nextGroupId();
    doc.applyTransaction({
      ops: [
        { kind: 'createGroup', node: { id: parentId, name: 'parent', parentId: null, childIds: [] }, index: 0 },
        { kind: 'voxel', owner: parentId, key: makeCellKey(9, 0, 9), before: null, after: RAW },
      ],
    });
    const tpl = template('c1', 'pillar');
    store.add(tpl);
    const placedResult = buildPlaceComponent(doc, tpl, [0, 0, 0]);
    if ('error' in placedResult) throw new Error('failed');
    doc.applyTransaction(placedResult.tx);
    const instanceId = (placedResult.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;
    doc.applyTransaction({
      ops: [{ kind: 'reparentGroup', id: instanceId, beforeParent: null, beforeIndex: 1, afterParent: parentId, afterIndex: 0 }],
    });
    store.remove('c1'); // the mark remains but there is no content

    const result = buildCreateComponent(doc, groupsSel(doc, parentId), 'c2');

    expect(isCreateComponentError(result)).toBe(false);
  });

  it('rejects when 2 groups are selected', () => {
    const { doc, groupId } = docWithPillar();
    const second = doc.nextGroupId();
    doc.applyTransaction({
      ops: [
        { kind: 'createGroup', node: { id: second, name: 'beam', parentId: null, childIds: [] }, index: 1 },
        { kind: 'voxel', owner: second, key: makeCellKey(5, 0, 0), before: null, after: RAW },
      ],
    });
    expect(buildCreateComponent(doc, groupsSel(doc, groupId, second), 'c1')).toEqual({
      error: 'componentNeedsOneGroup',
    });
  });
});

describe('Placing a component', () => {
  function pillarTemplate(): ComponentTemplate {
    const { doc, groupId } = docWithPillar();
    const result = buildCreateComponent(doc, groupsSel(doc, groupId), 'c1');
    if (isCreateComponentError(result)) throw new Error('failed');
    return result.template;
  }

  it('cells are restored along with it, and the root carries the instance mark', () => {
    const doc = newDoc();
    const result = buildPlaceComponent(doc, pillarTemplate(), [0, 0, 0]);
    if ('error' in result) throw new Error(`failed: ${result.error}`);
    doc.applyTransaction(result.tx);

    const rootId = (result.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;
    expect(doc.tree.getNode(rootId)?.templateId).toBe('c1');
    expect([...doc.scene.cells.entriesOf(rootId)]).toHaveLength(3);
  });

  it('is placed at the given position (world coordinates are reflected)', () => {
    const doc = newDoc();
    const result = buildPlaceComponent(doc, pillarTemplate(), [5, 0, 3]);
    if ('error' in result) throw new Error(`failed: ${result.error}`);
    doc.applyTransaction(result.tx);

    const rootId = (result.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;
    // cells stay local, position rides on the root's translate (same design as buildDuplicate)
    expect(doc.tree.getNode(rootId)?.transform?.translate).toEqual([5, 0, 3]);
    expect(doc.index.ownerAtWorld([5, 0, 3])).toBe(rootId);
    expect(doc.index.ownerAtWorld([0, 0, 0])).toBeNull();
  });

  it('changing the placement position places it at a different world coordinate', () => {
    const template = pillarTemplate();
    const first = newDoc();
    const second = newDoc();
    const a = buildPlaceComponent(first, template, [0, 0, 0]);
    const b = buildPlaceComponent(second, template, [10, 0, 0]);
    if ('error' in a || 'error' in b) throw new Error('failed');
    first.applyTransaction(a.tx);
    second.applyTransaction(b.tx);

    expect(first.index.ownerAtWorld([0, 0, 0])).not.toBeNull();
    expect(second.index.ownerAtWorld([10, 0, 0])).not.toBeNull();
    expect(second.index.ownerAtWorld([0, 0, 0])).toBeNull();
  });

  it('the rotation center is determined by the contents (does not jump even when placed far away)', () => {
    const doc = newDoc();
    const result = buildPlaceComponent(doc, pillarTemplate(), [20, 0, 20]);
    if ('error' in result) throw new Error('failed');
    doc.applyTransaction(result.tx);

    const rootId = (result.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;
    // if pivot2 were [0,0] it would rotate around the origin, jumping far away the instant it rotates
    expect(doc.tree.getNode(rootId)?.transform?.pivot2).not.toEqual([0, 0]);
  });

  it('rejects a placement that goes out of range (does not partially place)', () => {
    const doc = newDoc();
    const before = [...doc.scene.cells.allEntries()].length;
    const result = buildPlaceComponent(doc, pillarTemplate(), [10_000_000, 0, 0]);
    expect(result).toEqual({ error: 'outOfRangePlaceComponent' });
    expect([...doc.scene.cells.allEntries()]).toHaveLength(before);
  });

  it('a different placement location gives a different pattern (#69: pattern paint is determined by coordinates)', () => {
    // the pattern is not baked into PatternPaint but derived from world coordinates,
    // so placing the instance elsewhere gives a different pattern
    const atOrigin = patternSampleAt('c1', [0, 0, 0], 0);
    const shifted = patternSampleAt('c1', [5, 0, 3], 0);
    expect(atOrigin).not.toBe(shifted);
  });

  it('the same coordinate always derives the same pattern no matter how many times (does not change on reopening)', () => {
    expect(patternSampleAt('c1', [4, 2, 7], 0)).toBe(patternSampleAt('c1', [4, 2, 7], 0));
  });
});

describe('Appearance of a placed instance', () => {
  it('a painted component is restored along with its paint', () => {
    const { doc, groupId } = docWithPillar();
    const paint = { recipeId: 'r1', variant: 0, sourceRaw: RAW, appliedRaw: RAW };
    doc.applyTransaction({
      ops: [{ kind: 'setPattern', owner: groupId, key: makeCellKey(0, 0, 0), before: null, after: paint }],
    });

    const created = buildCreateComponent(doc, groupsSel(doc, groupId), 'c1');
    if (isCreateComponentError(created)) throw new Error('failed');
    expect(created.template.patterns).toHaveLength(1);

    const target = newDoc();
    const placed = buildPlaceComponent(target, created.template, [0, 0, 0]);
    if ('error' in placed) throw new Error('failed');
    target.applyTransaction(placed.tx);

    const restored = [...target.scene.patterns!.allEntries()];
    expect(restored).toHaveLength(1);
    expect(restored[0]![2].recipeId).toBe('r1');
  });
});

/**
 * Round-tripping through a project file (#69 Step 1).
 *
 * Components, like recipes, are **tied to the account**. The file only
 * contains the ones that project uses, and the opening side's list is not cleared.
 */
describe('Round-tripping through a project file', () => {
  function docWithInstance(templateId = 'c1'): { doc: Document; template: ComponentTemplate } {
    const { doc, groupId } = docWithPillar();
    const created = buildCreateComponent(doc, groupsSel(doc, groupId), templateId);
    if (isCreateComponentError(created)) throw new Error('failed');
    doc.applyTransaction(created.tx);
    return { doc, template: created.template };
  }

  it('only components in use are bundled', () => {
    const { doc, template } = docWithInstance();
    const unused: ComponentTemplate = { ...template, id: 'c99', name: 'unused' };

    const file = serializeProject('project', doc, CATALOG, [], { components: [template, unused] });

    expect(file.components?.map((c) => c.id)).toEqual(['c1']);
  });

  it('is not included in a project that does not use the component', () => {
    const { doc } = docWithPillar();
    const file = serializeProject('project', doc, CATALOG, [], { components: [template('c1', 'unused')] });
    expect(file.components).toBeUndefined();
  });

  it('loading restores it along with the instance mark', () => {
    const { doc, template: tpl } = docWithInstance();
    const file = serializeProject('project', doc, CATALOG, [], { components: [tpl] });

    const target = newDoc();
    const store = new ComponentStore(null);
    loadProject(file, target, indexOf, new RecipeStore(null), store);

    expect(store.templates.map((t) => t.id)).toEqual(['c1']);
    const roots = [...target.tree.allNodesPreOrder()].filter((n) => n.templateId !== undefined);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.templateId).toBe('c1');
  });

  it("the recipient's list is not cleared; on id collision it remaps and adds", () => {
    const { doc, template: tpl } = docWithInstance();
    const file = serializeProject('project', doc, CATALOG, [], { components: [tpl] });

    // the receiving side has a component with the same id but **different contents**
    const store = new ComponentStore(null);
    store.add({ ...template('c1', 'their window'), name: 'their window' });
    const target = newDoc();

    loadProject(file, target, indexOf, new RecipeStore(null), store);

    expect(store.templates.map((t) => t.name)).toEqual(['their window', 'pillar']);
    const added = store.templates[1]!;
    expect(added.id).not.toBe('c1');
    // the group's reference also points to the remapped id
    const instance = [...target.tree.allNodesPreOrder()].find((n) => n.templateId !== undefined);
    expect(instance?.templateId).toBe(added.id);
  });

  it('reading the same project twice does not grow the list', () => {
    const { doc, template: tpl } = docWithInstance();
    const file = serializeProject('project', doc, CATALOG, [], { components: [tpl] });
    const store = new ComponentStore(null);

    loadProject(file, newDoc(), indexOf, new RecipeStore(null), store);
    loadProject(file, newDoc(), indexOf, new RecipeStore(null), store);

    expect(store.templates).toHaveLength(1);
  });

  /**
   * Saving does not depend on the catalog's ordering (#142 review P1).
   *
   * `ComponentTemplate`'s raw value includes its position within the catalog. Writing it
   * as-is means that once blocks are added or the generation order changes, the same file
   * opens as a different block. Align with how the project body's cells already store
   * "block id + orientation" from the start.
   */
  describe('Does not depend on catalog ordering', () => {
    it('writes cells out as block id + orientation (does not keep the position within the catalog)', () => {
      const { doc, template: tpl } = docWithInstance();
      const file = serializeProject('project', doc, CATALOG, [], { components: [tpl] });

      const cell = file.components![0]!.cells[0]!;
      expect(typeof cell[2], 'block id is a string').toBe('string');
      expect(cell[2]).toBe(CATALOG[0]!.id);
      expect(cell[3], 'orientation code').toBe(0);
    });

    it('opens as the same block even if the catalog order changes', () => {
      const { doc, template: tpl } = docWithInstance();
      const file = serializeProject('project', doc, CATALOG, [], { components: [tpl] });

      // a catalog where a different block is inserted at the front, shifting every index by 1
      const shifted = [{ ...CATALOG[1]!, id: 'blocksmith:newcomer' }, ...CATALOG];
      const store = new ComponentStore(null);
      loadProject(file, newDoc(), buildIndexOf(shifted), new RecipeStore(null), store);

      const restored = store.templates[0]!;
      const [, , raw] = restored.cells[0]!;
      expect(unpackCell(raw).catalogIndex, 'reinterpreted as the position in the shifted catalog').toBe(
        buildIndexOf(shifted)(CATALOG[0]!.id),
      );
    });

    it('the list storage also goes through the same shape (localStorage)', () => {
      const { template: tpl } = docWithInstance();
      const memory = new Map<string, string>();
      const storage = {
        getItem: (k: string) => memory.get(k) ?? null,
        setItem: (k: string, v: string) => void memory.set(k, v),
      };
      const codec = {
        encode: (t: ComponentTemplate) => serializeComponentTemplate(t, CATALOG),
        decode: (raw: unknown) => validateComponents([raw], indexOf)[0] ?? null,
      };
      new ComponentStore(storage, codec).add(tpl);

      const written = JSON.stringify([...memory.values()]);
      expect(written, 'does not write the raw value').toContain(CATALOG[0]!.id);

      // even reading back with a shifted catalog, it still points to the same block
      const shifted = [{ ...CATALOG[1]!, id: 'blocksmith:newcomer' }, ...CATALOG];
      const shiftedIndexOf = buildIndexOf(shifted);
      const reopened = new ComponentStore(storage, {
        encode: codec.encode,
        decode: (raw: unknown) => validateComponents([raw], shiftedIndexOf)[0] ?? null,
      });
      const [, , raw] = reopened.templates[0]!.cells[0]!;
      expect(unpackCell(raw).catalogIndex).toBe(shiftedIndexOf(CATALOG[0]!.id));
    });

    it('a saved list is read back as-is on startup', () => {
      const { template: tpl } = docWithInstance();
      const memory = new Map<string, string>();
      const storage = {
        getItem: (k: string) => memory.get(k) ?? null,
        setItem: (k: string, v: string) => void memory.set(k, v),
      };
      const codec = {
        encode: (t: ComponentTemplate) => serializeComponentTemplate(t, CATALOG),
        decode: (raw: unknown) => validateComponents([raw], indexOf)[0] ?? null,
      };
      new ComponentStore(storage, codec).add(tpl);

      const reopened = new ComponentStore(storage, codec);

      expect(reopened.templates.map((t) => t.id), 'does not drop a single entry').toEqual([tpl.id]);
      expect(reopened.templates[0]!.cells).toHaveLength(tpl.cells.length);
    });

    it('opens with cells for blocks absent from the catalog dropped (same as the project body)', () => {
      const { doc, template: tpl } = docWithInstance();
      const file = serializeProject('project', doc, CATALOG, [], { components: [tpl] });
      const cellCount = file.components![0]!.cells.length;
      file.components![0]!.cells[0]![2] = 'blocksmith:unknown-block';

      const store = new ComponentStore(null);
      loadProject(file, newDoc(), indexOf, new RecipeStore(null), store);

      expect(store.templates[0]!.cells).toHaveLength(cellCount - 1);
    });
  });

  /**
   * Saved data comes from outside. **If it is broken, fail the whole load** (#142 review P1).
   *
   * Letting this slip through with a type assertion means a broken template reaches the
   * list and the Document, then crashes partway through rendering/placement. The farther
   * the crash site is from the entry point, the harder it is to diagnose.
   */
  describe('Does not accept a broken component', () => {
    function fileWith(broken: unknown): Record<string, unknown> {
      const { doc, template: tpl } = docWithInstance();
      const file = serializeProject('project', doc, CATALOG, [], { components: [tpl] });
      return { ...file, components: [{ ...file.components![0]!, ...(broken as object) }] };
    }

    const load = (file: unknown) => loadProject(file, newDoc(), indexOf, new RecipeStore(null), new ComponentStore(null));

    it.each([
      ['cells is not a tuple', { cells: [[0, makeCellKey(0, 0, 0)]] }],
      ['cells nodeIndex is out of range', { cells: [[99, makeCellKey(0, 0, 0), RAW]] }],
      ['cells key is not canonical', { cells: [[0, 'not-a-cell-key', RAW]] }],
      ['cells key has an extra component', { cells: [[0, '0,0,0,extra', RAW]] }],
      ['cells raw value is not an integer', { cells: [[0, makeCellKey(0, 0, 0), 1.5]] }],
      ['cells raw value is negative', { cells: [[0, makeCellKey(0, 0, 0), -1]] }],
      ['nodes hidden is not a boolean', { nodes: [{ name: 'pillar', parent: null, hidden: 'yes' }] }],
      ['nodes locked is not a boolean', { nodes: [{ name: 'pillar', parent: null, locked: 1 }] }],
      ['nodes transform is broken', { nodes: [{ name: 'pillar', parent: null, transform: { angleSteps: 1 } }] }],
      ['nodes parent points after itself', { nodes: [{ name: 'pillar', parent: 1 }, { name: 'child', parent: null }] }],
      ['patterns is not a tuple', { patterns: [[0, makeCellKey(0, 0, 0)]] }],
      ['patterns nodeIndex is out of range', { patterns: [[3, makeCellKey(0, 0, 0), { recipeId: 'r1', variant: 0, sourceRaw: RAW, appliedRaw: RAW }]] }],
      ['patterns variant is out of range', { patterns: [[0, makeCellKey(0, 0, 0), { recipeId: 'r1', variant: 999, sourceRaw: RAW, appliedRaw: RAW }]] }],
      ['patterns contents are not paint', { patterns: [[0, makeCellKey(0, 0, 0), { recipeId: 1 }]] }],
    ])('%s → load fails', (_name, broken) => {
      expect(() => load(fileWith(broken))).toThrow();
    });

    it('a broken template does not reach either the list or the Document', () => {
      const store = new ComponentStore(null);
      const target = newDoc();
      expect(() =>
        loadProject(fileWith({ cells: [[0, 'not-a-cell-key', RAW]] }), target, indexOf, new RecipeStore(null), store),
      ).toThrow();
      expect(store.templates).toEqual([]);
      expect([...target.tree.allNodesPreOrder()]).toEqual([]);
    });
  });

  it('loading without passing a list does not break (caller without component support)', () => {
    const { doc, template: tpl } = docWithInstance();
    const file = serializeProject('project', doc, CATALOG, [], { components: [tpl] });
    const target = newDoc();

    expect(() => loadProject(file, target, indexOf, new RecipeStore(null))).not.toThrow();
    // the mark remains (the list just has no contents)
    const instance = [...target.tree.allNodesPreOrder()].find((n) => n.templateId !== undefined);
    expect(instance?.templateId).toBe('c1');
  });
});

/**
 * Propagating component edits to instances (#69 Step 2).
 *
 * The contract is **sync wins**, so any direct edits made on an instance are wiped out
 * here. To change one individually, detach it first (`buildDetachInstance`).
 */
describe('Component edits propagate to instances (#69 Step 2)', () => {
  /** State with the pillar component placed in 2 locations */
  function docWithTwoInstances() {
    const { doc: source, groupId } = docWithPillar();
    const created = buildCreateComponent(source, groupsSel(source, groupId), 'c1');
    if (isCreateComponentError(created)) throw new Error('failed');
    const template = created.template;

    const doc = newDoc();
    const ids: string[] = [];
    for (const origin of [[0, 0, 0], [10, 0, 0]] as [number, number, number][]) {
      const placed = buildPlaceComponent(doc, template, origin);
      if ('error' in placed) throw new Error(`failed: ${placed.error}`);
      doc.applyTransaction(placed.tx);
      ids.push((placed.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!);
    }
    return { doc, template, ids };
  }

  /** Pillar of height 3 stretched to 5 as a component */
  const taller = (template: ComponentTemplate): ComponentTemplate => ({
    ...template,
    cells: [...template.cells, [0, makeCellKey(0, 3, 0), RAW], [0, makeCellKey(0, 4, 0), RAW]],
  });

  it('stretching the component stretches every placed instance', () => {
    const { doc, template, ids } = docWithTwoInstances();
    const result = buildSyncInstancesOf(doc, taller(template));
    if ('error' in result) throw new Error(`failed: ${result.error}`);
    doc.applyTransaction(result.tx);

    for (const id of ids) expect([...doc.scene.cells.entriesOf(id)]).toHaveLength(5);
    // the placement position does not move
    expect(doc.index.ownerAtWorld([0, 4, 0])).toBe(ids[0]);
    expect(doc.index.ownerAtWorld([10, 4, 0])).toBe(ids[1]);
  });

  it('placement position, name, and instance mark are retained', () => {
    const { doc, template, ids } = docWithTwoInstances();
    doc.applyTransaction({ ops: [{ kind: 'renameGroup', id: ids[1]!, before: 'pillar', after: 'west pillar' }] });
    const result = buildSyncInstancesOf(doc, taller(template));
    if ('error' in result) throw new Error('failed');
    doc.applyTransaction(result.tx);

    const node = doc.tree.getNode(ids[1]!)!;
    expect(node.transform?.translate).toEqual([10, 0, 0]);
    expect(node.name, 'does not erase the name given after placement').toBe('west pillar');
    expect(node.templateId).toBe('c1');
  });

  it('since it is 1 transaction, undo brings everything back together', () => {
    const { doc, template, ids } = docWithTwoInstances();
    const result = buildSyncInstancesOf(doc, taller(template));
    if ('error' in result) throw new Error('failed');
    doc.applyTransaction(result.tx);
    doc.undo();

    for (const id of ids) expect([...doc.scene.cells.entriesOf(id)], 'both back to the original height').toHaveLength(3);
  });

  it('direct edits made on an instance are wiped out by the sync (sync wins)', () => {
    const { doc, template, ids } = docWithTwoInstances();
    doc.applyTransaction({
      ops: [{ kind: 'voxel', owner: ids[0]!, key: makeCellKey(1, 0, 0), before: null, after: RAW }],
    });
    expect([...doc.scene.cells.entriesOf(ids[0]!)]).toHaveLength(4);

    const result = buildSyncInstancesOf(doc, template);
    if ('error' in result) throw new Error('failed');
    doc.applyTransaction(result.tx);
    expect([...doc.scene.cells.entriesOf(ids[0]!)], "reverts to the component's shape").toHaveLength(3);
  });

  /**
   * Checking only with flat components puts **rebuilding child groups outside the
   * observed range** (an implementation that only touches the root's cells would still pass)
   */
  it('a component with a child group is also rebuilt wholesale', () => {
    const source = newDoc();
    const rootId = source.nextGroupId();
    const childId = source.nextGroupId();
    source.applyTransaction({
      ops: [
        { kind: 'createGroup', node: { id: rootId, name: 'gate', parentId: null, childIds: [] }, index: 0 },
        { kind: 'createGroup', node: { id: childId, name: 'door', parentId: rootId, childIds: [] }, index: 0 },
        { kind: 'voxel', owner: rootId, key: makeCellKey(0, 0, 0), before: null, after: RAW },
        { kind: 'voxel', owner: childId, key: makeCellKey(1, 0, 0), before: null, after: RAW },
      ],
    });
    const created = buildCreateComponent(source, groupsSel(source, rootId), 'c2');
    if (isCreateComponentError(created)) throw new Error('failed');

    const doc = newDoc();
    const placed = buildPlaceComponent(doc, created.template, [0, 0, 0]);
    if ('error' in placed) throw new Error('failed');
    doc.applyTransaction(placed.tx);
    const instanceId = (placed.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;
    expect(doc.tree.childrenOf(instanceId)).toHaveLength(1);

    // component with the child's contents increased
    const grown: ComponentTemplate = {
      ...created.template,
      cells: [...created.template.cells, [1, makeCellKey(1, 1, 0), RAW]],
    };
    const synced = buildSyncInstancesOf(doc, grown);
    if ('error' in synced) throw new Error(`failed: ${synced.error}`);
    doc.applyTransaction(synced.tx);

    const children = doc.tree.childrenOf(instanceId);
    expect(children, 'the child group stays as one (does not multiply)').toHaveLength(1);
    expect([...doc.scene.cells.entriesOf(children[0]!)], "the child's contents follow along").toHaveLength(2);
  });

  /**
   * The child's `transform` is **part of the shape**. Dropping it during rebuild silently
   * changes the orientation of contents that have rotation (the cell count still matches,
   * so watching only the count would not catch it)
   */
  it("a child group's orientation is also preserved through rebuild", () => {
    const childTransform = { angleSteps: 1 as const, translate: [0, 0, 0] as [number, number, number], pivot2: [0, 0] as [number, number] };
    const withRotatedChild: ComponentTemplate = {
      id: 'c3',
      name: 'rotating gate',
      nodes: [
        { name: 'gate', parent: null },
        { name: 'door', parent: 0, transform: childTransform },
      ],
      cells: [
        [0, makeCellKey(0, 0, 0), RAW],
        [1, makeCellKey(1, 0, 0), RAW],
      ],
      patterns: [],
    };

    const doc = newDoc();
    const placed = buildPlaceComponent(doc, withRotatedChild, [0, 0, 0]);
    if ('error' in placed) throw new Error('failed');
    doc.applyTransaction(placed.tx);
    const instanceId = (placed.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;

    const grown: ComponentTemplate = {
      ...withRotatedChild,
      cells: [...withRotatedChild.cells, [1, makeCellKey(1, 1, 0), RAW]],
    };
    const synced = buildSyncInstancesOf(doc, grown);
    if ('error' in synced) throw new Error(`failed: ${synced.error}`);
    doc.applyTransaction(synced.tx);

    const child = doc.tree.getNode(doc.tree.childrenOf(instanceId)[0]!)!;
    expect(child.transform, "the child's orientation is dropped").toEqual(childTransform);
  });

  it('a component with no instances does nothing (not a failure)', () => {
    const doc = newDoc();
    const result = buildSyncInstancesOf(doc, template('c9', 'nobody has placed one'));
    // there is simply nothing to sync to. Making this an error would mean edits to a
    // component that has not been placed yet could never be finalized (#142 review P1)
    expect('tx' in result && result.tx.ops).toEqual([]);
  });
});

describe('Detaching from a component (#69 Step 2)', () => {
  it('a detached instance no longer follows subsequent edits', () => {
    const { doc: source, groupId } = docWithPillar();
    const created = buildCreateComponent(source, groupsSel(source, groupId), 'c1');
    if (isCreateComponentError(created)) throw new Error('failed');

    const doc = newDoc();
    const ids: string[] = [];
    for (const origin of [[0, 0, 0], [10, 0, 0]] as [number, number, number][]) {
      const placed = buildPlaceComponent(doc, created.template, origin);
      if ('error' in placed) throw new Error('failed');
      doc.applyTransaction(placed.tx);
      ids.push((placed.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!);
    }

    const detached = buildDetachInstance(doc, ids[0]!);
    if ('error' in detached) throw new Error(`failed: ${detached.error}`);
    doc.applyTransaction(detached.tx);
    expect(doc.tree.getNode(ids[0]!)?.templateId ?? null, 'the mark is removed').toBeNull();
    expect([...doc.scene.cells.entriesOf(ids[0]!)], 'the contents stay as-is').toHaveLength(3);

    const taller2: ComponentTemplate = {
      ...created.template,
      cells: [...created.template.cells, [0, makeCellKey(0, 3, 0), RAW]],
    };
    const synced = buildSyncInstancesOf(doc, taller2);
    if ('error' in synced) throw new Error('failed');
    doc.applyTransaction(synced.tx);

    expect([...doc.scene.cells.entriesOf(ids[0]!)], 'the detached one does not stretch').toHaveLength(3);
    expect([...doc.scene.cells.entriesOf(ids[1]!)], 'the remaining one stretches').toHaveLength(4);
  });

  it('a group that is not an instance cannot be detached', () => {
    const { doc, groupId } = docWithPillar();
    const result = buildDetachInstance(doc, groupId);
    expect('error' in result && result.error).toBe('componentNotFound');
  });
});

/**
 * **Placing a component built somewhere else at the clicked location** (#69 reported).
 *
 * Cells are owner-local, but for a group with no transform, local == world.
 * That means turning a group built high up or far away into a component
 * **bakes that position into the cell coordinates**. Adding the click position on top of
 * that when placing it would shift it by that amount.
 */
describe('Not dragged by the location it was built at (#69)', () => {
  /** A 3-cell pillar built at (10, 5, 3) */
  function farPillar() {
    const doc = newDoc();
    const groupId = doc.nextGroupId();
    doc.applyTransaction({
      ops: [
        { kind: 'createGroup', node: { id: groupId, name: 'far pillar', parentId: null, childIds: [] }, index: 0 },
        { kind: 'voxel', owner: groupId, key: makeCellKey(10, 5, 3), before: null, after: RAW },
        { kind: 'voxel', owner: groupId, key: makeCellKey(10, 6, 3), before: null, after: RAW },
        { kind: 'voxel', owner: groupId, key: makeCellKey(10, 7, 3), before: null, after: RAW },
      ],
    });
    const created = buildCreateComponent(doc, groupsSel(doc, groupId), 'c1');
    if (isCreateComponentError(created)) throw new Error('failed');
    return created.template;
  }

  it('appears exactly at the placed location (not shifted by the build location)', () => {
    const doc = newDoc();
    const result = buildPlaceComponent(doc, farPillar(), [0, 0, 0]);
    if ('error' in result) throw new Error(`failed: ${result.error}`);
    doc.applyTransaction(result.tx);

    expect(doc.index.ownerAtWorld([0, 0, 0]), 'the clicked location becomes the min corner').not.toBeNull();
    expect(doc.index.ownerAtWorld([0, 1, 0])).not.toBeNull();
    expect(doc.index.ownerAtWorld([0, 2, 0])).not.toBeNull();
  });

  it('changing the placement position places it there', () => {
    const doc = newDoc();
    const result = buildPlaceComponent(doc, farPillar(), [4, 0, 2]);
    if ('error' in result) throw new Error('failed');
    doc.applyTransaction(result.tx);
    expect(doc.index.ownerAtWorld([4, 0, 2])).not.toBeNull();
  });

  it('the preview of cells that would be filled is also not dragged by the build location', () => {
    const cells = componentWorldCells(farPillar(), [0, 0, 0]);
    expect(cells).toContain(makeCellKey(0, 0, 0));
  });

  /**
   * A component whose child node has a transform (#142 review P1).
   *
   * If the preview and the actual placement compute coordinates separately, **they drift
   * by however much the child was moved**. Verify both read the same projected cell list
   * by cross-checking against the actual placement result.
   */
  describe("The child node's transform also factors into the placement reference", () => {
    /** Root + "a child moved by 10". Only the child side holds a single cell */
    const movedChild = (): ComponentTemplate => ({
      id: 'c-moved',
      name: 'moved child',
      nodes: [
        { name: 'root', parent: null },
        { name: 'child', parent: 0, transform: { angleSteps: 0, translate: [10, 0, 0], pivot2: [0, 0] } },
      ],
      cells: [[1, makeCellKey(0, 0, 0), RAW]],
      patterns: [],
    });

    /** The world cells actually filled by placing it */
    function placedCells(template: ComponentTemplate, origin: [number, number, number]): CellKey[] {
      const doc = newDoc();
      const result = buildPlaceComponent(doc, template, origin);
      if ('error' in result) throw new Error(`failed: ${result.error}`);
      doc.applyTransaction(result.tx);
      return [...doc.index.entries()].map(([x, y, z]) => makeCellKey(x, y, z));
    }

    it('the preview matches the actual placement', () => {
      const origin: [number, number, number] = [5, 0, 5];
      expect([...componentWorldCells(movedChild(), origin)].sort()).toEqual(placedCells(movedChild(), origin).sort());
    });

    it('the clicked location becomes the min corner', () => {
      expect(placedCells(movedChild(), [5, 0, 5])).toEqual([makeCellKey(5, 0, 5)]);
    });

    it('the min corner is measured at the moved destination', () => {
      expect(componentMinCorner(movedChild())).toEqual([10, 0, 0]);
    });
  });
});

/**
 * Range check for sync (#142 review P1).
 *
 * Before rebuilding an instance, we check whether "the placement result would go outside
 * the world", but unless we measure it **in world coordinates by running the projected
 * cells through that instance's effective transform**, we miss child node moves and root
 * rotation. If it slips through, it throws at apply time, and by then the history session
 * has already closed, so the state being edited breaks along with it.
 */
describe('Sync checks range using projected coordinates', () => {
  /** Root + "a child moved by dx". A single cell on the child side */
  const movedChild = (dx: number): ComponentTemplate => ({
    id: 'c1',
    name: 'moved child',
    nodes: [
      { name: 'root', parent: null },
      { name: 'child', parent: 0, transform: { angleSteps: 0, translate: [dx, 0, 0], pivot2: [0, 0] } },
    ],
    cells: [[1, makeCellKey(0, 0, 0), RAW]],
    patterns: [],
  });

  it('refuses before building ops if the destination the child moved to is outside the world', () => {
    const store = new ComponentStore(null);
    const doc = new Document(
      { tree: new SceneTree(), cells: new OwnerVoxelStore(), patterns: new PatternPaintStore() },
      () => 'full',
      undefined,
      store,
    );
    const tpl = movedChild(10);
    store.add(tpl);
    // place at the edge (still within range up to here)
    const placedResult = buildPlaceComponent(doc, tpl, [COORD_LIMIT, 0, 0]);
    if ('error' in placedResult) throw new Error(`could not place: ${placedResult.error}`);
    doc.applyTransaction(placedResult.tx);

    // moving the child by 1 more sends that instance outside the world
    const result = buildSyncInstancesOf(doc, movedChild(11));

    expect(result).toEqual({ error: 'outOfRangePlaceComponent' });
  });

  it('passes when within range', () => {
    const store = new ComponentStore(null);
    const doc = new Document(
      { tree: new SceneTree(), cells: new OwnerVoxelStore(), patterns: new PatternPaintStore() },
      () => 'full',
      undefined,
      store,
    );
    const tpl = movedChild(10);
    store.add(tpl);
    const placedResult = buildPlaceComponent(doc, tpl, [0, 0, 0]);
    if ('error' in placedResult) throw new Error('failed');
    doc.applyTransaction(placedResult.tx);

    const result = buildSyncInstancesOf(doc, movedChild(11));

    expect('tx' in result).toBe(true);
  });
});

/**
 * The mark of a component removed from the list (#142 review P1).
 *
 * The list belongs to the account side and is not part of the project's history (same as
 * recipes). So after removal, undo / redo can sometimes bring back just the `templateId`.
 * **The mark is a weak reference** — if it cannot be resolved, treat it as a plain group.
 * Treating a mark with no contents as an instance would make that group impossible to
 * edit ever again.
 */
describe('The mark of a component removed from the list', () => {
  function docBackedBy(store: ComponentStore): Document {
    return new Document(
      { tree: new SceneTree(), cells: new OwnerVoxelStore(), patterns: new PatternPaintStore() },
      () => 'full',
      undefined,
      store,
    );
  }

  /** A project with one placed instance + its list */
  function placed(): { doc: Document; store: ComponentStore; rootId: string } {
    const store = new ComponentStore(null);
    const tpl = template('c1', 'pillar');
    store.add(tpl);
    const doc = docBackedBy(store);
    const result = buildPlaceComponent(doc, tpl, [0, 0, 0]);
    if ('error' in result) throw new Error('failed');
    doc.applyTransaction(result.tx);
    return { doc, store, rootId: (result.newSelection as { kind: 'groups'; ids: string[] }).ids[0]! };
  }

  it('treated as an instance while it is in the list', () => {
    const { doc, rootId } = placed();
    expect(doc.templateIdOf(rootId)).toBe('c1');
    expect(doc.instanceRootOf(rootId)).toBe(rootId);
  });

  it('even if the mark comes back via undo after removal, treat it as a plain group', () => {
    const { doc, store, rootId } = placed();
    // removing from the list = detach the placed instances (recorded in history)
    const detached = buildDetachInstancesOf(doc, 'c1');
    if (!('tx' in detached)) throw new Error('failed');
    doc.applyTransaction(detached.tx);
    store.remove('c1');

    doc.undo(); // undoing the detach brings the mark back. **But the contents are already gone**

    expect(doc.tree.getNode(rootId)?.templateId, 'the mark itself remains').toBe('c1');
    expect(doc.templateIdOf(rootId), 'not treated as an instance').toBeNull();
    expect(doc.instanceRootOf(rootId), 'the inside can be touched too').toBeNull();
  });

  it('even with a dead mark remaining, it can be turned into a component again', () => {
    const { doc, store, rootId } = placed();
    store.remove('c1');
    // the mark remains (same state as what undo brought back)
    expect(doc.tree.getNode(rootId)?.templateId).toBe('c1');

    const created = buildCreateComponent(doc, groupsSel(doc, rootId), 'c2');
    if (isCreateComponentError(created)) throw new Error(`failed: ${JSON.stringify(created)}`);
    doc.applyTransaction(created.tx);
    store.add(created.template);

    expect(doc.templateIdOf(rootId)).toBe('c2');
  });

  it('re-adding with the same id makes it take effect again', () => {
    const { doc, store, rootId } = placed();
    store.remove('c1');
    expect(doc.templateIdOf(rootId)).toBeNull();
    store.add(template('c1', 'pillar'));
    expect(doc.templateIdOf(rootId)).toBe('c1');
  });
});

/**
 * **The contents of an instance are not editable** (#69 reported).
 *
 * Even if you fix the inside, it gets overwritten the moment the component is edited
 * (sync wins). Allowing it to be touched would create edits that "work but don't stick",
 * so it is excluded at the entry point.
 */
describe('Does not allow touching the inside of an instance (#69)', () => {
  function placedInstance() {
    const { doc: source, groupId } = docWithPillar();
    const created = buildCreateComponent(source, groupsSel(source, groupId), 'c1');
    if (isCreateComponentError(created)) throw new Error('failed');

    const doc = newDoc();
    const placed = buildPlaceComponent(doc, created.template, [0, 0, 0]);
    if ('error' in placed) throw new Error('failed');
    doc.applyTransaction(placed.tx);
    const id = (placed.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;
    return { doc, id };
  }

  it('cells inside an instance cannot be erased', () => {
    const { doc, id } = placedInstance();
    const before = [...doc.scene.cells.entriesOf(id)].length;
    doc.applyEdits([{ kind: 'erase', worldCell: [0, 0, 0] }], null);
    expect([...doc.scene.cells.entriesOf(id)].length).toBe(before);
  });

  it('cells inside an instance cannot be overwritten', () => {
    const { doc, id } = placedInstance();
    const before = doc.scene.cells.get(id, makeCellKey(0, 0, 0));
    doc.applyEdits([{ kind: 'overwrite', worldCell: [0, 0, 0], afterWorldRaw: packCell(1, 0) }], null);
    expect(doc.scene.cells.get(id, makeCellKey(0, 0, 0))).toBe(before);
  });

  /** Once detached it is a normal group so it can be touched (confirming the one-way path) */
  it('can be edited once detached', () => {
    const { doc, id } = placedInstance();
    const detached = buildDetachInstance(doc, id);
    if ('error' in detached) throw new Error('failed');
    doc.applyTransaction(detached.tx);

    const before = [...doc.scene.cells.entriesOf(id)].length;
    doc.applyEdits([{ kind: 'erase', worldCell: [0, 0, 0] }], null);
    expect([...doc.scene.cells.entriesOf(id)].length).toBe(before - 1);
  });
});

/**
 * Component edit mode (#69).
 *
 * Since instance contents are not normally touchable, fixing them needs **a place to
 * bring out the component itself**. Everything else is hidden, only the contents are
 * shown, and on exit the changes are written back and propagated to all instances.
 */
describe('Component edit mode (#69)', () => {
  function docWithInstanceAndOther() {
    const { doc: source, groupId } = docWithPillar();
    const created = buildCreateComponent(source, groupsSel(source, groupId), 'c1');
    if (isCreateComponentError(created)) throw new Error('failed');

    const doc = newDoc();
    // unrelated existing group (should be hidden while editing)
    const otherId = doc.nextGroupId();
    doc.applyTransaction({
      ops: [
        { kind: 'createGroup', node: { id: otherId, name: 'ground', parentId: null, childIds: [] }, index: 0 },
        { kind: 'voxel', owner: otherId, key: makeCellKey(20, 0, 20), before: null, after: RAW },
      ],
    });
    const placed = buildPlaceComponent(doc, created.template, [5, 0, 5]);
    if ('error' in placed) throw new Error('failed');
    doc.applyTransaction(placed.tx);
    const instanceId = (placed.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;
    return { doc, template: created.template, otherId, instanceId };
  }

  /** Enter edit mode. Returns the working group's id and session */
  function enter(doc: Document, template: ComponentTemplate) {
    const entered = beginComponentEdit(doc, template);
    if (!('session' in entered)) throw new Error('failed');
    return { session: entered.session, workingId: entered.session.workingGroupId };
  }

  it('entering hides everything else and shows a touchable working group', () => {
    const { doc, template, otherId, instanceId } = docWithInstanceAndOther();
    const { workingId } = enter(doc, template);

    expect(doc.tree.getNode(otherId)?.hidden, 'the unrelated group is hidden').toBe(true);
    expect(doc.tree.getNode(instanceId)?.hidden, 'the instance is hidden too').toBe(true);
    expect(doc.tree.getNode(workingId)?.templateId ?? null, 'the working group is not an instance').toBeNull();
    expect([...doc.scene.cells.entriesOf(workingId)], "the component's contents appear").toHaveLength(3);
  });

  it('exiting propagates the fixed shape to the placed instances', () => {
    const { doc, template, otherId, instanceId } = docWithInstanceAndOther();
    const { session, workingId } = enter(doc, template);

    // stretch the working group by 1 cell
    doc.applyTransaction({
      ops: [{ kind: 'voxel', owner: workingId, key: makeCellKey(0, 3, 0), before: null, after: RAW }],
    });

    const exited = endComponentEdit(doc, session, template, true);
    if (!('template' in exited)) throw new Error('failed');

    expect(exited.template?.cells, 'the component stretches').toHaveLength(4);
    expect([...doc.scene.cells.entriesOf(instanceId)], 'the instance stretches too').toHaveLength(4);
    expect(doc.tree.getNode(workingId), 'the working group does not remain').toBeUndefined();
    expect(doc.tree.getNode(otherId)?.hidden ?? false, 'the hidden ones come back').toBe(false);
    expect(doc.tree.getNode(instanceId)?.hidden ?? false).toBe(false);
  });

  it('the name does not change through editing', () => {
    const { doc, template } = docWithInstanceAndOther();
    const { session } = enter(doc, template);
    const exited = endComponentEdit(doc, session, template, true);
    if (!('template' in exited)) throw new Error('failed');
    expect(exited.template?.name).toBe(template.name);
  });

  /**
   * Edit mode and undo / redo (#142 review P1).
   *
   * The edit session is one-to-one with the history session. **Changes inside do not leak
   * out**, and **history outside cannot be touched from inside**. If this breaks, you get
   * states where only the working group disappears and you cannot exit / you exit but the
   * edit screen comes back.
   */
  describe('Meshes with undo / redo', () => {
    it('an undo right after entering does not clear the edit mode precondition', () => {
      const { doc, template } = docWithInstanceAndOther();
      const { workingId } = enter(doc, template);

      doc.undo(); // there is nothing inside the session yet, so nothing happens here

      expect(doc.tree.getNode(workingId), 'the working group remains').toBeDefined();
    });

    it('changes inside the session can be undone', () => {
      const { doc, template } = docWithInstanceAndOther();
      const { workingId } = enter(doc, template);
      doc.applyTransaction({
        ops: [{ kind: 'voxel', owner: workingId, key: makeCellKey(0, 3, 0), before: null, after: RAW }],
      });
      expect([...doc.scene.cells.entriesOf(workingId)]).toHaveLength(4);

      doc.undo();

      expect([...doc.scene.cells.entriesOf(workingId)], 'reverts by exactly the stretched amount').toHaveLength(3);
      expect(doc.tree.getNode(workingId), 'the working group remains').toBeDefined();
    });

    it('an undo after exiting reverts to the original shape, not the edit screen', () => {
      const { doc, template, otherId, instanceId } = docWithInstanceAndOther();
      const { session, workingId } = enter(doc, template);
      doc.applyTransaction({
        ops: [{ kind: 'voxel', owner: workingId, key: makeCellKey(0, 3, 0), before: null, after: RAW }],
      });
      const exited = endComponentEdit(doc, session, template, true);
      if (!('template' in exited)) throw new Error('failed');

      doc.undo();

      expect([...doc.scene.cells.entriesOf(instanceId)], 'the instance reverts to its original shape').toHaveLength(3);
      expect(doc.tree.getNode(workingId), 'the working group for editing does not reappear').toBeUndefined();
      expect(doc.tree.getNode(otherId)?.hidden ?? false, 'the state hidden for editing does not reappear either').toBe(false);
    });

    it("an undo after exiting also reverts the list's contents together", () => {
      const store = new ComponentStore(null);
      const doc = new Document(
        { tree: new SceneTree(), cells: new OwnerVoxelStore(), patterns: new PatternPaintStore() },
        () => 'full',
        undefined,
        store,
      );
      const tpl = template('c1', 'pillar');
      store.add(tpl);
      const first = buildPlaceComponent(doc, tpl, [0, 0, 0]);
      if ('error' in first) throw new Error('failed');
      doc.applyTransaction(first.tx);
      const instanceId = (first.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;

      const entered = beginComponentEdit(doc, store.get('c1')!);
      if (!('session' in entered)) throw new Error('failed');
      doc.applyTransaction({
        ops: [{ kind: 'voxel', owner: entered.session.workingGroupId, key: makeCellKey(0, 1, 0), before: null, after: RAW }],
      });
      const exited = endComponentEdit(doc, entered.session, store.get('c1'), true);
      if (!('template' in exited)) throw new Error('failed');
      expect(store.get('c1')?.cells, 'precondition: the list is also at 2 cells').toHaveLength(2);

      doc.undo();

      expect([...doc.scene.cells.entriesOf(instanceId)], 'the actual instance reverts').toHaveLength(1);
      expect(store.get('c1')?.cells, 'the definition reverts together too').toHaveLength(1);

      // even after reverting, re-placing yields the same shape as what already exists
      const second = buildPlaceComponent(doc, store.get('c1')!, [10, 0, 10]);
      if ('error' in second) throw new Error('failed');
      doc.applyTransaction(second.tx);
      const otherId = (second.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;
      expect([...doc.scene.cells.entriesOf(otherId)].length).toBe(
        [...doc.scene.cells.entriesOf(instanceId)].length,
      );
    });

    it('redo brings both the definition and the instance back to the new shape', () => {
      const store = new ComponentStore(null);
      const doc = new Document(
        { tree: new SceneTree(), cells: new OwnerVoxelStore(), patterns: new PatternPaintStore() },
        () => 'full',
        undefined,
        store,
      );
      const tpl = template('c1', 'pillar');
      store.add(tpl);
      const placedResult = buildPlaceComponent(doc, tpl, [0, 0, 0]);
      if ('error' in placedResult) throw new Error('failed');
      doc.applyTransaction(placedResult.tx);
      const instanceId = (placedResult.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;

      const entered = beginComponentEdit(doc, store.get('c1')!);
      if (!('session' in entered)) throw new Error('failed');
      doc.applyTransaction({
        ops: [{ kind: 'voxel', owner: entered.session.workingGroupId, key: makeCellKey(0, 1, 0), before: null, after: RAW }],
      });
      endComponentEdit(doc, entered.session, store.get('c1'), true);

      doc.undo();
      doc.redo();

      expect([...doc.scene.cells.entriesOf(instanceId)]).toHaveLength(2);
      expect(store.get('c1')?.cells).toHaveLength(2);
    });

    it('can confirm and exit even without having placed a single one yet', () => {
      const store = new ComponentStore(null);
      const doc = new Document(
        { tree: new SceneTree(), cells: new OwnerVoxelStore(), patterns: new PatternPaintStore() },
        () => 'full',
        undefined,
        store,
      );
      store.add(template('c1', 'pillar')); // only in the list. not placed in the project

      const entered = beginComponentEdit(doc, store.get('c1')!);
      if (!('session' in entered)) throw new Error('failed');
      doc.applyTransaction({
        ops: [{ kind: 'voxel', owner: entered.session.workingGroupId, key: makeCellKey(0, 1, 0), before: null, after: RAW }],
      });

      const exited = endComponentEdit(doc, entered.session, store.get('c1'), true);

      if (!('template' in exited)) throw new Error(`could not exit: ${JSON.stringify(exited)}`);
      expect(exited.failed, 'not treated as a failure').toBeUndefined();
      expect(exited.template?.cells, 'the fixed shape goes into the list').toHaveLength(2);
      expect(store.get('c1')?.cells).toHaveLength(2);
      expect(doc.tree.getNode(entered.session.workingGroupId), 'the working group does not remain').toBeUndefined();
    });

    it('discarding and exiting leaves nothing in the project', () => {
      const { doc, template, otherId, instanceId } = docWithInstanceAndOther();
      const { session, workingId } = enter(doc, template);
      doc.applyTransaction({
        ops: [{ kind: 'voxel', owner: workingId, key: makeCellKey(0, 3, 0), before: null, after: RAW }],
      });

      const exited = endComponentEdit(doc, session, template, false);
      if (!('template' in exited)) throw new Error('failed');

      expect(exited.template, 'does not write back').toBeNull();
      expect([...doc.scene.cells.entriesOf(instanceId)], 'the instance stays as-is').toHaveLength(3);
      expect(doc.tree.getNode(workingId)).toBeUndefined();
      expect(doc.tree.getNode(otherId)?.hidden ?? false).toBe(false);
    });
  });
});
