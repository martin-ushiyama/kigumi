import { describe, expect, it, vi } from 'vitest';
import { dispatchShortcut, isCtrlOrMeta, type ShortcutContext, type ShortcutEntry } from '../src/input/priority';

function fakeEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: 'a',
    code: 'KeyA',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent;
}

const ctx: ShortcutContext = {
  tool: () => 'select',
  hasSelection: () => true,
};

describe('isCtrlOrMeta', () => {
  it('true even with only ctrlKey', () => {
    expect(isCtrlOrMeta(fakeEvent({ ctrlKey: true }))).toBe(true);
  });
  it('true even with only metaKey', () => {
    expect(isCtrlOrMeta(fakeEvent({ metaKey: true }))).toBe(true);
  });
  it('false when neither is set', () => {
    expect(isCtrlOrMeta(fakeEvent())).toBe(false);
  });
});

describe('dispatchShortcut', () => {
  it('runs only the first matching entry and returns true (array order = priority)', () => {
    const calls: string[] = [];
    const entries: ShortcutEntry[] = [
      { id: 'first', duringGesture: 'allow', matches: () => true, run: () => calls.push('first') },
      { id: 'second', duringGesture: 'allow', matches: () => true, run: () => calls.push('second') },
    ];
    const result = dispatchShortcut(entries, fakeEvent(), ctx, false);
    expect(result).toBe(true);
    expect(calls).toEqual(['first']);
  });

  it('returns false when no entry matches, and no run is called', () => {
    const run = vi.fn();
    const entries: ShortcutEntry[] = [{ id: 'never', duringGesture: 'allow', matches: () => false, run }];
    const result = dispatchShortcut(entries, fakeEvent(), ctx, false);
    expect(result).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('tries the next entry if the first does not match', () => {
    const calls: string[] = [];
    const entries: ShortcutEntry[] = [
      { id: 'skip', duringGesture: 'allow', matches: () => false, run: () => calls.push('skip') },
      { id: 'hit', duringGesture: 'allow', matches: () => true, run: () => calls.push('hit') },
    ];
    dispatchShortcut(entries, fakeEvent(), ctx, false);
    expect(calls).toEqual(['hit']);
  });

  it('matches can receive ctx (branches on tool/mode/hasSelection)', () => {
    const editCtx: ShortcutContext = { tool: () => 'place', hasSelection: () => false };
    const entries: ShortcutEntry[] = [
      { id: 'select-only', duringGesture: 'allow', matches: (_e, c) => c.tool() === 'select', run: vi.fn() },
    ];
    expect(dispatchShortcut(entries, fakeEvent(), editCtx, false)).toBe(false);
    expect(dispatchShortcut(entries, fakeEvent(), ctx, false)).toBe(true);
  });

  /**
   * A review finding: if a shortcut that changes the Document is allowed to run during a
   * gesture, the basis the in-progress preview relies on shifts, and one of them silently
   * disappears on commit. If the exclusion condition were copied into each entry's matches,
   * a missed one wouldn't be caught, so we reject it in bulk on the dispatch side instead.
   */
  describe('gestureActive', () => {
    function entriesFor(calls: string[]): ShortcutEntry[] {
      return [
        { id: 'edit', duringGesture: 'block', matches: (e) => e.key === 'a', run: () => calls.push('edit') },
        { id: 'view', duringGesture: 'allow', matches: () => true, run: () => calls.push('view') },
      ];
    }

    it("consumes the key without calling run when a 'block' entry matches during a gesture", () => {
      const calls: string[] = [];
      const preventDefault = vi.fn();
      expect(dispatchShortcut(entriesFor(calls), fakeEvent({ preventDefault }), ctx, true)).toBe(true);
      expect(calls).toEqual([]); // neither run nor any later entry runs
      expect(preventDefault).toHaveBeenCalledTimes(1); // also stops the browser default action (e.g. Ctrl+D)
    });

    it("runs a 'block' entry in priority order when not during a gesture", () => {
      const calls: string[] = [];
      const preventDefault = vi.fn();
      dispatchShortcut(entriesFor(calls), fakeEvent({ preventDefault }), ctx, false);
      expect(calls).toEqual(['edit']);
      expect(preventDefault).not.toHaveBeenCalled(); // preventDefault is the run side's responsibility
    });

    it("passes through to later entries during a gesture if the 'block' entry does not match", () => {
      const calls: string[] = [];
      dispatchShortcut(entriesFor(calls), fakeEvent({ key: 'b' }), ctx, true);
      expect(calls).toEqual(['view']); // the block entry's matches is false -> 'view' picks it up
    });

    it("an 'allow' entry still runs even during a gesture", () => {
      const run = vi.fn();
      const entries: ShortcutEntry[] = [{ id: 'view', duringGesture: 'allow', matches: () => true, run }];
      expect(dispatchShortcut(entries, fakeEvent(), ctx, true)).toBe(true);
      expect(run).toHaveBeenCalledTimes(1);
    });
  });
});
