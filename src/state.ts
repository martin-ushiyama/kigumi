import { cycleFacing as cycleFacingCode, cyclePillarAxis, defaultCode, toggleFlip as toggleFlipCode } from './core/orientation';
import { CATALOG } from './data/blocks';
import { isPillarBlock, type DisplayMode, type Tool } from './core/types';
import {
  DisplayableError,
  defaultName as resolveDefaultName,
  translate,
  translateOpError,
  type DefaultNameKey,
  type Lang,
  type OpErrorKey,
  type UiKey,
} from './core/i18n';
import { defaultHollow, type ShapeKind } from './core/shapes';
import type { Axis } from './core/axis';
import { createEmitter, type Unsubscribe } from './core/emitter';

export type { Axis, DisplayMode, Lang, ShapeKind, Tool };

/** Change-notification event kinds for the global AppState */
export type AppStateChange =
  | { kind: 'tool' }
  | { kind: 'activeBlock' }
  | { kind: 'activeRecipe' }
  | { kind: 'pendingOrientation' }
  | { kind: 'displayMode' }
  | { kind: 'voidEdges' }
  | { kind: 'lang' }
  | { kind: 'theme' }
  | { kind: 'shape' }
  | { kind: 'pendingComponent' };

const RECENT_MAX = 10;

export interface AppState {
  tool: Tool;
  /** Index into the blocks catalog */
  activeBlock: number;
  /**
   * Id of the component about to be placed. `null` = not in placement mode.
   *
   * **Only the id lives here.** The actual contents (`ComponentTemplate`) live in the
   * list and are looked up on every placement — if state held a copy of the shape,
   * editing a component would keep placing the stale shape.
   */
  pendingComponentId: string | null;
  /** Whether the paint material is set to void (shape tool only) */
  paintVoid: boolean;
  /**
   * The spare block (catalog index). Sits behind the stacked swatch in the
   * toolbar and swaps with activeBlock via the `X` key (same role as foreground /
   * background color in Photoshop).
   *
   * **Must never be empty.** Allowing a "no spare" state would only add branching
   * in three places (rendering, key handling, swapping) for no benefit, so a block
   * different from activeBlock is seeded in from startup.
   */
  spareBlock: number;
  /** block = solid color / mix = drawn from the mix palette */
  paintMode: 'block' | 'mix';
  activeRecipeId: string | null;
  /** Orientation code for the next placement (changed via T/G keys, meaning depends on shape — see orientation.ts) */
  pendingOrientation: number;
  /** Recently selected blocks (catalog index, newest first, no duplicates, max 10) */
  recentBlocks: number[];
  /** Display mode (textured vs. flat-colored) */
  displayMode: DisplayMode;
  /** Whether to show outlines on void blocks. Shown by default — it's a visual cue while placing */
  showVoidEdges: boolean;
  /** Display language for the UI and block names */
  lang: Lang;
  /**
   * Theme preference. **"Not yet decided" is itself a representable value.**
   *
   * `system` = no explicit choice made. Follows the OS setting and changes along
   * with it. `light` / `dark` = an explicit choice, which then stays fixed even if
   * the OS setting changes afterward.
   *
   * The resolved appearance is read via `resolvedTheme()` — storing the resolved
   * value here would erase the distinction between "undecided" and "happens to be
   * light right now."
   */
  themePreference: ThemePreference;
  /**
   * Shape to fill with the range-fill tool. The box is treated as just another
   * shape option on equal footing. This keeps the tool count fixed and only switches
   * how the fill is shaped.
   */
  shape: ShapeKind;
  /** Whether to fill the shape hollow (shell thickness 1). `null` = use the per-shape default (only the dome is hollow by default) */
  shapeHollow: boolean | null;
  /** Axis the cylinder extends along (0=X / 1=Y / 2=Z) */
  shapeAxis: Axis;
  /** Step height of the slope (blocks risen per step, minimum 1) */
  shapeStep: number;
}

export const state: AppState = {
  // Don't start in edit mode on load — a click meant to orient the camera would place a block
  tool: 'select',
  activeBlock: 0,
  pendingComponentId: null,
  paintVoid: false,
  // Stone (0) and cobblestone (2). Seeded with a different material so `X` swapping works from startup
  spareBlock: 2,
  paintMode: 'block',
  activeRecipeId: null,
  pendingOrientation: 0,
  recentBlocks: [],
  displayMode: 'texture',
  showVoidEdges: true,
  lang: 'en',
  themePreference: 'system',
  shape: 'box',
  shapeHollow: null,
  shapeAxis: 1,
  shapeStep: 1,
};

const emitter = createEmitter<AppStateChange>();

/** Supports multiple subscribers, returns an unsubscribe function */
export function onStateChange(fn: (event: AppStateChange) => void): Unsubscribe {
  return emitter.subscribe(fn);
}

export function setTool(tool: Tool): void {
  state.tool = tool;
  // Void is a paint material specific to the shape tool, so clear it when switching
  // to any other tool. Letting the placement tool place void would place it
  // outside a group, accidentally creating a "void that affects everything" (the
  // effect's scope is determined by the group it's placed inside).
  if (tool !== 'fill') state.paintVoid = false;
  emitter.notify({ kind: 'tool' });
}

/**
 * Toggle the paint material to void / back. **Shape tool only.**
 *
 * Not mixed into `activeBlock` — that's a catalog index, and most call sites
 * assume it always refers to an entry that exists in the catalog. Feeding it a
 * reserved sentinel index would make downstream behavior impossible to reason about.
 */
export function setPaintVoid(on: boolean): void {
  state.paintVoid = on;
  if (on) state.tool = 'fill';
  emitter.notify({ kind: 'shape' });
}

export function setActiveBlock(index: number): void {
  const prevShape = CATALOG[state.activeBlock]?.shape;
  const nextDef = CATALOG[index];
  const nextShape = nextDef?.shape;
  state.activeBlock = index;
  state.paintMode = 'block';
  // Clear void mode once a block is selected — selecting a block but still poking a hole would be confusing
  state.paintVoid = false;
  // Reset orientation when the shape changes (so a stair's flip doesn't carry over
  // onto an unrelated slab). Even when switching between two `full` blocks (shape
  // unchanged), force a reset when switching to a block without a pillar_axis (e.g.
  // stone, which has no concept of orientation) — if the previous log's vertical
  // orientation code carried over, blocks with differing side/top textures (e.g.
  // sandstone) would render with the wrong face.
  if (nextShape && (nextShape !== prevShape || (nextShape === 'full' && nextDef && !isPillarBlock(nextDef)))) {
    state.pendingOrientation = defaultCode(nextShape);
  }
  state.recentBlocks = [index, ...state.recentBlocks.filter((i) => i !== index)].slice(0, RECENT_MAX);
  emitter.notify({ kind: 'activeBlock' });
}

/**
 * Replace the spare block. Clicking the swatch's back slot opens the picker.
 * Unlike the foreground (activeBlock), this doesn't touch orientation reset or
 * history — it's not something you're about to place.
 */
export function setSpareBlock(index: number): void {
  if (state.spareBlock === index) return;
  state.spareBlock = index;
  emitter.notify({ kind: 'activeBlock' });
}

/**
 * Swap the foreground and spare blocks (`X` key / swatch swap button).
 *
 * The foreground goes through `setActiveBlock` — orientation needs resetting when
 * the shape changes, and it should also land in "recently used" history; a plain
 * assignment would skip both.
 */
export function swapActiveAndSpare(): void {
  const previousActive = state.activeBlock;
  setActiveBlock(state.spareBlock);
  state.spareBlock = previousActive;
  emitter.notify({ kind: 'activeBlock' });
}

export function setActiveRecipe(id: string | null): void {
  state.activeRecipeId = id;
  state.paintMode = id === null ? 'block' : 'mix';
  // Clear void mode once a mix recipe is selected. **Paint material selection
  // is always mutually exclusive** — choosing a block / recipe / void drops the
  // others. Leaving it set would mean "selected a recipe but still poking a hole,"
  // a mismatch between what was chosen and what happens.
  if (id !== null) state.paintVoid = false;
  emitter.notify({ kind: 'activeRecipe' });
}

/**
 * Set which component is about to be placed. `null` exits placement mode.
 *
 * Entering placement mode **switches back to the select tool** — staying on the
 * block placement tool while aiming for a spot would place a block on the click
 * that was meant to be an aim (the same accident as the tool-at-stroke-start one).
 */
export function setPendingComponent(id: string | null): void {
  state.pendingComponentId = id;
  if (id !== null) state.tool = 'select';
  emitter.notify({ kind: 'pendingComponent' });
}

/**
 * T key: rotate a stair's horizontal facing by one step / for blocks with a
 * pillar_axis (e.g. logs), cycle the axis y→x→z→y. Ignored for anything else
 * (slabs, or a `full` shape with no concept of orientation).
 */
export function cyclePendingFacing(): void {
  const def = CATALOG[state.activeBlock];
  if (!def) return;
  if (def.shape === 'full') {
    if (!isPillarBlock(def)) return;
    state.pendingOrientation = cyclePillarAxis(state.pendingOrientation);
  } else {
    state.pendingOrientation = cycleFacingCode(def.shape, state.pendingOrientation);
  }
  emitter.notify({ kind: 'pendingOrientation' });
}

/** Apply an orientation code picked up by the eyedropper as-is (pass a value already normalized for the shape) */
export function setPendingOrientation(code: number): void {
  state.pendingOrientation = code;
  emitter.notify({ kind: 'pendingOrientation' });
}

/** G key: toggle a slab's top/bottom half or a stair's upside-down flip (ignored for `full`) */
export function togglePendingFlip(): void {
  const shape = CATALOG[state.activeBlock]?.shape;
  if (!shape) return;
  state.pendingOrientation = toggleFlipCode(shape, state.pendingOrientation);
  emitter.notify({ kind: 'pendingOrientation' });
}

export function setShowVoidEdges(show: boolean): void {
  if (state.showVoidEdges === show) return;
  state.showVoidEdges = show;
  emitter.notify({ kind: 'voidEdges' });
}

/** Switch display mode (textured vs. flat-colored) */
export function setDisplayMode(mode: DisplayMode): void {
  state.displayMode = mode;
  emitter.notify({ kind: 'displayMode' });
}

/** Switch the range-fill shape. Resets the hollow setting back to the per-shape default */
export function setShape(shape: ShapeKind): void {
  if (state.shape === shape) return;
  state.shape = shape;
  state.shapeHollow = null;
  emitter.notify({ kind: 'shape' });
}

/** Toggle the hollow setting. Flips the current resolved value (including the default) */
export function toggleShapeHollow(): void {
  state.shapeHollow = !isShapeHollow();
  emitter.notify({ kind: 'shape' });
}

/** Whether to fill hollow right now. Falls back to the per-shape default (only the dome is hollow) if not explicitly set */
export function isShapeHollow(): boolean {
  return state.shapeHollow ?? defaultHollow(state.shape);
}

/** Switch the cylinder's axis */
export function setShapeAxis(axis: Axis): void {
  if (state.shapeAxis === axis) return;
  state.shapeAxis = axis;
  emitter.notify({ kind: 'shape' });
}

/** Set the slope's step height. Values below 1 or non-integers are rounded to 1 */
export function setShapeStep(step: number): void {
  const next = Number.isFinite(step) ? Math.max(1, Math.floor(step)) : 1;
  if (state.shapeStep === next) return;
  state.shapeStep = next;
  emitter.notify({ kind: 'shape' });
}

/** Screen theme */
export type Theme = 'light' | 'dark';

/** Theme preference. `system` = no explicit choice made (follows the OS) */
export type ThemePreference = Theme | 'system';

/**
 * Whether the OS wants dark mode.
 *
 * **Only used as the default when there's no saved choice.** Once the user has
 * switched even once, that choice wins — always following the OS would make it
 * impossible to express "I want the app dark/light regardless of the OS."
 */
export function prefersDarkTheme(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/** The appearance actually in use right now. Only consults the OS when set to `system` */
export function resolvedTheme(): Theme {
  if (state.themePreference !== 'system') return state.themePreference;
  return prefersDarkTheme() ? 'dark' : 'light';
}

export function setThemePreference(preference: ThemePreference): void {
  if (state.themePreference === preference) return;
  state.themePreference = preference;
  emitter.notify({ kind: 'theme' });
}

/**
 * Call this when the OS-level setting changes. **Does nothing if the user has made
 * an explicit choice.**
 *
 * Users who left it on `system` want to follow the OS, but the OS must never
 * override a choice the user made explicitly.
 */
export function notifySystemThemeChanged(): void {
  if (state.themePreference !== 'system') return;
  emitter.notify({ kind: 'theme' });
}

export function setLang(lang: Lang): void {
  if (state.lang === lang) return;
  state.lang = lang;
  emitter.notify({ kind: 'lang' });
}

/**
 * Resolve an error key returned by the editor layer in the current language.
 * Shaped so it can be passed straight through as the translate argument of `commitOpResult`.
 */
export function opError(key: OpErrorKey, vars?: Record<string, string | number>): string {
  return translateOpError(key, state.lang, vars);
}

/**
 * The **single entry point** that turns an exception into display text (raised in review).
 *
 * Through round 2, non-`DisplayableError` exceptions were shown using the raw
 * `e.message`. That missed a broken assumption: "throws are developer-facing so
 * they don't need translating" **breaks down right at the display boundary**. The
 * validation throws in `persistence.ts` (in Japanese) are caught and toasted by
 * `ProjectService`, so Japanese text was leaking onto the screen for English users.
 *
 * Chasing down every individual throw would mean re-auditing the whole call graph,
 * so instead **the boundary itself is closed off at the type level**: `fallback` is
 * now required, eliminating any path for a raw message to reach the user.
 * Developer-facing detail is still logged to console, so debuggability isn't lost.
 *
 * - `DisplayableError` → translate its key into the current language
 * - anything else → localize and return `fallback` (the raw message goes to console only)
 */
export function errorText(e: unknown, fallback: UiKey): string {
  if (e instanceof DisplayableError) return translate(e.key, state.lang, e.vars);
  console.error('[blocksmith] unhandled error surfaced to the user:', e);
  return translate(fallback, state.lang);
}

/** Resolve a UI label in the current language. **Call this on every render** (to follow language switches) */
export function t(key: UiKey, vars?: Record<string, string | number>): string {
  return translate(key, state.lang, vars);
}

/**
 * Resolve the default name for generated data. **Call this once, at creation time.**
 * Calling it again when rendering an already-stored name would corrupt past data's
 * name on a language switch.
 */
export function defaultName(key: DefaultNameKey, vars?: Record<string, string | number>): string {
  return resolveDefaultName(key, state.lang, vars);
}

/**
 * The single entry point that resolves a block's display name for the current
 * settings. If each UI read `def.nameJa` directly, every new switch would
 * leak into more call sites to update.
 */
export function blockName(def: { nameJa: string; nameEn: string }): string {
  return state.lang === 'ja' ? def.nameJa : def.nameEn;
}

/**
 * A subscription hook that only fires when the display language **actually
 * changes**.
 *
 * Most UI that shows names only subscribes to doc / selection changes; adding a
 * plain `onStateChange` subscription would re-render on every tool switch or
 * activeBlock change too (the layer tree is expensive). This lives in one place so
 * each UI doesn't have to write its own diff tracking.
 */
export function onLangChange(fn: () => void): Unsubscribe {
  let last = state.lang;
  return emitter.subscribe(() => {
    if (state.lang === last) return;
    last = state.lang;
    fn();
  });
}

/**
 * Match logic for block search. **Matches against both names regardless of
 * the display language.** Being able to search in Japanese while displaying in
 * English is practical, and the same goes the other way (OSS users searching in English).
 */
export function matchesBlockQuery(def: { nameJa: string; nameEn: string }, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase('ja');
  if (!needle) return true;
  return (
    def.nameJa.toLocaleLowerCase('ja').includes(needle) || def.nameEn.toLocaleLowerCase('en').includes(needle)
  );
}
