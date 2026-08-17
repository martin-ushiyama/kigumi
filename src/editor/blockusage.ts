import type { OwnerId } from '../core/cellref';
import { isVoidCell, unpackCell } from '../core/orientation';
import type { CellKey } from '../core/types';

/**
 * A tally of "what blocks exist right now and how many" (#48).
 *
 * The counting unit is **catalog block type only** — orientation code is folded away,
 * because what the user wants to see in the panel is "42 oak stairs," not "12 oak
 * stairs (facing north)." If splitting by orientation is ever wanted, that should be a
 * separate feature that expands a row.
 *
 * Overlaps (multiple owners at the same world coordinate) are counted as **1 per ref**.
 * An invisible layer underneath is still part of the build, and it affects both export
 * size and layer row count (now that #46 introduced stacking mode, counting only the
 * winner would no longer match reality).
 *
 * **Air (#113) is not counted.** It has no catalog entry, so it can't be shown as a
 * row; including it only in the total would create a state where "the row numbers
 * don't add up to the total" (#113 stage 5). The dropping happens **on the counting
 * side** — leaving it to a display-side "hide non-catalog entries" filter would split
 * the handling between where things are counted and where they're shown, and the same
 * mismatch would reappear.
 */
export interface BlockUsageEntry {
  catalogIndex: number;
  count: number;
}

/** Minimal port required by `collectBlockUsage` (Document's Reader type satisfies it structurally) */
export interface BlockUsageReader {
  /** Cells owned directly by an owner (localKey, raw value) */
  entriesOf(ownerId: OwnerId): Iterable<[CellKey, number]>;
  /** All owners (including unclassified = null) */
  owners(): Iterable<OwnerId>;
  /** The owners belonging to id's subtree (including id itself) */
  ownersOfSubtree(id: string): Iterable<OwnerId>;
}

/**
 * Tally scope.
 * - `world`: the whole build (including unclassified cells)
 * - `groups`: only the subtree of the given groups. **A duplicate owner is only
 *   counted once** — passing a parent and child together doesn't double-count them
 *   (`Selection` is normalized to outermost-only, but this function doesn't assume
 *   normalization)
 */
export type BlockUsageScope = { kind: 'world' } | { kind: 'groups'; ids: readonly string[] };

function ownersInScope(reader: BlockUsageReader, scope: BlockUsageScope): Set<OwnerId> {
  const owners = new Set<OwnerId>();
  if (scope.kind === 'world') {
    for (const owner of reader.owners()) owners.add(owner);
  } else {
    for (const id of scope.ids) for (const owner of reader.ownersOfSubtree(id)) owners.add(owner);
  }
  return owners;
}

/** Sorted by usage count descending. Ties break by catalogIndex ascending (keeps ordering stable per the catalog) */
export function collectBlockUsage(reader: BlockUsageReader, scope: BlockUsageScope): BlockUsageEntry[] {
  const counts = new Map<number, number>();
  for (const owner of ownersInScope(reader, scope)) {
    for (const [, raw] of reader.entriesOf(owner)) {
      if (isVoidCell(raw)) continue;
      const { catalogIndex } = unpackCell(raw);
      counts.set(catalogIndex, (counts.get(catalogIndex) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([catalogIndex, count]) => ({ catalogIndex, count }))
    .sort((a, b) => b.count - a.count || a.catalogIndex - b.catalogIndex);
}

export interface PatternUsageEntry {
  recipeId: string;
  count: number;
}

/**
 * Tallies regular blocks and live patterns exclusively in a single pass.
 * A cell for which `patternRecipeAt` returns a recipeId is not also counted into blocks.
 */
export function collectBlockAndPatternUsage(
  reader: BlockUsageReader,
  scope: BlockUsageScope,
  patternRecipeAt: (owner: OwnerId, key: CellKey, raw: number) => string | null,
): { blocks: BlockUsageEntry[]; patterns: PatternUsageEntry[] } {
  const blockCounts = new Map<number, number>();
  const patternCounts = new Map<string, number>();
  for (const owner of ownersInScope(reader, scope)) {
    for (const [key, raw] of reader.entriesOf(owner)) {
      if (isVoidCell(raw)) continue;
      const recipeId = patternRecipeAt(owner, key, raw);
      if (recipeId !== null) {
        patternCounts.set(recipeId, (patternCounts.get(recipeId) ?? 0) + 1);
        continue;
      }
      const { catalogIndex } = unpackCell(raw);
      blockCounts.set(catalogIndex, (blockCounts.get(catalogIndex) ?? 0) + 1);
    }
  }
  return {
    blocks: [...blockCounts.entries()]
      .map(([catalogIndex, count]) => ({ catalogIndex, count }))
      .sort((a, b) => b.count - a.count || a.catalogIndex - b.catalogIndex),
    patterns: [...patternCounts.entries()]
      .map(([recipeId, count]) => ({ recipeId, count }))
      .sort((a, b) => b.count - a.count || a.recipeId.localeCompare(b.recipeId)),
  };
}

/** Total count across the tally results (shown in the panel heading) */
export function totalBlockCount(entries: readonly BlockUsageEntry[]): number {
  return entries.reduce((sum, e) => sum + e.count, 0);
}
