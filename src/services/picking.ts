import * as THREE from 'three';
import { facePlaneAt, type FaceRef } from '../core/axis';
import type { Hit } from '../core/types';
import type { WorldIndexReader } from '../core/worldindex';
import { pick, type CellProbe } from '../input/picking';

/** The minimal contract main.ts passes into this service from a canvas element (#14 PR2, receives the DOM dependency through the smallest possible interface) */
export interface PickingCanvas {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

/** The minimal contract covering only the PointerEvent properties this service uses (#14 PR2 review feedback) */
export interface PointerLike {
  clientX: number;
  clientY: number;
}

export type DragProjectMode = { axis: 'horizontal'; y: number } | { axis: 'vertical'; x: number; z: number };

export interface PickingServiceOpts {
  canvas: PickingCanvas;
  camera: THREE.Camera;
  /**
   * Derived read-model (#37 B1b). This used to be a pair, `world: WorldReader` + `isCellHidden`,
   * but since WorldIndex's winner resolution now excludes hidden internally, injecting a
   * visibility filter is no longer needed.
   */
  index: WorldIndexReader;
}

export interface PickingService {
  /**
   * Hit resolution for place/erase/eyedropper (winner-based). This also hits locked cells —
   * place uses a locked face as the base to place adjacent to it, and erase is rejected by
   * `Document.resolveEraseTarget`.
   */
  pickFromEvent: (e: PointerLike) => Hit | null;
  /**
   * Hit resolution for selection (`selectableRefAt`-based). Skips hidden, and **passes through**
   * locked to reach the unlocked ref beneath it. Only the selection tool uses this.
   */
  pickFromEventForSelect: (e: PointerLike) => Hit | null;
  /** Resolves the new placement cell from a Hit (adds the face normal to place "one cell in front") */
  resolvePlaceCell: (hit: Hit) => [number, number, number];
  /** Resolves the projected target of the selection tool's drag-move/nudge (projects onto a horizontal/vertical plane) */
  dragProject: (e: PointerLike, mode: DragProjectMode) => [number, number, number] | null;
  /**
   * Shape-fill's **plane stage**: casts a ray onto the plane containing the touched face to
   * determine the target cell (#101).
   *
   * With the approach of taking the placement cell from the hit, dragging outside the existing
   * block would fall onto a different face (often the ground), and the plane along the touched
   * face couldn't be obtained. For walls, the vertical direction within the plane wouldn't move,
   * so **a wall bigger than the existing block couldn't be created**. Projecting onto the plane
   * itself lets it extend beyond the face.
   *
   * Returns null only the instant the ray becomes parallel to the plane (the caller keeps the previous target).
   */
  resolveRangeFaceCell: (
    e: PointerLike,
    anchor: [number, number, number],
    face: FaceRef,
  ) => [number, number, number] | null;
  /**
   * Shape-fill's **extrude stage**: determines how many cells to extend along the face's axis (#78 / #101).
   *
   * Casts onto a plane that contains the face's axis and faces the camera as directly as possible, and reads only that axis's component.
   */
  resolveRangeExtrudeCell: (
    e: PointerLike,
    anchor: [number, number, number],
    face: FaceRef,
  ) => [number, number, number] | null;
}

/** Picking extracted from main.ts (pick / placement coordinates / drag projection). #14 PR2 / #37 B1b */
export function createPickingService(opts: PickingServiceOpts): PickingService {
  const { canvas, camera, index } = opts;

  const raycaster3D = new THREE.Raycaster();
  const pointerNdc3D = new THREE.Vector2();

  /** Edit probe: visible winner (including locked) */
  const probeEdit: CellProbe = (x, y, z) => index.winnerRefAt([x, y, z])?.ref ?? null;
  /** Select probe: excludes hidden + passes through locked */
  const probeSelect: CellProbe = (x, y, z) => index.selectableRefAt([x, y, z])?.ref ?? null;

  function setRayFromEvent(e: PointerLike): void {
    const rect = canvas.getBoundingClientRect();
    pointerNdc3D.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc3D.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster3D.setFromCamera(pointerNdc3D, camera);
  }

  function pickWith(e: PointerLike, probe: CellProbe): Hit | null {
    setRayFromEvent(e);
    return pick(raycaster3D.ray.origin, raycaster3D.ray.direction, probe);
  }

  function pickFromEvent(e: PointerLike): Hit | null {
    return pickWith(e, probeEdit);
  }

  function pickFromEventForSelect(e: PointerLike): Hit | null {
    return pickWith(e, probeSelect);
  }

  function resolvePlaceCell(hit: Hit): [number, number, number] {
    return [hit.cell[0] + hit.normal[0], hit.cell[1] + hit.normal[1], hit.cell[2] + hit.normal[2]];
  }

  function dragProject(e: PointerLike, mode: DragProjectMode): [number, number, number] | null {
    setRayFromEvent(e);
    const plane = new THREE.Plane();
    if (mode.axis === 'horizontal') {
      plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, mode.y, 0));
    } else {
      const camDir = new THREE.Vector3();
      camera.getWorldDirection(camDir);
      camDir.y = 0;
      if (camDir.lengthSq() < 1e-6) camDir.set(0, 0, 1);
      camDir.normalize();
      plane.setFromNormalAndCoplanarPoint(camDir, new THREE.Vector3(mode.x, 0, mode.z));
    }
    const target = new THREE.Vector3();
    const hit = raycaster3D.ray.intersectPlane(plane, target);
    return hit ? [target.x, target.y, target.z] : null;
  }

  /**
   * Casts a ray onto **the touched face itself**.
   *
   * The plane sits at the block's boundary (not the cell center). Substituting the center would
   * shift things by half a cell, and viewing from an angle would drift the plane's coordinate
   * toward the neighboring cell by that much — a ground click came out shifted by 1 cell.
   */
  function resolveRangeFaceCell(
    e: PointerLike,
    anchor: [number, number, number],
    face: FaceRef,
  ): [number, number, number] | null {
    setRayFromEvent(e);
    const normal = new THREE.Vector3();
    normal.setComponent(face.axis, 1);
    const through = new THREE.Vector3();
    through.setComponent(face.axis, facePlaneAt(anchor, face));
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, through);
    const target = new THREE.Vector3();
    if (!raycaster3D.ray.intersectPlane(plane, target)) return null;
    const cell: [number, number, number] = [Math.floor(target.x), Math.floor(target.y), Math.floor(target.z)];
    // The face's axis is fixed to anchor (it's a point on the plane, so rounding could drop it onto the neighboring cell)
    cell[face.axis] = anchor[face.axis];
    return cell;
  }

  /**
   * Builds the extrude stage's projection plane. A plane that **contains the axis and faces the
   * camera as directly as possible**.
   *
   * Dropping the axis component from the camera direction gives a plane normal that contains
   * the axis direction. Same construction as the old implementation's Y-fixed `camDir.y = 0`, just generalized to any axis.
   */
  function resolveRangeExtrudeCell(
    e: PointerLike,
    anchor: [number, number, number],
    face: FaceRef,
  ): [number, number, number] | null {
    setRayFromEvent(e);
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    camDir.setComponent(face.axis, 0);
    if (camDir.lengthSq() < 1e-6) {
      // Looking straight down the axis. The plane isn't uniquely determined, so use an arbitrary orthogonal direction
      camDir.setComponent((face.axis + 1) % 3, 1);
    }
    camDir.normalize();
    const through = new THREE.Vector3(anchor[0] + 0.5, anchor[1] + 0.5, anchor[2] + 0.5);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, through);
    const target = new THREE.Vector3();
    if (!raycaster3D.ray.intersectPlane(plane, target)) return null;
    return [Math.floor(target.x), Math.floor(target.y), Math.floor(target.z)];
  }

  return {
    pickFromEvent,
    pickFromEventForSelect,
    resolvePlaceCell,
    dragProject,
    resolveRangeFaceCell,
    resolveRangeExtrudeCell,
  };
}
