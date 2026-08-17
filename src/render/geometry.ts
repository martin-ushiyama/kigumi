import * as THREE from 'three';
import { stairsFacingXZ, type Shape } from '../core/orientation';

/**
 * Block shape geometry.
 *
 * full/slab are symmetric rectangular boxes, so up/down orientation can be expressed with
 * just a Y translation on the instance matrix (the geometry is always centered at the origin,
 * no need to worry about normals or winding order) — voxelmesh.ts applies the offset per instance.
 *
 * stairs are an asymmetric L-shape, so flipping it upside down changes the normals and winding
 * order (a negative scale isn't enough) → a separate geometry is generated per upsideDown state
 * (voxelmesh.ts keeps a separate InstancedMesh per upsideDown state).
 *
 * Face groups follow the existing side/top texture convention (BlockTypeMesh): full uses
 * BoxGeometry's default 6 groups (0=+x,1=-x,2=+y,3=-y,4=+z,5=-z, with the caller passing
 * [side,side,top,top,side,side]), stairs use the 2 groups produced by mergeBoxGeometries
 * (0=side, 1=top).
 */
export function createShapeGeometry(shape: Shape, upsideDown: boolean): THREE.BufferGeometry {
  if (shape === 'full') return new THREE.BoxGeometry(1, 1, 1);
  if (shape === 'slab') return new THREE.BoxGeometry(1, 0.5, 1); // Centered at the origin, offset applied on the instance side
  return createStairsGeometry(upsideDown);
}

/** Instance position offset for the slab's bottom/top half (always 0 for full/stairs) */
export function slabHalfOffset(half: 'bottom' | 'top'): number {
  return half === 'top' ? 0.25 : -0.25;
}

/**
 * Stairs = bottom step (width 1 × height 0.5 × depth 1) + top step (width 1 × height 0.5 ×
 * depth 0.5, back half).
 *
 * **+Z is the reference orientation for "the direction it rises."** `weirdoDirectionToYRotation`
 * rotates from here toward whatever direction weirdo_direction points to. Changing the
 * reference changes that rotation angle too, so don't touch just one side (the source of truth
 * for orientation is the measured table in `orientation.ts`).
 */
function createStairsGeometry(upsideDown: boolean): THREE.BufferGeometry {
  const bottom = new THREE.BoxGeometry(1, 0.5, 1);
  bottom.translate(0, -0.25, 0);
  const top = new THREE.BoxGeometry(1, 0.5, 0.5);
  top.translate(0, 0.25, 0.25);

  const merged = mergeBoxGeometries(bottom, top);
  if (upsideDown) mirrorY(merged);
  return merged;
}

/**
 * Flips only the Y axis (leaves Z untouched). rotateX(π) would flip Y and Z simultaneously,
 * shifting the Z position of the side with the step (contradicting the weirdo_direction
 * orientation), so instead we flip the sign of just the Y component of positions/normals, and
 * reverse the winding order per group for the faces the mirror flips, to keep front/back
 * (normals/culling) correct.
 */
function mirrorY(geo: THREE.BufferGeometry): void {
  const position = geo.getAttribute('position');
  const normal = geo.getAttribute('normal');
  for (let i = 0; i < position.count; i++) {
    position.setY(i, -position.getY(i));
    normal.setY(i, -normal.getY(i));
  }
  position.needsUpdate = true;
  normal.needsUpdate = true;

  const index = geo.getIndex()!;
  const rewritten = Array.from(index.array);
  for (const group of geo.groups) {
    for (let i = group.start; i < group.start + group.count; i += 3) {
      const tmp = rewritten[i + 1]!;
      rewritten[i + 1] = rewritten[i + 2]!;
      rewritten[i + 2] = tmp;
    }
  }
  geo.setIndex(rewritten);
}

/**
 * Merges two BoxGeometry instances into a single BufferGeometry and sorts face groups into
 * ±Y faces → group 1 (top) / everything else → group 0 (side).
 * Assumes BoxGeometry's vertex order (24 vertices, 4 vertices × 6 faces: +x,-x,+y,-y,+z,-z)
 * and determines each face's normal direction from its index.
 */
function mergeBoxGeometries(a: THREE.BoxGeometry, b: THREE.BoxGeometry): THREE.BufferGeometry {
  const merged = new THREE.BufferGeometry();
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const sideIndices: number[] = [];
  const topIndices: number[] = [];

  let vertexOffset = 0;
  for (const box of [a, b]) {
    const posAttr = box.getAttribute('position');
    const normAttr = box.getAttribute('normal');
    const uvAttr = box.getAttribute('uv');
    const index = box.getIndex()!;

    for (let i = 0; i < posAttr.count; i++) {
      positions.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      normals.push(normAttr.getX(i), normAttr.getY(i), normAttr.getZ(i));
      uvs.push(uvAttr.getX(i), uvAttr.getY(i));
    }

    // BoxGeometry has 6 faces × 2 triangles × 3 = 36 indices, 6 consecutive indices per face
    for (let face = 0; face < 6; face++) {
      const isTop = face === 2 || face === 3; // +y=2, -y=3 (BoxGeometry's default order)
      const bucket = isTop ? topIndices : sideIndices;
      for (let k = 0; k < 6; k++) {
        bucket.push(index.getX(face * 6 + k) + vertexOffset);
      }
    }
    vertexOffset += posAttr.count;
  }

  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));

  const combinedIndex = [...sideIndices, ...topIndices];
  merged.setIndex(combinedIndex);
  merged.addGroup(0, sideIndices.length, 0);
  merged.addGroup(sideIndices.length, topIndices.length, 1);

  a.dispose();
  b.dispose();
  return merged;
}

/**
 * Converts weirdo_direction (0-3) into a Y-axis rotation angle.
 *
 * **Not `d * 90 degrees`.** In the real game the order is 0=east / 1=west / 2=south / 3=north,
 * with 0 and 1 being 180 degrees apart (see the measured table in `orientation.ts`). The angle
 * is derived from that — since the reference orientation is +Z (`createStairsGeometry` pushes
 * the top step toward +Z), and `rotateY(θ)` sends (0,0,1) to (sinθ, 0, cosθ), it follows that
 * `θ = atan2(fx, fz)`.
 */
export function weirdoDirectionToYRotation(weirdoDirection: 0 | 1 | 2 | 3): number {
  const [fx, fz] = stairsFacingXZ(weirdoDirection);
  return Math.atan2(fx, fz);
}
