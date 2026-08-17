import * as THREE from 'three';
import { decodeOrientation, unpackCell } from '../core/orientation';
import type { BlockDef } from '../core/types';
import { parseCellKey } from '../core/types';
import { makeCellKey } from '../core/types';
import type { WorldIndexChange } from '../core/worldindex';
import type { WorldReader } from '../core/voxels';
import { createShapeGeometry, slabHalfOffset, weirdoDirectionToYRotation } from './geometry';

const tmpVec = new THREE.Vector3();
const tmpQuaternion = new THREE.Quaternion();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const INITIAL_CAPACITY = 256; // In cell units (the position buffer is capacity * floatsPerCell floats)

/**
 * Outline overlay for flat display mode. Merges every cell's edges into a single
 * LineSegments and draws them in one go (cheap: 1 draw call even for thousands of cells).
 *
 * Caches the per-shape local edge vertices (rotation/offset already applied, cell position not
 * yet added) under a `shape:upsideDown:orientationCode` key, so rebuild only needs an array
 * copy plus adding the cell position (shape geometry is only generated for a key the first time
 * it's seen).
 *
 * The vertex count per cell varies by shape (full/slab/stairs), but we use the
 * max across the whole catalog, `floatsPerCell`, as a fixed slot width shared by all cells
 * (any shortfall is padded with a degenerate edge — the first vertex's coordinates repeated,
 * i.e. a zero-length segment — which stays invisible and harmless). Splitting into per-shape
 * buckets (separate objects) like VoxelMesh does would increase draw calls, defeating the
 * "cheap: 1 draw call" design goal, so this stays a single LineSegments and achieves per-cell
 * incremental updates via fixed-length slots + swap-with-last.
 */
export class VoxelEdges {
  private lineSegments: THREE.LineSegments;
  private localVertsCache = new Map<string, Float32Array>();
  private dirty = true;
  private needsFullRebuild = true;
  private pendingKeys = new Set<string>();
  private visible = false;
  private registry = new Map<string, number>();
  private order: string[] = [];
  private floatsPerCell: number;
  private capacity = INITIAL_CAPACITY;
  private positions: Float32Array;

  constructor(
    private scene: THREE.Scene,
    private world: WorldReader,
    private catalog: BlockDef[],
    /** Filter for e.g. excluding hidden cells (omitting it targets all cells, fully compatible with prior behavior) */
    private filter?: (x: number, y: number, z: number, value: number) => boolean,
  ) {
    this.floatsPerCell = this.computeFloatsPerCell();
    this.positions = new Float32Array(this.capacity * this.floatsPerCell);
    const material = new THREE.LineBasicMaterial({ color: '#000000', transparent: true, opacity: 0.25, depthWrite: false });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    // BufferGeometry's default drawRange is {start:0, count:Infinity} — since the buffer is
    // pre-allocated to capacity (mostly zero-filled, unused space), make sure nothing renders
    // until the first finalize() sets the actual vertex count
    geometry.setDrawRange(0, 0);
    this.lineSegments = new THREE.LineSegments(geometry, material);
    this.lineSegments.visible = this.visible;
    // A review fix: since incremental updates now mutate position in-place within
    // the same geometry, boundingSphere is lazily computed and cached only once on first render
    // and never auto-updates on later add/remove (as with VoxelMesh/DimModelMesh, disable
    // frustumCulled to avoid accidentally getting culled by stale bounds — the original
    // implementation created a `new BufferGeometry()` every time, so geometry was a fresh object
    // each time and boundingSphere was recreated along with it, which is why this issue never
    // surfaced before)
    this.lineSegments.frustumCulled = false;
    this.scene.add(this.lineSegments);
  }

  /** Only shown in flat mode (hidden in texture mode) */
  setVisible(v: boolean): void {
    this.visible = v;
    this.lineSegments.visible = v;
  }

  /** Receives WorldIndex content-change events. `cells` triggers an incremental update, `replaceAll` schedules a full rebuild */
  onWorldChange(event: WorldIndexChange): void {
    if (event.kind === 'cells') {
      // WorldIndex passes Cell (3 numeric elements). Internal dedup is handled by a Set of
      // string keys, so we run it through makeCellKey here (receive directly, no boundary adapter)
      for (const cell of event.cells) this.pendingKeys.add(makeCellKey(cell[0], cell[1], cell[2]));
      this.dirty = true;
      return;
    }
    this.pendingKeys.clear();
    this.needsFullRebuild = true;
    this.dirty = true;
  }

  /** For factors other than world (tree ops etc., or any change whose scope isn't confined to a single cell). Always does a full rebuild */
  markDirty(): void {
    this.pendingKeys.clear();
    this.needsFullRebuild = true;
    this.dirty = true;
  }

  /** Called every frame. Only rebuilds when visible + dirty (skips while hidden, keeping dirty set) */
  update(): void {
    if (!this.visible || !this.dirty) return;
    this.dirty = false;
    if (this.needsFullRebuild) {
      this.needsFullRebuild = false;
      this.pendingKeys.clear();
      this.rebuild();
      return;
    }
    if (this.pendingKeys.size === 0) return;
    const keys = this.pendingKeys;
    this.pendingKeys = new Set();
    this.applyIncremental(keys);
  }

  dispose(): void {
    this.scene.remove(this.lineSegments);
    this.lineSegments.geometry.dispose();
    (this.lineSegments.material as THREE.Material).dispose();
    this.localVertsCache.clear();
  }

  /** Scans the whole catalog (every shape × upsideDown combination) to find the max vertex float count any single cell needs */
  private computeFloatsPerCell(): number {
    let max = 0;
    for (const def of this.catalog) {
      const codes = def.shape === 'stairs' ? [0, 1] : [0]; // code's bit0 = upsideDown (only meaningful for stairs)
      for (const code of codes) {
        const len = this.getLocalEdgeVertices(def, code).length;
        if (len > max) max = len;
      }
    }
    return max || 3; // Safety net for an empty catalog (avoids division by zero / empty buffer, doesn't happen in practice)
  }

  private ensureCapacity(count: number): void {
    if (count <= this.capacity) return;
    let cap = this.capacity;
    while (cap < count) cap *= 2;
    const newPositions = new Float32Array(cap * this.floatsPerCell);
    newPositions.set(this.positions.subarray(0, this.order.length * this.floatsPerCell));
    this.positions = newPositions;
    this.capacity = cap;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.lineSegments.geometry.dispose();
    this.lineSegments.geometry = geometry;
  }

  /** Writes vertices into the cell slot at index. Any shortfall relative to local is padded with a degenerate edge (two identical points) */
  private writeCellVertices(index: number, x: number, y: number, z: number, local: Float32Array): void {
    const base = index * this.floatsPerCell;
    let offset = base;
    for (let i = 0; i < local.length; i += 3) {
      this.positions[offset++] = local[i]! + x + 0.5;
      this.positions[offset++] = local[i + 1]! + y + 0.5;
      this.positions[offset++] = local[i + 2]! + z + 0.5;
    }
    const padX = this.positions[base]!;
    const padY = this.positions[base + 1]!;
    const padZ = this.positions[base + 2]!;
    for (let i = offset; i < base + this.floatsPerCell; i += 3) {
      this.positions[i] = padX;
      this.positions[i + 1] = padY;
      this.positions[i + 2] = padZ;
    }
  }

  private finalize(): void {
    const activeVerts = (this.order.length * this.floatsPerCell) / 3;
    this.lineSegments.geometry.setDrawRange(0, activeVerts);
    (this.lineSegments.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  private addOrUpdateCell(key: string, x: number, y: number, z: number, def: BlockDef, code: number): void {
    const local = this.getLocalEdgeVertices(def, code);
    const existing = this.registry.get(key);
    if (existing !== undefined) {
      this.writeCellVertices(existing, x, y, z, local);
      return;
    }
    this.ensureCapacity(this.order.length + 1);
    const index = this.order.length;
    this.order.push(key);
    this.writeCellVertices(index, x, y, z, local);
    this.registry.set(key, index);
  }

  /** swap-with-last: copies the last cell's slot as-is into the freed index, then pops.
   *  Doesn't go through the current world value (the same lesson from review: if the
   *  source cell is also slated for removal within the same event, world has already applied
   *  the whole batch, so recomputing would produce a wrong value. Copying the slot's raw bytes
   *  directly stays correct regardless of world's state) */
  private removeCell(key: string): void {
    const old = this.registry.get(key);
    if (old === undefined) return;
    const lastIndex = this.order.length - 1;
    if (old !== lastIndex) {
      const movedKey = this.order[lastIndex]!;
      const base = old * this.floatsPerCell;
      const lastBase = lastIndex * this.floatsPerCell;
      this.positions.copyWithin(base, lastBase, lastBase + this.floatsPerCell);
      this.order[old] = movedKey;
      this.registry.set(movedKey, old);
    }
    this.order.pop();
    this.registry.delete(key);
  }

  private applyIncremental(keys: Set<string>): void {
    for (const key of keys) {
      const [x, y, z] = parseCellKey(key);
      const raw = this.world.get(x, y, z);
      const visible = raw !== null && (!this.filter || this.filter(x, y, z, raw));
      if (visible) {
        const { catalogIndex, code } = unpackCell(raw);
        const def = this.catalog[catalogIndex];
        if (def) {
          this.addOrUpdateCell(key, x, y, z, def, code);
          continue;
        }
      }
      this.removeCell(key);
    }
    this.finalize();
  }

  private rebuild(): void {
    this.registry.clear();
    this.order = [];
    this.ensureCapacity(this.world.size); // Will be less than this once the filter narrows it down, but over-allocating is fine

    for (const [x, y, z, raw] of this.world.entries()) {
      if (this.filter && !this.filter(x, y, z, raw)) continue;
      const { catalogIndex, code } = unpackCell(raw);
      const def = this.catalog[catalogIndex];
      if (!def) continue;
      const index = this.order.length;
      const key = `${x},${y},${z}`;
      this.order.push(key);
      this.writeCellVertices(index, x, y, z, this.getLocalEdgeVertices(def, code));
      this.registry.set(key, index);
    }
    this.finalize();
  }

  /**
   * Local edge vertices for a single cell (rotation + slab offset already applied, cell
   * coordinates not yet added). Uses the same transform rules (yOffset / yRotation) as
   * setInstance in voxelmesh.ts.
   */
  private getLocalEdgeVertices(def: BlockDef, code: number): Float32Array {
    const orientation = decodeOrientation(def.shape, code);
    const upsideDown = orientation.shape === 'stairs' && orientation.upsideDown;
    const cacheKey = `${def.shape}:${upsideDown ? 1 : 0}:${code}`;
    const cached = this.localVertsCache.get(cacheKey);
    if (cached) return cached;

    let yOffset = 0;
    let yRotation = 0;
    if (orientation.shape === 'slab') yOffset = slabHalfOffset(orientation.half);
    else if (orientation.shape === 'stairs') yRotation = weirdoDirectionToYRotation(orientation.weirdoDirection);

    const shapeGeometry = createShapeGeometry(def.shape, upsideDown);
    const edges = new THREE.EdgesGeometry(shapeGeometry);
    shapeGeometry.dispose();

    tmpQuaternion.setFromAxisAngle(Y_AXIS, yRotation);
    const pos = edges.getAttribute('position');
    const out = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      tmpVec.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      tmpVec.applyQuaternion(tmpQuaternion);
      tmpVec.y += yOffset;
      out[i * 3] = tmpVec.x;
      out[i * 3 + 1] = tmpVec.y;
      out[i * 3 + 2] = tmpVec.z;
    }
    edges.dispose();

    this.localVertsCache.set(cacheKey, out);
    return out;
  }
}
