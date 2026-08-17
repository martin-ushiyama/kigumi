import { describe, expect, it } from 'vitest';
import { encodeOrientation, packCell, type Orientation, type Shape } from '../src/core/orientation';
import { stateCountOf } from '../src/core/orientation-codec';
import { CATALOG } from '../src/data/blocks';
import { VoxelWorld } from '../src/core/voxels';
import { buildMcstructure } from '../src/export/mcstructure';
import { exportSignatureAt } from './helpers/export-signature';

/**
 * **Cross-checking the measured ledger against the exported byte stream** (#131 PR 3).
 *
 * Where PR 2 (`render-signature.test.ts`) looks at "what appears on screen", this one looks
 * at "what gets written into the `.mcstructure`". **The two share nothing** — different
 * observation helper, different way of writing expectations; the only shared anchor is the ledger.
 *
 * If they shared code, both sides would just be looking at the same table, and it would become
 * impossible to detect the actual subject of #131, **a mismatch between screen and export**
 * (the same shape as the #114 lesson).
 *
 * ## Where the expected values come from
 *
 * Block state values are the upstream declaration itself (`pillar_axis` = `y`/`x`/`z`, etc).
 * Only the correspondence between `weirdo_direction`'s numbers and compass directions can't be
 * read from the name, so the real-device measurement is the source of truth
 * (0=east / 1=west / 2=south / 3=north, 2026-08-01 Bedrock 1.21).
 *
 * **Booleans are written as a byte**, so reading them back gives `0` / `1` (per the NBT spec).
 */

/** The actual block used per pose. The export side doesn't use appearance, so pick a straightforward representative */
const BLOCKS: Record<Shape, string> = {
  full: 'minecraft:oak_log',
  slab: 'minecraft:smooth_stone_slab',
  stairs: 'minecraft:sandstone_stairs',
};

interface LedgerEntry {
  label: string;
  orientation: Orientation;
  /** The block state that should be written to the palette */
  states: Record<string, string | number>;
}

const LEDGER: LedgerEntry[] = [
  // Pillar axis. **The default (y) comes out as a fixed state held by the catalog side**
  { label: 'full · axis y', orientation: { shape: 'full', axis: 'y' }, states: { pillar_axis: 'y' } },
  { label: 'full · axis x', orientation: { shape: 'full', axis: 'x' }, states: { pillar_axis: 'x' } },
  { label: 'full · axis z', orientation: { shape: 'full', axis: 'z' }, states: { pillar_axis: 'z' } },
  {
    label: 'slab · bottom',
    orientation: { shape: 'slab', half: 'bottom' },
    states: { 'minecraft:vertical_half': 'bottom' },
  },
  {
    label: 'slab · top',
    orientation: { shape: 'slab', half: 'top' },
    states: { 'minecraft:vertical_half': 'top' },
  },
  // stairs: 4 directions × upside-down. Booleans are a byte, so 0 / 1
  ...([0, 1, 2, 3] as const).flatMap((weirdoDirection) =>
    [false, true].map((upsideDown) => ({
      label: `stairs · d=${weirdoDirection}${upsideDown ? ' upside-down' : ''}`,
      orientation: { shape: 'stairs' as const, weirdoDirection, upsideDown },
      states: { weirdo_direction: weirdoDirection, upside_down_bit: upsideDown ? 1 : 0 },
    })),
  ),
];

const indexOf = (id: string) => {
  const i = CATALOG.findIndex((b) => b.id === id);
  if (i < 0) throw new Error(`not in the catalog: ${id}`);
  return i;
};

/** **Runs through the product's actual export path as-is.** Only the resulting byte stream is observed */
function exportPose(orientation: Orientation) {
  const world = new VoxelWorld();
  world.replaceAll([[0, 0, 0, packCell(indexOf(BLOCKS[orientation.shape]), encodeOrientation(orientation))]]);
  return exportSignatureAt(buildMcstructure(world, CATALOG).bytes);
}

describe('measured ledger matches the export (#131 PR 3)', () => {
  it.each(LEDGER.map((entry) => [entry.label, entry] as const))('%s', (_label, entry) => {
    const signature = exportPose(entry.orientation);
    expect(signature.name).toBe(BLOCKS[entry.orientation.shape]);
    expect(signature.states).toEqual(entry.states);
  });

  /** Pins down that the ledger doesn't miss any pose in the orientation space (a gap learned from the #139 review) */
  it('the ledger covers every pose in the orientation space', () => {
    for (const shape of ['full', 'slab', 'stairs'] as const) {
      const codes = LEDGER.filter((e) => e.orientation.shape === shape).map((e) =>
        encodeOrientation(e.orientation),
      );
      expect(new Set(codes).size, `${shape} has duplicates`).toBe(codes.length);
      expect(codes.length, `${shape} is missing poses`).toBe(stateCountOf(shape));
    }
  });

  /**
   * **Different poses export differently.** If two poses produce the same state, one of them
   * has been collapsed on the export side (a mismatch, given that they're distinguishable on screen)
   */
  it('different poses produce different block states', () => {
    for (const shape of ['full', 'slab', 'stairs'] as const) {
      const written = LEDGER.filter((e) => e.orientation.shape === shape).map((e) =>
        JSON.stringify(exportPose(e.orientation).states),
      );
      expect(new Set(written).size, shape).toBe(written.length);
    }
  });

  /** Flipping upside-down does not move the horizontal orientation (confirmed on the real device 2026-08-01, #129). Same on the export side */
  it('weirdo_direction stays the same when flipped upside-down', () => {
    for (const d of [0, 1, 2, 3] as const) {
      const normal = exportPose({ shape: 'stairs', weirdoDirection: d, upsideDown: false });
      const flipped = exportPose({ shape: 'stairs', weirdoDirection: d, upsideDown: true });
      expect(flipped.states['weirdo_direction'], `d=${d}`).toBe(normal.states['weirdo_direction']);
      expect(flipped.states['upside_down_bit']).not.toBe(normal.states['upside_down_bit']);
    }
  });
});

/**
 * **Place every pose in a single work, and read them all back from one export** (#141 review finding).
 *
 * Writing each pose to a separate file can't detect a regression where **the palette
 * collapses within the same work**. In fact, once orientation was dropped from the palette
 * key, folding `pillar_axis: x` and `z` into the same entry, the one-cell-at-a-time tests
 * still stayed all green.
 */
describe('placing multiple poses in the same work does not collapse them (#131 PR 3)', () => {
  /** Lines up poses one cell at a time along X (coordinate = the ledger index) */
  function exportAllPoses() {
    const world = new VoxelWorld();
    world.replaceAll(
      LEDGER.map(
        (entry, i) =>
          [i, 0, 0, packCell(indexOf(BLOCKS[entry.orientation.shape]), encodeOrientation(entry.orientation))] as [
            number,
            number,
            number,
            number,
          ],
      ),
    );
    return buildMcstructure(world, CATALOG).bytes;
  }

  it('with a single export, every cell reads back with its own pose intact', () => {
    const bytes = exportAllPoses();
    for (const [i, entry] of LEDGER.entries()) {
      const signature = exportSignatureAt(bytes, [i, 0, 0]);
      expect(signature.name, entry.label).toBe(BLOCKS[entry.orientation.shape]);
      expect(signature.states, entry.label).toEqual(entry.states);
    }
  });

  /** Different poses of the same block must not be folded into the same palette entry */
  it('different poses of the same block get separate palette entries', () => {
    const bytes = exportAllPoses();
    const seen = new Map<string, string>();
    for (const [i, entry] of LEDGER.entries()) {
      const signature = exportSignatureAt(bytes, [i, 0, 0]);
      const key = `${signature.name} ${JSON.stringify(signature.states)}`;
      expect(seen.has(key), `${entry.label} exported the same as ${seen.get(key)}`).toBe(false);
      seen.set(key, entry.label);
    }
    expect(seen.size).toBe(LEDGER.length);
  });
});
