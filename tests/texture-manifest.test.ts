import { describe, expect, it } from 'vitest';
import { buildTextureManifest, projectBlockTextures } from '../scripts/texture-manifest.mjs';
import type { BlockRecord } from '../scripts/block-db.d.mts';

type Projectable = Pick<BlockRecord, 'id' | 'textures'>;

/**
 * The **projection rules** from the unified DB to the texture manifest.
 *
 * Neither `data/bedrock/` nor `data/block-db.json` exist in CI (both gitignored), so
 * the rules themselves are verified with fixtures (same reason as bedrock-parse / block-db).
 * Cross-checking against the committed generated artifact is owned by textures-manifest.test.ts.
 */

/** Build a DB record with `textures` specs and resolutions for all 6 faces */
const record = (refs: BlockRecord['textures']['refs'], resolved: BlockRecord['textures']['resolved']): Projectable => ({
  id: 'minecraft:test_block',
  textures: { refs, resolved },
});

const p = (name: string) => [`textures/blocks/${name}`];

describe('projecting a single DB record', () => {
  it('a uniform spec becomes side only (no top)', () => {
    const { entry, problems } = projectBlockTextures(record('foo', { foo: p('foo') }));
    expect(problems).toEqual([]);
    expect(entry).toEqual({ side: 'foo.png' });
  });

  it('has a top if the top face differs from the side', () => {
    const r = record({ down: 'top', side: 'sd', up: 'top' }, { top: p('a_top'), sd: p('a_side') });
    expect(projectBlockTextures(r).entry).toEqual({ side: 'a_side.png', top: 'a_top.png' });
  });

  it('has no top if the top face and side use the same file', () => {
    const r = record({ down: 'x', side: 'y', up: 'x' }, { x: p('same'), y: p('same') });
    expect(projectBlockTextures(r).entry).toEqual({ side: 'same.png' });
  });

  it('a path containing a subfolder is kept as a relative path', () => {
    const r = record('crimson', { crimson: ['textures/blocks/huge_fungus/crimson_log_side'] });
    expect(projectBlockTextures(r).entry).toEqual({ side: 'huge_fungus/crimson_log_side.png' });
  });

  describe('never silently collapses (does not project when undecided)', () => {
    it('gives ambiguousVariant when there are multiple candidates', () => {
      const r = record('multi', { multi: [...p('a'), ...p('b')] });
      const { entry, problems } = projectBlockTextures(r);
      expect(entry).toBeNull();
      expect(problems.map((x) => x.kind)).toContain('ambiguousVariant');
    });

    it('a variantIndex in the ledger decides which one is taken', () => {
      const r = record('multi', { multi: [...p('a'), ...p('b')] });
      const { entry, problems } = projectBlockTextures(r, { variantIndex: 1, reason: 'test' });
      expect(problems).toEqual([]);
      expect(entry).toEqual({ side: 'b.png' });
    });

    it('drops it if variantIndex is out of range for the candidates', () => {
      const r = record('multi', { multi: [...p('a'), ...p('b')] });
      const { problems } = projectBlockTextures(r, { variantIndex: 5, reason: 'test' });
      expect(problems.map((x) => x.kind)).toEqual(expect.arrayContaining(['variantIndexOutOfRange']));
    });

    /**
     * If candidates whose path can't be extracted (e.g. just `{overlay_color}`) are filtered
     * out before numbering, then ① the number drifts from upstream and the ledger points at a
     * different candidate, ② if filtering leaves only 1 candidate, it slips past the "multiple
     * candidates" check and passes through undecided.
     */
    describe('counts by the upstream index even when path-less candidates are mixed in', () => {
      const withHole = () => record('multi', { multi: [{ overlay_color: '#fff' }, ...p('b')] });

      it('does not let it through undecided even if filtering leaves only 1 candidate', () => {
        const { entry, problems } = projectBlockTextures(withHole());
        expect(entry).toBeNull();
        expect(problems.map((x) => x.kind)).toContain('ambiguousVariant');
      });

      it('variantIndex points at the position in the upstream array (not the position after filtering)', () => {
        const ok = projectBlockTextures(withHole(), { variantIndex: 1, reason: 'test' });
        expect(ok.problems).toEqual([]);
        expect(ok.entry).toEqual({ side: 'b.png' });
      });

      it("drops it if a path can't be extracted from the chosen candidate (never silently slides to another candidate)", () => {
        const { entry, problems } = projectBlockTextures(withHole(), { variantIndex: 0, reason: 'test' });
        expect(entry).toBeNull();
        // all 6 faces share the same ref, so 6 entries come out
        expect(problems.map((x) => x.kind)).toEqual(Array(6).fill('unresolvedFace'));
      });
    });

    it('needs dropsDownFace approval if top and bottom differ', () => {
      const r = record(
        { down: 'bottom', side: 'sd', up: 'top' },
        { bottom: p('a_bottom'), sd: p('a_side'), top: p('a_top') },
      );
      expect(projectBlockTextures(r).problems.map((x) => x.kind)).toEqual(['dropsDownFace']);
      const ok = projectBlockTextures(r, { dropsDownFace: true, reason: 'test' });
      expect(ok.problems).toEqual([]);
      expect(ok.entry).toEqual({ side: 'a_side.png', top: 'a_top.png' });
    });

    it("doesn't project if the 4 side faces disagree (the renderer can only apply one texture)", () => {
      const r = record(
        { down: 'x', up: 'x', north: 'n', south: 'n', east: 'e', west: 'n' },
        { x: p('x'), n: p('n'), e: p('e') },
      );
      expect(projectBlockTextures(r).problems.map((x) => x.kind)).toEqual(['sideFacesDiffer']);
    });

    it('does not convert a path pointing outside textures/blocks/', () => {
      const r = record('item', { item: ['textures/items/foo'] });
      expect(projectBlockTextures(r).problems.map((x) => x.kind)).toEqual(
        // all 6 faces share the same ref, so 6 entries come out
        Array(6).fill('pathOutsideBlocks'),
      );
    });

    it('gives noFaceRefs when there is no texture spec (a block with no appearance)', () => {
      expect(projectBlockTextures(record(null, {})).problems.map((x) => x.kind)).toEqual(['noFaceRefs']);
    });

    it('leaves it pending decision when both side and per-face specs for the 4 sides are present', () => {
      const r = record(
        { down: 'x', up: 'x', side: 's', north: 'n', south: 'n', east: 'n', west: 'n' },
        { x: p('x'), s: p('s'), n: p('n') },
      );
      expect(projectBlockTextures(r).problems.map((x) => x.kind)).toEqual(['ambiguousRefs']);
    });
  });
});

describe('assembling the catalog', () => {
  const dbBlocks: Projectable[] = [
    { id: 'minecraft:a', textures: { refs: 'fa', resolved: { fa: p('fa') } } },
    { id: 'minecraft:b', textures: { refs: 'fb', resolved: { fb: p('fb') } } },
  ];

  it('a block that needs no decision goes in as-is', () => {
    const r = buildTextureManifest({ catalogIds: ['minecraft:a'], dbBlocks, ledger: {} });
    expect(r.problems).toEqual([]);
    expect(r.manifest).toEqual({ 'minecraft:a': { side: 'fa.png' } });
  });

  it('a block with no DB record shows up as a problem', () => {
    const r = buildTextureManifest({ catalogIds: ['minecraft:zzz'], dbBlocks, ledger: {} });
    // NOTE: left as-is — this string is produced by scripts/texture-manifest.mjs (still Japanese, separate PR)
    expect(r.problems.join(' ')).toContain('there is no record in the unified DB');
  });

  it('drops it if expect disagrees with the projected result (re-decide if upstream moved)', () => {
    const ledger = {
      'minecraft:a': { expect: { side: 'old.png' }, changesAppearance: true, reason: 'test' },
    };
    const r = buildTextureManifest({ catalogIds: ['minecraft:a'], dbBlocks, ledger });
    expect(r.problems.join(' ')).toContain('expect');
    expect(r.manifest).toEqual({});
  });

  it('counts as an appearance-changing decision when it matches expect', () => {
    const ledger = {
      'minecraft:a': { expect: { side: 'fa.png' }, changesAppearance: true, reason: 'adopted upstream' },
    };
    const r = buildTextureManifest({ catalogIds: ['minecraft:a'], dbBlocks, ledger });
    expect(r.problems).toEqual([]);
    expect(r.appearanceChanges).toEqual([{ id: 'minecraft:a', to: { side: 'fa.png' }, reason: 'adopted upstream' }]);
  });

  it('a decision without a reason cannot stand', () => {
    const r = buildTextureManifest({ catalogIds: ['minecraft:a'], dbBlocks, ledger: { 'minecraft:a': {} } });
    expect(r.problems.join(' ')).toContain('reason');
  });

  it('drops it if an appearance-changing decision has no expect', () => {
    const ledger = { 'minecraft:a': { changesAppearance: true, reason: 'test' } };
    expect(buildTextureManifest({ catalogIds: ['minecraft:a'], dbBlocks, ledger }).problems.join(' ')).toContain(
      'expect',
    );
  });

  it("drops it if an unknown key is present (doesn't silently ignore a typo)", () => {
    const ledger = { 'minecraft:a': { variantIdx: 0, reason: 'test' } };
    expect(buildTextureManifest({ catalogIds: ['minecraft:a'], dbBlocks, ledger }).problems.join(' ')).toContain(
      'variantIdx',
    );
  });

  it('drops it if a leftover decision refers to a block not in the catalog', () => {
    const ledger = { 'minecraft:gone': { dropsDownFace: true, reason: 'test' } };
    expect(buildTextureManifest({ catalogIds: ['minecraft:a'], dbBlocks, ledger }).problems.join(' ')).toContain(
      'minecraft:gone',
    );
  });
});
