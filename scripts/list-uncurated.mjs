/**
 * Lists the blocks that are not yet included (#97 stage 5). **Read only; it rewrites nothing.**
 *
 * A tool for deciding what could be added next. It takes every block of the unified DB
 * (stage 2), subtracts the ones already decided in curation (stage 4), and lays the difference
 * out grouped into **series**, the unit in which inclusion happens.
 *
 * It makes no call — a classification such as "can be added right away" cannot be read from
 * upstream, so a machine guessing at it would point the opposite way from building the DB
 * (whose purpose is to remove guessing). See uncurated.mjs for the details.
 *
 *   node scripts/list-uncurated.mjs              # series only (default)
 *   node scripts/list-uncurated.mjs --singles    # also list the singles
 *   node scripts/list-uncurated.mjs --min 8      # only series with at least N members
 *   node scripts/list-uncurated.mjs --json       # machine-readable
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listUncurated } from './uncurated.mjs';

const DB_PATH = fileURLToPath(new URL('../data/block-db.json', import.meta.url));
const CURATION_PATH = fileURLToPath(new URL('../src/data/curation.json', import.meta.url));
const CATALOG_PATH = fileURLToPath(new URL('../src/data/blocks.json', import.meta.url));

const args = process.argv.slice(2);
const showSingles = args.includes('--singles');
const asJson = args.includes('--json');
const minIndex = args.indexOf('--min');
const minSize = minIndex === -1 ? 2 : Number(args[minIndex + 1]);

if (!Number.isFinite(minSize) || minSize < 2) {
  console.error('--min takes a number of 2 or more');
  process.exit(1);
}

if (!existsSync(DB_PATH)) {
  // It is generated output (gitignored), so it is absent right after a checkout.
  // Print how to build it and stop
  console.error(`the unified DB is missing: ${DB_PATH}`);
  console.error('build it with npm run build:block-db');
  process.exit(1);
}

const db = JSON.parse(readFileSync(DB_PATH, 'utf8'));
const curation = JSON.parse(readFileSync(CURATION_PATH, 'utf8'));
const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

/**
 * The ids already decided. **Both curation and the generated catalogue** are subtracted.
 *
 * curation holds only the 136 materials; slabs and stairs are derived from
 * `materials-with-variants` into 237 entries. Subtracting curation alone lists **37 stairs
 * that are already included as "not included"** (found by measurement). What counts as a
 * candidate is determined on the generated-output side.
 */
const decidedIds = new Set([
  ...Object.keys(curation.entries ?? {}),
  ...catalog.map((block) => block.id),
]);

const { series, singles, total } = listUncurated(db, decidedIds);
const shown = series.filter((entry) => entry.blocks.length >= minSize);

if (asJson) {
  console.log(JSON.stringify({ total, series: shown, singles: showSingles ? singles : undefined }, null, 2));
  process.exit(0);
}

/** Folds one material into a line. Only those whose texture cannot be looked up are marked (which does not mean they cannot be added) */
const line = (block) => {
  const name = block.nameEn ?? '(no English name)';
  const states = block.stateNames.length ? ` [${block.stateNames.join(', ')}]` : '';
  const texture = block.hasTexture ? '' : ' (texture unresolved)';
  return `    ${block.bareId.padEnd(34)} ${name}${states}${texture}`;
};

console.log(`${total} of the ${db.blocks.length} blocks in the unified DB are not included`);
console.log(`${decidedIds.size} are already decided (${Object.keys(curation.entries ?? {}).length} curation entries + ${catalog.length} in the generated catalogue, included: false among them)`);
console.log();
console.log(`${shown.length} series (groups of at least ${minSize})`);
console.log();

for (const entry of shown) {
  console.log(`  ${entry.suffix} — ${entry.blocks.length}`);
  for (const block of entry.blocks) console.log(line(block));
  console.log();
}

if (showSingles) {
  console.log(`${singles.length} singles`);
  console.log();
  for (const block of singles) console.log(line(block));
} else {
  console.log(`${singles.length} singles omitted (pass --singles to list them)`);
}
