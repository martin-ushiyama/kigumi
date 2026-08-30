import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_TEXTURE_FILES,
  extractRequiredTextures,
  textureFileForArchiveEntry,
} from '../src/services/texturepack';

describe('textureFileForArchiveEntry', () => {
  it('accepts a normal resource pack path and optional wrapper directories', () => {
    expect(textureFileForArchiveEntry('textures/blocks/stone.png')).toBe('stone.png');
    expect(textureFileForArchiveEntry('My Pack/resource_pack/textures/blocks/deepslate/deepslate.png')).toBe(
      'deepslate/deepslate.png',
    );
  });

  it('normalizes separators and casing without accepting unrelated PNGs', () => {
    expect(textureFileForArchiveEntry('PACK\\TEXTURES\\BLOCKS\\STONE.PNG')).toBe('stone.png');
    expect(textureFileForArchiveEntry('textures/items/stone.png')).toBeNull();
    expect(textureFileForArchiveEntry('textures/blocks/not-used-by-kigumi.png')).toBeNull();
  });
});

describe('extractRequiredTextures', () => {
  it('extracts only manifest-referenced files and keeps their logical names', async () => {
    const archive = zipSync({
      'pack/textures/blocks/stone.png': new Uint8Array([1, 2, 3]),
      'pack/textures/blocks/deepslate/deepslate.png': new Uint8Array([4, 5]),
      'pack/textures/items/unrelated.png': new Uint8Array([6]),
      'pack/manifest.json': new TextEncoder().encode('{}'),
    });

    const selected = await extractRequiredTextures(archive);

    expect([...selected.keys()].sort()).toEqual(['deepslate/deepslate.png', 'stone.png']);
    expect(new Uint8Array(await selected.get('stone.png')!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rejects a valid archive that has no supported textures', async () => {
    const archive = zipSync({ 'textures/items/unrelated.png': new Uint8Array([1]) });
    await expect(extractRequiredTextures(archive)).rejects.toMatchObject({
      code: 'no-matching-textures',
    });
  });

  it('rejects invalid archive bytes with a stable error code', async () => {
    await expect(extractRequiredTextures(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      code: 'invalid-archive',
    });
  });
});

describe('REQUIRED_TEXTURE_FILES', () => {
  it('is unique, sorted, and includes block and environment textures', () => {
    expect(REQUIRED_TEXTURE_FILES).toEqual([...new Set(REQUIRED_TEXTURE_FILES)].sort());
    expect(REQUIRED_TEXTURE_FILES).toContain('stone.png');
    expect(REQUIRED_TEXTURE_FILES).toContain('grass_top.png');
  });
});
