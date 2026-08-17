import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createShapeGeometry } from '../src/render/geometry';
import { VOID_CELL, packCell } from '../src/core/orientation';
import { makeCellKey, type BlockDef } from '../src/core/types';
import type { Edit } from '../src/core/voxels';
import { VoxelWorld } from '../src/core/voxels';

import { VoxelEdges } from '../src/render/voxeledges';
import { VoxelMesh } from '../src/render/voxelmesh';
import { SelectionOverlay } from '../src/render/selectionoverlay';
import { SelectionStore } from '../src/editor/selection';
import { DocumentFixture } from './helpers/document-fixture';
import { toIndexChange } from './helpers/world-index-events';

/**
 * Large-scale scenario measurements (#35) that #33/#34 (correctness of incremental updates,
 * single-cell edit performance) can't catch, one of #15's completion criteria.
 */

// #35 review follow-up: wrap createShapeGeometry (the sole entry point where BlockTypeMesh
// creates geometry) without swapping out the implementation, so we can track the call count
// (= how many times a bucket/BlockTypeMesh gets created)
vi.mock('../src/render/geometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/render/geometry')>();
  return { ...actual, createShapeGeometry: vi.fn(actual.createShapeGeometry) };
});

function makeCatalog(): BlockDef[] {
  return [
    { id: 'test:a', nameJa: 'A', nameEn: 'A', category: 'misc', color: '#ff0000', shape: 'full', materialGroup: 'test' },
    { id: 'test:b', nameJa: 'B', nameEn: 'B', category: 'misc', color: '#00ff00', shape: 'full', materialGroup: 'test' },
  ];
}

function fillCube(world: VoxelWorld, size: number, catalogIndex = 0): void {
  const edits: Edit[] = [];
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      for (let z = 0; z < size; z++) {
        edits.push({ x, y, z, before: null, after: packCell(catalogIndex, 0) });
      }
    }
  }
  world.stageMany(edits);
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
}

/**
 * The performance contract for the ghost preview (#37 B1b design rev.8).
 *
 * The point of turning a group drag into "a ghost that never moves the source of truth" is to
 * eliminate the structural rebuild on every pointermove (p95 17.4ms at 22³, 230ms at 48³).
 * But if the overlay side just recreates the InstancedMesh on every move, the cost has merely
 * moved elsewhere — so we pin down both "it's fast" and "allocation does not increase" **through
 * the real wiring, `setDragOffset → update`**.
 */
describe('#37 B1b: performance contract of the ghost drag preview', () => {
  for (const count of [512, 1000]) {
    it(`p95 stays at or under 8ms across 60 pointermoves with ${count} cells selected (via the real setDragOffset → update wiring)`, () => {
      const scene = new THREE.Scene();
      const doc = new DocumentFixture();
      const cells: Array<[number, number, number, number]> = [];
      for (let i = 0; i < count; i++) cells.push([i % 32, Math.floor(i / 32), 0, packCell(0, 0)]);
      doc.setCells(cells);
      const selection = new SelectionStore(doc);
      const overlay = new SelectionOverlay(scene, doc, selection);
      selection.set(doc.cellSelection(...cells.map(([x, y, z]) => [x, y, z] as [number, number, number])));
      overlay.update(); // initial build (excluded from measurement)

      const samples: number[] = [];
      for (let i = 1; i <= 70; i++) {
        const t0 = performance.now();
        overlay.setDragOffset([i, 0, 0]);
        overlay.update();
        const ms = performance.now() - t0;
        if (i > 10) samples.push(ms); // discard the first 10 warm-up iterations
      }
      expect(samples).toHaveLength(60);
      expect(p95(samples)).toBeLessThanOrEqual(8);
    });
  }

  it('does not create additional geometry / material / InstancedMesh instances during pointermove', () => {
    const scene = new THREE.Scene();
    const doc = new DocumentFixture();
    const cells: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 512; i++) cells.push([i % 32, Math.floor(i / 32), 0, packCell(0, 0)]);
    doc.setCells(cells);
    const selection = new SelectionStore(doc);
    const overlay = new SelectionOverlay(scene, doc, selection);
    selection.set(doc.cellSelection(...cells.map(([x, y, z]) => [x, y, z] as [number, number, number])));
    overlay.update();

    const countInstanced = (): number =>
      scene.children.flatMap((c) => (c instanceof THREE.Group ? c.children : [c])).filter((c) => c instanceof THREE.InstancedMesh)
        .length;
    const before = countInstanced();
    const disposeSpy = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    disposeSpy.mockClear();

    for (let i = 1; i <= 60; i++) {
      overlay.setDragOffset([i, 0, 0]);
      overlay.update();
    }

    expect(countInstanced()).toBe(before); // nothing was recreated
    expect(disposeSpy).not.toHaveBeenCalled(); // nothing was disposed either = no allocation happened
    disposeSpy.mockRestore();
  });
});

describe('#15 follow-up: large-scale performance measurement (#35)', () => {
  it('frame time stays within budget for a 1,000-cell drag (1 batch) on top of an existing 10,648-cell base', () => {
    const scene = new THREE.Scene();
    const world = new VoxelWorld();
    const catalog = makeCatalog();

    fillCube(world, 22); // 22^3 = 10,648 cells, a typical base size for where drag operations happen

    const voxelMesh = new VoxelMesh(scene, world, catalog);
    const edges = new VoxelEdges(scene, world, catalog);
    edges.setVisible(true);
    world.subscribe((event) => {
      const indexEvent = toIndexChange(event);
      voxelMesh.onWorldChange(indexEvent);
      edges.onWorldChange(indexEvent);
    });
    voxelMesh.update();
    edges.update();
    // initial full rebuild (excluded from measurement)

    // feed 1,000 new placements into unused space as a single batch (equivalent to one frame's worth of EditSession.stagePreview)
    const dragEdits: Edit[] = [];
    for (let i = 0; i < 1000; i++) dragEdits.push({ x: 100 + i, y: 0, z: 0, before: null, after: packCell(0, 0) });

    const t0 = performance.now();
    world.stageMany(dragEdits);
    voxelMesh.update();
    edges.update();
    const elapsedMs = performance.now() - t0;

    // far from the ideal of 1 frame (16.6ms at 60fps), but this is an absolute threshold to catch
    // a performance regression like "a 1,000-cell batch takes hundreds of ms and the operation freezes"
    expect(elapsedMs).toBeLessThan(150);
  });

  describe('GPU resources (geometry/material/texture) do not grow without bound as edit count increases', () => {
    beforeEach(() => {
      vi.mocked(createShapeGeometry).mockClear();
    });

    it('the gap between creation and disposal counts for InstancedMesh count and geometry/material does not keep growing with edit count', () => {
      const scene = new THREE.Scene();
      const world = new VoxelWorld();
      const catalog = makeCatalog(); // 2 block types (a/b); since shape='full', material is always 1 per bucket

      // since vi.spyOn reuses an existing spy on the same prototype method across other it() blocks,
      // clear explicitly so call history doesn't carry over from a previous test
      const geometryDisposeSpy = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
      geometryDisposeSpy.mockClear();
      const materialDisposeSpy = vi.spyOn(THREE.MeshLambertMaterial.prototype, 'dispose');
      materialDisposeSpy.mockClear();

      const voxelMesh = new VoxelMesh(scene, world, catalog);
      world.subscribe((event) => voxelMesh.onWorldChange(toIndexChange(event)));
      voxelMesh.update();

      // repeatedly repaint the same cell alternating between type a ⇔ b (a typical pattern that
      // repeatedly creates/destroys buckets). We sample at every iteration to confirm that
      // "creation count - dispose count" (= live bucket count) never grows monotonically as edit
      // count increases (checking only the final state would miss the peak while running)
      let maxAliveBucketCount = 0;
      let maxInstancedMeshCount = 0;
      for (let i = 0; i < 2000; i++) {
        const catalogIndex = i % 2;
        world.stage({ x: 0, y: 0, z: 0, before: null, after: packCell(catalogIndex, 0) });
        voxelMesh.update();

        const created = vi.mocked(createShapeGeometry).mock.calls.length;
        const disposed = geometryDisposeSpy.mock.calls.length;
        const aliveBuckets = created - disposed;
        if (aliveBuckets > maxAliveBucketCount) maxAliveBucketCount = aliveBuckets;

        const instancedMeshCount = scene.children.filter((c) => c instanceof THREE.InstancedMesh).length;
        if (instancedMeshCount > maxInstancedMeshCount) maxInstancedMeshCount = instancedMeshCount;
      }

      // since we only ever repaint the same cell one at a time, exactly one bucket should ever be
      // alive at once (the previous bucket must always be disposed before the next one is created;
      // a leak would show aliveBucketCount growing along with the edit count)
      expect(maxAliveBucketCount).toBe(1);
      expect(maxInstancedMeshCount).toBe(1);

      // material should be disposed the same number of times as geometry (since shape='full' is
      // always 1 bucket = 1 geometry + 1 material, creation and disposal counts stay in sync)
      const totalGeometryCreated = vi.mocked(createShapeGeometry).mock.calls.length;
      const totalGeometryDisposed = geometryDisposeSpy.mock.calls.length;
      const totalMaterialDisposed = materialDisposeSpy.mock.calls.length;
      expect(totalMaterialDisposed).toBe(totalGeometryDisposed);
      // apart from the one bucket still alive at the end, everything else should be disposed
      expect(totalGeometryCreated - totalGeometryDisposed).toBe(1);
    });

    it('for textures (via TextureLoader) too, the gap between creation and disposal counts does not keep growing with edit count (#36 review follow-up)', async () => {
      // #36 review finding: test:a/test:b are absent from the textures.json manifest, so
      // tryLoadTexture() returns early and the texture creation/dispose path never ran at all.
      // Use ids that are registered in the manifest (both side-only, the noTop single-material
      // path) and swap in a fake that resolves TextureLoader.load synchronously, so we can
      // measure texture creation/dispose
      const catalog: BlockDef[] = [
        { id: 'minecraft:stone', nameJa: '石', nameEn: 'Stone', category: 'stone', color: '#ffffff', shape: 'full', materialGroup: 'stone' },
        { id: 'minecraft:cobblestone', nameJa: '丸石', nameEn: 'Cobblestone', category: 'stone', color: '#ffffff', shape: 'full', materialGroup: 'stone' },
      ];

      const loadSpy = vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(function (
        this: THREE.TextureLoader,
        _url,
        onLoad,
      ) {
        const tex = new THREE.Texture<HTMLImageElement>();
        onLoad?.(tex);
        return tex;
      });
      const textureDisposeSpy = vi.spyOn(THREE.Texture.prototype, 'dispose');
      // BufferGeometry.dispose is already spyOn'd in other it() blocks, so clear its history explicitly
      const geometryDisposeSpy = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
      geometryDisposeSpy.mockClear();

      const scene = new THREE.Scene();
      const world = new VoxelWorld();
      const voxelMesh = new VoxelMesh(scene, world, catalog);
      world.subscribe((event) => voxelMesh.onWorldChange(toIndexChange(event)));
      voxelMesh.update();

      // texture loading is async (a Promise), so wait for it to finish before moving to the next
      // edit (firing edits back-to-back without waiting would make "does the bucket get disposed
      // before loading finishes" depend on edit speed, making the measurement flaky)
      const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

      const ROUNDS = 20;
      let maxAliveTextures = 0;
      let maxAliveGeometries = 0;
      for (let i = 0; i < ROUNDS; i++) {
        const catalogIndex = i % 2;
        world.stage({ x: 0, y: 0, z: 0, before: null, after: packCell(catalogIndex, 0) });
        voxelMesh.update();
        await flushMicrotasks(); // wait for this round's texture load to finish

        const aliveTextures = loadSpy.mock.calls.length - textureDisposeSpy.mock.calls.length;
        if (aliveTextures > maxAliveTextures) maxAliveTextures = aliveTextures;
        const aliveGeometries = vi.mocked(createShapeGeometry).mock.calls.length - geometryDisposeSpy.mock.calls.length;
        if (aliveGeometries > maxAliveGeometries) maxAliveGeometries = aliveGeometries;
      }

      expect(loadSpy).toHaveBeenCalledTimes(ROUNDS); // load() is called once per bucket creation
      // in each round, the bucket is only ever disposed after its load finishes (since we wait for
      // it), so neither texture nor geometry ever grows past "the one bucket currently alive"
      expect(maxAliveTextures).toBe(1);
      expect(maxAliveGeometries).toBe(1);
    });

    it('even in the reverse order where a texture load completes after its bucket was already disposed, the late-arriving texture still gets disposed and does not keep growing (#36 review follow-up)', async () => {
      // #36 review finding: the previous test always waits for the load to finish before moving to
      // the next edit each round, so only the normal order — "load completes → applyMaterial → the
      // next edit disposes it" — ever runs. The `if (this.disposed) sideTex.dispose()` branch in
      // BlockTypeMesh.tryLoadTexture() (voxelmesh.ts:82) only ever executes in the reverse order,
      // "the bucket is disposed first, and the texture load completes later." That reverse order
      // can realistically happen under fast, back-to-back edits like 2,000 alternating updates, so
      // we use a deferred fake loader that holds the onLoad callback, swaps buckets several times,
      // and then resolves them all at once to pin down the reverse-order behavior.
      const catalog: BlockDef[] = [
        { id: 'minecraft:stone', nameJa: '石', nameEn: 'Stone', category: 'stone', color: '#ffffff', shape: 'full', materialGroup: 'stone' },
        { id: 'minecraft:cobblestone', nameJa: '丸石', nameEn: 'Cobblestone', category: 'stone', color: '#ffffff', shape: 'full', materialGroup: 'stone' },
      ];

      // a fake loader that never calls onLoad immediately, holding it in a pending queue instead.
      // Just like the real TextureLoader.load(), it synchronously creates and returns a Texture
      // instance (the caller doesn't use the return value, using the tex from onLoad instead, but
      // we keep the signature matching)
      const pending: Array<{ onLoad: (tex: THREE.Texture<HTMLImageElement>) => void; tex: THREE.Texture<HTMLImageElement> }> = [];
      const loadSpy = vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(function (
        this: THREE.TextureLoader,
        _url,
        onLoad,
      ) {
        const tex = new THREE.Texture<HTMLImageElement>();
        if (onLoad) pending.push({ onLoad, tex });
        return tex;
      });
      loadSpy.mockClear(); // vi.spyOn also carries over call history from other it() blocks, so clear explicitly
      const textureDisposeSpy = vi.spyOn(THREE.Texture.prototype, 'dispose');
      textureDisposeSpy.mockClear();
      const geometryDisposeSpy = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
      geometryDisposeSpy.mockClear();

      const scene = new THREE.Scene();
      const world = new VoxelWorld();
      const voxelMesh = new VoxelMesh(scene, world, catalog);
      world.subscribe((event) => voxelMesh.onWorldChange(toIndexChange(event)));
      voxelMesh.update();
      pending.length = 0; // exclude the load() call from the initial fallback creation
      loadSpy.mockClear(); // also exclude the call history from the update() above

      const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

      // alternate editing the same cell between a/b without ever waiting for a load to finish
      // (deliberately creating a situation where buckets get disposed many times before their
      // load finishes, to force the reverse order)
      const SWAPS = 5;
      for (let i = 0; i < SWAPS; i++) {
        const catalogIndex = i % 2;
        world.stage({ x: 0, y: 0, z: 0, before: null, after: packCell(catalogIndex, 0) });
        voxelMesh.update();
      }

      // at this point SWAPS buckets have been created, and SWAPS-1 of them have already been
      // disposed by the following edit (dispose() runs synchronously). Not a single texture load
      // has completed yet (they're all still sitting in pending)
      expect(loadSpy).toHaveBeenCalledTimes(SWAPS);
      expect(pending.length).toBe(SWAPS);
      expect(textureDisposeSpy).not.toHaveBeenCalled(); // while loading is still incomplete, it's outside disposeMaterial()'s reach

      // now resolve them all at once (reproducing a situation where deferred loads all complete in a batch afterward)
      const toResolve = [...pending];
      pending.length = 0;
      toResolve.forEach(({ onLoad, tex }) => onLoad(tex));
      await flushMicrotasks();

      // the textures for the already-disposed buckets (SWAPS-1 of them) get disposed immediately by
      // tryLoadTexture()'s disposed check; only the texture for the one bucket still alive should remain
      const aliveTextures = loadSpy.mock.calls.length - textureDisposeSpy.mock.calls.length;
      expect(textureDisposeSpy).toHaveBeenCalledTimes(SWAPS - 1);
      expect(aliveTextures).toBe(1);

      // once the last living bucket is also disposed, textures should drop to 0 as well
      // (the final confirmation that there's no regression where "only late-arriving textures leak, one per edit")
      world.clear();
      voxelMesh.update();
      expect(loadSpy.mock.calls.length - textureDisposeSpy.mock.calls.length).toBe(0);
    });
  });
});

/**
 * The cost of a void cell's outline (#113 stage 3) must not push the cost of ordinary edits up to
 * the whole world's scale.
 *
 * `VoidEdges` **follows every world change regardless of kind** (since toggling a group's
 * visibility or reordering it also changes how voids look). That's why `voidCells()` gets called
 * "every time an ordinary block is placed." If that scanned the entire stack, then **even in a
 * world with zero voids**, every single-cell edit would sweep the whole world
 * (#122 review: measured about 3ms per call with 100,000 real blocks).
 */
describe('#113 stage 3: enumerating voids does not scale with world size', () => {
  /** builds a world of real blocks only (places zero voids) */
  function worldWithBlocks(size: number): DocumentFixture {
    const doc = new DocumentFixture(() => 'full');
    const cells: [number, number, number, number][] = [];
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        for (let z = 0; z < size; z++) cells.push([x, y, z, packCell(0, 0)]);
      }
    }
    doc.setCells(cells);
    return doc;
  }

  it('with zero voids, enumeration cost stays flat even at 1000x the world size (does not regress to a full stack scan)', () => {
    const small = worldWithBlocks(5); // 125 cells
    const large = worldWithBlocks(50); // 125,000 cells
    expect([...large.rawIndex.entries()]).toHaveLength(125_000); // precondition: actually larger

    const measure = (doc: DocumentFixture): number => {
      const t0 = performance.now();
      for (let i = 0; i < 50; i++) expect([...doc.rawIndex.voidCells()]).toHaveLength(0);
      return performance.now() - t0;
    };
    measure(small); // JIT warm-up (some environments are extremely slow on the first call)
    const smallMs = measure(small);
    const largeMs = measure(large);

    // a regression to a full stack scan would show a 1000x gap. This still catches it by orders of
    // magnitude even after absorbing constant-factor noise
    expect(largeMs).toBeLessThan(Math.max(smallMs * 20, 5));
  });

  it('the enumerated count is determined solely by the number of voids (independent of the world\'s real block count)', () => {
    const doc = worldWithBlocks(50);
    doc.insertGroup({ id: 'hole', name: 'hole', parentId: null, childIds: [] }, 1);
    doc.setOwnerCells('hole', [[makeCellKey(0, 0, 0), VOID_CELL]]);

    expect([...doc.rawIndex.voidCells()]).toEqual([[0, 0, 0]]);
  });
});
