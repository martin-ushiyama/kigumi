import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { uniqueFiles } from '../scripts/gen-textures.mjs';
import ENV_TEXTURES from '../src/data/env-textures.json';

/**
 * The fetch contract for environment textures (ground, etc.) the 3D scene references.
 *
 * The runtime's reference path and the fetch target were managed as separate strings, so
 * changing only one of them went unnoticed by everyone. The dev server returns index.html
 * with a 200 even for nonexistent paths, so the runtime side doesn't even get a 404 — it
 * silently falls back to a flat color.
 *
 * We made env-textures.json the single source of truth so both sides read from it.
 * **The drift itself can no longer happen structurally**, so what we're guarding here is
 * "don't regress to a form that bypasses the source of truth."
 */
describe('environment texture fetch contract', () => {
  it('every entry in the source of truth is included in the fetch plan', () => {
    // Currently EXTRA_FILES is derived from the source of truth, so this trivially passes.
    // This is insurance for if the fetch plan ever reverts to a hand-written list etc.
    const plan = new Set(uniqueFiles());
    for (const [name, file] of Object.entries(ENV_TEXTURES)) {
      expect(plan.has(file), `${name} (${file}) is not in the fetch target`).toBe(true);
    }
    expect(Object.keys(ENV_TEXTURES).length).toBeGreaterThan(0);
  });

  /**
   * The real point. Even with a source of truth in place, the same incident recurs if the
   * runtime side reverts to hardcoding strings. A typo in a key name fails via the JSON
   * import's type, but **a regression to hardcoding cannot be caught by types**.
   */
  it('scene.ts does not hardcode texture file names', () => {
    const src = readFileSync(new URL('../src/render/scene.ts', import.meta.url), 'utf-8');
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''); // examples inside comments are excluded
    const hardcoded = code.match(/['"`][^'"`]*\.(png|jpg|jpeg|webp)['"`]/g) ?? [];
    expect(hardcoded, 'file names should be sourced from src/data/env-textures.json').toEqual([]);
  });
});
