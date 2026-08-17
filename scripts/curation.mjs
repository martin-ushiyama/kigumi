/**
 * The **read rules** for the inclusion policy (`src/data/curation.json`).
 * Pure functions only.
 *
 * What curation holds are the decisions that do not come from Mojang — what to include and
 * which category, plus **filling the gaps in Japanese names that cannot be looked up from the
 * official files**. Representative colours are a property of the texture and are not held here
 * (`texture-colors.json` is the source of truth). How upstream is read (resolving a lang key
 * that does not line up with the id, and so on) stays in `gen-blocks.mjs`. Mixing them makes
 * "why was this value needed" untraceable when the upstream version is bumped.
 *
 * It is separated from file reading so that the rules themselves can be tested (the same
 * reason as bedrock-parse.mjs / texture-manifest.mjs).
 */

/**
 * The order things appear in the catalogue. **This order becomes the order of the palette**,
 * so it is held as a sequence rather than a set. Within a category, the order written in
 * curation.json is used as-is.
 */
export const CURATION_CATEGORIES = ['stone', 'wood', 'soil'];

/** The keys usable in one curation entry. When adding one, update the type definition and the validation too */
const ENTRY_KEYS = ['nameJa', 'category', 'included', 'note'];

/**
 * Resolves curation.json into **an array in the order it appears in the catalogue**.
 *
 * `included: false` is dropped, but the entry itself is assumed to remain — being able to
 * remove something from the catalogue without erasing the decision is the reason `included`
 * exists, so it is not treated as a gap here.
 * **Deliberately excluded ids are returned in `excludedIds`** — if the caller (generating the
 * derived blocks) cannot tell "deliberately excluded" from "no such id is known", generation
 * breaks the moment something is excluded (raised in review).
 *
 * @param {object} doc the parsed `src/data/curation.json`
 * @returns {{ blocks: Array<{id: string, nameJa: string|null, category: string}>, excludedIds: Set<string>, problems: string[] }}
 */
export function curatedBlocks(doc) {
  const problems = [];
  const entries = doc?.entries;
  if (!entries || typeof entries !== 'object') {
    return { blocks: [], excludedIds: new Set(), problems: ['curation.json has no entries'] };
  }

  const byCategory = new Map(CURATION_CATEGORIES.map((c) => [c, []]));
  const excludedIds = new Set();
  for (const [id, entry] of Object.entries(entries)) {
    const unknown = Object.keys(entry ?? {}).filter((k) => !ENTRY_KEYS.includes(k));
    if (unknown.length > 0) problems.push(`${id}: unknown key (${unknown.join(', ')})`);

    if (!id.startsWith('minecraft:')) problems.push(`${id}: write the id with the minecraft: prefix`);
    // **nameJa is optional.** When it can be looked up from the official ja_JP.lang, that is the
    // source of truth, and what is written here only fills the gaps for older blocks stored in
    // the `tile.<parent>.<variant>.name` form.
    // **It only takes effect when the official files cannot supply it** (the official ones are
    // the source of truth review)
    if (entry?.nameJa !== undefined && (typeof entry.nameJa !== 'string' || entry.nameJa.trim() === '')) {
      problems.push(`${id}: nameJa must be a string (it may be omitted when the official files supply it)`);
    }
    // **The representative colour does not belong to curation.** The average colour of the
    // texture is the source of truth, and leaving a place to write it here would make "which
    // one wins" impossible to tell ever again
    // **Inclusion requires a boolean** (raised in review). Deciding with `!== true` would
    // treat a missing value, null, or the string "true" the same as a proper false, with no
    // diagnostic either. The point is to make inclusion an explicit, canonical decision, so
    // ambiguous values are rejected
    if (typeof entry?.included !== 'boolean') {
      problems.push(`${id}: included must be written as true / false: ${JSON.stringify(entry?.included ?? null)}`);
      continue;
    }
    // The category is the ordering itself, so an unknown value is rejected rather than being
    // sent silently to the end
    const bucket = byCategory.get(entry.category);
    if (!bucket) {
      problems.push(`${id}: unknown category ${JSON.stringify(entry.category ?? null)} (the usable ones are ${CURATION_CATEGORIES.join(' / ')})`);
      continue;
    }
    if (!entry.included) {
      excludedIds.add(id);
      continue;
    }
    bucket.push({ id, nameJa: entry.nameJa ?? null, category: entry.category });
  }

  return { blocks: CURATION_CATEGORIES.flatMap((c) => byCategory.get(c)), excludedIds, problems };
}
