import type { Document } from '../core/document';
import type { BlockDef, Tool } from '../core/types';
import type { ViewPreset } from '../input/views';
import type { BlockChangePicker } from './blockchangepicker';
import { createBlockSwatchPair } from './blockswatch';
import {
  isShapeHollow,
  onStateChange,
  setDisplayMode,
  setShowVoidEdges,
  setPaintVoid,
  setShape,
  setShapeAxis,
  setShapeStep,
  setTool,
  state,
  t,
  toggleShapeHollow,
} from '../state';
import type { Axis } from '../core/axis';
import type { ShapeKind } from '../core/shapes';

/** Cylinder axis label. 0=X / 1=Y / 2=Z */
const AXIS_LABEL_KEY = ['shape.axisX', 'shape.axisY', 'shape.axisZ'] as const satisfies readonly UiKey[];
import type { Lang, UiKey } from '../core/i18n';
import { createIcon, type IconName } from './icons';
import { createButton, createDivider, createInput, setButtonPressed } from './primitives';

const TOOLS: { tool: Tool; icon: IconName; labelKey: UiKey; key: string }[] = [
  { tool: 'select', icon: 'cursor', labelKey: 'tool.select', key: 'V' },
  { tool: 'place', icon: 'square-plus', labelKey: 'tool.place', key: '1' },
  { tool: 'erase', icon: 'eraser', labelKey: 'tool.erase', key: '2' },
  { tool: 'fill', icon: 'box', labelKey: 'tool.fill', key: '3' },
  { tool: 'pick', icon: 'eyedropper', labelKey: 'tool.pick', key: '4' },
];

/**
 * Shapes for the range fill (#64). **box is listed as just another item, on equal footing.**
 * Treating it as "the basic box, plus bonus shapes" would add a box-only branch every time a
 * new shape is added.
 *
 * As in Figma, a key is bound directly to each shape (pressing it decides both the tool and
 * the shape selection at once). The toolbar button stays a single button, with its icon
 * reflecting whichever shape was picked last.
 */
export const SHAPES: { shape: ShapeKind; icon: IconName; labelKey: UiKey; key: string }[] = [
  { shape: 'box', icon: 'box', labelKey: 'shape.box', key: '3' },
  { shape: 'sphere', icon: 'shape-sphere', labelKey: 'shape.sphere', key: 'O' },
  { shape: 'cylinder', icon: 'shape-cylinder', labelKey: 'shape.cylinder', key: 'Y' },
  { shape: 'dome', icon: 'shape-dome', labelKey: 'shape.dome', key: 'M' },
  { shape: 'slope', icon: 'shape-slope', labelKey: 'shape.slope', key: 'K' },
];

const VIEWS: { preset: ViewPreset; icon: IconName; labelKey: UiKey; key: string }[] = [
  { preset: 'top', icon: 'view-top', labelKey: 'view.top', key: 'Shift+7' },
  { preset: 'front', icon: 'view-front', labelKey: 'view.front', key: 'Shift+1' },
  { preset: 'side', icon: 'view-side', labelKey: 'view.side', key: 'Shift+3' },
];

/**
 * Autosave state. Formatting the `saved` timestamp is the UI's concern, so ProjectService
 * only notifies "entered pending / finished saving," and the time is captured and formatted
 * here.
 */
export type SaveState = { kind: 'pending' } | { kind: 'saved'; at: Date };

export interface ToolbarHandle {
  /** Updates the document bar's save state in response to ProjectService's autosave notifications */
  setSaveState: (kind: SaveState['kind']) => void;
}

export interface ToolbarActions {
  getName: () => string;
  setName: (name: string) => void;
  exportMcpack: () => void;
  saveProject: () => void;
  loadProjectFile: (file: File) => void;
  clearAll: () => void;
  setView: (preset: ViewPreset) => void;
  toggleGround: () => void;
  getGroundLabel: () => string;
}

function group(className?: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className ? `toolbar-group ${className}` : 'toolbar-group';
  return el;
}

function saveStateText(state: SaveState | null, lang: Lang): string {
  if (state === null) return '';
  if (state.kind === 'pending') return t('doc.unsaved');
  const time = state.at.toLocaleTimeString(lang === 'ja' ? 'ja-JP' : 'en-US', { hour: '2-digit', minute: '2-digit' });
  return t('doc.autosavedAt', { time });
}

export function initToolbar(
  root: HTMLElement,
  documentBarRoot: HTMLElement,
  worldControlsRoot: HTMLElement,
  /** The logo at the top of the rail. Anchor for the file-operations menu (#61) */
  fileMenuAnchor: HTMLButtonElement,
  doc: Document,
  actions: ToolbarActions,
  /** Catalog (used for the stacked swatch's appearance, #87) */
  catalog: BlockDef[],
  /** Block-change picker. The composition root hands out exactly one instance for the whole screen (#87) */
  picker: BlockChangePicker,
): ToolbarHandle {
  // render() gets rebuilt by onStateChange, so the save state is kept outside the DOM and redrawn
  let saveState: SaveState | null = null;
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.hidden = true;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) actions.loadProjectFile(file);
    fileInput.value = '';
  });

  /**
   * The body of the shape dropdown (#64).
   *
   * **Built once, outside `render()`.** The toolbar gets rebuilt with `root.innerHTML = ''`
   * on every onStateChange, so placing the menu inside it would mean "the whole menu vanishes
   * the moment hollow is toggled" — a UI that forces you to reopen it. The popover lives
   * directly under body instead, keeping the DOM intact and only its state gets redrawn.
   */
  const shapeMenu = document.createElement('div');
  shapeMenu.className = 'shape-menu';
  shapeMenu.popover = 'auto';
  shapeMenu.id = 'shape-menu';
  // role="menu" / menuitem* comes with a keyboard contract for Arrow / Home / End / Escape.
  // That isn't implemented here, so this is downgraded to **a plain button group
  // (group + aria-pressed)** (#64 review). Keep state's single source of truth as
  // aria-pressed alone (setButtonPressed), avoiding a double specification
  shapeMenu.setAttribute('role', 'group');

  const shapeItems = new Map<ShapeKind, HTMLButtonElement>();
  for (const item of SHAPES) {
    const button = createButton({
      label: '',
      className: 'shape-menu-item',
      onClick: () => {
        setShape(item.shape);
        setTool('fill');
      },
    });
    button.dataset.shape = item.shape;
    shapeItems.set(item.shape, button);
    shapeMenu.append(button);
  }

  // Void (#113) and hollow are both "settings that apply to any shape," so they're listed
  // below the shape list. Void is a material-to-paint-with toggle, so it goes above hollow
  // (order: what to lay down → how to fill it)
  const voidItem = createButton({
    label: '',
    className: 'shape-menu-item shape-menu-toggle',
    onClick: () => setPaintVoid(!state.paintVoid),
  });
  shapeMenu.append(voidItem);

  // Hollow applies to any shape, so it's placed just once, below the shape list
  const hollowItem = createButton({
    label: '',
    className: 'shape-menu-item shape-menu-hollow',
    onClick: () => toggleShapeHollow(),
  });
  shapeMenu.append(hollowItem);

  /**
   * Per-shape parameters (#64). **Only show what applies to the current shape** — always
   * showing everything would leave a "step height showing while cylinder is selected" state,
   * making it unreadable which ones actually apply.
   */
  const paramRow = document.createElement('div');
  paramRow.className = 'shape-params';

  const axisLabel = document.createElement('span');
  axisLabel.className = 'shape-param-label';
  const axisButtons = ([0, 1, 2] as Axis[]).map((axis) => {
    const button = createButton({
      label: '',
      className: 'shape-axis-button',
      onClick: () => setShapeAxis(axis),
    });
    button.dataset.axis = String(axis);
    return button;
  });
  const axisGroup = document.createElement('div');
  axisGroup.className = 'shape-param shape-param-axis';
  axisGroup.append(axisLabel, ...axisButtons);

  const stepLabel = document.createElement('label');
  stepLabel.className = 'shape-param shape-param-step';
  const stepText = document.createElement('span');
  stepText.className = 'shape-param-label';
  const stepInput = createInput({ type: 'number', className: 'shape-step-input' });
  stepInput.min = '1';
  stepInput.step = '1';
  stepInput.addEventListener('change', () => setShapeStep(Number(stepInput.value)));
  stepLabel.append(stepText, stepInput);

  paramRow.append(axisGroup, stepLabel);
  shapeMenu.append(paramRow);
  document.body.append(shapeMenu);

  /** Redraws just the labels and selection state, so it keeps up even while left open */
  function syncShapeMenu(): void {
    shapeMenu.setAttribute('aria-label', t('shape.menu'));
    for (const item of SHAPES) {
      const button = shapeItems.get(item.shape);
      if (!button) continue;
      button.replaceChildren(createIcon(item.icon), document.createTextNode(t(item.labelKey)));
      const key = document.createElement('span');
      key.className = 'shape-menu-key';
      key.textContent = item.key;
      button.append(key);
      button.title = t(item.labelKey);
      setButtonPressed(button, item.shape === state.shape);
    }
    voidItem.replaceChildren(document.createTextNode(t('shape.void')));
    voidItem.title = t('shape.voidTitle');
    setButtonPressed(voidItem, state.paintVoid);

    hollowItem.replaceChildren(document.createTextNode(t('shape.hollow')));
    hollowItem.title = t('shape.hollowTitle');
    setButtonPressed(hollowItem, isShapeHollow());

    // Only show the parameters that apply to this shape
    axisGroup.hidden = state.shape !== 'cylinder';
    stepLabel.hidden = state.shape !== 'slope';
    paramRow.hidden = axisGroup.hidden && stepLabel.hidden;

    axisLabel.textContent = t('shape.axis');
    axisGroup.title = t('shape.axisTitle');
    for (const button of axisButtons) {
      const axis = Number(button.dataset.axis) as Axis;
      button.textContent = t(AXIS_LABEL_KEY[axis]);
      button.setAttribute('aria-label', t(AXIS_LABEL_KEY[axis]));
      setButtonPressed(button, state.shapeAxis === axis);
    }

    stepText.textContent = t('shape.step');
    stepLabel.title = t('shape.stepTitle');
    stepInput.setAttribute('aria-label', t('shape.step'));
    stepInput.value = String(state.shapeStep);
  }

  /**
   * The range-fill tool button + caret (same shape as Figma's shape tool).
   *
   * - The button itself reflects **the icon of the last-selected shape**. This avoids opening
   *   the menu when placing the same shape repeatedly
   * - Open/close is left to popover=auto (a custom toggle would conflict with light-dismiss,
   *   same as the file menu)
   */
  function renderShapeControl(): HTMLElement {
    const current = SHAPES.find((s) => s.shape === state.shape) ?? SHAPES[0]!;
    const wrap = document.createElement('div');
    wrap.className = 'shape-control';

    const main = createButton({
      label: '',
      ariaLabel: t('tool.withKey', { label: t(current.labelKey), key: current.key }),
      title: t('shape.current', { name: t(current.labelKey), key: current.key }),
      icon: createIcon(current.icon),
      className: 'tool-button shape-main',
      pressed: state.tool === 'fill',
      onClick: () => setTool('fill'),
    });

    const caret = createButton({
      label: '',
      ariaLabel: t('shape.menu'),
      title: t('shape.menuTitle'),
      icon: createIcon('chevron-down'),
      className: 'shape-caret',
    });
    // Adding popovertarget lets the browser manage aria-expanded.
    // Since this is a button group (role="group") rather than a menu, aria-haspopup="menu" is not added
    caret.setAttribute('popovertarget', shapeMenu.id);
    // Positioning happens after opening, using actual measured size. Shown directly above the caret (the toolbar sits at the bottom of the screen)
    caret.addEventListener('click', () => {
      const rect = caret.getBoundingClientRect();
      shapeMenu.style.left = `${Math.round(rect.left)}px`;
      shapeMenu.style.bottom = `${Math.round(window.innerHeight - rect.top + 6)}px`;
    });

    wrap.append(main, caret);
    return wrap;
  }

  function render(): void {
    root.innerHTML = '';
    documentBarRoot.innerHTML = '';
    worldControlsRoot.innerHTML = '';

    const projectName = createInput({
      value: actions.getName(),
      placeholder: t('doc.projectName'),
      ariaLabel: t('doc.projectName'),
      className: 'project-name',
    });
    projectName.id = 'project-name'; // Existing composition-root contract that ProjectService's onNameChange updates
    projectName.addEventListener('change', () => actions.setName(projectName.value));

    // The save state is tied to the project, so it sits directly under the project name rather than next to the app name
    const saveStateEl = document.createElement('p');
    saveStateEl.className = 'document-save-state';
    saveStateEl.dataset.state = saveState?.kind ?? 'none';
    saveStateEl.textContent = saveStateText(saveState, state.lang);
    saveStateEl.setAttribute('role', 'status');

    // The only thing always shown is **"export," the final exit point**. Save / load / clear
    // fold into a menu next to the project name (#61). Lining up all 4 would use 74px just
    // for the button row within the 248px width, crowding the header into the canvas. Tucking
    // away the 3 low-frequency ones that can be grouped as "operations on the project file"
    // gives the same shape as Figma's file menu.
    const exportButton = createButton({
      label: t('doc.export'),
      title: t('doc.exportTitle'),
      variant: 'primary',
      className: 'document-export',
      onClick: actions.exportMcpack,
    });

    const fileMenu = document.createElement('div');
    fileMenu.className = 'document-file-menu';
    fileMenu.popover = 'auto';
    fileMenu.id = 'document-file-menu';
    const menuItem = (label: string, title: string, onClick: () => void, variant?: 'danger'): HTMLButtonElement =>
      createButton({
        label,
        title,
        className: 'document-file-menu-item',
        ...(variant ? { variant } : {}),
        onClick: () => {
          fileMenu.hidePopover();
          onClick();
        },
      });
    fileMenu.append(
      menuItem(t('doc.save'), t('doc.saveTitle'), actions.saveProject),
      menuItem(t('doc.load'), t('doc.loadTitle'), () => fileInput.click()),
      menuItem(t('doc.clear'), t('doc.clearTitle'), actions.clearAll, 'danger'),
    );

    // **Open/close is left to the browser** (popovertarget). Toggling it manually in onClick
    // would let popover=auto's light-dismiss close it first, then onClick would see it as
    // "closed" and reopen it — the click would stop working. Registering it as an invoker
    // lets the browser resolve the ordering
    fileMenuAnchor.setAttribute('popovertarget', fileMenu.id);
    fileMenuAnchor.setAttribute('aria-haspopup', 'menu');

    // Positioning happens after opening, using actual measured size. Shown to the right of the anchor (the rail's logo).
    // The rail is narrow, so "directly below" would overlap the panel — offsetting sideways reads more naturally
    fileMenu.addEventListener('toggle', (event) => {
      if (event.newState !== 'open') return;
      const anchor = fileMenuAnchor.getBoundingClientRect();
      const menu = fileMenu.getBoundingClientRect();
      const left = Math.max(8, Math.min(anchor.right + 6, window.innerWidth - menu.width - 8));
      const top = Math.max(8, Math.min(anchor.top, window.innerHeight - menu.height - 8));
      fileMenu.style.left = `${Math.round(left)}px`;
      fileMenu.style.top = `${Math.round(top)}px`;
    });

    const nameRow = document.createElement('div');
    nameRow.className = 'document-name-row';
    nameRow.append(projectName);

    // Places the save state and "export" on the same row. A full-width filled button would
    // be a 223x30 ≈ 6,700px² solid block, making it the strongest element in the white panel.
    // Figma's Share button uses the same saturated blue but is only 60px wide —
    // **strength comes from area, not color** (#61)
    const statusRow = document.createElement('div');
    statusRow.className = 'document-status-row';
    statusRow.append(saveStateEl, exportButton);

    documentBarRoot.append(nameRow, statusRow, fileMenu, fileInput);

    // The stacked swatch sits at the left edge of the tool row (#87). "What to paint with" is
    // decided before tool selection, so it's placed ahead of the tool row
    const swatchGroup = group('block-swatch-group');
    swatchGroup.append(createBlockSwatchPair(catalog, picker));
    root.append(swatchGroup, createDivider());

    const toolGroup = group('edit-tools');
    for (const tool of TOOLS) {
      // Only the range fill is "button + caret." Rather than lining up 5 separate tools, it
      // stays the same "specify a range and fill it" operation, switching just **how it's
      // filled** (#64)
      if (tool.tool === 'fill') {
        toolGroup.append(renderShapeControl());
        continue;
      }
      toolGroup.append(
        createButton({
          label: '',
          ariaLabel: t('tool.withKey', { label: t(tool.labelKey), key: tool.key }),
          title: t('tool.withKey', { label: t(tool.labelKey), key: tool.key }),
          icon: createIcon(tool.icon),
          className: 'tool-button',
          pressed: state.tool === tool.tool,
          onClick: () => setTool(tool.tool),
        }),
      );
    }
    root.append(toolGroup, createDivider());

    const historyGroup = group('history-tools');
    historyGroup.append(
      createButton({
        label: '',
        ariaLabel: t('history.undo'),
        title: t('history.undoTitle'),
        icon: createIcon('undo'),
        variant: 'icon',
        onClick: () => doc.undo(),
      }),
      createButton({
        label: '',
        ariaLabel: t('history.redo'),
        title: t('history.redoTitle'),
        icon: createIcon('redo'),
        variant: 'icon',
        onClick: () => doc.redo(),
      }),
    );
    root.append(historyGroup);

    const worldTitle = document.createElement('h2');
    worldTitle.textContent = 'View';
    const viewRow = document.createElement('div');
    viewRow.className = 'world-control-row';
    const viewLabel = document.createElement('span');
    viewLabel.className = 'world-control-label';
    viewLabel.textContent = t('view.orientation');
    const viewGroup = group('view-tools');
    for (const view of VIEWS) {
      viewGroup.append(
        createButton({
          label: '',
          ariaLabel: t('view.ariaLabel', { label: t(view.labelKey) }),
          title: t('view.title', { label: t(view.labelKey), key: view.key }),
          icon: createIcon(view.icon),
          variant: 'icon',
          className: 'world-control-button',
          onClick: () => actions.setView(view.preset),
        }),
      );
    }
    viewRow.append(viewLabel, viewGroup);

    const displayRow = document.createElement('div');
    displayRow.className = 'world-control-row';
    const displayLabel = document.createElement('span');
    displayLabel.className = 'world-control-label';
    displayLabel.textContent = t('view.appearance');
    const displayGroup = group('display-tools');
    displayGroup.append(
      createButton({
        label: actions.getGroundLabel(),
        ariaLabel: t('toolbar.groundTitle', { label: actions.getGroundLabel() }),
        title: t('toolbar.groundTitle', { label: actions.getGroundLabel() }),
        icon: createIcon('grid'),
        className: 'world-control-button',
        onClick: () => {
          actions.toggleGround();
          render();
        },
      }),
      createButton({
        label: state.displayMode === 'texture' ? t('toolbar.textured') : t('toolbar.flat'),
        ariaLabel: state.displayMode === 'texture' ? t('toolbar.displayTextured') : t('toolbar.displayFlat'),
        title: state.displayMode === 'texture' ? t('toolbar.displayTextured') : t('toolbar.displayFlat'),
        icon: createIcon('texture'),
        className: 'world-control-button',
        onClick: () => setDisplayMode(state.displayMode === 'texture' ? 'flat' : 'texture'),
      }),
      // Void outlines (#146). Heavy use of void fills the screen with lines, so this can be toggled on/off
      createButton({
        label: t('toolbar.voidEdges'),
        ariaLabel: t('toolbar.voidEdgesTitle'),
        title: t('toolbar.voidEdgesTitle'),
        icon: createIcon('void'),
        className: 'world-control-button',
        pressed: state.showVoidEdges,
        onClick: () => setShowVoidEdges(!state.showVoidEdges),
      }),
    );
    displayRow.append(displayLabel, displayGroup);
    worldControlsRoot.append(worldTitle, viewRow, displayRow);
  }

  // onStateChange fires for **every** state change, including lang, so adding onLangChange
  // on top of it would render twice on a language switch (#70 review)
  onStateChange(() => {
    render();
    // The menu lives outside render(), so its selection state is redrawn separately
    // (toggling hollow while it's open doesn't close it)
    syncShapeMenu();
  });
  render();
  syncShapeMenu();

  return {
    setSaveState: (kind) => {
      saveState = kind === 'saved' ? { kind, at: new Date() } : { kind };
      const el = documentBarRoot.querySelector<HTMLElement>('.document-save-state');
      if (!el) return;
      el.dataset.state = kind;
      el.textContent = saveStateText(saveState, state.lang);
    },
  };
}
