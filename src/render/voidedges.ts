import * as THREE from 'three';
import type { Cell } from '../core/cell';
import type { WorldIndexChange } from '../core/worldindex';

/** Outline for a single void cell (a cube's 12 edges = 24 vertices = 72 floats) */
const FLOATS_PER_CELL = 72;
const INITIAL_CAPACITY = 64; // Void cells are used for "punching holes," so this initial value assumes far fewer than real blocks

/** Edge vertices of a unit cube centered at the cell's origin (line segment pairs, 24 vertices) */
const UNIT_EDGES = (() => {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const edges = new THREE.EdgesGeometry(box);
  box.dispose();
  const pos = edges.getAttribute('position');
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    out[i * 3] = pos.getX(i);
    out[i * 3 + 1] = pos.getY(i);
    out[i * 3 + 2] = pos.getZ(i);
  }
  edges.dispose();
  return out;
})();

/** Minimal contract using only `voidCells()`, so the renderer doesn't need to depend on all of WorldIndex */
export interface VoidCellSource {
  voidCells(): IterableIterator<Cell>;
}

/**
 * Outline overlay for void cells.
 *
 * Void cells never win = they are **never drawn**, so without this there's no on-screen cue at
 * all. The grab path (`selectableRefAt`) already returns void entries so hit-testing works, but
 * if there's no way to see where to point, it can't really be grabbed in practice. This is the
 * premise behind "a hole can be moved later."
 *
 * **Not toggled by display mode**. To avoid introducing a new mode-dependent
 * quirk where it's ungrabbable only in texture mode. If it gets in the way, hiding that group
 * in the layers panel makes it disappear (`voidCells()` excludes effectiveHidden).
 *
 * A void's raw value is always `VOID_CELL` (orientation code 0), so there's only one shape:
 * a cube. It doesn't need per-shape caching or fixed-length-slot incremental updates like
 * VoxelEdges (the count is small enough that a full rebuild is sufficient).
 */
export class VoidEdges {
  private lineSegments: THREE.LineSegments;
  private dirty = true;
  private capacity = INITIAL_CAPACITY;
  private positions: Float32Array;
  private visible = true;

  constructor(
    private scene: THREE.Scene,
    private index: VoidCellSource,
  ) {
    this.positions = new Float32Array(this.capacity * FLOATS_PER_CELL);
    const material = new THREE.LineBasicMaterial({
      color: '#e8a33d',
      transparent: true,
      opacity: 0.9,
      // The back face is missing inside a hole, so if the outline gets hidden behind another
      // block, its position is lost. Always draw it in front to keep "there's a void here" visible
      depthTest: false,
      depthWrite: false,
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setDrawRange(0, 0); // Don't draw the pre-allocated unused region (same reason as VoxelEdges)
    this.lineSegments = new THREE.LineSegments(geometry, material);
    this.lineSegments.renderOrder = 5; // Keeps ordering stable among other depthTest:false objects
    // position is mutated in-place on incremental updates, so boundingSphere goes stale.
    // Disable it so stale bounds don't cause it to be culled by mistake (same as VoxelEdges / VoxelMesh)
    this.lineSegments.frustumCulled = false;
    this.scene.add(this.lineSegments);
  }

  /**
   * Whether to show the outline.
   *
   * Heavy use of void cells fills the screen with lines and obscures the shape being built.
   * The cue is needed while placing, but gets in the way when viewing the whole thing.
   *
   * **Rebuilding continues even while hidden.** It's simpler to keep the small-count-assuming
   * design as-is than to carry over changes accumulated while hidden and reconcile them on
   * re-show (this way, re-showing never surfaces a stale shape)
   */
  setVisible(v: boolean): void {
    this.visible = v;
    this.lineSegments.visible = v;
  }

  /**
   * WorldIndex content change. **Voids can gain or lose members at coordinates that never
   * appear in the cells diff** (a group's display toggle or reordering can change what's in
   * effect), so this always does a full rebuild regardless of event kind. Given the
   * small-count design assumption, incremental-update complexity isn't worth introducing.
   */
  onWorldChange(_event: WorldIndexChange): void {
    this.dirty = true;
  }

  /** For factors other than world (e.g. tree ops) */
  markDirty(): void {
    this.dirty = true;
  }

  /** Called every frame. Only rebuilds when dirty */
  update(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.rebuild();
  }

  dispose(): void {
    this.scene.remove(this.lineSegments);
    this.lineSegments.geometry.dispose();
    (this.lineSegments.material as THREE.Material).dispose();
  }

  private rebuild(): void {
    const cells = [...this.index.voidCells()];
    this.ensureCapacity(cells.length);
    for (let i = 0; i < cells.length; i++) {
      const [x, y, z] = cells[i]!;
      const base = i * FLOATS_PER_CELL;
      for (let v = 0; v < FLOATS_PER_CELL; v += 3) {
        this.positions[base + v] = UNIT_EDGES[v]! + x + 0.5;
        this.positions[base + v + 1] = UNIT_EDGES[v + 1]! + y + 0.5;
        this.positions[base + v + 2] = UNIT_EDGES[v + 2]! + z + 0.5;
      }
    }
    const attribute = this.lineSegments.geometry.getAttribute('position') as THREE.BufferAttribute;
    attribute.needsUpdate = true;
    this.lineSegments.geometry.setDrawRange(0, cells.length * (FLOATS_PER_CELL / 3));
  }

  /** Doubles capacity as needed and swaps out the geometry (a full rewrite always follows a resize) */
  private ensureCapacity(cellCount: number): void {
    if (cellCount <= this.capacity) return;
    while (this.capacity < cellCount) this.capacity *= 2;
    this.positions = new Float32Array(this.capacity * FLOATS_PER_CELL);
    this.lineSegments.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
  }
}
