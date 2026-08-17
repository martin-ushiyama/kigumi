import { describe, expect, it } from 'vitest';
import { buildVoxelHull } from '../src/core/voxelhull';

/**
 * Assemble only the faces exposed on the outside (#69 Step 3b).
 *
 * **If even one internal face remains, drawing it translucent causes z-fighting for depth
 * and produces visible cracks.** This is a bug you can only spot by looking at the render,
 * so we pin down "no internal faces" via a face count instead.
 */
describe('voxel hull', () => {
  it('1 cell yields 6 faces', () => {
    expect(buildVoxelHull([[0, 0, 0]]).faceCount).toBe(6);
  });

  it('2 adjacent cells do not build the shared face', () => {
    // 6 × 2 = 12, minus the 2 facing faces = 10
    expect(buildVoxelHull([[0, 0, 0], [1, 0, 0]]).faceCount).toBe(10);
  });

  it('2 separated cells each get 6 faces', () => {
    expect(buildVoxelHull([[0, 0, 0], [5, 0, 0]]).faceCount).toBe(12);
  });

  it('a 2x2x2 block has 24 outer faces (zero internal faces)', () => {
    const cells: [number, number, number][] = [];
    for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) cells.push([x, y, z]);
    // 6 faces × 8 cells = 48, minus 12 internally-touching pairs = 24 faces -> 24
    expect(buildVoxelHull(cells).faceCount).toBe(24);
  });

  it('faces are built in every direction (top/bottom remain even when stacked vertically)', () => {
    // 3 cells stacked vertically: sides 4 × 3 = 12 + top/bottom 2 = 14
    expect(buildVoxelHull([[0, 0, 0], [0, 1, 0], [0, 2, 0]]).faceCount).toBe(14);
  });

  it('triangle count matches face count (1 face = 2 triangles)', () => {
    const hull = buildVoxelHull([[0, 0, 0], [1, 0, 0]]);
    expect(hull.indices.length).toBe(hull.faceCount * 6);
    expect(hull.positions.length).toBe(hull.faceCount * 4 * 3);
  });

  it('no cells means empty', () => {
    expect(buildVoxelHull([])).toEqual({ positions: [], indices: [], faceCount: 0 });
  });

  /**
   * If duplicates are passed through as-is, a face gets built twice at the same spot,
   * **reproducing the exact z-fighting we're trying to eliminate here**
   */
  it('duplicate cells do not increase the face count', () => {
    expect(buildVoxelHull([[0, 0, 0], [0, 0, 0]]).faceCount).toBe(6);
  });
});
