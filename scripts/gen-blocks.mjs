/**
 * The block catalogue generation script.
 * It cross-checks every ID against mojang-blocks.json from the official Mojang bedrock-samples
 * before writing src/data/blocks.json (no guessed naming).
 *
 * **Which blocks are included and their categories live in `src/data/curation.json`**
 *. The source of truth for Japanese names is the official ja_JP.lang, and
 * curation only fills the gaps it cannot supply. Representative colours do not belong to the
 * catalogue (texture-colors.json is the source of truth).
 * This file used to hold a 100-line hand-written list, but that was not a fact from Mojang — it
 * was our decision, mixed in with the rules for reading upstream. The decisions moved out into
 * data, and only **how upstream is read** stays here.
 *
 * Upstream is read from **a snapshot at a fixed commit** (data/bedrock/, fetched with
 * npm run fetch-bedrock-snapshot). It used to fetch main on every run, so the generated output
 * changed with when it was run and nothing recorded which point in time of Bedrock the
 * catalogue assumed.
 *
 *   node scripts/gen-blocks.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseLangEntries } from './bedrock-parse.mjs';
import { readSnapshot } from './bedrock-snapshot.mjs';
import { MATERIALS_WITH_VARIANTS } from './materials-with-variants.mjs';
import { findMissingVariants, formatMissingVariant } from './variant-coverage.mjs';
import { curatedBlocks } from './curation.mjs';
import { buildCatalog } from './catalog.mjs';
import { foldPoseSpacesByShape, poseStatesOf } from './pose-space.mjs';

// Resolved relative to this script (scripts/). It depends on neither the cwd at run time nor an
// absolute path specific to one developer's machine (so it works in any checkout or environment)
const OUTPUT_PATH = fileURLToPath(new URL('../src/data/blocks.json', import.meta.url));
const CURATION_PATH = fileURLToPath(new URL('../src/data/curation.json', import.meta.url));
const POSE_SPACES_PATH = fileURLToPath(new URL('../src/data/pose-spaces.json', import.meta.url));

/**
 * The exceptions when assembling an English name from an id. Held by hand only for the ones
 * where en_US.lang has no `tile.<id>.name` and machine generation disagrees with the official
 * spelling (1 case as measured on 2026-07-27).
 */
const NAME_EN_OVERRIDES = {
  smooth_quartz: 'Smooth Quartz',
  // The stone slab. Its lang key does not line up with its id
  // (tile.stone_slab.name / tile.double_stone_slab.stone.name), and title-casing produces
  // "Normal Stone Slab", a spelling that does not exist officially
  normal_stone_slab: 'Stone Slab',
};

const mojang = JSON.parse(readSnapshot('mojang-blocks.json'));
const officialNames = new Map(mojang.data_items.map((i) => [i.name.replace('minecraft:', ''), i]));

// The primary source of display names. Unlike IDs, the **display names** exist only here.
// Mojang ships the Japanese ones too
const langText = readSnapshot('en_US.lang');
const langTextJa = readSnapshot('ja_JP.lang');

/**
 * `langExact` = a direct lookup of `tile.<id>.name` (older blocks are stored in the
 * `tile.<parent>.<variant>.name` form and cannot be looked up) / `langValues` = the set of
 * strings that actually exist as display names.
 *
 * bedrock-parse.mjs owns the read rules. The block-db side needs the same rules,
 * so they are **not written in two places** — hand-writing the same fact in several places is
 * the structure the unified DB removes.
 */
const { exact: langExact, values: langValues } = parseLangEntries(langText);
const { exact: langExactJa } = parseLangEntries(langTextJa);

/**
 * Decides the Japanese display name. **It never guesses** — unlike the English side there is no
 * assembly rule such as title-casing, and existence cannot be confirmed, so it is null when
 * `tile.<id>.name` cannot be looked up. The gaps (older blocks in the
 * `tile.<parent>.<variant>.name` form) are filled by curation.json.
 */
const resolveNameJa = (id) => langExactJa.get(id) ?? null;

const titleCase = (id) => id.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/**
 * Decides the English name. The policy of **no guessed naming** (the head of this script)
 * applies to the English side too:
 *
 * 1. use `tile.<id>.name` when it exists (the official spelling itself)
 * 2. otherwise assemble it from the id and confirm that **the resulting string exists somewhere
 *    in lang as a display name** (which at least guarantees it is a spelling Mojang uses)
 * 3. if neither passes, look at NAME_EN_OVERRIDES
 * 4. if that is empty too, **abort**. A guessed name is never baked in silently
 *
 * Step 2 is needed because older blocks are stored in a parent.variant form such as
 * `tile.stone.granite.name` and cannot be looked up from an id. A plain title-case disagreed
 * with the official spelling in 11 of 139 cases, and for `stone_stairs` the official name is
 * "Cobblestone Stairs" (i.e. it would take on another block's name).
 */
function resolveNameEn(id) {
  const exact = langExact.get(id);
  if (exact) return exact;
  const guess = titleCase(id);
  if (langValues.has(guess)) return guess;
  return NAME_EN_OVERRIDES[id] ?? null;
}

function hasPillarAxis(id) {
  const item = officialNames.get(id);
  return !!item && (item.properties ?? []).some((p) => p.name === 'pillar_axis');
}

const curation = JSON.parse(readFileSync(CURATION_PATH, 'utf-8'));
const { blocks: curated, excludedIds, problems: curationProblems } = curatedBlocks(curation);
if (curationProblems.length) {
  console.error('there are problems with curation.json:');
  for (const p of curationProblems) console.error(`  ${p}`);
  process.exit(1);
}

// The pure functions in catalog.mjs own the assembly rules (the upstream files are gitignored
// and CI has no real copy, so writing them directly here would make the rules themselves
// untestable). This only injects how upstream is read
const { blocks: out, errors, skippedVariantsOf } = buildCatalog({
  curated,
  excludedIds,
  materials: MATERIALS_WITH_VARIANTS,
  isOfficial: (id) => officialNames.has(id),
  resolveNameEn,
  resolveNameJa,
  hasPillarAxis,
});

if (errors.length) {
  console.error('IDs absent from the official list / unknown materialGroup:', errors);
  process.exit(1);
}

/**
 * The pose space. Built from the block states and value ranges upstream declares,
 * then folded per shape.
 *
 * **An unknown state stops the run.** Silently dropping a state that has been decided neither
 * to be used as a pose nor to be ignored makes that orientation disappear quietly from the
 * export (states that are not poses really do exist, such as `deprecated` on bone_block).
 * Decide first, then pass.
 */
const stateDomains = new Map((mojang.block_properties ?? []).map((p) => [p.name, p.values.map((v) => v.value)]));
const poseInputs = [];
const unknownStates = [];
for (const block of out) {
  const bare = block.id.replace('minecraft:', '');
  const { pose, unknownStates: unknown } = poseStatesOf(officialNames.get(bare), stateDomains);
  if (unknown.length) unknownStates.push(`${bare}: ${unknown.join(', ')}`);
  poseInputs.push({ id: bare, shape: block.shape, pose });
}
if (unknownStates.length) {
  console.error('there are block states with no decision on whether they are poses (decide in pose-space.mjs):');
  for (const line of unknownStates) console.error(`  ${line}`);
  process.exit(1);
}
const { spaces: poseSpaces, conflicts } = foldPoseSpacesByShape(poseInputs);
if (conflicts.length) {
  console.error('blocks of the same shape have different pose spaces (the shape classification is not fine enough):');
  for (const line of conflicts) console.error(`  ${line}`);
  process.exit(1);
}
writeFileSync(POSE_SPACES_PATH, JSON.stringify(poseSpaces, null, 2) + String.fromCharCode(10));

// A deliberately excluded material takes its derived blocks with it. **They are not dropped
// silently; the count is printed** — what disappeared when included was set to false has to be
// visible to the person who set it, or they cannot confirm it
if (skippedVariantsOf.length) {
  console.log(`skipped the derived blocks of materials excluded in curation (${skippedVariantsOf.length}): ${skippedVariantsOf.join(', ')}`);
}

/**
 * **The inclusion-gap report** — finds derived blocks that exist officially but are not in the
 * catalogue.
 *
 * The pure functions in `variant-coverage.mjs` own the decision itself (this generation
 * requires the network and is run by hand, so writing the detection logic directly here would
 * mean **a break goes unnoticed in ordinary CI**). This only wires the input and output up and
 * prints them.
 *
 * **It is not an error.** Generation failing every time Mojang adds a new block would not be
 * workable, and whether to include one needs a human decision about its Japanese name and
 * representative colour. The point is to keep the state where nobody notices from existing.
 */
const missingVariants = findMissingVariants({
  fullIds: out.filter((e) => e.shape === 'full').map((e) => e.id.replace('minecraft:', '')),
  catalogIds: new Set(out.map((e) => e.id.replace('minecraft:', ''))),
  officialIds: new Set(officialNames.keys()),
});
if (missingVariants.length) {
  console.warn(`possible inclusion gaps (${missingVariants.length}) — derived blocks that exist officially but are not included:`);
  for (const entry of missingVariants) console.warn(`  ${formatMissingVariant(entry)}`);
  console.warn('  → to add one, append a line to scripts/materials-with-variants.mjs');
}

writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2) + '\n');

const byShape = (s) => out.filter((e) => e.shape === s).length;
console.log(
  `OK: ${out.length} types (full ${byShape('full')} / slab ${byShape('slab')} / stairs ${byShape('stairs')})`,
);
