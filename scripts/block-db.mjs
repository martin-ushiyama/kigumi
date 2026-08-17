/**
 * **Assembly of the unified DB** that binds the four upstream sources into one record
 * (#97 stage 2). Pure functions only.
 *
 * Facts about the same block being scattered by hand across several places was the common
 * cause of the incidents hit in #92 and #94. Binding upstream into a single thing that can be
 * looked up removes both the room to guess and the room for copies to appear.
 *
 * ## Contract
 *
 * 1. **Lossless.** Per-face specifications and the multiplicity of candidates are not dropped.
 *    Reducing to `{ side, top }` is the job of stage 3 (the projection into the app manifest)
 *    and is not collapsed in the DB — collapsing here makes "up differs from down", "the four
 *    sides differ" and "there are several candidates" impossible to tell apart ever again
 * 2. Upstream values are **held in their original shape**. The results of expansion or
 *    reduction are not held alongside them (one fact in two shapes lets one go stale).
 *    Whoever needs the expansion calls `expandFaceRefs`
 * 3. Nothing uninterpretable or missing is filled in silently. It all goes to `diagnostics`
 *
 * ## What it does not hold
 *
 * - `textureFrames` (the frame count of an animation). The physical frame count needs the PNG
 *   dimensions and deciding whether something is animated needs flipbook_textures.json.
 *   It cannot be derived from the four sources, so the source of truth stays in #93 (never
 *   generate it in two places)
 * - Japanese names, categories, representative colours, inclusion. Those are **our decisions**
 *   rather than something from Mojang, and stage 4's `curation.json` holds them
 */
import {
  collectRefNames,
  expandFaceRefs,
  FACES,
  normalizeTextureVariants,
  parseLangEntries,
  variantPath,
} from './bedrock-parse.mjs';

const NOTE =
  'The unified DB binding the four upstream sources (mojang-blocks / resource_pack blocks / terrain_texture / en_US.lang). ' +
  'Lossless — per-face specifications and the multiplicity of candidates are not dropped. It does not hold textureFrames (the source of truth is #93). ' +
  'Japanese names, categories, representative colours and inclusion do not come from Mojang, so they are not held here (stage 4, curation.json). ' +
  'It is generated output and is not committed. Rebuild it with npm run build:block-db.';

/** Strips `minecraft:`. resource_pack/blocks.json and en_US.lang are keyed without the namespace */
const bareId = (id) => id.replace(/^minecraft:/, '');

/**
 * Looks up the value ranges from `block_properties`.
 *
 * The properties in `data_items` **carry only the property name**, so the ranges exist nowhere
 * else. Even booleans are spelled out upstream as `[{value:false},{value:true}]`, so they are
 * listed as-is (building `[false, true]` here would hide a change upstream).
 */
function statesOf(dataItem, propertyIndex, diagnostics) {
  const states = {};
  for (const { name } of dataItem.properties ?? []) {
    const prop = propertyIndex.get(name);
    if (!prop) {
      diagnostics.push({
        kind: 'unknownProperty',
        id: dataItem.name,
        detail: `block_properties has no ${name}`,
      });
      continue;
    }
    states[name] = (prop.values ?? []).map((v) => v.value);
  }
  // Keep the key order independent of the upstream ordering (so a reshuffle alone never produces a diff)
  return Object.fromEntries(Object.keys(states).sort().map((k) => [k, states[k]]));
}

/**
 * Resolves the textures of a single block.
 *
 * `terrain_texture.json` is a dictionary keyed by **texture name**, so a block ID cannot reach
 * a real file without `resource_pack/blocks.json` as the bridge (the cause of the 10 blocks
 * left "unidentifiable" in #92).
 */
function texturesOf({ id, refs, terrainTextureData, diagnostics }) {
  const resolved = {};
  for (const name of collectRefNames(refs)) {
    const variants = normalizeTextureVariants(terrainTextureData[name]);
    if (variants === null) {
      diagnostics.push({
        kind: 'unknownTextureName',
        id,
        detail: `terrain_texture.json has no ${name}`,
      });
      continue;
    }
    resolved[name] = variants;
    const broken = variants.filter((v) => variantPath(v) === null);
    if (broken.length > 0) {
      diagnostics.push({
        kind: 'unresolvableVariant',
        id,
        detail: `cannot take a path out of the candidates of ${name}: ${JSON.stringify(broken)}`,
      });
    }
  }

  // Only checks whether it can expand. **The result is not held** (contract 2 — whoever needs
  // it calls expandFaceRefs)
  const { faces, notes } = expandFaceRefs(refs);
  for (const note of notes) {
    diagnostics.push({ kind: faces === null ? 'unresolvableRefs' : 'refsNote', id, detail: note });
  }

  return { refs: refs ?? null, resolved: Object.fromEntries(Object.keys(resolved).sort().map((k) => [k, resolved[k]])) };
}

/**
 * Assembles the unified DB.
 *
 * @param {object} input
 * @param {object} input.mojangBlocks     metadata/vanilladata_modules/mojang-blocks.json
 * @param {object} input.resourcePackBlocks resource_pack/blocks.json
 * @param {object} input.terrainTexture   resource_pack/textures/terrain_texture.json
 * @param {string} input.langText         the contents of resource_pack/texts/en_US.lang
 * @param {object|null} input.source      the record in data/bedrock/SOURCE.json (which upstream it was built from)
 */
export function buildBlockDb({ mojangBlocks, resourcePackBlocks, terrainTexture, langText, source = null }) {
  const dataItems = mojangBlocks?.data_items;
  if (!Array.isArray(dataItems)) throw new Error('mojang-blocks.json has no data_items');
  const terrainTextureData = terrainTexture?.texture_data;
  if (!terrainTextureData || typeof terrainTextureData !== 'object') {
    throw new Error('terrain_texture.json has no texture_data');
  }

  const propertyIndex = new Map((mojangBlocks.block_properties ?? []).map((p) => [p.name, p]));
  const { exact: langExact } = parseLangEntries(langText);
  const diagnostics = [];

  const blocks = dataItems.map((item) => {
    const bare = bareId(item.name);
    const packEntry = resourcePackBlocks[bare];

    if (packEntry === undefined) {
      diagnostics.push({
        kind: 'missingTextureEntry',
        id: item.name,
        detail: 'resource_pack/blocks.json has no entry',
      });
    } else if (packEntry.textures === undefined) {
      // A block with no appearance, such as air or light_block*. Recorded as a fact
      diagnostics.push({ kind: 'noTextureRefs', id: item.name, detail: 'the entry has no textures' });
    }

    const nameEn = langExact.get(bare) ?? null;
    if (nameEn === null) {
      // Older blocks are stored in a parent.variant form such as `tile.stone.granite.name` and
      // cannot be looked up from a block ID. **Do not guess** — guessing at the naming
      // convention is exactly the #92 incident
      diagnostics.push({
        kind: 'missingNameEn',
        id: item.name,
        detail: `en_US.lang has no tile.${bare}.name`,
      });
    }

    return {
      id: item.name,
      serializationId: item.serialization_id ?? null,
      rawId: item.raw_id ?? null,
      nameEn,
      states: statesOf(item, propertyIndex, diagnostics),
      textures: texturesOf({ id: item.name, refs: packEntry?.textures, terrainTextureData, diagnostics }),
    };
  });

  /**
   * Texture entries with no counterpart in `data_items` (older aggregate names such as
   * `carpet` and `double_stone_slab`).
   *
   * **They are held with their contents, in the same shape as a block.** They used to be
   * pushed onto diagnostics as an ID plus a boilerplate sentence, but that lost the original
   * entry's `textures` and its resolution result, which did not meet the goal of "keeping
   * them" (#97 stage 2 review). The `stone_slab` family's textures may only be reachable
   * through these names, so they are useless unless stage 3 can look them up the same way.
   *
   * They are held as data rather than as diagnostics because they are **an upstream fact**,
   * not something uninterpretable. summarizeBlockDb counts them.
   */
  const knownBare = new Set(dataItems.map((i) => bareId(i.name)));
  const orphanTextureEntries = Object.keys(resourcePackBlocks)
    .filter((key) => key !== 'format_version' && !knownBare.has(key))
    .sort()
    .map((key) => ({
      key,
      textures: texturesOf({
        id: key,
        refs: resourcePackBlocks[key]?.textures,
        terrainTextureData,
        diagnostics,
      }),
    }));

  blocks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  diagnostics.sort((a, b) =>
    a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  return { _note: NOTE, source, blocks, orphanTextureEntries, diagnostics };
}

/** The single representation used when writing the generated output to a file (comparison and writing both go through it) */
export const formatBlockDb = (db) => JSON.stringify(db, null, 2) + String.fromCharCode(10);

/**
 * Whether this one record **reaches a real file path on all six faces**.
 *
 * The check used to be "reached if `resolved` has at least one key", but that passes "only
 * some faces resolve" and "there are candidates but not one path can be taken out of them
 * (only `{overlay_color}`, etc.)" as reached (#97 stage 2 review).
 *
 * This predicate is the premise on which stage 3 (switching texture generation over to the DB)
 * stands, so the decision lives in this one place and callers are not given their own way of
 * counting.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function textureReachability(record) {
  const { faces, notes } = expandFaceRefs(record?.textures?.refs);
  if (!faces) return { ok: false, problems: notes.length > 0 ? notes : ['cannot expand into six faces'] };

  const problems = [];
  for (const face of FACES) {
    const name = faces[face];
    const variants = record.textures.resolved?.[name];
    if (!variants || variants.length === 0) {
      problems.push(`${face}: ${name} is not resolved`);
      continue;
    }
    if (!variants.some((v) => variantPath(v) !== null)) {
      problems.push(`${face}: cannot take a file path out of the candidates of ${name}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * A summary for eyeballing. **It does not go into the file** — holding values that can be
 * counted from the contents lets one of them go stale (the very structure this issue is
 * removing).
 */
export function summarizeBlockDb(db) {
  const byKind = {};
  for (const d of db.diagnostics) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  const withRefs = db.blocks.filter((b) => b.textures.refs !== null).length;
  const resolvedNames = new Set(
    [...db.blocks, ...db.orphanTextureEntries].flatMap((b) => Object.keys(b.textures.resolved)),
  );
  return {
    blocks: db.blocks.length,
    withTextureRefs: withRefs,
    /** How many reach a real file path on all six faces (not merely whether a key exists) */
    fullyReachable: db.blocks.filter((b) => textureReachability(b).ok).length,
    withNameEn: db.blocks.filter((b) => b.nameEn !== null).length,
    withStates: db.blocks.filter((b) => Object.keys(b.states).length > 0).length,
    distinctTextureNames: resolvedNames.size,
    orphanTextureEntries: db.orphanTextureEntries.length,
    diagnostics: byKind,
  };
}
