import { describe, expect, it } from 'vitest';
import textureFrames from '../src/data/texture-frames.json';
import {
  TEXTURE_BASE,
  firstFrameBackground,
  firstFrameImageHeight,
  firstFrameUv,
  frameCountOf,
} from '../src/core/textureframe';

/**
 * Cropping out the first frame.
 *
 * What this pins down is **the calculation only**. Whether the real PNG actually has
 * 5 frames requires the PNG itself, so we can't know that here (CI has no PNGs).
 * Matching the real dimensions is verified by `gen-texture-frames` after fetching.
 */

describe('firstFrameUv — 3D is flipped vertically due to flipY', () => {
  it('returns the offset that exposes the top of the image (three.js defaults to flipY = true)', () => {
    expect(firstFrameUv(4)).toEqual({ repeatY: 0.25, offsetY: 0.75 });
    expect(firstFrameUv(5)).toEqual({ repeatY: 0.2, offsetY: 0.8 });
  });

  it('1 frame means no scaling (does not distort a non-animated texture)', () => {
    expect(firstFrameUv(1)).toEqual({ repeatY: 1, offsetY: 0 });
  });

  it('invalid values are treated as 1 frame (does not break rendering)', () => {
    expect(firstFrameUv(0)).toEqual({ repeatY: 1, offsetY: 0 });
    expect(firstFrameUv(-3)).toEqual({ repeatY: 1, offsetY: 0 });
    expect(firstFrameUv(1.5)).toEqual({ repeatY: 1, offsetY: 0 });
  });
});

describe('firstFrameBackground — CSS treats the top of the image as the origin', () => {
  it('offset stays 0, only the height stretches by the frame count', () => {
    expect(firstFrameBackground(4)).toEqual({ size: '100% 400%', position: '0% 0%' });
    expect(firstFrameBackground(5)).toEqual({ size: '100% 500%', position: '0% 0%' });
  });

  it('1 frame means no scaling', () => {
    expect(firstFrameBackground(1)).toEqual({ size: '100% 100%', position: '0% 0%' });
  });
});

describe('pins down that 3D and CSS are vertically opposite by design', () => {
  /**
   * If the two values derived from the same frame count ended up facing the same direction,
   * one of them would be flipped vertically. We surface this in one place because computing
   * it separately in each consumer would risk only one of them being flipped.
   */
  it('the 3D offsetY is nonzero, but the CSS position is 0', () => {
    const frames = 5;
    expect(firstFrameUv(frames).offsetY).toBeGreaterThan(0);
    expect(firstFrameBackground(frames).position).toBe('0% 0%');
  });
});

describe('firstFrameImageHeight — height when cropping an <img> with a wrapper', () => {
  it('stretches vertically by the frame count', () => {
    expect(firstFrameImageHeight(5)).toBe('500%');
    expect(firstFrameImageHeight(1)).toBe('100%');
  });
});

describe('frameCountOf — a file with no recorded entry is 1 frame', () => {
  it('a recorded file returns its recorded value', () => {
    for (const [file, count] of Object.entries(textureFrames as Record<string, number>)) {
      expect(frameCountOf(file), file).toBe(count);
    }
  });

  it('a file with no recorded entry is 1 (a normal texture)', () => {
    expect(frameCountOf('stone.png')).toBe(1);
    expect(frameCountOf('nonexistent.png')).toBe(1);
  });
});

describe('the delivery route is defined in exactly one place', () => {
  it('TEXTURE_BASE is the sole definition', () => {
    expect(TEXTURE_BASE).toBe('textures/blocks/');
  });
});
