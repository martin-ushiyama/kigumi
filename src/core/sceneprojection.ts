import type { Cell, CellKey } from './types';
import { makeCellKey, parseCellKey } from './types';
import type { CellRef, OwnerId } from './cellref';
import type { Shape } from './orientation';
import { applyTransform, rotateRaw, type ResolvedTransform } from './transform';
import { isVoidCell } from './orientation';
import { assertValidEditorScene, type EditorSceneReader } from './ownervoxels';
import { isValidCell } from './limits';

/**
 * SceneProjection: the single source of truth that projects the owner-local editing
 * model into world coordinates and resolves overlaps (multiple owners at the same world
 * coordinate) via paint order.
 * renderer / picking / export all use this projection and winner determination (never
 * reimplemented per layer).
 *
 * Immutable snapshot: buildSceneProjection() eagerly computes and freezes every entry from
 * the EditorScene at construction time. Rewriting the source tree/cells afterward never
 * changes the projection result (there's no API that could read a stale cache as "the
 * correct projection").
 */

/** CellRef's source of truth is cellref.ts (core's bottom layer). Re-exported here to preserve existing import paths */
export type { CellRef };

/**
 * Injection point that resolves a cell's raw value into "the raw value currently used for
 * display" (used to resolve live patterns).
 *
 * **World coordinates are passed too** — because pattern-fill designs are derived from
 * world coordinates. Both the projection and the incremental update already have world
 * coordinates computed at hand, so it's cheaper to pass them along than to have the resolver
 * re-derive the transform chain. Resolvers that don't need it can ignore the third argument.
 */
export type LocalRawResolver = (ref: CellRef, raw: number, worldCell: Cell) => number;

export interface ProjectionEntry {
  readonly ref: CellRef;
  /** World coordinates with transformChain already applied */
  readonly worldCell: Cell;
  /** Cell value with orientation already rotated to match the composed angleSteps */
  readonly raw: number;
  readonly effectiveHidden: boolean;
}

/**
 * The minimal tree-side port SceneProjection depends on. Doesn't depend on the entire
 * existing SceneTreeReader (including the old single-owner concepts like groupOfCell/
 * cellsOf). SceneTree structurally satisfies this port.
 */
export interface TransformTreeReader {
  getNode(id: string): { readonly parentId: string | null } | undefined;
  childrenOf(parentId: string | null): readonly string[];
  isHiddenEffective(id: string | null): boolean;
  transformChain(id: string | null): ResolvedTransform;
}

const EMPTY_STACK: readonly ProjectionEntry[] = Object.freeze([]);

/**
 * Returns the full paint order as an owner list (back→front). Cells directly under root
 * (owner=null) come furthest back; from there, childIds are walked pre-order, treating
 * front→back child order as back→front paint order (a cell directly under a parent sits at
 * the back of that parent's subtree, and later sibling subtrees sit further to the front).
 *
 * This one list is what decides everything for stackAt/winnerAt/winners. WorldIndex's
 * owner-rank cache is also built from this — so the order calculation is never
 * reimplemented anywhere else.
 */
export function ownerPaintOrder(tree: Pick<TransformTreeReader, 'childrenOf'>): OwnerId[] {
  const order: OwnerId[] = [null];
  const walk = (parentId: string | null): void => {
    for (const childId of tree.childrenOf(parentId)) {
      order.push(childId);
      walk(childId);
    }
  };
  walk(null);
  return order;
}

/**
 * Predicate that decides "which owner does this void cell hide".
 *
 * An injection point so `winnerOfStack` doesn't need to hold a reference to the tree
 * directly. `SceneProjection` builds this from a live tree, while `WorldIndex` builds it from
 * a snapshot at rebuild time, so the same rule can be supplied from different sources.
 */
export type VoidHidesOwner = (voidOwnerId: OwnerId, otherOwnerId: OwnerId) => boolean;

/**
 * The **single implementation** of void's effective scope.
 *
 * > A void cell never reaches outside the group it belongs to. What it hides is everything
 * > further back than it, within its **parent group's subtree** (sibling groups / their
 * > descendants / cells directly owned by the parent). If the parent is root, it affects
 * > everything (= a rectangular cut).
 *
 * The scope is the parent's subtree rather than "the group it's in" itself, because **within
 * the same group, void and a real block can never overlap the same world coordinate** (the
 * same local coordinate within one owner is disallowed, and transforms are shared). Scoping
 * to the owner itself would leave nothing left for it to hide.
 *
 * @param parentOf the owner's parent (null for something owned directly by root)
 */
export function makeVoidHidesOwner(parentOf: (ownerId: string) => OwnerId): VoidHidesOwner {
  return (voidOwnerId, otherOwnerId) => {
    // If the void cell is owned directly by root, its scope is root = everything
    const scope = voidOwnerId === null ? null : parentOf(voidOwnerId);
    if (scope === null) return true;
    for (let cur = otherOwnerId; cur !== null; cur = parentOf(cur)) {
      if (cur === scope) return true;
    }
    return false;
  };
}

/**
 * The winner of a stack (back→front) = **the frontmost, non-hidden, real block**.
 * The single implementation of the winner rule, shared by SceneProjection.build and
 * WorldIndex's incremental update (the winner rule lives in one shared helper).
 *
 * A void cell is never a winner. Walking front to back, whenever a void is hit, its
 * scope's back entries are skipped and the search continues. **A coordinate that becomes a
 * hole has a null winner** — both the renderer and export read the winner, so "nothing here"
 * is communicated consistently to both.
 *
 * If a void cell itself falls within another void's scope, that void has no effect (it gets
 * skipped before it's ever considered).
 */
export function winnerOfStack(
  stack: readonly ProjectionEntry[],
  voidHidesOwner: VoidHidesOwner,
): ProjectionEntry | null {
  /** Scopes of void cells found on the front side (owners within these are hidden) */
  const voidOwners: OwnerId[] = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    const entry = stack[i]!;
    if (entry.effectiveHidden) continue;
    if (voidOwners.some((voidOwner) => voidHidesOwner(voidOwner, entry.ref.ownerId))) continue;
    if (isVoidCell(entry.raw)) {
      voidOwners.push(entry.ref.ownerId);
      continue;
    }
    return entry;
  }
  return null;
}

export class SceneProjection {
  /** worldKey → the full paint-order (back→front) entry list (hidden included). Arrays are already frozen */
  private constructor(
    private readonly stacks: ReadonlyMap<CellKey, readonly ProjectionEntry[]>,
    private readonly winnerMap: ReadonlyMap<CellKey, ProjectionEntry>,
  ) {}

  /** All entries projected at this world coordinate (hidden included, tagged with effectiveHidden), back→front */
  stackAt(world: Cell): readonly ProjectionEntry[] {
    return this.stacks.get(makeCellKey(world[0], world[1], world[2])) ?? EMPTY_STACK;
  }

  /** The frontmost non-hidden entry at this world coordinate. null if every entry is hidden */
  winnerAt(world: Cell): ProjectionEntry | null {
    return this.winnerMap.get(makeCellKey(world[0], world[1], world[2])) ?? null;
  }

  /** Exactly one entry per world coordinate — the frontmost non-hidden entry (the form renderer / export consume) */
  *winners(): IterableIterator<[Cell, ProjectionEntry]> {
    for (const [key, entry] of this.winnerMap) {
      yield [parseCellKey(key), entry];
    }
  }

  /**
   * Enumerates the stack for every world key (hidden included, each stack back→front).
   * The entry point for WorldIndex to ingest this projection result directly on
   * a full rebuild after a structural change — so projection and paint order are never
   * reimplemented on the WorldIndex side.
   */
  *allStacks(): IterableIterator<[CellKey, readonly ProjectionEntry[]]> {
    yield* this.stacks;
  }

  static build(
    scene: EditorSceneReader,
    shapeOf: (catalogIndex: number) => Shape | undefined,
    resolveLocalRaw: LocalRawResolver = (_ref, raw) => raw,
  ): SceneProjection {
    assertValidEditorScene(scene);

    const ownerOrder = ownerPaintOrder(scene.tree);

    const stacks = new Map<CellKey, ProjectionEntry[]>();
    const winnerMap = new Map<CellKey, ProjectionEntry>();

    for (const owner of ownerOrder) {
      const resolved = scene.tree.transformChain(owner);
      const hidden = scene.tree.isHiddenEffective(owner);
      for (const [localKey, raw] of scene.cells.entriesOf(owner)) {
        const localCell = parseCellKey(localKey);
        const ref: CellRef = { ownerId: owner, localCell };
        const worldCell = applyTransform(localCell, resolved);
        const rotated = rotateRaw(resolveLocalRaw(ref, raw, worldCell), resolved.angleSteps, shapeOf);
        const entry: ProjectionEntry = Object.freeze({
          ref: Object.freeze({ ownerId: owner, localCell: Object.freeze(localCell) }),
          worldCell: Object.freeze(worldCell),
          raw: rotated,
          effectiveHidden: hidden,
        });
        const worldKey = makeCellKey(worldCell[0], worldCell[1], worldCell[2]);
        let stack = stacks.get(worldKey);
        if (!stack) {
          stack = [];
          stacks.set(worldKey, stack);
        }
        stack.push(entry);
      }
    }

    // Void's effective scope is also part of the winner rule. Parents are looked up from the live tree
    const voidHidesOwner = makeVoidHidesOwner((ownerId) => scene.tree.getNode(ownerId)?.parentId ?? null);

    const frozenStacks = new Map<CellKey, readonly ProjectionEntry[]>();
    for (const [key, stack] of stacks) {
      frozenStacks.set(key, Object.freeze(stack));
      // winnerOfStack is the single implementation of the winner rule (shared with WorldIndex's incremental update)
      const winner = winnerOfStack(stack, voidHidesOwner);
      if (winner) winnerMap.set(key, winner);
    }
    return new SceneProjection(frozenStacks, winnerMap);
  }
}

export function buildSceneProjection(
  scene: EditorSceneReader,
  shapeOf: (catalogIndex: number) => Shape | undefined,
  resolveLocalRaw?: LocalRawResolver,
): SceneProjection {
  return SceneProjection.build(scene, shapeOf, resolveLocalRaw);
}

/**
 * Invariants for the runtime scene. Where `assertValidEditorScene`
 * only checks the consistency of owner references and owner-local coordinates, this checks
 * **whether the post-projection world coordinates are in range**, across every entry
 * including hidden/occluded ones.
 *
 * We consistently allow negative values in owner-local space but never allow out-of-range
 * world space at runtime (rotate is rejected by pre-validation, translate is clamped). Since
 * Document accepts arbitrary owner-local voxel ops and `setGroupTransform` as a public API,
 * bypassing the UI helpers could produce a scene that only goes out of range after
 * projection — this function is what closes off that entry point.
 *
 * Call this **before** the scene/index swap, history push, and notification. On failure, the
 * caller keeps scene / index / history / notifications completely unchanged.
 */
export function assertValidRuntimeScene(scene: EditorSceneReader, shapeOf: (catalogIndex: number) => Shape | undefined): void {
  const projection = buildSceneProjection(scene, shapeOf); // Owner consistency is validated inside this call
  for (const [, stack] of projection.allStacks()) {
    for (const entry of stack) {
      const [x, y, z] = entry.worldCell;
      if (!isValidCell(x, y, z)) {
        const owner = entry.ref.ownerId ?? '(root)';
        throw new Error(
          `runtime scene world-range violation: owner "${owner}"'s local ${JSON.stringify(entry.ref.localCell)} ` +
            `projected to world (${x}, ${y}, ${z}) (out-of-range is never allowed, including hidden/occluded entries)`,
        );
      }
    }
  }
}
