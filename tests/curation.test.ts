import { describe, expect, it } from 'vitest';
import { CATALOG } from '../src/data/blocks';
import curationDoc from '../src/data/curation.json';
import { CURATION_CATEGORIES, curatedBlocks } from '../scripts/curation.mjs';
import type { CurationEntry } from '../scripts/curation.d.mts';

/**
 * Rules for reading the inclusion policy (`src/data/curation.json`).
 *
 * Regenerating with `gen-blocks` needs the upstream snapshot (gitignored), so it cannot run in CI.
 * Both curation and the catalog are committed, though, so **their correspondence can always be
 * checked here** — the same shape as the relationship between texture-ledger and manifest.
 */
describe('curation reading rules', () => {
  const doc = (entries: Record<string, Partial<CurationEntry>>) => ({ _note: '', entries });

  it('returns only the blocks marked included: true', () => {
    const r = curatedBlocks(
      doc({
        'minecraft:a': { nameJa: 'あ', category: 'stone', included: true },
        'minecraft:b': { nameJa: 'い', category: 'stone', included: false },
      }),
    );
    expect(r.problems).toEqual([]);
    expect(r.blocks.map((b) => b.id)).toEqual(['minecraft:a']);
  });

  it('does not treat included: false as "missing" (being able to exclude while keeping the decision is the whole point)', () => {
    const r = curatedBlocks(doc({ 'minecraft:b': { nameJa: 'い', category: 'stone', included: false } }));
    expect(r.problems).toEqual([]);
    expect(r.blocks).toEqual([]);
  });

  it('returns deliberately excluded ids in excludedIds (so the variant side can tell them from unknown ids)', () => {
    const r = curatedBlocks(
      doc({
        'minecraft:a': { nameJa: 'あ', category: 'stone', included: true },
        'minecraft:b': { nameJa: 'い', category: 'stone', included: false },
      }),
    );
    expect([...r.excludedIds]).toEqual(['minecraft:b']);
  });

  it('orders by category and preserves the written order within a category (the palette ordering)', () => {
    const r = curatedBlocks(
      doc({
        'minecraft:w1': { nameJa: 'w1', category: 'wood', included: true },
        'minecraft:s1': { nameJa: 's1', category: 'stone', included: true },
        'minecraft:d1': { nameJa: 'd1', category: 'soil', included: true },
        'minecraft:s2': { nameJa: 's2', category: 'stone', included: true },
      }),
    );
    expect(r.blocks.map((b) => b.id)).toEqual(['minecraft:s1', 'minecraft:s2', 'minecraft:w1', 'minecraft:d1']);
  });

  describe('never lets anything through silently', () => {
    const problemsOf = (entries: Record<string, Partial<CurationEntry>>) => curatedBlocks(doc(entries)).problems.join(' ');

    it('rejects a document with no entries', () => {
      expect(curatedBlocks({}).problems.join(' ')).toContain('entries');
    });

    it('rejects an unknown category rather than sweeping it to the end (it is the ordering itself)', () => {
      expect(problemsOf({ 'minecraft:a': { nameJa: 'あ', category: 'metal' as never, included: true } })).toContain('category');
    });

    /** The official ja_JP.lang is the source of truth for nameJa, so it is **optional**. If written, it must be a non-empty string */
    it('allows nameJa to be omitted (anything resolvable officially is not written down)', () => {
      expect(problemsOf({ 'minecraft:a': { category: 'stone', included: true } })).toBe('');
    });

    it('rejects an empty nameJa when one is written', () => {
      expect(problemsOf({ 'minecraft:a': { nameJa: '  ', category: 'stone', included: true } })).toContain(
        'nameJa',
      );
    });

    /** The representative color does not belong to curation (the texture average is the source of truth review) */
    it('rejects a written color as an unknown key', () => {
      // It is removed from the type as well, so this side confirms at runtime that it "can no longer be written"
      const withColor = { category: 'stone', color: '#111111', included: true } as never;
      expect(problemsOf({ 'minecraft:a': withColor })).toContain('unknown key');
    });

    it('rejects an id without the minecraft: prefix', () => {
      expect(problemsOf({ stone: { nameJa: 'あ', category: 'stone', included: true } })).toContain('minecraft:');
    });

    /**
     * Because the check was `!== true`, a missing value / null / the string "true" were all
     * treated the same as a legitimate false, with no diagnostic (raised in review).
     * The point is to record inclusion as an explicit decision, so ambiguous values are rejected.
     */
    it.each([
      ['missing', undefined],
      ['null', null],
      ['the string "true"', 'true'],
      ['the string "false"', 'false'],
      ['the number 1', 1],
      ['the number 0', 0],
    ])('rejects included when it is %s (not treated the same as false)', (_label, value) => {
      const problems = problemsOf({
        'minecraft:a': { nameJa: 'あ', category: 'stone', included: value as never },
      });
      expect(problems).toContain('included');
    });

    it('keeps an ambiguous included out of excludedIds too (excluded and broken cannot be told apart)', () => {
      const r = curatedBlocks(doc({ 'minecraft:a': { nameJa: 'あ', category: 'stone' } }));
      expect(r.blocks).toEqual([]);
      expect([...r.excludedIds]).toEqual([]);
    });

    it('rejects an unknown key as a typo', () => {
      expect(problemsOf({ 'minecraft:a': { nameJa: 'あ', category: 'stone', included: true, colour: '#fff' } as never })).toContain('colour');
    });
  });
});

/**
 * Protects the alignment between the committed curation and the committed catalog.
 * Regeneration (gen-blocks) needs the snapshot, so this is the offline-side exit.
 */
describe('consistency between curation and the catalog (blocks.json)', () => {
  const { blocks: curated, problems } = curatedBlocks(curationDoc);
  const catalogById = new Map(CATALOG.map((b) => [b.id, b]));

  it('has no problem in curation itself', () => {
    expect(problems).toEqual([]);
  });

  it('has every included block present in the catalog as a material block (full)', () => {
    for (const b of curated) {
      const entry = catalogById.get(b.id);
      expect(entry, `${b.id} is not in the catalog`).toBeDefined();
      expect(entry!.shape, b.id).toBe('full');
    }
  });

  it('matches the catalog category exactly (the generator does not overwrite it)', () => {
    for (const b of curated) {
      expect(catalogById.get(b.id)!.category, b.id).toBe(b.category);
    }
  });

  /**
   * The official ja_JP.lang is the source of truth for Japanese names. A nameJa in curation exists
   * **to fill the gap where the official lookup fails**, so whatever is written there must appear
   * in the catalog (written but ineffective = the gap-filling is dead).
   */
  it('surfaces every nameJa written in curation in the catalog (the gap-filling works)', () => {
    for (const b of curated) {
      if (b.nameJa !== null) expect(catalogById.get(b.id)!.nameJa, b.id).toBe(b.nameJa);
    }
  });

  it('fills every catalog representative color with #rrggbb', () => {
    const bad = CATALOG.filter((b) => !/^#[0-9a-f]{6}$/.test(b.color)).map((b) => `${b.id}=${b.color}`);
    expect(bad, `invalid representative color: ${bad.join(', ')}`).toEqual([]);
  });

  it('fills every catalog Japanese name', () => {
    const empty = CATALOG.filter((b) => !b.nameJa?.trim()).map((b) => b.id);
    expect(empty, `empty Japanese name: ${empty.join(', ')}`).toEqual([]);
  });

  it('limits catalog material blocks to those listed in curation (none appear on their own)', () => {
    const curatedIds = new Set(curated.map((b) => b.id));
    const extra = CATALOG.filter((b) => b.shape === 'full' && !curatedIds.has(b.id)).map((b) => b.id);
    expect(extra, `material block absent from curation: ${extra.join(', ')}`).toEqual([]);
  });

  it('keeps variants (slabs / stairs) out of curation as individual entries', () => {
    const curatedIds = new Set(curated.map((b) => b.id));
    const derived = CATALOG.filter((b) => b.shape !== 'full' && curatedIds.has(b.id)).map((b) => b.id);
    expect(derived, `variant written into curation: ${derived.join(', ')}`).toEqual([]);
  });

  it('limits catalog categories to the 3 that curation holds', () => {
    const unknown = [...new Set(CATALOG.map((b) => b.category))].filter(
      (c) => !(CURATION_CATEGORIES as readonly string[]).includes(c),
    );
    expect(unknown, `unknown category: ${unknown.join(', ')}`).toEqual([]);
  });
});
