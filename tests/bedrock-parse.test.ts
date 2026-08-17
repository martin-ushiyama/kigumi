import { describe, expect, it } from 'vitest';
import {
  collectRefNames,
  expandFaceRefs,
  FACES,
  normalizeTextureVariants,
  parseJsonc,
  parseLangEntries,
  variantPath,
} from '../scripts/bedrock-parse.mjs';

/**
 * Rules for reading the upstream files.
 *
 * The real files (`data/bedrock/*`) belong to Mojang under All rights reserved, so they are
 * gitignored and **do not exist in CI**. The rules are therefore extracted into pure functions
 * and pinned down here with small inputs shaped like the upstream ones (the same reasoning as
 * bedrock-snapshot.mjs / verifySnapshotBytes).
 */

describe('parseJsonc — strips upstream leading-line comments', () => {
  it('reads past a leading comment line (the notice in terrain_texture.json)', () => {
    const text = ['// Do not copy this file directly into your resource pack.', '{ "a": 1 }'].join('\n');
    expect(parseJsonc(text)).toEqual({ a: 1 });
  });

  it('preserves line numbers (blanks the line instead of deleting it so error positions do not shift)', () => {
    const text = ['// c', '{', '  "a": 1', '}'].join('\n');
    expect(parseJsonc(text)).toEqual({ a: 1 });
  });

  it('keeps // inside a string (stripping carelessly would corrupt the value)', () => {
    expect(parseJsonc('{ "url": "https://example.com/x" }')).toEqual({ url: 'https://example.com/x' });
  });

  it('stops on a block comment rather than handling it (never strips it silently)', () => {
    expect(() => parseJsonc('/* c */ { "a": 1 }', 'x.json')).toThrow(/block comments/);
  });

  it('reports the file name when it cannot be parsed', () => {
    expect(() => parseJsonc('{ oops', 'x.json')).toThrow(/x\.json/);
  });
});

describe('parseLangEntries — English display names', () => {
  const lang = [
    'tile.crimson_stem.name=Crimson Stem',
    'tile.stone.granite.name=Granite',
    'item.apple.name=Apple',
    'accessibility.disableTTS=Text To Speech disabled',
  ].join(String.fromCharCode(10));

  it('takes tile.<id>.name directly', () => {
    expect(parseLangEntries(lang).exact.get('crimson_stem')).toBe('Crimson Stem');
  });

  it('leaves parent.variant entries out of exact, since they cannot be looked up by id', () => {
    // tile.stone.granite.name is "stone.granite", which is not any block ID
    expect(parseLangEntries(lang).exact.has('stone.granite')).toBe(false);
    expect(parseLangEntries(lang).exact.has('granite')).toBe(false);
  });

  it('includes parent.variant entries in the set of display names (used to verify a label really exists)', () => {
    const { values } = parseLangEntries(lang);
    expect(values.has('Granite')).toBe(true);
    expect(values.has('Crimson Stem')).toBe(true);
  });

  it('ignores lines that are not tile entries', () => {
    expect(parseLangEntries(lang).values.has('Apple')).toBe(false);
  });
});

describe('expandFaceRefs — expands the three upstream forms into 6 faces', () => {
  it('applies a string to all 6 faces', () => {
    const { faces, notes } = expandFaceRefs('flattened_stone');
    expect(faces).toEqual(Object.fromEntries(FACES.map((f) => [f, 'flattened_stone'])));
    expect(notes).toEqual([]);
  });

  it('spreads side across the 4 lateral faces for {down, side, up}', () => {
    const { faces } = expandFaceRefs({ down: 'log_top', side: 'log_side', up: 'log_top' });
    expect(faces).toEqual({
      down: 'log_top',
      up: 'log_top',
      north: 'log_side',
      south: 'log_side',
      east: 'log_side',
      west: 'log_side',
    });
  });

  it('passes a 6-face spec through unchanged (does not collapse differing north/south/east/west)', () => {
    const refs = { down: 'd', up: 'u', north: 'n', south: 's', east: 'e', west: 'w' };
    expect(expandFaceRefs(refs).faces).toEqual(refs);
  });

  it('takes the per-face spec when both side and the 4 lateral faces are present, and records what it discarded', () => {
    // A shape that occurs twice in the real data (azalea / flowering_azalea). side and the per-face spec disagree
    const { faces, notes } = expandFaceRefs({
      down: 'd',
      up: 'u',
      side: 'azalea_side',
      north: 'azalea_side',
      south: 'potted_side',
      east: 'azalea_plant',
      west: 'potted_plant',
    });
    expect(faces?.south).toBe('potted_side');
    expect(faces?.east).toBe('azalea_plant');
    expect(notes.join()).toMatch(/side/);
  });

  it('refuses to interpret when faces are missing, and lists the missing ones', () => {
    const { faces, notes } = expandFaceRefs({ up: 'u' });
    expect(faces).toBeNull();
    expect(notes.join()).toMatch(/down/);
  });

  it('refuses to interpret a missing spec and records it (air, light_block)', () => {
    expect(expandFaceRefs(undefined).faces).toBeNull();
    expect(expandFaceRefs(null).faces).toBeNull();
  });

  it('does not silently accept an unsupported shape', () => {
    const { faces, notes } = expandFaceRefs(['a', 'b']);
    expect(faces).toBeNull();
    expect(notes.join()).toMatch(/array/);
  });
});

describe('expandFaceRefs — validates the values even when every key is present', () => {
  const sixFaces = (value: unknown) => ({
    down: value,
    up: value,
    north: value,
    south: value,
    east: value,
    west: value,
  });

  it('does not report success when all 6 faces are numbers', () => {
    // While only key presence was checked, this passed with faces !== null and no diagnostics
    const { faces, notes } = expandFaceRefs(sixFaces(1));
    expect(faces).toBeNull();
    expect(notes.join()).toMatch(/is not a texture name/);
  });

  it('rejects null and undefined values too', () => {
    expect(expandFaceRefs(sixFaces(null)).faces).toBeNull();
    expect(expandFaceRefs({ down: 'a', side: null, up: 'a' }).faces).toBeNull();
  });

  it('rejects empty and whitespace-only values too (unusable as a name)', () => {
    expect(expandFaceRefs(sixFaces('')).faces).toBeNull();
    expect(expandFaceRefs(sixFaces('   ')).faces).toBeNull();
    expect(expandFaceRefs('').faces).toBeNull();
  });

  it('names which face is bad', () => {
    const { notes } = expandFaceRefs({ down: 'a', up: 'a', north: 'a', south: 7, east: 'a', west: 'a' });
    expect(notes.join()).toMatch(/south/);
  });

  it('does not count unusable values as reference names either (so the diagnostics do not misfire)', () => {
    expect(collectRefNames(sixFaces(3))).toEqual([]);
    expect(collectRefNames({ down: 'a', side: '', up: 'a' })).toEqual(['a']);
  });
});

describe('normalizeTextureVariants — only turns candidates into an array', () => {
  it('turns a string into a one-element array', () => {
    expect(normalizeTextureVariants({ textures: 'textures/blocks/stone' })).toEqual(['textures/blocks/stone']);
  });

  it('preserves the multiplicity of candidates in an array', () => {
    const variants = ['textures/blocks/a', 'textures/blocks/b'];
    expect(normalizeTextureVariants({ textures: variants })).toEqual(variants);
  });

  it('keeps a tinted spec with its keys intact (does not drop facts such as grass tinting)', () => {
    const entry = { textures: { path: 'textures/blocks/grass_side', overlay_color: '#79c05a' } };
    expect(normalizeTextureVariants(entry)).toEqual([entry.textures]);
  });

  it('does not shorten the path (some entries really point outside textures/blocks)', () => {
    expect(normalizeTextureVariants({ textures: 'textures/items/apple' })).toEqual(['textures/items/apple']);
  });

  it('returns null when entry or textures is absent (so the caller can route it to diagnostics)', () => {
    expect(normalizeTextureVariants(undefined)).toBeNull();
    expect(normalizeTextureVariants({})).toBeNull();
  });
});

describe('collectRefNames / variantPath', () => {
  it('yields that single name for a string spec', () => {
    expect(collectRefNames('stone')).toEqual(['stone']);
  });

  it('collects a per-face spec with duplicates folded together', () => {
    expect(collectRefNames({ down: 'top', up: 'top', side: 'side' })).toEqual(['side', 'top']);
  });

  it('collects the discarded side too (the fact that it is referenced is kept)', () => {
    const names = collectRefNames({ down: 'd', up: 'u', side: 's', north: 'n', south: 'n', east: 'n', west: 'n' });
    expect(names).toContain('s');
  });

  it('yields empty for a missing spec', () => {
    expect(collectRefNames(undefined)).toEqual([]);
  });

  it('extracts the path from a candidate (a string as-is / an object through path)', () => {
    expect(variantPath('textures/blocks/stone')).toBe('textures/blocks/stone');
    expect(variantPath({ path: 'textures/blocks/grass_side', overlay_color: '#fff' })).toBe(
      'textures/blocks/grass_side',
    );
    expect(variantPath({ overlay_color: '#fff' })).toBeNull();
  });

  it('treats empty and whitespace-only paths as not extractable (the same rule as for names)', () => {
    // Returning them as-is would make the reachability check mistake it for "a path exists" and pass
    expect(variantPath('')).toBeNull();
    expect(variantPath('   ')).toBeNull();
    expect(variantPath({ path: '' })).toBeNull();
    expect(variantPath({ path: '  ', overlay_color: '#fff' })).toBeNull();
  });
});
