import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { SelectionOverlay } from '../src/render/selectionoverlay';
import { SelectionStore } from '../src/editor/selection';
import { DocumentFixture } from './helpers/document-fixture';

/**
 * Precondition tests for ghost preview. Even making group drag a "ghost that
 * doesn't move the source of truth" only relocates where the weight sits if the overlay
 * side rebuilds the InstancedMesh on every pointermove, so this pins down structurally
 * that `setDragOffset()` never triggers a rebuild.
 */

function setup(cells: Array<[number, number, number]>): {
  scene: THREE.Scene;
  overlay: SelectionOverlay;
  selection: SelectionStore;
  doc: DocumentFixture;
} {
  const scene = new THREE.Scene();
  const doc = new DocumentFixture();
  // building a ref-based selection needs an actual entity (so re-projection via worldOf works)
  doc.setCells(cells.map(([x, y, z]) => [x, y, z, 0] as [number, number, number, number]));
  const selection = new SelectionStore(doc);
  const overlay = new SelectionOverlay(scene, doc, selection);
  selection.set(doc.cellSelection(...cells));
  overlay.update();
  return { scene, overlay, selection, doc };
}

/** Extracts the overlay's root (the Group responsible for translation) from the scene */
function rootOf(scene: THREE.Scene): THREE.Group {
  const group = scene.children.find((c): c is THREE.Group => c instanceof THREE.Group);
  if (!group) throw new Error('overlay root is not in the scene');
  return group;
}

function instancedMeshOf(scene: THREE.Scene): THREE.InstancedMesh | undefined {
  return rootOf(scene).children.find((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh);
}

describe('SelectionOverlay — ghost translation', () => {
  it('setDragOffset does not rebuild the InstancedMesh, keeping the same instance', () => {
    const { scene, overlay } = setup([[0, 0, 0], [1, 0, 0], [2, 0, 0]]);
    const before = instancedMeshOf(scene);
    expect(before).toBeDefined();
    const disposeSpy = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    disposeSpy.mockClear();

    for (let i = 1; i <= 30; i++) {
      overlay.setDragOffset([i, 0, 0]);
      overlay.update(); // no rebuild happens even after running update every frame
    }

    expect(instancedMeshOf(scene)).toBe(before); // same object = not regenerated
    expect(disposeSpy).not.toHaveBeenCalled(); // no geometry disposal either
    disposeSpy.mockRestore();
  });

  it('setDragOffset only moves the parent Group\'s position (the children\'s instance matrix stays at baseline)', () => {
    const { scene, overlay } = setup([[0, 0, 0], [5, 2, -3]]);
    const mesh = instancedMeshOf(scene)!;
    const baseline = new THREE.Matrix4();
    mesh.getMatrixAt(0, baseline);

    overlay.setDragOffset([4, -1, 7]);
    overlay.update();

    expect(rootOf(scene).position.toArray()).toEqual([4, -1, 7]);
    const after = new THREE.Matrix4();
    mesh.getMatrixAt(0, after);
    expect(after.elements).toEqual(baseline.elements); // the children have not moved
  });

  it('setDragOffset(null) returns to the origin', () => {
    const { scene, overlay } = setup([[0, 0, 0]]);
    overlay.setDragOffset([9, 9, 9]);
    overlay.setDragOffset(null);
    expect(rootOf(scene).position.toArray()).toEqual([0, 0, 0]);
  });

  it('rebuilds when the selection changes (the dirty path is still alive)', () => {
    const { scene, overlay, selection, doc } = setup([[0, 0, 0], [1, 0, 0]]);
    selection.set(doc.cellSelection([0, 0, 0]));
    overlay.update();
    const before = instancedMeshOf(scene);

    selection.set(doc.cellSelection([0, 0, 0], [1, 0, 0]));
    overlay.update();

    const after = instancedMeshOf(scene);
    expect(after).not.toBe(before); // rebuilt
    expect(after!.count).toBe(2);
  });

  it('the bbox fallback for a huge selection is also a child of the same root, and moves together with offset', () => {
    const cells: Array<[number, number, number]> = [];
    for (let i = 0; i < 20001; i++) cells.push([i % 500, Math.floor(i / 500), 0]);
    const { scene, overlay } = setup(cells);

    expect(instancedMeshOf(scene)).toBeUndefined(); // falls back to wire above INSTANCED_MAX
    const wire = rootOf(scene).children.find((c): c is THREE.LineSegments => c instanceof THREE.LineSegments);
    expect(wire?.visible).toBe(true);

    const wirePositionBefore = wire!.position.clone();
    overlay.setDragOffset([3, 0, 0]);
    overlay.update();

    expect(rootOf(scene).position.toArray()).toEqual([3, 0, 0]);
    expect(wire!.position.toArray()).toEqual(wirePositionBefore.toArray()); // the child itself does not move
  });

  it('dispose removes the root and its children from the scene', () => {
    const { scene, overlay } = setup([[0, 0, 0]]);
    expect(scene.children.some((c) => c instanceof THREE.Group)).toBe(true);
    overlay.dispose();
    expect(scene.children.some((c) => c instanceof THREE.Group)).toBe(false);
  });
});
