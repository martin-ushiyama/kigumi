/**
 * Writes out the representative colour of each texture.
 *
 *   node scripts/gen-texture-colors.mjs
 *
 * ## Why it is an independent final stage
 *
 * It has two dependencies, and **both must be settled before it runs**:
 *
 * 1. the real PNG files (fetched by `gen-textures --fetch`)
 * 2. the source of truth for frame counts, `src/data/texture-frames.json` (written by
 *    `gen-texture-frames`)
 *
 * Putting colour generation at the tail of `gen-textures --fetch` bakes in a stale (2) — a
 * texture that upstream has newly made animated is not in frames yet, so it is treated as a
 * single frame and the blend of every frame is recorded as its representative colour. And
 * because `gen-texture-frames` then writes the correct frame count, **the generated outputs
 * disagree with each other while the command reports success** (raised in review).
 *
 * ## Relationship to the catalogue
 *
 * **The catalogue (`blocks.json`) does not hold representative colours.** Colour is a property
 * of the texture, so this is the only source of truth and the display side looks it up through
 * `textures.json`. Baking colour into the catalogue creates the cycle "without the catalogue
 * you cannot fetch the texture / without the colour you cannot build the catalogue", which
 * makes new blocks impossible to include (raised in review).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { averageColor, decodePng } from './png-average.mjs';
import { uniqueFiles } from './gen-textures.mjs';

const TEXTURE_DIR = join(process.cwd(), 'public/textures/blocks');
const FRAMES_PATH = join(process.cwd(), 'src/data/texture-frames.json');
const OUTPUT_PATH = join(process.cwd(), 'src/data/texture-colors.json');

/**
 * Builds the representative colours from a file list and the frame counts (no side effects).
 *
 * @param {object} input
 * @param {string[]} input.files the relative paths of the textures in scope
 * @param {Record<string, number>} input.frames the source of truth for frame counts (absent = 1 frame)
 * @param {(file: string) => Uint8Array | null} input.readPng null when it has not been fetched
 * @returns {{ colors: Record<string, string>, missing: string[] }}
 */
export function buildTextureColors({ files, frames, readPng }) {
  const colors = {};
  const missing = [];
  for (const file of [...files].sort()) {
    const bytes = readPng(file);
    if (!bytes) {
      missing.push(file);
      continue;
    }
    colors[file] = averageColor(decodePng(bytes), { frameCount: frames[file] ?? 1 });
  }
  return { colors, missing };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const frames = JSON.parse(readFileSync(FRAMES_PATH, 'utf-8'));
  const { colors, missing } = buildTextureColors({
    files: [...uniqueFiles()],
    frames,
    readPng: (file) => {
      const path = join(TEXTURE_DIR, file);
      return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
    },
  });
  if (missing.length > 0) {
    console.error(`the PNGs have not been fetched, so no representative colour can be produced (${missing.length}): ${missing.slice(0, 5).join(', ')}`);
    console.error('  → run npm run fetch-textures first');
    process.exit(1);
  }
  writeFileSync(OUTPUT_PATH, JSON.stringify(colors, null, 2) + String.fromCharCode(10));
  console.log(`representative colours: ${Object.keys(colors).length} → ${OUTPUT_PATH}`);
}
