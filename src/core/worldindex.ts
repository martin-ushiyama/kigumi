import { assertCanonicalLocalCellKey, makeCellKey, parseCellKey, type Cell, type CellKey } from './cell';
import { makeCellRefKey, type CellRef, type CellRefKey, type CellRefRemap, type OwnerId } from './cellref';
import { createEmitter, type Unsubscribe } from './emitter';
import { isVoidCell, type Shape } from './orientation';
import { applyTransform, rotateRaw, type ResolvedTransform } from './transform';
import type { EditorSceneReader } from './ownervoxels';
import {
  buildSceneProjection,
  makeVoidHidesOwner,
  ownerPaintOrder,
  winnerOfStack,
  type LocalRawResolver,
  type ProjectionEntry,
  type VoidHidesOwner,
} from './sceneprojection';
import type { WorldReader } from './voxels';

/**
 * WorldIndex: the world-coordinate read-model derived from EditorScene (the source of
 * truth for the owner-local edit model). renderer / picking read this.
 *
 * Whereas SceneProjection is an immutable snapshot, this is a live index that's incrementally
 * updated at Document's transaction boundaries. The two share the projection, paint order, and
 * winner rules (ownerPaintOrder / winnerOfStack / buildSceneProjection) and WorldIndex does not
 * reimplement them — if a derived read-model had its own winner resolution, what renderer and
 * export see could diverge.
 *
 * **This module is not yet wired up as of B1a** (not called from Document / renderer / picking).
 * A pure addition to lock in the public event types ahead of the B1b cutover.
 */

/**
 * (1) Content-change notification — only the renderer subscribes to this. Plays the same role as
 * VoxelWorld's `WorldChange` (carrying only the fact "the index's contents changed"), but **is not
 * type-compatible** — `WorldChange` has `keys: readonly string[]`, while this has `cells: readonly Cell[]`.
 *
 * In B1b, the 3 renderer implementations' (VoxelMesh / VoxelEdges / DimModelMesh) `onWorldChange`
 * are rewritten to receive this type directly. A boundary adapter that converts to keys is not
 * used — having 2 representations run in parallel would blur which is the source of truth, and
 * since the renderer currently buffers `event.keys` into a Set and re-runs `parseCellKey` on it
 * downstream, passing a Cell directly cuts out a round trip.
 */
export type WorldIndexChange =
  | { readonly kind: 'cells'; readonly cells: readonly Cell[] }
  | { readonly kind: 'replaceAll' };

/**
 * (2) Lifecycle notification — Selection / SelectionOverlay subscribe to this. By the time it's
 * received, the index swap has already completed (contract).
 *
 * The reason this is a separate type from (1) is that they're separate facts.
 * In a staged voxel commit, scene/index are already in their final position as of preview time, so
 * the renderer must not be re-notified of a content change, while Selection must always be told
 * the old-ref → new-ref remap. Collapsing this into a single union and using `cells: []` as
 * metadata-only would make each subscriber's interpretation of the empty array diverge.
 *
 * The `source` field that used to be attached to `preview` / `restore` was removed in rev.8. Group
 * drag became a ghost preview (doesn't move the source of truth), removing preview/restore on the
 * transform side, leaving voxel-session as the only option — so it carried no information as a
 * type. Bring the discriminant back if a preview source that needs consumer branching actually reappears.
 */
export type SceneBatchChange =
  | { readonly phase: 'preview' }
  | { readonly phase: 'commit'; readonly refRemap?: CellRefRemap }
  | { readonly phase: 'restore' };

/** Per-owner projection parameters. A snapshot as of rebuild time; unaffected by later direct edits to the tree */
interface OwnerState {
  /** Rank in paint order (smaller = further back). Determines the stack insertion position */
  readonly rank: number;
  /** Parent owner (null if directly under root). Needed to determine a blank cell's scope of effect */
  readonly parentId: OwnerId;
  readonly transform: ResolvedTransform;
  readonly effectiveHidden: boolean;
  readonly effectiveLocked: boolean;
}

/** A single owner-local cell's change. `after: null` = deletion */
export interface OwnerVoxelChange {
  readonly owner: OwnerId;
  readonly localKey: CellKey;
  readonly after: number | null;
}

/**
 * WorldIndex's read contract. Pass this type to renderer / picking / selection so that the update
 * methods (rebuildFromScene / applyVoxelChanges / notifyBatch) cannot be called at the type level
 * (same policy as VoxelWorld ↔ WorldReader). Since it extends WorldReader, existing world-read
 * paths can be swapped in as-is.
 */
export interface WorldIndexReader extends WorldReader {
  /** Every entry projected onto this world coordinate (including hidden), back-to-front. The return value is a defensive copy */
  stackAt(world: Cell): readonly ProjectionEntry[];
  /** The frontmost non-hidden entry. Used by place / erase / pick's DDA */
  winnerRefAt(world: Cell): ProjectionEntry | null;
  /**
   * Resolution for selection. Scans front-to-back, returning the first entry that is non-hidden and
   * not effectiveLocked. This path is the only one that lets a locked group be "visible but
   * unselectable, passing through to what's below" — putting the returned ref straight into the
   * Hit preserves "which ref underneath was selected."
   */
  selectableRefAt(world: Cell): ProjectionEntry | null;
  /** The winner's owner (facade for display / count purposes). Not used for resolving a mutation target */
  ownerAtWorld(world: Cell): OwnerId;
  /** Whether this world coordinate has entries but all are hidden, making it invisible */
  isWorldCellHidden(world: Cell): boolean;
  /** Whether the winner's owner is locked (including ancestor lock) */
  isWorldCellLocked(world: Cell): boolean;
  /**
   * Enumerates the world coordinates of placed blank cells.
   *
   * **Cannot be obtained via `entries()`.** That one follows the winner contract, and a blank never
   * becomes a winner (a hollowed-out coordinate has a null winner). Things that aren't drawn don't
   * produce coordinates either, so the "display" side needs a separate channel to ask (the outline
   * feature).
   *
   * A blank inside a hidden group is not emitted (collapsing it in the layers panel also removes
   * its outline). **Whether it's actually having an effect is not asked** — a blank that's fallen
   * inside another blank's scope and stopped having an effect is still shown, since from the
   * placer's perspective "it's there."
   */
  voidCells(): IterableIterator<Cell>;
  /** A ref's current projection target. The reverse lookup used to re-project the selection after a structural change. Null if it's gone */
  worldOf(ref: CellRef): Cell | null;
  subscribe(fn: (event: WorldIndexChange) => void): Unsubscribe;
  subscribeBatch(fn: (event: SceneBatchChange) => void): Unsubscribe;
}

const EMPTY_STACK: readonly ProjectionEntry[] = Object.freeze([]);

/**
 * Whether this stack contains a "visible blank".
 * Even if multiple blanks are stacked at the same world coordinate, one outline is enough, so this just returns a boolean.
 */
function hasVisibleVoid(stack: readonly ProjectionEntry[]): boolean {
  return stack.some((entry) => !entry.effectiveHidden && isVoidCell(entry.raw));
}

export class WorldIndex implements WorldIndexReader {
  /** worldKey → all entries in paint order (back-to-front), including hidden */
  private stacks = new Map<CellKey, ProjectionEntry[]>();
  private winnerMap = new Map<CellKey, ProjectionEntry>();
  /** CellRefKey → worldKey reverse lookup (for worldOf) */
  private refToWorld = new Map<CellRefKey, CellKey>();
  private owners = new Map<OwnerId, OwnerState>();
  /** Blank scope of effect. Built from the owner snapshot as of rebuild time; the same one is used for incremental updates too */
  private voidHidesOwner: VoidHidesOwner = makeVoidHidesOwner(() => null);
  /**
   * worldKeys that contain a visible blank cell. **Maintained together with the stack.**
   *
   * Scanning every stack on every `voidCells()` call would scan the entire world on every ordinary
   * single-cell edit, even with zero blanks (since the outline follows world changes without
   * filtering by kind). Updated alongside the source of truth so enumeration cost stays
   * proportional to the number of blank coordinates.
   */
  private voidKeys = new Set<CellKey>();

  private readonly contentEmitter = createEmitter<WorldIndexChange>();
  private readonly batchEmitter = createEmitter<SceneBatchChange>();

  private constructor(
    private readonly shapeOf: (catalogIndex: number) => Shape | undefined,
    private readonly resolveLocalRaw: LocalRawResolver,
  ) {}

  static fromScene(
    scene: EditorSceneReader,
    shapeOf: (catalogIndex: number) => Shape | undefined,
    resolveLocalRaw: LocalRawResolver = (_ref, raw) => raw,
  ): WorldIndex {
    const index = new WorldIndex(shapeOf, resolveLocalRaw);
    index.rebuildFromScene(scene);
    return index;
  }

  subscribe(fn: (event: WorldIndexChange) => void): Unsubscribe {
    return this.contentEmitter.subscribe(fn);
  }

  subscribeBatch(fn: (event: SceneBatchChange) => void): Unsubscribe {
    return this.batchEmitter.subscribe(fn);
  }

  /**
   * Notifies the lifecycle of a transaction / session. Called even for a commit with no content
   * change to the index (a staged voxel / transform commit that already reached its final state at
   * preview time), in order to deliver the remap to Selection. The contract is that the caller
   * (Document) calls this after finishing the index swap.
   */
  notifyBatch(event: SceneBatchChange): void {
    this.batchEmitter.notify(event);
  }

  // ---- updates (called only by Document, at transaction boundaries) ----

  /**
   * After a structural op (group create/delete/reparent/transform/visibility-lock toggle/load),
   * fully rebuilds from the final scene. Takes the projection and paint order straight from
   * buildSceneProjection's result.
   *
   * Since the new state is completed before swapping, even if projection throws mid-way (unknown
   * catalog / owner consistency violation / transform falling off the grid), the existing index is left completely unchanged.
   */
  rebuildFromScene(scene: EditorSceneReader): void {
    const projection = buildSceneProjection(scene, this.shapeOf, this.resolveLocalRaw);

    const owners = new Map<OwnerId, OwnerState>();
    const order = ownerPaintOrder(scene.tree);
    for (let rank = 0; rank < order.length; rank++) {
      const owner = order[rank]!;
      owners.set(owner, {
        rank,
        parentId: owner === null ? null : (scene.tree.getNode(owner)?.parentId ?? null),
        transform: scene.tree.transformChain(owner),
        effectiveHidden: scene.tree.isHiddenEffective(owner),
        effectiveLocked: scene.tree.isLockedEffective(owner),
      });
    }

    // The blank's scope of effect is also pulled **from the rebuild-time snapshot**. Without
    // the same treatment as the other projection parameters, an incremental update after this
    // point would end up looking at the new tree alone if the tree is edited directly
    const voidHidesOwner = makeVoidHidesOwner((ownerId) => owners.get(ownerId)?.parentId ?? null);

    const stacks = new Map<CellKey, ProjectionEntry[]>();
    const winnerMap = new Map<CellKey, ProjectionEntry>();
    const refToWorld = new Map<CellRefKey, CellKey>();
    const voidKeys = new Set<CellKey>();
    for (const [worldKey, stack] of projection.allStacks()) {
      // projection's stack is frozen. Hold a mutable copy since it gets rewritten by later incremental updates
      stacks.set(worldKey, [...stack]);
      const winner = winnerOfStack(stack, voidHidesOwner);
      if (winner) winnerMap.set(worldKey, winner);
      if (hasVisibleVoid(stack)) voidKeys.add(worldKey);
      for (const entry of stack) refToWorld.set(makeCellRefKey(entry.ref), worldKey);
    }

    this.owners = owners;
    this.voidHidesOwner = voidHidesOwner;
    this.voidKeys = voidKeys;
    this.stacks = stacks;
    this.winnerMap = winnerMap;
    this.refToWorld = refToWorld;
    this.contentEmitter.notify({ kind: 'replaceAll' });
  }

  /**
   * Incrementally applies voxel writes (owner-local). Only the affected world coordinates' stacks
   * are rebuilt, and `cells` is notified once, in a batch.
   *
   * Not used for a transaction that includes a structural op (rebuildFromScene is the only option
   * there) — to structurally avoid the incident of applying incrementally against a stale
   * transform / rank cache.
   *
   * Same as rebuildFromScene: all affected stacks are fully assembled before swapping. Even if it
   * throws partway through (unknown owner / unknown catalog / out of grid), the index is not partially modified.
   */
  applyVoxelChanges(changes: readonly OwnerVoxelChange[]): void {
    // Input validation runs over every change before assembling the touched stacks. Rejecting while
    // assembling would let a non-canonical localKey slip through in a form where "the stack
    // reflects the parsed coordinate, but only the reverse lookup gets the non-canonical ref key" —
    // creating an inconsistency where the canonical ref's worldOf() keeps pointing at the old
    // coordinate while only stack/winner change
    for (const change of changes) {
      assertCanonicalLocalCellKey(change.localKey, 'WorldIndex.applyVoxelChanges');
      if (!this.owners.has(change.owner)) {
        throw new Error(`Incremental update to WorldIndex targeting an unknown owner: ${String(change.owner)} (rebuildFromScene is required after a structural change)`);
      }
    }

    const touchedStacks = new Map<CellKey, ProjectionEntry[]>();
    const touchedRefs = new Map<CellRefKey, CellKey | null>();
    const worldCells: Cell[] = [];

    for (const change of changes) {
      const owner = this.owners.get(change.owner)!;
      const localCell = parseCellKey(change.localKey);
      const worldCell = applyTransform(localCell, owner.transform);
      const worldKey = makeCellKey(worldCell[0], worldCell[1], worldCell[2]);

      let stack = touchedStacks.get(worldKey);
      if (!stack) {
        stack = [...(this.stacks.get(worldKey) ?? [])];
        touchedStacks.set(worldKey, stack);
      }
      // Since transform is injective, a single world coordinate has at most one entry per owner
      const existing = stack.findIndex((e) => e.ref.ownerId === change.owner);
      if (existing !== -1) stack.splice(existing, 1);

      if (change.after !== null) {
        const ref: CellRef = { ownerId: change.owner, localCell };
        const raw = rotateRaw(this.resolveLocalRaw(ref, change.after, worldCell), owner.transform.angleSteps, this.shapeOf);
        const entry: ProjectionEntry = Object.freeze({
          ref: Object.freeze({ ownerId: change.owner, localCell: Object.freeze(localCell) }),
          worldCell: Object.freeze(worldCell),
          raw,
          effectiveHidden: owner.effectiveHidden,
        });
        this.insertByRank(stack, entry, owner.rank);
        // The reverse-lookup key is built from the entry.ref that went into the stack (the same
        // generator function as the rebuild path). Building the key from the input string via a
        // separate path would leave room for the stack and the reverse lookup to diverge in representation
        touchedRefs.set(makeCellRefKey(entry.ref), worldKey);
      } else {
        touchedRefs.set(makeCellRefKey({ ownerId: change.owner, localCell }), null);
      }
      worldCells.push(Object.freeze(worldCell));
    }

    for (const [worldKey, stack] of touchedStacks) {
      if (stack.length === 0) {
        this.stacks.delete(worldKey);
        this.winnerMap.delete(worldKey);
        this.voidKeys.delete(worldKey);
        continue;
      }
      this.stacks.set(worldKey, stack);
      const winner = winnerOfStack(stack, this.voidHidesOwner);
      if (winner) this.winnerMap.set(worldKey, winner);
      else this.winnerMap.delete(worldKey);
      // Only judge the worldKeys that were touched (scan volume stays proportional to the diff, doesn't grow even in a world with zero blanks)
      if (hasVisibleVoid(stack)) this.voidKeys.add(worldKey);
      else this.voidKeys.delete(worldKey);
    }
    for (const [refKey, worldKey] of touchedRefs) {
      if (worldKey === null) this.refToWorld.delete(refKey);
      else this.refToWorld.set(refKey, worldKey);
    }
    this.contentEmitter.notify({ kind: 'cells', cells: worldCells });
  }

  /** The stack is in ascending rank order (back-to-front). No two entries share a rank (unique per owner) */
  private insertByRank(stack: ProjectionEntry[], entry: ProjectionEntry, rank: number): void {
    let at = stack.length;
    while (at > 0 && this.rankOf(stack[at - 1]!) > rank) at--;
    stack.splice(at, 0, entry);
  }

  private rankOf(entry: ProjectionEntry): number {
    // The owner of any entry on the stack has always already been rebuilt (= exists in owners)
    return this.owners.get(entry.ref.ownerId)!.rank;
  }

  // ---- reads ----

  get size(): number {
    return this.winnerMap.size;
  }

  get(x: number, y: number, z: number): number | null {
    return this.winnerMap.get(makeCellKey(x, y, z))?.raw ?? null;
  }

  has(x: number, y: number, z: number): boolean {
    return this.winnerMap.has(makeCellKey(x, y, z));
  }

  *entries(): IterableIterator<[number, number, number, number]> {
    for (const entry of this.winnerMap.values()) {
      yield [entry.worldCell[0], entry.worldCell[1], entry.worldCell[2], entry.raw];
    }
  }

  *voidCells(): IterableIterator<Cell> {
    for (const key of this.voidKeys) yield parseCellKey(key);
  }

  bounds(): { min: Cell; max: Cell } | null {
    if (this.winnerMap.size === 0) return null;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const [x, y, z] of this.entries()) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
  }

  stackAt(world: Cell): readonly ProjectionEntry[] {
    const stack = this.stacks.get(makeCellKey(world[0], world[1], world[2]));
    // The internal array gets rewritten by incremental updates, so don't pass it through as-is
    // (avoid the index breaking from a caller mutation / handing out a snapshot whose contents change later)
    return stack ? Object.freeze([...stack]) : EMPTY_STACK;
  }

  winnerRefAt(world: Cell): ProjectionEntry | null {
    return this.winnerMap.get(makeCellKey(world[0], world[1], world[2])) ?? null;
  }

  selectableRefAt(world: Cell): ProjectionEntry | null {
    const stack = this.stacks.get(makeCellKey(world[0], world[1], world[2]));
    if (!stack) return null;
    for (let i = stack.length - 1; i >= 0; i--) {
      const entry = stack[i]!;
      if (entry.effectiveHidden) continue;
      // effectiveLocked reads the rebuild-time snapshot. Don't create the halfway state of
      // "stack/rank are the old snapshot but lock alone is live" (same treatment as effectiveHidden / transform)
      if (this.owners.get(entry.ref.ownerId)?.effectiveLocked) continue;
      return entry;
    }
    return null;
  }

  ownerAtWorld(world: Cell): OwnerId {
    return this.winnerMap.get(makeCellKey(world[0], world[1], world[2]))?.ref.ownerId ?? null;
  }

  isWorldCellHidden(world: Cell): boolean {
    const key = makeCellKey(world[0], world[1], world[2]);
    const stack = this.stacks.get(key);
    if (!stack || stack.length === 0) return false;
    return !this.winnerMap.has(key);
  }

  isWorldCellLocked(world: Cell): boolean {
    const winner = this.winnerMap.get(makeCellKey(world[0], world[1], world[2]));
    if (!winner) return false;
    return this.owners.get(winner.ref.ownerId)?.effectiveLocked ?? false;
  }

  worldOf(ref: CellRef): Cell | null {
    const worldKey = this.refToWorld.get(makeCellRefKey(ref));
    if (worldKey === undefined) return null;
    return Object.freeze(parseCellKey(worldKey));
  }
}
