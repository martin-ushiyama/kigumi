/** Produces a representative colour from a PNG (a follow-on from #134). Implemented in png-average.mjs */

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA8. Its length is width * height * 4 */
  rgba: Uint8Array;
}

/**
 * Decodes a PNG into RGBA8. Only non-interlaced bit depths 1 / 2 / 4 / 8 are supported;
 * anything else throws (it is never read by guessing)
 */
export declare function decodePng(bytes: Uint8Array): DecodedPng;

/**
 * The representative colour `#rrggbb` (lower case).
 *
 * Passing `frameCount` looks at the first frame only (an animation with its frames stacked
 * vertically). **The frame count is the caller's responsibility** — it is not guessed from the
 * aspect ratio (the source of truth is the flipbook membership, #93).
 * Throws when the height is not divisible by the frame count, or when there is not a single
 * opaque pixel
 */
export declare function averageColor(image: DecodedPng, options?: { frameCount?: number }): string;
