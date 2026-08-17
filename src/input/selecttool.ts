import * as THREE from 'three';
import { makeCellRefKey, type CellRef } from '../core/cellref';
import type { Document, DocOp, EditSession } from '../core/document';
import type { Unsubscribe } from '../core/emitter';
import { isValidCell, OP_MAX_CELLS } from '../core/limits';
import type { SceneTreeReader } from '../core/scenetree';
import type { MirrorAxis } from '../core/transform';
import { screenAlignedNudge, type CameraBasis } from './screenaxes';
import type { Cell } from '../core/types';
import type { WorldIndexReader } from '../core/worldindex';
import {
  buildDeleteSelection,
  buildDuplicate,
  buildGroup,
  buildMirror,
  buildMove,
  buildRotateGroup90,
  buildTranslateGroup,
  buildUngroup,
  clampDeltaToBounds,
  commitOpResult,
} from '../editor/ops';
import { buildPaste, snapshotSelection, type ClipboardData } from '../editor/clipboard';
import { cellSelectionOf, type Selection, type SelectedCell, type SelectionStore } from '../editor/selection';
import { defaultName, opError, state, t } from '../state';
import type { Hit } from '../core/types';
import type { CancelReason, GestureClaim, PointerRouteHandler } from './router';

/**
 * Determines the next selection state from the click type (normal/Ctrl/double) and the
 * target cell. Pure function, DOM-independent.
 * - Normal click: always selects the outermost group (or the cell itself if unclassified)
 * - Ctrl+click: toggles within the same kind; crossing kinds replaces the selection
 * - Double click: if the current selection is a single group on this cell's path, drill down
 *   one level (to the cell itself if it's the innermost group). If the current selection is
 *   already a cells-selection of that same cell, no-op. Otherwise (an unrelated selection),
 *   behaves like a normal click (reset to outermost)
 *
 * #37 B1b: "which group a cell belongs to" is determined by **the owner of the hit ref**
 * (not derived from world coordinates via a membership index) — even when a locked group is
 * seen through to select a ref underneath, the drill-down target follows that ref's owner
 * chain.
 */
export function resolveClickSelection(
  tree: SceneTreeReader,
  current: Selection,
  cell: SelectedCell,
  opts: { ctrl: boolean; doubleClick: boolean },
): Selection {
  const groupId = cell.ref.ownerId;
  const refKey = makeCellRefKey(cell.ref);

  if (opts.ctrl) {
    if (groupId === null) {
      if (current.kind === 'cells') {
        const cells = new Map(current.cells);
        if (cells.has(refKey)) cells.delete(refKey);
        else cells.set(refKey, cell);
        return cells.size ? { kind: 'cells', cells } : { kind: 'none' };
      }
      return cellSelectionOf([cell]);
    }
    const outermost = tree.outermostAncestor(groupId);
    if (current.kind === 'groups') {
      const has = current.ids.includes(outermost);
      const ids = has ? current.ids.filter((i) => i !== outermost) : [...current.ids, outermost];
      return ids.length ? { kind: 'groups', ids } : { kind: 'none' };
    }
    return { kind: 'groups', ids: [outermost] };
  }

  if (groupId === null) return cellSelectionOf([cell]);

  const outermost = tree.outermostAncestor(groupId);
  if (!opts.doubleClick) return { kind: 'groups', ids: [outermost] };

  // Double click: no-op if already selecting the cell itself at the deepest level
  if (current.kind === 'cells' && current.cells.size === 1 && current.cells.has(refKey)) return current;

  // Build the outermost -> groupId path (walk up through parents, unshifting, stop at outermost)
  const path: string[] = [];
  let cursor: string | null = groupId;
  while (cursor !== null) {
    path.unshift(cursor);
    if (cursor === outermost) break;
    cursor = tree.getNode(cursor)?.parentId ?? null;
  }

  if (current.kind === 'groups' && current.ids.length === 1 && path.includes(current.ids[0]!)) {
    const idx = path.indexOf(current.ids[0]!);
    if (idx + 1 < path.length) return { kind: 'groups', ids: [path[idx + 1]!] };
    return cellSelectionOf([cell]); // one level deeper than groupId (the deepest) = the cell
  }
  return { kind: 'groups', ids: [outermost] }; // an unrelated selection is treated like a normal click
}

/**
 * Pure function (DOM-independent) that decides "what to do" on pointerdown. Side effects
 * like capture and session creation are the responsibility of onPointerDown (impure); this
 * only branches.
 * Priority order matches the original implementation's branch order exactly: shift-range →
 * starting a drag on an already-selected cell → immediate Ctrl/double-click resolution →
 * marquee candidate/clear.
 */
export type SelectPointerAction =
  | { kind: 'shift-noop' }
  | { kind: 'shift-set-anchor'; cell: [number, number, number] }
  | { kind: 'shift-commit-range'; from: [number, number, number]; to: [number, number, number] }
  | { kind: 'begin-drag' }
  | { kind: 'immediate-select'; cell: SelectedCell; ctrl: boolean; doubleClick: boolean }
  | { kind: 'clear-empty' }
  | { kind: 'clear' }
  | { kind: 'begin-marquee'; anchorCell: [number, number, number]; cellIfVoxel: SelectedCell | null }
  | { kind: 'noop' };

export interface SelectPointerContext {
  /** Hit already resolved via the selection probe (`selectableRefAt`). Locked cells are already seen through */
  hit: Hit | null;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** Click count (corresponds to PointerEvent.detail). 2 = double click */
  detail: number;
  rangeAnchor: [number, number, number] | null;
  isSelected: (cell: SelectedCell) => boolean;
  resolveSelectCell: (hit: Hit) => [number, number, number];
  isValidCell: (cell: readonly [number, number, number]) => boolean;
}

export function decideSelectAction(ctx: SelectPointerContext): SelectPointerAction {
  const { hit, shiftKey, ctrlKey, metaKey, detail, rangeAnchor, isSelected, resolveSelectCell, isValidCell } = ctx;

  if (shiftKey) {
    if (!hit) return { kind: 'shift-noop' };
    const cell = resolveSelectCell(hit);
    if (!isValidCell(cell)) return { kind: 'shift-noop' };
    if (rangeAnchor) return { kind: 'shift-commit-range', from: rangeAnchor, to: cell };
    return { kind: 'shift-set-anchor', cell };
  }

  if (hit && hit.kind === 'voxel' && !ctrlKey && !metaKey && detail === 1) {
    if (isSelected({ ref: hit.ref, worldCell: hit.cell })) return { kind: 'begin-drag' };
  }

  if (ctrlKey || metaKey || detail === 2) {
    if (!hit || hit.kind !== 'voxel') return !ctrlKey && !metaKey ? { kind: 'clear-empty' } : { kind: 'noop' };
    return {
      kind: 'immediate-select',
      cell: { ref: hit.ref, worldCell: hit.cell },
      ctrl: ctrlKey || metaKey,
      doubleClick: detail === 2,
    };
  }

  if (!hit) return { kind: 'clear' };
  const anchorCell = resolveSelectCell(hit);
  if (!isValidCell(anchorCell)) return { kind: 'noop' };
  return {
    kind: 'begin-marquee',
    anchorCell,
    cellIfVoxel: hit.kind === 'voxel' ? { ref: hit.ref, worldCell: hit.cell } : null,
  };
}

/**
 * Shift+click range selection: collects the **selectable** cells within a box (#37 B1b).
 * Excluding hidden / locked cells is `selectableRefAt`'s job, so no downstream filtering is
 * needed on the caller's side (if there's an unlocked ref under a locked winner, that one
 * gets picked up instead).
 * Returns volume first, for the guard check.
 */
export function collectSelectableInBox(
  index: WorldIndexReader,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): { cells: SelectedCell[]; volume: number } {
  const minX = Math.min(a[0], b[0]), maxX = Math.max(a[0], b[0]);
  const minY = Math.min(a[1], b[1]), maxY = Math.max(a[1], b[1]);
  const minZ = Math.min(a[2], b[2]), maxZ = Math.max(a[2], b[2]);
  const volume = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
  const cells: SelectedCell[] = [];
  if (volume > OP_MAX_CELLS) return { cells, volume }; // returns empty without scanning (the caller enforces the guard)
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        const entry = index.selectableRefAt([x, y, z]);
        if (entry) cells.push({ ref: entry.ref, worldCell: [x, y, z] });
      }
    }
  }
  return { cells, volume };
}

export interface SelectToolOpts {
  scene: THREE.Scene;
  doc: Document;
  selection: SelectionStore;
  /** Hit resolution **for selection** (`PickingService.pickFromEventForSelect`). Requires seeing through locked cells */
  pickFromEvent: (e: PointerEvent) => Hit | null;
  /** Unlike the same-named field in controls.ts, this is required (always needed to determine range-anchor coordinates) */
  resolvePlaceCell: (hit: Hit) => [number, number, number];
  toast: (msg: string) => void;
  /**
   * Injected function that determines the projection target for drag movement. Supplied via
   * raycasting against a horizontal plane (or a vertical plane while Shift is held)
   * (services/picking.ts's PickingService.dragProject, #14 PR2)
   */
  dragProject: (
    e: PointerEvent,
    mode: { axis: 'horizontal'; y: number } | { axis: 'vertical'; x: number; z: number },
  ) => [number, number, number] | null;
  /**
   * During a drag move, keeps the selection overlay's render position following via a live
   * offset. In a cell drag, the underlying entity moves but the selection itself still
   * references the old ref, so without calling this, the selection outline would stay at the
   * old position. In a group drag (ghost preview), this offset is itself **the only thing
   * that visibly moves**.
   */
  setSelectionDragOffset: (offset: [number, number, number] | null) => void;
  /** While true, yields tool operations to Space+left-drag panning (handled by OrbitControls) */
  isSpacePanActive?: () => boolean;
  /**
   * The current camera pose (#147). Used to map arrow-key movement onto the screen's
   * left/right and near/far directions.
   *
   * **Read on every keypress** (including each repeat while held down). If you rotate the
   * view while holding the key, the destination switches along with it — since the promise
   * is "moves in the direction you're seeing", latching onto the orientation from when the
   * key was first pressed would end up mismatched with the screen
   */
  getCameraBasis: () => CameraBasis;
}

/** Return value of initSelectTool. Used to query an in-progress gesture, cancel it explicitly, and run shortcuts */
export interface SelectToolHandle {
  /** Whether a drag move or a marquee range selection is in progress */
  isDragging: () => boolean;
  /** Only for an active drag move (excludes marquee). Used for the arrow-nudge exclusivity check */
  hasActiveDrag: () => boolean;
  /** On Esc broadcast / mode switch: handles exactly one step of the priority chain drag > marquee > rangeAnchor > deselect */
  cancelActive: () => void;
  /** Ctrl+G: group (called from InputRouter's (#12) SHORTCUTS) */
  handleGroup: () => void;
  /** Ctrl+Shift+G: ungroup */
  handleUngroup: () => void;
  /** Arrow keys/PageUp/PageDown: nudge the selection by one cell. No-op if not a handled key / no selection / mid-drag */
  handleNudge: (e: KeyboardEvent) => void;
  /**
   * `[` / `]`: rotates a groups selection 90 degrees around the Y axis (#37 B2).
   * Returns false when nothing was rotated (not a groups selection / mid-drag)
   * (the return value lets the SHORTCUTS side skip preventDefault).
   */
  handleRotate: (quarterTurns: 1 | 3) => boolean;
  /**
   * `Shift+X` / `Shift+Y` / `Shift+Z`: mirrors the selection across a world axis (#63).
   * Unlike rotation, this also works for a cells selection. Returns false mid-drag.
   *
   * **With no selection, the key itself doesn't match on the SHORTCUTS side** (so it falls
   * through to camerakeys, #65 review P1). Rejecting "no selection" here is defense at the
   * level of the public API.
   */
  handleMirror: (axis: MirrorAxis) => boolean;
  /** Ctrl+D: duplicate */
  handleDuplicate: () => void;
  /** Ctrl+C: copy */
  handleCopy: () => void;
  /** Ctrl+V: paste */
  handlePaste: () => void;
  /** Delete/Backspace: delete selection (preventDefault is only called internally when there's something to delete) */
  handleDelete: (e: KeyboardEvent) => void;
  /** Route handler registered with InputRouter's (#12 PR3) pointerRoutes */
  route: PointerRouteHandler;
}

/** List of keys handled by nudge (also used by the SHORTCUTS matches check) */
export const NUDGE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown']);

/**
 * Drag-move session for a cells selection (#37 B1b). **Live-previews the actual entity** —
 * each ref is shifted by worldDelta within its own owner (`EditSession.stageMoveRefs`).
 * Baseline restoration is unified in EditSession (#11).
 */
interface CellDragSession {
  kind: 'cells';
  session: EditSession;
  refs: CellRef[];
  bbox: { min: Cell; max: Cell };
  grabPoint: [number, number, number];
  grabY: number;
  lastOffset: [number, number, number];
}

/**
 * Drag-move session for a groups selection = **ghost preview** (#37 design rev.8).
 *
 * Never touches the source of truth (scene / WorldIndex / history) on any pointermove. Only
 * the position of the SelectionOverlay's parent node is moved, with zero notifications
 * fired. On pointerup, `buildTranslateGroup` is applied exactly once, as a normal Document
 * transaction.
 *
 * Measured: a structural rebuild on every pointermove hit p95 17.4ms at 22³ and 230ms at
 * 48³, missing 60fps. This isn't solved by optimizing the rebuild — it's solved by removing
 * the assumption that the source of truth moves during preview in the first place.
 *
 * UX tradeoff (accepted): a cell drag moves the actual entity, while a group drag leaves the
 * original entity in place and moves only a semi-transparent outline. Winner replacement at
 * the destination is finalized on drop.
 */
interface GhostDragSession {
  kind: 'ghost';
  ids: string[];
  bbox: { min: Cell; max: Cell };
  grabPoint: [number, number, number];
  grabY: number;
  lastOffset: [number, number, number];
  /** True if the Document changed externally during the drag (don't commit from a stale bbox / anchor position) */
  invalidated: boolean;
  unsubscribe: Unsubscribe;
}

type DragSession = CellDragSession | GhostDragSession;

/**
 * Session state for a single marquee (rectangular range) selection. Applies to a single
 * non-Ctrl click over an empty/unselected cell (over an already-selected cell it's the
 * existing drag-move; Ctrl+click/double-click still resolve immediately). Whether an actual
 * drag occurred determines "click" vs. "range selection" on pointerup.
 */
interface MarqueeSession {
  anchor: [number, number, number];
  anchorClient: [number, number];
  /** Target to treat as a normal click if released without dragging (null = deselect, if not a voxel hit) */
  cellIfVoxel: SelectedCell | null;
  dragged: boolean;
  lastCell: [number, number, number];
}

/** Pointer movement (CSS px) below this is treated as a "click" (prevents misfires from unintended tiny drags) */
const MARQUEE_DRAG_THRESHOLD_PX = 4;



/**
 * The select tool's pointer state machine. Integrated into InputRouter's pointerRoutes in
 * #12 PR3. Both drag-move and marquee selection are delegated to the router as a
 * GestureClaim — acquiring/releasing pointer capture, matching pointerId, and terminating on
 * pointercancel/blur (endActiveClaim) are unified in the router's shared handling (the
 * exclusivity of "this route only creates a claim while state.tool==='select'" is maintained
 * by the edit-tools route (controls.ts) returning null while state.tool==='select').
 */
export function initSelectTool(opts: SelectToolOpts): SelectToolHandle {
  const { scene, doc, selection, pickFromEvent, resolvePlaceCell, toast, dragProject, setSelectionDragOffset, isSpacePanActive, getCameraBasis } = opts;

  /** Origin of a Shift+click range selection (waiting for the second point) */
  let rangeAnchor: [number, number, number] | null = null;

  let dragSession: DragSession | null = null;
  let marqueeSession: MarqueeSession | null = null;
  let clipboard: ClipboardData | null = null;

  /**
   * Anchor coordinate for a range selection. Using resolvePlaceCell (cell+normal, meant for
   * the placement tool) as-is would resolve a click on an existing block's top face to the
   * empty cell above it, so the block you meant to select wouldn't end up inside the box.
   * For a voxel hit, use that cell itself as the anchor.
   */
  function resolveSelectCell(hit: Hit): [number, number, number] {
    return hit.kind === 'voxel' ? hit.cell : resolvePlaceCell(hit);
  }

  const rangePreview = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: '#e8a33d', transparent: true, opacity: 0.25, depthWrite: false }),
  );
  rangePreview.visible = false;
  scene.add(rangePreview);

  function updateRangePreview(a: [number, number, number], b: [number, number, number]): void {
    const [ax, ay, az] = a;
    const [bx, by, bz] = b;
    const minX = Math.min(ax, bx), maxX = Math.max(ax, bx);
    const minY = Math.min(ay, by), maxY = Math.max(ay, by);
    const minZ = Math.min(az, bz), maxZ = Math.max(az, bz);
    rangePreview.scale.set(maxX - minX + 1.01, maxY - minY + 1.01, maxZ - minZ + 1.01);
    rangePreview.position.set((minX + maxX) / 2 + 0.5, (minY + maxY) / 2 + 0.5, (minZ + maxZ) / 2 + 0.5);
    rangePreview.visible = true;
  }

  // ---- Drag move (pointerdown → move → pointerup over a selected cell = 1 transaction) ----

  /** Starts a drag. Branches into cell live preview / group ghost preview depending on selection type */
  function beginDrag(hit: Hit, e: PointerEvent): boolean {
    const sel = selection.get();
    if (sel.kind === 'none') return false;
    const bbox = selection.bbox();
    if (!bbox) return false;
    const grab = dragProject(e, { axis: 'horizontal', y: hit.cell[1] });
    if (!grab) return false;

    if (sel.kind === 'groups') {
      const ids = sel.ids.filter((id) => doc.tree.getNode(id) && !doc.tree.isLockedEffective(id));
      if (!ids.length) return false;
      const ghost: GhostDragSession = {
        kind: 'ghost',
        ids,
        bbox,
        grabPoint: grab,
        grabY: hit.cell[1],
        lastOffset: [0, 0, 0],
        invalidated: false,
        unsubscribe: () => {},
      };
      // If the Document changes externally during the drag, the ghost's reference frame goes stale. Cancel instead of committing
      ghost.unsubscribe = doc.subscribe(() => {
        ghost.invalidated = true;
      });
      dragSession = ghost;
      return true;
    }

    const refs = selection.resolveRefs().filter((ref) => !doc.tree.isLockedEffective(ref.ownerId));
    if (!refs.length) return false;
    if (refs.length > OP_MAX_CELLS) {
      toast(t('sel.tooLargeToMove', { count: refs.length.toLocaleString(), max: OP_MAX_CELLS.toLocaleString() }));
      return false;
    }
    dragSession = {
      kind: 'cells',
      session: doc.beginSession(),
      refs,
      bbox,
      grabPoint: grab,
      grabY: hit.cell[1],
      lastOffset: [0, 0, 0],
    };
    return true;
  }

  /** During pointermove: project → round to integer offset → clamp to bbox → apply if changed */
  function updateDrag(e: PointerEvent): void {
    if (!dragSession) return;
    if (dragSession.kind === 'ghost' && dragSession.invalidated) {
      cancelDrag();
      return;
    }
    const vertical = e.shiftKey;
    const mode = vertical
      ? ({ axis: 'vertical', x: dragSession.grabPoint[0], z: dragSession.grabPoint[2] } as const)
      : ({ axis: 'horizontal', y: dragSession.grabY } as const);
    const p = dragProject(e, mode);
    if (!p) return;
    // The offset formula always computes all 3 axes generically. For horizontal, p[1]===grabPoint[1]
    // always holds, and for vertical, p[0]/p[2]===grabPoint[0]/[2] always holds geometrically
    // (since the projection plane is defined to contain that axis), so this is equivalent to
    // an implementation that explicitly pins the non-moving axis to 0
    let offset: [number, number, number] = [
      Math.round(p[0] - dragSession.grabPoint[0]),
      Math.round(p[1] - dragSession.grabPoint[1]),
      Math.round(p[2] - dragSession.grabPoint[2]),
    ];
    offset = clampDeltaToBounds(dragSession.bbox, offset);
    if (
      offset[0] === dragSession.lastOffset[0] &&
      offset[1] === dragSession.lastOffset[1] &&
      offset[2] === dragSession.lastOffset[2]
    ) {
      return;
    }
    // A cell drag moves the actual entity. A group drag (ghost) never touches the source of truth
    if (dragSession.kind === 'cells') dragSession.session.stageMoveRefs(dragSession.refs, offset);
    setSelectionDragOffset(offset);
    dragSession.lastOffset = offset;
  }

  /**
   * Finalizes the drag.
   * - cells: the voxel-side diff (baseline vs. current) is computed internally by
   *   `EditSession.commit()` (if there was effectively no movement, the diff is empty, and
   *   commit() itself ignores that case without polluting the undo history). Selection
   *   follow-through is handled by SelectionStore via Transaction.remap → SceneBatchChange
   * - ghost: unsubscribes right before committing, re-verifies the group's existence and
   *   lock state, then applies `buildTranslateGroup` as a single transaction
   */
  function commitDrag(): void {
    if (!dragSession) return;
    const session = dragSession;
    dragSession = null;
    setSelectionDragOffset(null); // from here on, draw the selection (post-commit canonical coordinates) as-is

    if (session.kind === 'cells') {
      session.session.commit();
      return;
    }

    session.unsubscribe();
    if (session.invalidated) return; // an external change occurred: don't commit from a stale reference frame
    const offset = session.lastOffset;
    if (offset[0] === 0 && offset[1] === 0 && offset[2] === 0) return;

    const ops: DocOp[] = [];
    for (const id of session.ids) {
      if (!doc.tree.getNode(id) || doc.tree.isLockedEffective(id)) continue; // re-verify right before drop
      const result = buildTranslateGroup(doc, id, offset);
      if ('error' in result) {
        toast(result.error);
        return;
      }
      ops.push(...result.tx.ops);
    }
    if (ops.length) doc.applyTransaction({ ops });
  }

  /**
   * When the router (InputRouter.broadcastCancel) force-terminates a claim with
   * reason='escape', selectTool.cancelActive() (escapeHandlers) is called right after within
   * the same broadcast. The fact that claim.onCancel (cancelDrag/cancelMarquee) has already
   * handled the first step of the priority chain "drag/marquee > rangeAnchor > deselect"
   * can't be detected by cancelActive() from a null check on dragSession/marqueeSession alone
   * (they've already been nulled out by then). This flag makes "the router already handled
   * one step" explicit, so cancelActive() doesn't mistakenly chain into the next step
   * (rangeAnchor/deselect) within the same broadcast (regression found in review, #12 PR3,
   * 2026-07-21).
   *
   * Only set when reason==='escape' (limited to the specific combination that's guaranteed to
   * be consumed within the same tick via the broadcastCancel → escapeHandlers path).
   * pointercancel/lostpointercapture/blur call endActiveClaim directly and don't go through
   * escapeHandlers (cancelActive() itself isn't called), so setting the flag for those reasons
   * would create a stale-flag bug where it's left unconsumed and mistakenly consumed by a
   * later, unrelated Escape. Restricting by reason structurally prevents this leak.
   */
  let claimCancelledThisBroadcast = false;

  function noteClaimCancelledIfBroadcast(reason?: CancelReason): void {
    if (reason === 'escape') claimCancelledThisBroadcast = true;
  }

  /**
   * Esc / pointercancel / blur.
   * - cells: restores to baseline via `EditSession.cancel()` and discards it (not kept in the undo history, #11)
   * - ghost: since the source of truth was never touched, simply resetting the overlay's
   *   offset is enough (no baseline restore, rollback, or restore notification needed, design rev.8)
   */
  function cancelDrag(reason?: CancelReason): void {
    if (!dragSession) return;
    const session = dragSession;
    dragSession = null;
    if (session.kind === 'cells') session.session.cancel();
    else session.unsubscribe();
    setSelectionDragOffset(null);
    noteClaimCancelledIfBroadcast(reason);
  }

  /** Finalizes the marquee, resolving the pointerup-equivalent click exactly once (branches on dragged/cellIfVoxel) */
  function resolveMarqueeUp(): void {
    if (!marqueeSession) return;
    const session = marqueeSession;
    marqueeSession = null;
    rangePreview.visible = false;
    if (session.dragged) {
      const { cells, volume } = collectSelectableInBox(doc.index, session.anchor, session.lastCell);
      if (volume > OP_MAX_CELLS) {
        toast(t('sel.rangeTooLarge', { count: volume.toLocaleString(), max: OP_MAX_CELLS.toLocaleString() }));
      } else if (cells.length === 0) {
        toast(t('sel.nothingInRange'));
      } else {
        selection.set(cellSelectionOf(cells));
      }
    } else if (session.cellIfVoxel) {
      // effectively no drag = equivalent to a normal click
      selection.set(resolveClickSelection(doc.tree, selection.get(), session.cellIfVoxel, { ctrl: false, doubleClick: false }));
    } else {
      selection.clear();
    }
  }

  /** pointermove during a marquee. Called by the router as claim.onMove, with pointerId already matched */
  function updateMarquee(e: PointerEvent): void {
    if (!marqueeSession) return;
    const hit2 = pickFromEvent(e);
    if (!hit2) return;
    const dx = e.clientX - marqueeSession.anchorClient[0];
    const dy = e.clientY - marqueeSession.anchorClient[1];
    if (!marqueeSession.dragged && Math.hypot(dx, dy) < MARQUEE_DRAG_THRESHOLD_PX) return; // below the threshold is still treated as a click
    const cur = resolveSelectCell(hit2);
    if (!isValidCell(cur[0], cur[1], cur[2])) return;
    marqueeSession.dragged = true;
    marqueeSession.lastCell = cur;
    updateRangePreview(marqueeSession.anchor, cur);
  }

  /** pointercancel / blur (via the router's endActiveClaim): discards without finalizing */
  function cancelMarquee(reason?: CancelReason): void {
    if (!marqueeSession) return;
    marqueeSession = null;
    rangePreview.visible = false;
    noteClaimCancelledIfBroadcast(reason);
  }

  /** Exposes drag-move over an already-selected cell as a GestureClaim for the router */
  function makeDragClaim(): GestureClaim {
    return {
      onMove: (e) => updateDrag(e),
      onUp: () => {
        commitDrag();
        return 'commit';
      },
      onCancel: (reason) => cancelDrag(reason),
    };
  }

  /** Exposes the marquee (rectangular range selection) as a GestureClaim for the router */
  function makeMarqueeClaim(): GestureClaim {
    return {
      onMove: (e) => updateMarquee(e),
      onUp: () => {
        resolveMarqueeUp();
        return 'commit';
      },
      onCancel: (reason) => cancelMarquee(reason),
    };
  }

  /**
   * pointerRoutes route handler for InputRouter (#12 PR3). The edit-tools route (controls.ts)
   * returns null and yields while state.tool==='select', so this is only reached for left
   * clicks while the select tool is active. The branching decision is delegated to
   * decideSelectAction (a pure function); this function only performs side effects (session
   * creation, selection updates, claim construction).
   *
   * Hit resolution goes through the selection probe (`selectableRefAt`), so excluding hidden
   * cells and seeing through locked ones is already handled on the WorldIndex side (a lock
   * filter on the caller's side is no longer needed, #37 B1b).
   */
  function onPointerDown(e: PointerEvent): GestureClaim | 'handled' | null {
    if (state.tool !== 'select' || e.button !== 0) return null;
    if (isSpacePanActive?.()) return null; // yields to Space+left-drag panning (handled by OrbitControls)
    const hit = pickFromEvent(e);

    if (!e.shiftKey && rangeAnchor) {
      // A non-shift click cancels the pending anchor (moved to a different operation without waiting for the second point)
      rangeAnchor = null;
      rangePreview.visible = false;
    }

    const selectedRefKeys = new Set(selection.resolveRefs().map(makeCellRefKey));
    const action = decideSelectAction({
      hit,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      detail: e.detail,
      rangeAnchor,
      isSelected: (cell) => selectedRefKeys.has(makeCellRefKey(cell.ref)),
      resolveSelectCell,
      isValidCell: (c) => isValidCell(c[0], c[1], c[2]),
    });

    switch (action.kind) {
      case 'shift-noop':
      case 'noop':
        return 'handled';
      case 'shift-set-anchor':
        rangeAnchor = action.cell;
        updateRangePreview(action.cell, action.cell);
        return 'handled';
      case 'shift-commit-range': {
        const { cells, volume } = collectSelectableInBox(doc.index, action.from, action.to);
        rangeAnchor = null;
        rangePreview.visible = false;
        if (volume > OP_MAX_CELLS) {
          toast(t('sel.rangeTooLarge', { count: volume.toLocaleString(), max: OP_MAX_CELLS.toLocaleString() }));
          return 'handled';
        }
        if (cells.length === 0) {
          toast(t('sel.nothingInRange'));
          return 'handled';
        }
        selection.set(cellSelectionOf(cells));
        return 'handled';
      }
      case 'begin-drag':
        if (hit && beginDrag(hit, e)) return makeDragClaim();
        return 'handled';
      case 'immediate-select':
        selection.set(
          resolveClickSelection(doc.tree, selection.get(), action.cell, {
            ctrl: action.ctrl,
            doubleClick: action.doubleClick,
          }),
        );
        return 'handled';
      case 'clear-empty':
      case 'clear':
        selection.clear();
        return 'handled';
      case 'begin-marquee':
        marqueeSession = {
          anchor: action.anchorCell,
          anchorClient: [e.clientX, e.clientY],
          cellIfVoxel: action.cellIfVoxel,
          dragged: false,
          lastCell: action.anchorCell,
        };
        return makeMarqueeClaim();
      default:
        return 'handled';
    }
  }

  /**
   * pointermove while no claim is active (the router calls this on every move regardless of
   * whether a claim exists). drag/marquee are already handled by claim.onMove, so nothing
   * happens here for those. All that's left is tracking the preview while waiting for the
   * second point of a shift range selection (rangeAnchor set, second point not yet clicked).
   */
  function onHoverMove(e: PointerEvent): void {
    if (dragSession || marqueeSession) return;
    if (state.tool !== 'select' || !rangeAnchor) return;
    const hit = pickFromEvent(e);
    if (!hit) return;
    const cell = resolveSelectCell(hit);
    if (isValidCell(cell[0], cell[1], cell[2])) updateRangePreview(rangeAnchor, cell);
  }

  function handleGroup(): void {
    commitOpResult(doc, selection, buildGroup(doc, selection.get(), defaultName('group')), toast, opError);
  }

  function handleUngroup(): void {
    const sel = selection.get();
    if (sel.kind !== 'groups') {
      toast(t('sel.selectGroupToUngroup'));
      return;
    }
    commitOpResult(doc, selection, buildUngroup(doc, sel.ids), toast, opError);
  }

  /**
   * Nudge. For a cells selection, each ref is physically moved within its owner
   * (`buildMove`); for a groups selection, **`buildTranslateGroup` moves the transform's
   * translate** (design rev.3: group nudge / drag / inspector move were all switched to the
   * transform path in B1b).
   */
  function handleNudge(e: KeyboardEvent): void {
    // Maps onto the screen's left/right and near/far (#147). Pinning to world axes would mean
    // "which way does → move on screen" keeps changing every time the view is rotated
    const resolved = screenAlignedNudge(e.key, getCameraBasis());
    // The builder requires a mutable tuple, so copy it here
    const nudge: [number, number, number] | null = resolved ? [resolved[0], resolved[1], resolved[2]] : null;
    if (!nudge || dragSession) return;
    const sel = selection.get();
    if (sel.kind === 'none') return;
    e.preventDefault(); // consumed only when there's a target (otherwise yields to camerakeys' arrow-key camera movement)

    if (sel.kind === 'groups') {
      const ops: DocOp[] = [];
      for (const id of sel.ids) {
        const result = buildTranslateGroup(doc, id, nudge);
        if ('error' in result) {
          toast(result.error);
          return;
        }
        ops.push(...result.tx.ops);
      }
      if (ops.length) doc.applyTransaction({ ops });
    } else {
      const refs = selection.resolveRefs();
      if (!refs.length) return;
      commitOpResult(doc, selection, buildMove(doc, refs, nudge), toast, opError);
    }
  }

  /**
   * Rotates a groups selection 90 degrees around the Y axis (#37 B2). **Each group rotates
   * around its own pivot** — not the combined bbox center of a multi-selection (since the
   * pivot follows a "set on first use, kept afterward" contract, keeping the rotation center
   * unaffected by which combination is selected is more predictable).
   *
   * Bundled into a single transaction just like handleNudge, so if even one fails, nothing is
   * applied (never leaves things half-rotated).
   */
  function handleRotate(quarterTurns: 1 | 3): boolean {
    // Also blocked on the router side (duringGesture: 'block'), but since handle is a public
    // API, it's made a no-op here too. Moving a transform mid-drag would shift the reference
    // frame the ghost preview relies on, silently discarding the drag move on pointerup's
    // commit (review, #41 P1)
    if (dragSession) return false;
    const sel = selection.get();
    if (sel.kind !== 'groups') {
      // Rotating a cells selection isn't supported (only a group-level transform can be
      // rotated). Silently ignoring it would leave it unclear whether the key isn't working
      // or the target is wrong, so surface a reason the same way as deselection does
      if (sel.kind === 'cells') toast(t('sel.selectGroupToRotate'));
      return false;
    }
    const ops: DocOp[] = [];
    for (const id of sel.ids) {
      const result = buildRotateGroup90(doc, id, quarterTurns);
      if ('error' in result) {
        toast(result.error);
        return true; // there was a target (it just couldn't be rotated), so consume the key rather than letting it fall through to arrow keys etc.
      }
      ops.push(...result.tx.ops);
    }
    if (ops.length) doc.applyTransaction({ ops });
    return true;
  }

  /**
   * Mirrors the selection across a world axis (#63). Unlike rotation, **this also works for a
   * cells selection** — since it's an operation that physically re-places the cells, it
   * doesn't need a group-level transform.
   *
   * Same as rotation: a no-op mid-drag (doesn't disturb the ghost preview's reference frame).
   */
  function handleMirror(axis: MirrorAxis): boolean {
    if (dragSession) return false;
    const sel = selection.get();
    if (sel.kind === 'none') return false;
    commitOpResult(doc, selection, buildMirror(doc, sel, axis), toast, opError);
    return true; // there was a target (a toast was already shown even if it couldn't be flipped), so consume the key
  }

  function handleDuplicate(): void {
    commitOpResult(doc, selection, buildDuplicate(doc, selection.get()), toast, opError);
  }

  function handleCopy(): void {
    const clip = snapshotSelection(doc, selection.get());
    if (!clip) {
      toast(t('sel.nothingToCopy'));
      return;
    }
    clipboard = clip;
  }

  function handlePaste(): void {
    if (!clipboard) {
      toast(t('sel.clipboardEmpty'));
      return;
    }
    commitOpResult(doc, selection, buildPaste(doc, clipboard), toast, opError);
  }

  function handleDelete(e: KeyboardEvent): void {
    const result = buildDeleteSelection(doc, selection.get());
    if (!('tx' in result) || result.tx.ops.length === 0) return;
    e.preventDefault(); // consumed only when there's something to delete (otherwise doesn't interfere with the browser's default Backspace=back etc.)
    doc.applyTransaction(result.tx);
    selection.clear();
  }

  function cancelActive(): void {
    // If the router (broadcastCancel) already canceled one step of drag/marquee via
    // endActiveClaim(), the priority chain is already complete there. Don't chain further
    // into rangeAnchor/deselect here (regression, #12 PR3).
    if (claimCancelledThisBroadcast) {
      claimCancelledThisBroadcast = false;
      return;
    }
    // The following is a fallback for when cancelActive() is called standalone, without going through the router's claim mechanism.
    if (dragSession) {
      cancelDrag();
      return;
    }
    if (marqueeSession) {
      marqueeSession = null;
      rangePreview.visible = false;
      return;
    }
    if (rangeAnchor) {
      rangeAnchor = null;
      rangePreview.visible = false;
      return;
    }
    if (selection.get().kind !== 'none') selection.clear();
  }

  return {
    isDragging: () => dragSession !== null || marqueeSession !== null,
    hasActiveDrag: () => dragSession !== null,
    cancelActive,
    handleGroup,
    handleUngroup,
    handleNudge,
    handleRotate,
    handleMirror,
    handleDuplicate,
    handleCopy,
    handlePaste,
    handleDelete,
    route: { id: 'select-tool', onPointerDown, onHoverMove },
  };
}
