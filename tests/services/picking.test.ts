import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { CellRef } from '../../src/core/cellref';
import type { ProjectionEntry } from '../../src/core/sceneprojection';
import type { WorldIndexReader } from '../../src/core/worldindex';
import { createPickingService, type PointerLike } from '../../src/services/picking';

/** An upward-facing face (same as a ground click) */
const UP = { axis: 1, sign: 1 } as const;

function fakeCanvas(width = 800, height = 600) {
  return { getBoundingClientRect: () => ({ left: 0, top: 0, width, height }) };
}

function fakePointerEvent(overrides: Partial<PointerLike> = {}): PointerLike {
  return { clientX: 0, clientY: 0, ...overrides };
}

/**
 * A synchronous fake for WorldIndexReader (#37 B1b). PickingService only uses
 * `winnerRefAt` (the edit probe) and `selectableRefAt` (the selection probe).
 * We give both the same behavior here — the locked-passthrough branching is WorldIndex's
 * responsibility, not something PickingService's tests cover (worldindex.test.ts owns that).
 */
function fakeIndex(cells: Iterable<[number, number, number]>): WorldIndexReader {
  const set = new Set<string>();
  for (const [x, y, z] of cells) set.add(`${x},${y},${z}`);
  const entryAt = (world: readonly [number, number, number]): ProjectionEntry | null => {
    const key = `${world[0]},${world[1]},${world[2]}`;
    if (!set.has(key)) return null;
    const ref: CellRef = { ownerId: null, localCell: [world[0], world[1], world[2]] };
    return { ref, worldCell: [world[0], world[1], world[2]], raw: 0, effectiveHidden: false };
  };
  const notImplemented = (): never => {
    throw new Error('fakeIndex: a method PickingService should never call');
  };
  return {
    size: set.size,
    get: () => null,
    has: (x, y, z) => set.has(`${x},${y},${z}`),
    entries: function* () {
      /* not called by PickingService */
    },
    voidCells: function* () {
      /* not called by PickingService */
    },
    bounds: () => null,
    stackAt: (world) => {
      const entry = entryAt(world);
      return entry ? [entry] : [];
    },
    winnerRefAt: entryAt,
    selectableRefAt: entryAt,
    ownerAtWorld: () => null,
    isWorldCellHidden: () => false,
    isWorldCellLocked: () => false,
    worldOf: (ref) => [ref.localCell[0], ref.localCell[1], ref.localCell[2]],
    subscribe: notImplemented,
    subscribeBatch: notImplemented,
  };
}

/** A camera looking straight down (-Y) from the given coordinates (the center pixel's ray is always (0,-1,0)) */
function topDownCamera(x: number, y: number, z: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(x, y, z);
  camera.lookAt(x, y - 1, z);
  camera.updateMatrixWorld(true);
  return camera;
}

describe('PickingService — pickFromEvent', () => {
  it('hits the top face of the voxel directly below the camera (kind=voxel, normal=up)', () => {
    const service = createPickingService({
      canvas: fakeCanvas(),
      camera: topDownCamera(2.5, 20, 4.5),
      index: fakeIndex([[2, 3, 4]]),
    });

    const hit = service.pickFromEvent(fakePointerEvent({ clientX: 400, clientY: 300 }));

    expect(hit).toMatchObject({ cell: [2, 3, 4], normal: [0, 1, 0], kind: 'voxel' });
  });

  it('a cell the index answers as unoccupied (e.g. under a hidden group) falls through to a ground hit', () => {
    // #37 B1b: excluding hidden cells is now done internally by WorldIndex's winner
    // resolution, so there's no longer a path for injecting isCellHidden into PickingService.
    // The same result follows just from the index answering "there is no ref there"
    const service = createPickingService({
      canvas: fakeCanvas(),
      camera: topDownCamera(2.5, 20, 4.5),
      index: fakeIndex([]),
    });

    const hit = service.pickFromEvent(fakePointerEvent({ clientX: 400, clientY: 300 }));

    expect(hit?.kind).toBe('ground');
  });

  it('is null for a direction that hits nothing (looking straight up, never searches below the ground)', () => {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(0, -5, 0);
    camera.lookAt(0, 5, 0); // looking straight up, so pickGround's dir.y<0 assumption fails
    camera.updateMatrixWorld(true);
    const service = createPickingService({
      canvas: fakeCanvas(),
      camera,
      index: fakeIndex([]),
    });

    expect(service.pickFromEvent(fakePointerEvent({ clientX: 400, clientY: 300 }))).toBeNull();
  });
});

describe('PickingService — resolvePlaceCell', () => {
  it('returns the position offset by one cell along the face normal', () => {
    const service = createPickingService({
      canvas: fakeCanvas(),
      camera: topDownCamera(0, 10, 0),
      index: fakeIndex([]),
    });

    const placed = service.resolvePlaceCell({ kind: 'voxel', ref: { ownerId: null, localCell: [2, 3, 4] }, cell: [2, 3, 4], normal: [0, 1, 0], t: 0 });
    expect(placed).toEqual([2, 4, 4]);
  });
});

describe('PickingService — dragProject', () => {
  it('horizontal mode projects onto the horizontal plane y=mode.y', () => {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(0, 10, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const service = createPickingService({
      canvas: fakeCanvas(),
      camera,
      index: fakeIndex([]),
    });

    const p = service.dragProject(fakePointerEvent({ clientX: 400, clientY: 300 }), { axis: 'horizontal', y: 0 });
    expect(p).not.toBeNull();
    expect(p![1]).toBeCloseTo(0, 5);
  });

  it('is null when the plane is behind the ray', () => {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(0, -10, 0);
    camera.lookAt(0, 0, 0); // looking straight up
    camera.updateMatrixWorld(true);
    const service = createPickingService({
      canvas: fakeCanvas(),
      camera,
      index: fakeIndex([]),
    });

    // the horizontal plane y=-20 is below the camera (-10) = opposite the travel direction (+Y)
    const p = service.dragProject(fakePointerEvent({ clientX: 400, clientY: 300 }), { axis: 'horizontal', y: -20 });
    expect(p).toBeNull();
  });
});

describe('PickingService — resolveRangeExtrudeCell', () => {
  it('projects onto a plane through anchor, along the face axis, facing the camera, then floors it', () => {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(0, 5.5, 20);
    camera.lookAt(0, 5.5, 0); // aim the camera horizontally (a ray with zero y component)
    camera.updateMatrixWorld(true);
    const service = createPickingService({
      canvas: fakeCanvas(),
      camera,
      index: fakeIndex([]),
    });

    const cell = service.resolveRangeExtrudeCell(fakePointerEvent({ clientX: 400, clientY: 300 }), [2, 0, 2], UP);
    expect(cell).toEqual([0, 5, 2]);
  });

});

describe('PickingService — resolveRangeFaceCell (plane stage along a face, #101)', () => {
  /** A camera looking straight down. The center pixel's ray is (0,-1,0) */
  function service3D(camera: THREE.PerspectiveCamera) {
    return createPickingService({
      canvas: fakeCanvas(),
      camera,
      index: fakeIndex([]),
    });
  }

  it('an upward-facing face (axis Y) sticks to the Y of anchor', () => {
    const service = service3D(topDownCamera(3.5, 20, 4.5));
    const cell = service.resolveRangeFaceCell(fakePointerEvent({ clientX: 400, clientY: 300 }), [3, 7, 4], UP);
    expect(cell).toEqual([3, 7, 4]);
  });

  it('**resolves even where there is no existing block** (does not depend on a hit)', () => {
    // fakeIndex is empty. A hit-based approach would get nothing here, but this works because it's a plane projection
    const service = service3D(topDownCamera(30.5, 20, 40.5));
    const cell = service.resolveRangeFaceCell(fakePointerEvent({ clientX: 400, clientY: 300 }), [0, 2, 0], UP);
    expect(cell).toEqual([30, 2, 40]);
  });

  it('an X-facing side face (axis X) sticks to the X of anchor, with YZ moving freely', () => {
    // viewing the block from +X = the ray points -X. Lands on the plane X=5
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(20, 8.5, 6.5);
    camera.lookAt(0, 8.5, 6.5);
    camera.updateMatrixWorld(true);
    const cell = service3D(camera).resolveRangeFaceCell(
      fakePointerEvent({ clientX: 400, clientY: 300 }),
      [5, 0, 0],
      { axis: 0, sign: 1 },
    );
    expect(cell?.[0]).toBe(5); // the face axis stays fixed to anchor
    expect(cell?.[1]).toBe(8); // the vertical in-plane axis = Y moves (lets the wall get taller)
    expect(cell?.[2]).toBe(6);
  });

});

describe('PickingService — resolveRangeExtrudeCell axis generalization (#101)', () => {
  /** Looking down at an angle. An orientation where the plane never degenerates for any pushed axis */
  function obliqueService() {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(12, 12, 12);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    return createPickingService({
      canvas: fakeCanvas(),
      camera,
      index: fakeIndex([]),
    });
  }

  it('the component read changes per axis (not fixed to Y)', () => {
    const service = obliqueService();
    const e = fakePointerEvent({ clientX: 500, clientY: 200 });
    const anchor: [number, number, number] = [0, 0, 0];
    const byAxis = ([0, 1, 2] as const).map((axis) => service.resolveRangeExtrudeCell(e, anchor, { axis, sign: 1 }));
    for (const cell of byAxis) expect(cell).not.toBeNull();
    // each of the 3 axes lands on a different plane, so the results should not all match
    expect(new Set(byAxis.map((c) => JSON.stringify(c))).size).toBeGreaterThan(1);
  });

  it('does not return null even when looking straight along the axis (an escape hatch for when the plane degenerates)', () => {
    // extruding Y with a camera pointing straight down = dropping Y from the camera direction produces a zero vector
    const service = createPickingService({
      canvas: fakeCanvas(),
      camera: topDownCamera(0.5, 20, 0.5),
      index: fakeIndex([]),
    });
    const cell = service.resolveRangeExtrudeCell(fakePointerEvent({ clientX: 400, clientY: 300 }), [0, 0, 0], UP);
    expect(cell).not.toBeNull();
  });
});
