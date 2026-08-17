import { assertNever, decodeStates, encodeStates, type StateAssignment } from './orientation-codec';

export type Shape = 'full' | 'slab' | 'stairs';
export type PillarAxis = 'x' | 'y' | 'z';

export type Orientation =
  | { shape: 'full'; axis: PillarAxis }
  | { shape: 'slab'; half: 'bottom' | 'top' }
  | { shape: 'stairs'; weirdoDirection: 0 | 1 | 2 | 3; upsideDown: boolean };

/**
 * Bit width reserved for the orientation code (6 bits = 64 values).
 *
 * Values needed per shape: full 3 (axis) / slab 2 (top/bottom) / stairs 8 (4 facings × 2
 * upside-down states) / button 12 (3 mounting faces × 4 facings) / trapdoor 16 (4 facings ×
 * 2 up/down × 2 open/closed) / door 32 (4 facings × 2 half × 2 open/closed × 2 hinge).
 * We give ourselves double the headroom over the largest case, door's 32.
 *
 * 300 catalog entries × 64 = 19200, nowhere close to JS's safe-integer limit.
 *
 * **Changing this width never breaks saved projects** — the save format
 * (project/persistence.ts) stores the blockId string and the code separately rather than
 * writing out raw cell values. And since the meaning of `code` is scoped per shape
 * (encodeOrientation), the existing 0–15 range keeps pointing at the same orientations.
 */
const ORIENTATION_BITS = 64;
const ORIENTATION_MASK = 0b111111;

/**
 * Maximum orientation code value. **The save-format validator also reads this**
 * (project/persistence.ts).
 *
 * The writer (serializeProjectV5) writes out `unpackCell(raw).code` as-is, so if the reader
 * used a different upper bound we'd end up in a state where something could be saved but not
 * loaded back. Keeping the one place that knows this width here avoids that.
 */
export const MAX_ORIENTATION_CODE = ORIENTATION_MASK;

/** Whether a value loaded from a save file is a valid orientation code (an integer in 0..MAX_ORIENTATION_CODE) */
export function isValidOrientationCode(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_ORIENTATION_CODE;
}

/**
 * Reserved catalogIndex used for the **void cell**. Not a real catalog entry.
 *
 * Void is a cell that means "blocksmith isn't placing anything here" — stacking it in front
 * hides whatever's behind it (a hole). **It doesn't carve anything away, so it can still be
 * moved later.**
 *
 * We keep the cell value's shape (`catalogIndex * ORIENTATION_BITS + code`) unchanged, and
 * instead **reserve a single index the catalog's length can never reach**:
 *
 * - Using a negative value would make `raw` negative, which would ripple into sort order,
 *   palette keys, and `!== null` checks
 * - We deliberately **don't lean on** the existing fallback where an out-of-catalog index
 *   gets skipped via `!def` — piggybacking on that would make "void" indistinguishable from
 *   "corrupted data", losing the ability to warn when something is actually broken. Void is
 *   handled with an explicit branch via `isVoidCell` instead.
 *
 * Every Bedrock block totals 1342 entries in `mojang-blocks.json`'s `data_items`, nowhere
 * near 2^20 (tests/orientation.test.ts pins this fact so it never gets reached).
 */
export const VOID_CATALOG_INDEX = 2 ** 20;

/** A VoxelWorld cell value is always "catalogIndex * ORIENTATION_BITS + orientationCode". Full blocks are unified under code=0 too */
export function packCell(catalogIndex: number, code: number): number {
  return catalogIndex * ORIENTATION_BITS + (code & ORIENTATION_MASK);
}

/** Cell value for the void cell. It has no concept of orientation, so code is always 0 */
export const VOID_CELL = packCell(VOID_CATALOG_INDEX, 0);

/** Whether this cell value is void. Not out-of-catalog indices in general — only the reserved index counts as void */
export function isVoidCell(raw: number): boolean {
  return Math.floor(raw / ORIENTATION_BITS) === VOID_CATALOG_INDEX;
}

/**
 * Builds the value to paint. **Void has no orientation, so the code is discarded.**
 *
 * Calling `packCell` directly would let you build a value where void carries an orientation
 * code (`packCell(VOID, 3)`). `isVoidCell` would still return true for it, so it would work,
 * but **multiple raw values would end up meaning the same thing** — causing "changed even
 * though nothing changed" bugs across diffing, palette keys, and save round-trips. Keeping a
 * single entry point for building the paint value ensures void is always `VOID_CELL`.
 */
export function packPaintCell(catalogIndex: number, code: number): number {
  return catalogIndex === VOID_CATALOG_INDEX ? VOID_CELL : packCell(catalogIndex, code);
}

export function unpackCell(value: number): { catalogIndex: number; code: number } {
  return { catalogIndex: Math.floor(value / ORIENTATION_BITS), code: value & ORIENTATION_MASK };
}

export function defaultCode(_shape: Shape): number {
  return 0; // slab=bottom, stairs=weirdoDirection 0 / not flipped
}

/**
 * The (x, z) unit vector for the direction a stair's high side faces, indicated by
 * weirdo_direction (0-3).
 *
 * **This is the single source of truth for stair orientation.** The display rotation angle,
 * group rotation, mirroring, and export all derive from this. We used to assume "rotate d ×
 * 90 degrees from a +Z reference pose", but that's not how the real block behaves — 0 and 1
 * are 180 degrees apart, so d is a label, not a rotation amount. Every place that duplicates
 * this definition is a place where only one copy can get fixed by accident.
 *
 * Two sources agree on this, **both pointing to the same layout**:
 *
 * 1. Measured on the real client (2026-08-01, Bedrock 1.21). `scripts/gen-stairs-probe.mjs`
 *    wrote out a structure with directional markers embedded and checked which way each
 *    stair's high face pointed.
 * 2. Community references. Multiple sources agree that Bedrock stairs use data values 0-3
 *    for east / west / south / north, with +8 flipping upside-down (Minecraft Forum /
 *    Minecraft Education forums). Mojang's official Block States list only says it
 *    "represents the rotation of the stairs", without spelling out the number-to-direction
 *    mapping.
 *
 * | weirdo_direction | direction the high face points |
 * |---|---|
 * | 0 | east (+X) |
 * | 1 | west (-X) |
 * | 2 | south (+Z) |
 * | 3 | north (-Z) |
 */
const STAIRS_FACING_XZ = [
  [1, 0], // 0: east
  [-1, 0], // 1: west
  [0, 1], // 2: south
  [0, -1], // 3: north
] as const satisfies readonly (readonly [number, number])[];

/** weirdo_direction → the (x, z) unit vector for the direction the stair's high side faces */
export function stairsFacingXZ(weirdoDirection: 0 | 1 | 2 | 3): readonly [number, number] {
  return STAIRS_FACING_XZ[weirdoDirection];
}

/**
 * The weirdo_direction after rotating by +Y 90 degrees × steps.
 *
 * **This is the single path that rotates stair orientation.** The T-key / inspector
 * orientation cycle, group rotation (`transform.ts::rotateRaw`), and the projection all go
 * through this. Writing `weirdoDirection + steps` would produce 180-degree jumps like
 * east→west (since 0 and 1 are 180 degrees apart) — in fact, review found exactly
 * that old addition still lingering in the T-key path. Keeping this as a single copyable
 * implementation is what guarantees one side never goes stale on its own.
 *
 * The rotation direction matches the coordinate side (`transform.ts::rotateXZ`'s step
 * 1 = (x,z)→(z,-x)).
 */
export function rotateWeirdoDirection(weirdoDirection: 0 | 1 | 2 | 3, steps: number): 0 | 1 | 2 | 3 {
  let [x, z] = stairsFacingXZ(weirdoDirection);
  const turns = ((steps % 4) + 4) % 4;
  for (let i = 0; i < turns; i++) [x, z] = [z, -x];
  return xzToWeirdoDirection(x, z);
}

/** Inverse of the above (facing vector → weirdo_direction). Throws if it's not a unit direction */
export function xzToWeirdoDirection(x: number, z: number): 0 | 1 | 2 | 3 {
  for (const d of [0, 1, 2, 3] as const) {
    const [fx, fz] = STAIRS_FACING_XZ[d];
    if (fx === x && fz === z) return d;
  }
  throw new Error(`xzToWeirdoDirection: not a unit direction (${x}, ${z})`);
}

/** code 0/1/2 ↔ axis y/x/z (full's default code=0 is always y, fully compatible with existing orientation-less blocks) */
export function codeToAxis(code: number): PillarAxis {
  return code === 1 ? 'x' : code === 2 ? 'z' : 'y';
}

export function axisToCode(axis: PillarAxis): number {
  return axis === 'x' ? 1 : axis === 'z' ? 2 : 0;
}

/** Advances a pillar_axis block's axis one step in the order y→x→z→y (shared by the T-key and inspector axis toggle) */
export function cyclePillarAxis(code: number): number {
  return (code + 1) % 3;
}

/**
 * Orientation code → Orientation.
 *
 * **The numbering itself is owned by `orientation-codec.ts`** (sourced from the upstream
 * block state declarations). This just moves the state values into the `Orientation` shape.
 * We used to hand-write bit manipulation per shape, but that meant a new shape would silently
 * get swallowed into the last branch (stairs).
 */
export function decodeOrientation(shape: Shape, code: number): Orientation {
  const states = decodeStates(shape, code);
  switch (shape) {
    case 'full':
      return { shape, axis: states['pillar_axis'] as PillarAxis };
    case 'slab':
      return { shape, half: states['minecraft:vertical_half'] as 'bottom' | 'top' };
    case 'stairs':
      return {
        shape,
        weirdoDirection: states['weirdo_direction'] as 0 | 1 | 2 | 3,
        upsideDown: states['upside_down_bit'] as boolean,
      };
    default:
      return assertNever(shape, 'decodeOrientation');
  }
}

/** Orientation → orientation code. The numbering is owned by `orientation-codec.ts` (pairs with `decodeOrientation`) */
export function encodeOrientation(o: Orientation): number {
  return encodeStates(o.shape, orientationToStates(o));
}

/**
 * Moves an `Orientation` into a block state assignment. **Export goes through here too** (so
 * there's never a second definition).
 *
 * **Not exported** — the meaning model is `Orientation` alone; the state assignment exists
 * purely for save/export purposes.
 */
function orientationToStates(o: Orientation): StateAssignment {
  switch (o.shape) {
    case 'full':
      return { pillar_axis: o.axis };
    case 'slab':
      return { 'minecraft:vertical_half': o.half };
    case 'stairs':
      return { weirdo_direction: o.weirdoDirection, upside_down_bit: o.upsideDown };
    default:
      return assertNever(o, 'orientationToStates');
  }
}

/**
 * Advances a slab/stairs orientation to the next value (T key: stair horizontal-facing cycle).
 *
 * Goes through the same `rotateWeirdoDirection` as group rotation — advancing it with
 * separate logic here would let "orientation from the T key" and "orientation from rotating
 * the whole group" disagree.
 */
export function cycleFacing(shape: Shape, code: number): number {
  if (shape !== 'stairs') return code;
  const o = decodeOrientation(shape, code) as Extract<Orientation, { shape: 'stairs' }>;
  return encodeOrientation({ ...o, weirdoDirection: rotateWeirdoDirection(o.weirdoDirection, 1) });
}

/** Upside-down toggle (G key: slab's top/bottom, stairs' upside_down_bit) */
export function toggleFlip(shape: Shape, code: number): number {
  if (shape === 'slab') {
    const o = decodeOrientation(shape, code) as Extract<Orientation, { shape: 'slab' }>;
    return encodeOrientation({ ...o, half: o.half === 'top' ? 'bottom' : 'top' });
  }
  if (shape === 'stairs') {
    const o = decodeOrientation(shape, code) as Extract<Orientation, { shape: 'stairs' }>;
    return encodeOrientation({ ...o, upsideDown: !o.upsideDown });
  }
  return code;
}

/**
 * The orientation-derived NBT states merged with BlockDef.states at export time.
 * full (pillar_axis) returns empty only for the default y — this is by design, so we never
 * accidentally inject pillar_axis into a block whose catalog entry doesn't have it (no
 * concept of orientation, e.g. stone). There's an additional safeguard on the caller side
 * too: if the catalog doesn't declare pillar_axis for a block, this key is ignored outright
 * (see export/mcstructure.ts).
 */
export function orientationToNbtStates(o: Orientation): Record<string, string | number | boolean> {
  // **No value conversion happens here.** Since we hold the upstream value domain directly as
  // the pose, export can just pass it through as-is (inserting a conversion table would create
  // a spot where it alone could drift from upstream)
  if (o.shape === 'full' && o.axis === 'y') return {};
  return { ...orientationToStates(o) };
}
