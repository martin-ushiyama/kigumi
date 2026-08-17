import { assertCanonicalLocalCellKey, type CellKey } from './cell';
import type { OwnerId } from './cellref';
import type { PatternPaintReader, PatternPaintStore } from './patternpaint';
import type { SceneTree, SceneTreeReader } from './scenetree';

/**
 * Owner-local cell storage. owner = group id, null = directly under root (unassigned cell).
 *
 * Plays a different role from VoxelWorld (the source of truth for world coordinates,
 * 1cell=1value): this one is the source of truth for the editing model where "each
 * owner holds a sparse cell set in its own local coordinate system", and it can
 * represent overlaps where multiple owners project onto the same world coordinate.
 * Never used standalone — it's always bundled into an EditorScene, consumed by
 * SceneProjection / v3 persistence (so as not to create an isolated second source of
 * truth design review).
 */

/** OwnerId's source of truth is cellref.ts (core's lowest layer). Re-exported here to preserve existing import paths */
export type { OwnerId };

/** Read-only contract. SceneProjection depends only on this (not on the concrete store) */
export interface OwnerCellReader {
  get(owner: OwnerId, key: CellKey): number | undefined;
  has(owner: OwnerId, key: CellKey): boolean;
  entriesOf(owner: OwnerId): IterableIterator<[CellKey, number]>;
  owners(): IterableIterator<OwnerId>;
  /** All entries across all owners. So snapshot / full-replace / v3 export don't each write a duplicate owner loop */
  allEntries(): IterableIterator<[OwnerId, CellKey, number]>;
}

/** null can be used directly as a Map key (JS's Map keeps null as a distinct key) */
export class OwnerVoxelStore implements OwnerCellReader {
  private byOwner = new Map<OwnerId, Map<CellKey, number>>();

  get(owner: OwnerId, key: CellKey): number | undefined {
    return this.byOwner.get(owner)?.get(key);
  }

  has(owner: OwnerId, key: CellKey): boolean {
    return this.byOwner.get(owner)?.has(key) ?? false;
  }

  set(owner: OwnerId, key: CellKey, value: number): void {
    // CellKey is just a string alias, so we validate at runtime that it's a canonical
    // 3-integer key — letting an invalid key through would let the serializer write out
    // a corrupted v3 with NaN/null coordinates. Validation uses the
    // shared implementation in cell.ts (the isValidLocalCell criteria, which allows
    // negative y since these are owner-local coordinates)
    assertCanonicalLocalCellKey(key, 'OwnerVoxelStore.set');
    let cells = this.byOwner.get(owner);
    if (!cells) {
      cells = new Map();
      this.byOwner.set(owner, cells);
    }
    cells.set(key, value);
  }

  delete(owner: OwnerId, key: CellKey): void {
    const cells = this.byOwner.get(owner);
    if (!cells) return;
    cells.delete(key);
    if (cells.size === 0) this.byOwner.delete(owner);
  }

  *entriesOf(owner: OwnerId): IterableIterator<[CellKey, number]> {
    const cells = this.byOwner.get(owner);
    if (!cells) return;
    yield* cells.entries();
  }

  *owners(): IterableIterator<OwnerId> {
    yield* this.byOwner.keys();
  }

  /**
   * Enumerate all entries as `[owner, localKey, value]`. So Document's
   * snapshot / v3 export don't need to write a duplicate loop of "call entriesOf for
   * each owner". Enumeration order is owner insertion order (not paint order) — use
   * `ownerPaintOrder` alongside this when order matters.
   */
  *allEntries(): IterableIterator<[OwnerId, CellKey, number]> {
    for (const [owner, cells] of this.byOwner) {
      for (const [key, value] of cells) yield [owner, key, value];
    }
  }

  /**
   * Full replace. Used for project loading and Document's rollback (restoreAll).
   * Goes through `set`, so canonical key validation runs through the same single implementation.
   */
  replaceAll(entries: Iterable<[OwnerId, CellKey, number]>): void {
    this.byOwner.clear();
    for (const [owner, key, value] of entries) this.set(owner, key, value);
  }

  clear(): void {
    this.byOwner.clear();
  }

  get size(): number {
    let total = 0;
    for (const cells of this.byOwner.values()) total += cells.size;
    return total;
  }
}

/**
 * The editing model's aggregate. tree (hierarchy + transform + order) and cells
 * (owner-local cells) are always passed together as a pair. v3 load/serialize and
 * SceneProjection use only this type for input/output — no ad-hoc path that passes
 * (tree, cells) separately is created.
 */
export interface EditorScene {
  readonly tree: SceneTree;
  readonly cells: OwnerVoxelStore;
  readonly patterns?: PatternPaintStore;
}

/**
 * A read-only view of EditorScene. Now that Document owns the authoritative
 * EditorScene, editor / persistence / derived indexes only need to "read" — passing the
 * concrete store would open a write path that bypasses Document (same policy as
 * VoxelWorld <-> WorldReader).
 *
 * Projection (`buildSceneProjection`) / invariant validation / v3 export all only read,
 * so their argument types are aligned to this.
 */
export interface EditorSceneReader {
  readonly tree: SceneTreeReader;
  readonly cells: OwnerCellReader;
  readonly patterns?: PatternPaintReader;
}

/**
 * Validate an EditorScene's owner consistency. Throws if any cell's owner is a group
 * that doesn't exist in the tree (never silently ignored). Must be called at all 3
 * entry points — loadProjectV3 / buildSceneProjection / serializeProjectV3 (from the design
 * review: missing it only in serialize would leave room to export a corrupted v3 that
 * mistakenly demoted cells to root).
 */
export function assertValidEditorScene(scene: EditorSceneReader): void {
  for (const owner of scene.cells.owners()) {
    if (owner !== null && !scene.tree.getNode(owner)) {
      throw new Error(`EditorScene owner consistency violation: group "${owner}", which does not exist in the tree, owns cells`);
    }
  }
}
