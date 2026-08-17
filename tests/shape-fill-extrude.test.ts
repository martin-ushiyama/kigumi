import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { packCell, unpackCell } from '../src/core/orientation';
import type { Hit } from '../src/core/types';
import { CATALOG } from '../src/data/blocks';
import { initEditorControls, type EditorControlsHandle } from '../src/input/controls';
import { setShape, setTool, state, toggleShapeHollow } from '../src/state';
import { DocumentFixture } from './helpers/document-fixture';

/**
 * Shape fill extrusion (a 2-stage input: plane → height).
 *
 * Real 3D operation (camera + raycast) can't be built even in E2E, so this drives
 * `initEditorControls`'s route handlers directly, and the test supplies only the picking and
 * vertical projection. Since **the stage transitions themselves** are what's under test,
 * swapping out the injection points is enough to faithfully mirror real behavior.
 */

/** The minimal shape of a face hit. The placement face is determined by cell + normal */
function hitAt(cell: [number, number, number]): Hit {
  return { kind: 'voxel', cell, normal: [0, 1, 0] } as Hit;
}

function pointer(overrides: Partial<PointerEvent> = {}): PointerEvent {
  return { button: 0, shiftKey: false, altKey: false, clientX: 0, clientY: 0, ...overrides } as PointerEvent;
}

/** controls.ts's toast dispatches a CustomEvent on window. Since this runs in a node environment, just provide a stub to receive it */
function installWindowStub(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.CustomEvent ??= class {
    constructor(public type: string, public init?: { detail?: unknown }) {}
  };
  g.window ??= { dispatchEvent: () => true };
}

describe('shape fill extrusion', () => {
  let doc: DocumentFixture;
  let controls: EditorControlsHandle;
  /** The picking result the test supplies (used during the plane stage) */
  let nextHit: Hit | null;
  /** The vertical projection Y the test supplies (used during the height stage) */
  let verticalY: number | null;

  beforeEach(() => {
    installWindowStub();
    doc = new DocumentFixture(() => 'full');
    nextHit = null;
    verticalY = null;
    setTool('fill');
    setShape('box'); // shape doesn't affect the stage transition. Use box since its cell count is easy to check
    controls = initEditorControls({
      scene: new THREE.Scene(),
      world: doc.world,
      doc,
      getCatalog: () => CATALOG,
      getPaintBlock: () => 0,
      getPaintColor: () => '#ffffff',
      getPaintLabel: () => 'Test material',
      onHover: () => {},
      pickFromEvent: () => nextHit,
      // use the hit cell itself rather than the placement face (so the test's coordinates read straightforwardly)
      resolvePlaceCell: (hit) => [hit.cell[0], hit.cell[1], hit.cell[2]],
      getPlacementGroup: () => null,
      // stand-in for the plane stage's projection. Directly targets the cell of the hit the test supplied
      resolveRangeFaceCell: () => (nextHit ? [nextHit.cell[0], nextHit.cell[1], nextHit.cell[2]] : null),
      // stand-in for the extrude projection. Puts the value the test supplies into **the face's axis** and returns it
      resolveRangeExtrudeCell: (_e, anchor, face) => {
        if (verticalY === null) return null;
        const cell: [number, number, number] = [...anchor];
        cell[face.axis] = verticalY;
        return cell;
      },
    });
  });

  /** the hover route is declared optional, so resolve it once here before use */
  function hoverMove(): void {
    const fn = controls.route.onHoverMove;
    if (!fn) throw new Error('onHoverMove route is not registered');
    fn(pointer());
  }

  /** plane stage: drag from (0,0,0) to (2,0,2) and release the button */
  function dragPlane(): void {
    nextHit = hitAt([0, 0, 0]);
    const claim = controls.route.onPointerDown(pointer());
    if (claim === 'handled' || claim === null) throw new Error('claim was not returned');
    nextHit = hitAt([2, 0, 2]);
    hoverMove();
    claim.onUp(pointer());
  }

  /** height stage: move the mouse to target height y */
  function moveHeight(y: number): void {
    verticalY = y;
    nextHit = null; // mid-air = no hit. the height stage must still move even here
    hoverMove();
  }

  function placedCells(): number {
    let total = 0;
    for (const owner of [null, ...doc.tree.childrenOf(null)]) {
      for (const _ of doc.scene.cells.entriesOf(owner)) total++;
    }
    return total;
  }

  it('releasing the button does not commit; the next click commits it along with the height', () => {
    dragPlane();
    // at the point of release, not a single block has been placed yet
    expect(placedCells()).toBe(0);

    moveHeight(3);
    controls.route.onPointerDown(pointer());

    // 3 × 4 × 3 = 36 (y is 0..3)
    expect(placedCells()).toBe(36);
  });

  it('during the height stage, height keeps updating even with no hit (mid-air)', () => {
    dragPlane();
    moveHeight(5);
    moveHeight(2); // re-aim
    controls.route.onPointerDown(pointer());

    expect(placedCells()).toBe(3 * 3 * 3); // y is 0..2
  });

  it('if height is never moved, it can commit flat as-is (does not break the current usage)', () => {
    dragPlane();
    controls.route.onPointerDown(pointer());

    expect(placedCells()).toBe(3 * 3); // height 1
  });

  it('an Escape-equivalent cancel during the height stage leaves nothing behind', () => {
    dragPlane();
    moveHeight(4);
    controls.cancelActive();

    expect(placedCells()).toBe(0);
    // a click after cancel becomes the anchor of a new range (the previous operation does not come back)
    nextHit = hitAt([9, 0, 9]);
    controls.route.onPointerDown(pointer());
    expect(placedCells()).toBe(0);
  });

  it('if the tool changes during the height stage, it discards without waiting for a click', () => {
    dragPlane();
    moveHeight(4);
    setTool('place');
    // discarded immediately by the change notification (not left pending until a click)
    expect(placedCells()).toBe(0);

    controls.route.onPointerDown(pointer());
    expect(placedCells()).toBe(0);
  });

  it('is also discarded when switching to the select tool — the first click after returning to Fill does not commit the stale extrusion', () => {
    dragPlane();
    moveHeight(4);
    // the select tool never reaches controls due to onPointerDown's early return, so the
    // gesture side has no way to detect the end. a path that discards on the tool-change
    // notification is needed
    setTool('select');
    expect(placedCells()).toBe(0);

    // return to Fill after an intervening select operation
    setTool('fill');
    nextHit = hitAt([9, 0, 9]);
    controls.route.onPointerDown(pointer());
    // it just becomes the anchor of a new range; the stale extrusion does not commit
    expect(placedCells()).toBe(0);
  });

  it('a hollow spec also applies to extrusion (the path did not change)', () => {
    // extrude a 3×3 base up to height 3 = 27 solid / hollow is just the shell at 26 (the 1 interior cell drops out)
    dragPlane();
    moveHeight(2);
    controls.route.onPointerDown(pointer());
    expect(placedCells()).toBe(27);

    doc.undo();
    expect(placedCells()).toBe(0);

    toggleShapeHollow(); // box defaults to solid, so this makes it hollow
    dragPlane();
    moveHeight(2);
    controls.route.onPointerDown(pointer());
    expect(placedCells()).toBe(26);
    toggleShapeHollow(); // don't carry this over into other tests
  });

  it('placed cells are filled with the currently selected block', () => {
    dragPlane();
    moveHeight(1);
    controls.route.onPointerDown(pointer());

    for (const owner of [null, ...doc.tree.childrenOf(null)]) {
      for (const [, raw] of doc.scene.cells.entriesOf(owner)) {
        expect(unpackCell(raw).catalogIndex).toBe(unpackCell(packCell(state.activeBlock, 0)).catalogIndex);
      }
    }
  });
});
