import { describe, expect, it } from 'vitest';
import { findMissingVariants, formatMissingVariant, variantRoots, VARIANT_SUFFIXES } from '../scripts/variant-coverage.mjs';

/**
 * Detecting missing catalog coverage (#82 review).
 *
 * `gen-blocks.mjs` is a manual, network-required run, so writing the detection logic
 * directly into it means **breakage would go unnoticed by normal CI**. We split it out as a
 * pure function that takes official data as an argument, and pin it down offline here by
 * passing in fixtures.
 */

describe('variantRoots — derives variant stem candidates from a base ID', () => {
  it('absorbs suffix variation', () => {
    expect(variantRoots('brick_block')).toContain('brick'); // drops _block
    expect(variantRoots('stone_bricks')).toContain('stone_brick'); // plural -> singular
    expect(variantRoots('deepslate_tiles')).toContain('deepslate_tile');
    expect(variantRoots('purpur_block')).toContain('purpur');
  });

  it('keeps the original ID itself as a candidate too (for materials that need no conversion)', () => {
    expect(variantRoots('granite')).toContain('granite');
    expect(variantRoots('tuff')).toContain('tuff');
  });

  it('cannot absorb naming where the stem becomes something else entirely (explicitly documents what it cannot catch)', () => {
    // end_bricks's variant is end_stone_brick_slab. It can't be traced mechanically, so it's registered by hand
    expect(variantRoots('end_bricks')).not.toContain('end_stone_brick');
  });
});

describe('findMissingVariants — returns variants that exist officially but are not yet in the catalog', () => {
  const officialIds = new Set([
    'brick_block', 'brick_slab', 'brick_stairs',
    'granite', 'granite_slab', 'granite_stairs',
    'calcite', // a material with no official variants
  ]);

  it('detects variants for a material whose base is the only catalog entry', () => {
    const missing = findMissingVariants({
      fullIds: ['brick_block'],
      catalogIds: new Set(['brick_block']),
      officialIds,
    });
    expect(missing.map(formatMissingVariant)).toEqual([
      'brick_block → brick_slab',
      'brick_block → brick_stairs',
    ]);
  });

  it('does not return variants already in the catalog', () => {
    const missing = findMissingVariants({
      fullIds: ['granite'],
      catalogIds: new Set(['granite', 'granite_slab', 'granite_stairs']),
      officialIds,
    });
    expect(missing).toEqual([]);
  });

  it('does not return a material that has no official variants (never suggests a nonexistent ID)', () => {
    const missing = findMissingVariants({
      fullIds: ['calcite'],
      catalogIds: new Set(['calcite']),
      officialIds,
    });
    expect(missing).toEqual([]);
  });

  it('returns just the one missing item when only one is missing', () => {
    const missing = findMissingVariants({
      fullIds: ['granite'],
      catalogIds: new Set(['granite', 'granite_slab']),
      officialIds,
    });
    expect(missing.map(formatMissingVariant)).toEqual(['granite → granite_stairs']);
  });

  it('does not return the same ID twice even when stem candidates overlap', () => {
    // 'tuff' stays 'tuff' even after conversion, so the candidate set ends up with a duplicate
    const missing = findMissingVariants({
      fullIds: ['tuff'],
      catalogIds: new Set(['tuff']),
      officialIds: new Set(['tuff', 'tuff_slab']),
    });
    expect(missing.map(formatMissingVariant)).toEqual(['tuff → tuff_slab']);
  });

  it('only looks at the two suffixes slab and stairs', () => {
    // walls are not a supported shape, so they're excluded from detection (including them would just be noise every time)
    expect(VARIANT_SUFFIXES).toEqual(['_slab', '_stairs']);
    const missing = findMissingVariants({
      fullIds: ['granite'],
      catalogIds: new Set(['granite', 'granite_slab', 'granite_stairs']),
      officialIds: new Set([...officialIds, 'granite_wall']),
    });
    expect(missing).toEqual([]);
  });
});

/**
 * Whether the current catalog itself is missing anything is **not** verified here (#82 review).
 *
 * That check needs **the full set of official block IDs**. Since that can't be fetched
 * without a network, passing the catalog itself as `officialIds` would make it a tautology
 * (anything not in the catalog would be treated as not official either) and it would always
 * return empty. **A test that verifies nothing, sitting there green, is worse than no test
 * at all** — the next reader would misread it as "this is covered here."
 *
 * Checking the real catalog is the job of the missing-coverage report from `npm run gen-blocks`.
 * What this file pins down is only **that the detection logic itself works correctly**.
 */
