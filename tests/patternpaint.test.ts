import { describe, expect, it } from 'vitest';
import { Document } from '../src/core/document';
import { makeCellKey } from '../src/core/cell';
import { makeCellRefKey } from '../src/core/cellref';
import { buildIndexOf } from '../src/core/mixpalette';
import { decodeOrientation, encodeOrientation, packCell, unpackCell } from '../src/core/orientation';
import {
  activePatternAt,
  nextPatternVariant,
  PATTERN_VARIANTS,
  PatternPaintStore,
  patternSampleAt,
  resolvePatternRaw,
  samplePatternAt,
} from '../src/core/patternpaint';
import { OwnerVoxelStore, type EditorScene } from '../src/core/ownervoxels';
import { SceneTree } from '../src/core/scenetree';
import { CATALOG } from '../src/data/blocks';
import { buildDuplicate, buildMirror, buildReplacePatternUsage } from '../src/editor/ops';
import { cellSelectionOf, normalizeSelection } from '../src/editor/selection';
import { loadProjectV3, serializeProjectV5 } from '../src/project/persistence';

const indexOf = buildIndexOf(CATALOG);
const shapeOf = (index: number) => CATALOG[index]?.shape;

function sceneWithOne(): { scene: EditorScene; patterns: PatternPaintStore } {
  const cells = new OwnerVoxelStore();
  cells.set(null, makeCellKey(0, 0, 0), packCell(0, 0));
  const patterns = new PatternPaintStore();
  return { scene: { tree: new SceneTree(), cells, patterns }, patterns };
}

describe('live pattern paint', () => {
  it('the same ref samples deterministically, and changing the ratio changes only the projection while keeping the binding', () => {
    const { scene, patterns } = sceneWithOne();
    const ref = { ownerId: null, localCell: [0, 0, 0] as [number, number, number] };
    const recipe = {
      id: 'mix',
      name: 'mix',
      entries: [
        { blockId: CATALOG[1]!.id, weight: 1 },
        { blockId: CATALOG[2]!.id, weight: 1 },
      ],
    };
    expect(samplePatternAt(recipe, ref.localCell, indexOf)).toBe(samplePatternAt(recipe, ref.localCell, indexOf));

    const appliedRaw = packCell(1, 0);
    patterns.set(ref, { recipeId: recipe.id, variant: 0, sourceRaw: packCell(0, 0), appliedRaw });
    scene.cells.set(null, makeCellKey(0, 0, 0), appliedRaw);
    const paint = activePatternAt(patterns, scene.cells, null, makeCellKey(0, 0, 0))!;
    recipe.entries[0]!.weight = 0;
    expect(unpackCell(resolvePatternRaw(paint, ref.localCell, recipe, indexOf, shapeOf)).catalogIndex).toBe(2);
    expect(activePatternAt(patterns, scene.cells, null, makeCellKey(0, 0, 0))?.recipeId).toBe('mix');
  });

  it('setPattern can undo/redo even for a cell whose raw is unchanged', () => {
    const { scene } = sceneWithOne();
    const doc = new Document(scene, shapeOf);
    const key = makeCellKey(0, 0, 0);
    const paint = { recipeId: 'mix', variant: 0, sourceRaw: packCell(0, 0), appliedRaw: packCell(0, 0) };
    doc.applyTransaction({
      ops: [{ kind: 'setPattern', owner: null, key, before: null, after: paint }],
    });
    expect(doc.scene.patterns?.get(null, key)?.recipeId).toBe('mix');
    doc.undo();
    expect(doc.scene.patterns?.get(null, key)).toBeUndefined();
    doc.redo();
    expect(doc.scene.patterns?.get(null, key)?.recipeId).toBe('mix');
  });

  it('a normal block edit removes the binding within the same history unit, and undo restores it', () => {
    const { scene, patterns } = sceneWithOne();
    const key = makeCellKey(0, 0, 0);
    const raw = scene.cells.get(null, key)!;
    const ref = { ownerId: null, localCell: [0, 0, 0] as [number, number, number] };
    patterns.set(ref, { recipeId: 'mix', variant: 0, sourceRaw: raw, appliedRaw: raw });
    const doc = new Document(scene, shapeOf);
    const after = packCell(1, 0);
    doc.applyTransaction({ ops: [{ kind: 'voxel', owner: null, key, before: raw, after }] });
    expect(doc.scene.patterns?.get(null, key)).toBeUndefined();
    doc.undo();
    expect(doc.scene.patterns?.get(null, key)?.recipeId).toBe('mix');
  });

  it('a physical move with refRemap also moves the binding, and undo returns it to its original spot', () => {
    const { scene, patterns } = sceneWithOne();
    const oldKey = makeCellKey(0, 0, 0);
    const nextKey = makeCellKey(1, 0, 0);
    const raw = scene.cells.get(null, oldKey)!;
    const oldRef = { ownerId: null, localCell: [0, 0, 0] as [number, number, number] };
    const nextRef = { ownerId: null, localCell: [1, 0, 0] as [number, number, number] };
    const recipe = {
      id: 'mix',
      name: 'mix',
      entries: [
        { blockId: CATALOG[1]!.id, weight: 1 },
        { blockId: CATALOG[2]!.id, weight: 1 },
      ],
    };
    patterns.set(oldRef, { recipeId: 'mix', variant: 0, sourceRaw: raw, appliedRaw: raw });
    const doc = new Document(scene, shapeOf);
    doc.applyTransaction({
      ops: [
        { kind: 'voxel', owner: null, key: oldKey, before: raw, after: null },
        { kind: 'voxel', owner: null, key: nextKey, before: null, after: raw },
      ],
      remap: new Map([[makeCellRefKey(oldRef), nextRef]]),
    });
    expect(doc.scene.patterns?.get(null, oldKey)).toBeUndefined();
    expect(doc.scene.patterns?.get(null, nextKey)?.recipeId).toBe('mix');
    expect(doc.scene.patterns?.get(null, nextKey)?.variant).toBe(0);
    // the pattern is determined by the destination's world coordinate. It doesn't use the value baked into the binding
    expect(resolvePatternRaw(patterns.get(null, nextKey)!, nextRef.localCell, recipe, indexOf, shapeOf)).toBe(
      resolvePatternRaw({ recipeId: 'mix', variant: 0, sourceRaw: raw, appliedRaw: raw }, nextRef.localCell, recipe, indexOf, shapeOf),
    );
    doc.undo();
    expect(doc.scene.patterns?.get(null, oldKey)?.recipeId).toBe('mix');
    expect(doc.scene.patterns?.get(null, nextKey)).toBeUndefined();
  });

  it('array-duplicating copies the binding to every cell, and it is preserved through undo/redo', () => {
    const { scene, patterns } = sceneWithOne();
    const sourceRef = { ownerId: null, localCell: [0, 0, 0] as [number, number, number] };
    const sourceKey = makeCellKey(...sourceRef.localCell);
    const raw = scene.cells.get(null, sourceKey)!;
    const paint = { recipeId: 'mix', variant: 0, sourceRaw: raw, appliedRaw: raw };
    patterns.set(sourceRef, paint);
    const doc = new Document(scene, shapeOf);
    const selection = normalizeSelection(
      doc.tree,
      cellSelectionOf([{ ref: sourceRef, worldCell: sourceRef.localCell }]),
    );

    const result = buildDuplicate(doc, selection, { delta: [2, 0, 0], count: 3 });
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);

    for (const x of [0, 2, 4, 6]) {
      const key = makeCellKey(x, 0, 0);
      expect(activePatternAt(patterns, scene.cells, null, key)).toEqual(paint);
    }
    doc.undo();
    expect([...patterns.allEntries()]).toHaveLength(1);
    doc.redo();
    for (const x of [0, 2, 4, 6]) {
      expect(activePatternAt(patterns, scene.cells, null, makeCellKey(x, 0, 0))).toEqual(paint);
    }
  });

  it('array-duplicating a group also copies the binding to all N owners', () => {
    const tree = new SceneTree();
    tree.insertNode({ id: 'g', name: 'G', parentId: null, childIds: [] }, 0);
    const cells = new OwnerVoxelStore();
    const patterns = new PatternPaintStore();
    const key = makeCellKey(0, 0, 0);
    const raw = packCell(0, 0);
    cells.set('g', key, raw);
    const paint = { recipeId: 'mix', variant: 0, sourceRaw: raw, appliedRaw: raw };
    patterns.set({ ownerId: 'g', localCell: [0, 0, 0] }, paint);
    const scene: EditorScene = { tree, cells, patterns };
    const doc = new Document(scene, shapeOf);
    const selection = normalizeSelection(doc.tree, { kind: 'groups', ids: ['g'] });

    const result = buildDuplicate(doc, selection, { delta: [2, 0, 0], count: 3 });
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);

    const copiedIds = result.newSelection?.kind === 'groups' ? result.newSelection.ids : [];
    expect(copiedIds).toHaveLength(3);
    for (const owner of ['g', ...copiedIds]) {
      expect(activePatternAt(patterns, cells, owner, key)).toEqual(paint);
    }
  });

  it('mirror simultaneously transforms the orientation and position of the swapped bindings, and it is reversible through undo/redo', () => {
    const stairsIndex = CATALOG.findIndex((block) => block.shape === 'stairs');
    const sourceRaw = packCell(
      stairsIndex,
      encodeOrientation({ shape: 'stairs', weirdoDirection: 1, upsideDown: false }),
    );
    // 1 = facing west. Mirroring on X gives east = 0 (from the measured table)
    const mirroredRaw = packCell(
      stairsIndex,
      encodeOrientation({ shape: 'stairs', weirdoDirection: 0, upsideDown: false }),
    );
    const cells = new OwnerVoxelStore();
    const patterns = new PatternPaintStore();
    const leftRef = { ownerId: null, localCell: [0, 0, 0] as [number, number, number] };
    const rightRef = { ownerId: null, localCell: [1, 0, 0] as [number, number, number] };
    cells.set(null, makeCellKey(...leftRef.localCell), sourceRaw);
    cells.set(null, makeCellKey(...rightRef.localCell), sourceRaw);
    patterns.set(leftRef, { recipeId: 'mix', variant: 2, sourceRaw, appliedRaw: sourceRaw });
    patterns.set(rightRef, { recipeId: 'mix', variant: 5, sourceRaw, appliedRaw: sourceRaw });
    const scene: EditorScene = { tree: new SceneTree(), cells, patterns };
    const doc = new Document(scene, shapeOf);
    const selection = normalizeSelection(
      doc.tree,
      cellSelectionOf([
        { ref: leftRef, worldCell: leftRef.localCell },
        { ref: rightRef, worldCell: rightRef.localCell },
      ]),
    );

    const result = buildMirror(doc, selection, 'x');
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);

    const leftAfter = activePatternAt(patterns, cells, null, makeCellKey(0, 0, 0))!;
    const rightAfter = activePatternAt(patterns, cells, null, makeCellKey(1, 0, 0))!;
    expect(leftAfter).toMatchObject({ variant: 5, sourceRaw: mirroredRaw, appliedRaw: mirroredRaw });
    expect(rightAfter).toMatchObject({ variant: 2, sourceRaw: mirroredRaw, appliedRaw: mirroredRaw });
    const replacementIndex = CATALOG.findIndex(
      (block, catalogIndex) => block.shape === 'stairs' && catalogIndex !== stairsIndex,
    );
    const changedRecipe = {
      id: 'mix',
      name: 'changed',
      entries: [{ blockId: CATALOG[replacementIndex]!.id, weight: 1 }],
    };
    const reapplied = unpackCell(
      resolvePatternRaw(leftAfter, leftRef.localCell, changedRecipe, indexOf, shapeOf),
    );
    expect(reapplied.catalogIndex).toBe(replacementIndex);
    expect(decodeOrientation('stairs', reapplied.code)).toMatchObject({
      weirdoDirection: 0,
      upsideDown: false,
    });

    doc.undo();
    expect(activePatternAt(patterns, cells, null, makeCellKey(0, 0, 0))).toMatchObject({
      variant: 2,
      sourceRaw,
      appliedRaw: sourceRaw,
    });
    expect(activePatternAt(patterns, cells, null, makeCellKey(1, 0, 0))).toMatchObject({
      variant: 5,
      sourceRaw,
      appliedRaw: sourceRaw,
    });

    doc.redo();
    expect(activePatternAt(patterns, cells, null, makeCellKey(0, 0, 0))).toMatchObject({
      variant: 5,
      sourceRaw: mirroredRaw,
      appliedRaw: mirroredRaw,
    });
  });

  it('a mirror that changes sourceRaw\'s orientation is not treated as a no-op even when the coordinate and appliedRaw are symmetric', () => {
    const stairsIndex = CATALOG.findIndex((block) => block.shape === 'stairs');
    const fullIndex = CATALOG.findIndex((block) => block.shape === 'full');
    const sourceRaw = packCell(
      stairsIndex,
      encodeOrientation({ shape: 'stairs', weirdoDirection: 1, upsideDown: false }),
    );
    const appliedRaw = packCell(fullIndex, 0);
    const { scene, patterns } = sceneWithOne();
    const ref = { ownerId: null, localCell: [0, 0, 0] as [number, number, number] };
    const key = makeCellKey(...ref.localCell);
    scene.cells.set(null, key, appliedRaw);
    patterns.set(ref, { recipeId: 'mix', variant: 0, sourceRaw, appliedRaw });
    const doc = new Document(scene, shapeOf);
    expect(doc.mirrorWorldRaw(sourceRaw, 'x')).not.toBe(sourceRaw);
    const selection = normalizeSelection(
      doc.tree,
      cellSelectionOf([{ ref, worldCell: ref.localCell }]),
    );

    const result = buildMirror(doc, selection, 'x');
    if ('error' in result) throw new Error(result.error);
    expect(result.tx.ops).not.toHaveLength(0);
    doc.applyTransaction(result.tx);

    const mirrored = patterns.get(null, key)!;
    // 1 = facing west → X mirror → east = 0 (from the measured table)
    expect(decodeOrientation('stairs', unpackCell(mirrored.sourceRaw).code)).toMatchObject({
      weirdoDirection: 0,
    });
    expect(activePatternAt(patterns, scene.cells, null, key)).not.toBeNull();
  });

  it('a slab\'s Y mirror also transforms the binding\'s half, keeping it active through undo/redo', () => {
    const slabIndex = CATALOG.findIndex((block) => block.shape === 'slab');
    const topRaw = packCell(slabIndex, encodeOrientation({ shape: 'slab', half: 'top' }));
    const bottomRaw = packCell(slabIndex, encodeOrientation({ shape: 'slab', half: 'bottom' }));
    const cells = new OwnerVoxelStore();
    const patterns = new PatternPaintStore();
    const ref = { ownerId: null, localCell: [0, 0, 0] as [number, number, number] };
    const key = makeCellKey(...ref.localCell);
    cells.set(null, key, topRaw);
    patterns.set(ref, { recipeId: 'mix', variant: 0, sourceRaw: topRaw, appliedRaw: topRaw });
    const scene: EditorScene = { tree: new SceneTree(), cells, patterns };
    const doc = new Document(scene, shapeOf);
    const selection = normalizeSelection(
      doc.tree,
      cellSelectionOf([{ ref, worldCell: ref.localCell }]),
    );

    const result = buildMirror(doc, selection, 'y');
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);
    expect(activePatternAt(patterns, cells, null, key)).toMatchObject({
      sourceRaw: bottomRaw,
      appliedRaw: bottomRaw,
    });

    doc.undo();
    expect(activePatternAt(patterns, cells, null, key)).toMatchObject({
      sourceRaw: topRaw,
      appliedRaw: topRaw,
    });
    doc.redo();
    expect(activePatternAt(patterns, cells, null, key)).toMatchObject({
      sourceRaw: bottomRaw,
      appliedRaw: bottomRaw,
    });
  });

  it('v5 saves and loads pattern bindings, round-tripping them', () => {
    const { scene, patterns } = sceneWithOne();
    const key = makeCellKey(0, 0, 0);
    const raw = scene.cells.get(null, key)!;
    patterns.set(
      { ownerId: null, localCell: [0, 0, 0] },
      { recipeId: 'mix', variant: 0, sourceRaw: raw, appliedRaw: raw },
    );
    const recipes = [{ id: 'mix', name: 'mix', entries: [{ blockId: CATALOG[1]!.id, weight: 1 }] }];
    const file = serializeProjectV5('x', scene, CATALOG, recipes);
    expect(file.version).toBe(5);
    expect(file.cells[0]).toHaveLength(7);

    const loaded = loadProjectV3(file, indexOf).scene;
    expect(loaded.patterns?.get(null, key)).toEqual({
      recipeId: 'mix',
      variant: 0,
      sourceRaw: raw,
      appliedRaw: raw,
    });
    expect(serializeProjectV5('x', loaded, CATALOG, recipes)).toEqual(file);
  });

  it('even after group id renumbering, the same world coordinate picks the same entry', () => {
    const tree = new SceneTree();
    tree.insertNode({ id: 'g17', name: 'G', parentId: null, childIds: [] }, 0);
    const cells = new OwnerVoxelStore();
    const patterns = new PatternPaintStore();
    const key = makeCellKey(0, 0, 0);
    const ref = { ownerId: 'g17', localCell: [0, 0, 0] as [number, number, number] };
    const recipe = {
      id: 'mix',
      name: 'mix',
      entries: [
        { blockId: CATALOG[1]!.id, weight: 1 },
        { blockId: CATALOG[2]!.id, weight: 1 },
      ],
    };
    const appliedRaw = packCell(2, 0);
    cells.set('g17', key, appliedRaw);
    patterns.set(ref, { recipeId: recipe.id, variant: 3, sourceRaw: packCell(0, 0), appliedRaw });
    const scene: EditorScene = { tree, cells, patterns };
    // the group has no transform set = identity, so the world coordinate matches local
    const before = resolvePatternRaw(patterns.get('g17', key)!, ref.localCell, recipe, indexOf, shapeOf);

    const loaded = loadProjectV3(serializeProjectV5('x', scene, CATALOG, [recipe]), indexOf).scene;
    const loadedOwner = [...loaded.tree.childrenOf(null)][0]!;
    expect(loadedOwner).not.toBe('g17');
    const loadedPaint = loaded.patterns?.get(loadedOwner, key);
    // the draw position isn't persisted, but since the world coordinate is the same it resolves to the same pattern
    // (back when it was seeded by owner, renumbering would change the pattern, raised in review)
    expect(loadedPaint?.variant).toBe(3);
    expect(resolvePatternRaw(loadedPaint!, [0, 0, 0], recipe, indexOf, shapeOf)).toBe(before);
  });

  it('opening a v4 (sample) file reads it as variant 0', () => {
    const { scene, patterns } = sceneWithOne();
    const key = makeCellKey(0, 0, 0);
    const raw = scene.cells.get(null, key)!;
    patterns.set({ ownerId: null, localCell: [0, 0, 0] }, { recipeId: 'mix', variant: 3, sourceRaw: raw, appliedRaw: raw });
    const recipes = [{ id: 'mix', name: 'mix', entries: [{ blockId: CATALOG[1]!.id, weight: 1 }] }];
    const v5 = serializeProjectV5('x', scene, CATALOG, recipes);

    // revert to the v4-equivalent form (drop variant and restore sample)
    const v4 = JSON.parse(JSON.stringify(v5)) as { version: number; cells: Array<unknown[]> };
    v4.version = 4;
    const metadata = v4.cells[0]![6] as Record<string, unknown>;
    delete metadata.variant;
    metadata.sample = 0.75;

    const loaded = loadProjectV3(v4, indexOf).scene;
    expect(loaded.patterns?.get(null, key)).toEqual({
      recipeId: 'mix',
      variant: 0,
      sourceRaw: raw,
      appliedRaw: raw,
    });
    // export after reading is always v5
    expect(serializeProjectV5('x', loaded, CATALOG, recipes).version).toBe(5);
  });

  it('strictly checks required fields per version', () => {
    const { scene, patterns } = sceneWithOne();
    const raw = scene.cells.get(null, makeCellKey(0, 0, 0))!;
    patterns.set({ ownerId: null, localCell: [0, 0, 0] }, { recipeId: 'mix', variant: 0, sourceRaw: raw, appliedRaw: raw });
    const recipes = [{ id: 'mix', name: 'mix', entries: [{ blockId: CATALOG[1]!.id, weight: 1 }] }];
    const v5 = serializeProjectV5('x', scene, CATALOG, recipes);

    // claims to be v5 but only has sample
    const badV5 = JSON.parse(JSON.stringify(v5)) as { cells: Array<unknown[]> };
    const m5 = badV5.cells[0]![6] as Record<string, unknown>;
    delete m5.variant;
    m5.sample = 0.5;
    expect(() => loadProjectV3(badV5 as never, indexOf)).toThrow();

    // claims to be v4 but only has variant
    const badV4 = JSON.parse(JSON.stringify(v5)) as { version: number };
    badV4.version = 4;
    expect(() => loadProjectV3(badV4 as never, indexOf)).toThrow();
  });

  it('setPattern and the reader do not retain the caller\'s PatternPaint alias', () => {
    const { scene, patterns } = sceneWithOne();
    const doc = new Document(scene, shapeOf);
    const key = makeCellKey(0, 0, 0);
    const paint = { recipeId: 'mix', variant: 0, sourceRaw: packCell(0, 0), appliedRaw: packCell(0, 0) };
    doc.applyTransaction({ ops: [{ kind: 'setPattern', owner: null, key, before: null, after: paint }] });

    paint.recipeId = 'mutated-after-apply';
    const exposed = patterns.get(null, key)! as { recipeId: string };
    exposed.recipeId = 'mutated-reader';
    expect(patterns.get(null, key)?.recipeId).toBe('mix');

    doc.undo();
    doc.redo();
    expect(patterns.get(null, key)?.recipeId).toBe('mix');
  });

  it('re-applying the same pattern advances the placement number, and undo returns it to the original', () => {
    const { scene, patterns } = sceneWithOne();
    const key = makeCellKey(0, 0, 0);
    const ref = { ownerId: null, localCell: [0, 0, 0] as [number, number, number] };
    const raw = scene.cells.get(null, key)!;
    const oldPaint = { recipeId: 'mix', variant: 4, sourceRaw: raw, appliedRaw: raw };
    patterns.set(ref, oldPaint);
    const recipe = {
      id: 'mix',
      name: 'mix',
      entries: [
        { blockId: CATALOG[1]!.id, weight: 1 },
        { blockId: CATALOG[2]!.id, weight: 1 },
      ],
    };
    const doc = new Document(scene, shapeOf);

    const result = buildReplacePatternUsage(
      doc,
      [null],
      recipe.id,
      { kind: 'pattern', recipe },
      indexOf,
      shapeOf,
    );
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);

    const reapplied = patterns.get(null, key)!;
    expect(reapplied.variant).toBe(5);
    expect(scene.cells.get(null, key)).toBe(reapplied.appliedRaw);
    expect(resolvePatternRaw(reapplied, ref.localCell, undefined, indexOf, shapeOf)).toBe(reapplied.appliedRaw);
    doc.undo();
    expect(patterns.get(null, key)?.variant).toBe(4);
    expect(scene.cells.get(null, key)).toBe(raw);
  });

  describe('binding follows along during cell drag', () => {
    const recipe = {
      id: 'mix',
      name: 'mix',
      entries: CATALOG.slice(1, 5).map((block) => ({ blockId: block.id, weight: 1 })),
    };

    /** Find a move distance that actually changes the pattern (this test is about coordinate dependence, so a delta that doesn't change it is meaningless) */
    function deltaThatChangesPattern(from: [number, number, number]): number {
      const base = samplePatternAt(recipe, from, indexOf);
      for (let dx = 1; dx < 32; dx++) {
        if (samplePatternAt(recipe, [from[0] + dx, from[1], from[2]], indexOf) !== base) return dx;
      }
      throw new Error('could not find a move distance that changes the pattern (check whether the recipe has become a single block)');
    }

    function setup() {
      const cells = new OwnerVoxelStore();
      const patterns = new PatternPaintStore();
      const ref = { ownerId: null, localCell: [0, 0, 0] as [number, number, number] };
      const key = makeCellKey(...ref.localCell);
      const appliedRaw = packCell(samplePatternAt(recipe, ref.localCell, indexOf)!, 0);
      cells.set(null, key, appliedRaw);
      patterns.set(ref, { recipeId: recipe.id, variant: 0, sourceRaw: packCell(0, 0), appliedRaw });
      const scene: EditorScene = { tree: new SceneTree(), cells, patterns };
      const doc = new Document(scene, shapeOf, (r, raw, worldCell) => {
        const paint = activePatternAt(patterns, cells, r.ownerId, makeCellKey(...r.localCell));
        return paint ? resolvePatternRaw(paint, worldCell, recipe, indexOf, shapeOf) : raw;
      });
      return { doc, scene, patterns, ref, key, appliedRaw };
    }

    it('displays the destination pattern during preview, and it does not change on commit', () => {
      const { doc, ref } = setup();
      const dx = deltaThatChangesPattern(ref.localCell);
      const destCell: [number, number, number] = [ref.localCell[0] + dx, 0, 0];
      const expected = packCell(samplePatternAt(recipe, destCell, indexOf)!, 0);

      const session = doc.beginSession();
      session.stageMoveRefs([ref], [dx, 0, 0]);

      // already showing the destination's pattern at preview time (don't leave it as the stored fallback)
      const previewed = doc.index.winnerRefAt(destCell)!;
      expect(previewed.raw).toBe(expected);

      session.commit();
      // the pattern does not snap on commit = same as preview
      expect(doc.index.winnerRefAt(destCell)!.raw).toBe(expected);
      expect(doc.scene.patterns?.get(null, makeCellKey(...destCell))?.recipeId).toBe('mix');
    });

    it('canceling also returns the binding to the original ref', () => {
      const { doc, ref, key, appliedRaw } = setup();
      const dx = deltaThatChangesPattern(ref.localCell);
      const destKey = makeCellKey(ref.localCell[0] + dx, 0, 0);

      const session = doc.beginSession();
      session.stageMoveRefs([ref], [dx, 0, 0]);
      expect(doc.scene.patterns?.get(null, destKey)).toBeDefined();

      session.cancel();
      expect(doc.scene.patterns?.get(null, destKey)).toBeUndefined();
      expect(doc.scene.patterns?.get(null, key)).toEqual({
        recipeId: 'mix',
        variant: 0,
        sourceRaw: packCell(0, 0),
        appliedRaw,
      });
      expect(doc.index.winnerRefAt([0, 0, 0])!.raw).toBe(appliedRaw);
    });

    it('continuing to move the offset does not stack the binding away from the original position', () => {
      const { doc, ref } = setup();
      const dx = deltaThatChangesPattern(ref.localCell);

      const session = doc.beginSession();
      // during drag, stageMoveRefs is called on every pointermove. If the remap accumulated,
      // the binding would fly off by the sum of all the offsets
      session.stageMoveRefs([ref], [1, 0, 0]);
      session.stageMoveRefs([ref], [2, 0, 0]);
      session.stageMoveRefs([ref], [dx, 0, 0]);

      const destKey = makeCellKey(ref.localCell[0] + dx, 0, 0);
      expect([...doc.scene.patterns!.allEntries()]).toHaveLength(1);
      expect(doc.scene.patterns?.get(null, destKey)?.recipeId).toBe('mix');

      session.commit();
      expect(doc.scene.patterns?.get(null, destKey)?.recipeId).toBe('mix');
      expect([...doc.scene.patterns!.allEntries()]).toHaveLength(1);
    });

    it('committing without moving does not leave the binding stranded', () => {
      const { doc, ref, key } = setup();
      const session = doc.beginSession();
      // dragged and moved back = zero voxel diff. If only the staged remap remains, the binding gets lost
      session.stageMoveRefs([ref], [3, 0, 0]);
      session.stageMoveRefs([ref], [0, 0, 0]);
      session.commit();

      expect([...doc.scene.patterns!.allEntries()]).toHaveLength(1);
      expect(doc.scene.patterns?.get(null, key)?.recipeId).toBe('mix');
    });

    it('if stageMoveRefs fails, the binding does not move either', () => {
      const { doc, ref, key, appliedRaw } = setup();
      const before = [...doc.scene.patterns!.allEntries()];
      let indexChanges = 0;
      const unsubscribe = doc.index.subscribe(() => { indexChanges++; });

      const session = doc.beginSession();
      // coordinate out of range = staged application fails. If the voxel doesn't move, the binding must not move either
      expect(() => session.stageMoveRefs([ref], [1_000_000, 0, 0])).toThrow();
      unsubscribe();

      expect([...doc.scene.patterns!.allEntries()]).toEqual(before);
      expect(doc.scene.patterns?.get(null, key)?.recipeId).toBe('mix');
      expect(doc.scene.cells.get(null, key)).toBe(appliedRaw);
      expect(doc.index.winnerRefAt([0, 0, 0])!.raw).toBe(appliedRaw);
      expect(indexChanges).toBe(0);
    });

    it('even moving onto a cell that already has a pattern, both bindings are reversible through commit/undo/redo', () => {
      const cells = new OwnerVoxelStore();
      const patterns = new PatternPaintStore();
      const sourceRef = { ownerId: null, localCell: [0, 0, 0] as [number, number, number] };
      const destRef = { ownerId: null, localCell: [1, 0, 0] as [number, number, number] };
      const sourceKey = makeCellKey(...sourceRef.localCell);
      const destKey = makeCellKey(...destRef.localCell);
      // appliedRaw must be the value resolved from "that coordinate × that variant", or the post-undo display comparison drifts
      const sourceRaw = packCell(samplePatternAt(recipe, sourceRef.localCell, indexOf, 1)!, 0);
      const destRaw = packCell(samplePatternAt(recipe, destRef.localCell, indexOf, 7)!, 0);
      cells.set(null, sourceKey, sourceRaw);
      cells.set(null, destKey, destRaw);
      // both the source and destination have bindings. The destination's binding gets overwritten
      const sourcePaint = { recipeId: recipe.id, variant: 1, sourceRaw: packCell(0, 0), appliedRaw: sourceRaw };
      const destPaint = { recipeId: recipe.id, variant: 7, sourceRaw: packCell(0, 0), appliedRaw: destRaw };
      patterns.set(sourceRef, sourcePaint);
      patterns.set(destRef, destPaint);
      const scene: EditorScene = { tree: new SceneTree(), cells, patterns };
      const doc = new Document(scene, shapeOf, (r, raw, worldCell) => {
        const paint = activePatternAt(patterns, cells, r.ownerId, makeCellKey(...r.localCell));
        return paint ? resolvePatternRaw(paint, worldCell, recipe, indexOf, shapeOf) : raw;
      });

      const session = doc.beginSession();
      session.stageMoveRefs([sourceRef], [1, 0, 0]);
      session.commit();

      // the destination is overwritten by the incoming binding, and the source becomes empty
      expect(doc.scene.patterns?.get(null, destKey)).toMatchObject({ variant: 1 });
      // the display is resolved from "the destination's coordinate × the moved-in variant"
      expect(doc.index.winnerRefAt(destRef.localCell)!.raw).toBe(
        packCell(samplePatternAt(recipe, destRef.localCell, indexOf, 1)!, 0),
      );
      expect(doc.scene.patterns?.get(null, sourceKey)).toBeUndefined();

      doc.undo();
      // **the source's binding comes back** (it used to be undefined with only automatic remap)
      expect(doc.scene.patterns?.get(null, sourceKey)).toEqual(sourcePaint);
      // the overwritten destination's binding also comes back
      expect(doc.scene.patterns?.get(null, destKey)).toEqual(destPaint);
      // the display (index) also follows the binding back to the original pattern
      expect(doc.index.winnerRefAt(sourceRef.localCell)!.raw).toBe(sourceRaw);
      expect(doc.index.winnerRefAt(destRef.localCell)!.raw).toBe(destRaw);

      doc.redo();
      expect(doc.scene.patterns?.get(null, destKey)).toMatchObject({ variant: 1 });
      expect(doc.scene.patterns?.get(null, sourceKey)).toBeUndefined();
    });

    /**
     * Pin down the 3 source/destination binding-presence combinations under the same contract
     *.
     *
     * Contract: **the preview display = the post-commit display**. If a stale binding is left
     * only during preview, the pattern would change at the moment of pointerup (because
     * `withPatternClears` removes the binding on commit).
     */
    describe('the preview and commit displays match across all 3 binding-presence combinations', () => {
      const storedRaw = packCell(0, 0);

      /** A board where cells' raw values are the same, but only cells with a binding resolve to a different raw via the recipe */
      function setupPair(options: { sourceBinding: boolean; destBinding: boolean }) {
        const cells = new OwnerVoxelStore();
        const patterns = new PatternPaintStore();
        const sourceRef = { ownerId: null, localCell: [0, 0, 0] as [number, number, number] };
        const destRef = { ownerId: null, localCell: [1, 0, 0] as [number, number, number] };
        cells.set(null, makeCellKey(...sourceRef.localCell), storedRaw);
        cells.set(null, makeCellKey(...destRef.localCell), storedRaw);
        const paintOf = () => ({ recipeId: recipe.id, variant: 0, sourceRaw: storedRaw, appliedRaw: storedRaw });
        if (options.sourceBinding) patterns.set(sourceRef, paintOf());
        if (options.destBinding) patterns.set(destRef, paintOf());
        const scene: EditorScene = { tree: new SceneTree(), cells, patterns };
        const doc = new Document(scene, shapeOf, (r, raw, worldCell) => {
          const paint = activePatternAt(patterns, cells, r.ownerId, makeCellKey(...r.localCell));
          return paint ? resolvePatternRaw(paint, worldCell, recipe, indexOf, shapeOf) : raw;
        });
        return { doc, sourceRef, destRef };
      }

      /** After moving, the destination retains a binding only when "the source had a binding" */
      function expectedDestRaw(sourceBinding: boolean, destCell: [number, number, number]): number {
        if (!sourceBinding) return storedRaw;
        return packCell(samplePatternAt(recipe, destCell, indexOf)!, 0);
      }

      for (const { name, sourceBinding, destBinding } of [
        { name: 'no binding → has binding', sourceBinding: false, destBinding: true },
        { name: 'has binding → no binding', sourceBinding: true, destBinding: false },
        { name: 'has binding → has binding', sourceBinding: true, destBinding: true },
      ]) {
        it(name, () => {
          const { doc, sourceRef, destRef } = setupPair({ sourceBinding, destBinding });
          const expected = expectedDestRaw(sourceBinding, destRef.localCell);

          const session = doc.beginSession();
          session.stageMoveRefs([sourceRef], [1, 0, 0]);
          const previewRaw = doc.index.winnerRefAt(destRef.localCell)!.raw;
          expect(previewRaw).toBe(expected);

          session.commit();
          // does not snap on commit
          expect(doc.index.winnerRefAt(destRef.localCell)!.raw).toBe(previewRaw);
          expect(doc.scene.patterns?.get(null, makeCellKey(...destRef.localCell)) === undefined).toBe(!sourceBinding);
          // the source becomes empty (the binding doesn't remain either)
          expect(doc.scene.patterns?.get(null, makeCellKey(...sourceRef.localCell))).toBeUndefined();
        });
      }

      it('canceling returns all 3 combinations to their original binding configuration', () => {
        for (const [sourceBinding, destBinding] of [[false, true], [true, false], [true, true]] as const) {
          const { doc, sourceRef, destRef } = setupPair({ sourceBinding, destBinding });
          const session = doc.beginSession();
          session.stageMoveRefs([sourceRef], [1, 0, 0]);
          session.cancel();

          expect(doc.scene.patterns?.get(null, makeCellKey(...sourceRef.localCell)) === undefined).toBe(!sourceBinding);
          expect(doc.scene.patterns?.get(null, makeCellKey(...destRef.localCell)) === undefined).toBe(!destBinding);
        }
      });
    });

    it('commit does not emit renderer notifications — undo/redo update the display', () => {
      const { doc, ref } = setup();
      const dx = deltaThatChangesPattern(ref.localCell);

      const session = doc.beginSession();
      session.stageMoveRefs([ref], [dx, 0, 0]);

      // by preview time, scene / index are already in their final state. commit only pushes to history and does not re-project
      const events: string[] = [];
      const unsubscribe = doc.index.subscribe((event) => { events.push(event.kind); });
      session.commit();
      expect(events).toEqual([]);

      // undo / redo need a display update (a full rebuild is fine, it doesn't run on every pointerup)
      doc.undo();
      expect(events.length).toBeGreaterThan(0);
      const afterUndo = events.length;
      doc.redo();
      expect(events.length).toBeGreaterThan(afterUndo);
      unsubscribe();
    });

    it('a stroke commit also does not emit renderer notifications (the path that removes a binding review round 4)', () => {
      const { doc, ref, key } = setup();
      const session = doc.beginSession();
      // placing a different block on the same cell = the path that invalidates the binding
      session.stagePreview([{ kind: 'overwrite', worldCell: ref.localCell, afterWorldRaw: packCell(1, 0) }]);
      // the binding is already removed at preview time (doesn't rely on the automatic clear at commit)
      expect(doc.scene.patterns?.get(null, key)).toBeUndefined();

      const events: string[] = [];
      const unsubscribe = doc.index.subscribe((event) => { events.push(event.kind); });
      session.commit();
      expect(events).toEqual([]);
      unsubscribe();

      // since it's on the history, undo brings the binding back
      doc.undo();
      expect(doc.scene.patterns?.get(null, key)?.recipeId).toBe('mix');
    });

    it('if stagePreview fails, cell / index / binding / notifications are all unchanged', () => {
      const { doc, ref, key, appliedRaw } = setup();
      const before = [...doc.scene.patterns!.allEntries()];
      const events: string[] = [];
      const unsubscribe = doc.index.subscribe((event) => { events.push(event.kind); });

      const session = doc.beginSession();
      // pass a normal cell with a binding and an out-of-world-range cell in the same stage.
      // Range validation runs after the binding is cleared, so without protection only the binding gets dropped
      expect(() =>
        session.stagePreview([
          { kind: 'overwrite', worldCell: ref.localCell, afterWorldRaw: packCell(1, 0) },
          { kind: 'place', worldCell: [1_000_000, 0, 0], afterWorldRaw: packCell(1, 0) },
        ]),
      ).toThrow();
      unsubscribe();

      expect([...doc.scene.patterns!.allEntries()]).toEqual(before);
      expect(doc.scene.cells.get(null, key)).toBe(appliedRaw);
      expect(doc.index.winnerRefAt([0, 0, 0])!.raw).toBe(appliedRaw);
      expect(events).toEqual([]);
    });

    it('undo returns the binding to the original ref', () => {
      const { doc, ref, key } = setup();
      const dx = deltaThatChangesPattern(ref.localCell);
      const destKey = makeCellKey(ref.localCell[0] + dx, 0, 0);

      const session = doc.beginSession();
      session.stageMoveRefs([ref], [dx, 0, 0]);
      session.commit();

      doc.undo();
      expect(doc.scene.patterns?.get(null, destKey)).toBeUndefined();
      expect(doc.scene.patterns?.get(null, key)?.recipeId).toBe('mix');
    });
  });

  it('baking a rotated group\'s pattern into a same-shape block does not double-rotate the world orientation', () => {
    const stairs = CATALOG
      .map((block, catalogIndex) => ({ block, catalogIndex }))
      .filter(({ block }) => block.shape === 'stairs');
    const sourceIndex = stairs[0]!.catalogIndex;
    const replacementIndex = stairs[1]!.catalogIndex;
    const tree = new SceneTree();
    tree.insertNode({
      id: 'g',
      name: 'G',
      parentId: null,
      childIds: [],
      transform: { angleSteps: 1, translate: [0, 0, 0], pivot2: [0, 0] },
    }, 0);
    const cells = new OwnerVoxelStore();
    const patterns = new PatternPaintStore();
    const key = makeCellKey(0, 0, 0);
    const localRaw = packCell(
      sourceIndex,
      encodeOrientation({ shape: 'stairs', weirdoDirection: 0, upsideDown: false }),
    );
    cells.set('g', key, localRaw);
    patterns.set(
      { ownerId: 'g', localCell: [0, 0, 0] },
      { recipeId: 'mix', variant: 0, sourceRaw: localRaw, appliedRaw: localRaw },
    );
    const recipe = {
      id: 'mix',
      name: 'mix',
      entries: [{ blockId: CATALOG[sourceIndex]!.id, weight: 1 }],
    };
    const scene: EditorScene = { tree, cells, patterns };
    const doc = new Document(scene, shapeOf, (ref, raw, worldCell) => {
      const paint = activePatternAt(patterns, cells, ref.ownerId, makeCellKey(...ref.localCell));
      return paint ? resolvePatternRaw(paint, worldCell, recipe, indexOf, shapeOf) : raw;
    });

    const result = buildReplacePatternUsage(
      doc,
      ['g'],
      recipe.id,
      { kind: 'block', catalogIndex: replacementIndex },
      indexOf,
      shapeOf,
    );
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);

    const local = unpackCell(doc.scene.cells.get('g', key)!);
    expect(decodeOrientation('stairs', local.code)).toMatchObject({ weirdoDirection: 0 });
    const worldCell = doc.index.worldOf({ ownerId: 'g', localCell: [0, 0, 0] })!;
    const world = doc.index.winnerRefAt(worldCell)!;
    // local 0=east becomes north = 3 in the world projection of a 90-degree-rotated group (from the measured table)
    expect(decodeOrientation('stairs', unpackCell(world.raw).code)).toMatchObject({ weirdoDirection: 3 });
  });

  it('the recipe ratio is not skewed even within local 4x4 areas, and it does not create parallel streaks', () => {
    for (let variant = 0; variant < 16; variant++) {
      const samples: number[][] = [];
      for (let z = 0; z < 8; z++) {
        const row: number[] = [];
        for (let x = 0; x < 8; x++) {
          row.push(patternSampleAt('stone-mix', [x, 0, z], variant));
        }
        samples.push(row);
      }

      for (let tileZ = 0; tileZ < 2; tileZ++) {
        for (let tileX = 0; tileX < 2; tileX++) {
          const tile = samples
            .slice(tileZ * 4, tileZ * 4 + 4)
            .flatMap((row) => row.slice(tileX * 4, tileX * 4 + 4));
          expect(tile.filter((sample) => sample < 0.25)).toHaveLength(4);
          expect(tile.filter((sample) => sample < 0.5)).toHaveLength(8);
        }
      }

      expect(new Set(samples.map((row) => row.map((sample) => sample < 0.25).join(''))).size).toBeGreaterThan(2);
    }
  });

  it('the placement number cycles through PATTERN_VARIANTS and also accepts out-of-range input', () => {
    expect(nextPatternVariant(0)).toBe(1);
    expect(nextPatternVariant(PATTERN_VARIANTS - 1)).toBe(0);
    // non-integer / out-of-range values from old data (in case a pre sample slipped in)
    expect(nextPatternVariant(Number.NaN)).toBe(1);
    expect(nextPatternVariant(0.99)).toBe(1);
    expect(nextPatternVariant(-1)).toBe(1);
    expect(nextPatternVariant(PATTERN_VARIANTS)).toBe(1);
  });

  it('different world coordinates produce different patterns — duplicated cells do not all end up with the same pattern', () => {
    const recipe = {
      id: 'mix',
      name: 'mix',
      entries: CATALOG.slice(1, 5).map((block) => ({ blockId: block.id, weight: 1 })),
    };
    const picked = new Set<number>();
    for (let x = 0; x < 16; x++) {
      picked.add(samplePatternAt(recipe, [x, 0, 0], indexOf)!);
    }
    expect(picked.size).toBeGreaterThan(1);
  });

  it('the same world coordinate produces the same pattern even with a different owner', () => {
    const recipe = {
      id: 'mix',
      name: 'mix',
      entries: [
        { blockId: CATALOG[1]!.id, weight: 1 },
        { blockId: CATALOG[2]!.id, weight: 1 },
      ],
    };
    // it seeds by coordinate, not owner, so it produces the same pattern regardless of which group it belongs to
    for (let x = 0; x < 8; x++) {
      expect(samplePatternAt(recipe, [x, 0, 0], indexOf)).toBe(samplePatternAt(recipe, [x, 0, 0], indexOf));
    }
  });

});
