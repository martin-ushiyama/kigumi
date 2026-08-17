import { describe, expect, it } from 'vitest';
import type { CellRef } from '../src/core/cellref';
import { buildIndexOf } from '../src/core/mixpalette';
import type { MixRecipe } from '../src/core/mixpalette';
import { packCell, unpackCell } from '../src/core/orientation';
import { makeCellKey } from '../src/core/cell';
import { Document } from '../src/core/document';
import { OwnerVoxelStore } from '../src/core/ownervoxels';
import { PatternPaintStore } from '../src/core/patternpaint';
import { SceneTree } from '../src/core/scenetree';
import { buildReplaceSelection } from '../src/editor/ops';

/**
 * Repainting a selection (#64 PR-C).
 *
 * The existing `buildReplaceUsage` could only scope to "cells within a group whose block
 * type matches `from`", so **changing the texture of just part of a wall** wasn't possible.
 * This fills that granularity gap.
 *
 * The replacement semantics (carrying over orientation / limits / lock protection) are a
 * contract shared with the existing behavior, so those are pinned down here too.
 */

const FULL = () => 'full' as const;

/** Built with a PatternPaintStore so pattern bindings can be handled */
function docWith(cells: [number, number, number, number][]): Document {
  const store = new OwnerVoxelStore();
  for (const [x, y, z, raw] of cells) store.set(null, makeCellKey(x, y, z), raw);
  return new Document({ tree: new SceneTree(), cells: store, patterns: new PatternPaintStore() }, FULL);
}

/** A cell ref directly under root (DocumentFixture uses owner=null world coordinates directly as local) */
function ref(x: number, y: number, z: number): CellRef {
  return { ownerId: null, localCell: [x, y, z] };
}

const RECIPE: MixRecipe = {
  id: 'mix',
  name: 'Test Blend',
  entries: [{ blockId: 'b4', weight: 1 }],
};

/** blockId → catalogIndex. The recipe always resolves to index 4 */
const indexOf = (blockId: string): number | undefined =>
  blockId === 'b4' ? 4 : blockId === 'b9' ? 9 : undefined;

function blockAt(doc: Document, x: number, y: number, z: number): number | null {
  const raw = doc.world.get(x, y, z);
  return raw === null ? null : unpackCell(raw).catalogIndex;
}

describe('buildReplaceSelection — scope', () => {
  it("repaints only the selected cells (doesn't touch outside the same group)", () => {
    const doc = docWith([
      [0, 0, 0, packCell(1, 0)],
      [1, 0, 0, packCell(1, 0)],
      [2, 0, 0, packCell(1, 0)],
    ]);
    const result = buildReplaceSelection(doc, [ref(0, 0, 0), ref(1, 0, 0)], {
      from: null,
      replacement: { kind: 'block', catalogIndex: 4 },
      indexOf,
      shapeOf: FULL,
    });
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);

    expect(blockAt(doc, 0, 0, 0)).toBe(4);
    expect(blockAt(doc, 1, 0, 0)).toBe(4);
    expect(blockAt(doc, 2, 0, 0)).toBe(1); // unchanged outside the selection

    doc.undo();
    expect(blockAt(doc, 0, 0, 0)).toBe(1);
  });

  it('specifying from repaints only that block type within the selection', () => {
    const doc = docWith([
      [0, 0, 0, packCell(1, 0)],
      [1, 0, 0, packCell(7, 0)],
    ]);
    const result = buildReplaceSelection(doc, [ref(0, 0, 0), ref(1, 0, 0)], {
      from: 1,
      replacement: { kind: 'block', catalogIndex: 4 },
      indexOf,
      shapeOf: FULL,
    });
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);

    expect(blockAt(doc, 0, 0, 0)).toBe(4);
    expect(blockAt(doc, 1, 0, 0)).toBe(7); // out of scope because the type differs
  });

  it("from = null targets everything within the selection (doesn't filter by type)", () => {
    const doc = docWith([
      [0, 0, 0, packCell(1, 0)],
      [1, 0, 0, packCell(7, 0)],
    ]);
    const result = buildReplaceSelection(doc, [ref(0, 0, 0), ref(1, 0, 0)], {
      from: null,
      replacement: { kind: 'block', catalogIndex: 4 },
      indexOf,
      shapeOf: FULL,
    });
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);

    expect(blockAt(doc, 0, 0, 0)).toBe(4);
    expect(blockAt(doc, 1, 0, 0)).toBe(4);
  });

  it('processes the same ref only once even if it appears twice (a selection mixing cells and groups)', () => {
    const doc = docWith([[0, 0, 0, packCell(1, 0)]]);
    const result = buildReplaceSelection(doc, [ref(0, 0, 0), ref(0, 0, 0)], {
      from: null,
      replacement: { kind: 'block', catalogIndex: 4 },
      indexOf,
      shapeOf: FULL,
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.tx.ops).toHaveLength(1);
  });

  it('drops a nonexistent ref', () => {
    const doc = docWith([[0, 0, 0, packCell(1, 0)]]);
    const result = buildReplaceSelection(doc, [ref(0, 0, 0), ref(9, 9, 9)], {
      from: null,
      replacement: { kind: 'block', catalogIndex: 4 },
      indexOf,
      shapeOf: FULL,
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.tx.ops).toHaveLength(1);
  });

  it('noBlocksToReplace when there is nothing to target', () => {
    const doc = docWith([[0, 0, 0, packCell(1, 0)]]);
    const result = buildReplaceSelection(doc, [ref(0, 0, 0)], {
      from: 7, // no matching type
      replacement: { kind: 'block', catalogIndex: 4 },
      indexOf,
      shapeOf: FULL,
    });
    expect(result).toEqual({ error: 'noBlocksToReplace' });
  });

  it('does not push an op when the replacement target matches the current state', () => {
    const doc = docWith([[0, 0, 0, packCell(4, 0)]]);
    const result = buildReplaceSelection(doc, [ref(0, 0, 0)], {
      from: null,
      replacement: { kind: 'block', catalogIndex: 4 },
      indexOf,
      shapeOf: FULL,
    });
    expect(result).toEqual({ error: 'noBlocksToReplace' });
  });
});

describe('buildReplaceSelection — carrying over orientation (same contract as buildReplaceUsage)', () => {
  it('carries over the orientation code when the shape is the same', () => {
    const doc = docWith([[0, 0, 0, packCell(1, 2)]]);
    const result = buildReplaceSelection(doc, [ref(0, 0, 0)], {
      from: null,
      replacement: { kind: 'block', catalogIndex: 4 },
      indexOf,
      shapeOf: FULL,
    });
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);
    expect(unpackCell(doc.world.get(0, 0, 0)!)).toEqual({ catalogIndex: 4, code: 2 });
  });

  it('falls back to the default orientation when the shape changes (the meaning of the code differs per shape)', () => {
    const shapeOf = (i: number) => (i === 1 ? ('stairs' as const) : ('slab' as const));
    const store = new OwnerVoxelStore();
    store.set(null, makeCellKey(0, 0, 0), packCell(1, 3));
    const doc = new Document({ tree: new SceneTree(), cells: store, patterns: new PatternPaintStore() }, shapeOf);
    const result = buildReplaceSelection(doc, [ref(0, 0, 0)], {
      from: null,
      replacement: { kind: 'block', catalogIndex: 4 },
      indexOf,
      shapeOf,
    });
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);
    expect(unpackCell(doc.world.get(0, 0, 0)!).code).toBe(0);
  });
});

/**
 * Since #60, pattern painting isn't baked into a concrete block but held as a recipe reference
 * (binding). Leaving the binding untouched on repaint means a live recipe can later repaint
 * over it and **the change gets rolled back**.
 */
describe('buildReplaceSelection — pattern binding', () => {
  it('painting with a mix recipe attaches the binding within the same transaction', () => {
    const doc = docWith([[0, 0, 0, packCell(1, 0)]]);
    const result = buildReplaceSelection(doc, [ref(0, 0, 0)], {
      from: null,
      replacement: { kind: 'pattern', recipe: RECIPE },
      indexOf,
      shapeOf: FULL,
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.tx.ops.some((op) => op.kind === 'setPattern')).toBe(true);

    doc.applyTransaction(result.tx);
    expect(blockAt(doc, 0, 0, 0)).toBe(4);
    expect(doc.scene.patterns?.get(null, '0,0,0')?.recipeId).toBe('mix');
  });

  it("repainting to a single block strips the binding (won't be reverted by a live recipe)", () => {
    const doc = docWith([[0, 0, 0, packCell(1, 0)]]);
    // first attach the pattern
    const applied = buildReplaceSelection(doc, [ref(0, 0, 0)], {
      from: null,
      replacement: { kind: 'pattern', recipe: RECIPE },
      indexOf,
      shapeOf: FULL,
    });
    if ('error' in applied) throw new Error(applied.error);
    doc.applyTransaction(applied.tx);
    expect(doc.scene.patterns?.get(null, '0,0,0')).toBeTruthy();

    const replaced = buildReplaceSelection(doc, [ref(0, 0, 0)], {
      from: null,
      replacement: { kind: 'block', catalogIndex: 7 },
      indexOf,
      shapeOf: FULL,
    });
    if ('error' in replaced) throw new Error(replaced.error);
    doc.applyTransaction(replaced.tx);

    expect(blockAt(doc, 0, 0, 0)).toBe(7);
    expect(doc.scene.patterns?.get(null, '0,0,0') ?? null).toBe(null);
  });

  it("stripping the binding is undone by undo (it's in the same transaction)", () => {
    const doc = docWith([[0, 0, 0, packCell(1, 0)]]);
    const applied = buildReplaceSelection(doc, [ref(0, 0, 0)], {
      from: null,
      replacement: { kind: 'pattern', recipe: RECIPE },
      indexOf,
      shapeOf: FULL,
    });
    if ('error' in applied) throw new Error(applied.error);
    doc.applyTransaction(applied.tx);

    const replaced = buildReplaceSelection(doc, [ref(0, 0, 0)], {
      from: null,
      replacement: { kind: 'block', catalogIndex: 7 },
      indexOf,
      shapeOf: FULL,
    });
    if ('error' in replaced) throw new Error(replaced.error);
    doc.applyTransaction(replaced.tx);
    doc.undo();

    expect(doc.scene.patterns?.get(null, '0,0,0')?.recipeId).toBe('mix');
  });

  /**
   * #64 PR-C review, round 2: `sourceRaw` is **the source of truth for orientation before the
   * pattern was applied**. For a cell that already has a binding, the raw in `cells` is the
   * current appliedRaw (the save fallback), so overwriting from there loses the original
   * orientation (east-facing stairs → pattern A turns it into a full block → switching to
   * pattern B → even editing B's recipe back to stairs won't restore the east-facing orientation).
   */
  it('normal cell → pattern uses the current raw as sourceRaw', () => {
    const doc = docWith([[0, 0, 0, packCell(1, 3)]]); // orientation code 3
    const result = buildReplaceSelection(doc, [ref(0, 0, 0)], {
      from: null,
      replacement: { kind: 'pattern', recipe: RECIPE },
      indexOf,
      shapeOf: FULL,
    });
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);
    expect(doc.scene.patterns?.get(null, '0,0,0')?.sourceRaw).toBe(packCell(1, 3));
  });

  it("pattern → pattern carries over the existing sourceRaw (doesn't rebake the orientation source of truth)", () => {
    const original = packCell(1, 3);
    const doc = docWith([[0, 0, 0, original]]);

    const first = buildReplaceSelection(doc, [ref(0, 0, 0)], {
      from: null,
      replacement: { kind: 'pattern', recipe: RECIPE },
      indexOf,
      shapeOf: FULL,
    });
    if ('error' in first) throw new Error(first.error);
    doc.applyTransaction(first.tx);
    const afterFirst = doc.scene.cells.get(null, '0,0,0');
    expect(afterFirst, 'at this point the saved raw has been replaced by appliedRaw').not.toBe(original);

    const second = buildReplaceSelection(doc, [ref(0, 0, 0)], {
      from: null,
      replacement: { kind: 'pattern', recipe: { id: 'mix2', name: 'Another Blend', entries: [{ blockId: 'b9', weight: 1 }] } },
      indexOf,
      shapeOf: FULL,
    });
    if ('error' in second) throw new Error(second.error);
    doc.applyTransaction(second.tx);

    const paint = doc.scene.patterns?.get(null, '0,0,0');
    expect(paint?.recipeId).toBe('mix2');
    expect(paint?.sourceRaw, 'the pre-application orientation source of truth is preserved').toBe(original);
  });

  it('pushes nothing when not a single recipe entry resolves', () => {
    const doc = docWith([[0, 0, 0, packCell(1, 0)]]);
    const result = buildReplaceSelection(doc, [ref(0, 0, 0)], {
      from: null,
      replacement: { kind: 'pattern', recipe: { id: 'empty', name: 'Empty', entries: [] } },
      indexOf,
      shapeOf: FULL,
    });
    expect(result).toEqual({ error: 'noBlocksToReplace' });
  });
});

describe('buildReplaceSelection — limits', () => {
  it('a recipe whose blockId cannot resolve to an index is not targeted', () => {
    const doc = docWith([[0, 0, 0, packCell(1, 0)]]);
    const result = buildReplaceSelection(doc, [ref(0, 0, 0)], {
      from: null,
      replacement: { kind: 'pattern', recipe: { id: 'x', name: 'x', entries: [{ blockId: 'unknown', weight: 1 }] } },
      indexOf: buildIndexOf([]),
      shapeOf: FULL,
    });
    expect(result).toEqual({ error: 'noBlocksToReplace' });
  });
});

/**
 * #64 PR-C review: the raw in `scene.cells` is the live pattern's **save fallback**. It doesn't
 * get rewritten when the recipe's ratios are edited, so judging the type from there
 * **targets a different type than what's shown on screen**.
 */
describe("buildReplaceSelection — after editing a live pattern's ratio", () => {
  /** A Document with resolveLocalRaw injected (same shape as main.ts) */
  function docWithLiveRecipe(recipes: Map<string, MixRecipe>): Document {
    const store = new OwnerVoxelStore();
    store.set(null, makeCellKey(0, 0, 0), packCell(1, 0)); // the save fallback is index 1
    const patterns = new PatternPaintStore();
    patterns.set(
      { ownerId: null, localCell: [0, 0, 0] },
      { recipeId: 'mix', variant: 0, sourceRaw: packCell(1, 0), appliedRaw: packCell(1, 0) },
    );
    return new Document({ tree: new SceneTree(), cells: store, patterns }, FULL, (ref, raw) => {
      const paint = patterns.get(ref.ownerId, makeCellKey(ref.localCell[0], ref.localCell[1], ref.localCell[2]));
      if (!paint) return raw;
      const recipe = recipes.get(paint.recipeId);
      if (!recipe) return raw;
      // the block currently resolved after ratio editing (fixed to the first entry is enough for the test)
      const index = indexOf(recipe.entries[0]!.blockId);
      return index === undefined ? raw : packCell(index, 0);
    });
  }

  it('filtering applies to the displayed type, not the save fallback', () => {
    const recipes = new Map<string, MixRecipe>([['mix', RECIPE]]); // b4 → index 4
    const doc = docWithLiveRecipe(recipes);

    // not targeted by the fallback type (1)
    expect(
      buildReplaceSelection(doc, [ref(0, 0, 0)], {
        from: 1,
        replacement: { kind: 'block', catalogIndex: 7 },
        indexOf,
        shapeOf: FULL,
      }),
    ).toEqual({ error: 'noBlocksToReplace' });

    // targeted by the displayed type (4)
    const hit = buildReplaceSelection(doc, [ref(0, 0, 0)], {
      from: 4,
      replacement: { kind: 'block', catalogIndex: 7 },
      indexOf,
      shapeOf: FULL,
    });
    if ('error' in hit) throw new Error(hit.error);
    doc.applyTransaction(hit.tx);
    expect(blockAt(doc, 0, 0, 0)).toBe(7);
  });

  it('changing the ratio to change the displayed block also changes what the filter hits', () => {
    const recipes = new Map<string, MixRecipe>([['mix', RECIPE]]);
    const doc = docWithLiveRecipe(recipes);
    // a situation where ratio editing changed the resolved block to b9 (index 9)
    recipes.set('mix', { id: 'mix', name: 'Test Blend', entries: [{ blockId: 'b9', weight: 1 }] });
    doc.refreshDerived();

    expect(
      buildReplaceSelection(doc, [ref(0, 0, 0)], {
        from: 4,
        replacement: { kind: 'block', catalogIndex: 7 },
        indexOf,
        shapeOf: FULL,
      }),
      'no longer hits on the pre-edit type',
    ).toEqual({ error: 'noBlocksToReplace' });

    const hit = buildReplaceSelection(doc, [ref(0, 0, 0)], {
      from: 9,
      replacement: { kind: 'block', catalogIndex: 7 },
      indexOf,
      shapeOf: FULL,
    });
    expect('error' in hit).toBe(false);
  });
});
