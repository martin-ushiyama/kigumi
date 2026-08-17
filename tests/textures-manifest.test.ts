import { describe, expect, it } from 'vitest';
import { CATALOG } from '../src/data/blocks';
import textureManifest from '../src/data/textures.json';
import textureLedger from '../src/data/texture-ledger.json';
import type { TextureLedgerEntry } from '../scripts/texture-manifest.d.mts';

/**
 * Guards that the ID sets of the catalog (blocks.json) and the texture manifest
 * (textures.json) match.
 *
 * scripts/gen-textures.mjs has the same check on its side and throws the moment it
 * generates. This one targets **the committed output** — if the output is updated and
 * committed together, `gen-textures:check` (the diff check that the output matches what's
 * committed) stays green, so the set match needs to be pinned down here.
 */
describe('texture manifest and catalog consistency', () => {
  const manifest = textureManifest as Record<string, { side: string; top?: string }>;
  const catalogIds = CATALOG.map((b) => b.id);

  it('every catalog block has a manifest entry', () => {
    const missing = catalogIds.filter((id) => !(id in manifest));
    expect(missing, `blocks missing from manifest: ${missing.join(', ')}`).toEqual([]);
  });

  it('the manifest has no entries outside the catalog', () => {
    const known = new Set(catalogIds);
    const extra = Object.keys(manifest).filter((id) => !known.has(id));
    expect(extra, `manifest entries not in the catalog: ${extra.join(', ')}`).toEqual([]);
  });

  it('every entry has a side (top is optional)', () => {
    for (const [id, entry] of Object.entries(manifest)) {
      expect(entry.side, id).toBeTruthy();
    }
  });
});

/**
 * Guards that the ledger (`texture-ledger.json`) **matches the committed manifest** (#97 stage 3).
 *
 * The manifest is a projection from the integrated DB, but since neither the DB nor the
 * snapshot are tracked in git, CI cannot regenerate and cross-check it (regeneration is
 * handled by a manual workflow that includes fetching from upstream). Both the ledger and
 * the generated output are committed, though, so **this check can always run** — it's the
 * offline-side exit point for "making the ledger's judgment itself an executable contract."
 */
describe('texture ledger (texture-ledger.json) and manifest consistency', () => {
  const manifest = textureManifest as Record<string, { side: string; top?: string }>;
  const entries = Object.entries(textureLedger.entries as Record<string, TextureLedgerEntry>);
  const catalogIds = new Set(CATALOG.map((b) => b.id));

  it('has at least one ledger entry (if only the projection rule were needed, that would be a signal to fold the ledger away)', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('every ledger entry has a reason', () => {
    for (const [id, entry] of entries) {
      expect(entry.reason?.trim(), id).toBeTruthy();
    }
  });

  it('ledger entries only target blocks in the catalog', () => {
    const unknown = entries.map(([id]) => id).filter((id) => !catalogIds.has(id));
    expect(unknown, `ledger entries not in the catalog: ${unknown.join(', ')}`).toEqual([]);
  });

  it('entries that change appearance have an expect, and the manifest matches that value', () => {
    for (const [id, entry] of entries) {
      if (entry.changesAppearance !== true) continue;
      expect(entry.expect, `${id}: an appearance-changing entry has no expect`).toBeDefined();
      expect(manifest[id], id).toEqual(entry.expect);
    }
  });

  it('every entry with an expect matches the manifest (including ones that do not change appearance)', () => {
    for (const [id, entry] of entries) {
      if (entry.expect === undefined) continue;
      expect(manifest[id], id).toEqual(entry.expect);
    }
  });

  it('an entry with dropsDownFace has a top (it was recorded because top and bottom differ)', () => {
    for (const [id, entry] of entries) {
      if (entry.dropsDownFace !== true) continue;
      expect(manifest[id]?.top, `${id}: entry drops the bottom face but has no top`).toBeTruthy();
    }
  });
});
