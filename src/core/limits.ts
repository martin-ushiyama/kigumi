/**
 * Common limits for coordinates/sizes.
 * The same values are used by UI (controls) / project loading (persistence) / export (mcstructure).
 */

/** Absolute value limit for x/z (y ranges 0 to COORD_LIMIT) */
export const COORD_LIMIT = 512;

/** Max side length on export */
export const EXPORT_MAX_SIDE = 512;

/** Max total bounds volume on export (equivalent to 128^3. ~16MB across two Int32Arrays) */
export const EXPORT_MAX_VOLUME = 2 ** 21;

/** Common volume limit for box fill / range select / move / duplicate / paste */
export const OP_MAX_CELLS = 32768;

/**
 * Upper bound on the bbox volume that shape generation is **allowed to scan** (#64 review).
 *
 * A separate constraint from the generated cell count limit (OP_MAX_CELLS). Even when a
 * hollow shape's result is much smaller than the bbox volume, every cell still needs to be
 * visited to determine whether it's a shell. A bbox at the full coordinate limit has about
 * 539 million cells, so "check the length after generating" would freeze the browser in
 * synchronous processing before the check is even reached. This caps the scan itself.
 *
 * 2^21 is equivalent to 128^3. Leaves headroom for shapes like a hollow dome where bbox
 * volume greatly exceeds the actual cell count, while keeping a single synchronous scan
 * within a practical time.
 */
export const SHAPE_MAX_SCAN_CELLS = 2 ** 21;

/** Whether valid as a cell coordinate (finite integer + within range). For world/export space — requires y >= 0 */
export function isValidCell(x: number, y: number, z: number): boolean {
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    Number.isInteger(z) &&
    Math.abs(x) <= COORD_LIMIT &&
    y >= 0 &&
    y <= COORD_LIMIT &&
    Math.abs(z) <= COORD_LIMIT
  );
}

/**
 * Whether valid as an owner-local coordinate (#37). Unlike isValidCell for world space, this
 * doesn't require y >= 0 — a negative group-local y is legitimate after inverse transforms
 * or a future reparent. The upper bound is the same COORD_LIMIT as world (a safeguard against pathological files).
 */
export function isValidLocalCell(x: number, y: number, z: number): boolean {
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    Number.isInteger(z) &&
    Math.abs(x) <= COORD_LIMIT &&
    Math.abs(y) <= COORD_LIMIT &&
    Math.abs(z) <= COORD_LIMIT
  );
}
