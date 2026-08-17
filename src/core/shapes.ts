import type { Cell } from './cell';
import { OP_MAX_CELLS, SHAPE_MAX_SCAN_CELLS } from './limits';
import type { Axis } from './axis';

/**
 * Shape generator.
 *
 * A pure function that builds a **list of cell coordinates** from a bbox + params. Doesn't
 * depend on UI or Document (layer convention: core never imports editor / ui / render).
 *
 * Since this is used for the same "drag a range then confirm" operation as the box fill,
 * the box shape is treated as just another shape on equal footing. Special-casing box would
 * mean every new shape adds another "box-only" branch (a design decision).
 *
 * ## Contract (settled in review round 1)
 *
 * 1. **Limits act at the entry point.** "Caller checks the length of the generated result"
 *    doesn't work as a limit (it locks up before the check is ever reached). We keep the
 *    scan-volume limit (`maxScanCells`) and the generated-cell-count limit (`maxCells`)
 *    **separate**, and return failure without building a result when either is exceeded.
 * 2. **Direction is part of the input.** The bbox normalizes start/end, so the direction of
 *    slope is lost. The caller passes the slope direction (`slope`) explicitly.
 *    `slopeDirectionFromCorners()` can build it directly from the two drag points.
 * 3. **How the bbox edges map is a discretization decision.**
 *    - Slope: both ends of the run always map to the lowest/highest row (regardless of the
 *      bbox aspect ratio)
 *    - Dome: the top row is the apex (a single cell for odd width, a minimal
 *      center-symmetric cap for even width)
 * 4. **Returned cell order is fixed as ascending x → y → z.** Matches the order of the
 *    existing box fill (the triple loop in `src/input/controls.ts`), so pillar_axis
 *    auto-detection and grouping behavior stay consistent regardless of which shape is added.
 */

/** Shape kind. box isn't "any other shape" — it's one entry on equal footing */
export type ShapeKind = 'box' | 'sphere' | 'cylinder' | 'dome' | 'slope';

export type Bbox = { readonly min: Cell; readonly max: Cell };

/** Direction the slope rises. Horizontal axis + sign (info lost when the bbox is normalized) */
export type SlopeDirection = {
  /** Axis the slope runs along. 0 = X / 2 = Z (Y is height, so it's never taken) */
  readonly axis: 0 | 2;
  /** true rises min → max. false rises max → min */
  readonly ascending: boolean;
};

export type ShapeParams = {
  /**
   * Whether to hollow out the shape. **The meaning differs by shape, in two ways**:
   * - `box` / `sphere` / `cylinder` / `dome`: a shell 1 cell thick (`toShell`)
   * - `slope`: **only the sloped surface layer** (drops the sides, floor, and the riser
   *   under each step). Meant for roofs — a shell would leave the sides and floor in place
   *   and it wouldn't read as a roof, so `insideSlope` handles this case itself.
   * - The default differs by shape (dome defaults to hollow since it's meant for roofs;
   *   everything else defaults to solid)
   */
  readonly hollow?: boolean;
  /** Cylinder axis (0=X / 1=Y / 2=Z). Defaults to Y */
  readonly axis?: Axis;
  /** Slope step height (blocks risen per step). Integer >= 1, defaults to 1 */
  readonly step?: number;
  /**
   * Slope direction. If omitted, defaults to "the longer horizontal axis, min → max"
   * (X on a tie). Use `slopeDirectionFromCorners()` when building this from a drag.
   */
  readonly slope?: SlopeDirection;
};

/** Scan-volume and cell-count limits. Defaults to core/limits.ts values when omitted */
export type ShapeLimits = {
  /** Upper bound on cells generated. Default OP_MAX_CELLS */
  readonly maxCells?: number;
  /** Upper bound on bbox volume scanned. Default SHAPE_MAX_SCAN_CELLS */
  readonly maxScanCells?: number;
};

export type ShapeResult =
  | { readonly ok: true; readonly cells: Cell[] }
  /**
   * `bboxTooLarge` is thrown **before scanning starts** (count = bbox volume).
   * `tooManyCells` is thrown after the scan completes (count = actual cell count; the scan
   * itself is bounded since it stays within the scan-volume limit).
   */
  | {
      readonly ok: false;
      readonly reason: 'bboxTooLarge' | 'tooManyCells';
      readonly count: number;
      readonly max: number;
    };

/** Default hollow setting per shape. Dome defaults to hollow since it's meant for roofs */
export function defaultHollow(kind: ShapeKind): boolean {
  return kind === 'dome';
}

/**
 * Whether this shape fills the bbox completely (= generated cell count always equals bbox
 * volume).
 *
 * This is the only combination where we can say for certain that `buildShape`'s generated-cell
 * limit will be hit **before scanning even starts**. Every other case can end up with fewer
 * cells than the bbox volume, so we can't assert an over-limit purely from the bbox
 * (hollow shapes were incorrectly marked "not applicable").
 *
 * This check lives in the same file as `buildShape` so it stays visible whenever a shape's
 * internals change. `tests/shapes.test.ts` cross-checks the two against every shape ×
 * hollow-flag combination.
 */
export function shapeFillsBbox(kind: ShapeKind, hollow: boolean): boolean {
  return kind === 'box' && !hollow;
}

type Vec3 = [number, number, number];

/** Cell count along each axis of the bbox (minimum 1) */
function sizeOf(bbox: Bbox): Vec3 {
  return [
    bbox.max[0] - bbox.min[0] + 1,
    bbox.max[1] - bbox.min[1] + 1,
    bbox.max[2] - bbox.min[2] + 1,
  ];
}

/**
 * Tolerance so boundary cells don't get dropped.
 *
 * The inscribed-shape test comes out to exactly 1.0 at the bbox edge (e.g. ±1 on an axis with
 * size=2). Floating-point error can push that to 1.0000000000000002, which would wipe out the
 * entire edge layer, so the comparison absorbs it.
 */
const EPS = 1e-9;

/**
 * Test for the ellipsoid inscribed in the bbox. Measured at cell centers.
 *
 * The radius is `size / 2`, but with a floor of 0.5 to avoid division by zero on an axis
 * where size = 1 (with size = 1, the only cell is at that axis's center, so the normalized
 * distance is always 0).
 */
function insideEllipsoid(bbox: Bbox, size: Vec3, x: number, y: number, z: number): boolean {
  const d = (v: number, min: number, max: number, s: number): number =>
    (v - (min + max) / 2) / Math.max(s / 2, 0.5);
  const dx = d(x, bbox.min[0], bbox.max[0], size[0]);
  const dy = d(y, bbox.min[1], bbox.max[1], size[1]);
  const dz = d(z, bbox.min[2], bbox.max[2], size[2]);
  return dx * dx + dy * dy + dz * dz <= 1 + EPS;
}

/** 6-neighbor offsets (±X / ±Y / ±Z) */
const NEIGHBORS: readonly Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * Builds a hollow (shell thickness 1) predicate from a solid predicate.
 *
 * "In the solid set, and at least one of the 6 neighbors isn't solid" = outer shell.
 * Neighbors in a direction listed in `openFaces` are excluded from the test, though — those
 * directions are meant to stay open, so we don't cap them off:
 * - Dome: the bottom (-Y) stays open, for use as a roof placed from above
 * - Cylinder: both ends along the axis stay open, for use as a tube
 * - Sphere / box: no open faces (fully closed all around)
 */
function toShell(
  solid: (x: number, y: number, z: number) => boolean,
  openFaces: readonly Vec3[],
): (x: number, y: number, z: number) => boolean {
  const isOpen = (n: Vec3): boolean =>
    openFaces.some((o) => o[0] === n[0] && o[1] === n[1] && o[2] === n[2]);
  const walls = NEIGHBORS.filter((n) => !isOpen(n));
  return (x, y, z) => {
    if (!solid(x, y, z)) return false;
    return walls.some((n) => !solid(x + n[0], y + n[1], z + n[2]));
  };
}

/**
 * Solid test for the dome. Not the top half of a sphere — a "half-ellipsoid that fits the
 * bbox exactly".
 *
 * The vertical radius is **the distance between the cell centers of the lowest and highest
 * rows** (`sizeY - 1`). Dividing by `sizeY` instead would cap out at `(sizeY-1)/sizeY < 1`
 * even at the top row, producing a flat-topped dome that never reaches the apex
 * (the top row of a 9×5×9 came out as a flat 21-cell plane).
 *
 * At the top row the horizontal radius collapses to 0, so the ellipsoid test alone would
 * leave **an empty layer whenever the width is even**. We always include the column closest
 * to the center as solid (1 cell for odd width, 2 cells for even width, 2×2 if both axes are
 * even). This column is the dome's own axis, so it's geometrically correct for it to be solid
 * at every height.
 */
function insideDome(bbox: Bbox, size: Vec3, x: number, y: number, z: number): boolean {
  if (y < bbox.min[1] || y > bbox.max[1]) return false;
  const cx = (bbox.min[0] + bbox.max[0]) / 2;
  const cz = (bbox.min[2] + bbox.max[2]) / 2;
  if (Math.abs(x - cx) <= 0.5 && Math.abs(z - cz) <= 0.5) return true; // Center column (minimal cap)
  const dx = (x - cx) / Math.max(size[0] / 2, 0.5);
  const dz = (z - cz) / Math.max(size[2] / 2, 0.5);
  const dy = (y - bbox.min[1]) / Math.max(size[1] - 1, 0.5);
  return dx * dx + dy * dy + dz * dz <= 1 + EPS;
}

/** Solid test for the cylinder — full bbox length along the axis, inscribed ellipse on the other two */
function insideCylinder(bbox: Bbox, size: Vec3, axis: Axis, x: number, y: number, z: number): boolean {
  const p: Vec3 = [x, y, z];
  if (p[axis] < bbox.min[axis] || p[axis] > bbox.max[axis]) return false;
  let sum = 0;
  for (const i of [0, 1, 2] as const) {
    if (i === axis) continue;
    const d = (p[i] - (bbox.min[i] + bbox.max[i]) / 2) / Math.max(size[i] / 2, 0.5);
    sum += d * d;
  }
  return sum <= 1 + EPS;
}

/** Default slope direction when omitted — the longer horizontal axis, min → max (X on a tie) */
function defaultSlopeDirection(size: Vec3): SlopeDirection {
  return { axis: size[2] > size[0] ? 2 : 0, ascending: true };
}

/**
 * Solid test for the slope.
 *
 * `step` is the rise per step, in blocks. For position i (0-indexed) along the run axis, the
 * surface height is decided by **linear interpolation with both endpoints pinned**:
 *
 * ```
 * continuous height = 1 + (height - 1) * i / (run - 1)   // i=0 → 1 / i=run-1 → height
 * rounded up to a step = min(height, ceil(ceil(continuous) / step) * step)
 * ```
 *
 * The key point is that the endpoint mapping is a contract on **both** ends
 * (raised in review):
 * - `ceil(height * (i+1) / run)` only pins the far end, so when `run < height` the near end
 *   started at a height of `ceil(height/run)` (5,10 for a 2×10; 7,14,20 for a 3×20) — a wall
 *   would jump up right at the low side
 * - An earlier version that split the run into equal step counts didn't even pin the far end
 *   (a 2×10 topped out at y=5)
 *
 * With the current formula, `step=1` gives 1,10 for a 2×10 and 1,11,20 for a 3×20.
 * When `step>1`, the near end starts at the height of one step (= step), preserving the
 * "rise per step" meaning. `run=1` can't be interpolated, so it's defined as "a single
 * column that rises to the full bbox height in one step".
 */
function insideSlope(
  bbox: Bbox,
  size: Vec3,
  step: number,
  dir: SlopeDirection,
  hollow: boolean,
  x: number,
  y: number,
  z: number,
): boolean {
  const p: Vec3 = [x, y, z];
  if (p[0] < bbox.min[0] || p[0] > bbox.max[0]) return false;
  if (p[2] < bbox.min[2] || p[2] > bbox.max[2]) return false;
  if (y < bbox.min[1] || y > bbox.max[1]) return false;

  const run = size[dir.axis];
  const height = size[1];
  const rise = Math.max(1, Math.floor(step));
  const i = dir.ascending ? p[dir.axis] - bbox.min[dir.axis] : bbox.max[dir.axis] - p[dir.axis];
  /** Top row of column idx along the run direction (height of the solid slope) */
  const topAt = (idx: number): number => {
    const continuous = run === 1 ? height : 1 + ((height - 1) * idx) / (run - 1);
    return bbox.min[1] + Math.min(height, Math.ceil(Math.ceil(continuous) / rise) * rise) - 1;
  };
  const top = topAt(i);
  if (y > top) return false;
  if (!hollow) return true;

  /**
   * A hollow slope is **only the sloped surface layer** — the fill underneath is dropped.
   * `toShell` would leave the sides, floor, and riser under each step in place and it
   * wouldn't read as a roof, so this handles it directly (the one case where "hollow" means
   * something different from every other shape).
   *
   * The bottom edge kept is **the lower of "one above the previous column" and "rise cells
   * from the top"**:
   * - When the difference from the previous column is more than `rise` (i.e. `run < height`
   *   and a column rises more than one step), extend down to cover that difference —
   *   otherwise the slope gets a hole and stops reading as a roof
   * - When the difference is 0 (a flat stretch of columns at the same height), keep `rise`
   *   cells. Looking only at "one above the previous column" would leave the second column
   *   onward empty.
   */
  const prevTop = i > 0 ? topAt(i - 1) : bbox.min[1] - 1;
  return y >= Math.max(bbox.min[1], Math.min(prevTop + 1, top - rise + 1));
}

/**
 * The face each shape wants left "open" (the direction that shouldn't get capped when hollow).
 *
 * `slope` never reaches this — since "hollow" means "only the sloped surface layer" rather
 * than "a shell" for slopes, it's handled directly by `insideSlope` instead of going through
 * `toShell`.
 */
function openFacesOf(kind: ShapeKind, axis: Axis): readonly Vec3[] {
  if (kind === 'dome') return [[0, -1, 0]];
  if (kind === 'cylinder') {
    const plus: Vec3 = [0, 0, 0];
    const minus: Vec3 = [0, 0, 0];
    plus[axis] = 1;
    minus[axis] = -1;
    return [plus, minus];
  }
  return [];
}

/** Assembles the solid-shape predicate (hollowing is wrapped by toShell) */
function solidPredicate(
  kind: ShapeKind,
  bbox: Bbox,
  size: Vec3,
  axis: Axis,
  step: number,
  slope: SlopeDirection,
  hollow: boolean,
): (x: number, y: number, z: number) => boolean {
  const inBox = (x: number, y: number, z: number): boolean =>
    x >= bbox.min[0] &&
    x <= bbox.max[0] &&
    y >= bbox.min[1] &&
    y <= bbox.max[1] &&
    z >= bbox.min[2] &&
    z <= bbox.max[2];

  switch (kind) {
    case 'box':
      return inBox;
    case 'sphere':
      return (x, y, z) => inBox(x, y, z) && insideEllipsoid(bbox, size, x, y, z);
    case 'cylinder':
      return (x, y, z) => inBox(x, y, z) && insideCylinder(bbox, size, axis, x, y, z);
    case 'dome':
      return (x, y, z) => inBox(x, y, z) && insideDome(bbox, size, x, y, z);
    case 'slope':
      return (x, y, z) => inBox(x, y, z) && insideSlope(bbox, size, step, slope, hollow, x, y, z);
  }
}

/**
 * Builds cell coordinates from a bbox + params.
 *
 * There are two limit checks: **before scanning starts** (bbox volume) and **after
 * scanning** (generated cell count). Either exceeding returns `ok: false`, which the caller
 * can pass straight through to a toast. Since the scan itself is bounded by `maxScanCells`,
 * sync processing never hangs even in the over-limit case.
 */
export function buildShape(
  kind: ShapeKind,
  bbox: Bbox,
  params: ShapeParams = {},
  limits: ShapeLimits = {},
): ShapeResult {
  const maxCells = limits.maxCells ?? OP_MAX_CELLS;
  const maxScanCells = limits.maxScanCells ?? SHAPE_MAX_SCAN_CELLS;

  const size = sizeOf(bbox);
  if (size[0] <= 0 || size[1] <= 0 || size[2] <= 0) return { ok: true, cells: [] };

  const volume = size[0] * size[1] * size[2];
  if (volume > maxScanCells) return { ok: false, reason: 'bboxTooLarge', count: volume, max: maxScanCells };

  const axis: Axis = params.axis ?? 1;
  const step = Math.max(1, Math.floor(params.step ?? 1));
  const slope = params.slope ?? defaultSlopeDirection(size);
  const hollow = params.hollow ?? defaultHollow(kind);

  const solid = solidPredicate(kind, bbox, size, axis, step, slope, hollow);
  // Hollowing for slope is already handled by `insideSlope` (only the sloped surface layer, not a shell)
  const include = hollow && kind !== 'slope' ? toShell(solid, openFacesOf(kind, axis)) : solid;

  // Scanning continues even past the limit (bounded since the bbox volume is within
  // maxScanCells) — cutting off partway would leave us unable to report "how many cells
  // there actually were", making the count shown in the toast a lie. Only the array push
  // is stopped, to keep memory in check.
  const cells: Cell[] = [];
  let count = 0;
  for (let x = bbox.min[0]; x <= bbox.max[0]; x++) {
    for (let y = bbox.min[1]; y <= bbox.max[1]; y++) {
      for (let z = bbox.min[2]; z <= bbox.max[2]; z++) {
        if (!include(x, y, z)) continue;
        count++;
        if (count <= maxCells) cells.push([x, y, z]);
      }
    }
  }
  if (count > maxCells) return { ok: false, reason: 'tooManyCells', count, max: maxCells };
  return { ok: true, cells };
}

/** Builds a bbox from two points (the drag's start and end) */
export function bboxOfCorners(a: Cell, b: Cell): Bbox {
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  };
}

/**
 * Builds a slope direction from the two points of a drag.
 *
 * `bboxOfCorners` normalizes to min/max, which loses **which point the drag started from**.
 * Given only the bbox, we could only build "min → max on the longer axis", with no way to
 * request a staircase in the opposite direction. The anchor (start) side ends up low, and
 * the target (end) side ends up high.
 *
 * The run axis is whichever horizontal axis had the larger movement (X on a tie). Zero
 * movement (run=1) is treated as ascending — with a width of 1 cell, direction is
 * meaningless anyway and the result doesn't change.
 */
export function slopeDirectionFromCorners(anchor: Cell, target: Cell): SlopeDirection {
  const dx = target[0] - anchor[0];
  const dz = target[2] - anchor[2];
  const axis: 0 | 2 = Math.abs(dz) > Math.abs(dx) ? 2 : 0;
  const delta = axis === 0 ? dx : dz;
  return { axis, ascending: delta >= 0 };
}
