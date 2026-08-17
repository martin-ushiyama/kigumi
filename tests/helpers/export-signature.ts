import { readNbt, type ParsedNbt } from '../nbt-reader';

/**
 * **Reads orientation back from the exported byte stream**.
 *
 * ## Shares nothing with the renderer-side observation
 *
 * Shares neither types nor functions with `render-signature.ts` (PR 2). The moment they're
 * shared, both sides would just be looking at the same table, and **the very thing this is
 * about — a mismatch between the screen and the export — would become undetectable**
 * (the same failure mode as the stair-orientation one: "if both sides share the same table, the round trip
 * always passes").
 *
 * The only anchor for cross-checking is **the ledger**. The expected values for the screen
 * and for the export are written by hand independently, observed independently, and only
 * when both match the ledger can we say "the screen and the export point to the same
 * orientation."
 *
 * ## How to read it
 *
 * `.mcstructure` is NBT (little-endian, uncompressed). A cell's orientation lives in the
 * `block_palette` element pointed to by the value at `structure.block_indices[0]`.
 * This never references the product's export code at all — it only walks the NBT structure.
 *
 * The index layout is determined by `size` (`(x * sy + y) * sz + z`). **`size` is also read
 * from the file** — borrowing the product's own calculation would mean any layout drift
 * shifts on both sides together.
 */

/** One exported cell. `states` is the palette contents as-is */
export interface ExportSignature {
  /** Block ID (e.g. `minecraft:oak_log`) */
  name: string;
  /** Block state. Empty for blocks with no orientation */
  states: Record<string, string | number | boolean>;
}

const asRecord = (value: ParsedNbt): Record<string, ParsedNbt> => value as Record<string, ParsedNbt>;

/**
 * Reads the cell at a given position from the `.mcstructure` byte stream.
 *
 * **Set up so multiple orientations can be placed in a single build and read back from one
 * export.** Writing each orientation to a separate file would make it **impossible to
 * detect a regression where the palette collapses within the same build** (e.g. `pillar_axis:
 * x` and `z` folding into the same entry — unnoticeable one cell at a time,
 * a review finding).
 *
 * @param bytes the byte stream returned by `buildMcstructure`
 * @param cell position relative to the minimum corner of the export range (defaults to the minimum corner itself)
 */
export function exportSignatureAt(bytes: Uint8Array, cell: [number, number, number] = [0, 0, 0]): ExportSignature {
  const root = asRecord(readNbt(bytes).value);
  const structure = asRecord(root['structure']!);
  const size = root['size'] as ParsedNbt[];
  const [sx, sy, sz] = size.map(Number) as [number, number, number];
  const [x, y, z] = cell;
  if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) {
    throw new Error(`outside the export range: [${x}, ${y}, ${z}] (size ${sx}x${sy}x${sz})`);
  }
  const offset = (x * sy + y) * sz + z;
  const layers = structure['block_indices'] as ParsedNbt[][];
  const index = layers[0]![offset];
  if (typeof index !== 'number') throw new Error(`block_indices[0][${offset}] is not a number`);
  if (index < 0) throw new Error(`this cell is empty (index ${index})`);

  const palette = asRecord(asRecord(structure['palette']!)['default']!);
  const entry = asRecord((palette['block_palette'] as ParsedNbt[])[index]!);
  const name = entry['name'];
  if (typeof name !== 'string') throw new Error('palette entry has no name');

  // states may be absent (for blocks with no orientation)
  const rawStates = entry['states'];
  const states: Record<string, string | number | boolean> = {};
  if (rawStates && typeof rawStates === 'object' && !Array.isArray(rawStates)) {
    for (const [key, value] of Object.entries(rawStates)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        states[key] = value;
      } else if (typeof value === 'bigint') {
        states[key] = Number(value);
      } else {
        throw new Error(`state ${key} has an unexpected type`);
      }
    }
  }

  return { name, states };
}
