import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import packageJson from '../package.json';
import { buildTextureColors } from '../scripts/gen-texture-colors.mjs';
import { CATALOG } from '../src/data/blocks';
import textureColors from '../src/data/texture-colors.json';
import textureFrames from '../src/data/texture-frames.json';
import textureManifest from '../src/data/textures.json';
import rawCatalog from '../src/data/blocks.json';

/**
 * The **regeneration-in-a-clean-environment contract** for representative colors (#137 review P1).
 *
 * The representative color is the texture's average color, but PNGs are gitignored fetched
 * assets, and the upstream regeneration workflow does not fetch PNGs. So `gen-blocks` reads
 * not the PNG but the **committed `texture-colors.json`**. Without this, generation would
 * only work in a working environment where the PNGs happen to be cached, and regeneration
 * in a clean environment would fail.
 *
 * Extracting color from the PNG is `gen-textures --fetch`'s job, and this file is its output.
 */
describe('representative color regeneration contract', () => {
  const manifest = textureManifest as Record<string, { side: string; top?: string }>;
  const colors = textureColors as Record<string, string>;
  const frames = textureFrames as Record<string, number>;

  /** Looks things up in the same order as `gen-blocks`'s resolveColor (side -> top) */
  const colorFileOf = (id: string) => {
    const entry = manifest[id];
    if (!entry) return undefined;
    return [entry.side, entry.top].filter(Boolean).find((file) => file! in colors);
  };

  it('every catalog block can resolve a color from texture-colors.json (no PNG needed)', () => {
    const missing = CATALOG.filter((b) => colorFileOf(b.id) === undefined).map((b) => b.id);
    expect(missing, `blocks with no resolvable color: ${missing.slice(0, 10).join(', ')}`).toEqual([]);
  });

  /**
   * **The catalog does not carry color.** If it did, it would create a cycle ("no catalog
   * means no texture fetch" / "no color means no catalog"), making it impossible to add new
   * blocks (#137 review P1). Color is joined in from texture-colors.json at load time
   */
  it('blocks.json carries no color (so registering new entries does not create a cycle)', () => {
    const withColor = (rawCatalog as Record<string, unknown>[]).filter((b) => 'color' in b);
    expect(withColor.map((b) => b['id'])).toEqual([]);
  });

  it('the catalog color is exactly the texture-colors.json value', () => {
    const drifted = CATALOG.filter((b) => colors[colorFileOf(b.id)!] !== b.color).map((b) => b.id);
    expect(drifted).toEqual([]);
  });

  it('every color is #rrggbb (lowercase)', () => {
    const bad = Object.entries(colors).filter(([, c]) => !/^#[0-9a-f]{6}$/.test(c));
    expect(bad.map(([f, c]) => `${f}=${c}`)).toEqual([]);
  });

  /**
   * The source of truth for animation is `texture-frames.json` (derived from flipbook
   * membership, #93). The representative color takes its frame count from there, so
   * **there should be no frame count that has a color but is missing from the source of
   * truth** = the frame count is never guessed
   */
  it('every file listed in the frame-count source of truth also has a representative color', () => {
    const missing = Object.keys(frames).filter((file) => !(file in colors));
    expect(missing, `has a frame count but no representative color: ${missing.join(', ')}`).toEqual([]);
  });
});

/** Builds a 1x{rows} PNG (specify a gray value per row) */
function stripPng(values: number[]): Uint8Array {
  const chunks: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  const chunk = (type: string, body: number[]) =>
    chunks.push(...u32(body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body, 0, 0, 0, 0);
  chunk('IHDR', [...u32(1), ...u32(values.length), 8, 6, 0, 0, 0]);
  chunk('IDAT', [...zlibSync(new Uint8Array(values.flatMap((v) => [0, v, v, v, 255])))]);
  chunk('IEND', []);
  return new Uint8Array(chunks);
}

/**
 * If colors are generated **before** the frame-count source of truth, a texture that just
 * became animated upstream gets baked as an average across all frames. Worse, the later
 * step writes the correct frame count, so the command succeeds while the outputs disagree
 * with each other (#137 review P1)
 */
describe('representative colors are generated after the frame source of truth is updated', () => {
  const files = ['new_animated.png'];
  const readPng = () => stripPng([0, 255, 255, 255]); // frame 1 is black, the remaining 3 frames are white

  it('uses the color of frame 1 when the frame count is present in the source of truth', () => {
    const { colors } = buildTextureColors({ files, frames: { 'new_animated.png': 4 }, readPng });
    expect(colors['new_animated.png']).toBe('#000000');
  });

  it('falls back to the all-frame average when the frame count is missing from the source of truth (this is what happens if the order is not respected)', () => {
    const { colors } = buildTextureColors({ files, frames: {}, readPng });
    expect(colors['new_animated.png']).not.toBe('#000000');
  });

  it('lists a PNG that could not be fetched in missing (does not write it as if it were there)', () => {
    const { colors, missing } = buildTextureColors({ files, frames: {}, readPng: () => null });
    expect(colors).toEqual({});
    expect(missing).toEqual(files);
  });

  /** Pins down the ordering itself. Fails if the script sequence is reordered */
  it('fetch-textures writes the frame source of truth before generating colors', () => {
    const chain = (packageJson.scripts as Record<string, string>)['fetch-textures']!;
    expect(chain.indexOf('gen-texture-frames')).toBeGreaterThan(-1);
    expect(chain.indexOf('gen-texture-colors')).toBeGreaterThan(chain.indexOf('gen-texture-frames'));
  });
});
