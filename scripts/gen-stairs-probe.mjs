/**
 * A real-device verification pack for finding out which compass direction each
 * weirdo_direction (0-3) actually points.
 *
 * It bypasses the normal pipeline in orientation.ts and calls buildMcpack directly, specifying
 * the states by hand. That is deliberate: this script is the instrument that **measures** the
 * mapping, so it must not read it back from the mapping it is measuring.
 *
 * The mapping it produced is settled and lives in `core/orientation.ts` (the
 * `weirdo_direction → the direction the high face points` table). This script stays for
 * re-measuring — when upstream changes, or when a result is in doubt.
 *
 *   npx vite-node scripts/gen-stairs-probe.mjs [name]
 *
 * The name is settable because **an identical name forces you to delete the old pack in
 * Minecraft before importing again**. Giving each rebuild a new name makes it importable and
 * testable right away. It defaults to stairs_probe.
 *
 * **The viewer is never asked to judge the direction.** Direction markers are embedded in the
 * structure, so answering "which colour is this stair's high face pointing at" is enough (no
 * F3, no reading the compass).
 *
 * Colour blocks are placed around each stair:
 *
 *            blue (-Z north)
 *   green (-X west)  stair  gold (+X east)
 *            red (+Z south)
 *
 * Stone is then stacked directly above each stair to show which one it is. 1 stone =
 * weirdo_direction 0, 2 = 1, 3 = 2, 4 = 3. That removes any worry about which end to count from.
 *
 * Usage:
 *   1. Double-click the emitted .mcpack to import it into Minecraft
 *   2. Move the behaviour pack to **active** in the world settings
 *   3. Place it with /structure load bs:stairs_probe ~ ~ ~
 *   4. For each of 1 / 2 / 3 / 4 stones, report **the colour that the stair's high face
 *      (the wall you face when climbing) points at**
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { nbt, writeNbt } from '../src/export/nbt';
import { buildMcpack } from '../src/export/mcpack';
import { BLOCK_VERSION } from '../src/export/mcstructure';

/**
 * The direction markers. Blocks are chosen for an unmistakable colour and an id that has been
 * stable for a long time (wool ids differ between versions).
 *
 * **These are different colours from `gen-stairs-verify.mjs`.** That script goes through the
 * normal export path and can only place blocks present in the catalogue, whereas this one
 * assembles the NBT by hand and can use blocks outside it. As markers, these read more clearly.
 */
const MARKERS = [
  { id: 'minecraft:lapis_block', label: 'blue', dir: 'north (-Z)', d: [0, 0, -1] },
  { id: 'minecraft:redstone_block', label: 'red', dir: 'south (+Z)', d: [0, 0, 1] },
  { id: 'minecraft:gold_block', label: 'gold', dir: 'east (+X)', d: [1, 0, 0] },
  { id: 'minecraft:emerald_block', label: 'green', dir: 'west (-X)', d: [-1, 0, 0] },
];

const CELL_STRIDE = 5; // the spacing between cells (wide enough that colour blocks do not touch the next cell)
const SIZE = [4 * CELL_STRIDE - 2, 6, 3];
const [sx, sy, sz] = SIZE;
const volume = sx * sy * sz;

/** The block_indices of an mcstructure is a 1-D array folded in x → y → z order */
const indexAt = (x, y, z) => x * sy * sz + y * sz + z;

const cells = new Array(volume).fill(-1);
const palette = [];
const paletteIndexOf = new Map();

/** The same block reuses its palette entry (one entry is enough when the states match) */
function put(x, y, z, name, states = {}) {
  const key = `${name}|${JSON.stringify(states)}`;
  let index = paletteIndexOf.get(key);
  if (index === undefined) {
    index = palette.length;
    paletteIndexOf.set(key, index);
    palette.push(
      nbt.compound({
        name: nbt.string(name),
        states: nbt.compound(states),
        version: nbt.int(BLOCK_VERSION),
      }),
    );
  }
  cells[indexAt(x, y, z)] = index;
}

for (let w = 0; w < 4; w++) {
  const cx = 1 + w * CELL_STRIDE;
  const cz = 1;

  put(cx, 0, cz, 'minecraft:oak_stairs', {
    upside_down_bit: nbt.byte(0),
    weirdo_direction: nbt.int(w),
  });

  for (const marker of MARKERS) {
    put(cx + marker.d[0], 0, cz + marker.d[2], marker.id);
  }

  // (w + 1) stones directly above, with one empty cell between them and the stair so the
  // stair's shape stays visible
  for (let i = 0; i <= w; i++) put(cx, 2 + i, cz, 'minecraft:stone');
}

const root = nbt.compound({
  format_version: nbt.int(1),
  size: nbt.list([nbt.int(sx), nbt.int(sy), nbt.int(sz)]),
  structure: nbt.compound({
    block_indices: nbt.list([nbt.intList(cells), nbt.intList(new Array(volume).fill(-1))]),
    entities: nbt.list([]),
    palette: nbt.compound({
      default: nbt.compound({
        block_palette: nbt.list(palette),
        block_position_data: nbt.compound({}),
      }),
    }),
  }),
  structure_world_origin: nbt.list([nbt.int(0), nbt.int(0), nbt.int(0)]),
});

const probeName = process.argv[2] ?? 'stairs_probe';
mkdirSync('.shots', { recursive: true });
writeFileSync(`.shots/${probeName}.mcpack`, buildMcpack(probeName, writeNbt(root)));

console.log(`OK: .shots/${probeName}.mcpack`);
console.log('');
console.log(`place it with /structure load bs:${probeName} ~ ~ ~`);
console.log('');
console.log('direction markers:');
for (const m of MARKERS) console.log(`  ${m.label} = ${m.dir}`);
console.log('');
console.log('the number of stones above a stair = weirdo_direction + 1:');
for (let w = 0; w < 4; w++) console.log(`  ${w + 1} stone(s) → weirdo_direction=${w}`);
console.log('');
console.log("report the colour each stair's high face points at");
