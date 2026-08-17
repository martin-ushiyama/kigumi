/** The read rules for the inclusion policy. Implemented in curation.mjs */

/** The order things appear in the catalogue. This is the palette order itself */
export declare const CURATION_CATEGORIES: readonly ['stone', 'wood', 'soil'];

export type CurationCategory = (typeof CURATION_CATEGORIES)[number];

/**
 * One entry of `src/data/curation.json`. It holds only the decisions that do not come from
 * Mojang (how upstream is read stays in gen-blocks.mjs)
 */
export interface CurationEntry {
  /**
   * **Filling a gap** in the Japanese names (optional). The source of truth is the official
   * ja_JP.lang; this is written only for older blocks that cannot be looked up from
   * `tile.<id>.name`
   */
  nameJa?: string;
  category: CurationCategory;
  /** false drops it from the catalogue. Being able to drop it **without erasing the decision** is why this exists */
  included: boolean;
  /** An optional note to keep about the inclusion / exclusion decision */
  note?: string;
}

export interface CurationDoc {
  _note: string;
  entries: Record<string, CurationEntry>;
}

export interface CuratedBlock {
  /** with the `minecraft:` prefix */
  id: string;
  /** null when no gap-filler is written (it is looked up from the official files) */
  nameJa: string | null;
  category: CurationCategory;
}

/** Resolves curation into **an array in the order it appears in the catalogue**. Never generate when problems is non-empty */
export declare function curatedBlocks(doc: unknown): {
  blocks: CuratedBlock[];
  /**
   * The ids explicitly marked `included: false` (with `minecraft:`).
   * Used so that generating the derived blocks can tell "deliberately excluded" from
   * "no such id is known"
   */
  excludedIds: Set<string>;
  problems: string[];
};
