import { describe, expect, it } from 'vitest';
import { buildCatalog, classifyVariantBase } from '../scripts/catalog.mjs';
import type { CuratedBlock } from '../scripts/curation.d.mts';

/**
 * Rules for assembling the catalog (#97 stage 4).
 *
 * The upstream snapshot is gitignored and absent in CI, so the way upstream is read gets
 * injected as functions and verified against fixtures (the same shape as
 * bedrock-parse / texture-manifest). This pins down everything up to "included: false removes
 * a material together with its variants" without running `gen-blocks`.
 */

const curated = (...ids: string[]): CuratedBlock[] =>
  ids.map((id) => ({ id: `minecraft:${id}`, nameJa: id, category: 'stone' }));


/**
 * An upstream where everything exists officially, the English name is the id verbatim, and
 * nothing has pillar_axis. The Japanese name defaults to **not resolvable** (the side where
 * curation's gap-filling applies). Tests that need an official lookup swap in `resolveNameJa`.
 */
const upstream = {
  isOfficial: () => true,
  resolveNameEn: (id: string) => id,
  resolveNameJa: () => null,
  hasPillarAxis: () => false,
};

describe('classifyVariantBase — distinguishes "excluded" from "unknown"', () => {
  const scope = { includedIds: new Set(['minecraft:a']), excludedIds: new Set(['minecraft:b']) };

  it('reports an included parent as present', () => {
    expect(classifyVariantBase('minecraft:a', scope)).toBe('present');
  });

  it('reports a parent removed via included: false as excluded (not an error)', () => {
    expect(classifyVariantBase('minecraft:b', scope)).toBe('excluded');
  });

  it('reports a parent absent from curation as unknown (the mapping points at a nonexistent id)', () => {
    expect(classifyVariantBase('minecraft:zzz', scope)).toBe('unknown');
  });
});

describe('buildCatalog', () => {
  const materials = [{ baseId: 'stone', slabId: 'stone_slab', stairsId: 'stone_stairs' }];

  it('orders material before its variants, and variants inherit the category from the parent', () => {
    const { blocks, errors } = buildCatalog({
      curated: curated('stone'),
      excludedIds: new Set(),
      materials,
      ...upstream,
    });
    expect(errors).toEqual([]);
    expect(blocks.map((b) => [b.id, b.shape, b.materialGroup])).toEqual([
      ['minecraft:stone', 'full', 'stone'],
      ['minecraft:stone_slab', 'slab', 'stone'],
      ['minecraft:stone_stairs', 'stairs', 'stone'],
    ]);
    expect(blocks.every((b) => b.category === 'stone')).toBe(true);
    expect(blocks.map((b) => b.nameJa)).toEqual(['stone', 'stone（ハーフ）', 'stone（階段）']);
  });

  /**
   * For Japanese names **the official data is the source of truth**. curation's nameJa is
   * gap-filling that only applies when the official lookup fails, and variants have official
   * names too, so composing one from the parent drops to a fallback.
   */
  it('uses the official Japanese name, including for variants', () => {
    const { blocks } = buildCatalog({
      curated: curated('stone'),
      excludedIds: new Set(),
      materials: [{ baseId: 'stone', slabId: 'stone_slab', stairsId: 'stone_stairs' }],
      ...upstream,
      resolveNameJa: (id: string) => ({ stone: '石', stone_slab: '石ハーフ', stone_stairs: '石の階段' })[id] ?? null,
    });
    expect(blocks.map((b) => b.nameJa)).toEqual(['石', '石ハーフ', '石の階段']);
  });

  it('applies curation\'s nameJa only where the official lookup fails', () => {
    const { blocks } = buildCatalog({
      curated: curated('stone'),
      excludedIds: new Set(),
      materials: [{ baseId: 'stone', slabId: 'stone_slab', stairsId: null }],
      ...upstream,
      resolveNameJa: (id: string) => (id === 'stone_slab' ? '石ハーフ' : null),
    });
    // The parent comes from curation (no official lookup), the variant from the official data
    expect(blocks.map((b) => b.nameJa)).toEqual(['stone', '石ハーフ']);
  });

  /**
   * The central contract of `included: false` — **a block can leave the catalog while the
   * decision stays recorded** (#97 stage 4 review, P1). Previously, excluding a material that
   * had variants failed generation with an unknown-materialGroup error.
   */
  it('removes the variants along with an included: false material (generation does not fail)', () => {
    const { blocks, errors, skippedVariantsOf } = buildCatalog({
      curated: [],
      excludedIds: new Set(['minecraft:stone']),
      materials,
      ...upstream,
    });
    expect(errors).toEqual([]);
    expect(blocks).toEqual([]);
    expect(skippedVariantsOf).toEqual(['stone']);
  });

  it('keeps every material except the excluded one (exactly one entry disappears)', () => {
    const both = [
      { baseId: 'stone', slabId: 'stone_slab', stairsId: 'stone_stairs' },
      { baseId: 'granite', slabId: 'granite_slab', stairsId: 'granite_stairs' },
    ];
    const { blocks, errors, skippedVariantsOf } = buildCatalog({
      curated: curated('granite'),
      excludedIds: new Set(['minecraft:stone']),
      materials: both,
      ...upstream,
    });
    expect(errors).toEqual([]);
    expect(blocks.map((b) => b.id)).toEqual([
      'minecraft:granite',
      'minecraft:granite_slab',
      'minecraft:granite_stairs',
    ]);
    expect(skippedVariantsOf).toEqual(['stone']);
  });

  it('errors when the mapping points at a parent absent from curation (a typo, etc.)', () => {
    const { errors, skippedVariantsOf } = buildCatalog({
      curated: [],
      excludedIds: new Set(),
      materials,
      ...upstream,
    });
    expect(errors.join(' ')).toContain('unknown materialGroup');
    expect(skippedVariantsOf).toEqual([]);
  });

  describe('rejects anything that does not line up with upstream', () => {
    it('errors on a material absent from the official list', () => {
      const { blocks, errors } = buildCatalog({
        curated: curated('stone'),
        excludedIds: new Set(),
        materials: [],
        ...upstream,
        isOfficial: () => false,
      });
      expect(blocks).toEqual([]);
      expect(errors).toEqual(['stone']);
    });

    it('errors on a variant absent from the official list (the parent survives)', () => {
      const { blocks, errors } = buildCatalog({
        curated: curated('stone'),
        excludedIds: new Set(),
        materials,
        ...upstream,
        isOfficial: (id) => id === 'stone',
      });
      expect(blocks.map((b) => b.id)).toEqual(['minecraft:stone']);
      expect(errors).toEqual(['stone_slab', 'stone_stairs']);
    });

    it('errors when the Japanese name cannot be resolved from anywhere (no guessed name is baked in)', () => {
      const { blocks, errors } = buildCatalog({
        curated: [{ id: 'minecraft:stone', nameJa: null, category: 'stone' }],
        excludedIds: new Set(),
        materials: [],
        ...upstream,
      });
      expect(blocks).toEqual([]);
      expect(errors.join(' ')).toContain('cannot resolve the Japanese name');
    });

    it('errors when the English name cannot be resolved (no guessed name is baked in)', () => {
      const { blocks, errors } = buildCatalog({
        curated: curated('stone'),
        excludedIds: new Set(),
        materials: [],
        ...upstream,
        resolveNameEn: () => null,
      });
      expect(blocks).toEqual([]);
      expect(errors.join(' ')).toContain('cannot resolve the English name');
    });
  });

  it('attaches states to a block that has pillar_axis', () => {
    const { blocks } = buildCatalog({
      curated: curated('stone'),
      excludedIds: new Set(),
      materials: [],
      ...upstream,
      hasPillarAxis: () => true,
    });
    expect(blocks[0]!.states).toEqual({ pillar_axis: 'y' });
  });

  it('emits no variants for a material without slabId / stairsId', () => {
    const { blocks, errors } = buildCatalog({
      curated: curated('stone'),
      excludedIds: new Set(),
      materials: [{ baseId: 'stone', slabId: null, stairsId: null }],
      ...upstream,
    });
    expect(errors).toEqual([]);
    expect(blocks.map((b) => b.id)).toEqual(['minecraft:stone']);
  });
});
