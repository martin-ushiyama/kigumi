import { makeCellKey, parseCellKey, type Cell, type CellKey } from './cell';
import { makeCellRefKey, parseCellRefKey, type CellRef, type CellRefKey, type CellRefRemap, type OwnerId } from './cellref';
import { cloneComponent, type ComponentTemplate } from './component';
import { createEmitter, type Unsubscribe } from './emitter';
import { isValidCell } from './limits';
import type { Shape } from './orientation';
import { clonePatternPaint, samePatternPaint, type PatternPaint } from './patternpaint';
import {
  directCellCount,
  localKeyOf,
  ownerToWorldCell,
  ownerToWorldRaw,
  worldDeltaToOwnerDelta,
  worldToOwnerCell,
  worldToOwnerRaw,
} from './ownerlocal';
import type { EditorScene, EditorSceneReader } from './ownervoxels';
import { assertValidRuntimeScene, type LocalRawResolver } from './sceneprojection';
import type { GroupNode, ReadonlyGroupNode, SceneTreeReader } from './scenetree';
import { cloneTransform, mirrorRaw, type GroupTransform, type MirrorAxis } from './transform';
import { WorldIndex, type OwnerVoxelChange, type WorldIndexReader } from './worldindex';

/**
 * Document change notification event kinds (#13).
 *
 * As of #37 B1b, subscribers to this event are limited to **autosave / UI (layers, inspector, status)**.
 * The sole source of mesh updates is `WorldIndexChange`, and the source of selection re-projection is
 * `SceneBatchChange` — both are notified from the WorldIndex side (structurally prevents double rebuilds
 * and missed preview follow-ups, design rev.7).
 *
 * `voxelOnly` indicates "whether this transaction consists only of voxel ops." It's no longer used for
 * mesh rebuild decisions, but kept as information for the UI side to cheaply know "did structure change?"
 */
export type DocumentChange =
  | { kind: 'edit'; voxelOnly: boolean } // applyTransaction / commitStaged
  | { kind: 'undo'; voxelOnly: boolean }
  | { kind: 'redo'; voxelOnly: boolean }
  | { kind: 'replaceAll' }
  | { kind: 'clear' };

function isVoxelOnly(ops: readonly DocOp[]): boolean {
  return ops.every((op) => op.kind === 'voxel');
}

/**
 * The smallest unit of an edit operation.
 *
 * `voxel` is **owner-local** (#37 B1b): "which local cell of which owner, set to which value."
 * The old `{ kind:'voxel'; edit: Edit }`, which was keyed on world coordinates, couldn't represent
 * overlaps where multiple owners project onto the same world coordinate — a winner swap would cause
 * the op's target to silently switch to a different owner.
 *
 * `membership` was **removed**. Ownership changes are expressed as a pair of voxel ops — "erase from
 * the old owner + place into the new owner." In the owner-local model, "which owner holds the cell"
 * *is* the ownership itself, so keeping it as a separate op would split the source of truth.
 */
export type DocOp =
  | { kind: 'voxel'; owner: OwnerId; key: CellKey; before: number | null; after: number | null }
  | { kind: 'setPattern'; owner: OwnerId; key: CellKey; before: PatternPaint | null; after: PatternPaint | null }
  | { kind: 'createGroup'; node: GroupNode; index: number } // childIds must be [] on creation
  | { kind: 'deleteGroup'; node: GroupNode; index: number } // direct cell count and child count must both be 0 when applied
  | { kind: 'renameGroup'; id: string; before: string; after: string }
  | { kind: 'setGroupHidden'; id: string; before: boolean; after: boolean }
  | { kind: 'setGroupLocked'; id: string; before: boolean; after: boolean }
  /** Marks that this group is a component instance (#69). `null` = plain group */
  | { kind: 'setGroupTemplateId'; id: string; before: string | null; after: string | null }
  /**
   * Sets a group's transform (#37 B1b). `undefined` means "transform not set" — the v2 migration
   * omits the transform under the contract "initialize the pivot from the bounds center on first
   * rotation," so undoing the first transform assignment must restore the unset state rather than
   * identity (replacing with identity would bake in pivot=[0,0], making the next rotation pivot
   * around the origin).
   */
  | { kind: 'setGroupTransform'; id: string; before: GroupTransform | undefined; after: GroupTransform | undefined }
  /**
   * Replacing the component definition itself (#69 / #142 review P1).
   *
   * **Must go in the same transaction as the op that aligns instances.** If the definition (the
   * library entry) and the entities (instances within the artwork) live in separate history entries,
   * undoing one but not the other leaves instances sharing an id but differing in shape.
   * `null` = not present in the library.
   */
  | { kind: 'setComponentTemplate'; id: string; before: ComponentTemplate | null; after: ComponentTemplate | null }
  | {
      kind: 'reparentGroup';
      id: string;
      beforeParent: string | null;
      beforeIndex: number;
      afterParent: string | null;
      afterIndex: number;
    };

/**
 * Port to the component library (owned by the account side) (#69 / #142 review P1).
 *
 * Document does not hold the library itself — the library belongs to the user, not the artwork,
 * so ownership stays with the app side (`ComponentStore`). Only the **writes that need to go into
 * history** are routed through here.
 */
export interface ComponentLibraryPort {
  get(id: string): ComponentTemplate | undefined;
  /** Passing `null` removes it from the library */
  set(id: string, template: ComponentTemplate | null): void;
}

export interface Transaction {
  ops: DocOp[];
  /**
   * Ref mapping applied to the selection, only on success (#37 design rev.5). Physical moves
   * (nudge / drag / cross-owner move / group / ungroup) change the ref itself, so merely "dropping
   * the vanished ref" would deselect right after commit. Undo notifies with the inverse mapping,
   * redo notifies with this mapping as-is.
   */
  remap?: CellRefRemap;
}

/**
 * DocOp minus voxel. Only this type can be passed to EditSession.commit()'s extraOps —
 * the voxel diff is territory that EditSession itself computes from the baseline, and if the
 * caller sneaks a voxel op in via extraOps, commitStaged won't forward-apply voxel ops (it
 * assumes they're already staged), producing an op that's "recorded in undo history but never
 * reflected in the scene" — which then suddenly materializes an unapplied change the moment
 * redo runs (#22 review finding). Disallow this at the type level.
 */
/** Marker returned by `openHistorySession`. Pass it back unchanged when closing. */
export interface HistorySessionMark {
  /** Rewind to this point when closing (the depth before the entered operation) */
  readonly rollbackTo: number;
  /** The floor before entering (lets nested opens restore correctly) */
  readonly previousFloor: number;
}

export type NonVoxelDocOp = Exclude<DocOp, { kind: 'voxel' } | { kind: 'setPattern' }>;

/**
 * Input expressing edit intent in **world coordinates** (#37 design rev.3).
 *
 * The old `Edit` type carried `before`, but that was the WorldIndex visible-winner value, not
 * "the current value of the write-target ref." When the placement target is a different owner
 * than the winner (placing into A while B is the winner), the baseline gets contaminated with B's
 * value, causing cancel/undo to write B's value back into A. **`before` was removed from the type;
 * Document must always measure it live against the resolved ref.**
 *
 * The placement owner is not part of the intent — it's session-scoped (fixed at `beginSession`
 * time), which encodes in the type the intent that "even if the active group changes mid-stroke,
 * one session stays consistent with one owner."
 *
 * `overwrite` expresses "replace only the type/orientation of an already-existing block" (Fill
 * tool overwrite, inspector type change). It's kept separate from `place` because overwriting
 * must **preserve the winner's owner** (ownership must not silently shift to the active group) —
 * expressing it as an erase+place pair would move ownership.
 */
export type WorldEditIntent =
  | { kind: 'place'; worldCell: Cell; afterWorldRaw: number }
  | { kind: 'erase'; worldCell: Cell }
  | { kind: 'overwrite'; worldCell: Cell; afterWorldRaw: number };

/** Baseline for one ref touched by a session (measured owner-local value; `null` = was empty) */
export interface SessionBaseline {
  readonly ref: CellRef;
  readonly before: number | null;
}

/**
 * Session that governs pre-commit preview edits such as dragging and continuous placement.
 * The stage family only reflects into scene + WorldIndex immediately (not subject to undo/autosave).
 * commit() finalizes the "diff against the true value at session start (baseline)" as a single
 * Transaction; cancel() restores to baseline and discards it (#11).
 *
 * After either commit or cancel is called, the session becomes closed and further calls are
 * ignored (so that a delayed pointercancel after pointerup can double-terminate safely).
 */
export interface EditSession {
  /** Immediate preview of a place/erase/overwrite stroke. The first time a ref is touched, its current value is recorded as the baseline */
  stagePreview(intents: readonly WorldEditIntent[]): void;
  /**
   * Preview of a physical cell move (drag move). Shifts each ref by worldDelta **within its own
   * owner** (raw is unchanged, ownership is unchanged). Rebuilt from baseline every time, so the
   * state stays correct — including self-overlaps — whenever the offset changes. Returns the
   * old-ref → new-ref mapping.
   */
  stageMoveRefs(refs: readonly CellRef[], worldDelta: Cell): CellRefRemap;
  /** The baseline of every ref the session has touched so far. Empty after commit/cancel */
  baselineEntries(): IterableIterator<[CellRefKey, SessionBaseline]>;
  /** Commits the diff against baseline, together with extraOps, as a single Transaction. Does nothing if there's no diff (doesn't pollute undo history) */
  commit(extraOps?: NonVoxelDocOp[]): void;
  /** Restores to baseline and discards (scene/index match the pre-session state, nothing left in undo history) */
  cancel(): void;
}

function cloneGroupNode(node: GroupNode): GroupNode {
  // Deep-clone transform too, just like childIds — if the transform contents (translate / pivot2
  // arrays) could be rewritten via an alias left with the caller, the node snapshot pushed onto
  // the undo stack would change along with it (#37 B1b: plugs the gap where only childIds was cloned)
  return {
    ...node,
    childIds: [...node.childIds],
    ...(node.transform !== undefined ? { transform: cloneTransform(node.transform) } : {}),
  };
}

/** Builds a mutable GroupNode from a ReadonlyGroupNode (the tree's read type) (for snapshot / replaceAll) */
function toOwnedGroupNode(node: ReadonlyGroupNode): GroupNode {
  return {
    id: node.id,
    name: node.name,
    parentId: node.parentId,
    childIds: [...node.childIds],
    ...(node.hidden !== undefined ? { hidden: node.hidden } : {}),
    ...(node.locked !== undefined ? { locked: node.locked } : {}),
    ...(node.templateId !== undefined ? { templateId: node.templateId } : {}),
    ...(node.transform !== undefined ? { transform: cloneTransform(node.transform) } : {}),
  };
}

/**
 * Clones so that DocOp doesn't hold onto a caller-owned object directly. If an alias left with the
 * caller is rewritten later, the Transaction pushed onto the undo stack would change along with it,
 * creating a loophole where undo→redo revives the post-rewrite value (#19 review finding). voxel /
 * renameGroup / setGroupHidden / setGroupLocked / reparentGroup have only primitive fields so no
 * nested cloning is needed, but the reference to the op object itself must still be severed here.
 */
function cloneOp(op: DocOp): DocOp {
  switch (op.kind) {
    case 'setComponentTemplate':
      return {
        kind: 'setComponentTemplate',
        id: op.id,
        before: op.before === null ? null : cloneComponent(op.before),
        after: op.after === null ? null : cloneComponent(op.after),
      };
    case 'createGroup':
      return { kind: 'createGroup', node: cloneGroupNode(op.node), index: op.index };
    case 'deleteGroup':
      return { kind: 'deleteGroup', node: cloneGroupNode(op.node), index: op.index };
    case 'setGroupTransform':
      return {
        kind: 'setGroupTransform',
        id: op.id,
        before: op.before === undefined ? undefined : cloneTransform(op.before),
        after: op.after === undefined ? undefined : cloneTransform(op.after),
      };
    case 'setPattern':
      return {
        kind: 'setPattern',
        owner: op.owner,
        key: op.key,
        before: op.before === null ? null : clonePatternPaint(op.before),
        after: op.after === null ? null : clonePatternPaint(op.after),
      };
    default:
      return { ...op };
  }
}

/** Called at the entry point of applyTransaction/commitStaged — the Transaction Document retains from here on is independent of the caller's */
function cloneTransaction(tx: Transaction): Transaction {
  return { ops: tx.ops.map(cloneOp), ...(tx.remap ? { remap: new Map(tx.remap) } : {}) };
}

/** Inverts an old→new mapping into new→old (so undo can restore the selection to the move origin) */
function invertRemap(remap: CellRefRemap): CellRefRemap {
  const inverse = new Map<CellRefKey, CellRef | null>();
  for (const [oldKey, newRef] of remap) {
    // Deletions (newRef === null) can't be inverted — undo brings the cell back, but the
    // selection pointing to it was already cleared at delete time. Trying to revive it here
    // would create the inconsistency of "the deleted thing stays selected," so we don't.
    if (newRef !== null) inverse.set(makeCellRefKey(newRef), parseCellRefKey(oldKey));
  }
  return inverse;
}

/**
 * Facade governing the undo/redo history plus the edit model (EditorScene).
 *
 * As of #37 B1b, **the source of truth was moved to EditorScene (owner-local), and VoxelWorld was
 * removed from the runtime.** What renderer / picking read is the derived read-model `WorldIndex`
 * (one-way derivation, zero dual truth). `get world()` returns a `WorldIndexReader`, which is
 * compatible with `WorldReader`, so existing read paths can be swapped in as-is.
 *
 * Scene/tree mutation methods are restricted to going through Document only (#10). Public types
 * are limited to `EditorSceneReader` / `SceneTreeReader` / `WorldIndexReader` (read-only); the
 * concrete types are protected — production code cannot call write methods at the type level.
 * Only test setup — via DocumentFixture (a Document subclass) in tests/helpers/document-fixture.ts —
 * accesses the protected fields directly for low-level construction.
 */
export class Document {
  protected readonly _scene: EditorScene;
  protected readonly _index: WorldIndex;
  private readonly _resolveLocalRaw: LocalRawResolver;
  private undoStack: Transaction[] = [];
  private redoStack: Transaction[] = [];
  private readonly emitter = createEmitter<DocumentChange>();

  constructor(
    scene: EditorScene,
    protected readonly shapeOf: (catalogIndex: number) => Shape | undefined,
    resolveLocalRaw: LocalRawResolver = (_ref, raw) => raw,
    /**
     * Port to the component library (owned by the account side) (#69 / #142 review P1).
     *
     * Serves two roles.
     *
     * - **Determines whether a mark is alive**: `templateId` is a weak reference — if it's not in
     *   the library, treat it as a plain group (same as a paint reverting to its plain look when
     *   the recipe it pointed to is deleted). Treating an empty mark as an instance would make
     *   that group permanently uneditable.
     * - **Puts definition replacement into history**: the `setComponentTemplate` op writes here.
     *   If the definition and the entities live in separate histories, undo could revert only one,
     *   splitting the shape.
     *
     * When omitted, it means "no library" — marks are always treated as alive (doesn't change
     * load / test behavior), and definition replacement is a no-op.
     */
    private readonly components?: ComponentLibraryPort,
  ) {
    this._scene = scene;
    this._resolveLocalRaw = resolveLocalRaw;
    // Run the initial scene through the runtime invariants too (don't create an entry point where a broken scene could be "read" successfully)
    assertValidRuntimeScene(scene, shapeOf);
    this._index = WorldIndex.fromScene(scene, shapeOf, resolveLocalRaw);
  }

  /**
   * The **owner-local raw currently used for display** of a ref (#64 PR-C review).
   *
   * For live pattern (recipe reference) cells, `scene.cells`'s raw is the **fallback for saving**
   * and doesn't get rewritten when the ratio is edited (`refreshDerived()` only rebuilds the
   * projection). Taking the type judgment / shape / orientation carry-over from that fallback
   * would **target a different type than what's shown on screen**.
   *
   * Owner rotation is layered on at the projection side, so what this returns is pre-rotation —
   * the same coordinate system as writes. Undefined if the cell doesn't exist.
   */
  currentLocalRaw(ref: CellRef): number | undefined {
    const raw = this._scene.cells.get(ref.ownerId, makeCellKey(ref.localCell[0], ref.localCell[1], ref.localCell[2]));
    if (raw === undefined) return undefined;
    return this._resolveLocalRaw(ref, raw, ownerToWorldCell(this._scene.tree, ref.ownerId, ref.localCell));
  }

  /** The derived read-model compatible with WorldReader. renderer / picking / bounds calculations read this */
  get world(): WorldIndexReader {
    return this._index;
  }

  /** Same instance as `world`. Use this when the caller wants to make explicit the intent "I'm subscribing to the derived index" */
  get index(): WorldIndexReader {
    return this._index;
  }

  get tree(): SceneTreeReader {
    return this._scene.tree;
  }

  /** Read access to the owner-local edit model (needed for ops to build ops / for persistence to serialize) */
  get scene(): EditorSceneReader {
    return this._scene;
  }

  /** Re-projects the read-model after a change to derived values that don't move cell coordinates, such as recipes. Doesn't pollute history. */
  refreshDerived(): void {
    this._index.rebuildFromScene(this._scene);
  }

  /** Group ID issuance (consolidates the idCounter++ side effect through Document) */
  nextGroupId(): string {
    return this._scene.tree.nextId();
  }

  /**
   * #13: Supports multiple subscribers, returns an unsubscribe. Listeners are called in isolation
   * — one throwing doesn't affect other listeners or the caller (transaction success/failure)
   * (#22 3rd-round review finding: there was an incident where a notify failure was mistaken for
   * a transaction failure — state/history had already committed, but it looked like a failure to
   * the caller. "Did the notification to observers succeed" and "did the operation itself succeed"
   * are independent concerns; see createEmitter).
   */
  subscribe(fn: (event: DocumentChange) => void): Unsubscribe {
    return this.emitter.subscribe(fn);
  }

  private notify(change: DocumentChange): void {
    this.emitter.notify(change);
  }

  // ---- target resolution (#37 design rev.2 blocker ② + rev.3 blocker ②) ----
  //
  // A single resolution function that "always targets the winner if there is one" has a flaw
  // where the meaning of ownership changes based on visibility alone. Split into 3 by operation intent.

  /** Erase target: the visible winner's ref. `null` if locked (including ancestor lock) — protected from deletion */
  resolveEraseTarget(worldCell: Cell): CellRef | null {
    const winner = this._index.winnerRefAt(worldCell);
    if (!winner) return null;
    if (this._scene.tree.isLockedEffective(winner.ref.ownerId)) return null;
    return winner.ref;
  }

  /** Pick (eyedropper) target: the visible winner's ref and its raw **in world orientation** (already projected — picks up the world orientation) */
  resolvePickTarget(worldCell: Cell): { ref: CellRef; worldRaw: number } | null {
    const winner = this._index.winnerRefAt(worldCell);
    return winner ? { ref: winner.ref, worldRaw: winner.raw } : null;
  }

  /**
   * Placement target: falls onto the **placement owner** regardless of whether a winner exists.
   * Both the coordinates and the raw are converted to owner-local — if only the coordinates are
   * inverse-transformed while raw is kept in world orientation, WorldIndex reapplies the owner's
   * angle at projection time and stairs/pillars end up rotated away from what the user specified
   * (design rev.3 finding).
   */
  resolvePlacementTarget(worldCell: Cell, worldRaw: number, owner: OwnerId): { ref: CellRef; localRaw: number } {
    return {
      ref: { ownerId: owner, localCell: worldToOwnerCell(this._scene.tree, owner, worldCell) },
      localRaw: worldToOwnerRaw(this._scene.tree, owner, worldRaw, this.shapeOf),
    };
  }

  /**
   * The (new ref, new local raw) for **moving a ref to a different owner**.
   * The single shared transformation implementation for cross-owner move / grouping / ungrouping /
   * paste (design rev.3). Transforms both the coordinates and the raw so the world-space appearance
   * (position and orientation) is preserved. Returns null if the source ref has no cell.
   */
  retargetRef(ref: CellRef, toOwner: OwnerId): { ref: CellRef; localRaw: number } | null {
    const localRaw = this._scene.cells.get(ref.ownerId, localKeyOf(ref));
    if (localRaw === undefined) return null;
    const worldCell = ownerToWorldCell(this._scene.tree, ref.ownerId, ref.localCell);
    const worldRaw = ownerToWorldRaw(this._scene.tree, ref.ownerId, localRaw, this.shapeOf);
    return {
      ref: { ownerId: toOwner, localCell: worldToOwnerCell(this._scene.tree, toOwner, worldCell) },
      localRaw: worldToOwnerRaw(this._scene.tree, toOwner, worldRaw, this.shapeOf),
    };
  }

  /** World-oriented raw → owner-local-oriented raw (when replacing only type/orientation without moving the ref) */
  localRawOf(owner: OwnerId, worldRaw: number): number {
    return worldToOwnerRaw(this._scene.tree, owner, worldRaw, this.shapeOf);
  }

  /** Owner-local-oriented raw → world-oriented raw (for showing the UI "the current orientation") */
  worldRawOf(owner: OwnerId, localRaw: number): number {
    return ownerToWorldRaw(this._scene.tree, owner, localRaw, this.shapeOf);
  }

  /**
   * The world-oriented raw obtained by mirroring a world-oriented raw across a world axis (#63).
   * Since `shapeOf` is held protected by Document, this is the sole entry point here too, same as
   * `localRawOf` / `worldRawOf` (so the editor layer never pulls from the catalog directly).
   */
  mirrorWorldRaw(worldRaw: number, axis: MirrorAxis): number {
    return mirrorRaw(worldRaw, axis, this.shapeOf);
  }

  /** Overwrite target: replaces the raw while keeping the visible winner's ref. `null` if locked */
  resolveOverwriteTarget(worldCell: Cell, worldRaw: number): { ref: CellRef; localRaw: number } | null {
    const winner = this._index.winnerRefAt(worldCell);
    if (!winner) return null;
    if (this._scene.tree.isLockedEffective(winner.ref.ownerId)) return null;
    return {
      ref: winner.ref,
      localRaw: worldToOwnerRaw(this._scene.tree, winner.ref.ownerId, worldRaw, this.shapeOf),
    };
  }

  /**
   * Whether the given owner is inside a component instance (#69).
   *
   * **The contents of an instance are not editable.** Even if fixed, it gets overwritten the
   * moment the component is edited (the propagated version wins), so touching it produces an edit
   * that "works but doesn't stick." Just like locked cells, silently exclude it from the target.
   */
  private isInsideInstance(owner: OwnerId): boolean {
    return this.instanceRootOf(owner) !== null;
  }

  /**
   * The id of the nearest **live** instance among self or ancestors.
   *
   * Marks of components that were removed from the library don't count (see `isLiveTemplate`)
   */
  instanceRootOf(id: string | null): string | null {
    return this._scene.tree.instanceRootOf(id, (templateId) => this.isLiveTemplate(templateId));
  }

  /** Whether the component with that id is still alive in the library. Always true for a Document with no library */
  private isLiveTemplate(templateId: string): boolean {
    return this.components === undefined || this.components.get(templateId) !== undefined;
  }

  /**
   * The id of the **live** component that group points to (null if none).
   *
   * The "is this an instance" judgment always goes through here — looking only at whether the
   * mark exists would also pick up marks left over after removal from the library.
   */
  templateIdOf(id: string): string | null {
    const templateId = this._scene.tree.getNode(id)?.templateId;
    return templateId != null && this.isLiveTemplate(templateId) ? templateId : null;
  }

  /** World intent list → owner-local voxel change list (unresolvable intents are dropped) */
  private resolveIntents(intents: readonly WorldEditIntent[], placementOwner: OwnerId): OwnerVoxelChange[] {
    const changes: OwnerVoxelChange[] = [];
    for (const intent of intents) {
      if (intent.kind === 'erase') {
        const ref = this.resolveEraseTarget(intent.worldCell);
        if (ref && !this.isInsideInstance(ref.ownerId)) {
          changes.push({ owner: ref.ownerId, localKey: localKeyOf(ref), after: null });
        }
        continue;
      }
      if (intent.kind === 'overwrite') {
        const target = this.resolveOverwriteTarget(intent.worldCell, intent.afterWorldRaw);
        if (target && !this.isInsideInstance(target.ref.ownerId)) {
          changes.push({ owner: target.ref.ownerId, localKey: localKeyOf(target.ref), after: target.localRaw });
        }
        continue;
      }
      const target = this.resolvePlacementTarget(intent.worldCell, intent.afterWorldRaw, placementOwner);
      if (this.isInsideInstance(target.ref.ownerId)) continue;
      changes.push({ owner: target.ref.ownerId, localKey: localKeyOf(target.ref), after: target.localRaw });
    }
    return changes;
  }

  // ---- invariants ----

  /**
   * World-range validation for pure voxel changes (design rev.5's "granularity of judgment: for
   * pure voxel tx, the projected world cell of the affected ref"). A transaction with no structural
   * ops leaves the transform chain unchanged, so re-projecting every entry (`assertValidRuntimeScene`)
   * isn't needed — it's enough to check just the refs being added.
   *
   * Call this **before touching the scene** (pre-pass). Deletions don't newly create out-of-range cells, so they're excluded.
   */
  private assertVoxelChangesInRange(changes: readonly OwnerVoxelChange[]): void {
    for (const change of changes) {
      if (change.after === null) continue;
      const local = parseCellKey(change.localKey);
      const world = this.projectLocal(change.owner, local);
      if (!isValidCell(world[0], world[1], world[2])) {
        const owner = change.owner ?? '(root)';
        throw new Error(
          `Runtime scene world-range violation: local ${JSON.stringify(local)} of owner "${owner}" was ` +
            `projected to world (${world[0]}, ${world[1]}, ${world[2]})`,
        );
      }
    }
  }

  private projectLocal(owner: OwnerId, local: Cell): Cell {
    return ownerToWorldCell(this._scene.tree, owner, local);
  }

  /**
   * Precondition for deleteGroup (relocated from design rev.4 blocker ②).
   * SceneTree only knows whether it has children, so the **direct cell count is 0** check lives in
   * Document. It's checked against the state mid-transaction (= the moment that op is applied), so
   * a tx that stacks "move/delete cells first, then deleteGroup" passes correctly.
   */
  private assertGroupRemovable(id: string): void {
    if (directCellCount(this._scene, id) > 0) {
      throw new Error(`Cannot delete a group that has cells: ${id}`);
    }
  }

  // ---- applying ops ----

  /** For redo() only (undo/redo just replays an op list already validated once by applyForwardAtomic) */
  private applyOpForward(op: DocOp): void {
    switch (op.kind) {
      case 'voxel':
        this.writeCell(op.owner, op.key, op.after);
        break;
      case 'setPattern':
        this.writePattern(op.owner, op.key, op.after);
        break;
      case 'createGroup':
        this._scene.tree.insertNode(op.node, op.index);
        break;
      case 'deleteGroup':
        this.assertGroupRemovable(op.node.id);
        this._scene.tree.removeNode(op.node.id);
        break;
      case 'renameGroup':
        this._scene.tree.rename(op.id, op.after);
        break;
      case 'setGroupHidden':
        this._scene.tree.setHidden(op.id, op.after);
        break;
      case 'setGroupLocked':
        this._scene.tree.setLocked(op.id, op.after);
        break;
      case 'setGroupTemplateId':
        this._scene.tree.setTemplateId(op.id, op.after);
        break;
      case 'setComponentTemplate':
        this.components?.set(op.id, op.after);
        break;
      case 'setGroupTransform':
        this._scene.tree.setTransform(op.id, op.after);
        break;
      case 'reparentGroup':
        this._scene.tree.reparent(op.id, op.afterParent, op.afterIndex);
        break;
    }
  }

  private writeCell(owner: OwnerId, key: CellKey, value: number | null): void {
    if (value === null) this._scene.cells.delete(owner, key);
    else this._scene.cells.set(owner, key, value);
  }

  private writePattern(owner: OwnerId, key: CellKey, value: PatternPaint | null): void {
    if (!this._scene.patterns) throw new Error('Cannot apply a pattern op to a scene without a PatternPaintStore');
    this._scene.patterns.write(owner, key, value);
  }

  /**
   * Forward-applies an op while returning a "normalized op" that reflects the live state right
   * before application. Even if the before/node snapshot the caller passed in is stale or invalid,
   * Document always trusts this measured value — using this normalized op for rollback (the
   * unwind on applyForwardAtomic failure) and for the undo history record removes the dependency
   * on the caller's claim (#21 review finding: rewinding an op that had already succeeded before
   * the exception, using the caller-claimed "before," would restore incorrectly if that value
   * disagreed with the actual pre-start state).
   */
  private applyOpForwardCapturing(op: DocOp): DocOp {
    switch (op.kind) {
      case 'voxel': {
        // `before` is **measured live from owner-local**. Using the world winner value would set
        // the baseline to another owner's value when the write target differs from the winner
        // (design rev.3 blocker ③)
        const before = this._scene.cells.get(op.owner, op.key) ?? null;
        this.writeCell(op.owner, op.key, op.after);
        return { kind: 'voxel', owner: op.owner, key: op.key, before, after: op.after };
      }
      case 'setComponentTemplate': {
        const before = this.components?.get(op.id) ?? null;
        this.components?.set(op.id, op.after);
        return {
          kind: 'setComponentTemplate',
          id: op.id,
          before: before === null ? null : cloneComponent(before),
          after: op.after === null ? null : cloneComponent(op.after),
        };
      }
      case 'setPattern': {
        const before = this._scene.patterns?.get(op.owner, op.key) ?? null;
        this.writePattern(op.owner, op.key, op.after);
        return {
          kind: 'setPattern',
          owner: op.owner,
          key: op.key,
          before: before === null ? null : clonePatternPaint(before),
          after: op.after === null ? null : clonePatternPaint(op.after),
        };
      }
      case 'createGroup':
        // A new node has no live "before" (it's about to be created).
        // The contents of the node the caller declared *is* the forward intent, so it's fine to trust it
        this._scene.tree.insertNode(op.node, op.index);
        return op;
      case 'deleteGroup': {
        const real = this._scene.tree.getNode(op.node.id);
        const parentId = real?.parentId ?? op.node.parentId;
        const index = this._scene.tree.childrenOf(parentId).indexOf(op.node.id);
        const node = real ? toOwnedGroupNode(real) : cloneGroupNode(op.node);
        this.assertGroupRemovable(op.node.id); // throws here if cells remain
        this._scene.tree.removeNode(op.node.id); // throws here if children remain
        return { kind: 'deleteGroup', node, index: index === -1 ? op.index : index };
      }
      case 'renameGroup': {
        const before = this._scene.tree.getNode(op.id)?.name ?? op.before;
        this._scene.tree.rename(op.id, op.after);
        return { kind: 'renameGroup', id: op.id, before, after: op.after };
      }
      case 'setGroupHidden': {
        const before = !!this._scene.tree.getNode(op.id)?.hidden;
        this._scene.tree.setHidden(op.id, op.after);
        return { kind: 'setGroupHidden', id: op.id, before, after: op.after };
      }
      case 'setGroupLocked': {
        const before = !!this._scene.tree.getNode(op.id)?.locked;
        this._scene.tree.setLocked(op.id, op.after);
        return { kind: 'setGroupLocked', id: op.id, before, after: op.after };
      }
      case 'setGroupTemplateId': {
        // `before` is measured live — don't trust the caller's claim (same reason as setGroupTransform)
        const before = this._scene.tree.getNode(op.id)?.templateId ?? null;
        this._scene.tree.setTemplateId(op.id, op.after);
        return { kind: 'setGroupTemplateId', id: op.id, before, after: op.after };
      }
      case 'setGroupTransform': {
        // `before` is measured live. Don't trust the caller's claim (same reason as #21). SceneTree's
        // getNode returns the internal node as-is, so deep-copy before pushing onto history to sever the alias
        const live = this._scene.tree.getNode(op.id)?.transform;
        const before = live === undefined ? undefined : cloneTransform(live);
        this._scene.tree.setTransform(op.id, op.after);
        return { kind: 'setGroupTransform', id: op.id, before, after: op.after };
      }
      case 'reparentGroup': {
        const node = this._scene.tree.getNode(op.id);
        const beforeParent = node?.parentId ?? op.beforeParent;
        const beforeIndex = this._scene.tree.childrenOf(beforeParent).indexOf(op.id);
        this._scene.tree.reparent(op.id, op.afterParent, op.afterIndex);
        return {
          kind: 'reparentGroup',
          id: op.id,
          beforeParent,
          beforeIndex: beforeIndex === -1 ? op.beforeIndex : beforeIndex,
          afterParent: op.afterParent,
          afterIndex: op.afterIndex,
        };
      }
    }
  }

  /** Applies an op in reverse */
  private applyOpBackward(op: DocOp): void {
    switch (op.kind) {
      case 'voxel':
        this.writeCell(op.owner, op.key, op.before);
        break;
      case 'setPattern':
        this.writePattern(op.owner, op.key, op.before);
        break;
      case 'createGroup':
        this._scene.tree.removeNode(op.node.id);
        break;
      case 'deleteGroup':
        this._scene.tree.insertNode(op.node, op.index);
        break;
      case 'renameGroup':
        this._scene.tree.rename(op.id, op.before);
        break;
      case 'setGroupHidden':
        this._scene.tree.setHidden(op.id, op.before);
        break;
      case 'setGroupLocked':
        this._scene.tree.setLocked(op.id, op.before);
        break;
      case 'setGroupTemplateId':
        this._scene.tree.setTemplateId(op.id, op.before);
        break;
      case 'setComponentTemplate':
        this.components?.set(op.id, op.before);
        break;
      case 'setGroupTransform':
        this._scene.tree.setTransform(op.id, op.before); // if undefined, revert to "not set"
        break;
      case 'reparentGroup':
        this._scene.tree.reparent(op.id, op.beforeParent, op.beforeIndex);
        break;
    }
  }

  /** Group ids touched by voxel ops + reparent sources (candidates that may have become empty) */
  private touchedGroupsFromOps(ops: readonly DocOp[]): Set<string> {
    const touched = new Set<string>();
    for (const op of ops) {
      if (op.kind === 'voxel') {
        if (op.owner !== null) touched.add(op.owner);
      } else if (op.kind === 'reparentGroup' && op.beforeParent !== null) {
        touched.add(op.beforeParent);
      }
    }
    return touched;
  }

  /**
   * Among the groups a transaction touched, appends a deleteGroup op to the same transaction and
   * removes it from the tree for any that ended up with direct cell count 0 and 0 children.
   * If the parent also becomes empty, chains upward. Judged against the **transaction's final
   * state** (design rev.4: looked at after cells have already been moved/deleted).
   *
   * A group already removed by another op (e.g. a deleteGroup buildDeleteSelection explicitly
   * pushed) has getNode return undefined, so it's simply skipped (no double deletion).
   */
  private pruneEmptyGroups(ops: DocOp[]): void {
    const queue = [...this.touchedGroupsFromOps(ops)];
    const seen = new Set<string>();
    while (queue.length) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const node = this._scene.tree.getNode(id);
      if (!node) continue;
      if (directCellCount(this._scene, id) > 0 || this._scene.tree.childrenOf(id).length > 0) continue;
      const siblings = this._scene.tree.childrenOf(node.parentId);
      const index = siblings.indexOf(id);
      ops.push({ kind: 'deleteGroup', node: { ...toOwnedGroupNode(node), childIds: [] }, index });
      this._scene.tree.removeNode(id);
      if (node.parentId !== null) queue.push(node.parentId);
    }
  }

  /**
   * Atomic application of a transaction (design rev.2 blocker ④).
   *
   * 1. **Pure voxel tx**: range validation passes in a pre-pass → all ops applied to the scene →
   *    affected changes batched into a single `applyVoxelChanges` call → one `WorldIndexChange('cells')`
   * 2. **A tx containing even one structural op**: skip incremental updates along the way; after
   *    all ops succeed, do `assertValidRuntimeScene` → one `rebuildFromScene` call (structurally
   *    eliminates the incident of applying a post-structural-op voxel op incrementally against a
   *    stale transform/rank cache)
   * 3. **On failure**: roll back the scene; the index was never touched so it's unchanged; zero external notifications
   * 4. Validation and the index swap happen **before the history push and notification**
   *
   * Also rolls back the scene if the index diff construction itself throws (design rev.4 P2: a
   * temporary map that only protects the old index still leaves scene/index inconsistent).
   */
  private applyForwardAtomic(ops: DocOp[]): DocOp[] {
    const pureVoxel = isVoxelOnly(ops);
    if (pureVoxel) {
      // Range-validate before touching the scene (only need to check the projection targets of the refs being added)
      this.assertVoxelChangesInRange(
        ops.map((op) => {
          const v = op as Extract<DocOp, { kind: 'voxel' }>;
          return { owner: v.owner, localKey: v.key, after: v.after };
        }),
      );
    }

    const applied: DocOp[] = [];
    try {
      for (const op of ops) applied.push(this.applyOpForwardCapturing(op));
      this.pruneEmptyGroups(applied);
      const structural = !isVoxelOnly(applied);
      if (structural) {
        assertValidRuntimeScene(this._scene, this.shapeOf);
        this._index.rebuildFromScene(this._scene);
      } else {
        const changes = applied.map((op) => {
          const v = op as Extract<DocOp, { kind: 'voxel' }>;
          return { owner: v.owner, localKey: v.key, after: v.after };
        });
        if (changes.length) this._index.applyVoxelChanges(changes);
      }
    } catch (err) {
      for (let i = applied.length - 1; i >= 0; i--) this.applyOpBackward(applied[i]!);
      throw err;
    }
    return applied;
  }

  /**
   * A normal voxel edit also clears any pattern binding remaining on that ref, as part of the same
   * history unit. Requiring the caller to append a setPattern would inevitably get missed at every
   * new edit entry point, so it's structurally handled here at Document's transaction entry point.
   * refRemap move sources aren't cleared, since the binding itself follows to the destination.
   * Operations that already have an explicit setPattern aren't duplicated either.
   */
  private withPatternClears(tx: Transaction): Transaction {
    if (!this._scene.patterns?.size) return tx;
    const explicit = new Set(
      tx.ops
        .filter((op): op is Extract<DocOp, { kind: 'setPattern' }> => op.kind === 'setPattern')
        .map((op) => makeCellRefKey({ ownerId: op.owner, localCell: parseCellKey(op.key) })),
    );
    const moving = new Set(tx.remap?.keys() ?? []);
    const ops: DocOp[] = [];
    for (const op of tx.ops) {
      ops.push(op);
      if (op.kind !== 'voxel') continue;
      const refKey = makeCellRefKey({ ownerId: op.owner, localCell: parseCellKey(op.key) });
      if (explicit.has(refKey) || moving.has(refKey)) continue;
      if (!this._scene.patterns.has(op.owner, op.key)) continue;
      const paint = this._scene.patterns.get(op.owner, op.key);
      if (paint) ops.push({ kind: 'setPattern', owner: op.owner, key: op.key, before: paint, after: null });
    }
    return { ops, ...(tx.remap ? { remap: tx.remap } : {}) };
  }

  /**
   * Makes the pattern binding follow a physical move of a CellRef.
   *
   * A ref that explicitly has `setPattern` in the same transaction is excluded from automatic
   * remap, since that op already completes the post-move binding on its own. Unconditionally
   * remapping an operation that transforms the raw itself, like mirror, would overwrite the
   * already-transformed binding with the stale value.
   */
  private remapPatterns(remap: CellRefRemap | undefined, ops: readonly DocOp[]): void {
    if (!remap?.size || !this._scene.patterns) return;
    const explicit = new Set(
      ops
        .filter((op): op is Extract<DocOp, { kind: 'setPattern' }> => op.kind === 'setPattern')
        .map((op) => makeCellRefKey({ ownerId: op.owner, localCell: parseCellKey(op.key) })),
    );
    const automatic = new Map([...remap].filter(([source]) => !explicit.has(source)));
    if (automatic.size && this._scene.patterns.remap(automatic)) {
      this._index.rebuildFromScene(this._scene);
    }
  }

  /**
   * Applies all ops in sequence + push + notify. For bulk operations such as fill/range/structural changes.
   * Notification order follows the design rev.6/rev.7 contract
   * (index swap → WorldIndexChange → refRemap → SceneBatchChange → Document event).
   */
  applyTransaction(tx: Transaction): void {
    const owned = this.withPatternClears(cloneTransaction(tx));
    const committed: Transaction = { ops: this.applyForwardAtomic(owned.ops), ...(owned.remap ? { remap: owned.remap } : {}) };
    this.undoStack.push(committed);
    this.redoStack.length = 0;
    this.remapPatterns(committed.remap, committed.ops);
    this._index.notifyBatch({ phase: 'commit', ...(committed.remap ? { refRemap: committed.remap } : {}) });
    this.notify({ kind: 'edit', voxelOnly: isVoxelOnly(committed.ops) });
  }

  /**
   * **Assumes voxel and setPattern are already staged** (stroke/drag path). Applies only the
   * structural ops + push + notify.
   *
   * Notification-count contract (design rev.7): in a staged commit, scene/index are already in
   * their final state at preview time, so **`WorldIndexChange` for the renderer fires 0 times**,
   * `SceneBatchChange(commit + refRemap)` for Selection fires once, and Document event / autosave
   * fires once.
   *
   * Placing `setPattern` on the same "already staged" side as voxel is the key point (#76 review
   * round 4). Routing it through `applyForwardAtomic` as a structural op triggers
   * `rebuildFromScene()`, causing a **full WorldIndex rebuild + `replaceAll` notification on every
   * pointerup** (measured: ~230ms for 48³). The binding diff only needs to land in history — the
   * display is already correct as of preview.
   *
   * Because of this contract, **`withPatternClears` is deliberately not run here** — automatic
   * clearing is an "add an unapplied setPattern" operation, which doesn't fit the already-staged
   * assumption. Bindings invalidated by a raw change are removed by `EditSession` at preview time
   * and land in the op as a baseline diff. (The `applyTransaction` path is still handled by
   * `withPatternClears` as before.)
   */
  commitStaged(tx: Transaction): void {
    const owned = cloneTransaction(tx);
    // voxel / setPattern have already been accurately computed by the caller (EditSession) as a
    // baseline diff, so we don't forward-apply or re-validate them here. Only the structural ops
    // need to be rollback targets on exception (rollback of voxel is EditSession.commit's own
    // responsibility, see beginSession)
    const voxelOps = owned.ops.filter((op) => op.kind === 'voxel' || op.kind === 'setPattern');
    const structuralOps = owned.ops.filter((op) => op.kind !== 'voxel' && op.kind !== 'setPattern');
    const committedStructural = structuralOps.length ? this.applyForwardAtomic(structuralOps) : [];
    const committed: Transaction = {
      ops: [...voxelOps, ...committedStructural],
      ...(owned.remap ? { remap: owned.remap } : {}),
    };
    this.undoStack.push(committed);
    this.redoStack.length = 0;
    this.remapPatterns(committed.remap, committed.ops);
    this._index.notifyBatch({ phase: 'commit', ...(committed.remap ? { refRemap: committed.remap } : {}) });
    this.notify({ kind: 'edit', voxelOnly: isVoxelOnly(committed.ops) });
  }

  /**
   * Starts a preview edit session for dragging, continuous placement, etc. (#11).
   * The input layer (controls.ts / selecttool.ts) does preview → commit/discard only through the
   * EditSession obtained here, and doesn't own baseline-restoration logic itself.
   *
   * `placementOwner` is **held for the session** — kept consistent as one owner per session even
   * if the active group changes mid-stroke (design rev.3).
   */
  beginSession(placementOwner: OwnerId = null): EditSession {
    const baseline = new Map<CellRefKey, SessionBaseline>();
    /** Baseline for the binding side. Used to roll back a cell drag's staged remap (#76 review) */
    const patternBaseline = new Map<CellRefKey, { ref: CellRef; before: PatternPaint | null }>();
    let lastRemap: CellRefRemap | null = null;
    let closed = false;

    /** The "raw value" before baseline recording. Returns the baseline for a ref already touched, or the live value for one not yet touched */
    const pristineValueOf = (ref: CellRef): number | null => {
      const key = makeCellRefKey(ref);
      const recorded = baseline.get(key);
      if (recorded) return recorded.before;
      return this._scene.cells.get(ref.ownerId, localKeyOf(ref)) ?? null;
    };

    /** The "raw value" on the binding side. Same rule as voxel's `pristineValueOf` */
    const pristinePatternOf = (ref: CellRef): PatternPaint | null => {
      const recorded = patternBaseline.get(makeCellRefKey(ref));
      if (recorded) return recorded.before;
      return this._scene.patterns?.get(ref.ownerId, localKeyOf(ref)) ?? null;
    };

    const recordBaseline = (ref: CellRef): number | null => {
      const key = makeCellRefKey(ref);
      const existing = baseline.get(key);
      if (existing) return existing.before;
      const before = this._scene.cells.get(ref.ownerId, localKeyOf(ref)) ?? null;
      baseline.set(key, { ref, before });
      // Also take a baseline for the pattern binding, over the same ref set (#76 review). If only
      // the voxel is restored and the binding fails to restore, "the cell is back but the pattern
      // is still at the destination" would remain after cancel
      patternBaseline.set(key, { ref, before: this._scene.patterns?.get(ref.ownerId, localKeyOf(ref)) ?? null });
      return before;
    };

    /**
     * Restores a staged binding move back to baseline (#76 review).
     *
     * Same as voxel: **always rebuilt from baseline every time** — accumulating remaps would push
     * the binding further and further from its original position each time the drag offset changes.
     */
    const restorePatterns = (): void => {
      if (!this._scene.patterns || !patternBaseline.size) return;
      this._scene.patterns.writeMany([...patternBaseline.values()].map((entry) => [entry.ref, entry.before]));
    };

    /**
     * Turns the binding's baseline diff into `setPattern` ops (#76 review round 2).
     *
     * Leaving the staged remap to `Transaction.remap`'s automatic follow-along means **a binding
     * that originally existed at the destination doesn't come back on undo** — automatic remap can
     * only express "where does the source binding move to," and can't hold the overwritten
     * destination binding as a `before`. Turning the baseline diff into an op, same as voxel,
     * closes preview / commit / undo / redo over the same source of truth (baseline).
     *
     * Becoming an explicit op also excludes it from the automatic handling of `withPatternClears` /
     * `remapPatterns` (both treat a ref that already has setPattern as explicit and exclude it).
     */
    const collectPatternOps = (): DocOp[] => {
      const patterns = this._scene.patterns;
      if (!patterns) return [];
      const ops: DocOp[] = [];
      for (const entry of patternBaseline.values()) {
        const localKey = localKeyOf(entry.ref);
        const after = patterns.get(entry.ref.ownerId, localKey) ?? null;
        if (samePatternPaint(entry.before, after)) continue;
        ops.push({ kind: 'setPattern', owner: entry.ref.ownerId, key: localKey, before: entry.before, after });
      }
      return ops;
    };

    /**
     * Immediate reflection into scene + index (preview). **Makes the scene and index swap atomic.**
     *
     * Applies the same contract to preview as the `applyTransaction` side (review finding P1): even
     * after range validation passes, the index update can still throw (unknown owner / unknown
     * catalog / out of grid), so the live value before the write is kept and the scene is reverted
     * on failure. Otherwise **only the scene would advance invalidly, leaving the index and
     * notifications in the old state**.
     *
     * `applyVoxelChanges` only fires content notification on success, so on failure notifications fire 0 times.
     */
    const stageLocal = (changes: readonly OwnerVoxelChange[], phase: 'preview' | 'restore'): void => {
      if (!changes.length) return;
      this.assertVoxelChangesInRange(changes);
      const previous = changes.map((change) => ({
        owner: change.owner,
        localKey: change.localKey,
        live: this._scene.cells.get(change.owner, change.localKey) ?? null,
      }));
      for (const change of changes) this.writeCell(change.owner, change.localKey, change.after);
      try {
        this._index.applyVoxelChanges(changes);
      } catch (err) {
        // Restore in reverse order — if the same (owner, localKey) appears more than once, the first observed live value ends up remaining
        for (let i = previous.length - 1; i >= 0; i--) {
          const entry = previous[i]!;
          this.writeCell(entry.owner, entry.localKey, entry.live);
        }
        throw err;
      }
      this._index.notifyBatch({ phase });
    };

    /**
     * **The sole entry point for staged reflection of both binding and voxel** (#76 review round 5).
     *
     * Finishes range validation before touching the binding; any failure after that (index update
     * throwing, etc.) also restores the binding back to baseline. **Never leaves a state where only
     * one of the two has advanced.**
     *
     * Writing the same try/catch separately every time a new stage-family method is added is how
     * protection gets forgotten on a new path (it actually happened: `stagePreview`'s side was
     * missed when `stageMoveRefs` was made atomic). Confine the failure boundary to one place so
     * the contract stays the same as more paths are added.
     */
    const stageWithPatterns = (
      changes: readonly OwnerVoxelChange[],
      patternEntries: readonly (readonly [CellRef, PatternPaint | null])[],
    ): void => {
      this.assertVoxelChangesInRange(changes);
      try {
        if (patternEntries.length) this._scene.patterns?.writeMany(patternEntries.map(([ref, paint]) => [ref, paint]));
        stageLocal(changes, 'preview');
      } catch (err) {
        restorePatterns();
        throw err;
      }
    };

    /** A change list that restores the entire baseline back to its raw values */
    const restoreChanges = (): OwnerVoxelChange[] =>
      [...baseline.values()].map((entry) => ({
        owner: entry.ref.ownerId,
        localKey: localKeyOf(entry.ref),
        after: entry.before,
      }));

    return {
      stagePreview: (intents: readonly WorldEditIntent[]): void => {
        if (closed) return;
        const changes = this.resolveIntents(intents, placementOwner);
        for (const change of changes) {
          recordBaseline({ ownerId: change.owner, localCell: parseCellKey(change.localKey) });
        }
        // The bindings on touched cells are **removed at preview time** (#76 review round 4).
        // Previously `withPatternClears` added this automatically at commit, but that would let
        // an "unapplied setPattern" flow into commitStaged and trigger a full rebuild.
        // Removing it here means it lands in the op as a baseline diff, and the display is correct from preview onward
        const patterns = this._scene.patterns;
        const cleared: Array<[CellRef, PatternPaint | null]> = patterns
          ? changes
              .filter((change) => patterns.has(change.owner, change.localKey))
              .map((change) => [{ ownerId: change.owner, localCell: parseCellKey(change.localKey) }, null])
          : [];
        stageWithPatterns(changes, cleared);
      },

      stageMoveRefs: (refs: readonly CellRef[], worldDelta: Cell): CellRefRemap => {
        const remap = new Map<CellRefKey, CellRef | null>();
        if (closed) return remap;

        for (const ref of refs) recordBaseline(ref);

        // Collapse the final state down to one entry per refKey. Overwritten in the order
        // (a) fully restore baseline → (b) empty the move sources → (c) place at the move
        // destinations, so even self-overlaps (swapping among move sources, delta 0) end up
        // correct in a single stage
        const final = new Map<CellRefKey, OwnerVoxelChange>();
        // The binding also builds its final state via **exactly the same 3 steps** (#76 review
        // round 3). `PatternPaintStore.remap` only collects "moves where the source has a binding,"
        // so overlaying a plain block onto a cell with a binding would leave the destination's
        // binding un-cleared. Doing "empty both source and destination first, then place only what
        // existed" closes no-binding→binding / binding→no-binding / binding→binding under the same rule
        const patternFinal = new Map<CellRefKey, [CellRef, PatternPaint | null]>();
        for (const [key, entry] of baseline) {
          final.set(key, { owner: entry.ref.ownerId, localKey: localKeyOf(entry.ref), after: entry.before });
        }
        for (const entry of patternBaseline.values()) {
          patternFinal.set(makeCellRefKey(entry.ref), [entry.ref, entry.before]);
        }
        for (const ref of refs) {
          final.set(makeCellRefKey(ref), { owner: ref.ownerId, localKey: localKeyOf(ref), after: null });
          patternFinal.set(makeCellRefKey(ref), [ref, null]);
        }
        for (const ref of refs) {
          const value = pristineValueOf(ref);
          if (value === null) continue; // already empty = nothing to move
          const localDelta = worldDeltaToOwnerDelta(this._scene.tree, ref.ownerId, worldDelta);
          const destRef: CellRef = {
            ownerId: ref.ownerId,
            localCell: [
              ref.localCell[0] + localDelta[0],
              ref.localCell[1] + localDelta[1],
              ref.localCell[2] + localDelta[2],
            ],
          };
          recordBaseline(destRef);
          final.set(makeCellRefKey(destRef), {
            owner: destRef.ownerId,
            localKey: localKeyOf(destRef),
            after: value,
          });
          // If the move source has no binding, null goes in = the destination's existing binding is cleared
          patternFinal.set(makeCellRefKey(destRef), [destRef, pristinePatternOf(ref)]);
          remap.set(makeCellRefKey(ref), destRef);
        }

        // Copy the binding to the destination **before stageLocal** (#76 review). Since the pattern
        // is derived from world coordinates (#69), leaving the binding on the old ref would show
        // the save-fallback only during preview and then jump to the destination's pattern the
        // instant it's committed. `applyVoxelChanges` calls the resolver for the moved cell, so
        // placing the binding at the correct position beforehand makes it show the final pattern from preview onward
        stageWithPatterns([...final.values()], [...patternFinal.values()]);
        lastRemap = remap;
        return remap;
      },

      baselineEntries: (): IterableIterator<[CellRefKey, SessionBaseline]> => baseline.entries(),

      commit: (extraOps: NonVoxelDocOp[] = []): void => {
        if (closed) return;
        // The type already disallows passing a voxel op via extraOps (NonVoxelDocOp), but reject it
        // at runtime too as a safety net in case it slips through via `any` or a future caller (#22 review finding)
        for (const op of extraOps as DocOp[]) {
          if (op.kind === 'voxel') {
            throw new Error('Cannot pass a voxel op via EditSession.commit\'s extraOps (would be double-managed with the baseline diff)');
          }
        }
        const ops: DocOp[] = [];
        for (const [, entry] of baseline) {
          const localKey = localKeyOf(entry.ref);
          const after = this._scene.cells.get(entry.ref.ownerId, localKey) ?? null;
          if (after !== entry.before) {
            ops.push({ kind: 'voxel', owner: entry.ref.ownerId, key: localKey, before: entry.before, after });
          }
        }
        ops.push(...extraOps);
        // Turns the binding diff into ops (#76 review round 2). **The scene is passed through
        // as-staged** — commitStaged treats setPattern as "already staged," same as voxel, and
        // neither forward-applies nor re-projects it (review round 4). The op is only pushed for the undo history.
        ops.push(...collectPatternOps());
        if (!ops.length) {
          closed = true; // zero diff = commits nothing and finishes normally; commit/cancel are both fine to be no-ops from here on
          return;
        }
        try {
          this.commitStaged({ ops, ...(lastRemap && lastRemap.size ? { remap: lastRemap } : {}) });
          closed = true; // only set closed after commitStaged succeeds
        } catch (err) {
          // If commitStaged fails, setting closed beforehand would create a deadlock state where
          // "preview stays but cancel doesn't work either" (#21 review finding). Restore to
          // baseline and re-throw. Since it was already previewed, "0 notifications on failure"
          // doesn't apply here — a restore notification is fired since the screen must revert too
          restorePatterns();
          stageLocal(restoreChanges(), 'restore');
          closed = true;
          throw err;
        }
      },

      cancel: (): void => {
        if (closed) return;
        closed = true;
        restorePatterns();
        stageLocal(restoreChanges(), 'restore');
      },
    };
  }

  /** Fill/range confirmation (intents are not yet applied — applied here) */
  applyEdits(intents: readonly WorldEditIntent[], placementOwner: OwnerId): void {
    if (!intents.length) return;
    const changes = this.resolveIntents(intents, placementOwner);
    if (!changes.length) return;
    this.applyTransaction({
      ops: changes.map((c): DocOp => ({ kind: 'voxel', owner: c.owner, key: c.localKey, before: null, after: c.after })),
    });
  }

  /**
   * Finalizes intents bundled into a new group (for when you want to group from the start a
   * cluster created via a Shift+click range, like a pillar or wall). Does nothing and returns null
   * if intents is empty.
   *
   * Passing `parentId` creates it inside that group (default is directly under root). **Since
   * blank cells (#113) have their scope of effect determined by which group they're inside**,
   * fixing it to root would always make them affect everything.
   *
   * The new group's own transform is identity, but **the parent chain's transform still applies**,
   * so world coordinates / world orientation are converted to parent-local before placement
   * (stays correct even inside a rotated parent). The conversion goes through `worldToOwnerCell` /
   * `worldToOwnerRaw` — the coordinate math isn't rewritten here.
   */
  applyEditsAsNewGroup(
    intents: readonly WorldEditIntent[],
    name: string,
    parentId: string | null = null,
  ): string | null {
    if (!intents.length) return null;
    if (parentId !== null && !this._scene.tree.getNode(parentId)) {
      throw new Error(`applyEditsAsNewGroup: parent group not found ("${parentId}")`);
    }
    const id = this.nextGroupId();
    // Insert at the tail = frontmost among siblings (a blank has to be in front to hide what's behind it)
    const index = this._scene.tree.childrenOf(parentId).length;
    const ops: DocOp[] = [{ kind: 'createGroup', node: { id, name, parentId, childIds: [] }, index }];
    for (const intent of intents) {
      if (intent.kind === 'erase') continue; // an erase intent never enters new grouping
      // transformChain(id) can't be queried before createGroup is applied. The new group itself is
      // identity, so it's enough to drop world → local through the **parent's** chain
      const cell = worldToOwnerCell(this._scene.tree, parentId, intent.worldCell);
      ops.push({
        kind: 'voxel',
        owner: id,
        key: makeCellKey(cell[0], cell[1], cell[2]),
        before: null,
        after: worldToOwnerRaw(this._scene.tree, parentId, intent.afterWorldRaw, this.shapeOf),
      });
    }
    if (ops.length === 1) return null; // don't create an empty group if there are no actual cells
    this.applyTransaction({ ops });
    return id;
  }

  /**
   * A temporary floor for history (#69 component editing / #142 review P1).
   *
   * During a session (edit mode, etc.), **undo is prevented from going back past the point of
   * entry.** If it could, only the things premised on the session being active (working groups)
   * would vanish, leaving a state that can't be exited. Restricting movement to inside the session
   * prevents this inconsistency.
   */
  private historyFloor = 0;

  /**
   * Opens a history session. **Pass the return value back when closing** (restores correctly even when nested).
   *
   * While open, `undo()` won't go back before this point.
   */
  openHistorySession(entry?: Transaction): HistorySessionMark {
    const mark = { rollbackTo: this.undoStack.length, previousFloor: this.historyFloor };
    // **The entry operation is inside the session.** It gets rolled back together on close.
    // But the floor is placed **above** it — if an undo right after entry stripped away only the
    // entry operation, we'd end up with the session active but its premise (the working group) gone
    if (entry) this.applyTransaction(entry);
    this.historyFloor = this.undoStack.length;
    return mark;
  }

  /**
   * Closes a history session, **rolling back the entire set of changes made during the session**.
   *
   * For things like edit mode — "enter, fiddle, exit" — we want to leave only the net change to
   * the artwork after exiting as a single history entry. Leaving the intermediate steps in history
   * would cause an undo after exiting to restore the editing screen, leaving a state where only the mode isn't active.
   *
   * What gets rolled back can't be recovered via redo either (since the session no longer exists, there's nowhere to redo back into).
   */
  closeHistorySession(mark: HistorySessionMark): void {
    this.historyFloor = mark.previousFloor;
    while (this.undoStack.length > mark.rollbackTo) {
      const depth = this.undoStack.length;
      this.undo();
      if (this.undoStack.length === depth) break; // give up if not making progress (infinite loop guard)
    }
    this.redoStack.length = 0;
  }

  undo(): void {
    if (this.undoStack.length <= this.historyFloor) return;
    const tx = this.undoStack.pop();
    if (!tx) return;
    const undone: DocOp[] = [];
    try {
      for (let i = tx.ops.length - 1; i >= 0; i--) {
        this.applyOpBackward(tx.ops[i]!);
        undone.push(tx.ops[i]!);
      }
      this.refreshIndexAfterHistoryStep(tx.ops, 'backward');
    } catch (err) {
      for (let i = undone.length - 1; i >= 0; i--) this.applyOpForward(undone[i]!);
      this.undoStack.push(tx);
      throw err;
    }
    this.redoStack.push(tx);
    const inverseRemap = tx.remap ? invertRemap(tx.remap) : undefined;
    this.remapPatterns(inverseRemap, tx.ops);
    this._index.notifyBatch({ phase: 'commit', ...(inverseRemap ? { refRemap: inverseRemap } : {}) });
    this.notify({ kind: 'undo', voxelOnly: isVoxelOnly(tx.ops) });
  }

  redo(): void {
    const tx = this.redoStack.pop();
    if (!tx) return;
    const redone: DocOp[] = [];
    try {
      for (const op of tx.ops) {
        this.applyOpForward(op);
        redone.push(op);
      }
      this.refreshIndexAfterHistoryStep(tx.ops, 'forward');
    } catch (err) {
      for (let i = redone.length - 1; i >= 0; i--) this.applyOpBackward(redone[i]!);
      this.redoStack.push(tx);
      throw err;
    }
    this.undoStack.push(tx);
    this.remapPatterns(tx.remap, tx.ops);
    this._index.notifyBatch({ phase: 'commit', ...(tx.remap ? { refRemap: tx.remap } : {}) });
    this.notify({ kind: 'redo', voxelOnly: isVoxelOnly(tx.ops) });
  }

  /** Index update after undo/redo. Same 2 rules as applyForwardAtomic (pure voxel is incremental, structural is a full rebuild) */
  private refreshIndexAfterHistoryStep(ops: readonly DocOp[], direction: 'forward' | 'backward'): void {
    if (!isVoxelOnly(ops)) {
      assertValidRuntimeScene(this._scene, this.shapeOf);
      this._index.rebuildFromScene(this._scene);
      return;
    }
    const changes = ops.map((op) => {
      const v = op as Extract<DocOp, { kind: 'voxel' }>;
      return { owner: v.owner, localKey: v.key, after: direction === 'forward' ? v.after : v.before };
    });
    this.assertVoxelChangesInRange(changes);
    if (changes.length) this._index.applyVoxelChanges(changes);
  }

  /**
   * Snapshots the entire current scene/history. For rollback dedicated to "replace-everything /
   * clear-everything" methods like replaceAll/clearAll (found while investigating similar paths
   * per the #22 review finding: unlike applyTransaction/commitStaged, these two methods can't do
   * sequential per-op capture — since they're inherently "replace everything" operations, it's
   * natural for rollback to also be "restore everything wholesale," rather than forcing a reuse of
   * the per-op rollback mechanism).
   */
  private snapshotAll(): {
    cells: Array<[OwnerId, CellKey, number]>;
    patterns: Array<[OwnerId, CellKey, PatternPaint]>;
    nodes: GroupNode[];
    undoStack: Transaction[];
    redoStack: Transaction[];
  } {
    return {
      cells: [...this._scene.cells.allEntries()],
      patterns: this._scene.patterns ? [...this._scene.patterns.allEntries()] : [],
      nodes: [...this._scene.tree.allNodesPreOrder()].map(toOwnedGroupNode),
      undoStack: [...this.undoStack],
      redoStack: [...this.redoStack],
    };
  }

  /** Fully restores scene/index/history to a snapshotAll() result */
  private restoreAll(snapshot: ReturnType<Document['snapshotAll']>): void {
    this._scene.tree.replaceAll(snapshot.nodes);
    this._scene.cells.replaceAll(snapshot.cells);
    this._scene.patterns?.replaceAll(snapshot.patterns);
    this._index.rebuildFromScene(this._scene);
    this.undoStack = snapshot.undoStack;
    this.redoStack = snapshot.redoStack;
  }

  /**
   * For project loading. Clears history and replaces the entire scene (#37 B1b: direct connection to v3's EditorScene).
   *
   * The argument scene's **content only is imported** (the instance is not swapped) — so that
   * subscribers and derived indexes holding references into Document's owned tree/cells don't need
   * to be swapped. After import it's run through `assertValidRuntimeScene`; on failure it's fully restored from the snapshot.
   */
  replaceAll(next: EditorSceneReader): void {
    const snapshot = this.snapshotAll();
    try {
      this._scene.tree.replaceAll([...next.tree.allNodesPreOrder()].map(toOwnedGroupNode));
      this._scene.cells.replaceAll([...next.cells.allEntries()]);
      this._scene.patterns?.replaceAll(next.patterns ? [...next.patterns.allEntries()] : []);
      assertValidRuntimeScene(this._scene, this.shapeOf);
      this._index.rebuildFromScene(this._scene);
      this.undoStack.length = 0;
      this.historyFloor = 0; // history is wiped entirely, so collapse the session floor too
      this.redoStack.length = 0;
    } catch (err) {
      this.restoreAll(snapshot);
      throw err;
    }
    this._index.notifyBatch({ phase: 'commit' });
    this.notify({ kind: 'replaceAll' });
  }

  clearAll(): void {
    const snapshot = this.snapshotAll();
    try {
      this._scene.cells.clear();
      this._scene.patterns?.clear();
      this._scene.tree.clear();
      this._index.rebuildFromScene(this._scene);
      this.undoStack.length = 0;
      this.historyFloor = 0; // history is wiped entirely, so collapse the session floor too
      this.redoStack.length = 0;
    } catch (err) {
      this.restoreAll(snapshot);
      throw err;
    }
    this._index.notifyBatch({ phase: 'commit' });
    this.notify({ kind: 'clear' });
  }
}
