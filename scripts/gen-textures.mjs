/**
 * Generates the block → texture file name mapping and (with --fetch) fetches the real files.
 *
 * **The manifest is a projection of the unified DB (`data/block-db.json`)**; it holds no
 * hand-written mapping. The 136 entries used to be laid out by hand, which
 * produced 18 errors (a cut-end picture applied to the sides / reusing the uncracked picture /
 * picking up a file upstream never assigned, and so on). The point is to remove the path where
 * a human transcribes a file name.
 *
 * The decisions the upstream facts alone do not determine (which candidate to take when there
 * are several, discarding the bottom face because the renderer cannot separate top from bottom,
 * a ruling that changes the appearance against the current output) live in
 * `src/data/texture-ledger.json` with their reasons. **A result differing from a ruling fails.**
 *
 * **Every block in the catalogue (blocks.json) needs a matching entry.** Generation fails when
 * one is missing, or when an entry has no block in the catalogue (assertCoversCatalog).
 *
 * Usage:
 *   npm run build:block-db                   # build the unified DB first (needs the snapshot)
 *   node scripts/gen-textures.mjs            # regenerate src/data/textures.json only
 *   node scripts/gen-textures.mjs --fetch    # also fetch the real files into public/textures/blocks/
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rawUrl, readSource } from './bedrock-snapshot.mjs';
import { parseTextureSource } from './flipbook.mjs';
import { buildTextureManifest } from './texture-manifest.mjs';

/**
 * The generation record of the PNG cache. It keeps **which commit they were pulled from**.
 *
 * public/textures/ is gitignored, so this record is not committed either. It is here so that a
 * later stage (gen-texture-frames) can judge how old the local cache is.
 */
const TEXTURE_SOURCE_PATH = () => join(process.cwd(), 'public/textures/.source.json');

export function readTextureSource() {
  const p = TEXTURE_SOURCE_PATH();
  if (!existsSync(p)) return null;
  try {
    // Being readable as JSON and being usable as a record are different things. Returning a
    // structurally invalid value such as {} makes the next stage throw a TypeError at
    // commit.slice(). An unusable record collapses to null = generation unknown
    // and flows into the refetch path
    return parseTextureSource(JSON.parse(readFileSync(p, 'utf-8')));
  } catch {
    return null; // treat a broken one as "generation unknown" (which forces a refetch)
  }
}

function writeTextureSource(record) {
  mkdirSync(join(process.cwd(), 'public/textures'), { recursive: true });
  writeFileSync(TEXTURE_SOURCE_PATH(), JSON.stringify(record, null, 2) + String.fromCharCode(10));
}

/**
 * Where the PNGs are fetched from. **Pinned to the same commit as the snapshot.**
 *
 * They used to be taken from `main`, which put `flipbook_textures.json` (a fixed commit) and
 * the PNGs (main at that moment) in different generations. The frame count is determined by the
 * PNG's dimensions, so a generation gap produces "it is in the membership but the dimensions do
 * not agree".
 */
function rawBase() {
  const source = readSource();
  if (!source) {
    throw new Error(
      [
        'data/bedrock/SOURCE.json is missing, so the commit to fetch the PNGs from cannot be decided.',
        '  npm run fetch-bedrock-snapshot -- --update',
        'has to be run first.',
      ].join(String.fromCharCode(10)),
    );
  }
  return (rel) => rawUrl(source.commit, `resource_pack/textures/blocks/${rel}`);
}

const DB_PATH = () => join(process.cwd(), 'data/block-db.json');
const LEDGER_PATH = () => join(process.cwd(), 'src/data/texture-ledger.json');
const CATALOG_PATH = () => join(process.cwd(), 'src/data/blocks.json');
const MANIFEST_PATH = () => join(process.cwd(), 'src/data/textures.json');

/**
 * Reads the unified DB. **Fails when its generation differs from the snapshot** — the DB is
 * gitignored generated output, so arriving here after updating `SOURCE.json` without rebuilding
 * the DB would mean "projecting an old DB while believing a new upstream".
 */
function readBlockDb() {
  const path = DB_PATH();
  if (!existsSync(path)) {
    throw new Error(
      [
        'data/block-db.json is missing. The manifest is a projection of the unified DB, so the DB comes first.',
        '  npm run build:block-db',
        'builds it (start from npm run fetch-bedrock-snapshot if there is no snapshot).',
      ].join(String.fromCharCode(10)),
    );
  }
  const db = JSON.parse(readFileSync(path, 'utf-8'));
  const source = readSource();
  if (source && db.source?.commit && db.source.commit !== source.commit) {
    throw new Error(
      [
        `the unified DB is from a different generation than the snapshot (DB ${db.source.commit.slice(0, 8)} / SOURCE ${source.commit.slice(0, 8)}).`,
        '  npm run build:block-db',
        'rebuilds it.',
      ].join(String.fromCharCode(10)),
    );
  }
  return db;
}

/**
 * Textures not tied to a block (the ground of the 3D scene, and so on).
 *
 * **src/data/env-textures.json is the single source of truth.** Both the runtime
 * (render/scene.ts) and the fetch plan read the same file. Holding the strings twice here means
 * that rewriting only one of them fails no check at all (the runtime was looking at a path
 * that did not exist, and because the dev server returns index.html with a 200 it silently fell
 * back).
 *
 * They have no blockId, so they are not emitted into textures.json — they are only added to the
 * scope of --fetch.
 */
const ENV_TEXTURES = JSON.parse(readFileSync(join(process.cwd(), 'src/data/env-textures.json'), 'utf-8'));
const EXTRA_FILES = Object.values(ENV_TEXTURES);

/**
 * The list of files to fetch (no side effects). The contract test reads this.
 *
 * It references **the committed manifest**, not the unified DB. The fetch plan should be
 * determined by "the files the app actually reads", and going to the DB would make the plan
 * itself impossible to draw up in an environment without the snapshot (CI).
 */
export function uniqueFiles() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH(), 'utf-8'));
  const files = new Set(EXTRA_FILES);
  for (const entry of Object.values(manifest)) {
    files.add(entry.side);
    if (entry.top) files.add(entry.top);
  }
  return [...files];
}

/**
 * Guarantees that the ID sets of the catalogue (blocks.json) and the manifest agree.
 *
 * The diff check on the generated output (gen-textures:check) only looks at "is it the same as
 * what was committed", so updating the mapping and the output together would let a gap through.
 * Failing here, before anything is written, keeps a manifest with a gap from being committed at
 * all. (tests/textures-manifest.test.ts runs the same check against the committed output.)
 */
function assertCoversCatalog(manifest, catalogIds) {
  const known = new Set(catalogIds);
  const missing = catalogIds.filter((id) => !(id in manifest));
  const extra = Object.keys(manifest).filter((id) => !known.has(id));
  if (!missing.length && !extra.length) return;

  const lines = ['the ID sets of the catalogue and the manifest do not agree.'];
  if (missing.length) {
    lines.push(`  blocks absent from the manifest (${missing.length}): ${missing.join(', ')}`);
    lines.push('  → these could not be projected from the unified DB. Resolve the problems above first');
  }
  if (extra.length) {
    lines.push(`  manifest entries absent from the catalogue (${extra.length}): ${extra.join(', ')}`);
    lines.push('  → either add the block to src/data/blocks.json, or drop it from the manifest');
  }
  throw new Error(lines.join('\n'));
}

function writeManifest() {
  const db = readBlockDb();
  const ledger = JSON.parse(readFileSync(LEDGER_PATH(), 'utf-8'));
  const catalogIds = JSON.parse(readFileSync(CATALOG_PATH(), 'utf-8')).map((b) => b.id);

  const { manifest, problems, appearanceChanges } = buildTextureManifest({
    catalogIds,
    dbBlocks: db.blocks,
    ledger: ledger.entries,
  });

  // **Nothing is written if even one unruled ambiguity or lossy projection remains** (the
  // completion condition of stage 3). Silently taking the first candidate would bring back
  // the same "a decision nobody looked at" as the hand-written era
  if (problems.length > 0) {
    const lines = [`there are ${problems.length} places that cannot be projected from the unified DB.`];
    for (const p of problems) lines.push(`  ${p}`);
    lines.push('→ place a ruling with its reason in src/data/texture-ledger.json');
    throw new Error(lines.join(String.fromCharCode(10)));
  }
  assertCoversCatalog(manifest, catalogIds);

  writeFileSync(MANIFEST_PATH(), JSON.stringify(manifest, null, 2) + String.fromCharCode(10));
  console.log(`manifest: ${Object.keys(manifest).length} entries → ${MANIFEST_PATH()}`);
  console.log(`rulings (texture-ledger.json): ${Object.keys(ledger.entries).length}, of which ${appearanceChanges.length} change the appearance`);
  for (const c of appearanceChanges) console.log(`  ${c.id} → ${JSON.stringify(c.to)}`);
}

async function fetchTextures() {
  const files = uniqueFiles();
  const urlOf = rawBase();
  const commit = readSource().commit;
  const destDir = join(process.cwd(), 'public/textures/blocks');
  console.log(`fetching at commit: ${commit.slice(0, 8)} (the same generation as the snapshot)`);
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  // Look at which commit the local cache came from. **A different generation refetches
  // everything** — skipping merely because a file exists would leave old-generation PNGs behind
  // after SOURCE.json is updated, producing "new membership, old dimensions"
  const cached = readTextureSource();
  const sameGeneration = cached?.commit === commit;
  if (cached && !sameGeneration) {
    console.log(`the cache is from a different generation (${cached.commit.slice(0, 8)} → ${commit.slice(0, 8)}). Refetching everything`);
  }

  for (const rel of files) {
    const dest = join(destDir, rel);
    if (sameGeneration && existsSync(dest)) {
      skipped++;
      continue;
    }
    mkdirSync(join(dest, '..'), { recursive: true });
    const res = await fetch(urlOf(rel));
    if (!res.ok) {
      console.error(`  NG (${res.status}): ${rel}`);
      failed++;
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, buf);
    downloaded++;
  }
  console.log(`fetch: ${downloaded} downloaded / ${skipped} already present / ${failed} failed (${files.length} files in scope)`);

  // **The generation is not recorded if even one file could not be pulled.** Recording it would
  // make an incomplete cache count as "complete at this commit", and the later stage would claim
  // its real dimensions were verified
  if (failed > 0) {
    console.error(`${failed} could not be fetched, so the cache generation is not recorded`);
    process.exitCode = 1;
    return;
  }
  writeTextureSource({ commit, files: files.length });
  console.log(`recorded the generation in public/textures/.source.json (${commit.slice(0, 8)})`);
}

// Only write when run directly. The top-level side effects are closed off here so that the
// contract test can import uniqueFiles() (raised in review)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeManifest();
  if (process.argv.includes('--fetch')) {
    await fetchTextures();
  } else {
    console.log('to fetch the images, run npm run fetch-textures (or node scripts/gen-textures.mjs --fetch)');
  }
}
