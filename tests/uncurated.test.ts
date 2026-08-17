import { describe, expect, it } from 'vitest';
import { groupBySuffix, listUncurated } from '../scripts/uncurated.mjs';

/** The equivalent of one record in the integrated DB (only the fields this function reads) */
function block(id: string, opts: { nameEn?: string; states?: string[]; texture?: boolean } = {}) {
  return {
    id: `minecraft:${id}`,
    nameEn: opts.nameEn ?? null,
    states: Object.fromEntries((opts.states ?? []).map((name) => [name, [0, 1]])),
    textures: { refs: null, resolved: opts.texture === false ? {} : { [id]: [`textures/blocks/${id}`] } },
  };
}

describe('groupBySuffix — groups by curation unit', () => {
  it('groups ids that share a common suffix', () => {
    const series = groupBySuffix(['white_wool', 'black_wool', 'red_wool']);

    expect([...series.keys()]).toEqual(['wool']);
    expect(series.get('wool')).toEqual(['white_wool', 'black_wool', 'red_wool']);
  });

  it('takes the **longest** common suffix (a longer series is not absorbed into a shorter one)', () => {
    // mixing stained_glass_pane into stained_glass would put panes and windows in the same row
    const series = groupBySuffix([
      'white_stained_glass',
      'black_stained_glass',
      'white_stained_glass_pane',
      'black_stained_glass_pane',
    ]);

    expect(series.get('stained_glass')).toEqual(['white_stained_glass', 'black_stained_glass']);
    expect(series.get('stained_glass_pane')).toEqual(['white_stained_glass_pane', 'black_stained_glass_pane']);
  });

  it('does not group a suffix that only has one member (a single item is not made into a series)', () => {
    const series = groupBySuffix(['beacon', 'white_wool', 'black_wool']);

    expect([...series.keys()]).toEqual(['wool']);
  });

  it('does not use a candidate where the whole id would be the suffix (a bare item is not made a member of the series)', () => {
    // `fence` itself is not "one of the oak_fence family"
    const series = groupBySuffix(['fence', 'oak_fence', 'birch_fence']);

    expect(series.get('fence')).toEqual(['oak_fence', 'birch_fence']);
  });

  it('a shared prefix with a different suffix is a separate group', () => {
    const series = groupBySuffix(['oak_planks', 'birch_planks', 'oak_log', 'birch_log']);

    expect([...series.keys()].sort()).toEqual(['log', 'planks']);
  });

  it('an id with only one word produces no candidates', () => {
    expect([...groupBySuffix(['stone', 'dirt']).keys()]).toEqual([]);
  });
});

describe('listUncurated — the set difference after removing already-decided ids', () => {
  const db = {
    blocks: [
      block('stone', { nameEn: 'Stone' }),
      block('white_wool', { nameEn: 'White Wool' }),
      block('black_wool', { nameEn: 'Black Wool' }),
      block('beacon', { nameEn: 'Beacon', states: ['facing_direction'] }),
    ],
  };

  it('lists ids with already-decided ones excluded', () => {
    const result = listUncurated(db, new Set(['minecraft:stone']));

    expect(result.total).toBe(3);
    expect(result.series.map((s) => s.suffix)).toEqual(['wool']);
    expect(result.singles.map((b) => b.bareId)).toEqual(['beacon']);
  });

  it('**treats included: false as decided too** (does not bring an excluded item back as a candidate)', () => {
    // the contract is that the caller passes any id with an entry regardless of included.
    // being able to exclude without erasing the decision is the whole reason curation has
    // an `included` field; resurfacing it here would defeat that purpose
    const result = listUncurated(db, new Set(['minecraft:stone', 'minecraft:beacon']));

    expect(result.total).toBe(2);
    expect(result.singles).toEqual([]);
  });

  it('carries only the material for a decision (does not itself judge "can be added")', () => {
    const result = listUncurated(db, new Set());
    const beacon = result.singles.find((b) => b.bareId === 'beacon');

    expect(beacon).toEqual({
      id: 'minecraft:beacon',
      bareId: 'beacon',
      nameEn: 'Beacon',
      stateNames: ['facing_direction'],
      hasTexture: true,
    });
  });

  it('keeps items whose texture cannot be resolved, just flagging them', () => {
    // unable to resolve != cannot be added (some blocks are keyed under an aggregate name).
    // dropping it would remove it from the candidates
    const withMissing = { blocks: [block('barrier', { nameEn: 'Barrier', texture: false })] };
    const result = listUncurated(withMissing, new Set());

    expect(result.total).toBe(1);
    expect(result.singles[0]?.hasTexture).toBe(false);
  });

  it('keeps items with no resolvable English name as null (does not guess from the id)', () => {
    const noName = { blocks: [block('acacia_double_slab')] };
    const result = listUncurated(noName, new Set());

    expect(result.singles[0]?.nameEn).toBeNull();
  });

  it('outputs the largest series first (ties are stabilized by dictionary order of the suffix)', () => {
    const many = {
      blocks: [
        block('oak_log'),
        block('birch_log'),
        block('white_wool'),
        block('black_wool'),
        block('red_wool'),
      ],
    };
    const result = listUncurated(many, new Set());

    expect(result.series.map((s) => `${s.suffix}:${s.blocks.length}`)).toEqual(['wool:3', 'log:2']);
  });
});

/**
 * The rule of taking the longest suffix can leave the shorter side **shrunk to a single
 * item as a result**. That single item stays in series but is dropped by the
 * CLI's default (2+ items), and the `inSeries` check also excludes it from singles, so even
 * with `--singles` it disappears from every listing.
 */
describe('a series that shrinks does not vanish from the listing', () => {
  it('a group left with only 1 item after taking the longest suffix is not kept as a series', () => {
    // 3 copper_bulb items move to `copper_bulb`, leaving 1 behind under `bulb`
    const series = groupBySuffix([
      'copper_bulb',
      'exposed_copper_bulb',
      'waxed_copper_bulb',
      'waxed_exposed_copper_bulb',
    ]);

    expect(series.get('bulb')).toBeUndefined();
    expect(series.get('copper_bulb')).toEqual([
      'exposed_copper_bulb',
      'waxed_copper_bulb',
      'waxed_exposed_copper_bulb',
    ]);
  });

  it('an item that overflows from shrinking appears as a single', () => {
    const db = {
      blocks: [
        block('copper_bulb'),
        block('exposed_copper_bulb'),
        block('waxed_copper_bulb'),
        block('waxed_exposed_copper_bulb'),
      ],
    };
    const result = listUncurated(db, new Set());

    expect(result.singles.map((b) => b.bareId)).toEqual(['copper_bulb']);
  });

  it('**the total count is preserved** — nothing vanishes from the listing regardless of grouping', () => {
    // detects "appears nowhere" structurally. This equality should hold even if the grouping rules change
    const db = {
      blocks: [
        block('copper_bulb'),
        block('exposed_copper_bulb'),
        block('waxed_copper_bulb'),
        block('waxed_exposed_copper_bulb'),
        block('white_wool'),
        block('black_wool'),
        block('beacon'),
        block('glass_pane'),
        block('hard_glass_pane'),
        block('white_stained_glass_pane'),
      ],
    };
    const result = listUncurated(db, new Set());

    const inSeries = result.series.flatMap((s) => s.blocks).length;
    expect(inSeries + result.singles.length).toBe(result.total);
  });

  it('a series always has 2 or more items (never creates a 1-item group)', () => {
    const db = {
      blocks: [
        block('copper_bulb'),
        block('exposed_copper_bulb'),
        block('waxed_copper_bulb'),
        block('waxed_exposed_copper_bulb'),
        block('glass_pane'),
        block('hard_glass_pane'),
        block('white_stained_glass_pane'),
        block('black_stained_glass_pane'),
      ],
    };
    const result = listUncurated(db, new Set());

    for (const entry of result.series) {
      expect(entry.blocks.length, `${entry.suffix} has only 1 item`).toBeGreaterThanOrEqual(2);
    }
  });
});
