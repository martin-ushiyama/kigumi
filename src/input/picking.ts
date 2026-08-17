import type * as THREE from 'three';
import type { CellRef } from '../core/cellref';
import type { Hit } from '../core/types';

const MAX_DIST = 400;
const COORD_LIMIT = 2000;

/**
 * A probe that the DDA uses to test "did this hit a world cell?".
 *
 * On a hit, returns **the ref occupying that world cell**. What a hit means depends on
 * the use case, so the probe is swappable (1:1 with WorldIndex's resolver functions):
 * - place / erase / pick -> `winnerRefAt` (also hits locked cells; place uses a locked
 *   face as a base for adjacent placement, and erase has `resolveEraseTarget` reject
 *   locked targets)
 * - selection -> `selectableRefAt` (the only path that passes through locked cells to
 *   reach the unlocked ref underneath)
 *
 * The old predicate of "`has(cell)` and the winner owner is not locked" is not used —
 * it has the defect of being unable to reach an unlocked ref underneath a locked
 * winner (flagged in design rev.2, documented in rev.4).
 */
export type CellProbe = (x: number, y: number, z: number) => CellRef | null;

/**
 * Voxel DDA (Amanatides & Woo). On hitting an occupied cell, returns it with the face
 * normal + ref.
 */
export function pickVoxel(origin: THREE.Vector3, dir: THREE.Vector3, probe: CellProbe): Hit | null {
  let x = Math.floor(origin.x);
  let y = Math.floor(origin.y);
  let z = Math.floor(origin.z);

  const stepX = dir.x > 0 ? 1 : dir.x < 0 ? -1 : 0;
  const stepY = dir.y > 0 ? 1 : dir.y < 0 ? -1 : 0;
  const stepZ = dir.z > 0 ? 1 : dir.z < 0 ? -1 : 0;

  const tDeltaX = stepX !== 0 ? Math.abs(1 / dir.x) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dir.y) : Infinity;
  const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dir.z) : Infinity;

  const bound = (p: number, cellP: number, step: number) =>
    step > 0 ? cellP + 1 - p : p - cellP;

  let tMaxX = stepX !== 0 ? bound(origin.x, x, stepX) * tDeltaX : Infinity;
  let tMaxY = stepY !== 0 ? bound(origin.y, y, stepY) * tDeltaY : Infinity;
  let tMaxZ = stepZ !== 0 ? bound(origin.z, z, stepZ) * tDeltaZ : Infinity;

  let normal: [number, number, number] = [0, 0, 0];
  let t = 0;

  while (t <= MAX_DIST) {
    if (Math.abs(x) < COORD_LIMIT && Math.abs(y) < COORD_LIMIT && Math.abs(z) < COORD_LIMIT && t > 0) {
      const ref = probe(x, y, z);
      if (ref) return { kind: 'voxel', ref, cell: [x, y, z], normal, t };
    }
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      normal = [-stepX, 0, 0];
    } else if (tMaxY <= tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      normal = [0, -stepY, 0];
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      normal = [0, 0, -stepZ];
    }
  }
  return null;
}

/** Intersection with the y=0 plane (the ground's top face). Only valid for a ray looking downward */
export function pickGround(origin: THREE.Vector3, dir: THREE.Vector3): Hit | null {
  if (origin.y <= 0 || dir.y >= -1e-9) return null;
  const t = -origin.y / dir.y;
  if (t < 0 || t > MAX_DIST) return null;
  const px = origin.x + dir.x * t;
  const pz = origin.z + dir.z * t;
  return {
    kind: 'ground',
    cell: [Math.floor(px), -1, Math.floor(pz)],
    normal: [0, 1, 0],
    t,
  };
}

/** Combined pick, preferring the voxel hit (whichever is closer) */
export function pick(origin: THREE.Vector3, dir: THREE.Vector3, probe: CellProbe): Hit | null {
  const v = pickVoxel(origin, dir, probe);
  const g = pickGround(origin, dir);
  if (v && g) return v.t <= g.t ? v : g;
  return v ?? g;
}
