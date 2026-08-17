import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { packCell } from '../src/core/orientation';
import { VoxelWorld } from '../src/core/voxels';
import { CATALOG } from '../src/data/blocks';
import { buildMcpack, sanitizeStructureName } from '../src/export/mcpack';
import { BLOCK_VERSION, buildMcstructure } from '../src/export/mcstructure';
import { DocumentFixture } from './helpers/document-fixture';
import { readNbt, type ParsedNbt } from './nbt-reader';
import { DisplayableError } from '../src/core/i18n';

/**
 * Assert on the **error key**, not the wording. Display strings change with the
 * language, so expecting a particular phrase here would break the tests on every i18n change.
 */
function expectDisplayableError(fn: () => unknown, keys: readonly string[]): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DisplayableError);
    expect(keys).toContain((e as DisplayableError).key);
    return;
  }
  throw new Error('no exception was thrown');
}

const idx = (blockId: string) => {
  const i = CATALOG.findIndex((b) => b.id === blockId);
  if (i < 0) throw new Error(`not in the catalog: ${blockId}`);
  return i;
};

function makeWorld(cells: [number, number, number, string][]): VoxelWorld {
  const world = new VoxelWorld();
  world.replaceAll(cells.map(([x, y, z, id]) => [x, y, z, packCell(idx(id), 0)] as [number, number, number, number]));
  return world;
}

describe('mcstructure builder', () => {
  it('produces the correct size / palette / ZYX-ordered block_indices', () => {
    // (10,0,10)=stone, (11,0,10)=cobblestone, (10,1,10)=stone → size 2x2x1
    const world = makeWorld([
      [10, 0, 10, 'minecraft:stone'],
      [11, 0, 10, 'minecraft:cobblestone'],
      [10, 1, 10, 'minecraft:stone'],
    ]);
    const result = buildMcstructure(world, CATALOG);
    expect(result.size).toEqual([2, 2, 1]);
    expect(result.blockCount).toBe(3);
    expect(result.paletteCount).toBe(2);

    const parsed = readNbt(result.bytes).value as Record<string, ParsedNbt>;
    expect(parsed.format_version).toBe(1);
    expect(parsed.size).toEqual([2, 2, 1]);
    expect(parsed.structure_world_origin).toEqual([0, 0, 0]);

    const structure = parsed.structure as Record<string, ParsedNbt>;
    const [layer0, layer1] = structure.block_indices as ParsedNbt[][];
    // offset = (x-minX)*sy*sz + (y-minY)*sz + (z-minZ)
    // (10,0,10)→0, (10,1,10)→1, (11,0,10)→2, (11,1,10)→3 is empty (-1)
    const palette = ((structure.palette as Record<string, ParsedNbt>).default as Record<string, ParsedNbt>)
      .block_palette as Record<string, ParsedNbt>[];
    const names = palette.map((p) => p.name);
    const stone = names.indexOf('minecraft:stone');
    const cobble = names.indexOf('minecraft:cobblestone');
    expect(stone).toBeGreaterThanOrEqual(0);
    expect(cobble).toBeGreaterThanOrEqual(0);
    expect(layer0).toEqual([stone, stone, cobble, -1]);
    expect(layer1).toEqual([-1, -1, -1, -1]);
    for (const p of palette) expect(p.version).toBe(BLOCK_VERSION);

    expect(structure.entities).toEqual([]);
  });

  it('puts pillar_axis: y into the palette states for a log', () => {
    const world = makeWorld([[0, 0, 0, 'minecraft:oak_log']]);
    const parsed = readNbt(buildMcstructure(world, CATALOG).bytes).value as Record<string, ParsedNbt>;
    const structure = parsed.structure as Record<string, ParsedNbt>;
    const palette = ((structure.palette as Record<string, ParsedNbt>).default as Record<string, ParsedNbt>)
      .block_palette as Record<string, ParsedNbt>[];
    expect(palette).toHaveLength(1);
    expect(palette[0]!.name).toBe('minecraft:oak_log');
    expect(palette[0]!.states).toEqual({ pillar_axis: 'y' });
  });

  it('normalizes bounds that include negative coordinates', () => {
    const world = makeWorld([
      [-3, 0, -5, 'minecraft:stone'],
      [-1, 2, -4, 'minecraft:stone'],
    ]);
    const result = buildMcstructure(world, CATALOG);
    expect(result.size).toEqual([3, 3, 2]);
  });

  it('errors on an empty world', () => {
    expect(() => buildMcstructure(new VoxelWorld(), CATALOG)).toThrow();
  });

  it('sets the oversized flag when a side exceeds 64', () => {
    const world = makeWorld([
      [0, 0, 0, 'minecraft:stone'],
      [70, 0, 0, 'minecraft:stone'],
    ]);
    expect(buildMcstructure(world, CATALOG).oversized).toBe(true);
  });

  it('errors on the limit before allocating the array even for two sparse far-apart points (side too long)', () => {
    const world = makeWorld([
      [-512, 0, 0, 'minecraft:stone'],
      [512, 0, 0, 'minecraft:stone'],
    ]);
    expectDisplayableError(() => buildMcstructure(world, CATALOG), ['exportErr.sideTooLong', 'exportErr.volumeTooLarge']);
  });

  it('errors when the volume limit is exceeded (each side still within the limit)', () => {
    const world = makeWorld([
      [0, 0, 0, 'minecraft:stone'],
      [300, 300, 300, 'minecraft:stone'],
    ]);
    expectDisplayableError(() => buildMcstructure(world, CATALOG), ['exportErr.sideTooLong', 'exportErr.volumeTooLarge']);
  });

  it('errors on non-integer and NaN coordinates before allocating the array', () => {
    for (const bad of [[0.5, 0, 0], [Number.NaN, 0, 0], [0, -1, 0], [1e9, 0, 0]] as const) {
      const world = new VoxelWorld();
      world.replaceAll([[bad[0], bad[1], bad[2], 0]]);
      expectDisplayableError(() => buildMcstructure(world, CATALOG), ['exportErr.invalidCoords']);
    }
  });

  it('group membership does not affect the output (groups are parallel metadata; the export is flattened)', () => {
    const cells: [number, number, number, string][] = [
      [0, 0, 0, 'minecraft:stone'],
      [1, 0, 0, 'minecraft:cobblestone'],
    ];
    const plainResult = buildMcstructure(makeWorld(cells), CATALOG);

    const doc = new DocumentFixture();
    doc.setCells(cells.map(([x, y, z, id]) => [x, y, z, packCell(idx(id), 0)] as [number, number, number, number]));
    const groupId = doc.nextGroupId();
    doc.insertGroup({ id: groupId, name: 'group', parentId: null, childIds: [] }, 0);
    doc.setCellMembership('0,0,0', groupId);
    const groupedResult = buildMcstructure(doc.world, CATALOG);

    expect(groupedResult.size).toEqual(plainResult.size);
    expect(groupedResult.blockCount).toBe(plainResult.blockCount);
    expect(groupedResult.paletteCount).toBe(plainResult.paletteCount);
    expect(groupedResult.oversized).toBe(plainResult.oversized);
    expect(groupedResult.bytes).toEqual(plainResult.bytes);
  });
});

describe('.mcpack package', () => {
  it('produces a zip laid out as manifest + structures/bs/<name>.mcstructure', () => {
    const world = makeWorld([[0, 0, 0, 'minecraft:stone']]);
    const { bytes } = buildMcstructure(world, CATALOG);
    const pack = buildMcpack('テストの道 v2', bytes);
    const files = unzipSync(pack);
    const paths = Object.keys(files).sort();
    const structName = sanitizeStructureName('テストの道 v2');
    expect(paths).toEqual(['manifest.json', `structures/bs/${structName}.mcstructure`].sort());

    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as {
      format_version: number;
      header: { uuid: string; min_engine_version: number[] };
      modules: { type: string }[];
    };
    expect(manifest.format_version).toBe(2);
    expect(manifest.header.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(manifest.modules[0]!.type).toBe('data');
    expect(manifest.header.min_engine_version).toEqual([1, 21, 0]);

    // the mcstructure inside can be read back
    const inner = readNbt(files[`structures/bs/${structName}.mcstructure`]!);
    expect((inner.value as Record<string, ParsedNbt>).format_version).toBe(1);
  });

  it('passes a romaji name through unchanged', () => {
    expect(sanitizeStructureName('My Road v2')).toBe('my_road_v2');
    expect(sanitizeStructureName('ishi-mix_01')).toBe('ishi-mix_01');
  });

  /**
   * A Japanese name loses every usable character and comes out empty. Falling back to a fixed
   * string would make **separate creations export under the same name**, leaving it undetermined
   * which one `/structure load` picks up.
   */
  describe('names with no usable characters left', () => {
    it('gives each creation a different name', () => {
      const a = sanitizeStructureName('テストの道');
      const b = sanitizeStructureName('駅前の橋');
      expect(a).not.toBe(b);
    });

    it('is stable for the same name (re-exporting does not pile up aliases)', () => {
      expect(sanitizeStructureName('テストの道')).toBe(sanitizeStructureName('テストの道'));
    });

    it('consists only of characters valid in a structure name', () => {
      expect(sanitizeStructureName('テストの道')).toMatch(/^[a-z0-9_-]+$/);
      expect(sanitizeStructureName('🏠 いえ')).toMatch(/^[a-z0-9_-]+$/);
    });

    it('falls back to structure for an empty name (there is only one kind of "not entered", so it cannot collide)', () => {
      expect(sanitizeStructureName('')).toBe('structure');
      expect(sanitizeStructureName('   ')).toBe('structure');
    });

    it('does not collide even for similar names', () => {
      const names = ['あ', 'い', 'テスト', 'テスト2', 'テストの道', '道のテスト'];
      const generated = names.map(sanitizeStructureName);
      expect(new Set(generated).size).toBe(names.length);
    });

    /**
     * Looking only at "did it become empty" lets through names where **something remains but the
     * originals can no longer be told apart**. The test has to be
     * "was information lost".
     */
    it('does not collide for names that keep a few alphanumerics (駅前A / 港前A)', () => {
      expect(sanitizeStructureName('駅前A')).not.toBe(sanitizeStructureName('港前A'));
    });

    it('does not collide for names where only symbols are dropped (road!!! / road???)', () => {
      expect(sanitizeStructureName('road!!!')).not.toBe(sanitizeStructureName('road???'));
    });

    /**
     * A substitution that turns one character into a single `_` **cannot be detected by comparing
     * the results** (both `road/a` and `road?a` become `road_a`; raised in review).
     * The comparison has to be made on the original name, not the substituted one.
     */
    it('does not collide for names with only one substituted character (road/a / road?a)', () => {
      expect(sanitizeStructureName('road/a')).not.toBe(sanitizeStructureName('road?a'));
    });

    it('keeps the readable part even with a single-character substitution', () => {
      expect(sanitizeStructureName('road/a')).toMatch(/^road_a-/);
    });
  });

  /**
   * Structure names cannot contain uppercase letters or spaces. These three collapses are
   * demanded by the namespace itself, and we state deliberately that **this is the only place
   * where two different creations may end up with the same name** (raised in review).
   */
  describe('equivalence rules (the range we collapse on purpose)', () => {
    it('is case-insensitive', () => {
      expect(sanitizeStructureName('My Road')).toBe(sanitizeStructureName('my road'));
    });

    it('treats a run of spaces and underscores as a single _', () => {
      expect(sanitizeStructureName('road a')).toBe('road_a');
      expect(sanitizeStructureName('road_a')).toBe('road_a');
      expect(sanitizeStructureName('road  a')).toBe('road_a');
    });

    it('ignores leading and trailing spaces / underscores', () => {
      expect(sanitizeStructureName(' road ')).toBe('road');
      expect(sanitizeStructureName('_road_')).toBe('road');
    });

    /** Inside the equivalence rules (`road a`) and outside them (`road/a`) stay separate even when the writable form matches */
    it('keeps a name that falls outside the equivalence rules separate even when it looks the same', () => {
      expect(sanitizeStructureName('road a')).not.toBe(sanitizeStructureName('road/a'));
    });

    /**
     * The identifier goes through the equivalence rules as well. Deriving it from the original
     * name would make **names declared equivalent differ in their identifier alone**
     * (raised in review).
     */
    it('applies the equivalence rules to names carrying an identifier too (case)', () => {
      expect(sanitizeStructureName('Road/A')).toBe(sanitizeStructureName('road/a'));
    });

    it('applies the equivalence rules to names carrying an identifier too (spaces and _)', () => {
      expect(sanitizeStructureName('road /a')).toBe(sanitizeStructureName('road_/a'));
    });

    it('treats a name of only spaces / underscores as not entered', () => {
      expect(sanitizeStructureName('___')).toBe('structure');
      expect(sanitizeStructureName(' _ ')).toBe('structure');
      expect(sanitizeStructureName('')).toBe('structure');
    });

    it('keeps the readable part even for a name that was mostly dropped', () => {
      // If every hint of the original name disappears, entries become indistinguishable in a list
      expect(sanitizeStructureName('駅前A')).toMatch(/^a-/);
      expect(sanitizeStructureName('road!!!')).toMatch(/^road-/);
    });
  });

  /**
   * Minecraft identifies packs by UUID. Reissuing one every time would make each export of the
   * same creation pile up as a separate pack.
   */
  describe('pack UUID', () => {
    const manifestOf = (projectName: string) => {
      const world = new VoxelWorld();
      world.replaceAll([[0, 0, 0, packCell(0, 0)]]);
      const { bytes } = buildMcstructure(world, CATALOG);
      const files = unzipSync(buildMcpack(projectName, bytes));
      return JSON.parse(new TextDecoder().decode(files['manifest.json'])) as {
        header: { uuid: string };
        modules: { uuid: string }[];
      };
    };

    it('yields the same UUID for the same creation name (re-exporting does not multiply packs)', () => {
      const a = manifestOf('My Road');
      const b = manifestOf('My Road');
      expect(a.header.uuid).toBe(b.header.uuid);
      expect(a.modules[0]!.uuid).toBe(b.modules[0]!.uuid);
    });

    it('yields different UUIDs for different creation names', () => {
      expect(manifestOf('My Road').header.uuid).not.toBe(manifestOf('Other Road').header.uuid);
    });

    it('gives header and module different UUIDs (the same value is not reused)', () => {
      const m = manifestOf('My Road');
      expect(m.header.uuid).not.toBe(m.modules[0]!.uuid);
    });

    it('has the UUID shape', () => {
      const m = manifestOf('My Road');
      const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      expect(m.header.uuid).toMatch(shape);
      expect(m.modules[0]!.uuid).toMatch(shape);
    });
  });

  it('includes the in-game typed name alongside the pack display name', () => {
    const world = new VoxelWorld();
    world.replaceAll([[0, 0, 0, packCell(0, 0)]]);
    const { bytes } = buildMcstructure(world, CATALOG);
    const files = unzipSync(buildMcpack('My Road', bytes));
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as {
      header: { name: string };
    };
    // The name shown in the list and the name passed to /structure load are different things.
    // Surface the typeable form as well.
    expect(manifest.header.name).toContain('bs:my_road');
  });
});

/**
 * For Minecraft to pick up a re-exported pack, the **version must increase monotonically**.
 * Bedrock ignores an import with "the same pack identity and the same or a lower version".
 */
describe('pack version', () => {
  const versionOf = (name: string, revision?: number) => {
    const world = new VoxelWorld();
    world.replaceAll([[0, 0, 0, packCell(idx('minecraft:stone'), 0)]]);
    const { bytes } = buildMcstructure(world, CATALOG);
    const files = unzipSync(buildMcpack(name, bytes, revision));
    return JSON.parse(new TextDecoder().decode(files['manifest.json'])) as {
      header: { uuid: string; version: number[] };
      modules: { uuid: string; version: number[] }[];
    };
  };

  it('uses the default version when no count is passed (same as a never-exported creation)', () => {
    expect(versionOf('My Road').header.version).toEqual([1, 0, 0]);
  });

  it('raises the version as the count rises', () => {
    const first = versionOf('My Road', 1);
    const second = versionOf('My Road', 2);
    expect(second.header.version).toEqual([1, 0, 2]);
    expect(compareVersion(second.header.version, first.header.version)).toBeGreaterThan(0);
  });

  it('carries over a digit at 1000', () => {
    expect(versionOf('My Road', 999).header.version).toEqual([1, 0, 999]);
    expect(versionOf('My Road', 1000).header.version).toEqual([1, 1, 0]);
  });

  /** Wrapping around would land back on "the same or a lower version", returning to the state where imports are ignored */
  it('clamps overflow at the ceiling (does not wrap around)', () => {
    expect(versionOf('My Road', 999_999).header.version).toEqual([1, 999, 999]);
    expect(versionOf('My Road', 1_000_000).header.version).toEqual([1, 999, 999]);
  });

  it('keeps pack identity unchanged across versions (it does not pile up as a separate pack)', () => {
    expect(versionOf('My Road', 1).header.uuid).toBe(versionOf('My Road', 7).header.uuid);
  });

  it('keeps the header and module versions in sync', () => {
    const manifest = versionOf('My Road', 5);
    expect(manifest.modules[0]!.version).toEqual(manifest.header.version);
  });
});

/** Compares version triples (the same ordering Bedrock uses) */
function compareVersion(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
