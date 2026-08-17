import { makeCellRefKey, type CellRef, type CellRefKey, type OwnerId } from '../core/cellref';
import type { Document, DocOp, Transaction } from '../core/document';
import type { ReadonlyGroupNode } from '../core/scenetree';
import type { OpErrorKey } from '../core/i18n';
import { COORD_LIMIT, isValidCell, OP_MAX_CELLS } from '../core/limits';
import {
  initialTransformOf,
  localKeyOf,
  ownersOfSubtree,
  ownerToWorldCell,
  ownerToWorldRaw,
  refsOfSubtree,
  worldDeltaToOwnerDelta,
  worldToOwnerRaw,
} from '../core/ownerlocal';
import {
  applyTransform,
  composeResolved,
  composeTransform,
  IDENTITY_RESOLVED,
  inverseResolved,
  rebaseTransform,
  resolvedEquals,
  rotateDeltaToLocal,
  type AngleSteps,
  type GroupTransform,
  type MirrorAxis,
} from '../core/transform';
import { defaultCode, packCell, unpackCell, type Shape } from '../core/orientation';
import {
  activePatternAt,
  nextPatternVariant,
  resolvePatternRaw,
  samplePatternAt,
  samePatternPaint,
  type PatternPaint,
} from '../core/patternpaint';
import type { MixRecipe } from '../core/mixpalette';
import { parseCellKey, type Cell } from '../core/types';
import { cellSelectionFromRefs, type NormalizedSelection, type Selection, type SelectionStore } from './selection';

/**
 * Result of an op builder.
 *
 * - `newSelection`: selection that can be resolved before applying (groups selection / clear selection)
 * - `newSelectionRefs`: selection that must be resolved **after applying** (newly created refs).
 *   Where a ref projects to isn't known until the transaction is applied, so `commitOpResult`
 *   runs it through `cellSelectionFromRefs` after `applyTransaction`
 *
 * Neither is needed when an existing ref merely moved — `SelectionStore` auto-follows via
 * `Transaction.remap` on the commit notification (#37 design rev.5).
 */
export type OpResult =
  | { tx: Transaction; newSelection?: Selection; newSelectionRefs?: readonly CellRef[] }
  /**
   * Failure is returned as a **key** (#70). The editor layer can't depend on state, so it
   * can't assemble display text. The display side (`commitOpResult`'s translate) resolves
   * it in the current language.
   */
  | { error: OpErrorKey; errorVars?: Record<string, string | number> };

/**
 * Centralizes applying a builder result in one place (so the 8 call sites don't each
 * rewrite "toast on error / apply if tx isn't empty / set if newSelection exists").
 * Returns true if applied.
 */
export function commitOpResult(
  doc: Document,
  selection: SelectionStore,
  result: OpResult,
  toast: (msg: string) => void,
  /** Error key -> display text. Resolved in the current language by the composition root (#70) */
  translate: (key: OpErrorKey, vars?: Record<string, string | number>) => string,
): boolean {
  if ('error' in result) {
    toast(translate(result.error, result.errorVars));
    return false;
  }
  if (!result.tx.ops.length) return false;
  doc.applyTransaction(result.tx);
  if (result.newSelectionRefs) selection.set(cellSelectionFromRefs(doc.index, result.newSelectionRefs));
  else if (result.newSelection) selection.set(result.newSelection);
  return true;
}

/**
 * From a set of selected ids, keeps only the outermost ones — drops any id that is a
 * descendant of another selected id. Selecting a parent and child together and then
 * deleting/duplicating/grouping/ungrouping would otherwise process the child twice
 * (once via the parent's subtree pass), causing a double-applied destructive op
 * (exception on the second deleteGroup -> partial apply). Every builder that handles a
 * groups selection must normalize at its entry point.
 */
function dropDescendantIds(doc: Document, ids: string[]): string[] {
  return ids.filter((id) => !ids.some((other) => other !== id && doc.tree.isAncestor(other, id)));
}

/**
 * Resolves the actual ref list a selection points to (also referenced from clipboard.ts's
 * snapshotSelection).
 *
 * Since the argument is `NormalizedSelection`, groups are already outermost-only — no
 * need to call `dropDescendantIds` here (guaranteed by the type).
 */
export function resolveSelectionRefs(doc: Document, sel: NormalizedSelection): CellRef[] {
  if (sel.kind === 'cells') return [...sel.cells.values()].map((c) => c.ref);
  if (sel.kind === 'groups') {
    const out: CellRef[] = [];
    for (const id of sel.ids) out.push(...refsOfSubtree(doc.scene, id));
    return out;
  }
  return [];
}

/** Projected world bbox of a ref list (includes hidden / occluded. Basis for clamp / pivot / duplicate offset) */
export function worldBboxOfRefs(doc: Document, refs: readonly CellRef[]): { min: Cell; max: Cell } | null {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let found = false;
  for (const ref of refs) {
    const world = doc.index.worldOf(ref);
    if (!world) continue;
    if (world[0] < minX) minX = world[0];
    if (world[1] < minY) minY = world[1];
    if (world[2] < minZ) minZ = world[2];
    if (world[0] > maxX) maxX = world[0];
    if (world[1] > maxY) maxY = world[1];
    if (world[2] > maxZ) maxZ = world[2];
    found = true;
  }
  return found ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : null;
}

/** Builds a voxel op (Document overwrites `before` with the measured value, but we fill in the live value for history readability) */
function voxelOp(doc: Document, owner: OwnerId, localKey: string, after: number | null): DocOp {
  return { kind: 'voxel', owner, key: localKey, before: doc.scene.cells.get(owner, localKey) ?? null, after };
}

function eraseOp(doc: Document, ref: CellRef): DocOp {
  return voxelOp(doc, ref.ownerId, localKeyOf(ref), null);
}

function placeOp(doc: Document, ref: CellRef, localRaw: number): DocOp {
  return voxelOp(doc, ref.ownerId, localKeyOf(ref), localRaw);
}

/**
 * Detects a collision folding into the same owner-local in the **transaction's final
 * state** (#37 design rev.3 blocker (4) / rev.4 P2).
 *
 * Two refs can hold the same world coordinate while their owners differ, but when
 * ungroup moves a group's direct cells up to the parent, or when overlapping refs are
 * merged into one new group, they can fold onto the same owner/local and one disappears
 * (`OwnerVoxelStore` holds one value per owner/local). **Collisions are detected up
 * front and the whole transaction is rejected atomically** — a destructive resolution
 * like "top wins" would need an explicit product spec + confirmation UI, so we don't do
 * that here.
 *
 * The check runs against the state after folding the op list in order, not "currently
 * occupied", so **a cell that vacates within the same transaction is not treated as a
 * collision** (avoids false positives). Not called for ops where overwriting is
 * intentional (Fill's overwrite / duplicate landing spots).
 */
function detectOwnerLocalCollision(
  doc: Document,
  ops: readonly DocOp[],
): { key: OpErrorKey; vars: Record<string, string> } | null {
  const occupied = new Map<CellRefKey, boolean>();
  const keyOf = (owner: OwnerId, localKey: string): CellRefKey => `${owner === null ? '-' : `${owner.length}|${owner}`}|${localKey}`;
  for (const op of ops) {
    if (op.kind !== 'voxel') continue;
    const key = keyOf(op.owner, op.key);
    const before = occupied.has(key) ? occupied.get(key)! : doc.scene.cells.has(op.owner, op.key);
    if (op.after !== null && before) {
      // When owner is root (unassigned), swap out the message text itself.
      // Injecting "(unassigned)" as a variable into the English string would mix in
      // Japanese (#70 review)
      return op.owner === null
        ? { key: 'overlapAtDestinationRoot' as const, vars: {} }
        : { key: 'overlapAtDestination' as const, vars: { owner: op.owner } };
    }
    occupied.set(key, op.after !== null);
  }
  return null;
}

/**
 * Only pushes a `setGroupTransform` op when the parent chain's effective transform
 * changes (#37 B1b review P1).
 *
 * **`transform === undefined` means "identity relative to the old parent", not world
 * identity.** If the parent changes and the effective transform changes, an unset group
 * must also be rebased on top of `initialTransformOf`, or the position/rotation it
 * inherited from the old parent is lost.
 *
 * Doesn't push an op if the effective transform is unchanged (avoid cluttering history
 * for nothing).
 */
function rebaseOpIfParentChainChanged(doc: Document, id: string, newParentId: string | null): DocOp | null {
  const node = doc.tree.getNode(id);
  if (!node) return null;
  const oldParentChain = doc.tree.transformChain(node.parentId);
  const newParentChain = doc.tree.transformChain(newParentId);
  if (resolvedEquals(oldParentChain, newParentChain)) return null;
  const base = node.transform ?? initialTransformOf(doc.scene, id);
  return {
    kind: 'setGroupTransform',
    id,
    before: node.transform,
    after: rebaseTransform(base, oldParentChain, newParentChain),
  };
}

/**
 * Creates a new group from an ad-hoc cell selection or a groups selection (Ctrl+G).
 *
 * `name` is **passed by the caller (composition root side)** (#70). The default name
 * varies by display language, and the editor layer can't depend on state (layering
 * convention in docs/architecture.md). The default name is also **data** saved into the
 * work file, so it must be finalized at creation time.
 */
export function buildGroup(doc: Document, sel: NormalizedSelection, name: string): OpResult {
  if (sel.kind === 'none') return { error: 'noSelection' };
  const nodeId = doc.nextGroupId();
  const ops: DocOp[] = [];

  if (sel.kind === 'cells') {
    const index = doc.tree.childrenOf(null).length;
    // A new group has no transform set = identity. So local coordinates = world coordinates
    ops.push({ kind: 'createGroup', node: { id: nodeId, name, parentId: null, childIds: [] }, index });
    const refs = [...sel.cells.values()].map((c) => c.ref);
    const remap = new Map<CellRefKey, CellRef | null>();
    const placed: DocOp[] = [];
    const newRefs: CellRef[] = [];
    for (const ref of refs) {
      if (doc.tree.isLockedEffective(ref.ownerId)) continue; // Don't move while locked
      const retargeted = doc.retargetRef(ref, nodeId);
      if (!retargeted) continue;
      ops.push(eraseOp(doc, ref));
      placed.push(placeOp(doc, retargeted.ref, retargeted.localRaw));
      remap.set(makeCellRefKey(ref), retargeted.ref);
      newRefs.push(retargeted.ref);
    }
    if (!newRefs.length) return { error: 'noGroupableBlocks' };
    // Push all erases before any place — so the collision check runs against the
    // final state "after vacating the original owner" (grouping within the same owner
    // doesn't collide with itself)
    ops.push(...placed);
    const collision = detectOwnerLocalCollision(doc, ops);
    if (collision) return { error: collision.key, errorVars: collision.vars };
    return { tx: { ops, remap }, newSelection: { kind: 'groups', ids: [nodeId] } };
  }

  // groups selection: create a new group under the LCA of the current parents of each
  // selected group, then reparent all selected groups as its children. The new group
  // itself is identity, but **if the original parent is deeper than the LCA, the parent
  // chain's effective transform changes**, so those children (even with no transform
  // set) must be rebased to preserve their world appearance.
  // sel is a NormalizedSelection, so ids are already outermost-only (guaranteed by type)
  const topIds = sel.ids;
  const parents = topIds.map((id) => doc.tree.getNode(id)?.parentId ?? null);
  const lca = doc.tree.commonAncestor(parents);
  const index = doc.tree.childrenOf(lca).length;
  ops.push({ kind: 'createGroup', node: { id: nodeId, name, parentId: lca, childIds: [] }, index });
  let childIndex = 0;
  for (const id of topIds) {
    const node = doc.tree.getNode(id);
    if (!node) continue;
    const oldIndex = doc.tree.childrenOf(node.parentId).indexOf(id);
    ops.push({
      kind: 'reparentGroup',
      id,
      beforeParent: node.parentId,
      beforeIndex: oldIndex,
      afterParent: nodeId,
      afterIndex: childIndex++,
    });
    // The new group is directly under the LCA and identity, so the child's new parent chain = chain(LCA)
    const rebase = rebaseOpIfParentChainChanged(doc, id, lca);
    if (rebase) ops.push(rebase);
  }
  return { tx: { ops } , newSelection: { kind: 'groups', ids: [nodeId] } };
}

/** Ungroups the given groups (Ctrl+Shift+G). Lifts child groups and direct cells up to the parent, then deletes itself */
export function buildUngroup(doc: Document, groupIds: string[]): OpResult {
  const ops: DocOp[] = [];
  const remap = new Map<CellRefKey, CellRef | null>();
  for (const id of dropDescendantIds(doc, groupIds)) {
    const node = doc.tree.getNode(id);
    if (!node) continue;
    const newParent = node.parentId;
    const groupChain = doc.tree.transformChain(id);
    const parentChain = doc.tree.transformChain(newParent);

    // (1) Child groups: reparent + rebase transform onto the parent chain (preserve world appearance)
    let insertIndex = doc.tree.childrenOf(newParent).length;
    for (const childId of [...doc.tree.childrenOf(id)]) {
      const child = doc.tree.getNode(childId);
      const oldIndex = doc.tree.childrenOf(id).indexOf(childId);
      ops.push({
        kind: 'reparentGroup',
        id: childId,
        beforeParent: id,
        beforeIndex: oldIndex,
        afterParent: newParent,
        afterIndex: insertIndex++,
      });
      // Bake the ungrouped group's transform into the child: child' = parent^-1 * G * child
      const base = child?.transform ?? initialTransformOf(doc.scene, childId);
      const rebased = rebaseTransform(base, groupChain, parentChain);
      ops.push({ kind: 'setGroupTransform', id: childId, before: child?.transform, after: rebased });
    }

    // (2) Direct cells: move to the parent owner (transform both coordinates and raw, push all erases first)
    const directRefs = [...doc.scene.cells.entriesOf(id)].map(
      ([localKey]): CellRef => ({ ownerId: id, localCell: parseCellKey(localKey) }),
    );
    const placed: DocOp[] = [];
    for (const ref of directRefs) {
      const retargeted = doc.retargetRef(ref, newParent);
      if (!retargeted) continue;
      ops.push(eraseOp(doc, ref));
      placed.push(placeOp(doc, retargeted.ref, retargeted.localRaw));
      remap.set(makeCellRefKey(ref), retargeted.ref);
    }
    ops.push(...placed);

    // (3) Delete the now-empty self (cells/children were vacated above, so the final state is empty)
    const siblings = doc.tree.childrenOf(node.parentId);
    ops.push({ kind: 'deleteGroup', node: { ...node, childIds: [] }, index: siblings.indexOf(id) });
  }
  const collision = detectOwnerLocalCollision(doc, ops);
  if (collision) return { error: collision.key, errorVars: collision.vars };
  return { tx: { ops, remap }, newSelection: { kind: 'none' } };
}

/**
 * Deletes a selection (cells or groups). For groups, processes post-order (deepest
 * first), erasing each node's direct cells before pushing its own deleteGroup —
 * self-contained rather than relying on Document's auto-prune (so deleting a single
 * empty group also works correctly).
 */
export function buildDeleteSelection(doc: Document, sel: NormalizedSelection): OpResult {
  if (sel.kind === 'none') return { tx: { ops: [] } };
  const ops: DocOp[] = [];
  const remap = new Map<CellRefKey, CellRef | null>();

  if (sel.kind === 'cells') {
    for (const cell of sel.cells.values()) {
      const ref = cell.ref;
      if (doc.tree.isLockedEffective(ref.ownerId)) continue; // Locked cells are excluded from deletion (protection documented in README)
      if (!doc.scene.cells.has(ref.ownerId, localKeyOf(ref))) continue;
      ops.push(eraseOp(doc, ref));
      remap.set(makeCellRefKey(ref), null);
    }
    return { tx: { ops, remap }, newSelection: { kind: 'none' } };
  }

  // True if the id itself or any descendant is locked (protects the whole subtree
  // involved with a lock, to avoid a partial-delete inconsistency where the parent gets
  // deleteGroup'd while its children remain)
  function subtreeHasLock(id: string): boolean {
    const node = doc.tree.getNode(id);
    if (!node) return false;
    if (node.locked) return true;
    return doc.tree.childrenOf(id).some((childId) => subtreeHasLock(childId));
  }

  function visit(id: string): void {
    if (doc.tree.isLockedEffective(id) || subtreeHasLock(id)) return; // Excluded from deletion entirely while locked (including via ancestor or descendant)
    for (const childId of [...doc.tree.childrenOf(id)]) visit(childId);
    for (const [localKey] of doc.scene.cells.entriesOf(id)) {
      const ref: CellRef = { ownerId: id, localCell: parseCellKey(localKey) };
      ops.push(eraseOp(doc, ref));
      remap.set(makeCellRefKey(ref), null);
    }
    const node = doc.tree.getNode(id);
    if (!node) return;
    const siblings = doc.tree.childrenOf(node.parentId);
    ops.push({ kind: 'deleteGroup', node: { ...node, childIds: [] }, index: siblings.indexOf(id) });
  }
  for (const id of sel.ids) visit(id); // Outermost-only since this is a NormalizedSelection
  return { tx: { ops, remap }, newSelection: { kind: 'none' } };
}

/** Renames a group (for double-click rename in the layers panel) */
export function buildRename(doc: Document, id: string, name: string): Transaction {
  const node = doc.tree.getNode(id);
  if (!node || node.name === name) return { ops: [] };
  return { ops: [{ kind: 'renameGroup', id, before: node.name, after: name }] };
}

/** Toggles a group's visibility (for the eye icon in the layers panel) */
export function buildToggleHidden(doc: Document, id: string): Transaction {
  const node = doc.tree.getNode(id);
  if (!node) return { ops: [] };
  const before = !!node.hidden;
  return { ops: [{ kind: 'setGroupHidden', id, before, after: !before }] };
}

/** Toggles a group's lock state (for the lock icon in the layers panel) */
export function buildToggleLocked(doc: Document, id: string): Transaction {
  const node = doc.tree.getNode(id);
  if (!node) return { ops: [] };
  const before = !!node.locked;
  return { ops: [{ kind: 'setGroupLocked', id, before, after: !before }] };
}

/**
 * Replaces a single ref's block type/orientation (for the inspector).
 * Owner doesn't change since this is an overwrite. `afterWorldRaw` is passed as the
 * **world orientation** (the UI operates on the projected orientation), and is converted
 * to owner-local here.
 */
export function buildSetCell(doc: Document, ref: CellRef, afterWorldRaw: number): Transaction {
  const localKey = localKeyOf(ref);
  const before = doc.scene.cells.get(ref.ownerId, localKey) ?? null;
  const after = doc.localRawOf(ref.ownerId, afterWorldRaw);
  if (before === null || before === after) return { ops: [] };
  return { ops: [{ kind: 'voxel', owner: ref.ownerId, key: localKey, before, after }] };
}

/** Clamps delta per axis so the whole selection's bbox stays within isValidCell's range (x/z: +/-COORD_LIMIT, y: 0..COORD_LIMIT) */
export function clampDeltaToBounds(bbox: { min: Cell; max: Cell }, delta: [number, number, number]): [number, number, number] {
  const clampAxis = (lo: number, hi: number, d: number, floor: number, ceil: number): number => {
    let v = d;
    if (lo + v < floor) v = floor - lo;
    if (hi + v > ceil) v = ceil - hi;
    return v;
  };
  return [
    clampAxis(bbox.min[0], bbox.max[0], delta[0], -COORD_LIMIT, COORD_LIMIT),
    clampAxis(bbox.min[1], bbox.max[1], delta[1], 0, COORD_LIMIT),
    clampAxis(bbox.min[2], bbox.max[2], delta[2], -COORD_LIMIT, COORD_LIMIT),
  ];
}

/** The ref reached by shifting a ref by a world delta (physical move within the owner, raw unchanged) */
function movedRef(doc: Document, ref: CellRef, worldDelta: Cell): CellRef {
  const d = worldDeltaToOwnerDelta(doc.tree, ref.ownerId, worldDelta);
  return {
    ownerId: ref.ownerId,
    localCell: [ref.localCell[0] + d[0], ref.localCell[1] + d[1], ref.localCell[2] + d[2]],
  };
}

/**
 * Translates a selected ref list by a world delta (a single transaction, for nudging).
 * Each ref moves **within its own owner** (ownership and raw both unchanged), so cells
 * in a rotated group still move straightforwardly in world directions.
 *
 * To handle self-overlap correctly (e.g. moving refs swapping places), whether an erase
 * is needed is decided by checking whether the destination is "another cell of the same
 * moving ref set".
 */
export function buildMove(doc: Document, refs: readonly CellRef[], delta: [number, number, number]): OpResult {
  if (refs.length === 0) return { error: 'noSelection' };
  // Some call sites (e.g. the inspector) don't pre-check the limit, so we always guard
  // here before building a large Map (shared limit, #8 review finding)
  if (refs.length > OP_MAX_CELLS) {
    return { error: 'tooLargeToMove', errorVars: { count: refs.length.toLocaleString(), max: OP_MAX_CELLS.toLocaleString() } };
  }
  if (delta[0] === 0 && delta[1] === 0 && delta[2] === 0) return { tx: { ops: [] } };

  const moving = new Map<CellRefKey, { ref: CellRef; dest: CellRef; value: number }>();
  for (const ref of refs) {
    if (doc.tree.isLockedEffective(ref.ownerId)) continue; // Locked cells are excluded from moving (protection documented in README)
    const value = doc.scene.cells.get(ref.ownerId, localKeyOf(ref));
    if (value === undefined) continue;
    moving.set(makeCellRefKey(ref), { ref, dest: movedRef(doc, ref, delta), value });
  }
  if (moving.size === 0) return { error: 'noSelection' };

  for (const { dest } of moving.values()) {
    // The destination isn't in the index yet (it's about to be created), so compute the projection directly
    const world = ownerToWorldCell(doc.tree, dest.ownerId, dest.localCell);
    if (!isValidCell(world[0], world[1], world[2])) return { error: 'outOfRangeMove' };
  }

  const ops: DocOp[] = [];
  const remap = new Map<CellRefKey, CellRef | null>();
  const destKeys = new Set<CellRefKey>();
  for (const { ref, dest, value } of moving.values()) {
    destKeys.add(makeCellRefKey(dest));
    ops.push(placeOp(doc, dest, value));
    remap.set(makeCellRefKey(ref), dest);
  }
  for (const [key, { ref }] of moving) {
    if (destKeys.has(key)) continue; // Overlaps someone's destination = treated as still occupied, no erase needed
    ops.push(eraseOp(doc, ref));
  }
  return { tx: { ops, remap } };
}

/**
 * Translates a group by a world delta (#37 design rev.3: buildTranslateGroup is B1b's
 * responsibility).
 *
 * `GroupTransform.translate` is a value in the **parent's coordinate system**, so the
 * world delta is converted to parent-local by the inverse of the parent's resolved
 * rotation before adding. For a group with no transform set, this creates the first
 * transform and initializes the pivot from the subtree's local bounds (does not bake in
 * a placeholder `[0,0]`).
 *
 * Clamping is done against the **projected world bbox** (all refs, including
 * hidden/occluded) — so toggling visibility alone doesn't change how clamping behaves.
 */
export function buildTranslateGroup(doc: Document, id: string, worldDelta: [number, number, number]): OpResult {
  const node = doc.tree.getNode(id);
  if (!node) return { error: 'groupNotFound' };
  if (doc.tree.isLockedEffective(id)) return { error: 'lockedGroupCannotMove' };

  const bbox = worldBboxOfRefs(doc, refsOfSubtree(doc.scene, id));
  const delta = bbox ? clampDeltaToBounds(bbox, worldDelta) : worldDelta;
  if (delta[0] === 0 && delta[1] === 0 && delta[2] === 0) return { tx: { ops: [] } };

  const parentLocalDelta = rotateDeltaToLocal(delta, doc.tree.transformChain(node.parentId));
  const base = node.transform ?? initialTransformOf(doc.scene, id);
  const after: GroupTransform = {
    angleSteps: base.angleSteps,
    translate: [
      base.translate[0] + parentLocalDelta[0],
      base.translate[1] + parentLocalDelta[1],
      base.translate[2] + parentLocalDelta[2],
    ],
    pivot2: [base.pivot2[0], base.pivot2[1]],
  };
  return { tx: { ops: [{ kind: 'setGroupTransform', id, before: node.transform, after }] } };
}

/**
 * Checks every projected world coordinate of the subtree after swapping in a new
 * `transform` (#37 B2).
 *
 * We want to project with a transform not yet written to the tree, so `transformChain(id)`
 * can't be used. The "relative chain from id downward" = `chain(id)^-1 * chain(descendant)`
 * is unaffected by the swap, so we re-apply it inside the new self chain as-is (same
 * construction as `subtreeLocalBounds`).
 */
function anyProjectedCellOutOfRange(doc: Document, id: string, parentId: string | null, after: GroupTransform): boolean {
  const newSelf = composeResolved(doc.tree.transformChain(parentId), composeTransform(after, IDENTITY_RESOLVED));
  const fromSelf = inverseResolved(doc.tree.transformChain(id));
  for (const owner of ownersOfSubtree(doc.tree, id)) {
    const chain = composeResolved(newSelf, composeResolved(fromSelf, doc.tree.transformChain(owner)));
    for (const [localKey] of doc.scene.cells.entriesOf(owner)) {
      const [x, y, z] = applyTransform(parseCellKey(localKey), chain);
      if (!isValidCell(x, y, z)) return true;
    }
  }
  return false;
}

/**
 * Rotates a group by 90-degree steps around the Y axis, about its pivot (#37 B2).
 *
 * Just adds to `angleSteps` — **pivot2 and translate are untouched**. Pivot follows the
 * contract "only decided at first creation or explicit reset" (rev.2 blocker (5)), so a
 * group with no transform set only now bases itself on `initialTransformOf` (derived
 * from subtree bounds), while an already-set group keeps its existing pivot even when
 * `angleSteps` is 0. Re-deriving from bounds on every rotation would mean an asymmetric
 * group rotated 4 times wouldn't return to its original position.
 *
 * Unlike translation, **rotation cannot be clamped** (the rotation amount is discrete,
 * so you can't trim off just the overflowing part). If even one cell ends up out of
 * range after projecting, the whole transaction is rejected.
 *
 * `quarterTurns` is relative to the top-down view (right=+X / up=-Z): 1 = counterclockwise,
 * 3 = clockwise. Same direction as the existing renderer's +Y rotation
 * (`rotateXZ` step 1 = (x,z)->(z,-x)).
 */
export function buildRotateGroup90(doc: Document, id: string, quarterTurns: 1 | 2 | 3): OpResult {
  const node = doc.tree.getNode(id);
  if (!node) return { error: 'groupNotFound' };
  if (doc.tree.isLockedEffective(id)) return { error: 'lockedGroupCannotRotate' };

  const base = node.transform ?? initialTransformOf(doc.scene, id);
  const after: GroupTransform = {
    angleSteps: ((base.angleSteps + quarterTurns) % 4) as AngleSteps,
    translate: [base.translate[0], base.translate[1], base.translate[2]],
    pivot2: [base.pivot2[0], base.pivot2[1]],
  };
  if (anyProjectedCellOutOfRange(doc, id, node.parentId, after)) {
    return { error: 'outOfRangeRotate' };
  }
  return { tx: { ops: [{ kind: 'setGroupTransform', id, before: node.transform, after }] } };
}

/**
 * Mirrors a selection across a world axis (#63).
 *
 * **Unlike rotation, this does not touch `GroupTransform`.** Mirroring is a
 * determinant -1 transform, which `GroupTransform` (Y-axis 90-degree rotation +
 * translation) can't represent, so it's implemented as a destructive op that
 * physically re-places cells. Making it non-destructive would require a new persistent
 * format (v3) and reworking `composeTransform`'s composition rules (mirroring and
 * rotation don't commute) — not worth it against the operational judgment that "mirroring
 * is decided in one shot, so there's little demand to undo it later" (decided in #63).
 *
 * The mirror plane is the **center of the selection's projected world bbox**. Since
 * this is a mapping within the bbox, the result always stays within the bbox and never
 * goes out of range (destinations are still validated explicitly, same as `buildMove`).
 *
 * Each ref moves within its own owner. Since the owner's effective transform is a
 * rotation, converting the world mirror into a per-cell world delta and passing it to
 * `movedRef` produces the correct mirror image even in local space. Orientation is
 * mirrored by applying `Document.mirrorWorldRaw` to the world-facing raw, then
 * converting back to owner-local (transforming only the coordinates and leaving raw
 * alone would make stairs fail to mirror correctly).
 */
export function buildMirror(doc: Document, sel: NormalizedSelection, axis: MirrorAxis): OpResult {
  if (sel.kind === 'none') return { error: 'noSelection' };
  const refs = resolveSelectionRefs(doc, sel);
  if (refs.length === 0) return { error: 'noSelection' };
  if (refs.length > OP_MAX_CELLS) {
    return { error: 'tooLargeToMirror', errorVars: { count: refs.length.toLocaleString(), max: OP_MAX_CELLS.toLocaleString() } };
  }
  // Partially mirroring while locked would break the shape, so if even one locked ref
  // is included, don't run at all (buildMove has a different policy — it's for nudging
  // and moves only what it can)
  if (refs.some((ref) => doc.tree.isLockedEffective(ref.ownerId))) {
    return { error: 'lockedInMirror' };
  }
  const bbox = worldBboxOfRefs(doc, refs);
  if (!bbox) return { error: 'noSelection' };

  const axisIndex = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  // world_dest[axisIndex] = (min + max) - world_src[axisIndex]
  const mirrorSum = bbox.min[axisIndex] + bbox.max[axisIndex];

  const moving = new Map<
    CellRefKey,
    { ref: CellRef; dest: CellRef; localRaw: number; paint: PatternPaint | null }
  >();
  // Detects the case where "mirroring doesn't change the final state" (a single full
  // block / a symmetric arrangement of the same raw). If we push an op, Document pushes
  // it to history, and Ctrl+Z would fire once for nothing even though nothing visibly
  // changed (#65 review P2)
  let changesAnything = false;
  for (const ref of refs) {
    const localRaw = doc.scene.cells.get(ref.ownerId, localKeyOf(ref));
    if (localRaw === undefined) continue;
    const world = doc.index.worldOf(ref);
    if (!world) continue;
    const delta: [number, number, number] = [0, 0, 0];
    delta[axisIndex] = mirrorSum - 2 * world[axisIndex];
    const mirroredWorldRaw = doc.mirrorWorldRaw(doc.worldRawOf(ref.ownerId, localRaw), axis);
    const key = makeCellRefKey(ref);
    const dest = movedRef(doc, ref, delta);
    const destLocalRaw = doc.localRawOf(ref.ownerId, mirroredWorldRaw);
    const sourcePaint = doc.scene.patterns?.get(ref.ownerId, localKeyOf(ref)) ?? null;
    const paint = sourcePaint
      ? {
          ...sourcePaint,
          sourceRaw: doc.localRawOf(
            ref.ownerId,
            doc.mirrorWorldRaw(doc.worldRawOf(ref.ownerId, sourcePaint.sourceRaw), axis),
          ),
          appliedRaw: doc.localRawOf(
            ref.ownerId,
            doc.mirrorWorldRaw(doc.worldRawOf(ref.ownerId, sourcePaint.appliedRaw), axis),
          ),
        }
      : null;
    // If only refs whose coordinates and raw both stay put are involved, this mirror
    // adds nothing to the final state. When coordinates do move, we don't go as far as
    // checking "is the raw at the swapped destination the same" per ref — looking at
    // each one individually would wrongly judge no-op just because "A's destination has
    // the same raw", so that's left to the set comparison below
    if (
      key !== makeCellRefKey(dest) ||
      destLocalRaw !== localRaw ||
      (sourcePaint !== null &&
        paint !== null &&
        (paint.sourceRaw !== sourcePaint.sourceRaw || paint.appliedRaw !== sourcePaint.appliedRaw))
    ) {
      changesAnything = true;
    }
    moving.set(key, { ref, dest, localRaw: destLocalRaw, paint });
  }
  if (moving.size === 0) return { error: 'noSelection' };

  // When coordinates move, we decide by whether the post-move (ref, raw) set matches
  // the original (a symmetric arrangement of the same raw ends up in the same final
  // state even after swapping)
  if (changesAnything) {
    const beforeState = new Map<CellRefKey, number>();
    for (const [key, { ref }] of moving) {
      const raw = doc.scene.cells.get(ref.ownerId, localKeyOf(ref));
      if (raw !== undefined) beforeState.set(key, raw);
    }
    const afterState = new Map<CellRefKey, number>(beforeState);
    for (const { ref } of moving.values()) afterState.delete(makeCellRefKey(ref));
    for (const { dest, localRaw } of moving.values()) afterState.set(makeCellRefKey(dest), localRaw);
    const sameState =
      afterState.size === beforeState.size &&
      [...afterState].every(([key, raw]) => beforeState.get(key) === raw);
    const beforePatterns = new Map<CellRefKey, PatternPaint>();
    for (const [key, { ref }] of moving) {
      const before = doc.scene.patterns?.get(ref.ownerId, localKeyOf(ref));
      if (before) beforePatterns.set(key, before);
    }
    const afterPatterns = new Map(beforePatterns);
    for (const key of moving.keys()) afterPatterns.delete(key);
    for (const { dest, paint } of moving.values()) {
      if (paint) afterPatterns.set(makeCellRefKey(dest), paint);
    }
    const samePaint = samePatternPaint;
    const samePatterns =
      afterPatterns.size === beforePatterns.size &&
      [...afterPatterns].every(([key, paint]) => {
        const before = beforePatterns.get(key);
        return before !== undefined && samePaint(before, paint);
      });
    // Only collapse to a no-op when both the voxel set and the binding set are identical.
    if (sameState && samePatterns) changesAnything = false;
  }
  // In a symmetric arrangement, individual refs do move (mapped 0<->2), but **the source
  // and dest ref sets are identical**, so the selection set is unchanged. So the
  // selection isn't broken even without returning a remap (#65 review finding)
  if (!changesAnything) return { tx: { ops: [] } };

  for (const { dest } of moving.values()) {
    const world = ownerToWorldCell(doc.tree, dest.ownerId, dest.localCell);
    if (!isValidCell(world[0], world[1], world[2])) return { error: 'outOfRangeMirror' };
  }

  const ops: DocOp[] = [];
  const remap = new Map<CellRefKey, CellRef | null>();
  const destKeys = new Set<CellRefKey>();
  for (const { ref, dest, localRaw } of moving.values()) {
    destKeys.add(makeCellRefKey(dest));
    ops.push(placeOp(doc, dest, localRaw));
    remap.set(makeCellRefKey(ref), dest);
  }
  // Mirroring is a bijection within the selection set, so an original cell overlapping a
  // destination is treated as "still occupied" and not erased (same as buildMove's
  // self-overlap handling)
  for (const [key, { ref }] of moving) {
    if (destKeys.has(key)) continue;
    ops.push(eraseOp(doc, ref));
  }
  // PatternPaintStore's normal remap can't transform raw orientation. So this is a
  // two-phase process — clear all sources first, then re-push at the destinations — so
  // that even a swap doesn't overwrite an in-flight binding. Document excludes an
  // explicit setPattern's source from auto-remap, so the old paint never overwrites the
  // transformed paint either (#66).
  for (const { ref, paint } of moving.values()) {
    if (!paint) continue;
    const key = localKeyOf(ref);
    ops.push({ kind: 'setPattern', owner: ref.ownerId, key, before: doc.scene.patterns?.get(ref.ownerId, key) ?? null, after: null });
  }
  for (const { dest, paint } of moving.values()) {
    if (!paint) continue;
    const key = localKeyOf(dest);
    ops.push({ kind: 'setPattern', owner: dest.ownerId, key, before: doc.scene.patterns?.get(dest.ownerId, key) ?? null, after: paint });
  }
  return { tx: { ops, remap } };
}

/** Candidate landing offsets for duplicate/paste (tries +X-adjacent first, in order, the first that fits within range) */
function findAdjacentOffset(bbox: { min: Cell; max: Cell }): [number, number, number] | null {
  const sx = bbox.max[0] - bbox.min[0] + 1;
  const sy = bbox.max[1] - bbox.min[1] + 1;
  const sz = bbox.max[2] - bbox.min[2] + 1;
  const candidates: [number, number, number][] = [[sx, 0, 0], [-sx, 0, 0], [0, 0, sz], [0, 0, -sz], [0, sy, 0]];
  for (const delta of candidates) {
    const okMin = isValidCell(bbox.min[0] + delta[0], bbox.min[1] + delta[1], bbox.min[2] + delta[2]);
    const okMax = isValidCell(bbox.max[0] + delta[0], bbox.max[1] + delta[1], bbox.max[2] + delta[2]);
    if (okMin && okMax) return delta;
  }
  return null;
}

/** Options for array duplication (#63). If omitted, falls back to the previous behavior: "one copy, adjacent" */
export interface DuplicateOptions {
  /**
   * World offset for one copy. The i-th copy is placed at `delta * i`.
   * If omitted, falls back to bbox-adjacent (tries +X first, in order, the first
   * candidate that fits within range).
   */
  delta?: [number, number, number];
  /** Number of copies (integer >= 1). Defaults to 1 */
  count?: number;
}

/**
 * Duplicates a selection (cells or groups). Defaults to "try candidate offsets from
 * +X-adjacent, in order, and place 1 copy".
 *
 * Passing `opts` produces an **evenly-spaced array duplication** (#63) — for lining up N
 * copies of the same shape in a fixed direction, like repeating columns or windows. The
 * i-th copy is placed at `delta * i`. Overlap with existing blocks is handled the same
 * way as the default single duplicate — an **overwrite** (`placeOp`) — not rejected up
 * front.
 *
 * For a groups selection, the subtree is deep-copied under new ids and inserted as a
 * sibling right after the original. **Cell local coordinates are duplicated as-is, and
 * the offset is loaded onto the translate of the duplicated topmost group** (#37 design:
 * the duplicate offset goes onto the top group's translate, converting world delta ->
 * parent-local). This way a duplicate of a rotated group doesn't lose its shape.
 */
export function buildDuplicate(doc: Document, sel: NormalizedSelection, opts: DuplicateOptions = {}): OpResult {
  if (sel.kind === 'none') return { error: 'noSelection' };
  const count = opts.count ?? 1;
  if (!Number.isInteger(count) || count < 1) return { error: 'duplicateCountInvalid' };
  const allRefs = resolveSelectionRefs(doc, sel);
  if (allRefs.length === 0) return { error: 'noSelection' };
  // Always guard here before building a large ops array (shared limit, #8 review
  // finding). For array duplication we check **the total multiplied by copy count** —
  // checking just one copy's worth and letting it through would mean building N times
  // the limit's worth of DocOps before rejecting when count is large
  const totalCells = allRefs.length * count;
  if (totalCells > OP_MAX_CELLS) {
    return { error: 'tooLargeAfterDuplicate', errorVars: { count: totalCells.toLocaleString(), max: OP_MAX_CELLS.toLocaleString() } };
  }
  const bbox = worldBboxOfRefs(doc, allRefs);
  if (!bbox) return { error: 'noSelection' };

  let delta: [number, number, number];
  if (opts.delta) {
    if (opts.delta[0] === 0 && opts.delta[1] === 0 && opts.delta[2] === 0) return { error: 'duplicateGapZero' };
    delta = opts.delta;
  } else {
    const adjacent = findAdjacentOffset(bbox);
    if (!adjacent) return { error: 'noRoomToDuplicate' };
    delta = adjacent;
  }

  // Confirm up front that every copy fits within range (don't leave things half-placed
  // on failure). The default path is already guaranteed for count=1 by
  // findAdjacentOffset, so this just passes through
  for (let i = 1; i <= count; i++) {
    const okMin = isValidCell(bbox.min[0] + delta[0] * i, bbox.min[1] + delta[1] * i, bbox.min[2] + delta[2] * i);
    const okMax = isValidCell(bbox.max[0] + delta[0] * i, bbox.max[1] + delta[1] * i, bbox.max[2] + delta[2] * i);
    if (!okMin || !okMax) return { error: 'outOfRangeDuplicate', errorVars: { count } };
  }

  const ops: DocOp[] = [];

  if (sel.kind === 'cells') {
    const newRefs: CellRef[] = [];
    for (let i = 1; i <= count; i++) {
      const copyDelta: [number, number, number] = [delta[0] * i, delta[1] * i, delta[2] * i];
      for (const ref of allRefs) {
        const value = doc.scene.cells.get(ref.ownerId, localKeyOf(ref));
        if (value === undefined) continue;
        const dest = movedRef(doc, ref, copyDelta);
        ops.push(placeOp(doc, dest, value));
        const sourceKey = localKeyOf(ref);
        const paint = doc.scene.patterns
          ? activePatternAt(doc.scene.patterns, doc.scene.cells, ref.ownerId, sourceKey)
          : null;
        if (paint) {
          ops.push({ kind: 'setPattern', owner: dest.ownerId, key: localKeyOf(dest), before: null, after: paint });
        }
        newRefs.push(dest);
      }
    }
    if (!newRefs.length) return { error: 'noSelection' };
    return { tx: { ops }, newSelectionRefs: newRefs };
  }

  // The insert index is based on **the sibling array at op-building time**, so selecting
  // multiple groups with the same parent shifts the reference for later ones by however
  // much was already inserted earlier, producing crossed-over results like
  // [A, A1, B1, B2, A2, B] (#67 review P1). **Processing in descending sibling-index
  // order** means inserting from the back, so earlier indices don't move. Ids with
  // different parents don't affect each other's sibling arrays, so one combined sort is
  // enough.
  const targets = sel.ids
    .map((id) => {
      const node = doc.tree.getNode(id);
      return node ? { id, node, siblingIndex: doc.tree.childrenOf(node.parentId).indexOf(id) } : null;
    })
    .filter((t): t is { id: string; node: ReadonlyGroupNode; siblingIndex: number } => t !== null)
    .sort((a, b) => b.siblingIndex - a.siblingIndex);

  // We want to return newSelection in **selection order**, so keep it indexable by the
  // original id, separately from the processing order (descending)
  const copiesBySource = new Map<string, string[]>();
  for (const { id, node, siblingIndex } of targets) {

    const cloneSubtree = (oldId: string, newParentId: string | null, index: number, transform: GroupTransform | undefined): string => {
      const oldNode = doc.tree.getNode(oldId)!;
      const newId = doc.nextGroupId();
      ops.push({
        kind: 'createGroup',
        node: {
          id: newId,
          name: oldNode.name,
          parentId: newParentId,
          childIds: [],
          ...(oldNode.hidden !== undefined ? { hidden: oldNode.hidden } : {}),
          ...(oldNode.locked !== undefined ? { locked: oldNode.locked } : {}),
          ...(oldNode.templateId !== undefined ? { templateId: oldNode.templateId } : {}),
          ...(transform !== undefined ? { transform } : {}),
        },
        index,
      });
      let childIndex = 0;
      for (const childId of doc.tree.childrenOf(oldId)) {
        cloneSubtree(childId, newId, childIndex++, doc.tree.getNode(childId)?.transform);
      }
      for (const [localKey, value] of doc.scene.cells.entriesOf(oldId)) {
        ops.push({ kind: 'voxel', owner: newId, key: localKey, before: null, after: value });
        const paint = doc.scene.patterns
          ? activePatternAt(doc.scene.patterns, doc.scene.cells, oldId, localKey)
          : null;
        if (paint) ops.push({ kind: 'setPattern', owner: newId, key: localKey, before: null, after: paint });
      }
      return newId;
    };

    const base = node.transform ?? initialTransformOf(doc.scene, id);
    const insertIndex = siblingIndex + 1;
    const copies: string[] = [];

    for (let i = 1; i <= count; i++) {
      // Load the offset onto the topmost clone's translate (convert to the parent's
      // coordinate system, then add)
      const parentLocalDelta = rotateDeltaToLocal(
        [delta[0] * i, delta[1] * i, delta[2] * i],
        doc.tree.transformChain(node.parentId),
      );
      const topTransform: GroupTransform = {
        angleSteps: base.angleSteps,
        translate: [
          base.translate[0] + parentLocalDelta[0],
          base.translate[1] + parentLocalDelta[1],
          base.translate[2] + parentLocalDelta[2],
        ],
        pivot2: [base.pivot2[0], base.pivot2[1]],
      };
      // The i-th copy is inserted i slots after the original -> after applying, sibling order is [original, copy1, copy2, ...]
      copies.push(cloneSubtree(id, node.parentId, insertIndex + (i - 1), topTransform));
    }
    copiesBySource.set(id, copies);
  }
  // Processing was in descending sibling-index order, so rebuild the returned selection back into the original selection order
  const newTopIds = sel.ids.flatMap((id) => copiesBySource.get(id) ?? []);
  if (!newTopIds.length) return { error: 'noSelection' };
  return { tx: { ops }, newSelection: { kind: 'groups', ids: newTopIds } };
}

/**
 * For drag-and-drop reordering: converts the apparent intent of "insert immediately
 * before/after the target" into the actual post-splice index. When moving within the
 * same array, the removal happens first, so this corrects for the source shifting up by
 * one when it sits before the insert position.
 */
/**
 * The drag target in the layers panel (#44). Since `Selection` is an exclusive union of
 * groups / cells, the drag target doesn't mix either (mixed selection itself is #43's
 * concern).
 */
export type DragPayload =
  | { kind: 'groups'; ids: readonly string[] }
  | { kind: 'cells'; refs: readonly CellRef[] };

/**
 * Decides the actual drag target from the grabbed row (#44).
 *
 * **If the grabbed row is part of the current selection, the whole selection; if not,
 * just that one row** — the Figma / file-explorer / Finder convention.
 *
 * When a row outside the selection is grabbed, **the UI side (mousedown in layers.ts)
 * also moves the selection to that row**, so "what was moved" and "the target of the
 * next Delete / Ctrl+D" always match. This function itself is pure and doesn't change
 * the selection, but note that using it standalone can make the two diverge (#44 review
 * P1).
 *
 * Since `sel` is expected to be a `NormalizedSelection`, the returned payload is
 * guaranteed to be outermost-only / no duplicates / excluding hidden and locked.
 */
export function dragPayloadFor(sel: NormalizedSelection, grabbed: DragPayload): DragPayload {
  if (grabbed.kind === 'groups') {
    const id = grabbed.ids[0];
    if (id === undefined || sel.kind !== 'groups' || !sel.ids.includes(id)) return grabbed;
    return { kind: 'groups', ids: [...sel.ids] };
  }
  const ref = grabbed.refs[0];
  if (ref === undefined || sel.kind !== 'cells' || !sel.cells.has(makeCellRefKey(ref))) return grabbed;
  return { kind: 'cells', refs: [...sel.cells.values()].map((c) => c.ref) };
}

export function computeDropIndex(
  siblingsBefore: readonly string[],
  draggedId: string,
  targetId: string,
  position: 'before' | 'after',
): number {
  return computeDropIndexFor(siblingsBefore, [draggedId], targetId, position);
}

/**
 * The multi-target version (#44). The returned value has the same meaning as
 * `buildReparentGroups`'s `startIndex` — **the insert position into the sibling array
 * with all move targets removed**.
 *
 * Just extends the single-target version's idea — "the position after removing the one
 * grabbed item" — to N items. Assumes the caller already rejects the case where
 * `targetId` itself is among the move targets (self-drop).
 */
export function computeDropIndexFor(
  siblingsBefore: readonly string[],
  draggedIds: readonly string[],
  targetId: string,
  position: 'before' | 'after',
): number {
  const moving = new Set(draggedIds);
  const stable = siblingsBefore.filter((id) => !moving.has(id));
  const targetIndex = stable.indexOf(targetId);
  if (targetIndex === -1) return stable.length; // If the target has disappeared, go to the end
  return position === 'before' ? targetIndex : targetIndex + 1;
}

/**
 * Reorders a group via drag-and-drop, or moves it to a different group (for the layers
 * panel). Rejects when newParentId is groupId itself or one of its descendants, since
 * that would be circular. A locked group itself, or a locked destination group, is
 * excluded from dragging.
 *
 * When the parent changes, `rebaseTransform` swaps in a new transform to **preserve the
 * world appearance** (leaving the transform as-is while the parent chain's effective
 * transform changes would teleport the subtree).
 */
export function buildReparentGroup(doc: Document, groupId: string, newParentId: string | null, newIndex: number): OpResult {
  return buildReparentGroups(doc, [groupId], newParentId, newIndex);
}

/**
 * Reparents multiple groups together (multi-drag in the layers panel, #44). The
 * single-target version is just a one-item call to this.
 *
 * **`startIndex` is the insert position into "the sibling array with all move targets
 * removed"** (the same meaning as the value `computeDropIndex` returns for the
 * single-target version). The move targets go in there **contiguously, in selection
 * order**.
 *
 * `afterIndex` is decided by simulating op-application order. Because
 * `SceneTree.reparent` "removes from the old parent, then inserts at afterIndex", it
 * passes through an in-between state where move targets not yet processed are still
 * sitting at the destination — naively assigning `startIndex + i` would get the order
 * wrong. Here, **the first non-target element that comes right after the move targets
 * is used as an anchor**, and each op's insert position is measured against it (when
 * there's no anchor — i.e. it lands at the end — it's appended).
 *
 * `beforeIndex` is filled with the live value as-is (it goes stale for the 2nd item
 * onward, but that's fine given Document's contract of normalizing it against the
 * measured value right before applying).
 *
 * Callers are expected to pass ids from a `NormalizedSelection` — outermost-only / no
 * duplicates / excluding hidden and locked are guaranteed by the type. The checks here
 * guard against paths that don't go through the store.
 */
export function buildReparentGroups(
  doc: Document,
  groupIds: readonly string[],
  newParentId: string | null,
  startIndex: number,
): OpResult {
  if (!groupIds.length) return { error: 'noGroupToMove' };

  const siblings = [...doc.tree.childrenOf(newParentId)];
  const moving = new Set(groupIds);
  // The ordering with move targets removed. startIndex is the insert position into this
  // array, so the first remaining element after that point is "the one that comes right
  // after the move targets" = the anchor for the insert position
  const stable = siblings.filter((id) => !moving.has(id));
  const at = Math.min(Math.max(startIndex, 0), stable.length);
  const anchorAfter = stable[at] ?? null;

  const sim = [...siblings];
  const ops: DocOp[] = [];
  let parentChanged = false;

  for (const groupId of groupIds) {
    const node = doc.tree.getNode(groupId);
    if (!node) return { error: 'groupNotFound' };
    if (doc.tree.isLockedEffective(groupId)) return { error: 'lockedGroupCannotMove' };
    if (newParentId !== null) {
      if (newParentId === groupId || doc.tree.isAncestor(groupId, newParentId)) {
        return { error: 'cannotMoveIntoSelf' };
      }
      if (doc.tree.isLockedEffective(newParentId)) return { error: 'cannotMoveIntoLocked' };
    }
    if (node.parentId !== newParentId) parentChanged = true;

    // Mirror the sibling array using the same steps as SceneTree.reparent (remove, then insert)
    const existing = sim.indexOf(groupId);
    if (existing !== -1) sim.splice(existing, 1);
    const anchorIndex = anchorAfter === null ? -1 : sim.indexOf(anchorAfter);
    const afterIndex = anchorIndex === -1 ? sim.length : anchorIndex;
    sim.splice(afterIndex, 0, groupId);

    ops.push({
      kind: 'reparentGroup',
      id: groupId,
      beforeParent: node.parentId,
      beforeIndex: doc.tree.childrenOf(node.parentId).indexOf(groupId),
      afterParent: newParentId,
      afterIndex,
    });
    const rebase = rebaseOpIfParentChainChanged(doc, groupId, newParentId);
    if (rebase) ops.push(rebase);
  }

  // Don't clutter history if neither parent nor order changes (same treatment as the single-target version's "dropping at the same position is a no-op")
  const orderUnchanged = sim.length === siblings.length && sim.every((id, i) => id === siblings[i]);
  if (!parentChanged && orderUnchanged) return { tx: { ops: [] } };
  return { tx: { ops } };
}

/**
 * Moves a cell to another group via drag-and-drop (for the layers panel; newGroupId=null
 * moves to unassigned=root). Cells have no concept of sibling order (a sparse set per
 * owner), so this is a membership change only, not a reorder.
 *
 * The membership change is represented as a pair — **erase from the old owner + place
 * into the new owner** (the membership op has been removed). Coordinates and raw are
 * converted to preserve world appearance, and it's rejected if the same local is already
 * occupied at the destination.
 */
export function buildMoveCellToGroup(doc: Document, ref: CellRef, newGroupId: string | null): OpResult {
  return buildMoveCellsToGroup(doc, [ref], newGroupId);
}

/**
 * Moves multiple cells to another group together (multi-drag in the layers panel, #44).
 * The single-target version is just a one-item call to this.
 *
 * **Pushes all erases before any place** (same reason as `buildGroup`'s cells branch) —
 * without checking collisions against the final state "after vacating the original
 * owner", a move within the same owner would collide with itself. If move targets end
 * up overlapping the same local at the destination, the whole thing is rejected
 * together.
 *
 * Cells already belonging to the destination are silently skipped (a no-op if all of
 * them are).
 */
export function buildMoveCellsToGroup(doc: Document, refs: readonly CellRef[], newGroupId: string | null): OpResult {
  if (!refs.length) return { error: 'noBlockToMove' };

  const erases: DocOp[] = [];
  const places: DocOp[] = [];
  const remap = new Map<CellRefKey, CellRef | null>();

  for (const ref of refs) {
    if (doc.tree.isLockedEffective(ref.ownerId)) return { error: 'lockedBlocksCannotMove' };
    if (newGroupId !== null && doc.tree.isLockedEffective(newGroupId)) {
      return { error: 'cannotMoveIntoLocked' };
    }
    if (ref.ownerId === newGroupId) continue;
    const retargeted = doc.retargetRef(ref, newGroupId);
    if (!retargeted) return { error: 'blockNotFound' };
    erases.push(eraseOp(doc, ref));
    places.push(placeOp(doc, retargeted.ref, retargeted.localRaw));
    remap.set(makeCellRefKey(ref), retargeted.ref);
  }
  if (!erases.length) return { tx: { ops: [] } };

  const ops: DocOp[] = [...erases, ...places];
  const collision = detectOwnerLocalCollision(doc, ops);
  if (collision) return { error: collision.key, errorVars: collision.vars };
  return { tx: { ops, remap } };
}

/**
 * Bulk-replaces used blocks / paints a pattern (#48).
 *
 * Replaces "cells whose catalogIndex is `from`" within `ownersInScope` with the block
 * `pick()` returns. For a bulk replace, `pick` returns a constant; for pattern painting,
 * it returns a draw from the mix recipe.
 *
 * **The draw happens exactly once, at the point the op is being built, and the result is
 * baked into the transaction as a concrete voxel op.** Undo/redo just replays that op, so
 * the result reproduces without Document needing to hold a seed (this is where the
 * determinism concern raised in the issue gets closed off).
 *
 * Orientation handling: **if the shape is the same, carry over the orientation code; if
 * the shape changes, fall back to the default orientation**. What a code means differs
 * per shape (full=axis / slab=top-or-bottom half / stairs=direction+flip), so carrying
 * it across shapes would turn it into a different orientation.
 *
 * Locked owners are excluded (consistent with existing protection). If the only targets
 * were locked, the function reports that specifically rather than "no targets" — silently
 * doing nothing leaves no way to know why.
 */
export function buildReplaceUsage(
  doc: Document,
  ownersInScope: Iterable<OwnerId>,
  from: number,
  pick: () => number | null,
  shapeOf: (catalogIndex: number) => Shape | undefined,
): OpResult {
  const ops: DocOp[] = [];
  const fromShape = shapeOf(from);
  let skippedLocked = 0;

  for (const owner of new Set(ownersInScope)) {
    // The inside of an instance is not editable (#69). Excluded the same way as locked —
    // even if fixed here, it would be overwritten once the component is edited
    if (doc.tree.isLockedEffective(owner) || doc.instanceRootOf(owner) !== null) {
      for (const [, raw] of doc.scene.cells.entriesOf(owner)) {
        if (unpackCell(raw).catalogIndex === from) skippedLocked++;
      }
      continue;
    }
    for (const [localKey, raw] of doc.scene.cells.entriesOf(owner)) {
      const { catalogIndex, code } = unpackCell(raw);
      if (catalogIndex !== from) continue;
      // In the "used blocks" list, live patterns are subtracted out of regular blocks
      // and shown as a separate row. Without excluding them here using the same
      // predicate, cells whose recipe includes the original block would get swept up
      // into a plain bulk change, and the binding would be lost too.
      if (doc.scene.patterns && activePatternAt(doc.scene.patterns, doc.scene.cells, owner, localKey)) continue;
      // **Bail out the moment the limit is exceeded** (#48 review P2). Building
      // everything and then discarding it would mean, for a work with 100k+ cells,
      // constructing the whole DocOp array before rejecting it. Also avoids spinning the
      // draw (pick) for nothing.
      if (ops.length > OP_MAX_CELLS) {
        return { error: 'tooManyTargets', errorVars: { max: OP_MAX_CELLS.toLocaleString() } };
      }
      const next = pick();
      if (next === null) continue;
      const nextShape = shapeOf(next);
      const nextCode = nextShape !== undefined && nextShape === fromShape ? code : defaultCode(nextShape ?? 'full');
      const after = packCell(next, nextCode);
      if (after === raw) continue;
      ops.push({ kind: 'voxel', owner, key: localKey, before: raw, after });
    }
  }

  if (ops.length > OP_MAX_CELLS) {
    return { error: 'tooManyTargets', errorVars: { max: OP_MAX_CELLS.toLocaleString() } };
  }
  if (!ops.length) {
    return { error: skippedLocked > 0 ? 'onlyLockedGroups' : 'noBlocksToReplace' };
  }
  return { tx: { ops } };
}

/**
 * Applies a "live pattern" to a used-block row. The concrete raw is placed into cells as
 * a fallback for when the recipe is missing, but since setPattern is pushed within the
 * same transaction, recipeId is preserved per cell across undo/redo and after saving.
 */
export function buildApplyPatternUsage(
  doc: Document,
  ownersInScope: Iterable<OwnerId>,
  from: number,
  recipe: MixRecipe,
  indexOf: (blockId: string) => number | undefined,
  shapeOf: (catalogIndex: number) => Shape | undefined,
): OpResult {
  const ops: DocOp[] = [];
  const fromShape = shapeOf(from);
  let targets = 0;
  let skippedLocked = 0;

  for (const owner of new Set(ownersInScope)) {
    // The inside of an instance is not editable (#69). Excluded the same way as locked —
    // even if fixed here, it would be overwritten once the component is edited
    if (doc.tree.isLockedEffective(owner) || doc.instanceRootOf(owner) !== null) {
      for (const [, raw] of doc.scene.cells.entriesOf(owner)) {
        if (unpackCell(raw).catalogIndex === from) skippedLocked++;
      }
      continue;
    }
    for (const [localKey, raw] of doc.scene.cells.entriesOf(owner)) {
      const { catalogIndex, code } = unpackCell(raw);
      if (catalogIndex !== from) continue;
      if (++targets > OP_MAX_CELLS) {
        return { error: 'tooManyTargets', errorVars: { max: OP_MAX_CELLS.toLocaleString() } };
      }
      // The pattern is decided by world coordinates (#69). Even with the same recipe, a different entry is drawn depending on where it's placed
      const worldCell = ownerToWorldCell(doc.tree, owner, parseCellKey(localKey));
      const next = samplePatternAt(recipe, worldCell, indexOf);
      if (next === null) continue;
      const nextShape = shapeOf(next);
      const nextCode = nextShape !== undefined && nextShape === fromShape ? code : defaultCode(nextShape ?? 'full');
      const after = packCell(next, nextCode);
      const paint: PatternPaint = {
        recipeId: recipe.id,
        variant: 0,
        sourceRaw: raw,
        appliedRaw: after,
      };
      if (after !== raw) ops.push({ kind: 'voxel', owner, key: localKey, before: raw, after });
      ops.push({
        kind: 'setPattern',
        owner,
        key: localKey,
        before: doc.scene.patterns?.get(owner, localKey) ?? null,
        after: paint,
      });
    }
  }

  if (!ops.length) {
    return { error: skippedLocked > 0 ? 'onlyLockedGroups' : 'noBlocksToReplace' };
  }
  return { tx: { ops } };
}

export function buildReplacePatternUsage(
  doc: Document,
  ownersInScope: Iterable<OwnerId>,
  recipeId: string,
  replacement: { kind: 'block'; catalogIndex: number } | { kind: 'pattern'; recipe: MixRecipe },
  indexOf: (blockId: string) => number | undefined,
  shapeOf: (catalogIndex: number) => Shape | undefined,
): OpResult {
  if (!doc.scene.patterns) return { error: 'noPatternData' };
  const ops: DocOp[] = [];
  let targets = 0;

  for (const owner of new Set(ownersInScope)) {
    if (doc.tree.isLockedEffective(owner) || doc.instanceRootOf(owner) !== null) continue; // Excluded inside an instance (#69)
    for (const [localKey, raw] of doc.scene.cells.entriesOf(owner)) {
      const paint = doc.scene.patterns.get(owner, localKey);
      if (!paint || paint.recipeId !== recipeId || paint.appliedRaw !== raw) continue;
      if (++targets > OP_MAX_CELLS) {
        return { error: 'tooManyTargets', errorVars: { max: OP_MAX_CELLS.toLocaleString() } };
      }
      const localCell = parseCellKey(localKey);
      const ref: CellRef = { ownerId: owner, localCell };
      const worldCell = ownerToWorldCell(doc.tree, owner, localCell);
      if (replacement.kind === 'pattern') {
        const sameRecipe = replacement.recipe.id === recipeId;
        // Only reapplying the same recipe draws a placement. When switching to a
        // different recipe, the variant number is carried over
        const variant = sameRecipe ? nextPatternVariant(paint.variant) : paint.variant;
        const sampledPaint: PatternPaint = {
          ...paint,
          recipeId: replacement.recipe.id,
          variant,
        };
        const appliedRaw = resolvePatternRaw(sampledPaint, worldCell, replacement.recipe, indexOf, shapeOf);
        const nextPaint: PatternPaint = { ...sampledPaint, appliedRaw };
        if (appliedRaw !== raw) {
          ops.push({ kind: 'voxel', owner, key: localKey, before: raw, after: appliedRaw });
        }
        ops.push({
          kind: 'setPattern',
          owner,
          key: localKey,
          before: paint,
          after: nextPaint,
        });
        continue;
      }
      // cells' raw is a save-time fallback. The actual displayed raw (after recipe
      // resolution + owner rotation) has WorldIndex as the source of truth, so the
      // currently visible orientation is carried over from there.
      const world = doc.index.worldOf(ref);
      const resolved = world
        ? doc.index.stackAt(world).find((entry) =>
            entry.ref.ownerId === owner &&
            entry.ref.localCell[0] === ref.localCell[0] &&
            entry.ref.localCell[1] === ref.localCell[1] &&
            entry.ref.localCell[2] === ref.localCell[2]
          )?.raw
        : undefined;
      const source = unpackCell(resolved ?? ownerToWorldRaw(doc.tree, owner, raw, shapeOf));
      const nextShape = shapeOf(replacement.catalogIndex);
      const code = nextShape === shapeOf(source.catalogIndex) ? source.code : defaultCode(nextShape ?? 'full');
      const after = worldToOwnerRaw(
        doc.tree,
        owner,
        packCell(replacement.catalogIndex, code),
        shapeOf,
      );
      if (after !== raw) ops.push({ kind: 'voxel', owner, key: localKey, before: raw, after });
      ops.push({ kind: 'setPattern', owner, key: localKey, before: paint, after: null });
    }
  }

  if (!ops.length) return { error: 'noPatternPaintToChange' };
  return { tx: { ops } };
}

/**
 * Repaints a selection range (#64 PR-C).
 *
 * The existing `buildReplaceUsage` can only scope to **"per group" x "cells whose block
 * type matches from"**. It can't drag-select part of a wall and change just that part's
 * finish (only a whole group or a whole block type). This fills that granularity gap.
 *
 * There are only 3 differences; the replacement semantics (orientation carry-over /
 * limit / lock protection) stay consistent with the existing behavior:
 *
 * 1. **Scope is a selection (cells / groups)** — the caller turns it into a ref list via
 *    `resolveSelectionRefs`
 * 2. **Filter by type, or don't** — if `from: null`, everything within the selection is
 *    a target
 * 3. **Both a single block and a mix recipe** — branches on `replacement`, wiring up the
 *    binding the same way as `buildApplyPatternUsage`
 *
 * Rewiring the binding **is pushed into the same transaction** (consistent with the live
 * pattern behavior since #60). If the binding isn't stripped when repainting to a single
 * block, a live recipe would later repaint over it and "the block you just changed
 * reverts back".
 *
 * Orientation handling: carries over the orientation code if the shape is the same,
 * falls back to the default orientation if the shape changes (same reason as
 * `buildReplaceUsage` — what a code means differs per shape).
 */
export function buildReplaceSelection(
  doc: Document,
  refs: Iterable<CellRef>,
  options: {
    /** The block type to filter by. If null, everything within the selection */
    readonly from: number | null;
    readonly replacement: { kind: 'block'; catalogIndex: number } | { kind: 'pattern'; recipe: MixRecipe };
    readonly indexOf: (blockId: string) => number | undefined;
    readonly shapeOf: (catalogIndex: number) => Shape | undefined;
  },
): OpResult {
  const { from, replacement, indexOf, shapeOf } = options;
  const ops: DocOp[] = [];
  let targets = 0;
  let skippedLocked = 0;
  // Process the same cell only once even if it comes up twice (dedup for a selection mixing groups and cells)
  const seen = new Set<CellRefKey>();

  for (const ref of refs) {
    const refKey = makeCellRefKey(ref);
    if (seen.has(refKey)) continue;
    seen.add(refKey);

    const owner = ref.ownerId;
    const localKey = localKeyOf(ref);
    const stored = doc.scene.cells.get(owner, localKey);
    if (stored === undefined) continue;
    // **For a cell with a live pattern, cells' raw is a save-time fallback** and isn't
    // rewritten when the recipe ratio is edited. Type detection, shape, and orientation
    // carry-over are all taken from "the raw currently in use for display" (#64 PR-C
    // review). Writes still go to owner-local, so the coordinate system stays consistent
    const raw = doc.currentLocalRaw(ref) ?? stored;
    const { catalogIndex, code } = unpackCell(raw);
    if (from !== null && catalogIndex !== from) continue;
    // The inside of an instance is not editable (#69). Excluded the same way as locked —
    // even if fixed here, it would be overwritten once the component is edited
    if (doc.tree.isLockedEffective(owner) || doc.instanceRootOf(owner) !== null) {
      skippedLocked++;
      continue;
    }
    // Bail out the moment the limit is exceeded (don't build everything and discard, same reason as #48)
    if (++targets > OP_MAX_CELLS) {
      return { error: 'tooManyTargets', errorVars: { max: OP_MAX_CELLS.toLocaleString() } };
    }

    const fromShape = shapeOf(catalogIndex);
    const beforePaint = doc.scene.patterns?.get(owner, localKey) ?? null;

    if (replacement.kind === 'pattern') {
      // The pattern is decided by world coordinates (#69)
      const worldCell = ownerToWorldCell(doc.tree, owner, ref.localCell);
      const next = samplePatternAt(replacement.recipe, worldCell, indexOf);
      if (next === null) continue;
      const nextShape = shapeOf(next);
      const nextCode = nextShape !== undefined && nextShape === fromShape ? code : defaultCode(nextShape ?? 'full');
      const after = packCell(next, nextCode);
      const paint: PatternPaint = {
        recipeId: replacement.recipe.id,
        variant: 0,
        // sourceRaw is **the source of truth for orientation before the pattern was
        // applied**. For a cell that already has a binding, stored is the current
        // appliedRaw (a save-time fallback), so overwriting it would lose the original
        // orientation (e.g. east-facing stairs -> full via pattern A -> switch to
        // pattern B -> editing B's recipe to stairs would fail to restore the east
        // orientation). This keeps the same contract as `buildReplacePatternUsage`'s
        // pattern -> pattern path, which spreads the existing paint to preserve
        // sourceRaw
        sourceRaw: beforePaint?.sourceRaw ?? stored,
        appliedRaw: after,
      };
      if (after !== stored) ops.push({ kind: 'voxel', owner, key: localKey, before: stored, after });
      ops.push({ kind: 'setPattern', owner, key: localKey, before: beforePaint, after: paint });
      continue;
    }

    const nextShape = shapeOf(replacement.catalogIndex);
    const nextCode = nextShape !== undefined && nextShape === fromShape ? code : defaultCode(nextShape ?? 'full');
    const after = packCell(replacement.catalogIndex, nextCode);
    if (after !== stored) ops.push({ kind: 'voxel', owner, key: localKey, before: stored, after });
    // If a live binding remains, the recipe side would later repaint and roll the change back
    if (beforePaint) ops.push({ kind: 'setPattern', owner, key: localKey, before: beforePaint, after: null });
  }

  if (!ops.length) {
    return { error: skippedLocked > 0 ? 'onlyLockedGroups' : 'noBlocksToReplace' };
  }
  return { tx: { ops } };
}
