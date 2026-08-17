import { describe, expect, it } from 'vitest';
import { buildBlockDb, formatBlockDb, summarizeBlockDb, textureReachability } from '../scripts/block-db.mjs';

/**
 * The contract for assembling the combined DB (#97 stage 2).
 *
 * The real files are gitignored and absent in CI, so the contract is pinned down with
 * **small inputs shaped like the upstream ones**. Three things are protected here:
 *
 * 1. lossless — never drop the per-face spec or the multiplicity of candidates
 * 2. hold upstream values in their original shape (do not also store the expanded result)
 * 3. surface anything uninterpretable or missing in diagnostics instead of filling it in silently
 */

/** The minimal shape of upstream mojang-blocks.json */
function mojang(dataItems: unknown[], blockProperties: unknown[] = []) {
  return { data_items: dataItems, block_properties: blockProperties };
}

const LANG = ['tile.crimson_stem.name=Crimson Stem', 'tile.stone.granite.name=Granite'].join(
  String.fromCharCode(10),
);

/** Builds the DB from the 4 sources. Anything not supplied is filled in empty */
function build(over: Partial<Parameters<typeof buildBlockDb>[0]> = {}) {
  return buildBlockDb({
    mojangBlocks: mojang([]),
    resourcePackBlocks: {},
    terrainTexture: { texture_data: {} },
    langText: LANG,
    ...over,
  });
}

const CRIMSON = {
  name: 'minecraft:crimson_stem',
  raw_id: 480,
  serialization_id: 'tile.crimson_stem',
  properties: [{ name: 'pillar_axis' }],
};

const PILLAR_AXIS = { name: 'pillar_axis', type: 'string', values: [{ value: 'y' }, { value: 'x' }, { value: 'z' }] };

describe('buildBlockDb — joining the 4 sources', () => {
  const db = build({
    mojangBlocks: mojang([CRIMSON], [PILLAR_AXIS]),
    resourcePackBlocks: {
      format_version: '1.21.40',
      crimson_stem: {
        sound: 'stem',
        textures: {
          down: 'crimson_log_top',
          up: 'crimson_log_top',
          north: 'crimson_log_side',
          south: 'crimson_log_side',
          east: 'crimson_log_side',
          west: 'crimson_log_side',
        },
      },
    },
    terrainTexture: {
      texture_data: {
        crimson_log_top: { textures: 'textures/blocks/huge_fungus/crimson_log_top' },
        crimson_log_side: { textures: 'textures/blocks/huge_fungus/crimson_log_side' },
      },
    },
  });
  const record = db.blocks[0]!;

  it('reaches the real file name from the block ID (a path no naming convention can guess)', () => {
    // Only crimson has "log" in its real file name. Guessing never reached it, leaving 10 blocks unsupported
    expect(record.textures.resolved['crimson_log_side']).toEqual([
      'textures/blocks/huge_fungus/crimson_log_side',
    ]);
  });

  it('takes the English display name only straight from lang (never guesses)', () => {
    expect(record.nameEn).toBe('Crimson Stem');
  });

  it('carries the block state value ranges too (so the number of orientations need not be guessed)', () => {
    expect(record.states).toEqual({ pillar_axis: ['y', 'x', 'z'] });
  });

  it('holds the upstream identifiers as-is', () => {
    expect(record.id).toBe('minecraft:crimson_stem');
    expect(record.serializationId).toBe('tile.crimson_stem');
    expect(record.rawId).toBe(480);
  });

  it('records which upstream it was built from (so a stale DB can be recognized)', () => {
    const source = {
      repository: 'https://github.com/Mojang/bedrock-samples',
      commit: 'a'.repeat(40),
      files: {},
    };
    expect(build({ source }).source).toEqual(source);
  });

  it('does not carry textureFrames (not derivable from the 4 sources; #93 is the source of truth)', () => {
    expect(JSON.stringify(record)).not.toContain('textureFrames');
  });

  it('leaves diagnostics empty when there is no problem', () => {
    expect(db.diagnostics).toEqual([]);
  });
});

describe('buildBlockDb — lossless (information that can never be recovered once collapsed)', () => {
  const base = { name: 'minecraft:x', raw_id: 1, serialization_id: 'tile.x', properties: [] };

  it('holds the per-face spec in its original shape (the difference between up and down survives)', () => {
    const refs = { down: 'bottom', up: 'top', north: 'n', south: 's', east: 'e', west: 'w' };
    const db = build({
      mojangBlocks: mojang([base]),
      resourcePackBlocks: { x: { textures: refs } },
      terrainTexture: {
        texture_data: Object.fromEntries(
          ['bottom', 'top', 'n', 's', 'e', 'w'].map((n) => [n, { textures: `textures/blocks/${n}` }]),
        ),
      },
    });
    expect(db.blocks[0]!.textures.refs).toEqual(refs);
  });

  it('does not store the 6-face expansion of {down, side, up} (the same fact is not held in two shapes)', () => {
    const refs = { down: 'top', side: 'side', up: 'top' };
    const db = build({
      mojangBlocks: mojang([base]),
      resourcePackBlocks: { x: { textures: refs } },
      terrainTexture: {
        texture_data: { top: { textures: 'textures/blocks/top' }, side: { textures: 'textures/blocks/side' } },
      },
    });
    expect(db.blocks[0]!.textures.refs).toEqual(refs);
    expect(JSON.stringify(db.blocks[0]!.textures)).not.toContain('north');
  });

  it('preserves the fact that there are multiple candidates', () => {
    const db = build({
      mojangBlocks: mojang([base]),
      resourcePackBlocks: { x: { textures: 'multi' } },
      terrainTexture: {
        texture_data: { multi: { textures: ['textures/blocks/a', 'textures/blocks/b'] } },
      },
    });
    expect(db.blocks[0]!.textures.resolved['multi']).toEqual(['textures/blocks/a', 'textures/blocks/b']);
  });

  it('does not drop the keys of a tinted spec', () => {
    const db = build({
      mojangBlocks: mojang([base]),
      resourcePackBlocks: { x: { textures: 'grass_side' } },
      terrainTexture: {
        texture_data: {
          grass_side: { textures: [{ path: 'textures/blocks/grass_side', overlay_color: '#79c05a' }] },
        },
      },
    });
    expect(db.blocks[0]!.textures.resolved['grass_side']).toEqual([
      { path: 'textures/blocks/grass_side', overlay_color: '#79c05a' },
    ]);
  });
});

describe('buildBlockDb — surfaces gaps in diagnostics instead of filling them in silently', () => {
  const base = { name: 'minecraft:x', raw_id: 1, serialization_id: 'tile.x', properties: [] };
  const kinds = (db: ReturnType<typeof buildBlockDb>) => db.diagnostics.map((d) => d.kind);

  it('a block with no texture entry', () => {
    const db = build({ mojangBlocks: mojang([base]) });
    expect(kinds(db)).toContain('missingTextureEntry');
    expect(db.blocks[0]!.textures.refs).toBeNull();
  });

  it('a block with an entry but no textures (air / light_block)', () => {
    const db = build({ mojangBlocks: mojang([base]), resourcePackBlocks: { x: { sound: 'none' } } });
    expect(kinds(db)).toContain('noTextureRefs');
  });

  it('reports a candidate with an empty path in diagnostics (never silently marks it reachable)', () => {
    const db = build({
      mojangBlocks: mojang([base]),
      resourcePackBlocks: { x: { textures: 'blank' } },
      terrainTexture: { texture_data: { blank: { textures: '   ' } } },
    });
    expect(kinds(db)).toContain('unresolvableVariant');
    expect(textureReachability(db.blocks[0]).ok).toBe(false);
  });

  it('a referenced texture name is absent from terrain_texture', () => {
    const db = build({
      mojangBlocks: mojang([base]),
      resourcePackBlocks: { x: { textures: 'nope' } },
    });
    expect(kinds(db)).toContain('unknownTextureName');
  });

  it('a property with no value range in block_properties', () => {
    const db = build({
      mojangBlocks: mojang([{ ...base, properties: [{ name: 'mystery' }] }]),
      resourcePackBlocks: { x: { textures: 'stone' } },
      terrainTexture: { texture_data: { stone: { textures: 'textures/blocks/stone' } } },
    });
    expect(kinds(db)).toContain('unknownProperty');
    expect(db.blocks[0]!.states).toEqual({}); // never insert a guessed value range
  });

  it('a block whose English display name cannot be looked up (no guessed name is baked in)', () => {
    const db = build({ mojangBlocks: mojang([base]) });
    expect(kinds(db)).toContain('missingNameEn');
    expect(db.blocks[0]!.nameEn).toBeNull();
  });

  it('does not treat format_version as an entry', () => {
    const db = build({ resourcePackBlocks: { format_version: '1.21.40' } });
    expect(db.diagnostics).toEqual([]);
    expect(db.orphanTextureEntries).toEqual([]);
  });

  it('records that both side and the 4 lateral faces were present (so which one won can be traced)', () => {
    const db = build({
      mojangBlocks: mojang([base]),
      resourcePackBlocks: {
        x: { textures: { down: 'a', up: 'a', side: 'a', north: 'a', south: 'a', east: 'a', west: 'a' } },
      },
      terrainTexture: { texture_data: { a: { textures: 'textures/blocks/a' } } },
    });
    expect(kinds(db)).toContain('refsNote');
  });
});

describe('buildBlockDb — keeps entries missing from data_items, contents included (#97 stage 2 review)', () => {
  /** The same shape as `double_stone_slab` in the real data. A legacy aggregate name, but it does have textures */
  const db = build({
    resourcePackBlocks: {
      format_version: '1.21.40',
      double_stone_slab: {
        textures: { down: 'stone_slab_bottom', side: 'stone_slab_side', up: 'stone_slab_top' },
      },
    },
    terrainTexture: {
      texture_data: {
        stone_slab_bottom: { textures: 'textures/blocks/stone_slab_top' },
        stone_slab_side: { textures: 'textures/blocks/stone_slab_side' },
        stone_slab_top: { textures: 'textures/blocks/stone_slab_top' },
      },
    },
  });

  it('can recover the original entry spec, not just the key', () => {
    expect(db.orphanTextureEntries).toHaveLength(1);
    expect(db.orphanTextureEntries[0]!.key).toBe('double_stone_slab');
    expect(db.orphanTextureEntries[0]!.textures.refs).toEqual({
      down: 'stone_slab_bottom',
      side: 'stone_slab_side',
      up: 'stone_slab_top',
    });
  });

  it('carries the resolution down to the real file too (stage 3 can look it up through this name)', () => {
    expect(db.orphanTextureEntries[0]!.textures.resolved['stone_slab_side']).toEqual([
      'textures/blocks/stone_slab_side',
    ]);
  });

  it('can be checked for reachability with the same predicate as a block', () => {
    expect(textureReachability(db.orphanTextureEntries[0]).ok).toBe(true);
  });

  it('holds them as data rather than diagnostics (an upstream fact, not something uninterpretable)', () => {
    expect(db.diagnostics.map((d) => d.kind)).not.toContain('orphanTextureEntry');
    expect(summarizeBlockDb(db).orphanTextureEntries).toBe(1);
  });
});

describe('textureReachability — whether all 6 faces reach a real file (#97 stage 2 review)', () => {
  const recordWith = (refs: unknown, resolved: Record<string, unknown[]>) => ({
    textures: { refs, resolved },
  }) as Parameters<typeof textureReachability>[0];

  it('is reachable when a uniform spec resolves', () => {
    expect(textureReachability(recordWith('stone', { stone: ['textures/blocks/stone'] })).ok).toBe(true);
  });

  it('is not reachable when candidates exist but **not a single path can be extracted**', () => {
    // A candidate holding only `{overlay_color}`. Checking key presence alone let this pass
    const record = recordWith('grass', { grass: [{ overlay_color: '#fff' }] });
    const reach = textureReachability(record);
    expect(reach.ok).toBe(false);
    expect(reach.problems.join()).toMatch(/cannot take a file path/);
  });

  it('is not reachable when only some faces fail to resolve', () => {
    const refs = { down: 'a', up: 'a', north: 'b', south: 'b', east: 'b', west: 'b' };
    const reach = textureReachability(recordWith(refs, { a: ['textures/blocks/a'] })); // b is absent
    expect(reach.ok).toBe(false);
    expect(reach.problems.filter((p) => p.includes('b is not resolved'))).toHaveLength(4);
  });

  it('is not reachable when the candidate list is an empty array', () => {
    expect(textureReachability(recordWith('stone', { stone: [] })).ok).toBe(false);
  });

  it('is not reachable when the path is empty or whitespace-only', () => {
    expect(textureReachability(recordWith('stone', { stone: [''] })).ok).toBe(false);
    expect(textureReachability(recordWith('stone', { stone: ['   '] })).ok).toBe(false);
    expect(textureReachability(recordWith('stone', { stone: [{ path: '' }] })).ok).toBe(false);
  });

  it('is reachable if even one usable path exists (empty strings mixed in are fine)', () => {
    expect(textureReachability(recordWith('stone', { stone: ['', 'textures/blocks/stone'] })).ok).toBe(true);
  });

  it('is not reachable for a spec that cannot expand to 6 faces (and returns the reason)', () => {
    const reach = textureReachability(recordWith({ up: 'a' }, { a: ['textures/blocks/a'] }));
    expect(reach.ok).toBe(false);
    expect(reach.problems.join()).toMatch(/missing faces/);
  });

  it('is not reachable with no texture spec at all', () => {
    expect(textureReachability(recordWith(null, {})).ok).toBe(false);
    expect(textureReachability(undefined).ok).toBe(false);
  });
});

describe('buildBlockDb — emits a deterministic shape', () => {
  const item = (name: string) => ({ name, raw_id: 1, serialization_id: `tile.${name}`, properties: [] });

  it('sorts blocks by ascending ID (upstream reordering produces no diff)', () => {
    const db = build({ mojangBlocks: mojang([item('minecraft:c'), item('minecraft:a'), item('minecraft:b')]) });
    expect(db.blocks.map((b) => b.id)).toEqual(['minecraft:a', 'minecraft:b', 'minecraft:c']);
  });

  it('sorts diagnostics by kind, then by ID', () => {
    const db = build({ mojangBlocks: mojang([item('minecraft:b'), item('minecraft:a')]) });
    const sorted = [...db.diagnostics].sort((x, y) =>
      x.kind !== y.kind ? (x.kind < y.kind ? -1 : 1) : x.id < y.id ? -1 : 1,
    );
    expect(db.diagnostics).toEqual(sorted);
  });

  it('produces the same string from the same input', () => {
    const input = { mojangBlocks: mojang([item('minecraft:a')]) };
    expect(formatBlockDb(build(input))).toBe(formatBlockDb(build(input)));
  });

  it('stops rather than assembling from a broken upstream', () => {
    expect(() => buildBlockDb({ mojangBlocks: {}, resourcePackBlocks: {}, terrainTexture: {}, langText: '' })).toThrow(
      /data_items/,
    );
    expect(() =>
      buildBlockDb({ mojangBlocks: mojang([]), resourcePackBlocks: {}, terrainTexture: {}, langText: '' }),
    ).toThrow(/texture_data/);
  });
});

describe('summarizeBlockDb — a summary for human inspection', () => {
  it('keeps the summary out of the DB itself (storing a countable value alongside lets one go stale)', () => {
    const db = build({ mojangBlocks: mojang([{ name: 'minecraft:a', properties: [] }]) });
    expect(JSON.stringify(db)).not.toContain('withTextureRefs');
    expect(summarizeBlockDb(db).blocks).toBe(1);
  });

  it('counts diagnostics per kind', () => {
    const db = build({ mojangBlocks: mojang([{ name: 'minecraft:a', properties: [] }]) });
    expect(summarizeBlockDb(db).diagnostics['missingTextureEntry']).toBe(1);
  });
});
