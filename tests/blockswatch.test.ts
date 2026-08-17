import { beforeEach, describe, expect, it } from 'vitest';
import { CATALOG } from '../src/data/blocks';
import { setActiveBlock, setSpareBlock, state, swapActiveAndSpare } from '../src/state';

/**
 * State transitions for the active / spare block.
 *
 * The screen side (press swatch -> picker -> apply) is covered by e2e (`e2e/block-swatch.spec.ts`).
 * The main purpose here is to pin down **that swapping goes through setActiveBlock** —
 * a plain assignment would slip past both the orientation reset and the "recently used history".
 */
describe('swapping the active / spare block', () => {
  const stairsIndex = CATALOG.findIndex((b) => b.shape === 'stairs');
  const fullIndex = CATALOG.findIndex((b) => b.shape === 'full');

  beforeEach(() => {
    setActiveBlock(0);
    setSpareBlock(2);
    state.recentBlocks = [];
  });

  it('the default on startup has active and spare pointing to different blocks (never leaves spare "empty")', () => {
    expect(state.activeBlock).not.toBe(state.spareBlock);
    expect(CATALOG[state.spareBlock]).toBeDefined();
  });

  it('swapping exchanges active and spare', () => {
    setActiveBlock(fullIndex);
    setSpareBlock(stairsIndex);

    swapActiveAndSpare();

    expect(state.activeBlock).toBe(stairsIndex);
    expect(state.spareBlock).toBe(fullIndex);
  });

  it('swapping twice returns to the original', () => {
    setActiveBlock(fullIndex);
    setSpareBlock(stairsIndex);

    swapActiveAndSpare();
    swapActiveAndSpare();

    expect(state.activeBlock).toBe(fullIndex);
    expect(state.spareBlock).toBe(stairsIndex);
  });

  it('orientation resets when the shape changes on swap (evidence it goes through setActiveBlock)', () => {
    setActiveBlock(stairsIndex);
    state.pendingOrientation = 5; // stairs rotated and flipped
    setSpareBlock(fullIndex);

    swapActiveAndSpare();

    expect(state.activeBlock).toBe(fullIndex);
    expect(state.pendingOrientation).toBe(0);
  });

  it('the swapped-in active block is added to the "recently used" history', () => {
    setActiveBlock(fullIndex);
    setSpareBlock(stairsIndex);
    state.recentBlocks = [];

    swapActiveAndSpare();

    expect(state.recentBlocks[0]).toBe(stairsIndex);
  });

  it('replacing the spare touches neither orientation nor history (it is not the placement target)', () => {
    setActiveBlock(stairsIndex);
    state.pendingOrientation = 5;
    state.recentBlocks = [];

    setSpareBlock(fullIndex);

    expect(state.spareBlock).toBe(fullIndex);
    expect(state.pendingOrientation).toBe(5);
    expect(state.recentBlocks).toEqual([]);
  });
});
