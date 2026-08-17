import { describe, expect, it, vi } from 'vitest';
import { createEmitter } from '../src/core/emitter';

describe('createEmitter', () => {
  it('a subscribed listener is called by notify (with the payload passed through)', () => {
    const emitter = createEmitter<{ kind: 'x'; n: number }>();
    const fn = vi.fn();
    emitter.subscribe(fn);
    emitter.notify({ kind: 'x', n: 42 });
    expect(fn).toHaveBeenCalledWith({ kind: 'x', n: 42 });
  });

  it('can subscribe multiple listeners, each called once per notify', () => {
    const emitter = createEmitter<{ kind: 'x' }>();
    const a = vi.fn();
    const b = vi.fn();
    emitter.subscribe(a);
    emitter.subscribe(b);
    emitter.notify({ kind: 'x' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('calling the unsubscribe returned by subscribe stops it from being called by future notify calls', () => {
    const emitter = createEmitter<{ kind: 'x' }>();
    const fn = vi.fn();
    const unsubscribe = emitter.subscribe(fn);
    emitter.notify({ kind: 'x' });
    unsubscribe();
    emitter.notify({ kind: 'x' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe only removes its own listener (other listeners are unaffected)', () => {
    const emitter = createEmitter<{ kind: 'x' }>();
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = emitter.subscribe(a);
    emitter.subscribe(b);
    unsubA();
    emitter.notify({ kind: 'x' });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('calling unsubscribe multiple times does not throw (idempotent)', () => {
    const emitter = createEmitter<{ kind: 'x' }>();
    const unsubscribe = emitter.subscribe(() => {});
    expect(() => {
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
  });

  it('subscribing the same listener multiple times collapses to one entry (Set-backed), so notify calls it only once', () => {
    const emitter = createEmitter<{ kind: 'x' }>();
    const fn = vi.fn();
    emitter.subscribe(fn);
    emitter.subscribe(fn);
    emitter.notify({ kind: 'x' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('if one listener throws, other listeners are still called, and notify itself does not propagate the throw to the caller (safety at the source)', () => {
    const emitter = createEmitter<{ kind: 'x' }>();
    const after = vi.fn();
    emitter.subscribe(() => {
      throw new Error('boom');
    });
    emitter.subscribe(after);
    expect(() => emitter.notify({ kind: 'x' })).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('does not depend on listener registration order (a listener added later is still called by the same notify)', () => {
    const emitter = createEmitter<{ kind: 'x' }>();
    const calledOrder: string[] = [];
    emitter.subscribe(() => calledOrder.push('a'));
    emitter.subscribe(() => calledOrder.push('b'));
    emitter.notify({ kind: 'x' });
    expect(calledOrder.sort()).toEqual(['a', 'b']);
  });

  it('self-unsubscribing then re-subscribing during notify does not cause double delivery within the same notify (a review regression)', () => {
    const emitter = createEmitter<{ kind: 'x' }>();
    const fn = vi.fn();
    let hasResubscribed = false;
    let unsubscribe: () => void;
    const selfResub = () => {
      fn();
      // re-subscribes itself exactly once (guards against an infinite loop even with a buggy
      // live-Set implementation; the goal is to verify "how many times is it called within
      // this notify," not to reproduce infinite re-entry)
      if (!hasResubscribed) {
        hasResubscribed = true;
        unsubscribe();
        unsubscribe = emitter.subscribe(selfResub);
      }
    };
    unsubscribe = emitter.subscribe(selfResub);
    emitter.notify({ kind: 'x' });
    expect(fn).toHaveBeenCalledTimes(1); // only once within this notify; the resubscription takes effect starting from the next notify
  });

  it('unsubscribing another listener during notify still calls that listener within this notify, regardless of registration order (a review regression)', () => {
    const emitterAB = createEmitter<{ kind: 'x' }>();
    const bAB = vi.fn();
    const boxAB: { unsubB: () => void } = { unsubB: () => {} };
    emitterAB.subscribe(() => boxAB.unsubB()); // A: unsubscribes B (registration order A -> B)
    boxAB.unsubB = emitterAB.subscribe(bAB);
    emitterAB.notify({ kind: 'x' });
    expect(bAB).toHaveBeenCalledTimes(1); // unaffected by the unsubscribe within this notify

    const emitterBA = createEmitter<{ kind: 'x' }>();
    const bBA = vi.fn();
    const boxBA: { unsubB: () => void } = { unsubB: emitterBA.subscribe(bBA) }; // registration order B -> A (B registered first)
    emitterBA.subscribe(() => boxBA.unsubB());
    emitterBA.notify({ kind: 'x' });
    expect(bBA).toHaveBeenCalledTimes(1); // the result is unchanged even with registration order swapped

    // the unsubscribe takes effect starting from the next notify
    emitterAB.notify({ kind: 'x' });
    expect(bAB).toHaveBeenCalledTimes(1); // not called on the second round onward (stays at a total of 1)
  });
});
