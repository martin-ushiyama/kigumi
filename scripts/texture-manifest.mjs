/**
 * The **projection from the unified DB into the app's texture manifest**
 *. Pure functions only.
 *
 * The DB is lossless — it holds the reference of each of the six faces and the multiplicity of
 * the candidates as-is. The renderer, on the other hand, handles only the two values
 * `{ side, top? }` (`voxelmesh.ts`: top is applied to both +y and -y).
 * **That upstream only has that shape and that the renderer only handles that shape are
 * different facts**, so the collapsing is confined to this one place.
 *
 * ## Contract
 *
 * 1. Every block in the included catalogue can be projected
 * 2. **Zero unclassified ambiguity or lossy projection.** Several candidates / a different
 *    picture on top and bottom / the four sides disagreeing — none of them silently takes the
 *    first one; generation fails until a ruling with a reason is placed in
 *    `texture-ledger.json`
 * 3. A ruling that changes the appearance pins **the projection result itself** with `expect`.
 *    If upstream moves and produces a different value, it fails (rather than making a human
 *    eyeball it on every generation)
 *
 * ## What does not belong here
 *
 * - how upstream is read (`bedrock-parse.mjs`) / assembling the DB (`block-db.mjs`)
 * - what to include, Japanese names, representative colours (stage 4's `curation.json`)
 */
import { expandFaceRefs, FACES, variantPath } from './bedrock-parse.mjs';

/** A manifest file name is the relative path with this prefix stripped, plus `.png` */
const BLOCKS_PREFIX = 'textures/blocks/';

/** The four faces (everything but up and down) that `side` stands for. The manifest's `side` assumes these four agree */
const SIDE_FACES = ['north', 'south', 'east', 'west'];

/** The keys usable in the ledger. When adding one, update the README and the CI-side validation too */
const LEDGER_KEYS = ['variantIndex', 'dropsDownFace', 'expect', 'changesAppearance', 'reason'];

/**
 * Turns a `terrain_texture.json` path into a manifest file name.
 *
 * Paths pointing outside `textures/blocks/` really exist (84 of them, `textures/items/` and
 * friends). Dropping the prefix would change what the relative path means, so it
 * **returns null without converting and lets the caller reject it**.
 */
function manifestFileOf(path) {
  if (!path.startsWith(BLOCKS_PREFIX)) return null;
  return path.slice(BLOCKS_PREFIX.length) + '.png';
}

/**
 * Resolves the texture name of a single face into a real file name.
 *
 * `terrain_texture.json` has several candidates because of the old generation's data-value
 * multiplexing (`stone` → stone / granite / diorite …). **Which one to take is not determined
 * by upstream**, so without a `variantIndex` in the ledger it is returned as a problem.
 *
 * **The index applies to the upstream candidate array itself.** Candidates from which no path
 * can be taken (only `{overlay_color}`, etc.) used to be filtered out before indexing, but that
 * meant (1) the index drifted from the upstream data and the ledger pointed at a different
 * candidate, and (2) when filtering left exactly one, it slipped past the "several candidates"
 * check and the first was taken with no ruling. Both the multiplicity
 * check and the position taken use the upstream array as the single yardstick.
 */
function resolveFace({ face, name, resolved, variantIndex }) {
  const variants = resolved?.[name];
  if (!variants || variants.length === 0) {
    return { problem: { kind: 'unresolvedFace', detail: `${face}: ${name} is not resolved in the DB` } };
  }

  let index = 0;
  if (variants.length > 1) {
    if (variantIndex === undefined) {
      const shown = variants.map((v, i) => `[${i}] ${variantPath(v) ?? JSON.stringify(v)}`).join(', ');
      return {
        problem: {
          kind: 'ambiguousVariant',
          detail: `${face}: ${name} has ${variants.length} candidates (${shown}). Decide which to take with variantIndex in the ledger`,
        },
      };
    }
    if (!Number.isInteger(variantIndex) || variantIndex < 0 || variantIndex >= variants.length) {
      return {
        problem: {
          kind: 'variantIndexOutOfRange',
          detail: `${face}: ${name} has ${variants.length} candidates but the ledger's variantIndex is ${variantIndex}`,
        },
      };
    }
    index = variantIndex;
  }

  const path = variantPath(variants[index]);
  if (path === null) {
    return {
      problem: {
        kind: 'unresolvedFace',
        detail: `${face}: cannot take a file path out of candidate [${index}] of ${name} (${JSON.stringify(variants[index] ?? null)})`,
      },
    };
  }

  const file = manifestFileOf(path);
  if (file === null) {
    return {
      problem: {
        kind: 'pathOutsideBlocks',
        detail: `${face}: ${path} points outside ${BLOCKS_PREFIX}`,
      },
    };
  }
  return { file };
}

/**
 * Projects one DB record into `{ side, top? }`.
 *
 * `top` is carried **only when it differs from side** (the renderer treats `top === side` as
 * uniform, so holding the same value would write the same fact in two places).
 *
 * @param {object} record  one record of the unified DB
 * @param {object} [ledgerEntry] the matching entry in `texture-ledger.json`
 * @returns {{ entry: object|null, problems: Array<{kind: string, detail: string}> }}
 */
export function projectBlockTextures(record, ledgerEntry = undefined) {
  const { faces, notes } = expandFaceRefs(record?.textures?.refs);
  if (!faces) {
    return { entry: null, problems: [{ kind: 'noFaceRefs', detail: notes.join(' / ') || 'cannot expand into six faces' }] };
  }
  // Even when it expands, a collapsed decision is never let through silently (2 cases in the
  // real data, both azalea. Neither is in the included catalogue, but if one arrives it is
  // ruled on before passing)
  if (notes.length > 0) {
    return { entry: null, problems: notes.map((detail) => ({ kind: 'ambiguousRefs', detail })) };
  }

  const problems = [];
  const fileOf = {};
  for (const face of FACES) {
    const { file, problem } = resolveFace({
      face,
      name: faces[face],
      resolved: record.textures.resolved,
      variantIndex: ledgerEntry?.variantIndex,
    });
    if (problem) problems.push(problem);
    else fileOf[face] = file;
  }
  if (problems.length > 0) return { entry: null, problems };

  const sideFiles = [...new Set(SIDE_FACES.map((f) => fileOf[f]))];
  if (sideFiles.length > 1) {
    problems.push({
      kind: 'sideFacesDiffer',
      detail: `the four sides disagree (${SIDE_FACES.map((f) => `${f}=${fileOf[f]}`).join(' ')}). The renderer applies one image to all four sides, so this cannot be projected`,
    });
  }
  if (fileOf.up !== fileOf.down && ledgerEntry?.dropsDownFace !== true) {
    problems.push({
      kind: 'dropsDownFace',
      detail: `the top ${fileOf.up} differs from the bottom ${fileOf.down}. The renderer applies top to both, so the bottom is discarded. If that is intended, put dropsDownFace in the ledger`,
    });
  }
  if (problems.length > 0) return { entry: null, problems };

  const entry = { side: sideFiles[0] };
  if (fileOf.up !== entry.side) entry.top = fileOf.up;
  return { entry, problems: [] };
}

/**
 * Assembles the manifest for the included catalogue.
 *
 * @param {object} input
 * @param {object[]} input.catalogIds the IDs of the included blocks (from `src/data/blocks.json`)
 * @param {object[]} input.dbBlocks   the blocks of the unified DB
 * @param {object} input.ledger       `src/data/texture-ledger.json`
 * @returns {{ manifest: object, problems: string[], appearanceChanges: Array<{id, from, to, reason}> }}
 */
export function buildTextureManifest({ catalogIds, dbBlocks, ledger }) {
  const byId = new Map(dbBlocks.map((b) => [b.id, b]));
  const manifest = {};
  const problems = [];
  const appearanceChanges = [];
  const usedLedgerIds = new Set();

  for (const [id, entry] of Object.entries(ledger)) {
    const unknown = Object.keys(entry).filter((k) => !LEDGER_KEYS.includes(k));
    if (unknown.length > 0) problems.push(`${id}: the ledger has unknown keys (${unknown.join(', ')})`);
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      problems.push(`${id}: the ledger entry has no reason (a contract with no stated reason cannot be kept)`);
    }
    if (entry.changesAppearance === true && entry.expect === undefined) {
      problems.push(`${id}: a ruling that changes the appearance needs expect (the projection result it expects)`);
    }
  }

  for (const id of catalogIds) {
    const record = byId.get(id);
    if (!record) {
      problems.push(`${id}: there is no record in the unified DB`);
      continue;
    }
    const ledgerEntry = ledger[id];
    if (ledgerEntry) usedLedgerIds.add(id);

    const { entry, problems: found } = projectBlockTextures(record, ledgerEntry);
    if (!entry) {
      for (const p of found) problems.push(`${id}: [${p.kind}] ${p.detail}`);
      continue;
    }

    // **expect is the contract that pins the projection result.** If upstream moves and
    // produces a different value it fails — differing from what was in view when the ruling was
    // made means the ruling needs to be made again
    if (ledgerEntry?.expect !== undefined && JSON.stringify(entry) !== JSON.stringify(ledgerEntry.expect)) {
      problems.push(
        `${id}: the ledger's expect ${JSON.stringify(ledgerEntry.expect)} differs from the projection result ${JSON.stringify(entry)}`,
      );
      continue;
    }
    if (ledgerEntry?.changesAppearance === true) {
      appearanceChanges.push({ id, to: entry, reason: ledgerEntry.reason });
    }
    manifest[id] = entry;
  }

  // Keeping unused rulings makes it impossible to tell which contracts are live (the structure the unified DB removes)
  const stale = Object.keys(ledger).filter((id) => !usedLedgerIds.has(id));
  if (stale.length > 0) problems.push(`ledger entries that are not in the catalogue (${stale.length}): ${stale.join(', ')}`);

  return { manifest, problems, appearanceChanges };
}
