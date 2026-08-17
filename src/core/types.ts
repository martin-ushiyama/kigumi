import type { CellRef } from './cellref';
import type { Shape } from './orientation';

export interface BlockDef {
  /** Bedrock block ID (e.g. "minecraft:polished_andesite") */
  id: string;
  nameJa: string;
  /** English display name sourced from the official en_US.lang. Default display for OSS release */
  nameEn: string;
  category: 'stone' | 'wood' | 'soil' | 'misc';
  /** Flat color for editor display (#rrggbb) */
  color: string;
  /**
   * Catalog-fixed block states applied on export (e.g. pillar_axis for logs).
   * Does not include vertical_half / upside_down_bit / weirdo_direction
   * (orientation.ts always derives those from the per-voxel orientation)
   */
  states?: Record<string, string | number | boolean>;
  shape: Shape;
  /**
   * Grouping key for palette display. Matches the material's "full" block id (no prefix).
   * Naming for slab/stairs is irregular (e.g. stone's stairs is stone_stairs but it has no
   * slab, while the unrelated smooth_stone has its own smooth_stone_slab), so it can't be
   * derived by string conversion.
   */
  materialGroup: string;
}

/**
 * cell.ts (the lowest core layer) is the source of truth for coordinate primitives.
 * Re-exported here to keep the existing `from './types'` import path working
 * (split out to avoid a circular import).
 */
export type { Cell, CellKey } from './cell';
export { makeCellKey, parseCellKey } from './cell';

/** Whether the block has a pillar_axis (logs, basalt, quartz pillar, etc). Used to decide targets for the orientation-change UI / auto-detection */
export function isPillarBlock(def: BlockDef): boolean {
  return def.shape === 'full' && !!def.states && 'pillar_axis' in def.states;
}

/**
 * Raycast hit result. Placed in core because both picking (input layer) and the services
 * layer produce/consume this shared contract (keeps the dependency direction input → core).
 *
 * A voxel hit **always carries `ref` (owner + owner-local cell)**. If only the
 * world coordinate were carried around, "which cell was hit" couldn't be recovered after
 * seeing through a locked group to pick the ref beneath it, or after the winner changes.
 * A ground hit has no cell that was actually hit, so this is a discriminated union that
 * expresses the no-`ref` case in the type.
 */
export type Hit =
  | {
      kind: 'voxel';
      ref: CellRef;
      /** World coordinate of the hit cell (where ref projects to) */
      cell: [number, number, number];
      normal: [number, number, number];
      /** Distance from the ray origin */
      t: number;
    }
  | {
      kind: 'ground';
      /** Ground hits use y=-1 (placement target = cell + normal) */
      cell: [number, number, number];
      normal: [number, number, number];
      t: number;
    };

/** texture = textured display / flat = solid flat color + outline */
export type DisplayMode = 'texture' | 'flat';

export type Tool = 'place' | 'erase' | 'fill' | 'pick' | 'select';


