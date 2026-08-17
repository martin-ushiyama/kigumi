import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { packCell } from '../src/core/orientation';
import type { BlockDef } from '../src/core/types';
import { VoxelWorld } from '../src/core/voxels';
import { VoxelEdges } from '../src/render/voxeledges';
import { DocumentFixture, place } from './helpers/document-fixture';
import { toIndexChange } from './helpers/world-index-events';

function makeCatalog(): BlockDef[] {
  return [
    { id: 'test:full', nameJa: 'フル', nameEn: 'Full', category: 'misc', color: '#ffffff', shape: 'full', materialGroup: 'test' },
    { id: 'test:slab', nameJa: 'スラブ', nameEn: 'Slab', category: 'misc', color: '#ffffff', shape: 'slab', materialGroup: 'test' },
    { id: 'test:stairs', nameJa: '階段', nameEn: 'Stairs', category: 'misc', color: '#ffffff', shape: 'stairs', materialGroup: 'test' },
  ];
}

function getLineSegments(scene: THREE.Scene): THREE.LineSegments {
  const found = scene.children.find((c) => c instanceof THREE.LineSegments);
  if (!found) throw new Error('LineSegments not found in scene');
  return found as THREE.LineSegments;
}

/** #15 follow-up: the position attribute is a fixed buffer pre-allocated for capacity, so the
 *  actually rendered range is narrowed via geometry.drawRange (the raw attribute.count includes unused space) */
function activeVertexCount(geometry: THREE.BufferGeometry): number {
  return geometry.drawRange.count;
}

function yRange(geometry: THREE.BufferGeometry): [number, number] {
  const pos = geometry.getAttribute('position');
  const count = activeVertexCount(geometry);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < count; i++) {
    min = Math.min(min, pos.getY(i));
    max = Math.max(max, pos.getY(i));
  }
  return [min, max];
}

describe('VoxelEdges', () => {
  it('the edge vertices of 1 full block form a unit cube from cell coordinates (x, y, z) to (x+1, y+1, z+1)', () => {
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    world.stageMany([{ x: 2, y: 3, z: 4, before: null, after: packCell(0, 0) }]);

    const edges = new VoxelEdges(scene, world, makeCatalog());
    edges.setVisible(true);
    edges.update();

    const geometry = getLineSegments(scene).geometry;
    const pos = geometry.getAttribute('position');
    // BoxGeometry's EdgesGeometry is 12 edges × 2 vertices = 24. #15 follow-up: the per-cell
    // slot width is fixed to the max across the whole catalog (e.g. stairs), so it can be >= 24
    // (the excess is padded with degenerate edges of 2 identical points, with no effect on the bounding box)
    expect(activeVertexCount(geometry)).toBeGreaterThanOrEqual(24);

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < activeVertexCount(geometry); i++) {
      minX = Math.min(minX, pos.getX(i));
      maxX = Math.max(maxX, pos.getX(i));
      minY = Math.min(minY, pos.getY(i));
      maxY = Math.max(maxY, pos.getY(i));
      minZ = Math.min(minZ, pos.getZ(i));
      maxZ = Math.max(maxZ, pos.getZ(i));
    }
    expect(minX).toBeCloseTo(2, 6);
    expect(maxX).toBeCloseTo(3, 6);
    expect(minY).toBeCloseTo(3, 6);
    expect(maxY).toBeCloseTo(4, 6);
    expect(minZ).toBeCloseTo(4, 6);
    expect(maxZ).toBeCloseTo(5, 6);
  });

  it('skips rebuild while hidden, and reflects it immediately once made visible again since dirty remained set', () => {
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    const edges = new VoxelEdges(scene, world, makeCatalog());

    edges.update(); // the initial state is hidden (visible=false), so nothing happens
    expect(activeVertexCount(getLineSegments(scene).geometry)).toBe(0);

    world.stageMany([{ x: 0, y: 0, z: 0, before: null, after: packCell(0, 0) }]);
    edges.update(); // world changes while still hidden -> still no rebuild
    expect(activeVertexCount(getLineSegments(scene).geometry)).toBe(0);

    edges.setVisible(true);
    edges.update(); // rebuilds immediately since dirty was retained
    expect(activeVertexCount(getLineSegments(scene).geometry)).toBeGreaterThanOrEqual(24);
  });

  it('a slab (half=bottom) has its edges confined to the lower half of the cell (y ~ y+0.5)', () => {
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    world.stageMany([{ x: 0, y: 0, z: 0, before: null, after: packCell(1, 0) }]); // slab, code=0 => half='bottom'

    const edges = new VoxelEdges(scene, world, makeCatalog());
    edges.setVisible(true);
    edges.update();

    const [minY, maxY] = yRange(getLineSegments(scene).geometry);
    expect(minY).toBeCloseTo(0, 6);
    expect(maxY).toBeCloseTo(0.5, 6);
  });

  it('a slab (half=top) has its edges confined to the upper half of the cell (y+0.5 ~ y+1)', () => {
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    world.stageMany([{ x: 0, y: 0, z: 0, before: null, after: packCell(1, 1) }]); // slab, code=1 => half='top'

    const edges = new VoxelEdges(scene, world, makeCatalog());
    edges.setVisible(true);
    edges.update();

    const [minY, maxY] = yRange(getLineSegments(scene).geometry);
    expect(minY).toBeCloseTo(0.5, 6);
    expect(maxY).toBeCloseTo(1, 6);
  });

  it('dispose() removes the mesh from the scene', () => {
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    const edges = new VoxelEdges(scene, world, makeCatalog());
    expect(scene.children).toHaveLength(1);
    edges.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it('disables frustumCulled (#15 follow-up review fix: in-place mutation leaves boundingSphere permanently stale)', () => {
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    new VoxelEdges(scene, world, makeCatalog());
    expect(getLineSegments(scene).frustumCulled).toBe(false);
  });
});

describe('VoxelEdges incremental updates (#15 follow-up)', () => {
  function makeEdges(scene: THREE.Scene, world: VoxelWorld, catalog: BlockDef[]): VoxelEdges {
    const edges = new VoxelEdges(scene, world, catalog);
    world.subscribe((event) => edges.onWorldChange(toIndexChange(event)));
    edges.setVisible(true);
    return edges;
  }

  it('a single stage() addition reflects only the affected cell (incremental update path)', () => {
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    const edges = makeEdges(scene, world, makeCatalog());
    edges.update();

    world.stage({ x: 1, y: 2, z: 3, before: null, after: packCell(0, 0) });
    edges.update();

    const geometry = getLineSegments(scene).geometry;
    expect(activeVertexCount(geometry)).toBeGreaterThanOrEqual(24);
    const [minY, maxY] = yRange(geometry);
    expect(minY).toBeCloseTo(2, 6);
    expect(maxY).toBeCloseTo(3, 6);
  });

  it('deleting a middle cell compacts the remaining cells via swap-with-last', () => {
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    const edges = makeEdges(scene, world, makeCatalog());
    edges.update();

    world.stageMany([
      { x: 0, y: 0, z: 0, before: null, after: packCell(0, 0) },
      { x: 1, y: 5, z: 0, before: null, after: packCell(0, 0) },
      { x: 2, y: 0, z: 0, before: null, after: packCell(0, 0) },
    ]);
    edges.update();
    const geometry = getLineSegments(scene).geometry;
    const oneCellWidth = activeVertexCount(geometry) / 3; // width of 3 cells / 3 = the slot width of 1 cell

    // delete the middle one (x=1, y=5) -> both remaining cells are at y=0, so the y range should fall within [0,1]
    world.stage({ x: 1, y: 5, z: 0, before: packCell(0, 0), after: null });
    edges.update();

    expect(activeVertexCount(geometry)).toBe(oneCellWidth * 2); // 1 cell's worth of width × 2 remaining
    const [minY, maxY] = yRange(geometry);
    expect(minY).toBeCloseTo(0, 6);
    expect(maxY).toBeCloseTo(1, 6);
  });

  it('deleting multiple cells of the same slot width in the same event does not corrupt registry/order', () => {
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    const edges = makeEdges(scene, world, makeCatalog());
    edges.update();

    world.stageMany([
      { x: 0, y: 0, z: 0, before: null, after: packCell(0, 0) },
      { x: 1, y: 9, z: 0, before: null, after: packCell(0, 0) },
      { x: 2, y: 0, z: 0, before: null, after: packCell(0, 0) },
    ]);
    edges.update();
    const geometry = getLineSegments(scene).geometry;
    const oneCellWidth = activeVertexCount(geometry) / 3;

    // delete both ends (x=0, x=2) in the same stageMany = the same WorldChange event.
    // only the middle one (x=1, y=9) should survive
    world.stageMany([
      { x: 0, y: 0, z: 0, before: packCell(0, 0), after: null },
      { x: 2, y: 0, z: 0, before: packCell(0, 0), after: null },
    ]);
    edges.update();

    expect(activeVertexCount(geometry)).toBe(oneCellWidth);
    const [minY, maxY] = yRange(geometry);
    expect(minY).toBeCloseTo(9, 6);
    expect(maxY).toBeCloseTo(10, 6);

    // also verify that the surviving cell can still be incrementally updated correctly (would misbehave if the registry were corrupted)
    world.stage({ x: 1, y: 9, z: 0, before: packCell(0, 0), after: null });
    edges.update();
    expect(activeVertexCount(geometry)).toBe(0);
  });

  it('does not lose existing cell coordinates when an incremental addition exceeds capacity and resizes', () => {
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    const edges = makeEdges(scene, world, makeCatalog());
    edges.update();

    const N = 257; // exceeds VoxelEdges's INITIAL_CAPACITY(256) by 1 to trigger a resize
    for (let i = 0; i < N; i++) {
      world.stage({ x: 0, y: i, z: 0, before: null, after: packCell(0, 0) });
      edges.update();
    }

    const geometry = getLineSegments(scene).geometry;
    const oneCellWidth = activeVertexCount(geometry) / N;
    expect(oneCellWidth * N).toBe(activeVertexCount(geometry));

    // check that both the cell before the resize (y=0) and right after the resize (y=256) land in the correct y range
    const [minY, maxY] = yRange(geometry);
    expect(minY).toBeCloseTo(0, 6);
    expect(maxY).toBeCloseTo(257, 6); // from the bottom (0) of the y=0 cell to the top (257) of the y=256 cell
  });

  it('a voxel-only Document commit does not re-scan index.entries()', () => {
    const scene = new THREE.Scene();
    const catalog = makeCatalog();
    // #37 B1b: the sole source of mesh updates is WorldIndexChange (markDirty from Document events was removed)
    const doc = new DocumentFixture((i) => catalog[i]?.shape);
    const edges = new VoxelEdges(scene, doc.world, catalog);
    doc.index.subscribe((event) => edges.onWorldChange(event));
    edges.setVisible(true);
    edges.update();

    const entriesSpy = vi.spyOn(doc.world, 'entries');
    doc.applyEdits([place(1, 1, 1, packCell(0, 0))], null);
    edges.update();

    expect(entriesSpy).not.toHaveBeenCalled();
    expect(activeVertexCount(getLineSegments(scene).geometry)).toBeGreaterThanOrEqual(24);
  });

  it('replaceAll() does a full rebuild instead of tracking a diff', () => {
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    const edges = makeEdges(scene, world, makeCatalog());
    edges.update();

    world.replaceAll([[9, 9, 9, packCell(0, 0)]]);
    edges.update();

    const geometry = getLineSegments(scene).geometry;
    expect(activeVertexCount(geometry)).toBeGreaterThanOrEqual(24);
    const [minY, maxY] = yRange(geometry);
    expect(minY).toBeCloseTo(9, 6);
    expect(maxY).toBeCloseTo(10, 6);
  });

  it('performance regression guard: a single-cell edit on a large world is far faster than a full rebuild', () => {
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    const catalog = makeCatalog();
    const SIZE = 20; // 20^3 = 8,000 cells (edges has heavier vertex-copy overhead, so use a smaller scale than VoxelMesh)
    const edits: { x: number; y: number; z: number; before: null; after: number }[] = [];
    for (let x = 0; x < SIZE; x++) {
      for (let y = 0; y < SIZE; y++) {
        for (let z = 0; z < SIZE; z++) {
          edits.push({ x, y, z, before: null, after: packCell(0, 0) });
        }
      }
    }
    world.stageMany(edits);

    const edges = makeEdges(scene, world, catalog);
    edges.update();

    const t0 = performance.now();
    world.stage({ x: 0, y: 0, z: 0, before: packCell(0, 0), after: packCell(1, 0) });
    edges.update();
    const incrementalMs = performance.now() - t0;

    const t1 = performance.now();
    edges.markDirty();
    edges.update();
    const fullRebuildMs = performance.now() - t1;

    expect(incrementalMs).toBeLessThan(50);
    expect(incrementalMs).toBeLessThan(fullRebuildMs);
  });
});
