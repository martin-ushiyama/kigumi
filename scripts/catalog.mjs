/**
 * **Assembly** of the catalogue (`src/data/blocks.json`) (#97 stage 4). Pure functions only.
 *
 * It holds only the part that takes the inclusion decisions (`curation.json`) and the upstream
 * facts (the snapshot) and lays them out. How upstream is read (resolving display names,
 * whether pillar_axis exists) is injected as functions by the caller — the upstream files are
 * gitignored and CI has no real copy, so the assembly rules themselves could not be tested if
 * they depended on the real files (the same reason as bedrock-parse.mjs / texture-manifest.mjs).
 */

/**
 * What to do when the parent of a derived block (slab / stairs) is not in the included
 * catalogue.
 *
 * **Tell "deliberately excluded" apart from "no such id is known"** (#97 stage 4 review, P1).
 * Without the distinction it was an error either way, so a material with derived blocks broke
 * generation the moment it was set to `included: false` — the central contract of `included`,
 * "you can drop something from the catalogue while keeping the decision", did not work for
 * materials that have derived blocks.
 *
 * @returns {'present' | 'excluded' | 'unknown'}
 */
export function classifyVariantBase(baseId, { includedIds, excludedIds }) {
  if (includedIds.has(baseId)) return 'present';
  // there is a curation entry but it is not included → the derived blocks go with it (not an error)
  if (excludedIds.has(baseId)) return 'excluded';
  // there is no curation entry → it points at an id with no mapping (this is an error)
  return 'unknown';
}

/**
 * Assembles the included catalogue.
 *
 * The order is **the curated order (= by category, in the order written in curation.json),
 * then the derived blocks**. Derived blocks are stacked slab → stairs in the order of
 * `materials`. The palette follows this order.
 *
 * @param {object} input
 * @param {Array<{id: string, nameJa: string|null, category: string}>} input.curated `curatedBlocks().blocks`
 * @param {Set<string>} input.excludedIds `curatedBlocks().excludedIds` (with `minecraft:`)
 * @param {ReadonlyArray<{baseId: string, slabId?: string|null, stairsId?: string|null}>} input.materials the material ↔ derived mapping
 * @param {(bareId: string) => boolean} input.isOfficial whether it exists in the upstream official list
 * @param {(bareId: string) => string|null} input.resolveNameEn the English display name (null when unresolved)
 * @param {(bareId: string) => string|null} input.resolveNameJa the Japanese display name (null when unresolved)
 * @param {(bareId: string) => boolean} input.hasPillarAxis whether it has pillar_axis
 * @returns {{ blocks: object[], errors: string[], skippedVariantsOf: string[] }}
 */
export function buildCatalog({
  curated,
  excludedIds,
  materials,
  isOfficial,
  resolveNameEn,
  resolveNameJa,
  hasPillarAxis,
}) {
  const blocks = [];
  const errors = [];
  /** Materials deliberately excluded, so their derived blocks were not emitted either (for eyeballing, not an error) */
  const skippedVariantsOf = [];

  for (const { id: fullId, nameJa: curatedNameJa, category } of curated) {
    const bare = fullId.replace('minecraft:', '');
    if (!isOfficial(bare)) {
      errors.push(bare);
      continue;
    }
    const nameEn = resolveNameEn(bare);
    if (!nameEn) {
      errors.push(`cannot resolve the English name: ${bare}`);
      continue;
    }
    // The official files are the source of truth. curation only fills in **when they cannot supply it**
    const nameJa = resolveNameJa(bare) ?? curatedNameJa;
    if (!nameJa) {
      errors.push(`cannot resolve the Japanese name: ${bare} (the official files cannot supply it, so write nameJa in curation.json)`);
      continue;
    }
    // **The representative colour is not decided here.** Colour is a property of the texture, so
    // `texture-colors.json` holds it and the catalogue does not touch it. Demanding a colour
    // here would create a cycle when including a new block: "without the catalogue you cannot
    // fetch the texture / without the colour you cannot build the catalogue" (#137 review, P1)
    const entry = { id: fullId, nameJa, nameEn, category, shape: 'full', materialGroup: bare };
    if (hasPillarAxis(bare)) entry.states = { pillar_axis: 'y' };
    blocks.push(entry);
  }

  const includedIds = new Set(blocks.map((e) => e.id));

  /** Stacks one derived block. It inherits the parent's values (category, representative colour) */
  const pushVariant = (base, variantId, shape, suffix) => {
    if (!isOfficial(variantId)) {
      errors.push(variantId);
      return;
    }
    const nameEn = resolveNameEn(variantId);
    if (!nameEn) {
      errors.push(`cannot resolve the English name: ${variantId}`);
      return;
    }
    blocks.push({
      id: `minecraft:${variantId}`,
      // Derived blocks have official names too. Only when one cannot be looked up is it
      // assembled from the parent
      // i18n-allow: the suffix is part of the Japanese display name itself
      nameJa: resolveNameJa(variantId) ?? `${base.nameJa}（${suffix}）`,
      nameEn,
      category: base.category,
      shape,
      materialGroup: base.materialGroup,
    });
  };

  for (const { baseId, slabId, stairsId } of materials) {
    const kind = classifyVariantBase(`minecraft:${baseId}`, { includedIds, excludedIds });
    if (kind === 'excluded') {
      skippedVariantsOf.push(baseId);
      continue;
    }
    if (kind === 'unknown') {
      errors.push(`unknown materialGroup: ${baseId} (not in curation.json)`);
      continue;
    }
    const base = blocks.find((e) => e.id === `minecraft:${baseId}`);
    // i18n-allow: these suffixes are Japanese display-name data, not UI wording
    if (slabId) pushVariant(base, slabId, 'slab', 'ハーフ');
    if (stairsId) pushVariant(base, stairsId, 'stairs', '階段');
  }

  return { blocks, errors, skippedVariantsOf };
}
