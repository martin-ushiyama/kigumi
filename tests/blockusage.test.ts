import { describe, expect, it } from 'vitest';
import type { OwnerId } from '../src/core/cellref';
import { packCell, unpackCell } from '../src/core/orientation';
import { buildIndexOf, isDrawableRecipe, sampleRecipe } from '../src/core/mixpalette';
import { PatternPaintStore } from '../src/core/patternpaint';
import { Document } from '../src/core/document';
import { makeCellKey } from '../src/core/cell';
import { OwnerVoxelStore } from '../src/core/ownervoxels';
import { SceneTree } from '../src/core/scenetree';
import { collectBlockAndPatternUsage, collectBlockUsage, totalBlockCount, type BlockUsageReader } from '../src/editor/blockusage';
import { OP_MAX_CELLS } from '../src/core/limits';
import { buildReplaceUsage } from '../src/editor/ops';
import { DocumentFixture } from './helpers/document-fixture';

/** A minimal reader holding only per-owner cells (looks at the aggregation only, without assembling a Document) */
function reader(cells: Record<string, [string, number][]>, children: Record<string, string[]> = {}): BlockUsageReader {
  const key = (o: OwnerId): string => o ?? '@root';
  return {
    entriesOf: (o) => (cells[key(o)] ?? []),
    owners: () => Object.keys(cells).map((k) => (k === '@root' ? null : k)),
    ownersOfSubtree: (id) => {
      const out: OwnerId[] = [id];
      const walk = (p: string): void => {
        for (const c of children[p] ?? []) {
          out.push(c);
          walk(c);
        }
      };
      walk(id);
      return out;
    },
  };
}

describe('collectBlockUsage', () => {
  it('folds different orientations together and counts them as the same block', () => {
    // the same catalogIndex 3, 3 of them with code 0 / 1 / 2
    const r = reader({ '@root': [['0,0,0', packCell(3, 0)], ['1,0,0', packCell(3, 1)], ['2,0,0', packCell(3, 2)]] });
    expect(collectBlockUsage(r, { kind: 'world' })).toEqual([{ catalogIndex: 3, count: 3 }]);
  });

  it('sorts by usage count descending, then by catalogIndex ascending on ties', () => {
    const r = reader({
      '@root': [['0,0,0', packCell(5, 0)]],
      a: [['0,0,0', packCell(2, 0)], ['1,0,0', packCell(2, 0)]],
      b: [['0,0,0', packCell(1, 0)]],
    });
    expect(collectBlockUsage(r, { kind: 'world' })).toEqual([
      { catalogIndex: 2, count: 2 },
      { catalogIndex: 1, count: 1 },
      { catalogIndex: 5, count: 1 },
    ]);
  });

  it('a group scope only counts the subtree (excludes unclassified cells and other groups)', () => {
    const r = reader(
      {
        '@root': [['0,0,0', packCell(9, 0)]],
        p: [['0,0,0', packCell(1, 0)]],
        c: [['0,0,0', packCell(1, 0)], ['1,0,0', packCell(2, 0)]],
        other: [['0,0,0', packCell(1, 0)]],
      },
      { p: ['c'] },
    );
    expect(collectBlockUsage(r, { kind: 'groups', ids: ['p'] })).toEqual([
      { catalogIndex: 1, count: 2 },
      { catalogIndex: 2, count: 1 },
    ]);
  });

  it('does not double-count when passing a parent and its child at the same time', () => {
    const r = reader({ p: [['0,0,0', packCell(1, 0)]], c: [['0,0,0', packCell(1, 0)]] }, { p: ['c'] });
    expect(collectBlockUsage(r, { kind: 'groups', ids: ['p', 'c'] })).toEqual([{ catalogIndex: 1, count: 2 }]);
  });

  it('an overlap (the same world coordinate held by different owners) counts as 1 each', () => {
    // 2 owners hold the same local 0,0,0 = only 1 is visible, but the work contains 2
    const r = reader({ '@root': [['0,0,0', packCell(1, 0)]], g: [['0,0,0', packCell(1, 0)]] });
    expect(collectBlockUsage(r, { kind: 'world' })).toEqual([{ catalogIndex: 1, count: 2 }]);
  });

  it('an empty input gives an empty array, with a total of 0', () => {
    const r = reader({});
    expect(collectBlockUsage(r, { kind: 'world' })).toEqual([]);
    expect(totalBlockCount([])).toBe(0);
  });
});

describe('collectBlockAndPatternUsage', () => {
  it('separates pattern cells from regular blocks in a single pass, without double-counting', () => {
    const r = reader({
      '@root': [
        ['0,0,0', packCell(1, 0)],
        ['1,0,0', packCell(1, 0)],
        ['2,0,0', packCell(2, 0)],
      ],
    });
    let visits = 0;
    const usage = collectBlockAndPatternUsage(r, { kind: 'world' }, (_owner, key) => {
      visits++;
      return key === '0,0,0' ? 'mix' : null;
    });

    expect(visits).toBe(3);
    expect(usage).toEqual({
      blocks: [{ catalogIndex: 1, count: 1 }, { catalogIndex: 2, count: 1 }],
      patterns: [{ recipeId: 'mix', count: 1 }],
    });
  });
});

describe('buildReplaceUsage', () => {
  const FULL = () => 'full' as const;

  function docWith(cells: [number, number, number, number][]): DocumentFixture {
    const doc = new DocumentFixture();
    doc.setCells(cells);
    return doc;
  }

  it('replaces only the targets within scope, bundled into 1 transaction', () => {
    const doc = docWith([
      [0, 0, 0, packCell(1, 0)],
      [1, 0, 0, packCell(1, 0)],
      [2, 0, 0, packCell(7, 0)],
    ]);
    const result = buildReplaceUsage(doc, [null], 1, () => 4, FULL);
    if ('error' in result) throw new Error(result.error);
    expect(result.tx.ops).toHaveLength(2);
    doc.applyTransaction(result.tx);
    expect(unpackCell(doc.world.get(0, 0, 0)!).catalogIndex).toBe(4);
    expect(unpackCell(doc.world.get(1, 0, 0)!).catalogIndex).toBe(4);
    expect(unpackCell(doc.world.get(2, 0, 0)!).catalogIndex).toBe(7); // out-of-scope stays unchanged

    doc.undo();
    expect(unpackCell(doc.world.get(0, 0, 0)!).catalogIndex).toBe(1);
  });

  it('carries orientation over when the shape stays the same', () => {
    const doc = docWith([[0, 0, 0, packCell(1, 2)]]); // code 2
    const result = buildReplaceUsage(doc, [null], 1, () => 4, FULL);
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);
    expect(unpackCell(doc.world.get(0, 0, 0)!)).toEqual({ catalogIndex: 4, code: 2 });
  });

  it('falls back to the default orientation when the shape changes (since code means different things per shape)', () => {
    const doc = docWith([[0, 0, 0, packCell(1, 3)]]);
    const shapeOf = (i: number) => (i === 1 ? ('stairs' as const) : ('slab' as const));
    const result = buildReplaceUsage(doc, [null], 1, () => 4, shapeOf);
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);
    expect(unpackCell(doc.world.get(0, 0, 0)!)).toEqual({ catalogIndex: 4, code: 0 });
  });

  it('bakes the drawn result into the op for pattern painting, so undo → redo produces the same result', () => {
    const doc = docWith([
      [0, 0, 0, packCell(1, 0)],
      [1, 0, 0, packCell(1, 0)],
      [2, 0, 0, packCell(1, 0)],
    ]);
    const picks = [4, 5, 6];
    let i = 0;
    const result = buildReplaceUsage(doc, [null], 1, () => picks[i++ % picks.length]!, FULL);
    if ('error' in result) throw new Error(result.error);
    doc.applyTransaction(result.tx);
    const after = [0, 1, 2].map((x) => doc.world.get(x, 0, 0));

    doc.undo();
    doc.redo();
    expect([0, 1, 2].map((x) => doc.world.get(x, 0, 0))).toEqual(after);
  });

  it('skips a cell when pick returns null (when a recipe could not be drawn)', () => {
    const doc = docWith([
      [0, 0, 0, packCell(1, 0)],
      [1, 0, 0, packCell(1, 0)],
    ]);
    let n = 0;
    const result = buildReplaceUsage(doc, [null], 1, () => (n++ === 0 ? 4 : null), FULL);
    if ('error' in result) throw new Error(result.error);
    expect(result.tx.ops).toHaveLength(1);
  });

  it('a replacement with the same block adds no op', () => {
    const doc = docWith([[0, 0, 0, packCell(1, 0)]]);
    expect('error' in buildReplaceUsage(doc, [null], 1, () => 1, FULL)).toBe(true);
  });

  it('a cell with a valid pattern binding is excluded from regular-block replacement targets even with the same raw value', () => {
    const raw = packCell(1, 0);
    const cells = new OwnerVoxelStore();
    cells.set(null, makeCellKey(0, 0, 0), raw);
    cells.set(null, makeCellKey(1, 0, 0), raw);
    const patterns = new PatternPaintStore();
    patterns.set(
      { ownerId: null, localCell: [0, 0, 0] },
      { recipeId: 'stone-mix', variant: 0, sourceRaw: raw, appliedRaw: raw },
    );
    const doc = new Document({ tree: new SceneTree(), cells, patterns }, FULL);

    const result = buildReplaceUsage(doc, [null], 1, () => 4, FULL);
    if ('error' in result) throw new Error(result.error);
    expect(result.tx.ops).toEqual([
      { kind: 'voxel', owner: null, key: '1,0,0', before: raw, after: packCell(4, 0) },
    ]);
  });

  it('locked groups are excluded from targets. if only locked groups are present, returns the reason', () => {
    const doc = new DocumentFixture();
    doc.insertGroup({ id: 'l', name: 'locked', parentId: null, childIds: [], locked: true }, 0);
    doc.setOwnerCells('l', [['0,0,0', packCell(1, 0)]]);
    const result = buildReplaceUsage(doc, ['l'], 1, () => 4, FULL);
    expect('error' in result && result.error).toBe('onlyLockedGroups');
  });

  it('gives an error when there are no targets (never silently returns an empty tx)', () => {
    const doc = docWith([[0, 0, 0, packCell(9, 0)]]);
    expect('error' in buildReplaceUsage(doc, [null], 1, () => 4, FULL)).toBe(true);
  });
});

describe('isDrawableRecipe — "selected" and "drawable" are different things (#48 review P1)', () => {
  const catalog = [
    { id: 'a', nameJa: 'A', category: 'stone', color: '#000', shape: 'full' },
    { id: 'b', nameJa: 'B', category: 'stone', color: '#111', shape: 'full' },
  ] as never as Parameters<typeof buildIndexOf>[0];
  const indexOf = buildIndexOf(catalog);

  it('entries is empty = not drawable (the state right after RecipeStore.create())', () => {
    expect(isDrawableRecipe({ id: 'r', name: 'New', entries: [] }, indexOf)).toBe(false);
  });

  it('only weight <= 0 entries = not drawable', () => {
    expect(isDrawableRecipe({ id: 'r', name: 'x', entries: [{ blockId: 'a', weight: 0 }] }, indexOf)).toBe(false);
  });

  it('only a blockId not in the catalog = not drawable', () => {
    expect(isDrawableRecipe({ id: 'r', name: 'x', entries: [{ blockId: 'zzz', weight: 1 }] }, indexOf)).toBe(false);
  });

  it('drawable if even 1 valid entry exists (invalid ones may be mixed in)', () => {
    expect(
      isDrawableRecipe(
        { id: 'r', name: 'x', entries: [{ blockId: 'zzz', weight: 1 }, { blockId: 'b', weight: 2 }] },
        indexOf,
      ),
    ).toBe(true);
  });
});

describe('buildReplaceUsage — cuts off at the limit (#48 review P2)', () => {
  it('returns an error without assembling everything once OP_MAX_CELLS is exceeded', () => {
    const doc = new DocumentFixture();
    const cells: [number, number, number, number][] = [];
    // lay out limit + 2 cells (a single row would hit the coordinate limit, so spread them on a plane)
    const side = Math.ceil(Math.sqrt(OP_MAX_CELLS + 2));
    let n = 0;
    for (let x = 0; x < side && n < OP_MAX_CELLS + 2; x++)
      for (let z = 0; z < side && n < OP_MAX_CELLS + 2; z++, n++) cells.push([x, 0, z, packCell(1, 0)]);
    doc.setCells(cells);

    let picks = 0;
    const result = buildReplaceUsage(doc, [null], 1, () => {
      picks++;
      return 4;
    }, () => 'full');

    expect('error' in result && result.error).toContain('tooManyTargets');
    // **since it cuts off, the draw doesn't run far past the limit**
    expect(picks).toBeLessThanOrEqual(OP_MAX_CELLS + 1);
  });
});

describe('isDrawableRecipe and sampleRecipe operate under the same conditions (#48 review round 2)', () => {
  const catalog = [
    { id: 'a', nameJa: 'A', category: 'stone', color: '#000', shape: 'full' },
    { id: 'b', nameJa: 'B', category: 'stone', color: '#111', shape: 'full' },
  ] as never as Parameters<typeof buildIndexOf>[0];
  const indexOf = buildIndexOf(catalog);

  // Lines up boundary cases to confirm "can be pressed = can be drawn" always agrees.
  // If the condition is split across 2 places, one of these would catch a mismatch
  const cases: { name: string; entries: { blockId: string; weight: number }[] }[] = [
    { name: 'empty', entries: [] },
    { name: 'weight 0 only', entries: [{ blockId: 'a', weight: 0 }] },
    { name: 'negative weight only', entries: [{ blockId: 'a', weight: -1 }] },
    { name: 'outside catalog only', entries: [{ blockId: 'zzz', weight: 5 }] },
    { name: 'invalid + valid', entries: [{ blockId: 'zzz', weight: 5 }, { blockId: 'b', weight: 1 }] },
    { name: 'valid only', entries: [{ blockId: 'a', weight: 2 }] },
  ];

  for (const c of cases) {
    it(`${c.name}: isDrawableRecipe's result agrees with whether sampleRecipe can draw`, () => {
      const recipe = { id: 'r', name: c.name, entries: c.entries };
      const drawable = isDrawableRecipe(recipe, indexOf);
      // whether it can be drawn should not change even at either extreme of rng
      const drawnLow = sampleRecipe(recipe, indexOf, () => 0);
      const drawnHigh = sampleRecipe(recipe, indexOf, () => 0.999);
      expect(drawnLow !== null).toBe(drawable);
      expect(drawnHigh !== null).toBe(drawable);
    });
  }
});
