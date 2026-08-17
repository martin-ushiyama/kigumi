import { makeCellRefKey, type CellRef, type OwnerId } from '../core/cellref';
import { parseCellKey, type CellKey } from '../core/types';

/**
 * The order of rows **as visible** in the layer panel.
 *
 * Previously, row order was decided by `layers.ts`'s `render()` while it built the DOM,
 * with no way to reference the order itself. Implementing "move to the row above/below"
 * with the keyboard needs that order, so it's factored out here independent of the DOM.
 */
export type LayerRowRef = { kind: 'group'; id: string } | { kind: 'cell'; ref: CellRef };

/** A single row in the ordering. `depth` is the indent level (rendering only, not part of identity) */
export type LayerRow = LayerRowRef & { depth: number };

/** Minimal port required by `visibleLayerRows` (Document's Reader type satisfies it structurally) */
export interface LayerRowsReader {
  childrenOf(parentId: string | null): readonly string[];
  localCellKeysOf(ownerId: OwnerId): Iterable<CellKey>;
  /**
   * Is this a component instance? A query used to **not expose its contents as
   * rows**.
   *
   * The inside is a copy of the component, and editing it gets overwritten the moment
   * the component itself is edited. Exposing it would show something "editable but
   * won't persist." Optional (if omitted, everything is treated as a plain group).
   */
  isInstance?(id: string): boolean;
}

/**
 * Whether a row survives filtering. The name-holder is `layers.ts` (group names /
 * block names), so this only accepts a predicate and filters **without knowing any
 * names**.
 */
export type LayerRowPredicate = (row: LayerRow) => boolean;

/**
 * Returns the row order reflecting the collapsed state, following the same traversal
 * rules as `render()`: groups directly under root **front-first**, descending into
 * child groups → own cells if expanded, and finally the unclassified (owner = null)
 * cells at the end.
 *
 * ## Ordering direction: top is front
 *
 * The source of truth for paint order is `ownerPaintOrder` in
 * `core/sceneprojection.ts`, where **`childrenOf`'s front-to-back order is back-to-front**,
 * with unclassified cells (owner = null) furthest back. Display is the reverse of that:
 * **items higher in the list are in front** (the side that wins on overlap). This
 * matches Photoshop / Illustrator / Figma; laying it out straight in `childrenOf` order
 * would be counter-intuitive.
 *
 * The reversal applies **only to sibling order**. Group rows sit above their own
 * children (the tree display can't break that), so the whole thing isn't a pure reverse
 * of paint order. Placing a group's own cells after its child groups is also consistent
 * with paint order — a group's own cells rank at that group itself, behind its
 * descendant groups.
 *
 * The drag-drop logic that derives a sibling index from visual position (`ui/layers.ts`)
 * depends on this direction, as does the display. **Pure functions that work with
 * sibling index (`computeDropIndexFor`, etc.) must not carry the display direction into
 * their logic** — mixing array semantics with screen semantics in the same function
 * makes it unreadable which "front" is meant.
 *
 * **Includes unprojected cells (transient state) too.** `render()` doesn't draw rows
 * whose `worldOf` is null, but this function only looks at Document's structure.
 * `normalizeSelection` / the selection store's self-validation already drop them once
 * added to a selection, so it's simpler for the row order to just reflect the structure
 * as-is.
 *
 * Passing `matches` enters filter mode:
 * - Cell rows survive only if they themselves match
 * - Group rows survive if **they themselves match, or a descendant matches**
 * - While filtering, `expandedIds` is ignored and every group is descended into
 *   (otherwise a collapsed group could hide a match)
 *
 * The filtered result is seen as the same ordering by keyboard navigation too —
 * this single function is the entry point so the definition of "visible rows" doesn't
 * diverge between rendering and interaction.
 */
export function visibleLayerRows(
  reader: LayerRowsReader,
  expandedIds: ReadonlySet<string>,
  matches?: LayerRowPredicate,
): LayerRow[] {
  const cellRowsOf = (ownerId: OwnerId, depth: number): LayerRow[] => {
    const rows: LayerRow[] = [];
    for (const key of reader.localCellKeysOf(ownerId)) {
      const row: LayerRow = { kind: 'cell', ref: { ownerId, localCell: parseCellKey(key) }, depth };
      if (!matches || matches(row)) rows.push(row);
    }
    return rows;
  };

  /** Reorders siblings **front-first**. `childrenOf` is back-to-front order */
  const siblingsFrontFirst = (parentId: string | null): string[] => [...reader.childrenOf(parentId)].reverse();

  /** The rows for one group. During filtering, a branch where neither it nor any descendant matches becomes an empty array */
  const walk = (id: string, depth: number): LayerRow[] => {
    const self: LayerRow = { kind: 'group', id, depth };
    // Never descend into an instance, even while filtering (its contents aren't editable, so they aren't a search target either)
    const descend = reader.isInstance?.(id) ? false : matches ? true : expandedIds.has(id);
    const children = descend
      ? [...siblingsFrontFirst(id).flatMap((childId) => walk(childId, depth + 1)), ...cellRowsOf(id, depth + 1)]
      : [];
    if (!matches) return [self, ...children];
    if (children.length) return [self, ...children];
    return matches(self) ? [self] : [];
  };

  return [...siblingsFrontFirst(null).flatMap((id) => walk(id, 0)), ...cellRowsOf(null, 0)];
}

/** A row's identity key (group id / cell ref key). Used to hold the anchor and cursor across re-renders */
export function layerRowKey(row: LayerRowRef): string {
  return row.kind === 'group' ? `g:${row.id}` : `c:${makeCellRefKey(row.ref)}`;
}

/**
 * Moves the cursor one step in `direction`, only through rows whose `kind` matches
 *. Returns null if there's no row to move to (reached an edge).
 *
 * **Rows of a different kind are skipped over.** This is because `Selection` can't
 * represent a mix, being an exclusive union of groups / cells. Skipping rather
 * than stopping, because stopping would give no clue as to why it stopped. Once mixed selection is
 * resolved, removing this skip logic is all that's needed to support mixed selections.
 */
export function stepLayerCursor(
  rows: readonly LayerRow[],
  cursor: number,
  direction: -1 | 1,
  kind: LayerRow['kind'],
  isSkipped?: (row: LayerRow, index: number) => boolean,
): number | null {
  for (let i = cursor + direction; i >= 0 && i < rows.length; i += direction) {
    const row = rows[i]!;
    if (row.kind !== kind) continue;
    if (isSkipped?.(row, i)) continue;
    return i;
  }
  return null;
}

/**
 * Collects, in visual order, the rows whose `kind` matches within the anchor..cursor
 * range (inclusive on both ends).
 *
 * Passing `isAncestor` **drops rows that are descendants of another group within the
 * range** (raised in review). Since `normalizeSelection` keeps only the outermost
 * groups, passing the un-dropped set to the selection would **desync the internal
 * cursor from the actual Selection** — a step that brings a parent and child into range
 * together wouldn't visibly change anything (the child gets dropped by normalization),
 * making the next step appear to jump unexpectedly. This aligns them up front.
 */
export function layerRowsInRange(
  rows: readonly LayerRow[],
  anchor: number,
  cursor: number,
  kind: LayerRow['kind'],
  isAncestor?: (ancestorId: string, id: string) => boolean,
): LayerRow[] {
  const from = Math.min(anchor, cursor);
  const to = Math.max(anchor, cursor);
  const picked = rows.slice(from, to + 1).filter((row) => row.kind === kind);
  if (kind !== 'group' || !isAncestor) return picked;
  const ids = picked.map((row) => (row as { kind: 'group'; id: string }).id);
  return picked.filter((row) => {
    const id = (row as { kind: 'group'; id: string }).id;
    return !ids.some((other) => other !== id && isAncestor(other, id));
  });
}

/**
 * Whether **both ends survive normalization** if anchor..candidate were made the
 * selection (raised in review).
 *
 * `normalizeSelection` keeps only the outermost groups, so when a parent and child
 * enter the range together, one of them disappears. Making that kind of combination
 * the cursor's destination would desync the internal cursor from the actual Selection,
 * producing a "nothing happens the first time, then it suddenly jumps the second time"
 * behavior.
 *
 * Candidates that return false are skipped by `stepLayerCursor` — treated the same way
 * as skipping a row of a different kind.
 */
export function rangeKeepsBothEnds(
  rows: readonly LayerRow[],
  anchor: number,
  candidateIndex: number,
  isAncestor: (ancestorId: string, id: string) => boolean,
): boolean {
  const anchorRow = rows[anchor];
  const candidate = rows[candidateIndex];
  if (!anchorRow || !candidate) return false;
  if (anchorRow.kind !== 'group' || candidate.kind !== 'group') return true; // cell rows have no containment relationship
  const kept = layerRowsInRange(rows, anchor, candidateIndex, 'group', isAncestor).map(
    (row) => (row as { kind: 'group'; id: string }).id,
  );
  return kept.includes(anchorRow.id) && kept.includes(candidate.id);
}
