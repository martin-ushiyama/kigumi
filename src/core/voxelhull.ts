/**
 * Build **only the faces that are exposed** from a cluster of voxels (#69 Step 3b).
 *
 * When boxes are placed cell by cell, adjacent cells share a face on the same plane.
 * Drawing that translucently turns it into a depth fight, producing **visible cracks
 * even though no line was drawn** (reported during testing). Changing the opacity doesn't
 * fix it — the real fix is to simply not draw interior faces, so only the exterior shell is built.
 *
 * Kept as a pure function so the visual defect can be **pinned down without looking at
 * the rendered output** ("zero interior faces" is a statement a test can make).
 */

/** Face orientation (direction to check the neighbor) and the 4 vertices that span that face (within the unit cell, counter-clockwise, facing outward) */
const FACES: { normal: [number, number, number]; corners: [number, number, number][] }[] = [
  { normal: [1, 0, 0], corners: [[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]] },
  { normal: [-1, 0, 0], corners: [[0, 0, 1], [0, 0, 0], [0, 1, 0], [0, 1, 1]] },
  { normal: [0, 1, 0], corners: [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]] },
  { normal: [0, -1, 0], corners: [[0, 0, 1], [1, 0, 1], [1, 0, 0], [0, 0, 0]] },
  { normal: [0, 0, 1], corners: [[1, 0, 1], [0, 0, 1], [0, 1, 1], [1, 1, 1]] },
  { normal: [0, 0, -1], corners: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]] },
];

export interface VoxelHull {
  /** Vertex coordinates (x, y, z sequence). Same coordinate system as cells (1 cell = 1) */
  positions: number[];
  /** Triangle indices */
  indices: number[];
  /** Number of faces built (for tests / visual verification) */
  faceCount: number;
}

/**
 * Build a shape from a set of cells using only the exposed faces.
 *
 * Faces with a neighboring cell are not built. Since **there isn't a single interior
 * face**, drawing translucently doesn't overlap faces and doesn't cause a depth fight.
 */
export function buildVoxelHull(cells: readonly (readonly [number, number, number])[]): VoxelHull {
  // **Treat the same cell appearing twice as one.** Passing duplicates through as-is would
  // build the face at the same spot twice — exactly the depth fight we're trying to eliminate here
  const filled = new Map<string, [number, number, number]>();
  for (const [x, y, z] of cells) filled.set(`${x},${y},${z}`, [x, y, z]);

  const positions: number[] = [];
  const indices: number[] = [];
  let faceCount = 0;

  for (const [x, y, z] of filled.values()) {
    for (const face of FACES) {
      const [nx, ny, nz] = face.normal;
      if (filled.has(`${x + nx},${y + ny},${z + nz}`)) continue; // has a neighbor = interior, so don't build it
      const base = positions.length / 3;
      for (const [cx, cy, cz] of face.corners) positions.push(x + cx, y + cy, z + cz);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      faceCount++;
    }
  }

  return { positions, indices, faceCount };
}
