import { describe, expect, it } from 'vitest';
import type { OwnerId } from '../src/core/cellref';
import { ownerPaintOrder } from '../src/core/sceneprojection';
import type { CellKey } from '../src/core/types';
import {
  layerRowKey,
  layerRowsInRange,
  rangeKeepsBothEnds,
  stepLayerCursor,
  visibleLayerRows,
  type LayerRow,
  type LayerRowsReader,
} from '../src/editor/layerrows';

/** A minimal reader that only has the tree and per-owner cells (looks at ordering only, without assembling a Document) */
function reader(
  children: Record<string, readonly string[]>,
  cells: Record<string, readonly string[]> = {},
): LayerRowsReader {
  const keyOf = (ownerId: OwnerId): string => ownerId ?? '@root';
  return {
    childrenOf: (parentId) => children[keyOf(parentId)] ?? [],
    localCellKeysOf: (ownerId) => (cells[keyOf(ownerId)] ?? []) as CellKey[],
  };
}

function keys(rows: readonly LayerRow[]): string[] {
  return rows.map(layerRowKey);
}

describe('visibleLayerRows', () => {
  it('the contents of a collapsed group do not appear in the list', () => {
    const r = reader({ '@root': ['a', 'b'], a: ['a1'] }, { a: ['0,0,0'] });
    expect(keys(visibleLayerRows(r, new Set()))).toEqual(['g:b', 'g:a']);
  });

  it('an expanded group descends in the order child groups → its own cells (same traversal order as render)', () => {
    const r = reader({ '@root': ['a', 'b'], a: ['a1'] }, { a: ['0,0,0'] });
    expect(keys(visibleLayerRows(r, new Set(['a'])))).toEqual(['g:b', 'g:a', 'g:a1', 'c:1|a|0,0,0']);
  });

  it('unclassified (owner = null) cells are listed at the end', () => {
    const r = reader({ '@root': ['a'] }, { '@root': ['1,0,0', '2,0,0'] });
    expect(keys(visibleLayerRows(r, new Set()))).toEqual(['g:a', 'c:-|1,0,0', 'c:-|2,0,0']);
  });

  it('deep nesting still only descends into expanded branches', () => {
    const r = reader({ '@root': ['a'], a: ['a1'], a1: ['a2'] });
    expect(keys(visibleLayerRows(r, new Set(['a'])))).toEqual(['g:a', 'g:a1']);
    expect(keys(visibleLayerRows(r, new Set(['a', 'a1'])))).toEqual(['g:a', 'g:a1', 'g:a2']);
  });
});

/**
 * The relationship between display order and paint order (#110). **Pinned in a form that
 * fails if it's ever flipped back.**
 *
 * Paint order (`ownerPaintOrder` in `core/sceneprojection.ts`) treats `childrenOf`'s
 * front→back as back→front, and puts unclassified cells (owner = null) furthest back.
 * Display is the reverse of that: **what's higher up is more in front**.
 *
 * However the whole thing isn't a complete reversal — group rows need to sit above their
 * own children, so only **the sibling ordering** gets reversed. These are the two points
 * pinned here.
 */
describe('relationship between display order and paint order (#110)', () => {
  /** An owner's paint rank (smaller = further back). null = unclassified cells are furthest back */
  const rankOf = (children: Record<string, readonly string[]>): Map<OwnerId, number> => {
    const order = ownerPaintOrder({ childrenOf: (parentId) => children[parentId ?? '@root'] ?? [] });
    return new Map(order.map((ownerId, index) => [ownerId, index]));
  };

  it('siblings display with the front-most one on top (reverse of paint order)', () => {
    const children = { '@root': ['a', 'b', 'c'] };
    const rank = rankOf(children);
    const groups = visibleLayerRows(reader(children), new Set()).map((row) =>
      row.kind === 'group' ? row.id : null,
    );

    expect(groups).toEqual(['c', 'b', 'a']);
    // the higher the row, the more in front = the larger the rank
    for (let i = 1; i < groups.length; i++) {
      expect(rank.get(groups[i - 1]!)!).toBeGreaterThan(rank.get(groups[i]!)!);
    }
  });

  it('child groups also display front-most on top, and a group row stays above its own children', () => {
    const children = { '@root': ['a'], a: ['a1', 'a2'] };
    const rank = rankOf(children);
    const groups = visibleLayerRows(reader(children), new Set(['a'])).map((row) =>
      row.kind === 'group' ? row.id : null,
    );

    // parent a sits above its children in the tree display (in rank terms a < a1 < a2, so it's not a complete reversal)
    expect(groups).toEqual(['a', 'a2', 'a1']);
    expect(rank.get('a2')!).toBeGreaterThan(rank.get('a1')!);
  });

  it('the furthest-back unclassified cells land at the very bottom of the list', () => {
    const children = { '@root': ['a'] };
    const rows = visibleLayerRows(reader(children, { '@root': ['1,0,0'] }), new Set());

    expect(keys(rows)).toEqual(['g:a', 'c:-|1,0,0']);
    expect(rankOf(children).get(null)).toBe(0); // furthest back in paint order
  });

  it("a group's own cells sit below its child groups (their rank is further back than descendants)", () => {
    const children = { '@root': ['a'], a: ['a1'] };
    const rank = rankOf(children);
    const rows = visibleLayerRows(reader(children, { a: ['0,0,0'] }), new Set(['a']));

    expect(keys(rows)).toEqual(['g:a', 'g:a1', 'c:1|a|0,0,0']);
    expect(rank.get('a1')!).toBeGreaterThan(rank.get('a')!);
  });
});

describe('stepLayerCursor — skips rows of a different kind (#43 provisional spec under that constraint)', () => {
  const rows = visibleLayerRows(
    reader({ '@root': ['a', 'b'], a: [] }, { a: ['0,0,0'], '@root': ['9,0,0'] }),
    new Set(['a']),
  );
  // ['g:b', 'g:a', 'c:1|a|0,0,0', 'c:-|9,0,0'] (display puts the front-most on top, so b comes first, #110)

  it('when stepping through group, skips cell rows in between', () => {
    expect(stepLayerCursor(rows, 0, 1, 'group')).toBe(1);
  });

  it('when stepping through cell, skips group rows in between', () => {
    expect(stepLayerCursor(rows, 2, 1, 'cell')).toBe(3);
  });

  it('steps by the same rule in reverse too', () => {
    expect(stepLayerCursor(rows, 3, -1, 'cell')).toBe(2);
    expect(stepLayerCursor(rows, 1, -1, 'group')).toBe(0);
  });

  it('returns null (boundary) once there are no more rows of the same kind', () => {
    expect(stepLayerCursor(rows, 1, 1, 'group')).toBeNull();
    expect(stepLayerCursor(rows, 0, -1, 'group')).toBeNull();
  });
});

describe('layerRowsInRange', () => {
  const rows = visibleLayerRows(
    reader({ '@root': ['a', 'b'], a: [] }, { a: ['0,0,0'], '@root': ['9,0,0'] }),
    new Set(['a']),
  );

  it('returns rows of the same kind in between in visual order, regardless of the anchor/cursor order', () => {
    expect(keys(layerRowsInRange(rows, 0, 1, 'group'))).toEqual(['g:b', 'g:a']);
    expect(keys(layerRowsInRange(rows, 1, 0, 'group'))).toEqual(['g:b', 'g:a']);
  });

  it('drops rows of a different kind even if they fall within the range', () => {
    expect(keys(layerRowsInRange(rows, 0, 3, 'cell'))).toEqual(['c:1|a|0,0,0', 'c:-|9,0,0']);
  });

  it('returns 1 item when anchor and cursor are the same', () => {
    expect(keys(layerRowsInRange(rows, 1, 1, 'group'))).toEqual(['g:a']);
  });
});


describe("don't select a parent and child group at the same time (#49 review P1)", () => {
  // parent p (expanded) > child c, followed by sibling s. normalizeSelection keeps only the
  // outermost, so putting p and c into the range at the same time drops c = it must not be a
  // valid cursor destination
  const rows = visibleLayerRows(reader({ '@root': ['p', 's'], p: ['c'] }), new Set(['p']));
  // ['g:s', 'g:p', 'g:c'] — sibling s is in front of p, so it comes out on top (#110)
  const isAncestor = (a: string, b: string): boolean => a === 'p' && b === 'c';

  it('premise: order is sibling → parent → child', () => {
    expect(keys(rows)).toEqual(['g:s', 'g:p', 'g:c']);
  });

  it('a parent/child combination does not keep both ends', () => {
    expect(rangeKeepsBothEnds(rows, 1, 2, isAncestor)).toBe(false);
    expect(rangeKeepsBothEnds(rows, 2, 1, isAncestor)).toBe(false);
  });

  it('a parent/sibling combination keeps both ends (the child in between may drop)', () => {
    expect(rangeKeepsBothEnds(rows, 1, 0, isAncestor)).toBe(true);
  });

  it('moving from the parent toward the sibling side (up) skips the child and goes to the sibling', () => {
    const skip = (_row: LayerRow, i: number): boolean => !rangeKeepsBothEnds(rows, 1, i, isAncestor);
    expect(stepLayerCursor(rows, 1, -1, 'group', skip)).toBe(0);
    // below there is only the child, and parent/child can't be selected together, so it's treated as a boundary
    expect(stepLayerCursor(rows, 1, 1, 'group', skip)).toBeNull();
  });

  it("moving up from the child can't select the parent (because the child would drop) — treated as a boundary", () => {
    const skip = (_row: LayerRow, i: number): boolean => !rangeKeepsBothEnds(rows, 2, i, isAncestor);
    expect(stepLayerCursor(rows, 2, -1, 'group', skip)).toBeNull();
  });

  it('layerRowsInRange drops descendants within the range (to match the actual Selection)', () => {
    expect(keys(layerRowsInRange(rows, 0, 2, 'group', isAncestor))).toEqual(['g:s', 'g:p']);
  });

  it('without passing isAncestor, it passes everything through as before', () => {
    expect(keys(layerRowsInRange(rows, 0, 2, 'group'))).toEqual(['g:s', 'g:p', 'g:c']);
  });
});


describe('visibleLayerRows — filtering (#45)', () => {
  // root > a (> a1 > cell) / b, plus 1 unclassified cell
  const r = reader({ '@root': ['a', 'b'], a: ['a1'] }, { a1: ['0,0,0'], '@root': ['9,0,0'] });
  const only = (...wanted: string[]): ((row: LayerRow) => boolean) => (row) =>
    wanted.includes(layerRowKey(row));

  it('ancestors of a matched group remain (so they stay reachable)', () => {
    expect(keys(visibleLayerRows(r, new Set(), only('g:a1')))).toEqual(['g:a', 'g:a1']);
  });

  it('while filtering, descends ignoring collapsed state', () => {
    // expandedIds is empty, but it still descends down to a1
    expect(keys(visibleLayerRows(r, new Set(), only('c:2|a1|0,0,0')))).toEqual(['g:a', 'g:a1', 'c:2|a1|0,0,0']);
  });

  it('a group that matches itself remains even if its children do not match (children are not shown)', () => {
    expect(keys(visibleLayerRows(r, new Set(), only('g:a')))).toEqual(['g:a']);
  });

  it('unclassified cells are also subject to filtering', () => {
    expect(keys(visibleLayerRows(r, new Set(), only('c:-|9,0,0')))).toEqual(['c:-|9,0,0']);
  });

  it('returns empty if nothing matches (the caller produces "no match")', () => {
    expect(visibleLayerRows(r, new Set(), () => false)).toEqual([]);
  });

  it('without a predicate, follows collapsed state as before', () => {
    expect(keys(visibleLayerRows(r, new Set()))).toEqual(['g:b', 'g:a', 'c:-|9,0,0']);
  });
});
