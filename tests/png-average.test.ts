import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { averageColor, decodePng } from '../scripts/png-average.mjs';

/**
 * Builds a minimal PNG for tests. **CRCs are filled with 0** — the decoder does not look at the
 * CRC (there is no scenario where it reads a corrupted file, and we decided not to check), so
 * computing one here would only add a value that verifies nothing.
 */
function png({
  width,
  height,
  bitDepth = 8,
  colorType = 6,
  rows,
  palette,
  paletteAlpha,
  interlace = 0,
}: {
  width: number;
  height: number;
  bitDepth?: number;
  colorType?: number;
  /** Raw bytes per row (the filter type is not included; here it is always 0 = no filter) */
  rows: number[][];
  palette?: number[];
  paletteAlpha?: number[];
  interlace?: number;
}): Uint8Array {
  const chunks: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  const chunk = (type: string, body: number[]) => {
    chunks.push(...u32(body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body, 0, 0, 0, 0);
  };

  chunk('IHDR', [...u32(width), ...u32(height), bitDepth, colorType, 0, 0, interlace]);
  if (palette) chunk('PLTE', palette);
  if (paletteAlpha) chunk('tRNS', paletteAlpha);
  chunk('IDAT', [...zlibSync(new Uint8Array(rows.flatMap((row) => [0, ...row])))]);
  chunk('IEND', []);
  return new Uint8Array(chunks);
}

/** One row of 8-bit RGBA (opaque) */
const rgbaRow = (...pixels: [number, number, number, number][]) => pixels.flat();

describe('decodePng', () => {
  it('reads 8-bit RGBA', () => {
    const image = decodePng(
      png({ width: 2, height: 1, rows: [rgbaRow([10, 20, 30, 255], [40, 50, 60, 128])] }),
    );
    expect([image.width, image.height]).toEqual([2, 1]);
    expect([...image.rgba]).toEqual([10, 20, 30, 255, 40, 50, 60, 128]);
  });

  it('reads palette + 4-bit (2 pixels per byte)', () => {
    const image = decodePng(
      png({
        width: 2,
        height: 1,
        bitDepth: 4,
        colorType: 3,
        palette: [255, 0, 0, 0, 0, 255],
        rows: [[0x01]], // high 4 bits = index 0, low 4 bits = index 1
      }),
    );
    expect([...image.rgba]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });

  it('reads a palette tRNS as transparency', () => {
    const image = decodePng(
      png({
        width: 1,
        height: 1,
        bitDepth: 8,
        colorType: 3,
        palette: [1, 2, 3],
        paletteAlpha: [0],
        rows: [[0]],
      }),
    );
    expect([...image.rgba]).toEqual([1, 2, 3, 0]);
  });

  /**
   * The `png()` helper fixes the row filter at 0 (none), so filter reconstruction alone is
   * verified by assembling the IDAT directly. Row 1 is unfiltered, row 2 is Up (previous row + delta)
   */
  it('reconstructs the row filter (Up)', () => {
    const raw = new Uint8Array([0, 10, 10, 10, 255, 2, 5, 5, 5, 0]);
    const image = decodePng(rebuildWithIdat(png({ width: 1, height: 2, rows: [[], []] }), raw));
    expect([...image.rgba]).toEqual([10, 10, 10, 255, 15, 15, 15, 255]);
  });

  it('rejects input that is not a PNG', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow('not a PNG');
  });

  it('rejects interlaced images (never reads them by guessing)', () => {
    expect(() => decodePng(png({ width: 1, height: 1, rows: [[0, 0, 0, 255]], interlace: 1 }))).toThrow(
      'an interlaced PNG',
    );
  });

  it('rejects 16-bit depth', () => {
    expect(() => decodePng(png({ width: 1, height: 1, bitDepth: 16, rows: [[0, 0, 0, 255]] }))).toThrow(
      'bit depth',
    );
  });
});

/** Builds a PNG with the IHDR untouched and only the IDAT replaced (for verifying row filters) */
function rebuildWithIdat(source: Uint8Array, raw: Uint8Array): Uint8Array {
  const out: number[] = [...source.subarray(0, 8)];
  const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  let at = 8;
  while (at < source.length) {
    const length = (source[at]! << 24) | (source[at + 1]! << 16) | (source[at + 2]! << 8) | source[at + 3]!;
    const type = String.fromCharCode(source[at + 4]!, source[at + 5]!, source[at + 6]!, source[at + 7]!);
    if (type === 'IDAT') {
      const body = [...zlibSync(raw)];
      out.push(...u32(body.length), ...[...'IDAT'].map((c) => c.charCodeAt(0)), ...body, 0, 0, 0, 0);
    } else {
      out.push(...source.subarray(at, at + 12 + length));
    }
    at += 12 + length;
  }
  return new Uint8Array(out);
}

describe('averageColor', () => {
  it('returns the average of the opaque pixels', () => {
    const image = decodePng(
      png({ width: 2, height: 1, rows: [rgbaRow([0, 0, 0, 255], [100, 200, 254, 255])] }),
    );
    expect(averageColor(image)).toBe('#32647f');
  });

  it('does not count fully transparent pixels', () => {
    // Mixing in transparent black still yields exactly the color of the one remaining pixel
    const image = decodePng(
      png({ width: 2, height: 1, rows: [rgbaRow([0, 0, 0, 0], [16, 32, 48, 255])] }),
    );
    expect(averageColor(image)).toBe('#102030');
  });

  /**
   * An animation with frames stacked vertically. Mixing every frame does not give the color of
   * frame 1.
   *
   * **The same dimensions produce different results depending on the frame count** — whether
   * something is an animation is not decided by the aspect ratio; the membership in
   * `flipbook_textures.json` is the source of truth (#93). Reverting this to guesswork averages a
   * tall non-animated PNG over its first strip only (#137 review, P1)
   */
  it('looks at frame 1 only when a frame count is passed', () => {
    const image = decodePng(
      png({
        width: 1,
        height: 3,
        rows: [rgbaRow([16, 32, 48, 255]), rgbaRow([255, 255, 255, 255]), rgbaRow([255, 255, 255, 255])],
      }),
    );
    expect(averageColor(image, { frameCount: 3 })).toBe('#102030');
  });

  it('averages the whole image at the same dimensions when no frame count is passed', () => {
    const image = decodePng(
      png({
        width: 1,
        height: 3,
        rows: [rgbaRow([16, 32, 48, 255]), rgbaRow([255, 255, 255, 255]), rgbaRow([255, 255, 255, 255])],
      }),
    );
    // Tall with an integer ratio still does not imply an animation
    expect(averageColor(image)).not.toBe('#102030');
    expect(averageColor(image)).toBe('#afb5ba'); // (16+255+255)/3 and so on — the average of all 3 rows
  });

  it('rejects a height that the frame count does not divide evenly', () => {
    const image = decodePng(png({ width: 1, height: 3, rows: [rgbaRow([1, 1, 1, 255]), rgbaRow([1, 1, 1, 255]), rgbaRow([1, 1, 1, 255])] }));
    expect(() => averageColor(image, { frameCount: 2 })).toThrow('is not divisible by');
  });

  it('rejects an image with no opaque pixels', () => {
    const image = decodePng(png({ width: 1, height: 1, rows: [rgbaRow([9, 9, 9, 0])] }));
    expect(() => averageColor(image)).toThrow('no opaque pixels');
  });
});
