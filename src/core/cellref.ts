import { assertCanonicalLocalCellKey, makeCellKey, parseCellKey, type Cell, type CellKey } from './cell';

/**
 * The cell identifier `CellRef` and its normalized key.
 *
 * World coordinates aren't a cell's identity — multiple owners can project onto the
 * same world coordinate, and the winner can swap due to hide / reordering / transform.
 * Persistent identity is held by "which owner, which local cell" = `CellRef`.
 *
 * Placed as a low-level module depending only on `cell.ts`. This is so that when `Hit`
 * (types.ts) or Selection come to hold a `CellRef`, it doesn't create a circular
 * import between types and sceneprojection.
 */

/** A cell's owner. Group id, or `null` = directly under root (unassigned cell) */
export type OwnerId = string | null;

export interface CellRef {
  readonly ownerId: OwnerId;
  readonly localCell: Cell;
}

/**
 * `CellRef`'s normalized string key. Used to treat CellRefs as equal when used as Map/Set keys.
 *
 * The format is `"<owner length>|<owner>|x,y,z"`, and `"-|x,y,z"` for root (owner=null).
 * The length prefix exists to **make encoding injective over `OwnerId`'s entire value
 * range (`string | null`)**. A naive delimiter join would
 * collapse `owner === ''` onto the same key as root, and an id containing `|` would
 * silently desync parsing. Since `SceneTree` currently rejects neither empty-string ids
 * nor ids containing `|`, rejecting them as "invalid ids" at key-generation time would
 * create a state where **a valid EditorScene becomes unreadable by derived indexes**.
 * So instead of relying on upstream id-generation rules, the key side reversibly
 * encodes any string.
 */
export type CellRefKey = string;

const SEP = '|';
/** Marker for root (owner=null). The owner side always contains a length (non-negative integer), so it never collides with a digit */
const ROOT_MARK = '-';

function encodeOwner(owner: OwnerId): string {
  return owner === null ? ROOT_MARK : `${owner.length}${SEP}${owner}`;
}

/**
 * The sole entry point for key generation. **No generation API accepts a string
 * `CellKey`** — if a non-canonical representation ("01,2,3" / "0,0,0,extra") went
 * straight into a key, the same logical cell would end up with multiple key
 * representations, desyncing the stack and its reverse-lookup index (raised in
 * finding). It's routed through `makeCellKey` from a numeric `localCell`, so the same
 * logical cell always produces the same representation (validating that coordinates
 * are within range is each caller's own responsibility, via `assertCanonicalLocalCellKey`).
 */
export function makeCellRefKey(ref: CellRef): CellRefKey {
  return `${encodeOwner(ref.ownerId)}${SEP}${makeCellKey(ref.localCell[0], ref.localCell[1], ref.localCell[2])}`;
}

export function parseCellRefKey(key: CellRefKey): CellRef {
  const sep = key.indexOf(SEP);
  if (sep === -1) throw new Error(`Invalid CellRefKey (no delimiter): ${key}`);
  const head = key.slice(0, sep);
  if (head === ROOT_MARK) return { ownerId: null, localCell: parseLocalCell(key, key.slice(sep + 1)) };

  const length = Number(head);
  // Reject non-canonical representations like "01" or non-integers (so the same ref never has multiple key representations)
  if (!Number.isInteger(length) || length < 0 || String(length) !== head) {
    throw new Error(`Invalid CellRefKey (owner length is not a non-negative integer): ${key}`);
  }
  const ownerEnd = sep + 1 + length;
  if (key[ownerEnd] !== SEP) {
    throw new Error(`Invalid CellRefKey (owner length doesn't match content): ${key}`);
  }
  return { ownerId: key.slice(sep + 1, ownerEnd), localCell: parseLocalCell(key, key.slice(ownerEnd + 1)) };
}

function parseLocalCell(key: CellRefKey, localKey: CellKey): Cell {
  // The generating side (makeCellRefKey) only ever produces canonical output, so parsing
  // must enforce the same invariant. If a corrupted string were restored as a ref with
  // NaN coordinates, it would silently vanish as a Map miss
  assertCanonicalLocalCellKey(localKey, `Invalid CellRefKey "${key}"`);
  return parseCellKey(localKey);
}

/**
 * A mapping of refs to apply to selection state as the result of a mutation.
 * `CellRef` is stable across winner changes and owner transforms, but changes its
 * localCell / ownerId when the cell itself physically moves (nudge / drag / move
 * between owners / group / ungroup). Simply "dropping vanished refs from selection"
 * would deselect right after a move commits, so old -> new is applied only on success.
 * `null` = the ref was deleted.
 */
export type CellRefRemap = ReadonlyMap<CellRefKey, CellRef | null>;
