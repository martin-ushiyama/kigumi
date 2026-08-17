import { EXPORT_MAX_SIDE, EXPORT_MAX_VOLUME, isValidCell } from '../core/limits';
import { decodeOrientation, orientationToNbtStates, unpackCell } from '../core/orientation';
import type { BlockDef } from '../core/types';
import type { WorldReader } from '../core/voxels';
import { nbt, writeNbt, type NbtValue } from './nbt';
import { DisplayableError } from '../core/i18n';

/**
 * Version for block_palette entries.
 * The 1.21.60-series value (listed on the Bedrock wiki). The game uses this
 * version to upgrade legacy IDs to the current spec, so it's safe to pin to
 * this known value.
 */
export const BLOCK_VERSION = 18168865;

/** Practical size limit for a structure block (a warning is shown above this) */
export const SIZE_WARN_LIMIT = 64;

export interface McstructureResult {
  bytes: Uint8Array;
  size: [number, number, number];
  blockCount: number;
  paletteCount: number;
  /** True if any side exceeds SIZE_WARN_LIMIT */
  oversized: boolean;
}

function statesToNbt(states: Record<string, string | number | boolean>): Record<string, NbtValue> {
  const out: Record<string, NbtValue> = {};
  for (const [key, value] of Object.entries(states)) {
    if (typeof value === 'string') out[key] = nbt.string(value);
    else if (typeof value === 'boolean') out[key] = nbt.byte(value ? 1 : 0);
    else out[key] = nbt.int(value);
  }
  return out;
}

/**
 * VoxelWorld → .mcstructure byte array.
 * block_indices is in ZYX order (x outermost → y → z innermost); empty
 * cells are -1 (keep existing block). Layer 2 (for waterlogging) is all -1.
 */
export function buildMcstructure(world: WorldReader, catalog: BlockDef[]): McstructureResult {
  const bounds = world.bounds();
  if (!bounds) throw new DisplayableError('exportErr.empty');

  // Validate coordinates, dimensions, and volume before allocating the array.
  // volume is the volume of bounds (not the block count) — a required guard
  // since even two sparse, far-apart points can blow this up.
  if (!isValidCell(...bounds.min) || !isValidCell(...bounds.max)) {
    throw new DisplayableError('exportErr.invalidCoords');
  }

  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  const sx = maxX - minX + 1;
  const sy = maxY - minY + 1;
  const sz = maxZ - minZ + 1;

  if (sx > EXPORT_MAX_SIDE || sy > EXPORT_MAX_SIDE || sz > EXPORT_MAX_SIDE) {
    throw new DisplayableError('exportErr.sideTooLong', { sx, sy, sz, max: EXPORT_MAX_SIDE });
  }
  const volume = sx * sy * sz;
  if (volume > EXPORT_MAX_VOLUME) {
    throw new DisplayableError('exportErr.volumeTooLarge', {
      sx,
      sy,
      sz,
      volume: volume.toLocaleString(),
      max: EXPORT_MAX_VOLUME.toLocaleString(),
    });
  }

  // Build the palette from only the cell values actually in use (the
  // catalogIndex + orientation pairs).
  // The raw packed cell value already uniquely represents
  // (catalogIndex, orientationCode), so it can be used directly as the
  // palette key without building a composite key (unpack is only needed
  // when creating a new palette entry)
  const paletteMap = new Map<number, number>();
  const paletteEntries: NbtValue[] = [];
  const layer0 = new Int32Array(volume).fill(-1);

  let blockCount = 0;
  // Iterate in coordinate order. Palette indices are assigned in
  // "first-encountered order", so a different traversal order produces a
  // different byte array from the same model. WorldIndex's entries() order
  // depends on paint order / the history of incremental updates, so using it
  // directly would mean "just grouping cells changes the .mcpack byte
  // array". Pay the O(n log n) cost only for export, so the same model
  // always yields the same byte array.
  const sorted = [...world.entries()].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  for (const [x, y, z, raw] of sorted) {
    let paletteIndex = paletteMap.get(raw);
    if (paletteIndex === undefined) {
      const { catalogIndex, code } = unpackCell(raw);
      const def = catalog[catalogIndex];
      if (!def) continue; // Silently skip (not drop with an error) indices outside the catalog, for saved-data compatibility
      const orientation = decodeOrientation(def.shape, code);
      const orientationStates = { ...orientationToNbtStates(orientation) };
      // Safeguard against injecting orientation state into blocks whose
      // catalog entry has no pillar_axis (e.g. stone, which has no concept
      // of orientation), even if axis info somehow ended up in `code`.
      // (state.ts is supposed to prevent this already, but this gives
      // export-side resilience against anomalous values too, e.g. from an
      // old loaded project file)
      if ('pillar_axis' in orientationStates && !(def.states && 'pillar_axis' in def.states)) {
        delete orientationStates.pillar_axis;
      }
      const states = { ...(def.states ?? {}), ...orientationStates };
      paletteIndex = paletteEntries.length;
      paletteMap.set(raw, paletteIndex);
      paletteEntries.push(
        nbt.compound({
          name: nbt.string(def.id),
          states: nbt.compound(statesToNbt(states)),
          version: nbt.int(BLOCK_VERSION),
        }),
      );
    }
    const offset = (x - minX) * sy * sz + (y - minY) * sz + (z - minZ);
    layer0[offset] = paletteIndex;
    blockCount++;
  }

  const root = nbt.compound({
    format_version: nbt.int(1),
    size: nbt.list([nbt.int(sx), nbt.int(sy), nbt.int(sz)]),
    structure: nbt.compound({
      block_indices: nbt.list([
        nbt.intList(layer0),
        nbt.intList(new Int32Array(volume).fill(-1)),
      ]),
      entities: nbt.list([]),
      palette: nbt.compound({
        default: nbt.compound({
          block_palette: nbt.list(paletteEntries),
          block_position_data: nbt.compound({}),
        }),
      }),
    }),
    structure_world_origin: nbt.list([nbt.int(0), nbt.int(0), nbt.int(0)]),
  });

  return {
    bytes: writeNbt(root as NbtValue & { type: 'compound' }),
    size: [sx, sy, sz],
    blockCount,
    paletteCount: paletteEntries.length,
    oversized: sx > SIZE_WARN_LIMIT || sy > SIZE_WARN_LIMIT || sz > SIZE_WARN_LIMIT,
  };
}
