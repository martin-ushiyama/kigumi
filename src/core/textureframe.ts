import textureFrames from '../data/texture-frames.json';

/**
 * Calculation for cropping out the first frame of an animated texture
 * (a 16xN vertically-stacked sprite sheet).
 *
 * Minecraft's animated textures ship as a single PNG with frames stacked vertically.
 * Pasting it as-is looks vertically squashed, so only the first frame is shown.
 *
 * The crux of this implementation is that **3D and CSS have opposite vertical origins**.
 * three.js textures default to flipY = true (the image's bottom edge is V=0), so showing
 * the frame at the *top* of the image requires shifting the offset upward. CSS backgrounds
 * use the image's top edge as the origin, so the offset there is 0.
 * If each consumer computed this separately, one of them could end up flipped without anyone noticing.
 */

/** Base path for texture delivery. If references were scattered, one could break without anyone noticing */
export const TEXTURE_BASE = 'textures/blocks/';

const FRAMES = textureFrames as Record<string, number>;

/**
 * The physical frame count for a file. Non-animated textures are 1.
 *
 * The source of truth is `src/data/texture-frames.json` (a derived value generated
 * from the PNG dimensions, not hand-edited). Files with no entry default to 1 frame = full-size display.
 */
export function frameCountOf(file: string): number {
  const n = FRAMES[file];
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : 1;
}

/** For 3D. Assumes flipY = true; returns the UV that shows the frame at the **top** of the image */
export function firstFrameUv(frameCount: number): { repeatY: number; offsetY: number } {
  const n = Number.isInteger(frameCount) && frameCount > 0 ? frameCount : 1;
  return { repeatY: 1 / n, offsetY: (n - 1) / n };
}

/** For CSS background. The image's top edge is the origin, so offset is 0 */
export function firstFrameBackground(frameCount: number): { size: string; position: string } {
  const n = Number.isInteger(frameCount) && frameCount > 0 ? frameCount : 1;
  return { size: `100% ${n * 100}%`, position: '0% 0%' };
}

/**
 * The height for the `<img>` element itself when a wrapper crops it to show only the first frame.
 *
 * Switching to a background image would collapse this to a single calculation, but
 * `layers.ts`'s `<img>` has a path that catches load failures via the error event and
 * falls back to a flat color (a background image can't detect that failure). This
 * keeps the `<img>` while applying the same frame count.
 */
export function firstFrameImageHeight(frameCount: number): string {
  const n = Number.isInteger(frameCount) && frameCount > 0 ? frameCount : 1;
  return `${n * 100}%`;
}
