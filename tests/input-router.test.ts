import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { createInputRouter, type CameraKeyBridge } from '../src/input/router';
import type { ShortcutContext, ShortcutEntry } from '../src/input/priority';

// for isTypingTarget's (via typing.ts) instanceof checks; same approach as tests/input-typing.test.ts
class FakeInputElement {}
class FakeTextAreaElement {}
class FakeHTMLElement {
  isContentEditable = false;
}

let prevInput: unknown;
let prevTextArea: unknown;
let prevHtmlElement: unknown;
beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  prevInput = g.HTMLInputElement;
  prevTextArea = g.HTMLTextAreaElement;
  prevHtmlElement = g.HTMLElement;
  g.HTMLInputElement = FakeInputElement;
  g.HTMLTextAreaElement = FakeTextAreaElement;
  g.HTMLElement = FakeHTMLElement;
});
afterAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = prevInput;
  g.HTMLTextAreaElement = prevTextArea;
  g.HTMLElement = prevHtmlElement;
});

/** A stub mimicking window.addEventListener. Keeps handlers so the test can invoke them directly */
function createFakeTarget() {
  const listeners: Record<string, EventListener[]> = {};
  return {
    addEventListener: (type: string, listener: EventListener) => {
      (listeners[type] ??= []).push(listener);
    },
    fire: (type: string, event: unknown) => {
      for (const l of listeners[type] ?? []) l(event as Event);
    },
  };
}

/** A stub for canvas.addEventListener + setPointerCapture/releasePointerCapture (assumes capture calls always succeed) */
function createFakeCanvas() {
  return { ...createFakeTarget(), setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() };
}

function fakePointerEvent(overrides: Partial<PointerEvent> = {}): PointerEvent {
  return {
    pointerId: 1,
    button: 0,
    buttons: 1,
    clientX: 0,
    clientY: 0,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as PointerEvent;
}

function fakeKeyEvent(overrides: Partial<KeyboardEvent> = {}, targetIsInput = false): KeyboardEvent {
  return {
    key: 'a',
    code: 'KeyA',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: targetIsInput ? new FakeInputElement() : null,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent;
}

const ctx: ShortcutContext = { tool: () => 'select', hasSelection: () => true };

function makeCameraKeys(): CameraKeyBridge {
  return {
    onKeyDown: vi.fn<(e: KeyboardEvent) => void>(),
    onKeyUp: vi.fn<(e: KeyboardEvent) => void>(),
    onBlur: vi.fn<() => void>(),
  };
}

describe('createInputRouter', () => {
  it('attach() registers keydown/keyup/blur + a pointerup fallback on target', () => {
    const target = createFakeTarget();
    const addSpy = vi.spyOn(target, 'addEventListener');
    const router = createInputRouter({ target, canvas: createFakeCanvas(), shortcuts: [], ctx, cameraKeys: makeCameraKeys(), escapeHandlers: [] });
    router.attach();
    const types = addSpy.mock.calls.map((c) => c[0]);
    // pointerup is the fallback for when canvas capture is unavailable (#12 PR2), carried over from the old implementation's window pointerup registration
    expect(types).toEqual(['keydown', 'keyup', 'blur', 'pointerup']);
  });

  it('attach() registers pointer events + contextmenu on canvas', () => {
    const canvas = createFakeCanvas();
    const addSpy = vi.spyOn(canvas, 'addEventListener');
    const router = createInputRouter({ target: createFakeTarget(), canvas, shortcuts: [], ctx, cameraKeys: makeCameraKeys(), escapeHandlers: [] });
    router.attach();
    const types = addSpy.mock.calls.map((c) => c[0]);
    expect(types).toEqual([
      'pointerdown',
      'pointermove',
      'pointerup',
      'pointercancel',
      'lostpointercapture',
      'pointerleave',
      'contextmenu',
    ]);
  });

  it('neither shortcuts nor camerakeys are called for a typing target', () => {
    const target = createFakeTarget();
    const cameraKeys = makeCameraKeys();
    const run = vi.fn();
    const shortcuts: ShortcutEntry[] = [{ id: 'always', duringGesture: 'allow', matches: () => true, run }];
    const router = createInputRouter({ target, canvas: createFakeCanvas(), shortcuts, ctx, cameraKeys, escapeHandlers: [] });
    router.attach();
    target.fire('keydown', fakeKeyEvent({}, true));
    expect(run).not.toHaveBeenCalled();
    expect(cameraKeys.onKeyDown).not.toHaveBeenCalled();
  });

  it('Escape calls every escapeHandler and does not pass through to shortcuts/camerakeys (broadcast, not first-match)', () => {
    const target = createFakeTarget();
    const cameraKeys = makeCameraKeys();
    const run = vi.fn();
    const shortcuts: ShortcutEntry[] = [{ id: 'escape-shortcut', duringGesture: 'allow', matches: (e) => e.key === 'Escape', run }];
    const h1 = vi.fn();
    const h2 = vi.fn();
    const router = createInputRouter({ target, canvas: createFakeCanvas(), shortcuts, ctx, cameraKeys, escapeHandlers: [h1, h2] });
    router.attach();
    target.fire('keydown', fakeKeyEvent({ key: 'Escape' }));
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(cameraKeys.onKeyDown).not.toHaveBeenCalled();
  });

  it('runs when a shortcut matches, and does not fall through to camerakeys', () => {
    const target = createFakeTarget();
    const cameraKeys = makeCameraKeys();
    const run = vi.fn();
    const shortcuts: ShortcutEntry[] = [{ id: 'hit', duringGesture: 'allow', matches: () => true, run }];
    const router = createInputRouter({ target, canvas: createFakeCanvas(), shortcuts, ctx, cameraKeys, escapeHandlers: [] });
    router.attach();
    target.fire('keydown', fakeKeyEvent());
    expect(run).toHaveBeenCalledTimes(1);
    expect(cameraKeys.onKeyDown).not.toHaveBeenCalled();
  });

  it('falls back to camerakeys.onKeyDown when no shortcut matches', () => {
    const target = createFakeTarget();
    const cameraKeys = makeCameraKeys();
    const shortcuts: ShortcutEntry[] = [{ id: 'never', duringGesture: 'allow', matches: () => false, run: vi.fn() }];
    const router = createInputRouter({ target, canvas: createFakeCanvas(), shortcuts, ctx, cameraKeys, escapeHandlers: [] });
    router.attach();
    const e = fakeKeyEvent();
    target.fire('keydown', e);
    expect(cameraKeys.onKeyDown).toHaveBeenCalledWith(e);
  });

  it('keyup is always forwarded to camerakeys.onKeyUp', () => {
    const target = createFakeTarget();
    const cameraKeys = makeCameraKeys();
    const router = createInputRouter({ target, canvas: createFakeCanvas(), shortcuts: [], ctx, cameraKeys, escapeHandlers: [] });
    router.attach();
    const e = fakeKeyEvent({ key: 'w' });
    target.fire('keyup', e);
    expect(cameraKeys.onKeyUp).toHaveBeenCalledWith(e);
  });

  it('blur calls camerakeys.onBlur (does not call escapeHandlers, a separate path from Escape)', () => {
    const target = createFakeTarget();
    const cameraKeys = makeCameraKeys();
    const h1 = vi.fn();
    const router = createInputRouter({ target, canvas: createFakeCanvas(), shortcuts: [], ctx, cameraKeys, escapeHandlers: [h1] });
    router.attach();
    target.fire('blur', new Event('blur'));
    expect(cameraKeys.onBlur).toHaveBeenCalledTimes(1);
    expect(h1).not.toHaveBeenCalled();
  });

  // #12 PR2: pointer route priority + the claim lifecycle
  describe('pointer routes', () => {
    it('array order = priority. Only the first route to return claim/handled processes it; nothing after is tried', () => {
      const canvas = createFakeCanvas();
      const secondOnPointerDown = vi.fn();
      const router = createInputRouter({
        target: createFakeTarget(),
        canvas,
        shortcuts: [],
        ctx,
        cameraKeys: makeCameraKeys(),
        escapeHandlers: [],
        pointerRoutes: [
          { id: 'first', onPointerDown: () => 'handled' },
          { id: 'second', onPointerDown: secondOnPointerDown },
        ],
      });
      router.attach();
      canvas.fire('pointerdown', fakePointerEvent());
      expect(secondOnPointerDown).not.toHaveBeenCalled();
    });

    it('a route that returns null falls through to the next route', () => {
      const canvas = createFakeCanvas();
      const run = vi.fn();
      const router = createInputRouter({
        target: createFakeTarget(),
        canvas,
        shortcuts: [],
        ctx,
        cameraKeys: makeCameraKeys(),
        escapeHandlers: [],
        pointerRoutes: [
          { id: 'skip', onPointerDown: () => null },
          { id: 'hit', onPointerDown: () => (run(), 'handled') },
        ],
      });
      router.attach();
      canvas.fire('pointerdown', fakePointerEvent());
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('once a claim is established, setPointerCapture is called and subsequent moves with the same pointerId reach claim.onMove', () => {
      const canvas = createFakeCanvas();
      const onMove = vi.fn();
      const router = createInputRouter({
        target: createFakeTarget(),
        canvas,
        shortcuts: [],
        ctx,
        cameraKeys: makeCameraKeys(),
        escapeHandlers: [],
        pointerRoutes: [{ id: 'drag', onPointerDown: () => ({ onMove, onUp: () => 'commit', onCancel: () => {} }) }],
      });
      router.attach();
      canvas.fire('pointerdown', fakePointerEvent({ pointerId: 7 }));
      expect(canvas.setPointerCapture).toHaveBeenCalledWith(7);
      const moveEvent = fakePointerEvent({ pointerId: 7, clientX: 10 });
      canvas.fire('pointermove', moveEvent);
      expect(onMove).toHaveBeenCalledWith(moveEvent);
    });

    /**
     * #41 review P1: allowing a shortcut that changes the Document through during an
     * in-progress gesture shifts the basis for the preview, and one of them silently
     * disappears on commit. The judgment is based on activeClaim, which only the router
     * holds, so this pins down the wiring here.
     */
    it("during a claim, duringGesture: 'block' calls neither run nor camerakeys, and consumes the input", () => {
      const canvas = createFakeCanvas();
      const target = createFakeTarget();
      const cameraKeys = makeCameraKeys();
      const blocked = vi.fn();
      const router = createInputRouter({
        target,
        canvas,
        shortcuts: [{ id: 'edit', duringGesture: 'block', matches: () => true, run: blocked }],
        ctx,
        cameraKeys,
        escapeHandlers: [],
        pointerRoutes: [{ id: 'drag', onPointerDown: () => ({ onMove: vi.fn(), onUp: () => 'commit', onCancel: () => {} }) }],
      });
      router.attach();

      target.fire('keydown', fakeKeyEvent());
      expect(blocked).toHaveBeenCalledTimes(1); // passes through before there's a claim

      canvas.fire('pointerdown', fakePointerEvent({ pointerId: 3 }));
      const preventDefault = vi.fn();
      target.fire('keydown', fakeKeyEvent({ preventDefault }));
      expect(blocked).toHaveBeenCalledTimes(1); // the app-side handler does not run
      expect(cameraKeys.onKeyDown).not.toHaveBeenCalled(); // does not leak through to the camera either
      // also stops the browser default action (e.g. Ctrl+D bookmark UI mid-drag)
      expect(preventDefault).toHaveBeenCalledTimes(1);

      canvas.fire('pointerup', fakePointerEvent({ pointerId: 3, buttons: 0 }));
      target.fire('keydown', fakeKeyEvent());
      expect(blocked).toHaveBeenCalledTimes(2); // restored once the claim ends
    });

    it("during a claim, an 'allow' duringGesture shortcut still runs", () => {
      const canvas = createFakeCanvas();
      const target = createFakeTarget();
      const allowed = vi.fn();
      const router = createInputRouter({
        target,
        canvas,
        shortcuts: [{ id: 'view', duringGesture: 'allow', matches: () => true, run: allowed }],
        ctx,
        cameraKeys: makeCameraKeys(),
        escapeHandlers: [],
        pointerRoutes: [{ id: 'drag', onPointerDown: () => ({ onMove: vi.fn(), onUp: () => 'commit', onCancel: () => {} }) }],
      });
      router.attach();
      canvas.fire('pointerdown', fakePointerEvent({ pointerId: 3 }));
      target.fire('keydown', fakeKeyEvent());
      expect(allowed).toHaveBeenCalledTimes(1);
    });

    it("falls back to camerakeys during a claim if the 'block' entry does not match (arrow-key camera movement mid-drag)", () => {
      const canvas = createFakeCanvas();
      const target = createFakeTarget();
      const cameraKeys = makeCameraKeys();
      const router = createInputRouter({
        target,
        canvas,
        shortcuts: [{ id: 'edit', duringGesture: 'block', matches: (e) => e.key === 'x', run: vi.fn() }],
        ctx,
        cameraKeys,
        escapeHandlers: [],
        pointerRoutes: [{ id: 'drag', onPointerDown: () => ({ onMove: vi.fn(), onUp: () => 'commit', onCancel: () => {} }) }],
      });
      router.attach();
      canvas.fire('pointerdown', fakePointerEvent({ pointerId: 3 }));
      const preventDefault = vi.fn();
      const e = fakeKeyEvent({ key: 'ArrowRight', preventDefault });
      target.fire('keydown', e);
      expect(cameraKeys.onKeyDown).toHaveBeenCalledWith(e);
      expect(preventDefault).not.toHaveBeenCalled();
    });

    it('ignores a new pointerdown during a claim (route: active-gesture)', () => {
      const canvas = createFakeCanvas();
      const secondDown = vi.fn();
      const router = createInputRouter({
        target: createFakeTarget(),
        canvas,
        shortcuts: [],
        ctx,
        cameraKeys: makeCameraKeys(),
        escapeHandlers: [],
        pointerRoutes: [
          { id: 'first', onPointerDown: () => ({ onMove: () => {}, onUp: () => 'commit', onCancel: () => {} }) },
          { id: 'second', onPointerDown: secondDown },
        ],
      });
      router.attach();
      canvas.fire('pointerdown', fakePointerEvent({ pointerId: 1 }));
      canvas.fire('pointerdown', fakePointerEvent({ pointerId: 2 })); // still ignored even with a different pointerId
      expect(secondDown).not.toHaveBeenCalled();
    });

    it('pointerup calls claim.onUp, and returning commit ends the claim and releases capture', () => {
      const canvas = createFakeCanvas();
      const onUp = vi.fn().mockReturnValue('commit');
      const router = createInputRouter({
        target: createFakeTarget(),
        canvas,
        shortcuts: [],
        ctx,
        cameraKeys: makeCameraKeys(),
        escapeHandlers: [],
        pointerRoutes: [{ id: 'drag', onPointerDown: () => ({ onMove: () => {}, onUp, onCancel: () => {} }) }],
      });
      router.attach();
      canvas.fire('pointerdown', fakePointerEvent({ pointerId: 3 }));
      const upEvent = fakePointerEvent({ pointerId: 3, button: 0 });
      canvas.fire('pointerup', upEvent);
      expect(onUp).toHaveBeenCalledWith(upEvent);
      expect(canvas.releasePointerCapture).toHaveBeenCalledWith(3);
      expect(router.hasActiveClaim()).toBe(false);
    });

    it("the claim continues if onUp returns 'ignore' (equivalent to the old implementation's button!==0 check)", () => {
      const canvas = createFakeCanvas();
      const onUp = vi.fn().mockReturnValue('ignore');
      const router = createInputRouter({
        target: createFakeTarget(),
        canvas,
        shortcuts: [],
        ctx,
        cameraKeys: makeCameraKeys(),
        escapeHandlers: [],
        pointerRoutes: [{ id: 'drag', onPointerDown: () => ({ onMove: () => {}, onUp, onCancel: () => {} }) }],
      });
      router.attach();
      canvas.fire('pointerdown', fakePointerEvent({ pointerId: 3 }));
      canvas.fire('pointerup', fakePointerEvent({ pointerId: 3, button: 2 }));
      expect(router.hasActiveClaim()).toBe(true);
      expect(canvas.releasePointerCapture).not.toHaveBeenCalled();
    });

    it('pointercancel calls claim.onCancel with reason pointercancel', () => {
      const canvas = createFakeCanvas();
      const onCancel = vi.fn();
      const router = createInputRouter({
        target: createFakeTarget(),
        canvas,
        shortcuts: [],
        ctx,
        cameraKeys: makeCameraKeys(),
        escapeHandlers: [],
        pointerRoutes: [{ id: 'drag', onPointerDown: () => ({ onMove: () => {}, onUp: () => 'commit', onCancel }) }],
      });
      router.attach();
      canvas.fire('pointerdown', fakePointerEvent({ pointerId: 4 }));
      canvas.fire('pointercancel', fakePointerEvent({ pointerId: 4 }));
      expect(onCancel).toHaveBeenCalledWith('pointercancel');
      expect(router.hasActiveClaim()).toBe(false);
    });

    it('lostpointercapture calls claim.onCancel with reason lostpointercapture', () => {
      const canvas = createFakeCanvas();
      const onCancel = vi.fn();
      const router = createInputRouter({
        target: createFakeTarget(),
        canvas,
        shortcuts: [],
        ctx,
        cameraKeys: makeCameraKeys(),
        escapeHandlers: [],
        pointerRoutes: [{ id: 'drag', onPointerDown: () => ({ onMove: () => {}, onUp: () => 'commit', onCancel }) }],
      });
      router.attach();
      canvas.fire('pointerdown', fakePointerEvent({ pointerId: 5 }));
      canvas.fire('lostpointercapture', fakePointerEvent({ pointerId: 5 }));
      expect(onCancel).toHaveBeenCalledWith('lostpointercapture');
    });

    it('window blur calls claim.onCancel with reason blur (and camerakeys.onBlur is also called)', () => {
      const canvas = createFakeCanvas();
      const target = createFakeTarget();
      const cameraKeys = makeCameraKeys();
      const onCancel = vi.fn();
      const router = createInputRouter({
        target,
        canvas,
        shortcuts: [],
        ctx,
        cameraKeys,
        escapeHandlers: [],
        pointerRoutes: [{ id: 'drag', onPointerDown: () => ({ onMove: () => {}, onUp: () => 'commit', onCancel }) }],
      });
      router.attach();
      canvas.fire('pointerdown', fakePointerEvent({ pointerId: 6 }));
      target.fire('blur', new Event('blur'));
      expect(onCancel).toHaveBeenCalledWith('blur');
      expect(cameraKeys.onBlur).toHaveBeenCalledTimes(1);
    });

    it('Escape (keydown) calls claim.onCancel with reason escape, then also calls escapeHandlers', () => {
      const canvas = createFakeCanvas();
      const target = createFakeTarget();
      const onCancel = vi.fn();
      const h1 = vi.fn();
      const router = createInputRouter({
        target,
        canvas,
        shortcuts: [],
        ctx,
        cameraKeys: makeCameraKeys(),
        escapeHandlers: [h1],
        pointerRoutes: [{ id: 'drag', onPointerDown: () => ({ onMove: () => {}, onUp: () => 'commit', onCancel }) }],
      });
      router.attach();
      canvas.fire('pointerdown', fakePointerEvent({ pointerId: 8 }));
      target.fire('keydown', fakeKeyEvent({ key: 'Escape' }));
      expect(onCancel).toHaveBeenCalledWith('escape');
      expect(h1).toHaveBeenCalledTimes(1);
    });

    it('pointermove calls onHoverMove on every route regardless of whether a claim is active', () => {
      const canvas = createFakeCanvas();
      const hover1 = vi.fn();
      const hover2 = vi.fn();
      const router = createInputRouter({
        target: createFakeTarget(),
        canvas,
        shortcuts: [],
        ctx,
        cameraKeys: makeCameraKeys(),
        escapeHandlers: [],
        pointerRoutes: [
          { id: 'a', onPointerDown: () => null, onHoverMove: hover1 },
          { id: 'b', onPointerDown: () => null, onHoverMove: hover2 },
        ],
      });
      router.attach();
      const e = fakePointerEvent();
      canvas.fire('pointermove', e);
      expect(hover1).toHaveBeenCalledWith(e);
      expect(hover2).toHaveBeenCalledWith(e);
    });

    it('pointerleave calls onPointerLeave on every route', () => {
      const canvas = createFakeCanvas();
      const leave = vi.fn();
      const router = createInputRouter({
        target: createFakeTarget(),
        canvas,
        shortcuts: [],
        ctx,
        cameraKeys: makeCameraKeys(),
        escapeHandlers: [],
        pointerRoutes: [{ id: 'a', onPointerDown: () => null, onPointerLeave: leave }],
      });
      router.attach();
      canvas.fire('pointerleave', new Event('pointerleave'));
      expect(leave).toHaveBeenCalledTimes(1);
    });

    it('window pointerup terminates the same claim, as the fallback for when canvas capture is unavailable', () => {
      const canvas = createFakeCanvas();
      const target = createFakeTarget();
      const onUp = vi.fn().mockReturnValue('commit');
      const router = createInputRouter({
        target,
        canvas,
        shortcuts: [],
        ctx,
        cameraKeys: makeCameraKeys(),
        escapeHandlers: [],
        pointerRoutes: [{ id: 'drag', onPointerDown: () => ({ onMove: () => {}, onUp, onCancel: () => {} }) }],
      });
      router.attach();
      canvas.fire('pointerdown', fakePointerEvent({ pointerId: 10 }));
      target.fire('pointerup', fakePointerEvent({ pointerId: 10 }));
      expect(onUp).toHaveBeenCalledTimes(1);
    });
  });
});
