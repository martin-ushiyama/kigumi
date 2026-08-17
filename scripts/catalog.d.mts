/** Assembling the catalogue (#97 stage 4). Implemented in catalog.mjs */
import type { CurationCategory, CuratedBlock } from './curation.d.mts';

/** How the parent of a derived block is classified when it is not in the included catalogue */
export type VariantBaseKind =
  /** it is included */
  | 'present'
  /** there is a curation entry but `included: false` → the derived blocks go with it (not an error) */
  | 'excluded'
  /** there is no curation entry → it points at an id with no mapping (an error) */
  | 'unknown';

export declare function classifyVariantBase(
  baseId: string,
  scope: { includedIds: Set<string>; excludedIds: Set<string> },
): VariantBaseKind;

/** **It holds no representative colour** (colour is a property of the texture, so texture-colors.json is the source of truth, #137 review) */
export interface CatalogEntry {
  id: string;
  nameJa: string;
  nameEn: string;
  category: CurationCategory;
  shape: 'full' | 'slab' | 'stairs';
  /** The bare id of the material block. A derived block points at its parent's id */
  materialGroup: string;
  states?: { pillar_axis: 'y' };
}

export declare function buildCatalog(input: {
  curated: CuratedBlock[];
  excludedIds: Set<string>;
  materials: ReadonlyArray<{ baseId: string; slabId?: string | null; stairsId?: string | null }>;
  isOfficial: (bareId: string) => boolean;
  resolveNameEn: (bareId: string) => string | null;
  /** The Japanese display name (from the official ja_JP.lang; null when unresolved → falls through to the curation gap-filler) */
  resolveNameJa: (bareId: string) => string | null;
  hasPillarAxis: (bareId: string) => boolean;
}): {
  blocks: CatalogEntry[];
  errors: string[];
  /** Materials deliberately excluded, so their derived blocks were not emitted either (for eyeballing, not an error) */
  skippedVariantsOf: string[];
};
