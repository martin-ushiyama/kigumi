/** The list of blocks not yet included. Implemented in uncurated.mjs */
import type { TextureVariant } from './bedrock-parse.d.mts';

/**
 * The minimal contract of the DB record this function reads (structurally satisfied by
 * `BlockRecord`). Demanding the whole thing would force callers to assemble `_note` /
 * `source` / `serializationId` that they never use — and it would hide what is actually
 * being read from the type
 */
export interface UncuratedSourceBlock {
  id: string;
  nameEn: string | null;
  states: Record<string, (string | number | boolean)[]>;
  textures: { resolved: Record<string, TextureVariant[]> };
}

export interface UncuratedSource {
  blocks: UncuratedSourceBlock[];
}

/** Holds only the material for the decision. It carries no "can / cannot be added" call (a human decides) */
export interface UncuratedBlock {
  /** with `minecraft:` */
  id: string;
  /** without `minecraft:`. This is the word structure used to decide series membership */
  bareId: string;
  /** The English name resolved from lang. null when unresolved */
  nameEn: string | null;
  /** The property names of the block states it has. **This does not determine whether a shape is needed** (see the doc) */
  stateNames: string[];
  /** Whether a texture can be looked up. Some blocks cannot (they hold theirs under an aggregate name, etc.) */
  hasTexture: boolean;
}

/** A sequence grouped by a shared suffix (an inclusion unit such as "the 16 wool colours") */
export interface UncuratedSeries {
  suffix: string;
  blocks: UncuratedBlock[];
}

/**
 * Groups ids by a shared suffix. Among those shared by two or more, the **longest** suffix is
 * taken (so that `stained_glass_pane` is not absorbed into `stained_glass`).
 */
export declare function groupBySuffix(ids: string[]): Map<string, string[]>;

/**
 * Lays out the blocks that are not included, split into series and singles.
 * `decidedIds` is the ids with a curation entry (`included: false` among them).
 */
export declare function listUncurated(
  db: UncuratedSource,
  decidedIds: Set<string>,
): {
  /** Larger sequences first. Ties are broken by the lexical order of the suffix */
  series: UncuratedSeries[];
  singles: UncuratedBlock[];
  total: number;
};
