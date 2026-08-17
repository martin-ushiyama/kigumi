import { isTypingTarget } from './typing';
import { dispatchShortcut, type ShortcutContext, type ShortcutEntry } from './priority';

/** Minimal interface for telling something "clear your pending state" on Escape */
export type EscapeHandler = () => void;

export interface CameraKeyBridge {
  onKeyDown: (e: KeyboardEvent) => void;
  onKeyUp: (e: KeyboardEvent) => void;
  onBlur: () => void;
}

/** The reason a claim was terminated. Passed to onCancel (explicit labels for every commit=false path from the original implementation) */
export type CancelReason = 'pointercancel' | 'lostpointercapture' | 'blur' | 'escape';

/**
 * The contract for telling the router "I'll handle this gesture" on pointerdown.
 * If onUp returns 'ignore' (e.g. a button other than the left one was released), the
 * claim continues (serves the same role as the old `if (e.button !== 0 ...) return` in
 * controls.ts).
 */
export interface GestureClaim {
  onMove: (e: PointerEvent) => void;
  onUp: (e: PointerEvent) => 'commit' | 'ignore';
  onCancel: (reason: CancelReason) => void;
}

/**
 * A single entry in the pointer-side route table. Priority is exactly the order of the
 * array passed when the router is built (POINTER_ROUTES from the #12 plan). If
 * onPointerDown returns null, it falls through to the next route; 'handled' consumes
 * the event without creating a claim; returning a GestureClaim makes the router capture
 * the pointer and dedicate all further events with that pointerId to it.
 */
export interface PointerRouteHandler {
  id: string;
  onPointerDown: (e: PointerEvent) => GestureClaim | 'handled' | null;
  /** Called on every pointermove regardless of whether a claim exists (for tracking ghost/highlight/activePane) */
  onHoverMove?: (e: PointerEvent) => void;
  /** Called when the pointer leaves the canvas (hides ghost/highlight, etc.) */
  onPointerLeave?: () => void;
}


export interface InputRouterOpts {
  /** Where keyboard/blur listeners are registered. Tests can pass an EventTarget-compatible stub */
  target: Pick<Window, 'addEventListener'>;
  /** Where pointer/wheel listeners are registered */
  canvas: Pick<HTMLElement, 'addEventListener' | 'setPointerCapture' | 'releasePointerCapture'>;
  shortcuts: readonly ShortcutEntry[];
  ctx: ShortcutContext;
  cameraKeys: CameraKeyBridge;
  /**
   * The handlers called on Escape.
   * All of them are called, with no priority order — this keeps the old behavior
   * (where each module independently listened for window keydown / a synthetic Escape
   * event and self-judged) of "multiple things can react at once," as an explicit
   * broadcast.
   */
  escapeHandlers: readonly EscapeHandler[];
  /** Prioritized routes for pointerdown (#12 PR2). Array order = priority */
  pointerRoutes?: readonly PointerRouteHandler[];
}

export interface InputRouter {
  /** Registers keydown/keyup/blur/pointer/wheel listeners on window/canvas (called exactly once, from main.ts) */
  attach: () => void;
  /** Whether a pointer gesture is in progress (usable as a substitute for isDragging-style flags) */
  hasActiveClaim: () => boolean;
}

/**
 * The single receiving point for keyboard + pointer input (#12 PR1 keyboard / PR2 pointer).
 *
 * keyboard: (1) typing/modal check -> (2) Escape broadcast -> (3) SHORTCUTS table lookup -> (4) camerakeys fallback
 * pointer: evaluates pointerRoutes in order; once a claim is established, it owns all
 * further events with that pointerId.
 *
 * selecttool.ts was also folded into this router in #12 PR3 (the edit-tools route
 * returns null while state.tool === 'select', yielding to the select-tool route to
 * preserve the exclusive relationship). Direct listener registration on canvas/window
 * has been removed from both controls.ts and selecttool.ts — this router is now the
 * sole receiving point.
 */
export function createInputRouter(opts: InputRouterOpts): InputRouter {
  const { target, canvas, shortcuts, ctx, cameraKeys, escapeHandlers, pointerRoutes = [] } = opts;

  let activeClaim: { claim: GestureClaim; pointerId: number } | null = null;

  function broadcastCancel(reason: CancelReason): void {
    endActiveClaim(reason);
    for (const handler of escapeHandlers) handler();
  }

  function escape(): void {
    broadcastCancel('escape');
  }

  function endActiveClaim(reason: CancelReason): void {
    if (!activeClaim) return;
    const { claim, pointerId } = activeClaim;
    activeClaim = null; // clear before releasing capture (prevents double-termination via lostpointercapture etc.)
    try {
      canvas.releasePointerCapture(pointerId);
    } catch {
      // ignore if capture wasn't held / was already lost (synthetic events, test environments, etc.)
    }
    claim.onCancel(reason);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (isTypingTarget(e.target)) return;
    if (e.key === 'Escape') {
      escape();
      return;
    }
    // Only the router knows whether a gesture is in progress (activeClaim).
    // The check "don't let a Document-mutating shortcut through during a gesture" is done in this one place.
    if (dispatchShortcut(shortcuts, e, ctx, activeClaim !== null)) return;
    cameraKeys.onKeyDown(e);
  }

  function onKeyUp(e: KeyboardEvent): void {
    cameraKeys.onKeyUp(e);
  }

  function onWindowBlur(): void {
    cameraKeys.onBlur();
    endActiveClaim('blur');
  }

  function onPointerDown(e: PointerEvent): void {
    if (activeClaim) return; // ignore new pointerdowns while a gesture is in progress (route: active-gesture)
    for (const route of pointerRoutes) {
      const result = route.onPointerDown(e);
      if (result === null) continue;
      if (result === 'handled') return;
      activeClaim = { claim: result, pointerId: e.pointerId };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // even in an environment where capture isn't possible, it still terminates via pointerup (window fallback) / blur
      }
      return;
    }
  }

  function onPointerMove(e: PointerEvent): void {
    for (const route of pointerRoutes) route.onHoverMove?.(e);
    if (activeClaim && activeClaim.pointerId === e.pointerId) activeClaim.claim.onMove(e);
  }

  function finishPointerUp(e: PointerEvent): void {
    if (!activeClaim || activeClaim.pointerId !== e.pointerId) return;
    const outcome = activeClaim.claim.onUp(e);
    if (outcome === 'ignore') return; // claim continues (e.g. a button other than the left one was released)
    activeClaim = null;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // already released / unsupported environment
    }
  }

  function onPointerCancel(e: PointerEvent): void {
    if (activeClaim && activeClaim.pointerId === e.pointerId) endActiveClaim('pointercancel');
  }

  function onLostPointerCapture(e: PointerEvent): void {
    if (activeClaim && activeClaim.pointerId === e.pointerId) endActiveClaim('lostpointercapture');
  }

  function onPointerLeave(): void {
    for (const route of pointerRoutes) route.onPointerLeave?.();
  }

  function onContextMenu(e: Event): void {
    e.preventDefault(); // don't interfere with right-drag rotation (OrbitControls)
  }

  function attach(): void {
    target.addEventListener('keydown', onKeyDown as EventListener);
    target.addEventListener('keyup', onKeyUp as EventListener);
    target.addEventListener('blur', onWindowBlur);

    canvas.addEventListener('pointerdown', onPointerDown as EventListener);
    canvas.addEventListener('pointermove', onPointerMove as EventListener);
    canvas.addEventListener('pointerup', finishPointerUp as EventListener);
    canvas.addEventListener('pointercancel', onPointerCancel as EventListener);
    canvas.addEventListener('lostpointercapture', onLostPointerCapture as EventListener);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('contextmenu', onContextMenu);
    // A fallback in case capture didn't take effect (release outside the window, etc.).
    // Register the same finishPointerUp on window too, and rely on pointerId matching
    // to avoid mis-terminating an unrelated operation (same double registration as the
    // original implementation)
    target.addEventListener('pointerup', finishPointerUp as EventListener);
  }

  return { attach, hasActiveClaim: () => activeClaim !== null };
}
