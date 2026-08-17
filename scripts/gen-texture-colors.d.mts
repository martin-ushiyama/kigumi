/** The final stage producing a representative colour per texture. Implemented in gen-texture-colors.mjs */

/**
 * Builds the representative colours from a file list and the frame counts (no side effects).
 *
 * **The caller passes the frame counts.** The source of truth is
 * `src/data/texture-frames.json`, and unless this runs after `gen-texture-frames`, which
 * writes that file, a newly animated texture is baked as the average of every frame
 */
export declare function buildTextureColors(input: {
  files: string[];
  frames: Record<string, number>;
  readPng: (file: string) => Uint8Array | null;
}): { colors: Record<string, string>; missing: string[] };
