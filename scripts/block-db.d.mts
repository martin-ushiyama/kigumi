/** Assembling the unified DB. Implemented in block-db.mjs */
import type { SnapshotSource } from './bedrock-snapshot.d.mts';
import type { TextureVariant } from './bedrock-parse.d.mts';

/** Holds the upstream values in their original shape. The expansion is not held (whoever needs it calls expandFaceRefs) */
export interface BlockTextures {
  refs: string | Record<string, string> | null;
  resolved: Record<string, TextureVariant[]>;
}

export interface BlockRecord {
  id: string;
  serializationId: string | null;
  rawId: number | null;
  /** Only a direct lookup in lang. null when unresolved (a guessed name is never baked in) */
  nameEn: string | null;
  /** property name → value range */
  states: Record<string, (string | number | boolean)[]>;
  textures: BlockTextures;
}

/** The record of what could not be interpreted or was missing. The outlet that keeps silently filled gaps from existing */
export interface BlockDbDiagnostic {
  kind: string;
  id: string;
  detail: string;
}

/**
 * A texture entry absent from `data_items` (an old aggregate name). **Held with its contents** —
 * keeping only the ID would defeat the point of "keeping" it, since stage 3 could not look it
 * up the same way
 */
export interface OrphanTextureEntry {
  key: string;
  textures: BlockTextures;
}

export interface BlockDb {
  _note: string;
  /** which upstream snapshot it was built from */
  source: SnapshotSource | null;
  blocks: BlockRecord[];
  orphanTextureEntries: OrphanTextureEntry[];
  diagnostics: BlockDbDiagnostic[];
}

/**
 * The contents of `resource_pack/blocks.json`. Besides block ID → entry, a `format_version`
 * (a string) is mixed in at the same level
 */
export type ResourcePackBlocks = Record<string, string | { textures?: unknown; [key: string]: unknown }>;

export function buildBlockDb(input: {
  mojangBlocks: unknown;
  resourcePackBlocks: ResourcePackBlocks;
  terrainTexture: unknown;
  langText: string;
  source?: SnapshotSource | null;
}): BlockDb;

export function formatBlockDb(db: BlockDb): string;

export function summarizeBlockDb(db: BlockDb): {
  blocks: number;
  withTextureRefs: number;
  fullyReachable: number;
  withNameEn: number;
  withStates: number;
  distinctTextureNames: number;
  orphanTextureEntries: number;
  diagnostics: Record<string, number>;
};

/**
 * Whether it reaches a real file path on all six faces. This predicate is the premise on which
 * stage 3 stands, so callers are not given their own way of counting
 */
export function textureReachability(record: { textures?: BlockTextures } | null | undefined): {
  ok: boolean;
  problems: string[];
};
