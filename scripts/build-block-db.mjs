/**
 * Builds the unified DB (`data/block-db.json`) from the upstream snapshot.
 *
 * No network is needed. It reads only the snapshot already fetched into `data/bedrock/`, and
 * `SOURCE.json` holds which commit it assumes.
 *
 * **Nobody uses it yet at this point.** Switching texture generation over to the DB is stage 3.
 * The DB is built first so its contents can be inspected, and only then is the consumer side
 * swapped over.
 *
 * The output is **not committed** (gitignored), matching the decision not to redistribute the
 * upstream files (the head of bedrock-snapshot.mjs) — the DB binds the upstream facts almost
 * as-is, which amounts to redistributing the material. What is committed is `src/data/*.json`,
 * the projection of the included blocks alone.
 *
 * Usage:
 *   npm run build:block-db              # build data/block-db.json
 *   npm run build:block-db -- --check   # print whether it assembles, and the summary, without writing
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readSnapshot, readSource } from './bedrock-snapshot.mjs';
import { parseJsonc } from './bedrock-parse.mjs';
import { buildBlockDb, formatBlockDb, summarizeBlockDb, textureReachability } from './block-db.mjs';

const OUT_PATH = fileURLToPath(new URL('../data/block-db.json', import.meta.url));
const CATALOG_PATH = fileURLToPath(new URL('../src/data/blocks.json', import.meta.url));
const checkOnly = process.argv.includes('--check');

const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf-8'));

const db = buildBlockDb({
  mojangBlocks: parseJsonc(readSnapshot('mojang-blocks.json'), 'mojang-blocks.json'),
  resourcePackBlocks: parseJsonc(readSnapshot('resource-pack-blocks.json'), 'resource-pack-blocks.json'),
  terrainTexture: parseJsonc(readSnapshot('terrain_texture.json'), 'terrain_texture.json'),
  langText: readSnapshot('en_US.lang'),
  source: readSource(),
});

const summary = summarizeBlockDb(db);
console.log(`${summary.blocks} blocks (${summary.withTextureRefs} with texture refs / ${summary.withNameEn} with an English name / ${summary.withStates} with states)`);
console.log(`${summary.distinctTextureNames} distinct texture names / ${summary.fullyReachable} reach a real file on all six faces`);
console.log(`kept ${summary.orphanTextureEntries} texture entries absent from data_items (old aggregate names), contents included`);
console.log('diagnostics:');
const kinds = Object.keys(summary.diagnostics).sort();
if (kinds.length === 0) console.log('  none');
for (const kind of kinds) console.log(`  ${kind}: ${summary.diagnostics[kind]}`);

/**
 * Confirms that the included catalogue reaches real files through the DB.
 *
 * This is the very premise on which stage 3 (switching texture generation over to the DB)
 * stands, so a break stops the run. `src/data/blocks.json` is committed, so with the snapshot
 * in place it can be confirmed in any environment. **The app does not read the DB at this
 * point** — this is verification only.
 */
const unreachable = [];
const dbById = new Map(db.blocks.map((b) => [b.id, b]));
for (const entry of catalog) {
  const record = dbById.get(entry.id);
  if (!record) {
    unreachable.push(`${entry.id} (no record in the DB)`);
    continue;
  }
  // textureReachability owns the decision. Writing a way of counting here would let through
  // cases where only some faces are missing, or candidates from which no path can be taken
  //
  const reach = textureReachability(record);
  if (!reach.ok) unreachable.push(`${entry.id}: ${reach.problems.join(' / ')}`);
}
console.log(`${catalog.length - unreachable.length} of the ${catalog.length} catalogue entries are reachable`);
if (unreachable.length > 0) {
  console.error('some blocks are not reachable:');
  for (const line of unreachable) console.error(`  ${line}`);
  process.exitCode = 1;
} else if (checkOnly) {
  console.log('--check was given, so nothing was written');
}

if (!checkOnly && unreachable.length === 0) {
  writeFileSync(OUT_PATH, formatBlockDb(db));
  console.log('wrote data/block-db.json');
}
