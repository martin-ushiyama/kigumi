import { isValidLocalCell } from './limits';

/**
 * Coordinate primitives for cells. The lowest core module, depending on nothing but
 * limits (constants and range checks only).
 *
 * Split out from types.ts. Once `Hit` (types.ts) started carrying `CellRef`
 * (cellref.ts), a types → cellref dependency was created; if cellref then imported types
 * back for the coordinate types, that would form a cycle. Coordinate primitives are placed
 * below both to keep the dependency one-directional (cell ← cellref ← types).
 *
 * The existing import path (`from './types'`) is preserved via a re-export in types.ts.
 */

export type Cell = readonly [number, number, number];

/**
 * String key for a cell coordinate ("x,y,z"). Shared by VoxelWorld's internal Map /
 * SceneTree's membership index / Document's DocOp. Generation and parsing are centralized
 * here to prevent the duplication and format drift that came from hand-written
 * `${x},${y},${z}` / `key.split(',').map(Number)` scattered across the codebase.
 */
export type CellKey = string;

export function makeCellKey(x: number, y: number, z: number): CellKey {
  return `${x},${y},${z}`;
}

export function parseCellKey(key: CellKey): [number, number, number] {
  const parts = key.split(',');
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

/**
 * Validates that an owner-local `CellKey` is canonical (3 integer components + within
 * range + unique representation). `parseCellKey` isn't written defensively, so extra
 * components (`"0,0,0,extra"`) / NaN / non-integers / non-canonical notation (`"01,2,3"`)
 * silently pass through, letting the same logical cell end up with multiple key representations.
 *
 * **Call this at every entry point that receives a string `CellKey` from outside.** Copying
 * the same invariant check at each entry point risks fixing one and missing another (it was
 * present in `OwnerVoxelStore.set` but missing from `WorldIndex.applyVoxelChanges`, which
 * could desync the stack and the reverse-lookup index — raised in review).
 */
export function assertCanonicalLocalCellKey(key: CellKey, context: string): void {
  const [x, y, z] = parseCellKey(key);
  if (!isValidLocalCell(x, y, z) || makeCellKey(x, y, z) !== key) {
    throw new Error(`${context}: invalid CellKey "${key}" (not canonical "x,y,z" integer format)`);
  }
}
