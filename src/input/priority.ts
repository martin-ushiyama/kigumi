/**
 * The single priority-order definition for keyboard shortcuts.
 * Evaluates matches() top to bottom; only the run() of the first entry to return true
 * is executed (no fallback to later entries or to camerakeys runs after that).
 *
 * The actual logic (undo/redo, grouping, nudge, etc.) is injected into run straight
 * from functions in each module (controls.ts / selecttool.ts / main.ts) — this file
 * only consolidates the key-matching conditions and their priority order in one place.
 */
export interface ShortcutContext {
  tool: () => string;
  hasSelection: () => boolean;
}

/**
 * Whether this shortcut may run while a pointer gesture (drag move / marquee / Fill
 * drag, etc.) is in progress. **Cannot be omitted** — this forces whoever adds a new
 * entry to make a deliberate call.
 *
 * If a `'block'` entry matches during a gesture, **the key is consumed without calling
 * run** (`preventDefault()` is called and the lookup is reported as successful).
 * Falling through would let it reach the browser's default action after camerakeys
 * ignores ctrl/meta, leaking things like Ctrl+D opening the bookmark UI mid-drag
 * (found in a second review pass).
 *
 * An entry that wants to yield to camera control even during a gesture returns false
 * itself from `matches` (nudge's `!hasActiveDrag()` is exactly that. Which key gets
 * yielded to whom is a judgment specific to each entry, so it isn't expressed as a
 * blanket policy).
 *
 * The deciding factor is whether the shortcut **mutates the Document**. Mutating the
 * Document during a gesture shifts the ground the in-progress preview is standing on,
 * and one of the two silently gets dropped at commit time (that's exactly what review
 * flagged: only the rotation got committed and the drag move was discarded).
 */
export type GesturePolicy = 'block' | 'allow';

export interface ShortcutEntry {
  /** An identifier for logging/review. If there's a conflict, note the reason here (e.g. 'g' vs 'ctrl+g') */
  id: string;
  /** Whether this is allowed during a gesture. Any Document-mutating operation must be 'block' */
  duringGesture: GesturePolicy;
  matches: (e: KeyboardEvent, ctx: ShortcutContext) => boolean;
  run: (e: KeyboardEvent, ctx: ShortcutContext) => void;
}

/**
 * Table lookup. Executes the first matching entry and returns true. Returns false if
 * nothing matches (falls back to camerakeys).
 *
 * If a `duringGesture: 'block'` entry matches while `gestureActive` is true, run is not
 * called; the key is **consumed** and true is returned instead (preventDefault already
 * called). If exclusion conditions had to be copied into each entry's matches
 * individually, forgetting it in a new entry would go unnoticed (that's exactly what
 * happened with the rotation) — so this rejects them all in one place instead.
 */
export function dispatchShortcut(
  entries: readonly ShortcutEntry[],
  e: KeyboardEvent,
  ctx: ShortcutContext,
  gestureActive: boolean,
): boolean {
  for (const entry of entries) {
    if (!entry.matches(e, ctx)) continue;
    if (gestureActive && entry.duringGesture === 'block') {
      // consume and stop: don't run run, later entries, camerakeys, or the browser's default action
      e.preventDefault();
      return true;
    }
    entry.run(e, ctx);
    return true;
  }
  return false;
}

/** Either ctrl or meta (supports both Mac/Win, following the existing codebase convention) */
export function isCtrlOrMeta(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey;
}
