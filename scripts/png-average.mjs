/**
 * Reads a PNG and produces its **representative colour** (a follow-on from #134). Pure
 * functions only.
 *
 * The representative colours used to be picked by hand, but with the textures available a
 * machine can produce them. Picking by hand always leaves the wobble of "similar stones end up
 * with colours that do not line up", and it does not follow when a texture is swapped.
 *
 * The decoder is hand-rolled because it costs no new dependency (`fflate`'s unzlib is already
 * here). The scope is Bedrock block textures only, so **not all of the PNG spec is
 * implemented** — an unexpected format is never reinterpreted silently; it always throws.
 */

import { unzlibSync } from 'fflate';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Channels per pixel for each colour type */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const readU32 = (bytes, at) =>
  ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;

/**
 * Decodes a PNG into RGBA8.
 *
 * What is supported is **non-interlaced, bit depth 1 / 2 / 4 / 8**. Bedrock block textures
 * contain not only 8-bit RGBA but also **4-bit palette PNGs**. 16-bit, interlaced and unknown
 * colour types throw (guessing would bake in a value whose colour is quietly off).
 *
 * @param {Uint8Array} bytes the contents of the PNG file
 * @returns {{ width: number, height: number, rgba: Uint8Array }}
 */
export function decodePng(bytes) {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('not a PNG');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette = null;
  let paletteAlpha = null;
  const idat = [];

  let at = 8;
  while (at < bytes.length) {
    const length = readU32(bytes, at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const body = bytes.subarray(at + 8, at + 8 + length);
    at += 12 + length; // length(4) + type(4) + data + crc(4)

    if (type === 'IHDR') {
      width = readU32(body, 0);
      height = readU32(body, 4);
      bitDepth = body[8];
      colorType = body[9];
      if (body[12] !== 0) throw new Error('an interlaced PNG is out of scope');
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'tRNS') {
      paletteAlpha = body;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (![1, 2, 4, 8].includes(bitDepth)) throw new Error(`bit depth ${bitDepth} is out of scope (1 / 2 / 4 / 8)`);
  const channels = CHANNELS[colorType];
  if (channels === undefined) throw new Error(`colour type ${colorType} is out of scope`);
  if (colorType === 3 && !palette) throw new Error('a palette PNG without a PLTE chunk');

  const total = idat.reduce((n, chunk) => n + chunk.length, 0);
  const deflated = new Uint8Array(total);
  let offset = 0;
  for (const chunk of idat) {
    deflated.set(chunk, offset);
    offset += chunk.length;
  }
  // IDAT is zlib format (header + adler32), not raw deflate
  const raw = unzlibSync(deflated);

  // Each row is prefixed with one filter-type byte and is restored using the row above and the
  // pixel to the left. **The filter works on bytes**, so it is processed byte by byte even when
  // the bit depth is below 8
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  const filterUnit = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const pixels = new Uint8Array(stride * height);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src++];
      const a = x >= filterUnit ? pixels[row + x - filterUnit] : 0;
      const b = y > 0 ? pixels[prev + x] : 0;
      const c = x >= filterUnit && y > 0 ? pixels[prev + x - filterUnit] : 0;
      let restored;
      if (filter === 0) restored = value;
      else if (filter === 1) restored = value + a;
      else if (filter === 2) restored = value + b;
      else if (filter === 3) restored = value + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        restored = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`unknown row filter ${filter}`);
      pixels[row + x] = restored & 0xff;
    }
  }

  /**
   * Takes sample `ch` of pixel `i`. Below bit depth 8 several samples are packed into one byte,
   * and **packing does not run across rows** (each row starts back on a byte boundary)
   */
  const sampleAt = (x, y, ch) => {
    if (bitDepth === 8) return pixels[y * stride + x * channels + ch];
    const bitIndex = (x * channels + ch) * bitDepth;
    const byte = pixels[y * stride + (bitIndex >> 3)];
    const shift = 8 - bitDepth - (bitIndex & 7);
    return (byte >> shift) & ((1 << bitDepth) - 1);
  };
  /** Stretches to 0-255 regardless of depth (for greyscale; palette indices are not stretched) */
  const scale = (v) => (bitDepth === 8 ? v : Math.round((v * 255) / ((1 << bitDepth) - 1)));

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const px = i % width;
    const py = (i / width) | 0;
    const sample = (ch) => sampleAt(px, py, ch);
    const d = i * 4;
    if (colorType === 0 || colorType === 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = scale(sample(0));
      rgba[d + 3] = colorType === 4 ? scale(sample(1)) : 255;
    } else if (colorType === 2 || colorType === 6) {
      rgba[d] = sample(0);
      rgba[d + 1] = sample(1);
      rgba[d + 2] = sample(2);
      rgba[d + 3] = colorType === 6 ? sample(3) : 255;
    } else {
      const index = sample(0);
      rgba[d] = palette[index * 3];
      rgba[d + 1] = palette[index * 3 + 1];
      rgba[d + 2] = palette[index * 3 + 2];
      rgba[d + 3] = paletteAlpha && index < paletteAlpha.length ? paletteAlpha[index] : 255;
    }
  }

  return { width, height, rgba };
}

/**
 * Produces the representative colour (`#rrggbb`).
 *
 * - **Only the first frame of an animation is looked at.** Frames ship stacked vertically in a
 *   single PNG, so averaging as-is mixes every frame together. **The frame count is passed in
 *   by the caller** — it must not be guessed from the aspect ratio. The source of truth for
 *   "is this animated" is the membership in `flipbook_textures.json`
 *   (`src/data/texture-frames.json`); tall PNGs with an integer ratio that are *not* animated
 *   really do exist (#93)
 * - **Transparent pixels are not counted.** Mixing in the edges of leaves or glass gives a
 *   colour darker than the real one
 * - The average is taken **in sRGB**. Physically it would be correct to convert back to linear
 *   before mixing, but this colour is "the single colour that looks like the block when there
 *   is no texture", so human perception is the yardstick. Against the 136 hand-picked entries,
 *   the sRGB average came out closer (median distance 4 vs 5)
 *
 * @param {{ width: number, height: number, rgba: Uint8Array }} image the result of `decodePng`
 * @param {{ frameCount?: number }} [options] the frame count (default 1 = not animated)
 * @returns {string} `#rrggbb` (lower case)
 */
export function averageColor({ width, height, rgba }, { frameCount = 1 } = {}) {
  if (!Number.isInteger(frameCount) || frameCount < 1) throw new Error(`invalid frame count: ${frameCount}`);
  if (height % frameCount !== 0) throw new Error(`height ${height} is not divisible by ${frameCount} frames`);
  const frameHeight = height / frameCount;

  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  for (let i = 0; i < width * frameHeight; i++) {
    const d = i * 4;
    const alpha = rgba[d + 3] / 255;
    if (alpha === 0) continue;
    r += rgba[d] * alpha;
    g += rgba[d + 1] * alpha;
    b += rgba[d + 2] * alpha;
    weight += alpha;
  }
  if (weight === 0) throw new Error('there are no opaque pixels');

  const hex = (v) => Math.round(v / weight).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}
