/**
 * The table of slabs and stairs verified to exist (2026-07-19).
 * Every row was checked one by one against the official block list of bedrock-samples
 * (mojang-blocks.json) — none of it is guessed from a naming convention.
 *
 * materialGroup is not spelled out; baseId is used directly as the palette grouping key
 * (gen-blocks.mjs assumes each row's baseId matches the id of the corresponding existing
 * catalogue entry).
 *
 * 48 materials: 42 with both / 4 slab-only (smooth_stone, cobblestone, cut_sandstone,
 * cut_red_sandstone) / 2 stairs-only (stone, end_bricks).
 */
export const MATERIALS_WITH_VARIANTS = [
  // Note: "stone_stairs" is a leftover of historical naming and its actual texture is
  // cobblestone (the earliest implementation from when stair blocks were introduced is still
  // in place; confirmed as textures:"cobblestone" in the legacy resource_pack/blocks.json).
  // The stairs that actually look like stone have their own ID, "normal_stone_stairs".
  { baseId: 'stone', slabId: 'normal_stone_slab', stairsId: 'normal_stone_stairs' },
  { baseId: 'smooth_stone', slabId: 'smooth_stone_slab' },
  { baseId: 'cobblestone', slabId: 'cobblestone_slab', stairsId: 'stone_stairs' },
  { baseId: 'mossy_cobblestone', slabId: 'mossy_cobblestone_slab', stairsId: 'mossy_cobblestone_stairs' },
  { baseId: 'stone_bricks', slabId: 'stone_brick_slab', stairsId: 'stone_brick_stairs' },
  { baseId: 'mossy_stone_bricks', slabId: 'mossy_stone_brick_slab', stairsId: 'mossy_stone_brick_stairs' },
  { baseId: 'granite', slabId: 'granite_slab', stairsId: 'granite_stairs' },
  { baseId: 'polished_granite', slabId: 'polished_granite_slab', stairsId: 'polished_granite_stairs' },
  { baseId: 'diorite', slabId: 'diorite_slab', stairsId: 'diorite_stairs' },
  { baseId: 'polished_diorite', slabId: 'polished_diorite_slab', stairsId: 'polished_diorite_stairs' },
  { baseId: 'andesite', slabId: 'andesite_slab', stairsId: 'andesite_stairs' },
  { baseId: 'polished_andesite', slabId: 'polished_andesite_slab', stairsId: 'polished_andesite_stairs' },
  { baseId: 'cobbled_deepslate', slabId: 'cobbled_deepslate_slab', stairsId: 'cobbled_deepslate_stairs' },
  { baseId: 'polished_deepslate', slabId: 'polished_deepslate_slab', stairsId: 'polished_deepslate_stairs' },
  { baseId: 'deepslate_bricks', slabId: 'deepslate_brick_slab', stairsId: 'deepslate_brick_stairs' },
  { baseId: 'tuff', slabId: 'tuff_slab', stairsId: 'tuff_stairs' },
  { baseId: 'polished_tuff', slabId: 'polished_tuff_slab', stairsId: 'polished_tuff_stairs' },
  { baseId: 'tuff_bricks', slabId: 'tuff_brick_slab', stairsId: 'tuff_brick_stairs' },
  { baseId: 'blackstone', slabId: 'blackstone_slab', stairsId: 'blackstone_stairs' },
  { baseId: 'polished_blackstone', slabId: 'polished_blackstone_slab', stairsId: 'polished_blackstone_stairs' },
  {
    baseId: 'polished_blackstone_bricks',
    slabId: 'polished_blackstone_brick_slab',
    stairsId: 'polished_blackstone_brick_stairs',
  },
  { baseId: 'mud_bricks', slabId: 'mud_brick_slab', stairsId: 'mud_brick_stairs' },
  { baseId: 'sandstone', slabId: 'sandstone_slab', stairsId: 'sandstone_stairs' },
  { baseId: 'cut_sandstone', slabId: 'cut_sandstone_slab' },
  { baseId: 'smooth_sandstone', slabId: 'smooth_sandstone_slab', stairsId: 'smooth_sandstone_stairs' },
  { baseId: 'red_sandstone', slabId: 'red_sandstone_slab', stairsId: 'red_sandstone_stairs' },
  { baseId: 'cut_red_sandstone', slabId: 'cut_red_sandstone_slab' },
  { baseId: 'smooth_red_sandstone', slabId: 'smooth_red_sandstone_slab', stairsId: 'smooth_red_sandstone_stairs' },
  { baseId: 'smooth_quartz', slabId: 'smooth_quartz_slab', stairsId: 'smooth_quartz_stairs' },
  { baseId: 'prismarine', slabId: 'prismarine_slab', stairsId: 'prismarine_stairs' },
  { baseId: 'prismarine_bricks', slabId: 'prismarine_brick_slab', stairsId: 'prismarine_bricks_stairs' },
  { baseId: 'dark_prismarine', slabId: 'dark_prismarine_slab', stairsId: 'dark_prismarine_stairs' },
  { baseId: 'end_bricks', slabId: 'end_stone_brick_slab', stairsId: 'end_brick_stairs' },
  { baseId: 'nether_brick', slabId: 'nether_brick_slab', stairsId: 'nether_brick_stairs' },
  { baseId: 'red_nether_brick', slabId: 'red_nether_brick_slab', stairsId: 'red_nether_brick_stairs' },
  { baseId: 'oak_planks', slabId: 'oak_slab', stairsId: 'oak_stairs' },
  { baseId: 'spruce_planks', slabId: 'spruce_slab', stairsId: 'spruce_stairs' },
  { baseId: 'birch_planks', slabId: 'birch_slab', stairsId: 'birch_stairs' },
  { baseId: 'jungle_planks', slabId: 'jungle_slab', stairsId: 'jungle_stairs' },
  { baseId: 'acacia_planks', slabId: 'acacia_slab', stairsId: 'acacia_stairs' },
  { baseId: 'dark_oak_planks', slabId: 'dark_oak_slab', stairsId: 'dark_oak_stairs' },
  { baseId: 'mangrove_planks', slabId: 'mangrove_slab', stairsId: 'mangrove_stairs' },
  { baseId: 'cherry_planks', slabId: 'cherry_slab', stairsId: 'cherry_stairs' },
  { baseId: 'pale_oak_planks', slabId: 'pale_oak_slab', stairsId: 'pale_oak_stairs' },
  { baseId: 'crimson_planks', slabId: 'crimson_slab', stairsId: 'crimson_stairs' },
  { baseId: 'warped_planks', slabId: 'warped_slab', stairsId: 'warped_stairs' },
  { baseId: 'bamboo_planks', slabId: 'bamboo_slab', stairsId: 'bamboo_stairs' },
  { baseId: 'bamboo_mosaic', slabId: 'bamboo_mosaic_slab', stairsId: 'bamboo_mosaic_stairs' },
  // Materials whose base is in the catalogue but whose derived blocks were missing entirely
  // (found by the inclusion-gap report). The IDs were verified against mojang-blocks.json —
  // their naming drifts from the base, so machine guessing cannot reach them
  // (deepslate_tiles → deepslate_tile_*, brick_block → brick_*)
  { baseId: 'deepslate_tiles', slabId: 'deepslate_tile_slab', stairsId: 'deepslate_tile_stairs' },
  { baseId: 'brick_block', slabId: 'brick_slab', stairsId: 'brick_stairs' },
  { baseId: 'quartz_block', slabId: 'quartz_slab', stairsId: 'quartz_stairs' },
  { baseId: 'purpur_block', slabId: 'purpur_slab', stairsId: 'purpur_stairs' },
];
