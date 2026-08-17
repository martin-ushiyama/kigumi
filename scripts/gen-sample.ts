/**
 * Generates a sample .mcpack for checking that things work (run with vite-node).
 *   npx vite-node scripts/gen-sample.ts
 * Output: .shots/sample_road.mcpack (not under git)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildIndexOf, sampleRecipe, type MixRecipe } from '../src/core/mixpalette';
import { packCell } from '../src/core/orientation';
import { VoxelWorld } from '../src/core/voxels';
import { CATALOG } from '../src/data/blocks';
import { buildMcpack } from '../src/export/mcpack';
import { buildMcstructure } from '../src/export/mcstructure';

const indexOf = buildIndexOf(CATALOG);
const recipe: MixRecipe = {
  id: 'sample',
  // i18n-allow: the recipe name shown in the sample pack
  name: '石畳ミックス',
  entries: [
    { blockId: 'minecraft:stone_bricks', weight: 4 },
    { blockId: 'minecraft:cobblestone', weight: 3 },
    { blockId: 'minecraft:andesite', weight: 2 },
    { blockId: 'minecraft:mossy_cobblestone', weight: 1 },
  ],
};

const world = new VoxelWorld();
const cells: [number, number, number, number][] = [];
// A 16x5 mixed cobblestone road, edged with logs on both sides
for (let x = 0; x < 16; x++) {
  for (let z = 0; z < 5; z++) {
    cells.push([x, 0, z, packCell(sampleRecipe(recipe, indexOf)!, 0)]);
  }
  cells.push([x, 0, -1, packCell(indexOf('minecraft:oak_log')!, 0)]);
  cells.push([x, 0, 5, packCell(indexOf('minecraft:oak_log')!, 0)]);
}
world.replaceAll(cells);

const result = buildMcstructure(world, CATALOG);
const pack = buildMcpack('sample_road', result.bytes);
mkdirSync('.shots', { recursive: true });
writeFileSync('.shots/sample_road.mcpack', pack);
writeFileSync('.shots/sample_road.mcstructure', result.bytes);
console.log('OK', {
  size: result.size,
  blocks: result.blockCount,
  palette: result.paletteCount,
  mcpackBytes: pack.length,
  mcstructureBytes: result.bytes.length,
});
console.log('import: double-click the .mcpack → apply the behaviour pack in the world settings → /structure load bs:sample_road');
