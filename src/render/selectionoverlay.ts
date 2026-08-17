import * as THREE from 'three';
import type { Document } from '../core/document';
import type { SelectionStore } from '../editor/selection';

/** Above this count, give up on InstancedMesh and show only the bbox wire (calling setMatrixAt on tens of thousands of boxes every time is slow) */
const INSTANCED_MAX = 20000;

const tmpMatrix = new THREE.Matrix4();
const tmpPosition = new THREE.Vector3();
const IDENTITY_QUATERNION = new THREE.Quaternion();
const ONE_SCALE = new THREE.Vector3(1, 1, 1);

/**
 * Selection highlight. Selection changes are interaction-driven (click / drag-confirm) rather
 * than per-frame, so unlike BlockTypeMesh in voxelmesh.ts, this doesn't do capacity doubling —
 * it just recreates and disposes an InstancedMesh on every rebuild (favoring simplicity;
 * further optimization would be overkill at this scale).
 */
export class SelectionOverlay {
  private dirty = true;
  private instancedMesh: THREE.InstancedMesh | null = null;
  private readonly bboxWire: THREE.LineSegments;
  /**
   * Parent node responsible only for translating the ghost (#37 B1b). Children (InstancedMesh /
   * bbox wire) are built once at the baseline position, and dragging just moves this `position`.
   *
   * Previously, `setDragOffset()` set `dirty` and `update()` would dispose/recreate the
   * InstancedMesh and reset every cell's matrix. Even after making group drag "a ghost preview
   * that doesn't move the source of truth," leaving it that way would still run an O(selection)
   * rebuild and allocation on every pointermove — just moving where the cost lands, not removing it.
   */
  private readonly root: THREE.Group;

  constructor(
    private scene: THREE.Scene,
    private doc: Document,
    private selection: SelectionStore,
  ) {
    this.root = new THREE.Group();
    this.scene.add(this.root);

    const box = new THREE.BoxGeometry(1, 1, 1);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    this.bboxWire = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: '#e8a33d' }));
    this.bboxWire.visible = false;
    this.root.add(this.bboxWire);

    this.doc.subscribe(() => {
      this.dirty = true;
    });
    this.selection.subscribe(() => {
      this.dirty = true;
    });
  }

  /**
   * Called by the selection tool during a drag-move preview. Pass null to clear the offset
   * (back to normal display). **Never triggers a rebuild** — just updates the parent node's position.
   */
  setDragOffset(offset: [number, number, number] | null): void {
    const [ox, oy, oz] = offset ?? [0, 0, 0];
    this.root.position.set(ox, oy, oz);
  }

  /** Called every frame. Only rebuilds when dirty */
  update(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.rebuild();
  }

  dispose(): void {
    this.disposeInstancedMesh();
    this.root.remove(this.bboxWire);
    this.bboxWire.geometry.dispose();
    (this.bboxWire.material as THREE.Material).dispose();
    this.scene.remove(this.root);
  }

  private disposeInstancedMesh(): void {
    if (!this.instancedMesh) return;
    this.root.remove(this.instancedMesh);
    this.instancedMesh.geometry.dispose();
    (this.instancedMesh.material as THREE.Material).dispose();
    this.instancedMesh.dispose(); // Frees InstancedMesh-specific buffers like instanceMatrix
    this.instancedMesh = null;
  }

  /** Children are always built at baseline coordinates. The drag offset lives on root's position */
  private rebuild(): void {
    const cells = this.selection.resolveCells();

    if (cells.size === 0) {
      this.disposeInstancedMesh();
      this.bboxWire.visible = false;
      return;
    }

    if (cells.size <= INSTANCED_MAX) {
      this.disposeInstancedMesh();
      const geometry = new THREE.BoxGeometry(1.02, 1.02, 1.02);
      const material = new THREE.MeshBasicMaterial({
        color: '#e8a33d',
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      });
      const mesh = new THREE.InstancedMesh(geometry, material, cells.size);
      mesh.frustumCulled = false;
      let i = 0;
      for (const key of cells) {
        const [x, y, z] = key.split(',').map(Number) as [number, number, number];
        tmpPosition.set(x + 0.5, y + 0.5, z + 0.5);
        tmpMatrix.compose(tmpPosition, IDENTITY_QUATERNION, ONE_SCALE);
        mesh.setMatrixAt(i, tmpMatrix);
        i++;
      }
      mesh.instanceMatrix.needsUpdate = true;
      this.root.add(mesh);
      this.instancedMesh = mesh;
      this.bboxWire.visible = false;
      return;
    }

    // Huge selection: recreating an InstancedMesh every time is slow, so show only the bbox wire
    this.disposeInstancedMesh();
    const box = this.selection.bbox();
    if (!box) {
      this.bboxWire.visible = false;
      return;
    }
    const [minX, minY, minZ] = box.min;
    const [maxX, maxY, maxZ] = box.max;
    this.bboxWire.scale.set(maxX - minX + 1.01, maxY - minY + 1.01, maxZ - minZ + 1.01);
    this.bboxWire.position.set((minX + maxX) / 2 + 0.5, (minY + maxY) / 2 + 0.5, (minZ + maxZ) / 2 + 0.5);
    this.bboxWire.visible = true;
  }
}
