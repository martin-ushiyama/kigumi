import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { encodeOrientation, packCell } from '../src/core/orientation';
import type { BlockDef } from '../src/core/types';
import { VoxelWorld } from '../src/core/voxels';
import { VoxelMesh } from '../src/render/voxelmesh';
import { DocumentFixture, place } from './helpers/document-fixture';
import { toIndexChange } from './helpers/world-index-events';

function makeCatalog(): BlockDef[] {
  return [
    { id: 'test:a', nameJa: 'A', nameEn: 'A', category: 'misc', color: '#ff0000', shape: 'full', materialGroup: 'test' },
    { id: 'test:b', nameJa: 'B', nameEn: 'B', category: 'misc', color: '#00ff00', shape: 'full', materialGroup: 'test' },
    { id: 'test:stairs', nameJa: '階段', nameEn: 'Stairs', category: 'misc', color: '#0000ff', shape: 'stairs', materialGroup: 'test' },
  ];
}

/** VoxelMesh does not subscribe to world itself (main.ts's composition root wires it up),
 *  so the test does the same wiring. */
function makeMesh(scene: THREE.Scene, world: VoxelWorld, catalog: BlockDef[]): VoxelMesh {
  const mesh = new VoxelMesh(scene, world, catalog);
  world.subscribe((event) => mesh.onWorldChange(toIndexChange(event)));
  return mesh;
}

function getInstancedMeshes(scene: THREE.Scene): THREE.InstancedMesh[] {
  return scene.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh);
}

function instancePosition(mesh: THREE.InstancedMesh, index: number): THREE.Vector3 {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(index, m);
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  m.decompose(pos, quat, scale);
  return pos;
}

describe('VoxelMesh differential update', () => {
  it('adding 1 cell via stage() reflects only that cell as an instance', () => {
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    const mesh = makeMesh(scene, world, makeCatalog());
    mesh.update(); // initial (empty) rebuild

    world.stage({ x: 1, y: 2, z: 3, before: null, after: packCell(0, 0) });
    mesh.update();

    const meshes = getInstancedMeshes(scene);
    expect(meshes).toHaveLength(1);
    expect(meshes[0]!.count).toBe(1);
    const pos = instancePosition(meshes[0]!, 0);
    expect([pos.x, pos.y, pos.z]).toEqual([1.5, 2.5, 3.5]);
  });

  it('deleting a middle cell packs the remaining cell instances via swap-with-last', () => {
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    const mesh = makeMesh(scene, world, makeCatalog());
    mesh.update();

    world.stageMany([
      { x: 0, y: 0, z: 0, before: null, after: packCell(0, 0) },
      { x: 1, y: 0, z: 0, before: null, after: packCell(0, 0) },
      { x: 2, y: 0, z: 0, before: null, after: packCell(0, 0) },
    ]);
    mesh.update();
    const meshes = getInstancedMeshes(scene);
    expect(meshes[0]!.count).toBe(3);

    // delete the middle one (x=1)
    world.stage({ x: 1, y: 0, z: 0, before: packCell(0, 0), after: null });
    mesh.update();

    expect(meshes[0]!.count).toBe(2);
    const xs = [0, 1].map((i) => instancePosition(meshes[0]!, i).x).sort();
    expect(xs).toEqual([0.5, 2.5]);
  });

  it('an edit that changes bucket (block type change) leaves the old bucket and moves to the new one', () => {
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    const mesh = makeMesh(scene, world, makeCatalog());
    mesh.update();

    world.stage({ x: 0, y: 0, z: 0, before: null, after: packCell(0, 0) });
    mesh.update();
    expect(getInstancedMeshes(scene)).toHaveLength(1);

    // catalogIndex 0 → 1 (bucket key changes; the old bucket becomes empty and is discarded)
    world.stage({ x: 0, y: 0, z: 0, before: packCell(0, 0), after: packCell(1, 0) });
    mesh.update();

    const meshes = getInstancedMeshes(scene);
    expect(meshes).toHaveLength(1); // old bucket discarded + new bucket created, never both at once
    expect(meshes[0]!.count).toBe(1);
  });

  it('an orientation change within the same bucket (stairs rotation) updates only the instance transform', () => {
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    const mesh = makeMesh(scene, world, makeCatalog());
    mesh.update();

    const before = packCell(2, encodeOrientation({ shape: 'stairs', weirdoDirection: 0, upsideDown: false }));
    world.stage({ x: 4, y: 4, z: 4, before: null, after: before });
    mesh.update();
    expect(getInstancedMeshes(scene)).toHaveLength(1);

    // change only weirdoDirection (upsideDown unchanged → bucket key unchanged)
    const after = packCell(2, encodeOrientation({ shape: 'stairs', weirdoDirection: 2, upsideDown: false }));
    world.stage({ x: 4, y: 4, z: 4, before, after });
    mesh.update();

    const meshes = getInstancedMeshes(scene);
    expect(meshes).toHaveLength(1); // bucket count unchanged (handled by the differential update)
    expect(meshes[0]!.count).toBe(1);
  });

  it('replaceAll() does not track diffs and rebuilds everything', () => {
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    const mesh = makeMesh(scene, world, makeCatalog());
    mesh.update();

    world.replaceAll([
      [9, 9, 9, packCell(1, 0)],
      [10, 9, 9, packCell(1, 0)],
    ]);
    mesh.update();

    const meshes = getInstancedMeshes(scene);
    expect(meshes).toHaveLength(1);
    expect(meshes[0]!.count).toBe(2);
  });

  it('clear() removes all instances', () => {
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    const mesh = makeMesh(scene, world, makeCatalog());
    mesh.update();

    world.stageMany([
      { x: 0, y: 0, z: 0, before: null, after: packCell(0, 0) },
      { x: 1, y: 0, z: 0, before: null, after: packCell(0, 0) },
    ]);
    mesh.update();
    expect(getInstancedMeshes(scene)[0]!.count).toBe(2);

    world.clear();
    mesh.update();
    expect(getInstancedMeshes(scene)).toHaveLength(0);
  });

  it('performance regression detection: editing a single cell in a large world is significantly faster than a full rebuild', () => {
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    const catalog = makeCatalog();
    const SIZE = 30; // 30^3 = 27,000 cells
    const edits: { x: number; y: number; z: number; before: null; after: number }[] = [];
    for (let x = 0; x < SIZE; x++) {
      for (let y = 0; y < SIZE; y++) {
        for (let z = 0; z < SIZE; z++) {
          edits.push({ x, y, z, before: null, after: packCell(0, 0) });
        }
      }
    }
    world.stageMany(edits);

    const mesh = makeMesh(scene, world, catalog);
    mesh.update(); // initial full rebuild (excluded from measurement)

    const t0 = performance.now();
    world.stage({ x: 0, y: 0, z: 0, before: packCell(0, 0), after: packCell(1, 0) });
    mesh.update();
    const incrementalMs = performance.now() - t0;

    const t1 = performance.now();
    mesh.markDirty(); // force a full rebuild (comparison baseline)
    mesh.update();
    const fullRebuildMs = performance.now() - t1;

    // absolute threshold: editing 1 cell in a 27,000-cell world taking tens of ms or more is a sign of performance regression
    expect(incrementalMs).toBeLessThan(50);
    // relative threshold: should reliably be faster than a full rebuild (the whole point of the differential update)
    expect(incrementalMs).toBeLessThan(fullRebuildMs);
  });

  it('deleting multiple cells in the same bucket simultaneously within the same event (stageMany) does not corrupt registry/order', () => {
    // Review finding: if removeFromBucket recomputes the destination instance from world.get(),
    // registry/order goes inconsistent when the swap-source cell itself is also a deletion
    // target within the same batch.
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    const mesh = makeMesh(scene, world, makeCatalog());
    mesh.update();

    world.stageMany([
      { x: 0, y: 0, z: 0, before: null, after: packCell(0, 0) },
      { x: 1, y: 0, z: 0, before: null, after: packCell(0, 0) },
      { x: 2, y: 0, z: 0, before: null, after: packCell(0, 0) },
    ]);
    mesh.update();
    const meshes = getInstancedMeshes(scene);
    expect(meshes[0]!.count).toBe(3);

    // delete both ends (x=0, x=2) simultaneously in the same stageMany = the same WorldChange event
    world.stageMany([
      { x: 0, y: 0, z: 0, before: packCell(0, 0), after: null },
      { x: 2, y: 0, z: 0, before: packCell(0, 0), after: null },
    ]);
    mesh.update();

    expect(meshes[0]!.count).toBe(1);
    const pos = instancePosition(meshes[0]!, 0);
    expect([pos.x, pos.y, pos.z]).toEqual([1.5, 0.5, 0.5]); // only x=1 survives

    // if the registry were corrupted, the next edit to the surviving cell would misbehave here
    world.stage({ x: 1, y: 0, z: 0, before: packCell(0, 0), after: null });
    mesh.update();
    expect(getInstancedMeshes(scene)).toHaveLength(0); // bucket becomes empty and is discarded
  });

  it('incremental additions that resize past capacity (256) do not lose the coordinates of existing instances', () => {
    // Review finding: the original resize() did not copy existing instance data into the new
    // mesh. This never surfaced back when it was rebuild()-only, since every instance was
    // re-set via setInstance() right after every resize; but a differential addition only calls
    // setInstance() for the single new instance, so the moment capacity was exceeded, every
    // existing instance vanished to its initial state (the origin).
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    const mesh = makeMesh(scene, world, makeCatalog());
    mesh.update();

    const N = 257; // exceeds BlockTypeMesh's INITIAL_CAPACITY(256) by 1, triggering a resize
    for (let i = 0; i < N; i++) {
      world.stage({ x: i, y: 0, z: 0, before: null, after: packCell(0, 0) });
      mesh.update(); // differential update one at a time
    }

    const meshes = getInstancedMeshes(scene);
    expect(meshes).toHaveLength(1);
    expect(meshes[0]!.count).toBe(N);
    // are the coordinates of instances added before the resize (before capacity=256 was reached) preserved?
    for (const i of [0, 1, 100, 255]) {
      const pos = instancePosition(meshes[0]!, i);
      expect([pos.x, pos.y, pos.z]).toEqual([i + 0.5, 0.5, 0.5]);
    }
    // is the 257th (index 256), the one that triggered the resize, also set correctly?
    const lastPos = instancePosition(meshes[0]!, 256);
    expect([lastPos.x, lastPos.y, lastPos.z]).toEqual([256.5, 0.5, 0.5]);
  });
});

describe('VoxelMesh × Document integration (invalidate is unified into one path)', () => {
  /**
   * Reproduces the actual wiring from main.ts (composition root). The sole
   * source of mesh updates is `WorldIndexChange` — markDirty from the Document event side was
   * removed. A commit with voxel ops only makes the index notify 'cells' and becomes a
   * differential update; a commit that includes structural ops makes the index fully rebuild →
   * notify 'replaceAll', and the mesh also fully rebuilds.
   */
  function wireLikeMain(doc: DocumentFixture, mesh: VoxelMesh): void {
    doc.index.subscribe((event) => mesh.onWorldChange(event));
  }

  it('a voxel-only Document commit does not fully rebuild VoxelMesh (does not rescan index.entries())', () => {
    const scene = new THREE.Scene();
    const catalog = makeCatalog();
    const doc = new DocumentFixture((i) => catalog[i]?.shape);
    const mesh = new VoxelMesh(scene, doc.world, catalog);
    wireLikeMain(doc, mesh);
    mesh.update(); // initial rebuild (excluded from measurement)

    const entriesSpy = vi.spyOn(doc.world, 'entries');
    doc.applyEdits([place(1, 1, 1, packCell(0, 0))], null);
    mesh.update();

    // a full rebuild calls entries(). If it wasn't called, that's proof the differential update path was taken
    expect(entriesSpy).not.toHaveBeenCalled();
    expect(getInstancedMeshes(scene)[0]!.count).toBe(1);
  });

  it('a Document commit that includes a structural op (e.g. creating a group) fully rebuilds VoxelMesh', () => {
    const scene = new THREE.Scene();
    const catalog = makeCatalog();
    const doc = new DocumentFixture((i) => catalog[i]?.shape);
    const mesh = new VoxelMesh(scene, doc.world, catalog);
    wireLikeMain(doc, mesh);
    mesh.update();

    const entriesSpy = vi.spyOn(doc.world, 'entries');
    doc.applyTransaction({
      ops: [{ kind: 'createGroup', node: { id: 'g1', name: 'Test', parentId: null, childIds: [] }, index: 0 }],
    });
    mesh.update();

    expect(entriesSpy).toHaveBeenCalled();
  });
});
