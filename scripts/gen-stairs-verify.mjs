/**
 * A pack for **checking the answer** — whether stair orientation matches the real game.
 *
 *   npx vite-node scripts/gen-stairs-verify.mjs [name] [--upside]
 *
 * `--upside` lays out **vertically flipped stairs** (upside_down_bit). It exists to confirm
 * whether flipping also appears to move the step horizontally — the flipped side can be off
 * even when the normal orientation is right (still unconfirmed).
 *
 * Where `gen-stairs-probe.mjs` measures "which compass direction weirdo_direction actually
 * is" by assembling the NBT by hand, this one goes through **the same export path as the app**
 * (`VoxelWorld` → `buildMcstructure` → `buildMcpack`) to confirm that the settled mapping in
 * `core/orientation.ts` meshes with the real game.
 *
 * **Do not assemble the NBT by hand.** Doing so slips past the inside of `buildMcstructure`
 * (the catalogue cross-check, the merging of states, building the palette) and hides "the
 * verification passes but the actual export is off". That was raised in review.
 *
 * Direction markers are placed around each stair:
 *
 *              black (north)   ← obsidian
 *   white (west)   stair   yellow (east)
 *   ↑snow                  ↑stripped bamboo block
 *              red (south)     ← chiseled red sandstone
 *
 * The markers are chosen **from blocks present in the catalogue** (see MARKERS below).
 *
 * The number of stones directly above a stair is weirdo_direction + 1. What to expect:
 *   1 stone → the high face points yellow (east) / 2 → white (west) / 3 → red (south) / 4 → black (north)
 *
 * If even one differs, the mapping is still off.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildIndexOf } from '../src/core/mixpalette';
import { encodeOrientation, packCell } from '../src/core/orientation';
import { VoxelWorld } from '../src/core/voxels';
import { CATALOG } from '../src/data/blocks';
import { buildMcpack } from '../src/export/mcpack';
import { buildMcstructure } from '../src/export/mcstructure';

const indexOf = buildIndexOf(CATALOG);

/** Fail immediately when a block is not in the catalogue (never silently fall back to another block and make the verification meaningless) */
function need(blockId) {
  const index = indexOf(blockId);
  if (index === undefined) throw new Error(`not in the catalogue: ${blockId}`);
  return index;
}

/**
 * The direction markers. **Chosen from blocks in the catalogue** — the normal export path goes
 * through the catalogue cross-check, so unincluded blocks such as lapis or gold cannot be used
 * (assembling the NBT by hand lets them through, which kept this constraint out of sight).
 * These are the four most widely separated colours among the included blocks.
 */
const MARKERS = [
  { id: 'minecraft:obsidian', label: 'black', dir: 'north', d: [0, -1] },
  { id: 'minecraft:chiseled_red_sandstone', label: 'red', dir: 'south', d: [0, 1] },
  { id: 'minecraft:stripped_bamboo_block', label: 'yellow', dir: 'east', d: [1, 0] },
  { id: 'minecraft:snow', label: 'white', dir: 'west', d: [-1, 0] },
];
const EXPECTED = ['yellow (east)', 'white (west)', 'red (south)', 'black (north)'];

const UPSIDE_DOWN = process.argv.includes('--upside');

const STAIRS_ID = 'minecraft:oak_stairs';
const STONE_ID = 'minecraft:stone';
const CELL_STRIDE = 5;

const cells = [];
for (let w = 0; w < 4; w++) {
  const cx = w * CELL_STRIDE;

  // The stairs are built with packCell + encodeOrientation, **exactly as the normal path does**.
  // The conversion into states happens inside buildMcstructure
  cells.push([
    cx,
    0,
    0,
    packCell(need(STAIRS_ID), encodeOrientation({ shape: 'stairs', weirdoDirection: w, upsideDown: UPSIDE_DOWN })),
  ]);

  for (const m of MARKERS) cells.push([cx + m.d[0], 0, m.d[1], packCell(need(m.id), 0)]);

  // (w + 1) stones directly above, with one empty cell between them and the stair so its shape stays visible
  for (let i = 0; i <= w; i++) cells.push([cx, 2 + i, 0, packCell(need(STONE_ID), 0)]);
}

const world = new VoxelWorld();
world.replaceAll(cells);

const result = buildMcstructure(world, CATALOG);
const name = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'stairs_verify';
mkdirSync('.shots', { recursive: true });
writeFileSync(`.shots/${name}.mcpack`, buildMcpack(name, result.bytes));

console.log(`OK: .shots/${name}.mcpack (${result.size.join('x')}, ${result.blockCount} blocks)`);
console.log(UPSIDE_DOWN ? 'the stairs are **vertically flipped** (upside_down_bit = true)' : 'the stairs are in the normal orientation');
console.log(`/structure load bs:${name} ~ ~ ~`);
console.log('');
console.log('what to expect (anything else means the mapping is still off):');
for (let w = 0; w < 4; w++) console.log(`  ${w + 1} stone(s) → the high face points ${EXPECTED[w]}`);
