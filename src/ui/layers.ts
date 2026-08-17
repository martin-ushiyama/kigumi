import { applyTextureImage } from './textureframe';
import { makeCellRefKey, type CellRef } from '../core/cellref';
import type { Document } from '../core/document';
import { unpackCell } from '../core/orientation';
import { countCellsInSubtree } from '../core/ownerlocal';
import { makeCellKey, type BlockDef } from '../core/types';
import textureManifest from '../data/textures.json';
import {
  buildDeleteSelection,
  buildDuplicate,
  buildMoveCellsToGroup,
  buildRename,
  buildReparentGroups,
  buildToggleHidden,
  buildToggleLocked,
  computeDropIndexFor,
  dragPayloadFor,
  type DragPayload,
} from '../editor/ops';
import {
  layerRowKey,
  layerRowsInRange,
  rangeKeepsBothEnds,
  stepLayerCursor,
  visibleLayerRows,
  type LayerRow,
  type LayerRowRef,
} from '../editor/layerrows';
import { cellSelectionOf, normalizeSelection, type Selection, type SelectionStore } from '../editor/selection';
import { createIcon, type IconName } from './icons';
import { createButton } from './primitives';
import { blockName, matchesBlockQuery, onLangChange, t } from '../state';
/**
 * Drop-target zone for group rows. Cell rows don't have this (always the single "move into
 * this group" choice).
 *
 * **Named after the on-screen position**. It used to reuse the sibling array's
 * `'before' | 'after'` wording, but display renders front-most at the top while the array
 * treats front as the back — **the directions are reversed**, so the same words would leave
 * it ambiguous which "before" is meant.
 */
type DropZone = 'above' | 'into' | 'below';

function iconButton(icon: IconName, title = ''): HTMLButtonElement {
  return createButton({
    label: '',
    ariaLabel: title,
    title,
    icon: createIcon(icon),
    variant: 'icon',
    className: 'icon-btn',
  });
}

/** Re-applies an icon button's text. The accessible name and tooltip must always match */
function setIconButtonLabel(button: HTMLButtonElement, label: string): void {
  button.setAttribute('aria-label', label);
  button.title = label;
}

/** Outward-facing interface of the layers panel. The keyboard path calls it from SHORTCUTS */
export interface LayersPanel {
  /**
   * Whether Shift+↑ / ↓ **can be handled as a layers operation** (no side effects review P1).
   *
   * `dispatchShortcut` consumes the key without looking at `run`'s return value, so whether to
   * accept it has to be decided on the shortcut table's `matches` side. When false, it falls
   * through to the usual assignment (nudge / camera).
   *
   * "There is a selection" alone isn't enough — if a selected child group is hidden by its
   * parent's collapse, the Selection still holds it, but no selected row remains among the
   * visible rows.
   */
  canExtendSelection(): boolean;
  /**
   * Grows / shrinks the selection along the panel's row order via Shift+↑ / ↓.
   * Assumes it's only called when `canExtendSelection()` is true, and always consumes the key.
   */
  extendSelection(direction: -1 | 1): void;
}

interface TextureEntry {
  side: string;
  top?: string;
}
const MANIFEST = textureManifest as Record<string, TextureEntry>;


/**
 * The left-sidebar layers tree panel. Shows groups plus every placed block (expanding a
 * group reveals the blocks inside it; unclassified blocks directly under root also become
 * their own rows). Double-click to rename, plus collapse and delete buttons.
 *
 * For builds with a lot of blocks (hundreds to thousands), the row count grows right along
 * with it — no virtualization for now (render everything plainly first; whether to add
 * virtualization is an operational call to revisit if it actually gets slow).
 */
export function initLayers(
  root: HTMLElement,
  doc: Document,
  selection: SelectionStore,
  getCatalog: () => BlockDef[],
  toast: (msg: string) => void,
): LayersPanel {
  const expandedIds = new Set<string>();
  let renamingId: string | null = null;
  let lastSelFingerprint = '';
  /** The drag target. If the grabbed row is part of the selection, the whole selection moves; otherwise just that one row */
  let dragged: DragPayload | null = null;

  /**
   * **Locks in the selection the moment it's grabbed**.
   *
   * Grabbing a row outside the current selection with no modifier key moves the selection to
   * just that row (same as Finder / Explorer / Figma). The goal is to **always keep "what was
   * moved" and "what Delete / Ctrl+D targets next" in sync** — the same rule holds for clicks,
   * not just drags.
   *
   * This runs on mousedown (rather than dragstart) so that render() finishes before dragstart
   * fires — changing the selection inside dragstart would let the synchronous render replace
   * the source element and break the drag.
   *
   * Rows already in the selection are left untouched (so a multi-selection can still be
   * dragged as a group; collapsing to a single selection in that case is the click handler's
   * job).
   */
  function claimSelectionOnGrab(
    e: MouseEvent,
    isInSelection: boolean,
    soleSelection: () => Selection,
    anchorRow: LayerRowRef,
  ): void {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    // Buttons inside the row (duplicate / delete / show / lock), the caret, and the rename input are not selection actions
    if ((e.target as HTMLElement | null)?.closest('button, input, .caret, .layer-actions')) return;
    if (isInSelection) return;
    selection.set(soleSelection());
    setAnchor(anchorRow);
  }

  /**
   * State for the Shift+↑↓ range selection. **Kept as row identity keys** — a row's
   * index shifts on re-render or collapse, but a key can still be tracked down.
   *
   * `anchorKey` is the fixed end of the range (the row from the single selection); `cursorKey`
   * is the end being extended.
   */
  let anchorKey: string | null = null;
  let cursorKey: string | null = null;

  /** Resets the anchor at the point a single selection is confirmed (on click / on grab) */
  function setAnchor(row: LayerRowRef): void {
    anchorKey = layerRowKey(row);
    cursorKey = anchorKey;
  }

  const rowsReader = {
    childrenOf: (parentId: string | null) => doc.tree.childrenOf(parentId),
    isInstance: (id: string) => doc.templateIdOf(id) !== null,
    localCellKeysOf: function* (ownerId: string | null) {
      for (const [key] of doc.scene.cells.entriesOf(ownerId)) yield key;
    },
  };

  /**
   * Shift+↑↓: grows / shrinks the selection along the layers panel row order.
   *
   * Rows of a different kind (group row ↔ block row) are skipped — `Selection` can't
   * represent a mix as an exclusive union. At the end, **the key is still consumed**
   * (letting it fall through to nudge or camera movement with nothing happening would mean
   * "holding Shift suddenly moves blocks").
   *
   * The return value is "was the key accepted as a layers operation?" If false, the caller
   * (SHORTCUTS) falls back to nudge / camera as usual.
   */
  /** Filter string. Empty means no filtering */
  let filterText = '';

  /** Whether the name shown on the row (group name / block's localized display name) contains the filter string */
  function rowMatchesFilter(row: LayerRow): boolean {
    const needle = filterText.trim().toLowerCase();
    if (!needle) return true;
    if (row.kind === 'group') return (doc.tree.getNode(row.id)?.name ?? '').toLowerCase().includes(needle);
    const localRaw = doc.scene.cells.get(row.ref.ownerId, makeCellKey(...row.ref.localCell));
    if (localRaw === undefined) return false;
    const def = getCatalog()[unpackCell(localRaw).catalogIndex];
    // **Only match text that's actually shown on screen**. The catalog ID
    // (minecraft:* etc.) isn't displayed in the row, so implicitly OR-ing it in would make
    // filtering unreadable ("why did this stay in the results?"). If ID search is needed,
    // add it separately as an explicit syntax like `id:minecraft:stone`
    return !!def && matchesBlockQuery(def, needle);
  }

  /**
   * The currently visible row order. Both rendering and keyboard movement go through
   * this — to structurally avoid mismatches like "the cursor moves to a row that's not on
   * screen" while filtering.
   */
  function currentRows(): LayerRow[] {
    return filterText.trim()
      ? visibleLayerRows(rowsReader, expandedIds, rowMatchesFilter)
      : visibleLayerRows(rowsReader, expandedIds);
  }

  /**
   * Resolves the target of Shift+↑↓. No side effects — both `canExtendSelection` and
   * `extendSelection` go through this, upholding the contract that "if matches is true, run
   * always consumes the key."
   */
  function resolveRange(direction: -1 | 1): {
    rows: LayerRow[];
    kind: LayerRow['kind'];
    anchor: number;
    cursor: number;
  } | null {
    const sel = selection.get();
    if (sel.kind === 'none') return null;
    const kind: LayerRow['kind'] = sel.kind === 'groups' ? 'group' : 'cell';

    const rows = currentRows();
    if (!rows.length) return null;

    const isSelected = (row: LayerRow): boolean =>
      row.kind === 'group'
        ? sel.kind === 'groups' && sel.ids.includes(row.id)
        : sel.kind === 'cells' && sel.cells.has(makeCellRefKey(row.ref));
    const indexOf = (key: string | null): number =>
      key === null ? -1 : rows.findIndex((row) => layerRowKey(row) === key);

    let anchor = indexOf(anchorKey);
    let cursor = indexOf(cursorKey);
    if (anchor === -1 || rows[anchor]!.kind !== kind || !isSelected(rows[anchor]!)) {
      // The anchor is stale (the selection changed from outside the panel / got hidden by a
      // collapse, etc.) — re-derive the anchor from the selection among visible rows, taking
      // the end opposite the direction of travel
      const selected = rows.map((row, i) => ({ row, i })).filter((x) => x.row.kind === kind && isSelected(x.row));
      if (!selected.length) return null; // No selected row among the visible rows = cannot be handled
      anchor = direction === 1 ? selected[0]!.i : selected[selected.length - 1]!.i;
      cursor = direction === 1 ? selected[selected.length - 1]!.i : selected[0]!.i;
    }
    if (cursor === -1) cursor = anchor;
    return { rows, kind, anchor, cursor };
  }

  function canExtendSelection(): boolean {
    // Regardless of direction, only checks "is there a selection among the visible rows?"
    // (whether it's at the end is a separate question from whether it can be handled — at the
    // end, the key is consumed and nothing happens = it doesn't leak to nudge or camera)
    return resolveRange(1) !== null;
  }

  const isAncestor = (ancestorId: string, id: string): boolean => doc.tree.isAncestor(ancestorId, id);

  /**
   * Shift+↑↓: grows / shrinks the selection along the layers panel row order.
   *
   * There are two kinds of rows this skips over:
   * - **Rows of a different kind** (group row ↔ block row) — `Selection` can't represent a
   *   mix as an exclusive union
   * - **Rows dropped by normalization** — including a parent and child in the range at the
   *   same time makes one of them disappear, throwing the internal cursor out of sync with
   *   the actual Selection
   *
   * At the end, nothing changes, but **the key is still consumed** (letting it fall through
   * to nudge or camera movement with nothing happening would mean "holding Shift suddenly
   * moves blocks").
   */
  function extendSelection(direction: -1 | 1): void {
    const range = resolveRange(direction);
    if (!range) return;
    const { rows, kind, anchor, cursor } = range;

    const next = stepLayerCursor(rows, cursor, direction, kind, (_row, index) =>
      !rangeKeepsBothEnds(rows, anchor, index, isAncestor),
    );
    if (next === null) return; // At the end. Nothing changes (the key was already consumed by the caller)
    anchorKey = layerRowKey(rows[anchor]!);
    cursorKey = layerRowKey(rows[next]!);

    const picked = layerRowsInRange(rows, anchor, next, kind, isAncestor);
    if (kind === 'group') {
      selection.set({ kind: 'groups', ids: picked.map((row) => (row as { kind: 'group'; id: string }).id) });
    } else {
      const cells = [];
      for (const row of picked) {
        const ref = (row as { kind: 'cell'; ref: CellRef }).ref;
        const worldCell = doc.index.worldOf(ref);
        if (worldCell) cells.push({ ref, worldCell });
      }
      selection.set(cellSelectionOf(cells));
    }
  }

  /** Common dragstart logic: determine and hold the actual drag target from the grabbed row */
  function beginDrag(e: DragEvent, grabbed: DragPayload, fallbackLabel: string): void {
    dragged = dragPayloadFor(selection.get(), grabbed);
    const count = dragged.kind === 'groups' ? dragged.ids.length : dragged.refs.length;
    e.dataTransfer?.setData('text/plain', count > 1 ? t('layers.count', { count }) : fallbackLabel);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  function clearDropIndicator(): void {
    root.querySelectorAll('.drop-above, .drop-into, .drop-below').forEach((el) => {
      el.classList.remove('drop-above', 'drop-into', 'drop-below');
    });
  }

  function zoneOf(row: HTMLElement, clientY: number): DropZone {
    const rect = row.getBoundingClientRect();
    const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
    if (ratio < 0.25) return 'above';
    if (ratio > 0.75) return 'below';
    return 'into';
  }

  /** Common entry point for applying an OpResult (errors go to a toast; an empty tx is discarded so it doesn't clutter the history) */
  function commit(result: ReturnType<typeof buildReparentGroups>): void {
    if ('error' in result) {
      toast(result.error);
      return;
    }
    if (result.tx.ops.length) doc.applyTransaction(result.tx);
  }

  /** Moves whatever's being dragged (groups or cells, doesn't matter) to the front as a child
   *  of groupId (null = unclassified/root). In the sibling array, last = front = the top child
   *  in the display. Whatever got dropped ends up somewhere visible.
   *  A cell only changes ownership (no ordering concept); a group is reparented (moving into
   *  itself or a descendant is rejected by buildReparentGroups). Even with multiple targets,
   *  it's one transaction = one undo */
  function dropOntoGroup(groupId: string | null): void {
    if (!dragged) return;
    if (dragged.kind === 'cells') {
      commit(buildMoveCellsToGroup(doc, dragged.refs, groupId));
      return;
    }
    if (groupId !== null && dragged.ids.includes(groupId)) return; // Ignore self-drops
    commit(buildReparentGroups(doc, dragged.ids, groupId, doc.tree.childrenOf(groupId).length));
  }

  /** Drop on the top/bottom edge of a group row (sibling-order reorder). "into" is treated the same as dropOntoGroup(id) on a group row */
  function dropOnGroupSibling(targetId: string, targetParentId: string | null, zone: 'above' | 'below'): void {
    if (!dragged) return;
    if (dragged.kind === 'cells') {
      // Cells have no sibling order, so this just moves it to the same parent group as the
      // target (there's nothing in Figma equivalent to a cell, so this is our own
      // interpretation with no corresponding behavior in other tools)
      dropOntoGroup(targetParentId);
      return;
    }
    if (dragged.ids.includes(targetId)) return;
    const siblings = doc.tree.childrenOf(targetParentId);
    // **On-screen up/down and sibling-array front/back are reversed**. Display renders
    // front at the top while the sibling array treats front as the back, so "drop above the
    // target = move it in front of the target" means inserting it after the target in the array
    const position = zone === 'above' ? 'after' : 'before';
    const newIndex = computeDropIndexFor(siblings, dragged.ids, targetId, position);
    commit(buildReparentGroups(doc, dragged.ids, targetParentId, newIndex));
  }

  function selectionFingerprint(sel: Selection): string {
    if (sel.kind === 'none') return 'none';
    if (sel.kind === 'groups') return `g:${[...sel.ids].sort().join(',')}`;
    return `c:${[...sel.cells.keys()].sort().join(',')}`;
  }

  /** Expands the ancestor groups of a selected group/cell (syncs viewport selection to layers visibility) */
  function expandAncestorsOf(groupId: string): void {
    let current: string | null = doc.tree.getNode(groupId)?.parentId ?? null;
    while (current !== null) {
      expandedIds.add(current);
      current = doc.tree.getNode(current)?.parentId ?? null;
    }
  }

  function ensureVisible(sel: Selection): void {
    if (sel.kind === 'groups') {
      for (const id of sel.ids) expandAncestorsOf(id);
    } else if (sel.kind === 'cells') {
      for (const cell of sel.cells.values()) {
        const groupId = cell.ref.ownerId;
        if (groupId !== null) {
          expandedIds.add(groupId);
          expandAncestorsOf(groupId);
        }
      }
    }
  }

  function blockIcon(def: BlockDef): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'layer-block-icon';
    const entry = MANIFEST[def.id];
    if (entry) {
      const img = document.createElement('img');
      applyTextureImage(wrap, img, entry.side);
      img.alt = '';
      img.addEventListener(
        'error',
        () => {
          img.remove();
          wrap.style.background = def.color;
        },
        { once: true },
      );
      wrap.appendChild(img);
    } else {
      wrap.style.background = def.color; // Blocks without a texture just get a flat color
    }
    return wrap;
  }

  function commitRename(id: string, rawName: string): void {
    const name = rawName.trim();
    renamingId = null;
    if (!name) {
      render(); // Empty input reverts (no change)
      return;
    }
    const tx = buildRename(doc, id, name);
    if (tx.ops.length) doc.applyTransaction(tx);
    else render();
  }

  function render(): void {
    const sel = selection.get();
    const fp = selectionFingerprint(sel);
    const selectionChanged = fp !== lastSelFingerprint;
    if (selectionChanged) {
      lastSelFingerprint = fp;
      ensureVisible(sel);
    }

    const filtering = filterText.trim().length > 0;
    treeHost.innerHTML = '';
    const tree = document.createElement('div');
    tree.className = 'layers-tree';
    let selectedRowEl: HTMLElement | null = null;

    /**
     * A single-cell row. Identity is the ref (owner + owner-local); displayed coordinates are
     * the projected world position. `localRaw` is oriented owner-local, but since
     * the row only uses catalogIndex, rotation doesn't matter here.
     */
    function renderCellRow(ref: CellRef, localRaw: number, depth: number): void {
      const world = doc.index.worldOf(ref);
      if (!world) return; // Not yet projected (transient state)
      const [x, y, z] = world;
      const { catalogIndex } = unpackCell(localRaw);
      const def = getCatalog()[catalogIndex];
      if (!def) return;
      const refKey = makeCellRefKey(ref);

      const row = document.createElement('div');
      row.className = 'layer-row layer-row-cell';
      row.style.paddingLeft = `${depth * 16 + 8}px`;

      const caretSpacer = document.createElement('span');
      caretSpacer.className = 'caret';
      row.appendChild(caretSpacer);
      row.appendChild(blockIcon(def));

      const isSelected = sel.kind === 'cells' && sel.cells.has(refKey);
      row.classList.toggle('active', isSelected);
      if (isSelected) selectedRowEl = row;
      row.classList.toggle('layer-row-dimmed', doc.tree.isHiddenEffective(ref.ownerId));

      const nameEl = document.createElement('span');
      nameEl.className = 'layer-name';
      nameEl.textContent = `${blockName(def)} (${x},${y},${z})`;
      row.appendChild(nameEl);

      row.addEventListener('click', (e) => {
        // Accepts both Ctrl/Cmd+click (the Windows list-operation convention) and Shift+click
        // (Figma's multi-select toggle) as toggles (see README/shortcut-research; added to
        // align with Figma)
        if (e.ctrlKey || e.metaKey || e.shiftKey) selection.toggleCell({ ref, worldCell: world });
        else selection.set(cellSelectionOf([{ ref, worldCell: world }]));
        setAnchor({ kind: 'cell', ref }); // Shift+↑↓ range selection uses this as its fixed end
      });

      // Drag and drop (can't be grabbed while locked, consistent with the protection documented in the README)
      row.draggable = !doc.tree.isLockedEffective(ref.ownerId);
      row.addEventListener('mousedown', (e) =>
        claimSelectionOnGrab(e, isSelected, () => cellSelectionOf([{ ref, worldCell: world }]), { kind: 'cell', ref }),
      );
      row.addEventListener('dragstart', (e) => beginDrag(e, { kind: 'cells', refs: [ref] }, refKey));
      row.addEventListener('dragover', (e) => {
        if (!dragged) return;
        e.preventDefault();
        e.stopPropagation(); // Prevent double-handling with a drop directly on root (append to the end)
        clearDropIndicator();
        row.classList.add('drop-into'); // A cell row only has the single choice of "move to the owning group"
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-into'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearDropIndicator();
        if (!dragged) return;
        dropOntoGroup(ref.ownerId);
        dragged = null;
      });
      row.addEventListener('dragend', () => {
        clearDropIndicator();
        dragged = null;
      });

      tree.appendChild(row);
    }

    function renderNode(id: string, depth: number): void {
      const node = doc.tree.getNode(id);
      if (!node) return;
      const row = document.createElement('div');
      row.className = 'layer-row';
      row.style.paddingLeft = `${depth * 16 + 8}px`;
      row.dataset.testid = 'layer-row-group';
      row.dataset.groupId = id;

      const childGroupIds = doc.tree.childrenOf(id);
      // Direct cells are pulled from the owner-local store (the membership index has been removed)
      const directCells = [...doc.scene.cells.entriesOf(id)];
      // **Instances don't expand their contents**. What's inside is a copy of the
      // component, and any edit gets overwritten the moment the component is edited.
      // Expanding it would show something you can touch but that won't stick.
      const isInstance = doc.templateIdOf(id) !== null;
      const isExpandable = !isInstance && (childGroupIds.length > 0 || directCells.length > 0);
      // While filtering, staying collapsed would make matches unreachable, so it's always treated as expanded
      const expanded = filtering ? true : expandedIds.has(id);
      const caret = document.createElement('span');
      caret.className = 'caret';
      caret.textContent = isExpandable ? (expanded ? '▾' : '▸') : '';
      // Makes the caret a complete no-op while filtering (raised in review).
      //
      // The display is always expanded, but click still rewrote expandedIds, so clicking did
      // nothing visible while leaving a delayed state change — it would collapse the instant
      // the filter was cleared.
      //
      // But **just removing the listener isn't enough** — the click would bubble to the
      // parent row and fire group selection instead of expanding (the second-pass finding).
      // Removing the listener would also remove the thing stopping that bubble, so the
      // listener stays attached even while filtering, as an inert handler that only calls
      // stopPropagation.
      caret.classList.toggle('caret-static', filtering);
      if (isExpandable) {
        caret.addEventListener('click', (e) => {
          e.stopPropagation();
          if (filtering) return; // Does nothing: changes neither expansion state nor selection
          if (expanded) expandedIds.delete(id);
          else expandedIds.add(id);
          render();
        });
      }
      row.appendChild(caret);

      const isSelected = sel.kind === 'groups' && sel.ids.includes(id);
      row.classList.toggle('active', isSelected);
      // A component instance. **Shown with both an icon and a lighter color** —
      // color alone would be confused with a selected row, and an icon alone would be hard
      // to spot among a row of collapsed items
      row.classList.toggle('layer-row-instance', isInstance);
      if (isInstance) {
        const mark = createIcon('square-plus');
        mark.classList.add('layer-instance-mark');
        row.appendChild(mark);
      }
      if (isSelected) selectedRowEl = row;
      row.classList.toggle('layer-row-dimmed', doc.tree.isHiddenEffective(id));

      if (renamingId === id) {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = node.name;
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('blur', () => commitRename(id, input.value));
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') input.blur();
          if (e.key === 'Escape') {
            renamingId = null;
            render();
          }
        });
        row.appendChild(input);
        queueMicrotask(() => {
          input.focus();
          input.select();
        });
      } else {
        const nameEl = document.createElement('span');
        nameEl.className = 'layer-name';
        nameEl.textContent = `${node.name} (${countCellsInSubtree(doc.scene, id)})`;
        nameEl.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          renamingId = id;
          render();
        });
        row.appendChild(nameEl);
      }

      const actions = document.createElement('span');
      actions.className = 'layer-actions';
      const hideBtn = iconButton(node.hidden ? 'eye-off' : 'eye', node.hidden ? t('layers.show') : t('layers.hide'));
      hideBtn.dataset.testid = 'layer-hide-btn';
      hideBtn.classList.toggle('icon-btn-on', !!node.hidden);
      hideBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tx = buildToggleHidden(doc, id);
        if (tx.ops.length) doc.applyTransaction(tx);
      });
      actions.appendChild(hideBtn);
      const lockBtn = iconButton(node.locked ? 'lock' : 'unlock', node.locked ? t('layers.unlock') : t('layers.lock'));
      lockBtn.dataset.testid = 'layer-lock-btn';
      lockBtn.classList.toggle('icon-btn-on', !!node.locked);
      lockBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tx = buildToggleLocked(doc, id);
        if (tx.ops.length) doc.applyTransaction(tx);
      });
      actions.appendChild(lockBtn);
      const dupBtn = iconButton('copy', t('layers.duplicateGroup'));
      dupBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const result = buildDuplicate(doc, normalizeSelection(doc.tree, { kind: 'groups', ids: [id] }));
        if ('error' in result) return;
        doc.applyTransaction(result.tx);
        if (result.newSelection) selection.set(result.newSelection);
      });
      actions.appendChild(dupBtn);
      const delBtn = iconButton('trash', t('layers.deleteGroup'));
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const result = buildDeleteSelection(doc, normalizeSelection(doc.tree, { kind: 'groups', ids: [id] }));
        if ('tx' in result && result.tx.ops.length) doc.applyTransaction(result.tx);
        const cur = selection.get();
        if (cur.kind === 'groups' && cur.ids.includes(id)) selection.clear();
      });
      actions.appendChild(delBtn);
      row.appendChild(actions);

      row.addEventListener('click', (e) => {
        // Accepts both Ctrl/Cmd+click (the Windows list-operation convention) and Shift+click
        // (Figma's multi-select toggle) as toggles (see README/shortcut-research; added to
        // align with Figma)
        if (e.ctrlKey || e.metaKey || e.shiftKey) selection.toggleGroup(id);
        else selection.set({ kind: 'groups', ids: [id] });
        setAnchor({ kind: 'group', id }); // Shift+↑↓ range selection uses this as its fixed end
      });

      // Drag and drop (can't be grabbed while locked, including inherited from ancestors; disabled during rename to prevent accidental changes)
      const groupLocked = doc.tree.isLockedEffective(id);
      row.draggable = !groupLocked && renamingId !== id;
      row.addEventListener('mousedown', (e) =>
        claimSelectionOnGrab(e, isSelected, () => ({ kind: 'groups', ids: [id] }), { kind: 'group', id }),
      );
      row.addEventListener('dragstart', (e) => beginDrag(e, { kind: 'groups', ids: [id] }, id));
      row.addEventListener('dragover', (e) => {
        if (!dragged) return;
        if (dragged.kind === 'groups' && dragged.ids.includes(id)) return; // Don't show a self-drop
        e.preventDefault();
        e.stopPropagation(); // Prevent double-handling with a drop directly on root (append to the end)
        clearDropIndicator();
        row.classList.add(`drop-${zoneOf(row, e.clientY)}`);
      });
      row.addEventListener('dragleave', () => clearDropIndicator());
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const zone = zoneOf(row, e.clientY);
        clearDropIndicator();
        if (!dragged) return;
        if (zone === 'into') dropOntoGroup(id);
        else dropOnGroupSibling(id, node.parentId, zone);
        dragged = null;
      });
      row.addEventListener('dragend', () => {
        clearDropIndicator();
        dragged = null;
      });

      tree.appendChild(row);
    }

    // visibleLayerRows is the single source of truth for row order. To keep rendering
    // and keyboard movement from disagreeing on the definition of "visible row," the
    // recursion lives there rather than here
    const rows = currentRows();
    for (const row of rows) {
      if (row.kind === 'group') {
        renderNode(row.id, row.depth);
        continue;
      }
      const localRaw = doc.scene.cells.get(row.ref.ownerId, makeCellKey(...row.ref.localCell));
      if (localRaw !== undefined) renderCellRow(row.ref, localRaw, row.depth);
    }
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'layers-empty';
      empty.textContent = filterText ? t('layers.noMatch') : t('layers.empty');
      tree.appendChild(empty);
    }
    treeHost.appendChild(tree);

    if (selectionChanged && selectedRowEl) {
      (selectedRowEl as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }

  // ---- Persistent header. render() only swaps out the contents of treeHost, so
  //      caret position and focus during typing don't get lost on re-render ----
  root.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'layers-header';

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'layers-search';
  search.addEventListener('input', () => {
    filterText = search.value;
    render();
  });
  header.appendChild(search);

  const headerActions = document.createElement('div');
  headerActions.className = 'layers-header-actions';
  const expandAllBtn = iconButton('chevron-down');
  expandAllBtn.addEventListener('click', () => {
    for (const node of doc.tree.allNodesPreOrder()) expandedIds.add(node.id);
    render();
  });
  const collapseAllBtn = iconButton('chevron-up');
  collapseAllBtn.addEventListener('click', () => {
    expandedIds.clear();
    render();
  });
  headerActions.append(expandAllBtn, collapseAllBtn);
  header.appendChild(headerActions);

  /**
   * The header is built once, outside `render()` (rebuilding it while the search field is
   * focused would lose the input). To make up for that, **only the text is re-applied on
   * every language switch** — if t() were left evaluated at creation time, it would keep the
   * language from startup.
   */
  function applyHeaderLabels(): void {
    search.placeholder = t('layers.filter');
    setIconButtonLabel(expandAllBtn, t('layers.expandAll'));
    setIconButtonLabel(collapseAllBtn, t('layers.collapseAll'));
  }
  applyHeaderLabels();

  const treeHost = document.createElement('div');
  treeHost.className = 'layers-tree-host';
  root.append(header, treeHost);

  // A drop that wasn't stopPropagation'd by a row's drop handler (= dropped on empty space
  // outside any row) moves to root (unclassified). Since root itself stays the same element
  // even when render() swaps out its innerHTML, this only needs to be registered once here
  root.addEventListener('dragover', (e) => {
    if (!dragged) return;
    e.preventDefault();
  });
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    clearDropIndicator();
    if (!dragged) return;
    dropOntoGroup(null);
    dragged = null;
  });

  doc.subscribe(render);

  onLangChange(() => {
    applyHeaderLabels(); // The header is outside render(), so re-apply it separately
    render(); // Block names inside the tree
  });
  selection.subscribe(render);
  render();

  return { canExtendSelection, extendSelection };
}
