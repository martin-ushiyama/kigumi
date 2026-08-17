import type { CellRef } from '../core/cellref';
import type { Document, DocOp } from '../core/document';
import { isValidCell, OP_MAX_CELLS } from '../core/limits';
import { initialTransformOf, localKeyOf, ownerToWorldCell } from '../core/ownerlocal';
import { IDENTITY_RESOLVED, rebaseTransform, type GroupTransform } from '../core/transform';
import { makeCellKey, parseCellKey } from '../core/types';
import { activePatternAt, type PatternPaint } from '../core/patternpaint';
import type { OpResult } from './ops';
import { resolveSelectionRefs, worldBboxOfRefs } from './ops';
import type { NormalizedSelection } from './selection';

/**
 * Portable copy data (made owner-local in #37 B1b).
 *
 * Copying a groups selection **carries owner-local coordinates + group transform as-is**
 * — baking them into world coordinates would break the shape when pasting a rotated
 * group (falling off the grid, or the orientation raw value double-rotating). Only the
 * top-level group's transform gets folded via `rebaseTransform` into "including the
 * original parent chain" (since the paste destination is always directly under root,
 * skipping this would change the world-space appearance for anything that was
 * originally nested).
 */
export interface ClipboardData {
  /**
   * `[ownerIndex, x, y, z, packed value]`.
   * - `ownerIndex >= 0`: index into the `groups` array. Coordinates are **that owner's local**
   * - `ownerIndex === -1`: fragment root (a cell not carried out with a group). Coordinates are **world - origin**
   */
  cells: [number, number, number, number, number, PatternPaint?][];
  /** Pre-order. `parent` is an index into this array; -1 means fragment root */
  groups: {
    name: string;
    parent: number;
    hidden?: boolean;
    locked?: boolean;
    /** If this is a component instance, its id (#69). Stays an instance at the paste destination too */
    templateId?: string;
    transform?: GroupTransform;
  }[];
  /** World bbox min at copy time (absolute coordinates) */
  origin: [number, number, number];
  size: [number, number, number];
}

/**
 * Snapshots a selection into portable form (Ctrl+C). Only a groups selection carries
 * out its subtree structure.
 *
 * The argument is `NormalizedSelection` — if a raw `{ ids: ['p', 'c'] }` could be
 * passed in, `collectGroup('p')` would add `c` as a child, and then `collectGroup('c')`
 * would register the same `c` a second time at the top level, overwriting
 * `groupIndexOf('c')` with the latter and **breaking the hierarchy after paste** (found
 * in a second review pass). The type enforces using the **same normalized ids** for
 * both ref resolution and groups collection.
 */
export function snapshotSelection(doc: Document, sel: NormalizedSelection): ClipboardData | null {
  const refs = resolveSelectionRefs(doc, sel);
  if (refs.length === 0) return null;
  const bbox = worldBboxOfRefs(doc, refs);
  if (!bbox) return null;
  const origin: [number, number, number] = [bbox.min[0], bbox.min[1], bbox.min[2]];

  const groups: ClipboardData['groups'] = [];
  const groupIndexOf = new Map<string, number>();
  const collectGroup = (id: string, parentIndex: number): void => {
    const node = doc.tree.getNode(id);
    if (!node) return;
    const myIndex = groups.length;
    // Top level (parentIndex === -1) has its paste destination directly under root, so
    // the original parent chain gets folded in.
    //
    // A group with no transform set **must always** be materialized on top of
    // `initialTransformOf` (a pivot derived from subtree bounds), too (P2 from review).
    // Paste always loads a non-zero offset onto translate, so the top level ends up
    // with a transform regardless — if pivot were left as `[0, 0]` at that point, the
    // appearance right after paste would still hold, but **the first rotation after
    // that would pivot around the origin instead of the subtree center** (inconsistent
    // with the "don't bake in a placeholder" rule elsewhere in this PR).
    //
    // The pivot is decided **at snapshot time**. At paste time the group isn't in the
    // tree yet, so the subtree bounds (folding in descendant transforms) can't be
    // derived.
    const transform =
      parentIndex === -1
        ? rebaseTransform(
            node.transform ?? initialTransformOf(doc.scene, id),
            doc.tree.transformChain(node.parentId),
            IDENTITY_RESOLVED,
          )
        : node.transform;
    groups.push({
      name: node.name,
      parent: parentIndex,
      ...(node.hidden !== undefined ? { hidden: node.hidden } : {}),
      ...(node.locked !== undefined ? { locked: node.locked } : {}),
      ...(node.templateId !== undefined ? { templateId: node.templateId } : {}),
      ...(transform !== undefined ? { transform } : {}),
    });
    groupIndexOf.set(id, myIndex);
    for (const childId of doc.tree.childrenOf(id)) collectGroup(childId, myIndex);
  };
  if (sel.kind === 'groups') {
    for (const id of sel.ids) collectGroup(id, -1);
  }

  const cells: ClipboardData['cells'] = [];
  for (const ref of refs) {
    const value = doc.scene.cells.get(ref.ownerId, localKeyOf(ref));
    if (value === undefined) continue;
    const ownerIndex = ref.ownerId !== null ? (groupIndexOf.get(ref.ownerId) ?? -1) : -1;
    const paint = doc.scene.patterns
      ? activePatternAt(doc.scene.patterns, doc.scene.cells, ref.ownerId, localKeyOf(ref))
      : null;
    if (ownerIndex !== -1) {
      if (paint) cells.push([ownerIndex, ref.localCell[0], ref.localCell[1], ref.localCell[2], value, paint]);
      else cells.push([ownerIndex, ref.localCell[0], ref.localCell[1], ref.localCell[2], value]);
      continue;
    }
    // Fragment root: hold the projected world position relative to origin (the paste destination root is identity, so local = world)
    const world = ownerToWorldCell(doc.tree, ref.ownerId, ref.localCell);
    const worldRaw = doc.worldRawOf(ref.ownerId, value);
    const worldPaint = paint
      ? {
          ...paint,
          sourceRaw: doc.worldRawOf(ref.ownerId, paint.sourceRaw),
          appliedRaw: worldRaw,
        }
      : null;
    if (worldPaint) {
      cells.push([-1, world[0] - origin[0], world[1] - origin[1], world[2] - origin[2], worldRaw, worldPaint]);
    } else {
      cells.push([-1, world[0] - origin[0], world[1] - origin[1], world[2] - origin[2], worldRaw]);
    }
  }
  if (cells.length === 0) return null;

  return {
    cells,
    groups,
    origin,
    size: [bbox.max[0] - bbox.min[0] + 1, bbox.max[1] - bbox.min[1] + 1, bbox.max[2] - bbox.min[2] + 1],
  };
}

/** Candidate paste offsets (starting from adjacent +X, the first one where the whole bbox fits in range) */
function findPasteOffset(clip: ClipboardData): [number, number, number] | null {
  const [sx, sy, sz] = clip.size;
  const min = clip.origin;
  const max: [number, number, number] = [min[0] + sx - 1, min[1] + sy - 1, min[2] + sz - 1];
  const candidates: [number, number, number][] = [[sx, 0, 0], [-sx, 0, 0], [0, 0, sz], [0, 0, -sz], [0, sy, 0]];
  for (const delta of candidates) {
    const okMin = isValidCell(min[0] + delta[0], min[1] + delta[1], min[2] + delta[2]);
    const okMax = isValidCell(max[0] + delta[0], max[1] + delta[1], max[2] + delta[2]);
    if (okMin && okMax) return delta;
  }
  return null;
}

/**
 * Pastes the clipboard (Ctrl+V). Placement follows the same adjacent-offset search as
 * duplicate. Works self-contained even if the copy source is gone (the clip carries
 * coordinates, values, and structure in full).
 *
 * The offset is loaded onto **the top-level group's translate** and **the fragment
 * root cells' world coordinates**. Cells under a group are pasted with their local
 * coordinates unchanged, so copy-pasting a rotated group doesn't break its shape.
 */
export function buildPaste(doc: Document, clip: ClipboardData): OpResult {
  if (clip.cells.length === 0) return { error: 'noSelection' };
  // Always guard here before building up a large ops array (shared limit, flagged in #8 review)
  if (clip.cells.length > OP_MAX_CELLS) {
    return { error: 'tooLargeAfterDuplicate', errorVars: { count: clip.cells.length.toLocaleString(), max: OP_MAX_CELLS.toLocaleString() } };
  }
  const delta = findPasteOffset(clip);
  if (!delta) return { error: 'noRoomToDuplicate' };

  const ops: DocOp[] = [];
  const idMap = new Map<number, string>();
  // Track the next insertion index per parent. New groups don't actually exist in
  // doc.tree until applied (childrenOf always returns []), so naively using only
  // doc.tree.childrenOf(parentId).length would compute index 0 every time for the
  // second and later siblings sharing the same parent, reversing sibling order
  // depending on apply order (repeated childIds.splice(0,...) stacks up LIFO-style).
  // Base it on doc.tree's actual child count only for the first one, then increment
  // locally by 1 afterward to preserve sibling order.
  const nextIndexByParent = new Map<string | null, number>();
  function nextInsertIndex(parentId: string | null): number {
    const base = nextIndexByParent.get(parentId) ?? doc.tree.childrenOf(parentId).length;
    nextIndexByParent.set(parentId, base + 1);
    return base;
  }
  for (let i = 0; i < clip.groups.length; i++) {
    const g = clip.groups[i]!;
    const newId = doc.nextGroupId();
    idMap.set(i, newId);
    const parentId = g.parent === -1 ? null : (idMap.get(g.parent) ?? null);
    const index = nextInsertIndex(parentId);
    // Top level loads the paste offset onto translate (parent = root = identity, so world delta = parent-local delta)
    const transform: GroupTransform | undefined =
      g.parent === -1
        ? {
            angleSteps: g.transform?.angleSteps ?? 0,
            translate: [
              (g.transform?.translate[0] ?? 0) + delta[0],
              (g.transform?.translate[1] ?? 0) + delta[1],
              (g.transform?.translate[2] ?? 0) + delta[2],
            ],
            pivot2: [g.transform?.pivot2[0] ?? 0, g.transform?.pivot2[1] ?? 0],
          }
        : g.transform;
    ops.push({
      kind: 'createGroup',
      node: {
        id: newId,
        name: g.name,
        parentId,
        childIds: [],
        ...(g.hidden !== undefined ? { hidden: g.hidden } : {}),
        ...(g.locked !== undefined ? { locked: g.locked } : {}),
        ...(g.templateId !== undefined ? { templateId: g.templateId } : {}),
        ...(transform !== undefined ? { transform } : {}),
      },
      index,
    });
  }

  const newRefs: CellRef[] = [];
  for (const [ownerIndex, x, y, z, value, paint] of clip.cells) {
    if (ownerIndex === -1) {
      // Fragment root: restore to world coordinates (root is identity, so local = world)
      const wx = clip.origin[0] + x + delta[0];
      const wy = clip.origin[1] + y + delta[1];
      const wz = clip.origin[2] + z + delta[2];
      if (!isValidCell(wx, wy, wz)) continue;
      ops.push({ kind: 'voxel', owner: null, key: makeCellKey(wx, wy, wz), before: null, after: value });
      if (paint) ops.push({ kind: 'setPattern', owner: null, key: makeCellKey(wx, wy, wz), before: null, after: paint });
      newRefs.push({ ownerId: null, localCell: [wx, wy, wz] });
      continue;
    }
    const newGroupId = idMap.get(ownerIndex);
    if (!newGroupId) continue;
    const localKey = makeCellKey(x, y, z);
    ops.push({ kind: 'voxel', owner: newGroupId, key: localKey, before: null, after: value });
    if (paint) ops.push({ kind: 'setPattern', owner: newGroupId, key: localKey, before: null, after: paint });
    newRefs.push({ ownerId: newGroupId, localCell: parseCellKey(localKey) });
  }
  if (!newRefs.length) return { error: 'noSelection' };

  const topLevelNewIds = clip.groups
    .map((g, i) => (g.parent === -1 ? idMap.get(i) : undefined))
    .filter((id): id is string => id !== undefined);
  if (topLevelNewIds.length > 0) return { tx: { ops }, newSelection: { kind: 'groups', ids: topLevelNewIds } };
  return { tx: { ops }, newSelectionRefs: newRefs };
}
