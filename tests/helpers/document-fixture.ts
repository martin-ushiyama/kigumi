import { makeCellRefKey, type CellRef, type OwnerId } from '../../src/core/cellref';
import { Document, type WorldEditIntent } from '../../src/core/document';
import type { Shape } from '../../src/core/orientation';
import { localKeyOf } from '../../src/core/ownerlocal';
import { OwnerVoxelStore, type EditorScene } from '../../src/core/ownervoxels';
import { SceneTree, type GroupNode } from '../../src/core/scenetree';
import { makeCellKey, parseCellKey, type Cell, type CellKey } from '../../src/core/types';
import type { WorldIndex } from '../../src/core/worldindex';
import {
  cellSelectionOf,
  normalizeSelection,
  type NormalizedSelection,
  type SelectedCell,
  type Selection,
} from '../../src/editor/selection';

/**
 * Test-only Document extension.
 *
 * Production code only touches Document's Reader type (read-only), but test
 * setup needs low-level operations that build an arbitrary initial state
 * "without polluting history". The protected concrete fields (`_scene` / `_index`)
 * are accessible from subclasses, so DocumentFixture alone holds a window onto them.
 *
 * **Always rebuild the WorldIndex** after a direct mutation — leaving the derived
 * index stale would let tests create a state impossible in production ("present
 * in scene but invisible from world"), which means the tests would stop guarding
 * the implementation.
 */
export class DocumentFixture extends Document {
  constructor(shapeOf: (catalogIndex: number) => Shape | undefined = () => 'full') {
    super({ tree: new SceneTree(), cells: new OwnerVoxelStore() }, shapeOf);
  }

  /** Test-only: direct access to the concrete EditorScene */
  get rawScene(): EditorScene {
    return this._scene;
  }

  /** Test-only: direct access to the concrete SceneTree */
  get rawTree(): SceneTree {
    return this._scene.tree;
  }

  /** Test-only: direct access to the concrete OwnerVoxelStore */
  get rawCells(): OwnerVoxelStore {
    return this._scene.cells;
  }

  /** Test-only: direct access to the concrete WorldIndex (e.g. observing notification counts) */
  get rawIndex(): WorldIndex {
    return this._index;
  }

  private resync(): this {
    this._index.rebuildFromScene(this._scene);
    return this;
  }

  /**
   * Place unclassified (owner = null) cells directly at world coordinates. Root has no
   * transform, so local coordinates = world coordinates.
   */
  setCells(cells: Iterable<[number, number, number, number]>): this {
    this._scene.cells.clear();
    for (const [x, y, z, v] of cells) this._scene.cells.set(null, makeCellKey(x, y, z), v);
    return this.resync();
  }

  /** Place owner-local cells directly (for setting up groups that have a transform) */
  setOwnerCells(owner: OwnerId, entries: Iterable<[CellKey, number]>): this {
    for (const [key, v] of entries) this._scene.cells.set(owner, key, v);
    return this.resync();
  }

  /** Insert a group node directly (without polluting history) */
  insertGroup(node: GroupNode, index = 0): this {
    this._scene.tree.insertNode(node, index);
    return this.resync();
  }

  /**
   * Change a world cell's ownership directly (without polluting history).
   *
   * **For moves between owners with no transform (identity) only** — it just reassigns
   * without transforming local coordinates, so it can't be used to set up a rotated group
   * (use `setOwnerCells` for that).
   *
   * If no cell exists at that coordinate, a new one is created with `defaultValue`. The old
   * `SceneTree.setMembership` could register membership independent of the cell's substance,
   * but in the owner-local model "the owner holding the cell" *is* the membership, so
   * membership without substance can't be represented.
   */
  setCellMembership(worldKey: CellKey, groupId: OwnerId, defaultValue = 1): this {
    const cell = parseCellKey(worldKey);
    const canonical = makeCellKey(cell[0], cell[1], cell[2]);
    for (const [owner, localKey, value] of [...this._scene.cells.allEntries()]) {
      if (localKey !== canonical) continue;
      this._scene.cells.delete(owner, localKey);
      this._scene.cells.set(groupId, localKey, value);
      return this.resync();
    }
    this._scene.cells.set(groupId, canonical, defaultValue);
    return this.resync();
  }

  /** Simulate a direct stage call during a drag (doesn't accumulate history, equivalent to production's EditSession.stagePreview) */
  stageRaw(owner: OwnerId, localKey: CellKey, value: number | null): this {
    if (value === null) this._scene.cells.delete(owner, localKey);
    else this._scene.cells.set(owner, localKey, value);
    return this.resync();
  }

  /** Test-only: undo history depth (window onto the private undoStack) */
  get undoDepth(): number {
    return (this as unknown as { undoStack: unknown[] }).undoStack.length;
  }

  // ---- Read shortcuts (sugar for writing test intent concisely) ----

  /** The owner of the winner at that world coordinate (successor to the old `tree.groupOfCell`) */
  ownerAt(x: number, y: number, z: number): OwnerId {
    return this.index.ownerAtWorld([x, y, z]);
  }

  /** The winner ref at that world coordinate. Throws if none (to make test intent explicit) */
  refAt(x: number, y: number, z: number): CellRef {
    const entry = this.index.winnerRefAt([x, y, z]);
    if (!entry) throw new Error(`refAt: no winner at (${x}, ${y}, ${z})`);
    return entry.ref;
  }

  /** The owner-local raw value (pre-projection) */
  localValueOf(r: CellRef): number | null {
    return this._scene.cells.get(r.ownerId, localKeyOf(r)) ?? null;
  }

  /**
   * The `SelectedCell` at that world coordinate. If a winner exists, uses its ref; otherwise
   * synthesizes it as "the same-coordinate cell directly under root (owner = null)" — since
   * root has no transform, local coordinates = world coordinates, so this is usable in tests
   * that want to build selection state without placing any actual cell.
   */
  cellAt(x: number, y: number, z: number): SelectedCell {
    const entry = this.index.winnerRefAt([x, y, z]);
    return { ref: entry ? entry.ref : { ownerId: null, localCell: [x, y, z] }, worldCell: [x, y, z] };
  }

  /**
   * Build a **normalized** cells selection from a list of world coordinates (same resolution
   * rule as `cellAt`). builder / snapshot only accept `NormalizedSelection`, so tests go
   * through it too.
   */
  cellSelection(...worldCells: Array<[number, number, number]>): NormalizedSelection {
    return normalizeSelection(this.tree, cellSelectionOf(worldCells.map((c) => this.cellAt(c[0], c[1], c[2]))));
  }

  /** Build a normalized cells selection from a list of refs (for when you want to explicitly pass a locked / hidden ref) */
  refSelection(...refs: CellRef[]): NormalizedSelection {
    return normalizeSelection(
      this.tree,
      cellSelectionOf(refs.map((r) => ({ ref: r, worldCell: this.index.worldOf(r) ?? [0, 0, 0] }))),
    );
  }

  /** Build a normalized groups selection from a list of group ids (falls to existence / uniqueness / outermost) */
  groupSelection(...ids: string[]): NormalizedSelection {
    return normalizeSelection(this.tree, { kind: 'groups', ids });
  }

  /** Normalized "no selection" */
  noneSelection(): NormalizedSelection {
    return normalizeSelection(this.tree, { kind: 'none' });
  }
}

/** Shorthand for a `WorldEditIntent` place */
export function place(x: number, y: number, z: number, afterWorldRaw: number): WorldEditIntent {
  return { kind: 'place', worldCell: [x, y, z], afterWorldRaw };
}

/** Shorthand for a `WorldEditIntent` erase */
export function erase(x: number, y: number, z: number): WorldEditIntent {
  return { kind: 'erase', worldCell: [x, y, z] };
}

/** Shorthand for a `WorldEditIntent` overwrite */
export function overwrite(x: number, y: number, z: number, afterWorldRaw: number): WorldEditIntent {
  return { kind: 'overwrite', worldCell: [x, y, z], afterWorldRaw };
}

/** Shorthand for an owner-local ref */
export function ref(ownerId: OwnerId, x: number, y: number, z: number): CellRef {
  return { ownerId, localCell: [x, y, z] };
}

/** Shorthand for a SelectedCell (for tests where the caller is expected to know worldCell) */
export function selected(r: CellRef, worldCell: Cell): SelectedCell {
  return { ref: r, worldCell };
}

/** The set of refKeys contained in a cells selection (order-independent comparison) */
export function selectedRefKeys(sel: Selection): string[] {
  if (sel.kind !== 'cells') return [];
  return [...sel.cells.values()].map((c) => makeCellRefKey(c.ref)).sort();
}
