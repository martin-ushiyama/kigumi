import type { Document } from '../core/document';
import { countCellsInSubtree, localKeyOf } from '../core/ownerlocal';
import {
  buildDeleteSelection,
  buildDuplicate,
  buildGroup,
  buildMirror,
  buildMove,
  buildRename,
  buildReplaceSelection,
  resolveSelectionRefs,
  buildRotateGroup90,
  buildSetCell,
  buildTranslateGroup,
  buildUngroup,
  clampDeltaToBounds,
  commitOpResult,
} from '../editor/ops';
import type { MirrorAxis } from '../core/transform';
import { cellSelectionOf, normalizeSelection, type NormalizedSelection, type SelectedCell, type SelectionStore } from '../editor/selection';
import type { MixRecipe } from '../core/mixpalette';
import {
  cycleFacing,
  cyclePillarAxis,
  decodeOrientation,
  defaultCode,
  packCell,
  toggleFlip,
  unpackCell,
  type Orientation,
} from '../core/orientation';
import { isPillarBlock, type BlockDef, type Cell } from '../core/types';
import { blockName, defaultName, onLangChange, onStateChange, opError, state, t } from '../state';
import { createIcon, type IconName } from './icons';
import { createButton } from './primitives';

/**
 * The right-sidebar inspector panel. Shows different sections depending on the selection kind
 * (single group / single cell / multiple). Rebuilt on doc/selection subscriptions, same as #layers.
 */
export function initInspector(
  root: HTMLElement,
  doc: Document,
  selection: SelectionStore,
  getCatalog: () => BlockDef[],
  toast: (msg: string) => void,
  /** The recipe currently being rolled in the mix palette (null for solid-color mode). Used to paint the selection with a pattern */
  getActivePattern: () => MixRecipe | null = () => null,
  /** blockId → catalog index (for resolving recipes) */
  indexOfBlock: (blockId: string) => number | undefined = () => undefined,
  /** Subscription hook for recipe edits. Changing a ratio changes the displayed block, so a re-render is needed */
  subscribeRecipes: (fn: () => void) => void = () => {},
  /** Turns the selected group into a component. If not provided, no entry point is shown */
  componentActions: {
    createFromSelection: (sel: NormalizedSelection) => void;
    detach: (groupId: string) => void;
    isInstance: (groupId: string) => boolean;
    /** Jumps in to edit that instance's component. Only the entry point differs; there's only one mode once inside */
    editComponentOf: (groupId: string) => void;
  } | null = null,
): void {
  function field(label: string, valueEl: HTMLElement): HTMLElement {
    const row = document.createElement('div');
    row.className = 'inspector-field';
    const labelEl = document.createElement('span');
    labelEl.className = 'inspector-field-label';
    labelEl.textContent = label;
    row.append(labelEl, valueEl);
    return row;
  }

  /** As in Figma's property panel, a heading conveys the meaning of the operation up front, instead of a divider line. */
  function section(title: string, ...children: HTMLElement[]): HTMLElement {
    const el = document.createElement('section');
    el.className = 'inspector-section';
    const heading = document.createElement('h3');
    heading.className = 'inspector-section-title';
    heading.textContent = title;
    el.append(heading, ...children);
    return el;
  }

  /** Keeps X/Y/Z or W/H/D attached to the input rather than pushed outside it, so they read as one with the value. */
  function prefixedControl(prefix: string, control: HTMLElement, ariaLabel: string): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'inspector-prefixed-control';
    const mark = document.createElement('span');
    mark.textContent = prefix;
    if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
      control.setAttribute('aria-label', ariaLabel);
    }
    wrap.append(mark, control);
    return wrap;
  }

  function metric(prefix: string, value: number, label: string): HTMLElement {
    const output = document.createElement('output');
    output.textContent = String(value);
    output.setAttribute('aria-label', `${label}: ${value}`);
    return prefixedControl(prefix, output, label);
  }

  function actionButton(label: string, onClick: () => void): HTMLButtonElement {
    return createButton({ label, onClick });
  }

  function iconActionButton(
    icon: IconName,
    label: string,
    shortcut: string | null,
    onClick: () => void,
    axis?: string,
  ): HTMLButtonElement {
    const title = shortcut ? `${label} (${shortcut})` : label;
    const button = createButton({
      label: '',
      ariaLabel: label,
      title,
      icon: createIcon(icon),
      variant: 'icon',
      className: 'inspector-icon-action',
      onClick,
    });
    if (axis) {
      const axisLabel = document.createElement('span');
      axisLabel.className = 'inspector-icon-axis';
      axisLabel.textContent = axis;
      button.append(axisLabel);
    }
    return button;
  }

  /** A number input that only accepts integers. Confirmed on blur/Enter; NaN, non-integer, or unchanged values revert (the redraw restores the original value) */
  function numberInput(value: number, onCommit: (next: number) => void): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '1';
    input.value = String(value);
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') input.blur();
    });
    input.addEventListener('blur', () => {
      const parsed = Number(input.value);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed === value) {
        render();
        return;
      }
      onCommit(parsed);
    });
    return input;
  }

  function render(): void {
    root.innerHTML = '';
    const sel = selection.get();

    if (sel.kind === 'none') {
      const empty = document.createElement('div');
      empty.className = 'inspector-empty';
      empty.textContent = t('insp.empty');
      root.appendChild(empty);
      return;
    }
    if (sel.kind === 'groups' && sel.ids.length === 1) {
      renderSingleGroup(sel.ids[0]!);
      return;
    }
    if (sel.kind === 'cells' && sel.cells.size === 1) {
      renderSingleCell([...sel.cells.values()][0]!);
      return;
    }
    renderMulti(sel);
  }

  /**
   * A row of 3 mirror buttons (X/Y/Z). Unlike rotation, this is an op that physically
   * relocates cells, so it works through the same path for both groups and cells selections —
   * the caller just passes the target selection.
   */
  function mirrorRow(sel: NormalizedSelection): HTMLElement {
    const row = document.createElement('div');
    row.className = 'inspector-icon-actions';
    const axes: readonly { axis: MirrorAxis; label: string; icon: IconName }[] = [
      { axis: 'x', label: t('insp.mirrorX'), icon: 'mirror-x' },
      { axis: 'y', label: t('insp.mirrorY'), icon: 'mirror-y' },
      { axis: 'z', label: t('insp.mirrorZ'), icon: 'mirror-z' },
    ];
    for (const { axis, label, icon } of axes) {
      row.appendChild(
        iconActionButton(
          icon,
          label,
          `Shift+${axis.toUpperCase()}`,
          () => commitOpResult(doc, selection, buildMirror(doc, sel, axis), toast, opError),
          axis.toUpperCase(),
        ),
      );
    }
    return row;
  }

  /**
   * The array-duplicate row. Specify direction (axis + sign) / count / gap as numbers
   * to lay out evenly spaced copies.
   *
   * The offset is **the selection's bbox size + the gap**. A gap of 0 means flush adjacency,
   * the same meaning as Ctrl+D's default (repeating pillars or windows usually calls for
   * spacing them by "pillar width + opening width" rather than plain adjacency, hence the gap).
   */
  function arrayDuplicateRow(sel: NormalizedSelection, bbox: { min: Cell; max: Cell }): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'inspector-array-dup';

    const dirSelect = document.createElement('select');
    const DIRECTIONS: readonly { value: string; label: string; axis: 0 | 1 | 2; sign: 1 | -1 }[] = [
      { value: '+x', label: '+X', axis: 0, sign: 1 },
      { value: '-x', label: t('insp.dirMinusX'), axis: 0, sign: -1 },
      { value: '+y', label: t('insp.dirPlusY'), axis: 1, sign: 1 },
      { value: '-y', label: t('insp.dirMinusY'), axis: 1, sign: -1 },
      { value: '+z', label: '+Z', axis: 2, sign: 1 },
      { value: '-z', label: t('insp.dirMinusZ'), axis: 2, sign: -1 },
    ];
    for (const d of DIRECTIONS) {
      const opt = document.createElement('option');
      opt.value = d.value;
      opt.textContent = d.label;
      dirSelect.appendChild(opt);
    }
    dirSelect.addEventListener('click', (e) => e.stopPropagation());
    dirSelect.addEventListener('keydown', (e) => e.stopPropagation());

    /** Numeric input (not confirmed on blur — only the value at the moment of the click is read) */
    function plainNumber(value: number, min: number): HTMLInputElement {
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '1';
      input.min = String(min);
      input.value = String(value);
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('keydown', (e) => e.stopPropagation());
      return input;
    }
    const countInput = plainNumber(3, 1);
    const gapInput = plainNumber(0, 0);

    const grid = document.createElement('div');
    grid.className = 'inspector-array-dup-grid';
    const labeled = (text: string, el: HTMLElement): HTMLElement => {
      const cell = document.createElement('label');
      cell.className = 'inspector-array-dup-cell';
      const span = document.createElement('span');
      span.textContent = text;
      cell.append(span, el);
      return cell;
    };
    grid.append(labeled(t('insp.direction'), dirSelect), labeled(t('insp.count'), countInput), labeled(t('insp.gap'), gapInput));
    wrap.appendChild(grid);

    const actions = document.createElement('div');
    actions.className = 'inspector-actions';
    actions.appendChild(
      createButton({
        label: t('insp.arrange'),
        icon: createIcon('copy'),
        variant: 'primary',
        className: 'inspector-array-run',
        onClick: () => {
        const dir = DIRECTIONS.find((d) => d.value === dirSelect.value);
        if (!dir) return;
        const count = Number(countInput.value);
        const gap = Number(gapInput.value);
        if (!Number.isInteger(count) || count < 1) {
          toast(t('insp.countMustBePositive'));
          return;
        }
        if (!Number.isInteger(gap) || gap < 0) {
          toast(t('insp.gapMustBeNonNegative'));
          return;
        }
        const size = bbox.max[dir.axis] - bbox.min[dir.axis] + 1;
        const delta: [number, number, number] = [0, 0, 0];
        delta[dir.axis] = dir.sign * (size + gap);
        commitOpResult(doc, selection, buildDuplicate(doc, sel, { delta, count }), toast, opError);
        },
      }),
    );
    wrap.appendChild(actions);
    return wrap;
  }

  function renderSingleGroup(id: string): void {
    const node = doc.tree.getNode(id);
    const bbox = selection.bbox();
    if (!node || !bbox) return; // Transient state until the next render resolves the selection validation; draw nothing

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = node.name;
    nameInput.addEventListener('click', (e) => e.stopPropagation());
    nameInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') nameInput.blur();
    });
    nameInput.addEventListener('blur', () => {
      const val = nameInput.value.trim();
      if (!val) {
        render();
        return;
      }
      const tx = buildRename(doc, id, val);
      if (tx.ops.length) doc.applyTransaction(tx);
    });
    const nameField = field(t('insp.name'), nameInput);
    nameField.classList.add('inspector-name-field');
    root.appendChild(nameField);

    /**
     * Moving a group changes **the transform's translate** (group nudge /
     * drag / inspector move were switched to the `buildTranslateGroup` path in B1b).
     * Unlike the old implementation that physically moved cells one by one, a rotated group's
     * shape doesn't get distorted. Clamping is done by buildTranslateGroup against the
     * projected world bbox.
     */
    function moveGroupBy(delta: [number, number, number]): void {
      const result = buildTranslateGroup(doc, id, delta);
      if ('error' in result) {
        toast(result.error);
        return;
      }
      if (result.tx.ops.length) doc.applyTransaction(result.tx);
      else render(); // Clamped down to 0: restore the input to its original value
      // groups selection is id-invariant, so the selection is left untouched
    }

    const posRow = document.createElement('div');
    posRow.className = 'inspector-position';
    const axisNames = ['X', 'Y', 'Z'] as const;
    ([0, 1, 2] as const).forEach((axis) => {
      const input = numberInput(bbox.min[axis], (next) => {
        const delta: [number, number, number] = [0, 0, 0];
        delta[axis] = next - bbox.min[axis];
        moveGroupBy(delta);
      });
      posRow.appendChild(prefixedControl(axisNames[axis], input, `${t('insp.positionOrigin')} ${axisNames[axis]}`));
    });

    const sizeRow = document.createElement('div');
    sizeRow.className = 'inspector-dimensions';
    sizeRow.append(
      metric('W', bbox.max[0] - bbox.min[0] + 1, t('insp.width')),
      metric('H', bbox.max[1] - bbox.min[1] + 1, t('insp.height')),
      metric('D', bbox.max[2] - bbox.min[2] + 1, t('insp.depth')),
    );
    const countEl = document.createElement('p');
    countEl.className = 'inspector-meta';
    countEl.textContent = t('insp.blockCount', { count: countCellsInSubtree(doc.scene, id).toLocaleString() });
    root.appendChild(
      section(
        t('insp.sectionPosition'),
        field(t('insp.positionOrigin'), posRow),
        field(t('insp.size'), sizeRow),
        countEl,
      ),
    );

    /**
     * 90-degree rotation around the Y axis. The pivot is the group's pivot (the
     * center of the subtree bounds initially). Unlike translation, this can't be clamped, so
     * a rotation that would go out of bounds makes buildRotateGroup90 return an error, which
     * is turned into a toast here.
     */
    function rotateGroupBy(quarterTurns: 1 | 3): void {
      const result = buildRotateGroup90(doc, id, quarterTurns);
      if ('error' in result) {
        toast(result.error);
        return;
      }
      if (result.tx.ops.length) doc.applyTransaction(result.tx);
    }

    const rotateRow = document.createElement('div');
    rotateRow.className = 'inspector-transform-row';
    const angle = document.createElement('output');
    angle.className = 'inspector-angle';
    angle.textContent = `Y ${(node.transform?.angleSteps ?? 0) * 90}°`;
    angle.setAttribute('aria-label', `${t('insp.rotateY')}: ${(node.transform?.angleSteps ?? 0) * 90}°`);
    rotateRow.appendChild(angle);
    const rotateButtons = document.createElement('div');
    rotateButtons.className = 'inspector-icon-actions';
    // The labels describe the rotation as seen in a top-down view (right = +X / up = -Z)
    rotateButtons.append(
      iconActionButton('rotate-ccw', t('insp.rotateLeft'), '[', () => rotateGroupBy(1)),
      iconActionButton('rotate-cw', t('insp.rotateRight'), ']', () => rotateGroupBy(3)),
    );
    rotateRow.appendChild(rotateButtons);
    const normalizedGroup = normalizeSelection(doc.tree, { kind: 'groups', ids: [id] });
    root.appendChild(
      section(
        t('insp.sectionTransform'),
        field(t('insp.rotateY'), rotateRow),
        field(t('insp.mirror'), mirrorRow(normalizedGroup)),
      ),
    );

    root.appendChild(section(t('insp.sectionArray'), arrayDuplicateRow(normalizedGroup, bbox)));

    const actions = document.createElement('div');
    actions.className = 'inspector-actions inspector-object-actions';
    actions.appendChild(
      createButton({
        label: t('insp.duplicate'),
        icon: createIcon('copy'),
        onClick: () => {
          const result = buildDuplicate(doc, normalizedGroup);
          if ('error' in result) {
            toast(result.error);
            return;
          }
          doc.applyTransaction(result.tx);
          if (result.newSelection) selection.set(result.newSelection);
        },
      }),
    );
    // Make into / detach from component. **Detach is not undoable**, so it's placed
    // here rather than in the right-click flow (to avoid it being triggered accidentally
    // somewhere you didn't mean to click)
    const componentButtons = document.createElement('div');
    componentButtons.className = 'inspector-actions inspector-object-actions';
    if (componentActions) {
      if (componentActions.isInstance(id)) {
        // Only the entry point differs; there's only one mode once inside
        componentButtons.appendChild(
          createButton({
            label: t('insp.editComponent'),
            icon: createIcon('component'),
            className: 'inspector-component-action',
            onClick: () => componentActions.editComponentOf(id),
          }),
        );
        componentButtons.appendChild(
          createButton({
            label: t('insp.detachComponent'),
            icon: createIcon('detach'),
            className: 'inspector-component-action',
            onClick: () => componentActions.detach(id),
          }),
        );
      } else {
        componentButtons.appendChild(
          createButton({
            label: t('insp.makeComponent'),
            icon: createIcon('component'),
            className: 'inspector-component-action',
            onClick: () => componentActions.createFromSelection(normalizedGroup),
          }),
        );
      }
      root.appendChild(section(t('insp.sectionComponent'), componentButtons));
    }
    actions.appendChild(
      createButton({
        label: t('insp.ungroup'),
        icon: createIcon('ungroup'),
        onClick: () => {
          const result = buildUngroup(doc, [id]);
          if ('error' in result) {
            toast(result.error);
            return;
          }
          if (result.tx.ops.length) doc.applyTransaction(result.tx);
          if (result.newSelection) selection.set(result.newSelection);
        },
      }),
    );
    actions.appendChild(
      createButton({
        label: t('insp.delete'),
        icon: createIcon('trash'),
        variant: 'danger',
        className: 'inspector-delete-action',
        onClick: () => {
          const result = buildDeleteSelection(doc, normalizedGroup);
          if ('tx' in result && result.tx.ops.length) doc.applyTransaction(result.tx);
          selection.clear();
        },
      }),
    );
    root.appendChild(section(t('insp.sectionActions'), actions));
  }

  function renderSingleCell(cell: SelectedCell): void {
    const ref = cell.ref;
    const localRaw = doc.scene.cells.get(ref.ownerId, localKeyOf(ref));
    if (localRaw === undefined) return; // Transient state (resolved by the next render's selection validation)
    const [x, y, z] = cell.worldCell;
    // The UI deals with the projected appearance, so the orientation is converted to **world orientation** for display and editing
    const raw = doc.worldRawOf(ref.ownerId, localRaw);
    const { catalogIndex, code } = unpackCell(raw);
    const catalog = getCatalog();
    const def = catalog[catalogIndex];
    if (!def) return;

    const infoRow = document.createElement('div');
    infoRow.className = 'inspector-block-info';
    const swatch = document.createElement('span');
    swatch.className = 'inspector-swatch';
    swatch.style.background = def.color;
    const nameEl = document.createElement('span');
    nameEl.textContent = blockName(def);
    infoRow.append(swatch, nameEl);
    root.appendChild(field(t('insp.block'), infoRow));

    const activeDef = catalog[state.activeBlock];
    if (activeDef) {
      root.appendChild(
        actionButton(t('insp.replaceWithActive', { name: blockName(activeDef) }), () => {
          // Even if the shapes match, the orientation code isn't carried over between two
          // 'full' blocks when only one supports pillar_axis (fixes a bug where, e.g.,
          // replacing a sideways log with stone left the old code behind and caused
          // VoxelMesh to rotate it incorrectly review finding)
          const canCarryOrientation =
            activeDef.shape === def.shape && (activeDef.shape !== 'full' || (isPillarBlock(def) && isPillarBlock(activeDef)));
          const newCode = canCarryOrientation ? code : defaultCode(activeDef.shape);
          const tx = buildSetCell(doc, ref, packCell(state.activeBlock, newCode));
          if (tx.ops.length) doc.applyTransaction(tx);
        }),
      );
    }

    if (def.shape === 'slab' || def.shape === 'stairs') {
      const orientRow = document.createElement('div');
      orientRow.className = 'inspector-actions';
      orientRow.appendChild(
        actionButton(t('insp.rotateFacing'), () => {
          const tx = buildSetCell(doc, ref, packCell(catalogIndex, cycleFacing(def.shape, code)));
          if (tx.ops.length) doc.applyTransaction(tx);
        }),
      );
      orientRow.appendChild(
        actionButton(t('insp.flipVertical'), () => {
          const tx = buildSetCell(doc, ref, packCell(catalogIndex, toggleFlip(def.shape, code)));
          if (tx.ops.length) doc.applyTransaction(tx);
        }),
      );
      root.appendChild(orientRow);
    } else if (def.shape === 'full' && isPillarBlock(def)) {
      const axis = (decodeOrientation('full', code) as Extract<Orientation, { shape: 'full' }>).axis;
      const axisLabel = document.createElement('span');
      axisLabel.textContent = t('insp.axisLabel', { axis: axis.toUpperCase() });
      root.appendChild(field(t('insp.facing'), axisLabel));
      root.appendChild(
        actionButton(t('insp.cycleAxis'), () => {
          const tx = buildSetCell(doc, ref, packCell(catalogIndex, cyclePillarAxis(code)));
          if (tx.ops.length) doc.applyTransaction(tx);
        }),
      );
    }

    const posRow = document.createElement('div');
    posRow.className = 'inspector-position';
    const coords: [number, number, number] = [x, y, z];
    const axisNames = ['X', 'Y', 'Z'] as const;
    ([0, 1, 2] as const).forEach((axis) => {
      const input = numberInput(coords[axis], (next) => {
        const delta: [number, number, number] = [0, 0, 0];
        delta[axis] = next - coords[axis];
        const clamped = clampDeltaToBounds({ min: coords, max: coords }, delta);
        if (clamped[0] === 0 && clamped[1] === 0 && clamped[2] === 0) {
          render();
          return;
        }
        const result = buildMove(doc, [ref], clamped);
        if ('error' in result) {
          toast(result.error);
          return;
        }
        if (result.tx.ops.length) {
          doc.applyTransaction(result.tx);
          if (result.newSelection) selection.set(result.newSelection); // For a cells selection, following the coordinates is correct
        }
      });
      posRow.appendChild(prefixedControl(axisNames[axis], input, `${t('insp.position')} ${axisNames[axis]}`));
    });
    root.appendChild(section(t('insp.sectionPosition'), field(t('insp.position'), posRow)));

    // Show mirror and array-duplicate for a single cell too.
    // "Select one block and grow it into evenly spaced pillars or windows" is the most basic
    // use of array duplication, and without it here, the most ordinary operation would be
    // unreachable. buildMirror / buildDuplicate already handle a single cell fine on their
    // own, so all that was missing was the UI branch
    const cellSel = normalizeSelection(doc.tree, cellSelectionOf([cell]));
    const cellBbox = selection.bbox();
    if (cellSel.kind !== 'none') {
      root.appendChild(section(t('insp.sectionTransform'), field(t('insp.mirror'), mirrorRow(cellSel))));
      if (cellBbox) root.appendChild(section(t('insp.sectionArray'), arrayDuplicateRow(cellSel, cellBbox)));
    }
  }

  /**
   * Repaints the selection.
   *
   * The existing bulk-replace could only scope to "group × block kind," which meant
   * **changing the texture of just part of a wall** wasn't possible. This is the entry point
   * for selection-scoped painting.
   *
   * The filter is "everything selected" or "just one specific kind." To avoid making the user
   * guess which kind an action applies to in a mixed selection, **the kinds actually present
   * in the selection are listed with their counts**.
   */
  function repaintSection(sel: NormalizedSelection): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'inspector-repaint';

    const catalog = getCatalog();
    const refs = resolveSelectionRefs(doc, sel);
    // The kinds actually present in the selection, with their counts (most frequent first)
    const counts = new Map<number, number>();
    for (const ref of refs) {
      // For live-pattern cells, the raw stored on cells is just a save-time fallback, so
      // count using **the raw actually used for display**. This keeps "the kind you see" and
      // the count from drifting apart after a ratio edit
      const raw = doc.currentLocalRaw(ref);
      if (raw === undefined) continue;
      const { catalogIndex } = unpackCell(raw);
      counts.set(catalogIndex, (counts.get(catalogIndex) ?? 0) + 1);
    }
    const kinds = [...counts.entries()].sort((a, b) => b[1] - a[1]);

    const scope = document.createElement('select');
    scope.className = 'inspector-repaint-scope';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = t('insp.repaintAll');
    scope.append(all);
    for (const [index, count] of kinds) {
      const def = catalog[index];
      if (!def) continue;
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = t('insp.repaintOnly', { name: blockName(def), count });
      scope.append(option);
    }
    // If there's only one kind, the filter is meaningless
    if (kinds.length > 1) wrap.append(field(t('insp.repaintScope'), scope));

    const from = (): number | null => (scope.value === '' ? null : Number(scope.value));
    const run = (replacement: Parameters<typeof buildReplaceSelection>[2]['replacement']): void => {
      commitOpResult(
        doc,
        selection,
        buildReplaceSelection(doc, resolveSelectionRefs(doc, selection.get()), {
          from: from(),
          replacement,
          indexOf: indexOfBlock,
          shapeOf: (i) => catalog[i]?.shape,
        }),
        toast,
        opError,
      );
    };

    // Keeps display and the applied target on the same snapshot: display uses the value at
    // render time, while application **re-reads it at click time**. Changes to AppState /
    // RecipeStore also trigger a re-render, but even if a subscription is missed, this
    // guarantees at least that "something different from what's shown gets applied" never
    // happens
    const activeDef = catalog[state.activeBlock];
    if (activeDef) {
      const button = actionButton(t('insp.repaintWithBlock', { name: blockName(activeDef) }), () =>
        run({ kind: 'block', catalogIndex: state.activeBlock }),
      );
      button.dataset.block = String(state.activeBlock);
      wrap.append(button);
    }
    const recipe = getActivePattern();
    if (recipe) {
      const button = actionButton(t('insp.repaintWithPattern', { name: recipe.name }), () => {
        const latest = getActivePattern();
        if (!latest) return; // Does nothing if it's switched to solid color (avoids baking in a stale recipe)
        run({ kind: 'pattern', recipe: latest });
      });
      button.dataset.recipe = recipe.id;
      wrap.append(button);
    }
    return wrap;
  }

  function renderMulti(sel: NormalizedSelection): void {
    const bbox = selection.bbox();
    const info: HTMLElement[] = [];
    if (bbox) {
      const sizeRow = document.createElement('div');
      sizeRow.className = 'inspector-dimensions';
      sizeRow.append(
        metric('W', bbox.max[0] - bbox.min[0] + 1, t('insp.width')),
        metric('H', bbox.max[1] - bbox.min[1] + 1, t('insp.height')),
        metric('D', bbox.max[2] - bbox.min[2] + 1, t('insp.depth')),
      );
      info.push(field(t('insp.sizeCombined'), sizeRow));
    }
    const countEl = document.createElement('p');
    countEl.className = 'inspector-meta';
    countEl.textContent = t('insp.blockCount', { count: selection.resolveCells().size.toLocaleString() });
    info.push(countEl);
    root.appendChild(section(t('insp.sectionPosition'), ...info));
    root.appendChild(section(t('insp.sectionTransform'), field(t('insp.mirror'), mirrorRow(sel))));
    if (bbox) root.appendChild(section(t('insp.sectionArray'), arrayDuplicateRow(sel, bbox)));
    root.appendChild(section(t('insp.repaint'), repaintSection(sel)));
    root.appendChild(
      section(
        t('insp.sectionActions'),
        createButton({
          label: t('insp.group'),
          icon: createIcon('group'),
          onClick: () => {
        const result = buildGroup(doc, sel, defaultName('group'));
        if ('error' in result) {
          toast(result.error);
          return;
        }
        doc.applyTransaction(result.tx);
        if (result.newSelection) selection.set(result.newSelection);
          },
        }),
      ),
    );
  }

  doc.subscribe(render);

  // Also subscribe to AppState and RecipeStore so the repaint section keeps up when the
  // palette's block / rolling recipe is switched while the selection stays put
  onStateChange(render);
  subscribeRecipes(render);

  onLangChange(render); // Block name language switch
  selection.subscribe(render);
  render();
}
