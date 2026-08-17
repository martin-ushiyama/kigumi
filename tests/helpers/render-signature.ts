import * as THREE from 'three';

/**
 * Observe appearance **from the final data handed to the screen** (#131 PR 2).
 *
 * ## Why not call the product-side functions
 *
 * If a test called `createShapeGeometry` or `weirdoDirectionToYRotation` itself and
 * called it "renderer-derived", **wiring mistakes into the geometry or instance
 * transform would slip through undetected**. It would only be cross-checking the
 * same function's return value against the ledger, without observing whether that
 * function is actually connected to the screen. Same shape as #114's "if both sides
 * share the same table, the round trip passes."
 *
 * So this file takes only the `InstancedMesh` that landed in the `THREE.Scene` as
 * input. It reads just two things:
 *
 * - `geometry`'s vertices, indices, and face groups (materialIndex)
 * - the instance transform returned by `getMatrixAt(i)`
 *
 * and **imports nothing from product code**.
 *
 * ## What becomes the signature
 *
 * Occupied volume alone isn't enough (#131). A pillar occupies all 8 cells on any
 * of the X/Y/Z axes, so occupancy comes out the same regardless of axis. So this
 * also looks at **which material is assigned to which face**.
 *
 * - `occupancy`: of the 8 sub-cells formed by splitting a cell into 2×2×2, which ones are actually filled
 * - `faces`: the materialIndex (face group value) used by the triangles facing each of the 6 world directions
 * - `faceTextures`: **the texture actually mapped onto the material that materialIndex points to**
 *
 * `faces` alone isn't enough. materialIndex is just a number on the geometry side and
 * doesn't check correspondence with the `mesh.material` array, so **swapping side/top
 * when inserting into the array wouldn't be detected**
 * (#139 review finding).
 * `faceTextures` looks up `mesh.material` and follows it all the way to the `map`'s
 * name, so it verifies "which texture shows up on which face" end to end.
 */

/** The 6 world directions */
export type Direction = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

const DIRECTIONS: Array<[Direction, THREE.Vector3]> = [
  ['+x', new THREE.Vector3(1, 0, 0)],
  ['-x', new THREE.Vector3(-1, 0, 0)],
  ['+y', new THREE.Vector3(0, 1, 0)],
  ['-y', new THREE.Vector3(0, -1, 0)],
  ['+z', new THREE.Vector3(0, 0, 1)],
  ['-z', new THREE.Vector3(0, 0, -1)],
];

/** Name of a 2×2×2 sub-cell. `x0y1z0` = the -X side / upper half / -Z side of the cell */
export type SubCell = `x${0 | 1}y${0 | 1}z${0 | 1}`;

export interface RenderSignature {
  /** The sub-cells that are actually filled (ascending) */
  occupancy: SubCell[];
  /** world direction -> the materialIndex used by the face pointing that way (ascending, no duplicates) */
  faces: Record<Direction, number[]>;
  /** world direction -> the texture name actually shown on the face pointing that way (ascending, no duplicates) */
  faceTextures: Record<Direction, string[]>;
}

interface Triangle {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  normal: THREE.Vector3;
  materialIndex: number;
  /** Texture name of the material actually assigned to that materialIndex */
  texture: string;
}

/**
 * Look up materialIndex -> texture name from `mesh.material`.
 *
 * If material isn't an array (whole surface uses the same material), any index points
 * to that single material. A material with no texture returns `(no texture)` —
 * **never silently returns an empty string**, so that "no texture" and "couldn't be
 * observed" don't get conflated.
 */
function textureNameOf(material: THREE.Material | THREE.Material[], materialIndex: number): string {
  const one = Array.isArray(material) ? material[materialIndex] : material;
  if (!one) return '(no material)';
  const map = (one as THREE.MeshLambertMaterial).map;
  return map?.name ? map.name : '(no texture)';
}

/** Build world-space triangles from geometry + instance transform */
function worldTriangles(
  geometry: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
  material: THREE.Material | THREE.Material[],
): Triangle[] {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  if (!index) throw new Error('geometry without an index is not supported');

  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
  const groups = geometry.groups.length > 0 ? geometry.groups : [{ start: 0, count: index.count, materialIndex: 0 }];

  const triangles: Triangle[] = [];
  for (const group of groups) {
    const materialIndex = group.materialIndex ?? 0;
    const texture = textureNameOf(material, materialIndex);
    for (let i = group.start; i < group.start + group.count; i += 3) {
      const corners = [0, 1, 2].map((k) => {
        const v = new THREE.Vector3().fromBufferAttribute(position, index.getX(i + k));
        return v.applyMatrix4(matrix);
      }) as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
      const normal = new THREE.Vector3()
        .subVectors(corners[1], corners[0])
        .cross(new THREE.Vector3().subVectors(corners[2], corners[0]))
        .normalize();
      // Trust geometry's normal attribute rather than winding order (mirroring flips winding order)
      const attrNormal = geometry.getAttribute('normal');
      if (attrNormal) {
        normal.copy(
          new THREE.Vector3().fromBufferAttribute(attrNormal, index.getX(i)).applyMatrix3(normalMatrix).normalize(),
        );
      }
      triangles.push({ a: corners[0], b: corners[1], c: corners[2], normal, materialIndex, texture });
    }
  }
  return triangles;
}

/**
 * Whether a point is inside a closed mesh (parity of ray-triangle intersection count).
 *
 * **Don't make the ray axis-parallel.** A sub-cell's center can land directly on the
 * diagonal that splits a box face (`BoxGeometry` faces split into 2 triangles), and
 * firing straight along it makes whether it hits 2 triangles or 0 depend on boundary
 * handling, producing a checkerboard pattern. Tilt slightly off-axis to avoid landing on the edge.
 */
function isInside(point: THREE.Vector3, triangles: Triangle[]): boolean {
  const origin = point;
  const direction = new THREE.Vector3(0.0137, 1, 0.0231).normalize();
  let crossings = 0;
  for (const tri of triangles) {
    // Möller–Trumbore
    const edge1 = new THREE.Vector3().subVectors(tri.b, tri.a);
    const edge2 = new THREE.Vector3().subVectors(tri.c, tri.a);
    const h = new THREE.Vector3().crossVectors(direction, edge2);
    const det = edge1.dot(h);
    if (Math.abs(det) < 1e-9) continue;
    const invDet = 1 / det;
    const s = new THREE.Vector3().subVectors(origin, tri.a);
    const u = s.dot(h) * invDet;
    if (u < 0 || u > 1) continue;
    const q = new THREE.Vector3().crossVectors(s, edge1);
    const v = direction.dot(q) * invDet;
    if (v < 0 || u + v > 1) continue;
    const t = edge2.dot(q) * invDet;
    if (t > 1e-9) crossings++;
  }
  return crossings % 2 === 1;
}

/** The closest world direction to a vector. null if diagonal (only handles axis-aligned faces) */
function directionOf(normal: THREE.Vector3): Direction | null {
  for (const [name, axis] of DIRECTIONS) {
    if (normal.dot(axis) > 0.999) return name;
  }
  return null;
}

/**
 * Observe the appearance of a given cell from the `InstancedMesh` objects in the scene.
 *
 * @param scene The scene to observe. **Pass the actual scene the product code uses for rendering, as-is**
 * @param cell The integer coordinates (world) of the cell to observe
 */
export function renderSignatureAt(scene: THREE.Scene, cell: [number, number, number]): RenderSignature {
  const [cx, cy, cz] = cell;
  const triangles: Triangle[] = [];
  const matrix = new THREE.Matrix4();

  const isInstanced = (o: THREE.Object3D): o is THREE.InstancedMesh => o instanceof THREE.InstancedMesh;
  const meshes: THREE.InstancedMesh[] = [];
  scene.traverse((object) => {
    if (isInstanced(object)) meshes.push(object);
  });

  for (const mesh of meshes) {
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      const center = new THREE.Vector3().setFromMatrixPosition(matrix);
      // Only pick up instances placed in this cell (a slab's center is offset by half a cell, so judge by floor)
      if (Math.floor(center.x) !== cx || Math.floor(center.y) !== cy || Math.floor(center.z) !== cz) continue;
      triangles.push(...worldTriangles(mesh.geometry, matrix, mesh.material));
    }
  }

  const occupancy: SubCell[] = [];
  for (const ix of [0, 1] as const) {
    for (const iy of [0, 1] as const) {
      for (const iz of [0, 1] as const) {
        const point = new THREE.Vector3(cx + 0.25 + ix * 0.5, cy + 0.25 + iy * 0.5, cz + 0.25 + iz * 0.5);
        if (isInside(point, triangles)) occupancy.push(`x${ix}y${iy}z${iz}`);
      }
    }
  }

  const faces = Object.fromEntries(DIRECTIONS.map(([name]) => [name, new Set<number>()])) as Record<
    Direction,
    Set<number>
  >;
  const faceTextures = Object.fromEntries(DIRECTIONS.map(([name]) => [name, new Set<string>()])) as Record<
    Direction,
    Set<string>
  >;
  for (const tri of triangles) {
    const direction = directionOf(tri.normal);
    if (!direction) continue;
    faces[direction].add(tri.materialIndex);
    faceTextures[direction].add(tri.texture);
  }

  return {
    occupancy: occupancy.sort(),
    faces: Object.fromEntries(
      DIRECTIONS.map(([name]) => [name, [...faces[name]].sort((a, b) => a - b)]),
    ) as Record<Direction, number[]>,
    faceTextures: Object.fromEntries(
      DIRECTIONS.map(([name]) => [name, [...faceTextures[name]].sort()]),
    ) as Record<Direction, string[]>,
  };
}
