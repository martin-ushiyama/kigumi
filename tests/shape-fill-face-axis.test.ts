import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Axis } from '../src/core/axis';
import type { Hit } from '../src/core/types';
import { CATALOG } from '../src/data/blocks';
import { initEditorControls, type EditorControlsHandle } from '../src/input/controls';
import { setShape, setTool } from '../src/state';
import { DocumentFixture } from './helpers/document-fixture';

/**
 * The shape fill's basis is **the face that was touched**.
 *
 * While the extrude direction was pinned to Y, only the floor got special-cased and building
 * a wall never lined up. What this checks is that "the face normal decides the plane and the
 * extrude axis," and that the axis **is fixed at the start of the operation and doesn't change
 * partway through**.
 *
 * The projection itself (camera/ray geometry) belongs to `tests/services/picking.test.ts`.
 * This file is about the controls wiring, so the test swaps out the projection at its
 * injection point.
 */

function hitAt(cell: [number, number, number], normal: [number, number, number]): Hit {
  return { kind: 'voxel', cell, normal } as Hit;
}

function pointer(): PointerEvent {
  return { button: 0, shiftKey: false, altKey: false, clientX: 0, clientY: 0 } as PointerEvent;
}

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

describe('Shape fill — the touched face is the basis', () => {
  let doc: DocumentFixture;
  let controls: EditorControlsHandle;
  let nextHit: Hit | null;
  /** The cell the test returns during the plane stage. null = the projection couldn't resolve at that moment */
  let planeCell: [number, number, number] | null;
  /** The "face-axis coordinate" the test returns during the extrude stage */
  let extrudeTo: number | null;
  /** Records the axis controls passed in (to confirm it's derived from the face normal) */
  let seenAxes: Axis[];

  beforeEach(() => {
    installWindowStub();
    doc = new DocumentFixture(() => 'full');
    nextHit = null;
    planeCell = null;
    extrudeTo = null;
    seenAxes = [];
    setTool('fill');
    setShape('box'); // use a shape whose cell count is easy to count
    controls = initEditorControls({
      scene: new THREE.Scene(),
      world: doc.world,
      doc,
      getCatalog: () => CATALOG,
      getPaintBlock: () => 0,
      getPaintColor: () => '#ffffff',
      getPaintLabel: () => 'Test Material',
      onHover: () => {},
      pickFromEvent: () => nextHit,
      // use the hit cell itself as the placement target (so the test's coordinates read directly)
      resolvePlaceCell: (hit) => [hit.cell[0], hit.cell[1], hit.cell[2]],
      getPlacementGroup: () => null,
      resolveRangeFaceCell: (_e, _anchor, face) => {
        seenAxes.push(face.axis);
        return planeCell;
      },
      resolveRangeExtrudeCell: (_e, anchor, face) => {
        seenAxes.push(face.axis);
        if (extrudeTo === null) return null;
        const cell: [number, number, number] = [...anchor];
        cell[face.axis] = extrudeTo;
        return cell;
      },
    });
  });

  // state change notifications share a module-wide subscription with no unsubscribe hook. leaving one in progress would leak into the next test
  afterEach(() => {
    controls.cancelActive();
  });

  function hoverMove(): void {
    const fn = controls.route.onHoverMove;
    if (!fn) throw new Error('onHoverMove route is not registered');
    fn(pointer());
  }

  /** Click the face → expand to `to` during the plane stage → release (moves to the extrude stage) */
  function dragOnFace(
    anchor: [number, number, number],
    normal: [number, number, number],
    to: [number, number, number],
  ): void {
    nextHit = hitAt(anchor, normal);
    const claim = controls.route.onPointerDown(pointer());
    if (claim === 'handled' || claim === null) throw new Error('claim was not returned');
    planeCell = to;
    hoverMove();
    claim.onUp(pointer());
  }

  function extrude(to: number): void {
    extrudeTo = to;
    nextHit = null; // midair = no hit. the extrude stage still works here
    hoverMove();
  }

  function placedCells(): number {
    let total = 0;
    for (const owner of [null, ...doc.tree.childrenOf(null)]) {
      for (const _ of doc.scene.cells.entriesOf(owner)) total++;
    }
    return total;
  }

  /** The world range of the placed cells. Used to see which axis grew */
  function placedBounds() {
    return doc.world.bounds();
  }

  it('a face pointing up still gets the XZ plane + Y extrude, as before', () => {
    dragOnFace([0, 0, 0], [0, 1, 0], [2, 0, 2]);
    extrude(3);
    controls.route.onPointerDown(pointer());

    expect(seenAxes.every((a) => a === 1)).toBe(true);
    expect(placedCells()).toBe(3 * 4 * 3); // Y is 0..3
  });

  it('a side face pointing X becomes a YZ plane + X extrude (lets you build a wall)', () => {
    // click the face and expand Y and Z during the plane stage. Y moving is the key to building a wall
    dragOnFace([5, 0, 0], [1, 0, 0], [5, 3, 3]);
    expect(seenAxes.every((a) => a === 0)).toBe(true);

    extrude(7); // adds thickness in the X direction
    controls.route.onPointerDown(pointer());

    expect(placedBounds()).toEqual({ min: [5, 0, 0], max: [7, 3, 3] });
    expect(placedCells()).toBe(3 * 4 * 4);
  });

  it('a side face pointing Z becomes an XY plane + Z extrude', () => {
    dragOnFace([0, 0, 9], [0, 0, -1], [2, 2, 9]);
    expect(seenAxes.every((a) => a === 2)).toBe(true);

    extrude(6);
    controls.route.onPointerDown(pointer());

    expect(placedBounds()).toEqual({ min: [0, 0, 6], max: [2, 2, 9] });
  });

  it("the face axis doesn't move during the plane stage (the plane is preserved)", () => {
    dragOnFace([5, 0, 0], [1, 0, 0], [5, 4, 4]);
    // commit without extruding = a wall of thickness 1
    controls.route.onPointerDown(pointer());

    expect(placedBounds()).toEqual({ min: [5, 0, 0], max: [5, 4, 4] });
  });

  it('extruding only moves the face axis (the 2 in-plane axes are already fixed)', () => {
    dragOnFace([5, 1, 2], [-1, 0, 0], [5, 3, 6]);
    extrude(2);
    controls.route.onPointerDown(pointer());

    const bounds = placedBounds();
    expect(bounds?.min[1]).toBe(1); // the Y/Z decided during the plane stage doesn't change during extrusion
    expect(bounds?.max[1]).toBe(3);
    expect(bounds?.min[2]).toBe(2);
    expect(bounds?.max[2]).toBe(6);
    expect(bounds?.min[0]).toBe(2); // only X grows
    expect(bounds?.max[0]).toBe(5);
  });

  it('updates via the plane projection even when the ray hits nothing (lets you drag past the edge of the face)', () => {
    // if this stayed hit-dependent, updates would stop the moment you left the face and it would commit as a single cell
    nextHit = hitAt([5, 0, 0], [1, 0, 0]);
    const claim = controls.route.onPointerDown(pointer());
    if (claim === 'handled' || claim === null) throw new Error('claim was not returned');

    nextHit = null; // midair = hits neither the ground nor a voxel
    planeCell = [5, 3, 3];
    hoverMove();
    claim.onUp(pointer());
    controls.route.onPointerDown(pointer()); // commit without extruding

    expect(placedBounds()).toEqual({ min: [5, 0, 0], max: [5, 3, 3] });
  });

  it("the range doesn't jump to a different hit even if the projection goes null for a moment", () => {
    // even in 3D, the projection goes null the instant the ray becomes parallel to the plane. falling
    // back to the hit path here would grab a cell on another face (e.g. the ground) and the range would jump (review reproduced this path)
    nextHit = hitAt([5, 0, 0], [1, 0, 0]);
    const claim = controls.route.onPointerDown(pointer());
    if (claim === 'handled' || claim === null) throw new Error('claim was not returned');

    planeCell = [5, 3, 3];
    hoverMove(); // expands up to the wall's plane

    planeCell = null; // the projection fails for a moment
    nextHit = hitAt([9, 0, 9], [0, 1, 0]); // the ground hit is still live
    hoverMove();

    claim.onUp(pointer());
    controls.route.onPointerDown(pointer()); // commit without extruding

    // keeps the previous target (the wall's plane). hasn't expanded to the ground at [9,0,9]
    expect(placedBounds()).toEqual({ min: [5, 0, 0], max: [5, 3, 3] });
  });

  it('extrusion grows in the direction of the normal (+face)', () => {
    // the +X face at x=5. outward is the direction where x increases
    dragOnFace([5, 0, 0], [1, 0, 0], [5, 2, 2]);
    extrude(8);
    controls.route.onPointerDown(pointer());

    expect(placedBounds()).toEqual({ min: [5, 0, 0], max: [8, 2, 2] });
  });

  it("extrusion grows in the direction of the normal (-face, doesn't give the same result as +face)", () => {
    // the -X face at x=5. outward is the direction where x decreases
    dragOnFace([5, 0, 0], [-1, 0, 0], [5, 2, 2]);
    extrude(2);
    controls.route.onPointerDown(pointer());

    expect(placedBounds()).toEqual({ min: [2, 0, 0], max: [5, 2, 2] });
  });

  it("doesn't bite into the inside (the original block's side) — even aiming inward on the +face, it stops at thickness 1", () => {
    dragOnFace([5, 0, 0], [1, 0, 0], [5, 2, 2]);
    extrude(1); // closer than the anchor = inside the original block
    controls.route.onPointerDown(pointer());

    expect(placedBounds()).toEqual({ min: [5, 0, 0], max: [5, 2, 2] });
  });

  it("doesn't bite into the inside — even aiming further on the -face, it stops at thickness 1", () => {
    dragOnFace([5, 0, 0], [-1, 0, 0], [5, 2, 2]);
    extrude(9);
    controls.route.onPointerDown(pointer());

    expect(placedBounds()).toEqual({ min: [5, 0, 0], max: [5, 2, 2] });
  });

  it('a hit with an unreadable normal is treated as an upward-facing face (same as clicking the ground)', () => {
    nextHit = hitAt([0, 0, 0], [0, 0, 0]);
    const claim = controls.route.onPointerDown(pointer());
    if (claim === 'handled' || claim === null) throw new Error('claim was not returned');
    planeCell = [1, 0, 1];
    hoverMove();

    expect(seenAxes).toContain(1);
    claim.onUp(pointer());
  });
});
