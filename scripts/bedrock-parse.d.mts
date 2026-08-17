/** The read rules for the upstream files (#97 stage 2). Implemented in bedrock-parse.mjs */

/** The six faces of a block */
export const FACES: readonly string[];

/** One candidate in `terrain_texture.json`. A string, or `{ path, overlay_color }`, etc. */
export type TextureVariant = string | { path?: string; [key: string]: unknown };

/** The `textures` value of `resource_pack/blocks.json` (a string / per-face / absent) */
export type FaceRefs = string | Record<string, string> | null | undefined;

export function parseJsonc(text: string, label?: string): unknown;

export function parseLangEntries(text: string): {
  exact: Map<string, string>;
  values: Set<string>;
};

export function expandFaceRefs(refs: unknown): {
  faces: Record<string, string> | null;
  notes: string[];
};

export function normalizeTextureVariants(entry: unknown): TextureVariant[] | null;

export function collectRefNames(refs: unknown): string[];

export function variantPath(variant: unknown): string | null;
