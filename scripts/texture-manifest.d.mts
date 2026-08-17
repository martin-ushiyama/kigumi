/** The projection from the unified DB into the texture manifest (#97 stage 3). Implemented in texture-manifest.mjs */
import type { BlockRecord } from './block-db.d.mts';

/** The shape the renderer handles. `top` is applied to both +y and -y (it is absent when it equals side) */
export interface ManifestEntry {
  side: string;
  top?: string;
}

/**
 * One ruling, with its reason, pinning down a decision that the upstream facts alone do not
 * determine. The background is in Issue #97; the source of truth is
 * `src/data/texture-ledger.json`
 */
export interface TextureLedgerEntry {
  /** Which candidate to take when the old generation's data-value multiplexing leaves several */
  variantIndex?: number;
  /** Approval that the bottom face is discarded, for a block whose top and bottom differ */
  dropsDownFace?: boolean;
  /** Pins the projection result. Generation fails if upstream moves and produces a different value */
  expect?: ManifestEntry;
  /** Whether the ruling changes the appearance against the current manifest (what gets listed in the PR) */
  changesAppearance?: boolean;
  /** Required. A ruling with no reason cannot be kept as a contract */
  reason: string;
}

export interface ProjectionProblem {
  kind:
    | 'noFaceRefs'
    | 'ambiguousRefs'
    | 'ambiguousVariant'
    | 'variantIndexOutOfRange'
    | 'unresolvedFace'
    | 'pathOutsideBlocks'
    | 'sideFacesDiffer'
    | 'dropsDownFace';
  detail: string;
}

/** Projects one DB record into `{ side, top? }`. Where a ruling is needed it returns entry: null plus problems */
export function projectBlockTextures(
  record: Pick<BlockRecord, 'id' | 'textures'> | null | undefined,
  ledgerEntry?: Partial<TextureLedgerEntry>,
): { entry: ManifestEntry | null; problems: ProjectionProblem[] };

/** Assembles the manifest for the included catalogue. Never write it out when problems is non-empty */
export function buildTextureManifest(input: {
  catalogIds: string[];
  dbBlocks: Pick<BlockRecord, 'id' | 'textures'>[];
  ledger: Record<string, Partial<TextureLedgerEntry>>;
}): {
  manifest: Record<string, ManifestEntry>;
  problems: string[];
  appearanceChanges: { id: string; to: ManifestEntry; reason: string }[];
};
