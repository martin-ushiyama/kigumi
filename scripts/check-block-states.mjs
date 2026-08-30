/**
 * Cross-checks that the block states blocksmith writes out exist in Mojang's official block
 * definitions.
 *
 *   npm run check-block-states
 *
 * It mechanically checks **whether we emit a state the destination does not accept**. The
 * stair orientation was a
 * case of "the state was right but the meaning of the value was misread"; a wrong state *name*,
 * on the other hand, is simply ignored in silence and cannot be noticed until it is placed in
 * the real game.
 *
 * The upstream snapshot (`data/bedrock/mojang-blocks.json`) is not committed to the repository
 * because of the EULA. **When it is absent, this skips and exits successfully**, so it does
 * nothing in CI.
 *
 * The manual `regen-from-upstream` workflow runs this after regenerating the block catalogue,
 * while the updated snapshot is available. Local runs need `npm run fetch-bedrock-snapshot`
 * first; without the snapshot the command exits successfully after reporting that it skipped.
 *
 * The meaning of the values (whether 0 of weirdo_direction is east or north) cannot be known
 * here. The measured table in `docs/bedrock-format.md` holds that.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readSnapshot } from './bedrock-snapshot.mjs';
import { CATALOG } from '../src/data/blocks';
import { isPillarBlock } from '../src/core/types';

const SNAPSHOT = fileURLToPath(new URL('../data/bedrock/mojang-blocks.json', import.meta.url));

if (!existsSync(SNAPSHOT)) {
  console.log('skipped: no upstream snapshot (fetch one with npm run fetch-bedrock-snapshot)');
  process.exit(0);
}

/** The state names blocksmith writes out. Mirrors `core/orientation.ts::orientationToNbtStates` */
function statesWrittenFor(block) {
  switch (block.shape ?? 'full') {
    case 'stairs':
      return ['upside_down_bit', 'weirdo_direction'];
    case 'slab':
      return ['minecraft:vertical_half'];
    default:
      // full covers only the blocks that have pillar_axis. The default y emits no states, but
      // it has to be emittable when the axis is changed, so it is included in the scope here
      return isPillarBlock(block) ? ['pillar_axis'] : [];
  }
}

const upstream = JSON.parse(readSnapshot('mojang-blocks.json'));
const officialStates = new Map(
  upstream.data_items.map((item) => [item.name, (item.properties ?? []).map((p) => p.name)]),
);

const problems = [];
for (const block of CATALOG) {
  const official = officialStates.get(block.id);
  if (official === undefined) {
    problems.push(`${block.id}: not in the official block list`);
    continue;
  }
  for (const state of statesWrittenFor(block)) {
    if (!official.includes(state)) {
      problems.push(`${block.id}: writes "${state}", but the official definition only has [${official.join(', ')}]`);
    }
  }
}

if (problems.length) {
  console.error(`NG: ${problems.length}`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(`OK: ${CATALOG.length} catalogue entries, every state written out exists officially`);
