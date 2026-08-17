import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hit } from '../src/core/types';
import type { RangeSize } from '../src/core/rangesize';
import { CATALOG } from '../src/data/blocks';
import { initEditorControls, type EditorControlsHandle } from '../src/input/controls';
import { setShape, setShapeAxis, setTool, toggleShapeHollow } from '../src/state';
import { DocumentFixture } from './helpers/document-fixture';

/**
 * The wiring for **what the dimensions shown during a range operation depend on** for
 * updates.
 *
 * The counting itself lives in `tests/rangesize.test.ts`, and whether it appears/disappears
 * is covered by e2e. What this checks is whether the "can it be asserted as exceeding the
 * limit" judgment **tracks changes in the state it depends on**.
 *
 * The height stage holds no claim (it proceeds with the button released), so shape hotkeys
 * can pass through during that time. Committing reads the `state` after the change, so if
 * the dimensions were stuck on the shape at the start, an operation that would actually
 * succeed could still be committed while showing a "rejected" mark.
 */

function hitAt(cell: [number, number, number]): Hit {
  return { kind: 'voxel', cell, normal: [0, 1, 0] } as Hit;
}

function pointer(): PointerEvent {
  return { button: 0, shiftKey: false, altKey: false, clientX: 0, clientY: 0 } as PointerEvent;
}

/** controls.ts's toast dispatches a CustomEvent on window. Since this is the node environment, we just provide a stub to receive it */
function installWindowStub(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.CustomEvent ??= class {
    constructor(
      public type: string,
      public init?: { detail?: unknown },
    ) {}
  };
  g.window ??= { dispatchEvent: () => true };
}

describe('range dimension wiring — the limit judgment tracks the state it depends on', () => {
  let controls: EditorControlsHandle;
  let nextHit: Hit | null;
  let verticalY: number | null;
  /** The most recently emitted dimensions. null = not shown */
  let lastRange: RangeSize | null;

  beforeEach(() => {
    installWindowStub();
    const doc = new DocumentFixture(() => 'full');
    nextHit = null;
    verticalY = null;
    lastRange = null;
    setTool('fill');
    setShape('box');
    setShapeAxis(1);
    controls = initEditorControls({
      scene: new THREE.Scene(),
      world: doc.world,
      doc,
      getCatalog: () => CATALOG,
      getPaintBlock: () => 0,
      getPaintColor: () => '#ffffff',
      getPaintLabel: () => 'Test material',
      onHover: () => {},
      onRangeSize: (range) => {
        lastRange = range;
      },
      pickFromEvent: () => nextHit,
      resolvePlaceCell: (hit) => [hit.cell[0], hit.cell[1], hit.cell[2]],
      getPlacementGroup: () => null,
      // Stand-in for the plane-stage projection. Uses the hit cell the test provided as-is
      resolveRangeFaceCell: () => (nextHit ? [nextHit.cell[0], nextHit.cell[1], nextHit.cell[2]] : null),
      // Stand-in for the extrude projection. Returns the value the test provided, placed on **the face's axis**
      resolveRangeExtrudeCell: (_e, anchor, face) => {
        if (verticalY === null) return null;
        const cell: [number, number, number] = [...anchor];
        cell[face.axis] = verticalY;
        return cell;
      },
    });
  });

  /**
   * Don't carry an in-progress operation over into the next test.
   *
   * `state` change notifications are **module-wide**, and `initEditorControls` has no
   * unsubscribe hook. If the previous test's controls are left in progress, changing the
   * shape in a later test would make it react too and emit dimensions (a leak between
   * tests, not a product bug, but the cause is hard to spot).
   */
  afterEach(() => {
    controls.cancelActive();
  });

  function hoverMove(): void {
    const fn = controls.route.onHoverMove;
    if (!fn) throw new Error('onHoverMove route is not registered');
    fn(pointer());
  }

  /**
   * Builds a range that exceeds the generation limit (OP_MAX_CELLS = 32768 = 32^3) and
   * advances to the height stage.
   * 33 × 32 × 32 = 33,792 cells. **A size that is guaranteed to be rejected for a solid cuboid.**
   */
  function extrudeOverLimit(): void {
    nextHit = hitAt([0, 0, 0]);
    const claim = controls.route.onPointerDown(pointer());
    if (claim === 'handled' || claim === null) throw new Error('no claim returned');
    nextHit = hitAt([32, 0, 31]); // X 33 blocks / Z 32 blocks
    hoverMove();
    claim.onUp(pointer()); // advance to height stage
    verticalY = 31; // Y 32 blocks
    nextHit = null;
    hoverMove();
  }

  it('for a solid cuboid, asserts rejection the moment the generation limit is exceeded', () => {
    extrudeOverLimit();
    expect(lastRange?.size).toEqual([33, 32, 32]);
    expect(lastRange?.certainlyRejected).toBe(true);
  });

  it('withdraws the assertion when switching to a sphere at the height stage (a sphere does not fill the bbox, so it could pass)', () => {
    extrudeOverLimit();
    expect(lastRange?.certainlyRejected).toBe(true);

    setShape('sphere');

    expect(lastRange?.size).toEqual([33, 32, 32]); // the range itself is unchanged
    expect(lastRange?.certainlyRejected).toBe(false);
  });

  it('withdraws the assertion when switching to hollow at the height stage too (only a shell, so it could pass)', () => {
    extrudeOverLimit();
    expect(lastRange?.certainlyRejected).toBe(true);

    toggleShapeHollow();

    expect(lastRange?.certainlyRejected).toBe(false);
  });

  it('re-asserts after switching back to a cuboid (the update is not one-way)', () => {
    extrudeOverLimit();
    setShape('sphere');
    expect(lastRange?.certainlyRejected).toBe(false);

    setShape('box');

    expect(lastRange?.certainlyRejected).toBe(true);
  });

  it('does not emit dimensions on a shape change while no range operation is in progress (the numbers do not linger)', () => {
    extrudeOverLimit();
    controls.cancelActive();
    expect(lastRange).toBeNull();

    setShape('sphere');

    expect(lastRange).toBeNull();
  });
});
