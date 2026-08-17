/**
 * The list of blocks not yet included. Pure functions only.
 *
 * The unified DB (stage 2) holds every Mojang block, and curation (stage 4) holds whether a
 * block is included. The difference between them is "what could be added next". **A human
 * decides what to add**, so this only lays out the material for that decision — it makes no
 * call such as "can be added right away / needs a shape implementation".
 *
 * ## Why it makes no call
 *
 * Whether a shape is needed is not determined by the presence of `states`. Blocks without
 * states include fences, carpets, glass panes and shulker boxes, none of which are cubes. A
 * machine guessing at a distinction upstream does not record would point the opposite way from
 * building the DB (whose purpose is to remove guessing).
 *
 * ## Series
 *
 * Inclusion advances in groups such as "the 16 wool colours" rather than one at a time. **The
 * colour list is not held here** — upstream has no colour value range in its states (in 1.21
 * each colour is a separate id), and enumerating them here would hide a change upstream.
 * Instead they are grouped by **a shared id suffix**. The same rule picks up sequences of
 * woods and ores, not just colours.
 */

/** Strips `minecraft:`. The word structure of an id is read without the prefix */
const bareId = (id) => id.replace(/^minecraft:/, '');

/**
 * Groups ids by "shared suffix".
 *
 * For each id, suffix candidates are built by extending one word at a time from the end, and
 * **the longest one shared by two or more ids** becomes that id's series. The longest is taken
 * so that `stained_glass_pane` is not absorbed into `stained_glass`.
 *
 * Candidates that leave an empty prefix (the whole id being the suffix) are not used — when
 * `oak_fence` and `fence` line up in the same column, the latter is a bare entry rather than "a
 * member of the series".
 *
 * **"Two or more" at the candidate stage is not enough**. Each id picks its own
 * longest, so the side that was not picked can thin out to a single entry — with `copper_bulb`
 * / `exposed_copper_bulb` / `waxed_copper_bulb` / `waxed_exposed_copper_bulb`, the last three
 * move to `copper_bulb` and one is left behind on the `bulb` side. **After the final
 * assignment, "two or more" is checked once more and the rest are dropped.** Dropped ids are
 * picked up as singles by the caller (`listUncurated`).
 *
 * @param {string[]} ids ids without the prefix
 * @returns {Map<string, string[]>} suffix → the ids in that sequence (in input order). **Every sequence has at least 2**
 */
export function groupBySuffix(ids) {
  /** suffix candidate → the ids sharing it */
  const candidates = new Map();
  for (const id of ids) {
    const parts = id.split('_');
    // From the last word up to the length that still leaves at least one word of prefix
    for (let take = 1; take < parts.length; take++) {
      const suffix = parts.slice(parts.length - take).join('_');
      if (!candidates.has(suffix)) candidates.set(suffix, []);
      candidates.get(suffix).push(id);
    }
  }

  /** id → the suffix it belongs under (the longest among those shared by two or more) */
  const chosen = new Map();
  for (const [suffix, members] of candidates) {
    if (members.length < 2) continue;
    for (const id of members) {
      const current = chosen.get(id);
      if (current === undefined || suffix.length > current.length) chosen.set(id, suffix);
    }
  }

  const series = new Map();
  for (const id of ids) {
    const suffix = chosen.get(id);
    if (suffix === undefined) continue;
    if (!series.has(suffix)) series.set(suffix, []);
    series.get(suffix).push(id);
  }

  // A sequence that thinned to one entry as a result of taking the longest is not a series
  for (const [suffix, members] of series) {
    if (members.length < 2) series.delete(suffix);
  }
  return series;
}

/**
 * Lays out the blocks that are not included, **split into series and singles**.
 *
 * An id with an entry in `curation.json` is not counted as uncurated even when
 * `included: false` (deliberately excluded) — letting something already decided resurface as a
 * candidate would erase the meaning of excluding it.
 *
 * @param {{ blocks: Array<{id: string, nameEn: string|null, states: object, textures: {resolved: object}}> }} db the unified DB (only blocks is read)
 * @param {Set<string>} decidedIds ids with a curation entry (with `minecraft:`, regardless of included)
 * @returns {{ series: Array<{suffix: string, blocks: object[]}>, singles: object[], total: number }}
 */
export function listUncurated(db, decidedIds) {
  const uncurated = (db?.blocks ?? [])
    .filter((block) => !decidedIds.has(block.id))
    .map((block) => ({
      id: block.id,
      bareId: bareId(block.id),
      nameEn: block.nameEn ?? null,
      stateNames: Object.keys(block.states ?? {}),
      /** Whether a texture can be looked up. **Not lookupable ≠ not addable** (some blocks hold theirs under an aggregate name) */
      hasTexture: Object.keys(block.textures?.resolved ?? {}).length > 0,
    }));

  const byBareId = new Map(uncurated.map((block) => [block.bareId, block]));
  const grouped = groupBySuffix(uncurated.map((block) => block.bareId));

  const series = [...grouped.entries()]
    .map(([suffix, ids]) => ({ suffix, blocks: ids.map((id) => byBareId.get(id)) }))
    // Larger sequences first. Ties are stabilized by the lexical order of the suffix
    .sort((a, b) => b.blocks.length - a.blocks.length || a.suffix.localeCompare(b.suffix));

  const inSeries = new Set(series.flatMap((entry) => entry.blocks.map((block) => block.bareId)));
  const singles = uncurated.filter((block) => !inSeries.has(block.bareId));

  return { series, singles, total: uncurated.length };
}
