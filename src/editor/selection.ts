import { makeCellRefKey, type CellRef, type CellRefKey, type CellRefRemap } from '../core/cellref';
import type { Document } from '../core/document';
import { createEmitter, type Unsubscribe } from '../core/emitter';
import { refsOfSubtree } from '../core/ownerlocal';
import type { Cell } from '../core/types';
import { makeCellKey } from '../core/types';
import type { SceneBatchChange, WorldIndexReader } from '../core/worldindex';

/** Change notification event kind for SelectionStore. Only one kind since the only change path is set(). */
export type SelectionChange = { kind: 'change' };

/**
 * A single selected cell.
 *
 * **Identity is `ref` (owner + owner-local cell); `worldCell` is a derived value.** The
 * world coordinate is only unique for that instant's display — after a winner swap
 * (hide / reorder / transform), the same world key can point to a different owner's
 * cell. Marquee, bbox, and overlay rendering may use worldCell, but mutation
 * (delete, move, change block type) must always use ref.
 */
export interface SelectedCell {
  readonly ref: CellRef;
  readonly worldCell: Cell;
}

/**
 * Selection state. Mixing kinds is not allowed (Ctrl+click across kinds replaces the
 * selection — that's selecttool.ts's responsibility). Dead group ids/refs can remain
 * after undo/redo/load, so this subscribes to WorldIndex lifecycle notifications
 * (`SceneBatchChange`) to self-validate.
 */
export type Selection =
  | { kind: 'none' }
  | { kind: 'groups'; ids: string[] }
  | { kind: 'cells'; cells: ReadonlyMap<CellRefKey, SelectedCell> };

declare const NORMALIZED: unique symbol;

/**
 * A **normalized** Selection (from a second review pass).
 *
 * - `groups`: exists in the tree / no duplicates / not a descendant of another selected
 *   id (outermost only) / not hidden or locked
 * - `cells`: the ref's owner is not hidden or locked
 *
 * The only construction points are `normalizeSelection` and `SelectionStore.get()`.
 * **Consumers that walk a subtree** (grouping / delete / duplicate / copy / ref
 * resolution) **only accept this type**, so the "a raw Selection could be passed in"
 * path is closed off by the type system.
 *
 * This is the structural answer to hitting the same root cause twice across two review
 * passes: the first pass relied on each consumer following the convention of calling
 * `dropDescendantIds`, and missed 4 selection-boundary call sites; the second pass, inside
 * `snapshotSelection`, **normalized only the ref resolution and missed the groups
 * collection loop**. Instead of piling on more conventions or one-off patches, the type
 * system now enforces that an unnormalized selection can't be passed around.
 */
export type NormalizedSelection = Selection & { readonly [NORMALIZED]: true };

/** Minimal tree port required by `normalizeSelection` (SceneTreeReader satisfies it structurally) */
export interface SelectionTreeReader {
  getNode(id: string): { readonly parentId: string | null } | undefined;
  isAncestor(a: string, b: string): boolean;
  isHiddenEffective(id: string | null): boolean;
  isLockedEffective(id: string | null): boolean;
}

/**
 * The single implementation that reduces a Selection to its invariants. Both
 * `SelectionStore`'s entry point/self-validation and calls that bypass the store
 * (Layers / Inspector building a Selection from a single id) go through this.
 *
 * If the input already satisfies the invariants, this **returns the same reference**
 * (so callers can use `toBe` comparisons and avoid needless notify calls).
 */
export function normalizeSelection(tree: SelectionTreeReader, sel: Selection): NormalizedSelection {
  if (sel.kind === 'groups') {
    const seen = new Set<string>();
    const alive = sel.ids.filter((id) => {
      if (seen.has(id)) return false; // dedupe (first wins, preserving selection order)
      seen.add(id);
      if (tree.getNode(id) === undefined) return false; // id no longer exists after undo/load
      return !tree.isHiddenEffective(id) && !tree.isLockedEffective(id);
    });
    // Among surviving ids, drop any that are a descendant of another id (keep outermost only)
    const ids = alive.filter((id) => !alive.some((other) => other !== id && tree.isAncestor(other, id)));
    const unchanged = ids.length === sel.ids.length && ids.every((id, i) => id === sel.ids[i]);
    if (unchanged) return sel as NormalizedSelection;
    return (ids.length ? { kind: 'groups', ids } : { kind: 'none' }) as NormalizedSelection;
  }
  if (sel.kind === 'cells') {
    const cells = new Map<CellRefKey, SelectedCell>();
    for (const [key, cell] of sel.cells) {
      const owner = cell.ref.ownerId;
      // Check **the ref's own owner, not the winner** — so that selecting an unlocked
      // ref hidden under a locked group isn't wrongly cleared by the winner's lock state
      if (!tree.isHiddenEffective(owner) && !tree.isLockedEffective(owner)) cells.set(key, cell);
    }
    if (cells.size === sel.cells.size) return sel as NormalizedSelection;
    return (cells.size ? { kind: 'cells', cells } : { kind: 'none' }) as NormalizedSelection;
  }
  return sel as NormalizedSelection;
}

/** Builds a cells selection from a list of `SelectedCell` (none if empty). Consolidates the construction path here. */
export function cellSelectionOf(cells: Iterable<SelectedCell>): Selection {
  const map = new Map<CellRefKey, SelectedCell>();
  for (const cell of cells) map.set(makeCellRefKey(cell.ref), cell);
  return map.size ? { kind: 'cells', cells: map } : { kind: 'none' };
}

/**
 * Builds a cells selection from a list of refs. Looks up the current projection from
 * the index and **drops any ref that no longer resolves**. Used for the path that
 * rebuilds a selection from the result of a mutation (a new set of refs).
 */
export function cellSelectionFromRefs(index: WorldIndexReader, refs: Iterable<CellRef>): Selection {
  const cells: SelectedCell[] = [];
  for (const ref of refs) {
    const worldCell = index.worldOf(ref);
    if (worldCell) cells.push({ ref, worldCell });
  }
  return cellSelectionOf(cells);
}

/**
 * Selection lives in its own store rather than AppState (self-validation after
 * undo/redo/load is a selection-specific concern, and mixing it with other UI
 * notifications would add noise).
 *
 * The subscription source is **`SceneBatchChange`, not Document events** (from the design
 * rev.5 blocker 3) — drag preview doesn't emit Document events, so subscribing to
 * Document wouldn't be able to follow preview updates.
 */
export class SelectionStore {
  private sel: NormalizedSelection = { kind: 'none' } as NormalizedSelection;
  private readonly emitter = createEmitter<SelectionChange>();

  constructor(private doc: Document) {
    this.doc.index.subscribeBatch((event) => this.onBatch(event));
  }

  /** The held selection is always normalized (existing / unique / outermost / excludes hidden or locked) */
  get(): NormalizedSelection {
    return this.sel;
  }

  /**
   * Enforces the selection invariants at the entry point (the implementation is
   * consolidated in `normalizeSelection`).
   *
   * Runs on both the set() entry point and self-validation (validate) — so toggling
   * lock/hidden from the layer panel while selected doesn't leave a stale selection
   * behind (a stale selection would let the inspector's delete button or
   * SelectionOverlay trust outdated state).
   */
  private sanitize(sel: Selection): NormalizedSelection {
    return normalizeSelection(this.doc.tree, sel);
  }

  set(sel: Selection): void {
    this.sel = this.sanitize(sel);
    this.notify();
  }

  clear(): void {
    this.set({ kind: 'none' });
  }

  toggleGroup(id: string): void {
    if (this.sel.kind !== 'groups') {
      this.set({ kind: 'groups', ids: [id] });
      return;
    }
    const has = this.sel.ids.includes(id);
    const ids = has ? this.sel.ids.filter((i) => i !== id) : [...this.sel.ids, id];
    this.set(ids.length ? { kind: 'groups', ids } : { kind: 'none' });
  }

  toggleCell(cell: SelectedCell): void {
    const key = makeCellRefKey(cell.ref);
    if (this.sel.kind !== 'cells') {
      this.set(cellSelectionOf([cell]));
      return;
    }
    const cells = new Map(this.sel.cells);
    if (cells.has(key)) cells.delete(key);
    else cells.set(key, cell);
    this.set(cells.size ? { kind: 'cells', cells } : { kind: 'none' });
  }

  /**
   * All refs the selection points to (for mutation). For groups, all refs in the
   * subtree including descendant groups. **Does not collapse to world keys** — if
   * multiple overlapping refs share the same world coordinate, collapsing would drop
   * one of them from the mutation target.
   */
  resolveRefs(): CellRef[] {
    if (this.sel.kind === 'cells') return [...this.sel.cells.values()].map((c) => c.ref);
    if (this.sel.kind === 'groups') {
      const out: CellRef[] = [];
      for (const id of this.sel.ids) out.push(...refsOfSubtree(this.doc.scene, id));
      return out;
    }
    return [];
  }

  /**
   * The set of world cell keys the selection points to (a derived value for
   * rendering / bbox / counting). Not for mutation — use `resolveRefs` instead.
   */
  resolveCells(): Set<string> {
    const out = new Set<string>();
    if (this.sel.kind === 'cells') {
      for (const cell of this.sel.cells.values()) {
        out.add(makeCellKey(cell.worldCell[0], cell.worldCell[1], cell.worldCell[2]));
      }
      return out;
    }
    if (this.sel.kind === 'groups') {
      for (const ref of this.resolveRefs()) {
        const world = this.doc.index.worldOf(ref);
        if (world) out.add(makeCellKey(world[0], world[1], world[2]));
      }
    }
    return out;
  }

  bbox(): { min: Cell; max: Cell } | null {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let found = false;
    for (const key of this.resolveCells()) {
      const parts = key.split(',');
      const x = Number(parts[0]), y = Number(parts[1]), z = Number(parts[2]);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
      found = true;
    }
    return found ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : null;
  }

  /** Supports multiple subscribers, returns an unsubscribe function */
  subscribe(fn: (event: SelectionChange) => void): Unsubscribe {
    return this.emitter.subscribe(fn);
  }

  private notify(): void {
    this.emitter.notify({ kind: 'change' });
  }

  /**
   * Behavior for WorldIndex lifecycle notifications (per-phase rules from the design
   * rev.6).
   *
   * - `preview`: **don't validate/remove old refs**. During drag preview, the old ref
   *   temporarily disappears from the index, so validating here would clear the
   *   selection before the commit-time remap runs. Overlay tracking during the drag is
   *   handled by selecttool's own drag offset.
   * - `commit`: the index has already been swapped to its final state (by contract).
   *   **Apply refRemap first**, then re-project via `worldOf` and drop only the refs
   *   that are gone.
   * - `restore`: after reverting to the baseline index, re-project the held refs (so
   *   cancel doesn't clear the selection).
   */
  private onBatch(event: SceneBatchChange): void {
    if (event.phase === 'preview') return;
    if (event.phase === 'commit' && event.refRemap) this.applyRemap(event.refRemap);
    this.validate();
  }

  private applyRemap(remap: CellRefRemap): void {
    if (this.sel.kind !== 'cells') return;
    const next = new Map<CellRefKey, SelectedCell>();
    for (const [key, cell] of this.sel.cells) {
      if (!remap.has(key)) {
        next.set(key, cell);
        continue;
      }
      const mapped = remap.get(key)!;
      if (mapped === null) continue; // ref was deleted
      const world = this.doc.index.worldOf(mapped);
      next.set(makeCellRefKey(mapped), { ref: mapped, worldCell: world ?? cell.worldCell });
    }
    // Don't notify here (the validate() call right after only notifies on an actual
    // change). Run the remap result through the invariants too (drop refs whose owner
    // changed and moved under a hidden/locked node)
    this.sel = normalizeSelection(this.doc.tree, next.size ? { kind: 'cells', cells: next } : { kind: 'none' });
  }

  /**
   * Drops dead group ids / refs and re-projects the worldCell of surviving refs.
   * Doesn't fire notify if nothing actually changed (so unrelated subscribers, like
   * the status bar, aren't disturbed on every undo/redo).
   */
  private validate(): void {
    const tree = this.doc.tree;
    if (this.sel.kind === 'groups') {
      // Consolidate the check into sanitize (one implementation owns existing / unique /
      // outermost / not hidden-or-locked). Writing the same invariants twice, at both
      // the entry point and validation, risks fixing one and missing the other
      const next = this.sanitize(this.sel);
      if (next !== this.sel) this.set(next);
      return;
    }
    if (this.sel.kind !== 'cells') return;

    const cells = new Map<CellRefKey, SelectedCell>();
    let moved = false;
    for (const [key, cell] of this.sel.cells) {
      const owner = cell.ref.ownerId;
      if (owner !== null && tree.getNode(owner) === undefined) continue;
      if (tree.isHiddenEffective(owner) || tree.isLockedEffective(owner)) continue;
      const world = this.doc.index.worldOf(cell.ref);
      if (!world) continue; // the ref itself is gone
      if (world[0] !== cell.worldCell[0] || world[1] !== cell.worldCell[1] || world[2] !== cell.worldCell[2]) {
        moved = true;
        cells.set(key, { ref: cell.ref, worldCell: world });
      } else {
        cells.set(key, cell);
      }
    }
    if (cells.size !== this.sel.cells.size || moved) {
      this.set(cells.size ? { kind: 'cells', cells } : { kind: 'none' });
    }
  }
}
