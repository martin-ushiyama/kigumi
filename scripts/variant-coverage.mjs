/**
 * **Detecting gaps in the catalogue** (pure functions).
 *
 * The cross-check in `gen-blocks.mjs` only runs one way — "does a hand-written ID exist
 * officially" — so **something that exists officially but was never written down** went
 * unnoticed by everyone (deepslate_tiles / brick_block / quartz_block / purpur_block really
 * were in the catalogue as bases only, with their slabs and stairs missing entirely).
 *
 * Writing this directly inside `gen-blocks.mjs` would mean **not noticing when the detection
 * itself breaks** — generation requires the network and is run by hand, so it never runs in
 * ordinary CI. It is lifted out as pure functions that take the official data as arguments,
 * which pins it down offline.
 */

/** The suffixes of slabs and stairs */
export const VARIANT_SUFFIXES = ['_slab', '_stairs'];

/**
 * Returns the candidate stems that a derived ID could be built from, given a base ID.
 *
 * The official naming sometimes shifts the stem between a base and its derivatives:
 * - `brick_block` → `brick_slab` (`_block` is dropped)
 * - `stone_bricks` → `stone_brick_slab` (plural → singular)
 * - `deepslate_tiles` → `deepslate_tile_slab` (same)
 * - `end_bricks` → `end_stone_brick_slab` ← **this one cannot be absorbed** (a different stem)
 *
 * As the last example shows, some naming cannot be followed mechanically, so **this function
 * only widens the candidates**. It assumes some will remain unreachable and guarantees only
 * that it does not drop the ones within reach.
 * @param {string} baseId
 * @returns {Set<string>}
 */
export function variantRoots(baseId) {
  return new Set([
    baseId,
    baseId.replace(/_block$/, ''),
    baseId.replace(/s$/, ''),
    baseId.replace(/_bricks$/, '_brick'),
    baseId.replace(/_tiles$/, '_tile'),
  ]);
}

/**
 * For the bases already included, returns the derivatives that **exist officially but are not
 * in the catalogue**.
 *
 * @param {object} args
 * @param {readonly string[]} args.fullIds the IDs of the full blocks in the catalogue
 * @param {ReadonlySet<string>} args.catalogIds every ID in the catalogue (derivatives included)
 * @param {ReadonlySet<string>} args.officialIds every block ID that exists officially
 * @returns {{ baseId: string; missingId: string }[]} deduplicated, in input order
 */
export function findMissingVariants({ fullIds, catalogIds, officialIds }) {
  const found = [];
  const seen = new Set();
  for (const baseId of fullIds) {
    for (const root of variantRoots(baseId)) {
      for (const suffix of VARIANT_SUFFIXES) {
        const missingId = root + suffix;
        if (!officialIds.has(missingId)) continue;
        if (catalogIds.has(missingId)) continue;
        if (seen.has(missingId)) continue;
        seen.add(missingId);
        found.push({ baseId, missingId });
      }
    }
  }
  return found;
}

/** How one report line is shown (gen-blocks output and the tests use the same function) */
export function formatMissingVariant({ baseId, missingId }) {
  return `${baseId} → ${missingId}`;
}
