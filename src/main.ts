import * as THREE from 'three';
import { Document } from './core/document';
import { averageColor, buildIndexOf, RecipeStore, sampleRecipe } from './core/mixpalette';
import { VOID_CATALOG_INDEX, unpackCell } from './core/orientation';
import { formatRangeSize, type RangeSize } from './core/rangesize';
import { OwnerVoxelStore, type EditorScene } from './core/ownervoxels';
import { activePatternAt, PatternPaintStore, resolvePatternRaw } from './core/patternpaint';
import { SceneTree } from './core/scenetree';
import type { MirrorAxis } from './core/transform';
import { CATALOG } from './data/blocks';
import { SelectionStore } from './editor/selection';
import { initCameraKeys, type ArrowModifiers } from './input/camerakeys';
import { initEditorControls } from './input/controls';
import { isCtrlOrMeta, type ShortcutContext, type ShortcutEntry } from './input/priority';
import { createInputRouter } from './input/router';
import { initSelectTool, NUDGE_KEYS } from './input/selecttool';
import { applyViewPreset, type ViewPreset } from './input/views';
import { SelectionOverlay } from './render/selectionoverlay';
import { createScene } from './render/scene';
import { VoidEdges } from './render/voidedges';
import { VoxelEdges } from './render/voxeledges';
import { VoxelMesh } from './render/voxelmesh';
import { createPickingService } from './services/picking';
import { createBrowserProjectIO } from './services/project-io-browser';
import { createProjectService } from './services/project';
import { createBackupReminder } from './services/backup-reminder';
import { serializeComponentTemplate, validateComponents } from './project/persistence';
import { createBrowserFrameClock } from './services/renderscheduler-clock-browser';
import { createRenderScheduler } from './services/renderscheduler';
import { createTexturePackService, TexturePackError } from './services/texturepack';
import { initHelp } from './ui/help';
import { initBlockUsage } from './ui/blockusage';
import { createBlockChangePicker } from './ui/blockchangepicker';
import { initInspector } from './ui/inspector';
import { initLayers } from './ui/layers';
import { initPalette } from './ui/palette';
import { initRecipes } from './ui/recipes';
import { initComponents } from './ui/components';
import { ComponentStore, type ComponentTemplate } from './core/component';
import {
  buildCreateComponent,
  buildDetachInstance,
  buildDetachInstancesOf,
  beginComponentEdit,
  endComponentEdit,
  type ComponentEditSession,
  buildPlaceComponent,
  componentPlacementOffsets,
  isCreateComponentError,
} from './editor/componentops';
import { commitOpResult } from './editor/ops';
import { initAxisGizmo } from './ui/axisgizmo';
import { initSidebarTabs } from './ui/sidebar';
import { initStaticLabels } from './ui/staticlabels';
import { initToolbar, SHAPES, type ToolbarHandle } from './ui/toolbar';
import { configureTextureUrlResolver, refreshTextureElements } from './ui/textureframe';
import { toast } from './ui/toast';
import { blockName, cyclePendingFacing, defaultName, errorText, onStateChange, opError, setActiveBlock, setPendingComponent, setActiveRecipe, setLang, setShowVoidEdges, setThemePreference, resolvedTheme, notifySystemThemeChanged, setDisplayMode, setShape, setTool, state, swapActiveAndSpare, t, togglePendingFlip, type Lang, type ThemePreference, type DisplayMode } from './state';

// Bring the static text written into index.html (region aria-labels / <html lang>) under
// language switching. Render this once before any other UI mounts (raised in review)
initStaticLabels();

/** Direct shape hotkeys (box is excluded since the existing '3' key already covers it). toolbar's SHAPES is the single source of truth */
const SHAPE_KEYS = new Map(SHAPES.filter((s) => s.shape !== 'box').map((s) => [s.key.toLowerCase(), s.shape]));

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const sidebarRoot = document.getElementById('sidebar-left')!;
const railRoot = document.getElementById('sidebar-rail')!;
const { documentRoot, fileMenuAnchor, layersRoot, paletteRoot, recipesRoot, componentsRoot } = initSidebarTabs(sidebarRoot, railRoot);
const toolbarRoot = document.getElementById('toolbar')!;
const worldControlsRoot = document.getElementById('world-controls')!;
const statusbar = document.getElementById('statusbar')!;
const inspectorRoot = document.getElementById('inspector')!;
const blockUsageRoot = document.getElementById('block-usage')!;

const texturePackService = createTexturePackService();
configureTextureUrlResolver(texturePackService.resolveUrl);
const ctx = createScene(canvas, texturePackService.resolveUrl);

/**
 * Source of truth for the edit model. Document owns the EditorScene (owner-local
 * tree + cells); renderer / picking read the derived read-model WorldIndex (`doc.world`).
 * VoxelWorld has been removed from the runtime.
 */
const shapeOf = (catalogIndex: number) => CATALOG[catalogIndex]?.shape;
const recipeStore = new RecipeStore(localStorage);
// **Must come before the codec.** The list reads back from localStorage during
// construction, so declaring this after it would reference an uninitialized value
// mid-readback and drop every entry.
const indexOfBlock = buildIndexOf(CATALOG);
// Save the list in a form independent of catalog ordering (block id + orientation),
// so it still opens the same way even if blocks are added or generation order changes.
const componentStore = new ComponentStore(localStorage, {
  encode: (template) => serializeComponentTemplate(template, CATALOG),
  decode: (raw) => {
    try {
      return validateComponents([raw], indexOfBlock)[0] ?? null;
    } catch {
      return null; // Drop only the broken entry (don't wipe the whole list)
    }
  },
});
const patternPaints = new PatternPaintStore();
const editorScene: EditorScene = { tree: new SceneTree(), cells: new OwnerVoxelStore(), patterns: patternPaints };
const doc = new Document(
  editorScene,
  shapeOf,
  (ref, raw, worldCell) => {
    // Called for every cell during a full reprojection. Skip key generation / parse / lookup when no patterns are in use.
    if (patternPaints.size === 0) return raw;
    const key = `${ref.localCell[0]},${ref.localCell[1]},${ref.localCell[2]}`;
    const paint = activePatternAt(patternPaints, editorScene.cells, ref.ownerId, key);
    return paint ? resolvePatternRaw(paint, worldCell, recipeStore.get(paint.recipeId), indexOfBlock, shapeOf) : raw;
  },
  // The hook into the list (owning side). Tracks marker lifecycle and records definition swaps in history
  componentStore,
);
/**
 * Derived index compatible with WorldReader. **Hidden-cell exclusion is now handled
 * internally by WorldIndex's winner resolution**, so injecting the old `isCellHidden`
 * filter (into renderer / picking) is no longer needed.
 */
const world = doc.world;

const voxelMesh = new VoxelMesh(ctx.scene, world, CATALOG, new THREE.TextureLoader(), texturePackService.resolveUrl);
const voxelEdges = new VoxelEdges(ctx.scene, world, CATALOG);
// Void never wins and is never drawn, so show a position hint via outline edges
const voidEdges = new VoidEdges(ctx.scene, doc.index);
const selection = new SelectionStore(doc);
const selectionOverlay = new SelectionOverlay(ctx.scene, doc, selection);

// ---- Render scheduling (dirty notifications, requestAnimationFrame loop). Extracted to RenderScheduler ----

// Axis gizmo. Overlaid on the viewport — placing it inside the 3D scene would make it disappear when the build is far from the origin
const axisGizmo = initAxisGizmo(canvas.parentElement ?? document.body, ctx.camera);

const renderScheduler = createRenderScheduler({
  voxelMesh,
  voxelEdges,
  voidEdges,
  selectionOverlay,
  resizeIfNeeded: () => ctx.resizeIfNeeded(),
  // cameraKeys is created further down this file (after computeFocus is defined), but
  // updateCameraKeys is a closure only invoked during tick() (i.e. after all consts are
  // initialized, via requestAnimationFrame), so declaration order isn't an issue
  // (same forward-reference pattern as projectService.scheduleAutosave)
  updateCameraKeys: (dt) => cameraKeys.update(dt),
  controlsUpdate: () => ctx.controls.update(),
  renderScene: () => {
    ctx.renderer.render(ctx.scene, ctx.camera);
    // **Sync right after drawing.** Camera movement (including inertia) changes every
    // frame, so picking it up on the input side would stop before damping finishes and
    // leave the gizmo behind
    axisGizmo.update();
  },
  clock: createBrowserFrameClock(),
});

function activeRecipe() {
  if (state.paintMode !== 'mix' || !state.activeRecipeId) return null;
  return recipeStore.get(state.activeRecipeId) ?? null;
}

/**
 * Preview color for void. Prioritize reading as "not a block color" — use a pale
 * blue-gray that doesn't overlap any catalog color (won't be confused with stone grays or quartz white)
 */
const VOID_PREVIEW_COLOR = '#7fd7e8';

/** Called for every cell placed. In mix mode, draws from the blend recipe */
function getPaintBlock(): number | null {
  // Void takes top priority. The blend recipe is about "which block to draw",
  // whereas void means "don't place a block" — it isn't a candidate to mix into the draw
  if (state.paintVoid) return VOID_CATALOG_INDEX;
  const recipe = activeRecipe();
  if (!recipe) return state.activeBlock;
  return sampleRecipe(recipe, indexOfBlock);
}

function getPaintColor(): string {
  if (state.paintVoid) return VOID_PREVIEW_COLOR;
  const recipe = activeRecipe();
  if (!recipe) return CATALOG[state.activeBlock]?.color ?? '#ffffff';
  return averageColor(recipe, CATALOG);
}

/**
 * Display name for the material currently being painted. Appended to the shape group's
 * default name (e.g. `Cuboid: Cobblestone`).
 * In mix mode, this is the blend recipe name — since a block is drawn per cell, no single
 * block name can represent it.
 */
function getPaintLabel(): string {
  if (state.paintVoid) return defaultName('void');
  const recipe = activeRecipe();
  if (recipe) return recipe.name;
  const def = CATALOG[state.activeBlock];
  return def ? blockName(def) : '';
}

let hoverCell: [number, number, number] | null = null;
let toastMessage: string | null = null;
/** Dimensions populated only during a range operation. Reset to null on commit / cancel */
let rangeSize: RangeSize | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function updateStatus(): void {
  if (toastMessage) {
    statusbar.textContent = toastMessage;
    return;
  }
  const hover = hoverCell ? `(${hoverCell[0]}, ${hoverCell[1]}, ${hoverCell[2]})` : '—';
  const selCount = selection.resolveCells().size;
  const selPart = selCount > 0 ? t('status.selPart', { count: selCount.toLocaleString() }) : '';
  // Show dimensions only during a range operation. Don't leave numbers lingering when idle.
  // Conversely, the guide text isn't needed during the operation, so swap dimensions and
  // guide into the same slot (keep the line from growing)
  const sizePart = rangeSize ? t('status.sizePart', { size: formatRangeSize(rangeSize) }) : '';
  const guide = rangeSize ? '' : t('status.guide');
  statusbar.textContent = t('status.line', { blocks: world.size, hover, sel: selPart + sizePart, guide });
}

window.addEventListener('bs-toast', (e) => {
  toastMessage = String((e as CustomEvent).detail);
  updateStatus();
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastMessage = null;
    updateStatus();
  }, 2500);
});

// The single source of mesh updates is WorldIndexChange. Drag preview,
// commit, and structural changes (group visibility toggle / reparent / transform) are all
// notified by WorldIndex as "content changed" — a structural op fires 'replaceAll', triggering
// a full rebuild.
//
// The old implementation updated the mesh through two paths: world.subscribe (diffs) and
// doc.subscribe (markDirty when not voxelOnly), causing double rebuilds for the same change.
// The markDirty call on the Document event side is removed here, consolidating invalidation
// into a single source of truth.
doc.index.subscribe((event) => {
  voxelMesh.onWorldChange(event);
  voxelEdges.onWorldChange(event);
  voidEdges.onWorldChange(event);
});

// When editing ratios, don't rebake cells — just reproject the derived index, and also
// autosave recipe-only changes.
// projectService is already initialized by the time the callback runs (same forward-reference as Document subscribe).
recipeStore.subscribe(() => {
  doc.refreshDerived();
  projectService.scheduleAutosave();
});

// Document events are dedicated to autosave / UI (status, layers, inspector) only
doc.subscribe((change) => {
  updateStatus();
  // projectService is created further down, but subscribe only registers the
  // callback without executing it immediately, so by the time an actual doc change
  // occurs (after projectService exists), the reference is safe
  projectService.scheduleAutosave();
  backupReminder.consider(change, world.size);
});

// ---- Display mode (texture ⇔ flat color). Persisted to localStorage `blocksmith.ui.v1` ----

const UI_STORAGE_KEY = 'blocksmith.ui.v1';

function saveUiPrefs(): void {
  try {
    localStorage.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({
        displayMode: state.displayMode,
        lang: state.lang,
        // **Don't write if the user hasn't chosen.** Writing the resolved value here would
        // pin even users who only changed the language to "whatever the OS setting was at
        // that moment", so they'd stop following OS changes afterward
        showVoidEdges: state.showVoidEdges,
        ...(state.themePreference === 'system' ? {} : { theme: state.themePreference }),
      }),
    );
  } catch {
    // Ignore if localStorage is unavailable (private mode, etc.)
  }
}

// Display language for block names. UI labels stay fixed in English; only this switches
let lastLang = state.lang;
onStateChange(() => {
  if (state.lang === lastLang) return;
  lastLang = state.lang;
  updateStatus(); // The status bar renders itself, so redraw it on language switch
  saveUiPrefs();
});

/**
 * Screen theme. **A single `<html>` attribute switches everything** —
 * CSS re-maps semantic tokens via `[data-theme='dark']`, and 3D re-reads that CSS.
 * Consolidated into one to avoid a state where only one side switches.
 */
function applyTheme(): void {
  document.documentElement.dataset.theme = resolvedTheme();
  ctx.refreshTheme();
  renderScheduler.markDirty();
}

let lastTheme = resolvedTheme();
let lastThemePreference = state.themePreference;
onStateChange((event) => {
  if (event.kind !== 'theme') return;
  const next = resolvedTheme();
  if (next !== lastTheme) {
    lastTheme = next;
    applyTheme();
  }
  // **Don't touch storage if only the OS changed.** The user's own preference hasn't
  // changed, so rewriting would keep updating storage while still in the "not chosen" state
  if (state.themePreference !== lastThemePreference) {
    lastThemePreference = state.themePreference;
    saveUiPrefs();
  }
});

// Follow OS-side setting changes (only while the user hasn't chosen themselves; the decision lives in state)
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', notifySystemThemeChanged);

let lastShowVoidEdges = state.showVoidEdges;
onStateChange((event) => {
  if (event.kind !== 'voidEdges' || state.showVoidEdges === lastShowVoidEdges) return;
  lastShowVoidEdges = state.showVoidEdges;
  voidEdges.setVisible(state.showVoidEdges);
  renderScheduler.markDirty();
  saveUiPrefs();
});

let lastDisplayMode = state.displayMode;
onStateChange(() => {
  if (state.displayMode === lastDisplayMode) return;
  lastDisplayMode = state.displayMode;
  voxelMesh.setDisplayMode(state.displayMode);
  voxelEdges.setVisible(state.displayMode === 'flat');
  saveUiPrefs();
});

// Restore the previous mode on startup (applied before the first render)
try {
  const raw = localStorage.getItem(UI_STORAGE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw) as {
      displayMode?: DisplayMode;
      lang?: Lang;
      theme?: ThemePreference;
      showVoidEdges?: boolean;
    };
    if (parsed.displayMode === 'flat' || parsed.displayMode === 'texture') setDisplayMode(parsed.displayMode);
    if (parsed.lang === 'ja' || parsed.lang === 'en') setLang(parsed.lang);
    if (typeof parsed.showVoidEdges === 'boolean') setShowVoidEdges(parsed.showVoidEdges);
    // **Only saved when the user explicitly chose it**. If absent, stays "system" = follows the OS
    if (parsed.theme === 'light' || parsed.theme === 'dark') setThemePreference(parsed.theme);
  }
} catch {
  // Ignore corrupted settings and keep the default (texture)
}

// Apply once after restoring. **state's default is the OS setting**, so if nothing was saved, it just follows that
applyTheme();
voidEdges.setVisible(state.showVoidEdges);

// ---- Picking (pick / placement coordinates / drag projection). Extracted to PickingService ----

const pickingService = createPickingService({
  canvas,
  camera: ctx.camera,
  index: doc.index,
});

/** Snaps to a view preset (top / front / side). computeFocus is a function declaration (hoisted), so it's referenceable here */
function setView(preset: ViewPreset): void {
  applyViewPreset(preset, { camera: ctx.camera, controls: ctx.controls, getFocus: computeFocus });
}

/**
 * **The single predicate that decides ownership of the arrow keys** (raised in review).
 *
 * Both the nudge entry in the shortcut table and camerakeys **look at this and only this**.
 * Previously the decision was made independently in two places, which could produce a state
 * where "the table rejected the nudge, but camerakeys also yielded" — nobody handles the key
 * and nothing happens.
 *
 * - Selection exists and no modifier key is held → nudge takes it
 * - Otherwise → not taken (falls through to camerakeys' arrow camera movement)
 *
 * Modifier-key presses are excluded because `handleNudge` doesn't look at modifiers.
 * Shift+↑↓ belongs to layer range selection; when that doesn't claim it, it passes to
 * the camera. `W A S D` always go to the camera regardless of selection, so the view
 * never becomes unreachable.
 */
function arrowsClaimedByNudge(mods: ArrowModifiers): boolean {
  if (mods.shiftKey || mods.ctrlKey || mods.metaKey || mods.altKey) return false;
  if (selection.get().kind === 'none') return false;
  // Don't take it while dragging, since it would conflict with the nudge. **This condition
  // also belongs inside the predicate** — if a caller instead appends `&& !hasActiveDrag()`,
  // camerakeys would keep yielding without knowing about it, and the "neither nudge nor
  // camera gets it" state would recur in the same shape (raised in review)
  return !selectTool.hasActiveDrag();
}

/** If a single group is selected in the layers panel, place new blocks under its id; otherwise root (same as drawing inside a Figma frame) */
function getPlacementGroup(): string | null {
  const sel = selection.get();
  return sel.kind === 'groups' && sel.ids.length === 1 ? sel.ids[0]! : null;
}

// Forward reference until initCameraKeys (constructed further down, after computeFocus is
// defined) provides isSpaceHeld. Since the closure passes the variable by reference,
// swapping in cameraKeys.isSpaceHeld later also takes effect in the isSpacePanActive
// callback registered earlier
let isSpaceHeldRef: () => boolean = () => false;
/**
 * While Space is held, yield the edit tool's left-drag to panning. The actual pan movement
 * is handled by OrbitControls (mouseButtons.LEFT=PAN), so this only returns "yield or not".
 */
function isSpacePanActive(): boolean {
  return isSpaceHeldRef();
}

const editorControls = initEditorControls({
  scene: ctx.scene,
  world,
  doc,
  // Cells of the component about to be placed. Only the shape is passed down to the input layer
  getPendingComponentCells: () => {
    const template = pendingComponent();
    if (!template) return null;
    // **Read the same column as the placement side** (aligns the projected cells' min
    // corner to the click position). Recomputing coordinates here would make the ghost
    // and the actual placement diverge
    return componentPlacementOffsets(template).map(([x, y, z]) => [x, y, z] as [number, number, number]);
  },
  onPlaceComponent: (origin) => {
    const template = pendingComponent();
    if (!template) return;
    commitOpResult(doc, selection, buildPlaceComponent(doc, template, origin), toast, opError);
    // Exit placement mode after placing. **Press again to keep placing** —
    // otherwise the next click intended for selecting something else would place another one
    setPendingComponent(null);
  },
  getCatalog: () => CATALOG,
  getPaintBlock,
  getPaintColor,
  getPaintLabel,
  onHover: (cell) => {
    hoverCell = cell;
    updateStatus();
  },
  onRangeSize: (range) => {
    rangeSize = range;
    updateStatus();
  },
  pickFromEvent: pickingService.pickFromEvent,
  resolvePlaceCell: pickingService.resolvePlaceCell,
  getPlacementGroup,
  resolveRangeFaceCell: pickingService.resolveRangeFaceCell,
  resolveRangeExtrudeCell: pickingService.resolveRangeExtrudeCell,
  isSpacePanActive,
});

const selectTool = initSelectTool({
  scene: ctx.scene,
  doc,
  selection,
  // Selection needs locked transparency, so pass the select-only probe path
  pickFromEvent: pickingService.pickFromEventForSelect,
  resolvePlaceCell: pickingService.resolvePlaceCell,
  toast,
  dragProject: pickingService.dragProject,
  setSelectionDragOffset: (offset) => selectionOverlay.setDragOffset(offset),
  isSpacePanActive,
  // Camera pose used to map arrow keys to screen left/right and near/far.
  // Pass matrixWorld's basis directly, keeping the three.js dependency out of the input layer
  getCameraBasis: () => {
    ctx.camera.updateMatrixWorld();
    const m = ctx.camera.matrixWorld.elements;
    return {
      right: [m[0], m[1], m[2]],
      up: [m[4], m[5], m[6]],
      forward: [-m[8], -m[9], -m[10]], // The camera faces its own -Z
    };
  },
});

selection.subscribe(updateStatus);

// ---- Project management (export / save / load / autosave). Extracted to ProjectService ----

const projectService = createProjectService({
  world,
  doc,
  recipeStore,
  componentStore,
  getCatalog: () => CATALOG,
  indexOfBlock,
  toast,
  onNameChange: (name) => {
    const nameInput = document.getElementById('project-name') as HTMLInputElement | null;
    if (nameInput) nameInput.value = name;
  },
  // toolbar is built later since it receives projectService. Notifications only fire
  // after the first edit (i.e. after initToolbar), so pass it through as a forward reference
  onSaveStateChange: (kind) => toolbarHandle?.setSaveState(kind),
  io: createBrowserProjectIO(),
});
let toolbarHandle: ToolbarHandle | null = null;
const backupReminder = createBackupReminder({
  storage: sessionStorage,
  notify: () => toast(t('project.backupReminder')),
});

/** Reading the File's contents (`file.text()`) is the composition root's responsibility
 *  (ProjectService's public API doesn't take a File type review). Toast with the same
 *  wording as loadProjectFromText, including read failures themselves
 *  (same behavior as the original implementation's single catch) */
function loadProjectFromFile(file: File): void {
  file
    .text()
    .then((text) => projectService.loadProjectFromText(text))
    // Don't assemble a raw message. Route all display through errorText as the single boundary (raised in review)
    .catch((e) => toast(t('toast.loadFailed', { message: errorText(e, 'err.loadFailed') })));
}

function refreshImportedTextures(): void {
  refreshTextureElements();
  voxelMesh.reloadTextures();
  ctx.reloadTextureAssets();
}

function textureImportError(error: unknown): string {
  if (!(error instanceof TexturePackError)) return t('texture.error.storage');
  const key = {
    'archive-too-large': 'texture.error.archiveTooLarge',
    'invalid-archive': 'texture.error.invalidArchive',
    'no-matching-textures': 'texture.error.noMatches',
    'texture-too-large': 'texture.error.textureTooLarge',
  } as const;
  return t(key[error.code]);
}

initPalette(paletteRoot, CATALOG);
initRecipes(recipesRoot, CATALOG, recipeStore);
// A component placed from the list **appears at the origin, selected**.
// Alignment (ghost + click to confirm) is Step 3b; until then, place then move
/**
 * Component edit mode state. **Two entry points (list / instance selection), but
 * one mode** — since what happens after entering is the same, keep the state singular too
 */
let componentEdit: ComponentEditSession | null = null;

function enterComponentEdit(template: ComponentTemplate): void {
  if (componentEdit) return;
  const entered = beginComponentEdit(doc, template);
  if (!('session' in entered)) {
    if ('error' in entered) toast(opError(entered.error, entered.errorVars));
    return;
  }
  componentEdit = entered.session;
  selection.set(entered.newSelection);
  componentsPanel.refresh();
}

/** Exit edit mode. If `save` is false, discard without writing back */
function leaveComponentEdit(save: boolean): void {
  if (!componentEdit) return;
  const result = endComponentEdit(doc, componentEdit, componentStore.get(componentEdit.templateId), save);
  if (!('template' in result)) {
    // Failed before rolling back = the session is still active (Done can be pressed again)
    if ('error' in result) toast(opError(result.error, result.errorVars));
    return;
  }
  // By the time execution reaches here, the session is closed. **Fold edit mode even if the write-back failed**
  if (result.failed && 'error' in result.failed) toast(opError(result.failed.error, result.failed.errorVars));
  componentEdit = null;
  selection.clear();
  // Writing back to the list happens in the op that endComponentEdit records to history (don't double-write here)
  componentsPanel.refresh();
}

function finishComponentEdit(): void {
  leaveComponentEdit(true);
}


const componentsPanel = initComponents(componentsRoot, CATALOG, componentStore, {
  onEdit: enterComponentEdit,
  getEditingId: () => componentEdit?.templateId ?? null,
  onFinishEdit: finishComponentEdit,
  // **Removing from the list and breaking the build are separate decisions**.
  // Don't delete placed instances — revert them to a plain group (recorded in history, so undo can restore it)
  onRemove: (template) => {
    const result = buildDetachInstancesOf(doc, template.id);
    if ('tx' in result && result.tx.ops.length) doc.applyTransaction(result.tx);
  },
});

/** The component about to be placed. **Always look it up by id** — caching a copy of the shape would place a stale shape after editing */
const pendingComponent = (): ComponentTemplate | null =>
  state.pendingComponentId === null ? null : (componentStore.get(state.pendingComponentId) ?? null);
const layersPanel = initLayers(layersRoot, doc, selection, () => CATALOG, toast);
initInspector(
  inspectorRoot,
  doc,
  selection,
  () => CATALOG,
  toast,
  activeRecipe,
  indexOfBlock,
  (fn) => {
    recipeStore.subscribe(fn);
  },
  {
    // **Register into the list only after the transaction succeeds**. Registering
    // first would leave a list entry with no instance if applying it failed
    createFromSelection: (sel) => {
      const result = buildCreateComponent(doc, sel, componentStore.nextId());
      if (isCreateComponentError(result)) {
        if ('error' in result) toast(opError(result.error, result.errorVars));
        return;
      }
      doc.applyTransaction(result.tx);
      componentStore.add(result.template);
    },
    detach: (groupId) => {
      commitOpResult(doc, selection, buildDetachInstance(doc, groupId), toast, opError);
    },
    isInstance: (groupId) => doc.templateIdOf(groupId) !== null,
    editComponentOf: (groupId) => {
      const id = doc.templateIdOf(groupId);
      const template = id === null ? undefined : componentStore.get(id);
      if (template) enterComponentEdit(template);
    },
  },
);
// Only one block-change picker exists on screen. The block-usage panel and the
// toolbar's overlaid swatch both open the same instance — creating one per caller would
// spawn two popovers with the same id
const blockChangePicker = createBlockChangePicker(CATALOG, recipeStore);
initBlockUsage(blockUsageRoot, doc, selection, () => CATALOG, recipeStore, toast, blockChangePicker);
toolbarHandle = initToolbar(toolbarRoot, documentRoot, worldControlsRoot, fileMenuAnchor, doc, {
  getName: projectService.getName,
  setName: projectService.setName,
  exportMcpack: projectService.exportMcpack,
  saveProject: () => {
    projectService.saveProjectFile();
    backupReminder.markBackedUp();
  },
  loadProjectFile: loadProjectFromFile,
  clearAll: () => {
    if (world.size === 0 || window.confirm(t('confirm.clearAll', { count: world.size }))) doc.clearAll();
  },
  setView,
  toggleGround: () => ctx.setGroundTheme(ctx.getGroundTheme() === 'neutral' ? 'grass' : 'neutral'),
  getGroundLabel: () => (ctx.getGroundTheme() === 'neutral' ? t('ground.neutral') : t('ground.grass')),
  loadTexturePackFile: (file) => {
    void texturePackService
      .importFile(file)
      .then((result) => {
        refreshImportedTextures();
        toolbarHandle?.setTextureCount(result.imported);
        toast(t('texture.imported', { count: result.imported, total: result.required }));
      })
      .catch((error) => toast(textureImportError(error)));
  },
  clearTexturePack: () => {
    void texturePackService
      .clear()
      .then(() => {
        refreshImportedTextures();
        toolbarHandle?.setTextureCount(0);
        toast(t('texture.removed'));
      })
      .catch(() => toast(t('texture.error.storage')));
  },
}, CATALOG, blockChangePicker);

void texturePackService
  .count()
  .then((count) => toolbarHandle?.setTextureCount(count))
  .catch(() => toolbarHandle?.setTextureCount(0));
window.addEventListener('pagehide', () => texturePackService.dispose(), { once: true });

projectService.restoreAutosave(); // Restore the previous autosave

const helpHandle = initHelp(document.getElementById('help')!);

/** Center coordinates and radius of the build (shared by the F key and view-preset distance calculation) */
function computeFocus(): { center: THREE.Vector3; radius: number } | null {
  const b = world.bounds();
  if (!b) return null;
  const center = new THREE.Vector3(
    (b.min[0] + b.max[0]) / 2 + 0.5,
    (b.min[1] + b.max[1]) / 2 + 0.5,
    (b.min[2] + b.max[2]) / 2 + 0.5,
  );
  const radius = Math.max(
    2,
    new THREE.Vector3(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]).length() / 2,
  );
  return { center, radius };
}

// Keyboard camera controls (WASD / arrows / Z / C / Q / E / F / R; Space is dedicated to left-drag panning)
const cameraKeys = initCameraKeys({
  camera: ctx.camera,
  controls: ctx.controls,
  getFocus: computeFocus,
  isArrowClaimed: arrowsClaimedByNudge,
});
isSpaceHeldRef = cameraKeys.isSpaceHeld;

// If focus stays on a button, Space/Enter would misfire it, so blur after clicking
document.addEventListener('click', (e) => {
  if (e.target instanceof HTMLButtonElement) e.target.blur();
});

// ---- InputRouter: the single source of keyboard shortcut priority ----
// Array order = priority. Follows the same order as the old implementation's window keydown
// listener registration (controls → selecttool → main → help) (behavior frozen plan §invariant 6).

const shortcutCtx: ShortcutContext = {
  tool: () => state.tool,
  hasSelection: () => selection.get().kind !== 'none',
};

const SHORTCUTS: ShortcutEntry[] = [
  {
    id: 'undo-redo (ctrl+z / ctrl+shift+z)',
    duringGesture: 'block',
    matches: (e) => isCtrlOrMeta(e) && e.key.toLowerCase() === 'z',
    run: (e) => {
      e.preventDefault();
      if (e.shiftKey) doc.redo();
      else doc.undo();
    },
  },
  {
    id: 'redo (ctrl+y)',
    duringGesture: 'block',
    matches: (e) => isCtrlOrMeta(e) && e.key.toLowerCase() === 'y',
    run: (e) => {
      e.preventDefault();
      doc.redo();
    },
  },
  {
    // **Block during a gesture**. If the tool changes mid-stroke, the
    // toolbar's pressed-state display would disagree with the edits actually being
    // accumulated. The processing side already pins strokeTool to the tool active at
    // start, so this is purely to keep the display consistent
    id: 'tool hotkeys (1/2/3/4/v) — does not fire with ctrl/shift/meta held, to avoid misfires',
    duringGesture: 'block',
    matches: (e) => !e.shiftKey && !isCtrlOrMeta(e) && ['1', '2', '3', '4', 'v', 'V'].includes(e.key),
    run: (e) => {
      if (e.key === '1') setTool('place');
      else if (e.key === '2') setTool('erase');
      else if (e.key === '3') {
        // 3 is the "fill a range" tool + box shape. Same as Figma: each shape gets its own direct hotkey
        setShape('box');
        setTool('fill');
      } else if (e.key === '4') setTool('pick');
      else setTool('select');
    },
  },
  {
    // Assign a direct hotkey per shape. Pressing one key decides tool and shape
    // selection simultaneously, so it's never a two-step "pick tool, then pick shape".
    // The toolbar stays a single button; only the number of hotkeys grows
    id: 'shape hotkeys (o/y/m/k) — enters range-fill with the pressed shape',
    duringGesture: 'block',
    matches: (e) => !e.shiftKey && !isCtrlOrMeta(e) && SHAPE_KEYS.has(e.key.toLowerCase()),
    run: (e) => {
      const shape = SHAPE_KEYS.get(e.key.toLowerCase());
      if (!shape) return;
      setShape(shape);
      setTool('fill');
    },
  },
  {
    id: 'orientation (t/g) — g is mutually exclusive with ctrl+g (group) via modifiers',
    duringGesture: 'allow',
    matches: (e) => !e.shiftKey && !isCtrlOrMeta(e) && ['t', 'T', 'g', 'G'].includes(e.key),
    run: (e) => {
      if (e.key === 't' || e.key === 'T') cyclePendingFacing();
      else togglePendingFlip();
    },
  },
  {
    // Same key as Photoshop's foreground/background color swap. shift+x is already used
    // for mirroring the selection, so only pick this up when no modifier is held
    id: 'swap active/spare block (x)',
    duringGesture: 'allow',
    matches: (e) => !e.shiftKey && !e.altKey && !isCtrlOrMeta(e) && (e.key === 'x' || e.key === 'X'),
    run: () => swapActiveAndSpare(),
  },
  {
    id: 'group (ctrl+g, select tool)',
    duringGesture: 'block',
    matches: (e, ctx) => isCtrlOrMeta(e) && !e.shiftKey && (e.key === 'g' || e.key === 'G') && ctx.tool() === 'select',
    run: (e) => {
      e.preventDefault();
      selectTool.handleGroup();
    },
  },
  {
    id: 'ungroup (ctrl+shift+g, select tool)',
    duringGesture: 'block',
    matches: (e, ctx) => isCtrlOrMeta(e) && e.shiftKey && (e.key === 'g' || e.key === 'G') && ctx.tool() === 'select',
    run: (e) => {
      e.preventDefault();
      selectTool.handleUngroup();
    },
  },
  {
    // Layer panel range selection. Placed above nudge — Shift wasn't previously
    // watched by either path (nudge / camerakeys) and fell into the same bucket as a plain
    // arrow key, so claiming only the Shift-modified case leaves plain arrows unchanged.
    //
    // **Don't match when the key can't actually be handled** — dispatchShortcut consumes
    // the key without checking run's return value, so the yield condition must live in
    // matches, not run. `hasSelection()` alone isn't enough: collapsing a parent that
    // hides a selected child group leaves Selection non-empty while zero visible rows are
    // selected — it would match and do nothing, without even calling preventDefault,
    // leaking through to the browser's default scroll.
    id: 'extend layer selection (shift+arrowup/arrowdown, with a visible selection)',
    duringGesture: 'block',
    matches: (e) =>
      e.shiftKey &&
      !isCtrlOrMeta(e) &&
      !e.altKey &&
      (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
      layersPanel.canExtendSelection(),
    run: (e) => {
      e.preventDefault();
      layersPanel.extendSelection(e.key === 'ArrowUp' ? -1 : 1);
    },
  },
  {
    // With no selection / mid-drag, don't match here — fall back to camerakeys' arrow
    // camera movement. (In the old implementation, camerakeys could independently pick up
    // arrows even when selecttool's side returned. Now that routing is a single exclusive
    // entry, the condition here needs to be exact. Found via review.)
    //
    // **Don't include the tool in the condition**. `handleNudge` only ever acted on
    // selection, and the gate lived in two places: here and `isArrowClaimed()`. Removing it
    // from both consolidates to "where the arrow goes is decided purely by selection" —
    // fixing only one side would create a state where the key is claimed but nothing happens.
    //
    // **All** the conditions live in `arrowsClaimedByNudge` (the same predicate camerakeys
    // uses). Don't add conditions here — doing so creates a check camerakeys doesn't know
    // about, and the "both yield, nothing happens" state returns.
    id: 'nudge (arrows/PageUp/PageDown, arrowsClaimedByNudge)',
    duringGesture: 'block',
    matches: (e) => NUDGE_KEYS.has(e.key) && arrowsClaimedByNudge(e),
    run: (e) => selectTool.handleNudge(e), // preventDefault is called inside handleNudge only when there's a target cell
  },
  {
    // Originally assigned to r / Shift+R, but that collided with camerakeys' r (view
    // reset), which would turn a non-destructive operation into a model change depending
    // on selection state — so it was changed to [ / ]. Neither key had an
    // existing assignment or browser default behavior.
    id: 'rotate group 90° ([=left 90° / ]=right 90°, select tool)',
    duringGesture: 'block',
    matches: (e, ctx) => !isCtrlOrMeta(e) && !e.altKey && (e.key === '[' || e.key === ']') && ctx.tool() === 'select',
    run: (e) => {
      // Based on the top-down view (right=+X / up=−Z): [ = counterclockwise (angleSteps +1) / ] = clockwise (+3)
      if (selectTool.handleRotate(e.key === '[' ? 1 : 3)) e.preventDefault();
    },
  },
  {
    // Maps directly to the axis's initial letter (Shift+X = mirror on the X axis).
    //
    // **camerakeys only excludes ctrl/meta/alt, so Shift+Z has always been handled as a
    // view-raise**. The router doesn't fall through to camerakeys once
    // SHORTCUTS matches, so claiming this without checking for a selection would turn
    // Shift+Z with no selection into a dead key that does neither camera nor mirror.
    // **Only claim it when there's actually something to mirror.** Excluding isCtrlOrMeta
    // also keeps it mutually exclusive with Ctrl+Shift+Z (redo).
    id: 'mirror selection (shift+x / shift+y / shift+z, select tool, only with a selection)',
    duringGesture: 'block',
    matches: (e, ctx) =>
      !isCtrlOrMeta(e) &&
      !e.altKey &&
      e.shiftKey &&
      (['x', 'y', 'z'] as const).some((a) => a === e.key.toLowerCase()) &&
      ctx.tool() === 'select' &&
      ctx.hasSelection(),
    run: (e) => {
      const axis = e.key.toLowerCase() as MirrorAxis;
      if (selectTool.handleMirror(axis)) e.preventDefault();
    },
  },
  {
    id: 'duplicate (ctrl+d, select tool)',
    duringGesture: 'block',
    matches: (e, ctx) => isCtrlOrMeta(e) && !e.shiftKey && e.key.toLowerCase() === 'd' && ctx.tool() === 'select',
    run: (e) => {
      e.preventDefault();
      selectTool.handleDuplicate();
    },
  },
  {
    id: 'copy (ctrl+c, select tool)',
    duringGesture: 'block',
    matches: (e, ctx) => isCtrlOrMeta(e) && !e.shiftKey && e.key.toLowerCase() === 'c' && ctx.tool() === 'select',
    run: (e) => {
      e.preventDefault();
      selectTool.handleCopy();
    },
  },
  {
    id: 'paste (ctrl+v, select tool)',
    duringGesture: 'block',
    matches: (e, ctx) => isCtrlOrMeta(e) && !e.shiftKey && e.key.toLowerCase() === 'v' && ctx.tool() === 'select',
    run: (e) => {
      e.preventDefault();
      selectTool.handlePaste();
    },
  },
  {
    id: 'delete selection (Delete/Backspace, select tool)',
    duringGesture: 'block',
    matches: (e, ctx) => ctx.tool() === 'select' && (e.key === 'Delete' || e.key === 'Backspace'),
    run: (e) => selectTool.handleDelete(e), // preventDefault is called inside handleDelete only when there's something to delete
  },
  {
    id: 'view presets (shift+digit7/1/3, layout-independent via e.code)',
    duringGesture: 'allow',
    matches: (e) => e.shiftKey && ['Digit7', 'Digit1', 'Digit3'].includes(e.code),
    run: (e) => {
      if (e.code === 'Digit7') setView('top');
      else if (e.code === 'Digit1') setView('front');
      else setView('side');
    },
  },
  {
    id: 'help toggle (h / ?)',
    duringGesture: 'allow',
    matches: (e) => e.key === 'h' || e.key === 'H' || e.key === '?',
    run: () => helpHandle.toggle(),
  },
];

const inputRouter = createInputRouter({
  target: window,
  canvas,
  shortcuts: SHORTCUTS,
  ctx: shortcutCtx,
  cameraKeys,
  // Escape broadcast: preserves the same "multiple can react simultaneously" behavior as
  // the old implementation, where each module independently judged and reacted to
  // synthetic/real Escape events (an invariant of the input plan)
  escapeHandlers: [editorControls.cancelActive, selectTool.cancelActive, helpHandle.close],
  // pointerdown priority (the select tool is integrated into the router): edit-tools (place/erase/fill/pick) →
  // select-tool (select / drag-move / marquee). Array order = priority.
  // The edit-tools route returns null while state.tool==='select', yielding to select-tool.
  // Both routes return null during Space+left-drag, yielding to OrbitControls' pan.
  pointerRoutes: [editorControls.route, selectTool.route],
});
inputRouter.attach();

updateStatus();

/**
 * Projects a cell's center 3D coordinates onto the canvas's screen (page) coordinates.
 * Helper so E2E tests (Playwright) can accurately align click/drag coordinates to any
 * cell without depending on the camera's default position (used only via window.__bs).
 */
function projectToScreen(v: THREE.Vector3): { x: number; y: number } {
  v.project(ctx.camera);
  const rect = canvas.getBoundingClientRect();
  return {
    x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
    y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
  };
}

function cellScreenPos(x: number, y: number, z: number): { x: number; y: number } {
  return projectToScreen(new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5));
}

/**
 * Projects the center of cell (x, z) on the y=0 ground plane onto screen coordinates.
 * Use this for clicking on ground with nothing placed yet to place a new block
 * (cellScreenPos uses the voxel center y+0.5, so the parallax difference from ground
 * y=0 would cause placement to land in the wrong neighboring cell).
 */
function groundScreenPos(x: number, z: number): { x: number; y: number } {
  return projectToScreen(new THREE.Vector3(x + 0.5, 0, z + 0.5));
}

// Debug hook (inspect state from the console; also referenced from E2E tests via window.__bs)
(window as unknown as Record<string, unknown>).__bs = {
  world,
  /**
   * The catalogIndex of the block placed in the cell (null if empty).
   *
   * If E2E extracted this by dividing `world.get()`'s raw value, tests would need
   * updating every time the orientation code width changes. Pass it semantically
   * instead, keeping the packed representation's radix out of the public surface.
   */
  catalogIndexAt: (x: number, y: number, z: number): number | null => {
    const raw = world.get(x, y, z);
    return raw === null ? null : unpackCell(raw).catalogIndex;
  },
  voxelMesh,
  voxelEdges,
  voidEdges,
  doc,
  ctx,
  recipeStore,
  state,
  setActiveBlock,
  setActiveRecipe,
  CATALOG,
  selection,
  selectionOverlay,
  cellScreenPos,
  groundScreenPos,
  selectTool,
  editorControls,
};

renderScheduler.start();
