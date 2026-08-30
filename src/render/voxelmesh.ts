import { firstFrameUv, frameCountOf, staticTextureUrl, type TextureUrlResolver } from '../core/textureframe';
import * as THREE from 'three';
import { decodeOrientation, unpackCell, type Orientation } from '../core/orientation';
import type { BlockDef, DisplayMode } from '../core/types';
import { parseCellKey } from '../core/types';
import { makeCellKey } from '../core/types';
import type { WorldIndexChange } from '../core/worldindex';
import type { WorldReader } from '../core/voxels';
import { createShapeGeometry, slabHalfOffset, weirdoDirectionToYRotation } from './geometry';
import textureManifest from '../data/textures.json';

const INITIAL_CAPACITY = 256;

interface TextureEntry {
  side: string;
  top?: string;
}

const MANIFEST = textureManifest as Record<string, TextureEntry>;


/**
 * InstancedMesh for a single block type (one per upsideDown state for stairs).
 * Automatically falls back to a flat color when the texture hasn't loaded yet.
 */
class BlockTypeMesh {
  mesh: THREE.InstancedMesh;
  private capacity = INITIAL_CAPACITY;
  private geometry: THREE.BufferGeometry;
  private fallbackMaterial: THREE.Material | THREE.Material[];
  /** null until the async load completes. Once loaded, kept around regardless of display mode. */
  private texturedMaterial: THREE.Material | THREE.Material[] | null = null;
  private displayMode: DisplayMode;
  private disposed = false;

  constructor(
    private scene: THREE.Scene,
    def: BlockDef,
    upsideDown: boolean,
    private loader: THREE.TextureLoader,
    displayMode: DisplayMode,
    private resolveTextureUrl: TextureUrlResolver,
  ) {
    this.displayMode = displayMode;
    this.geometry = createShapeGeometry(def.shape, upsideDown);
    const groupCount = def.shape === 'stairs' ? 2 : 6;
    this.fallbackMaterial =
      groupCount === 2
        ? [new THREE.MeshLambertMaterial({ color: def.color }), new THREE.MeshLambertMaterial({ color: def.color })]
        : new THREE.MeshLambertMaterial({ color: def.color });
    this.mesh = this.createMesh(this.capacity, this.fallbackMaterial);
    this.scene.add(this.mesh);
    this.tryLoadTexture(def);
  }

  private tryLoadTexture(def: BlockDef): void {
    const entry = MANIFEST[def.id];
    if (!entry) return; // Blocks with no mapping stay flat-colored

    const loadTex = (path: string): Promise<THREE.Texture> => {
      const loadFromUrl = (url: string) => new Promise<THREE.Texture>((resolve, reject) => {
        this.loader.load(
          url,
          (tex) => {
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestFilter;
            tex.colorSpace = THREE.SRGBColorSpace;
            // Animated textures (16xN stacked vertically) only get the first frame applied.
            // Applying the raw texture would squeeze every frame onto one face. Use the same
            // helper as the UI side to compute values (calculating flipY separately in each
            // place ends up flipping one of them upside down).
            const frames = frameCountOf(path);
            if (frames > 1) {
              const { repeatY, offsetY } = firstFrameUv(frames);
              tex.repeat.set(1, repeatY);
              tex.offset.set(0, offsetY);
            }
            resolve(tex);
          },
          undefined,
          reject,
        );
      });
      const resolved = this.resolveTextureUrl(path);
      return typeof resolved === 'string' ? loadFromUrl(resolved) : resolved.then(loadFromUrl);
    };

    const groupCount = def.shape === 'stairs' ? 2 : 6;

    loadTex(entry.side)
      .then(async (sideTex) => {
        if (this.disposed) {
          sideTex.dispose();
          return;
        }
        const sideMat = new THREE.MeshLambertMaterial({ map: sideTex });
        const noTop = !entry.top || entry.top === entry.side;
        if (noTop) {
          this.applyMaterial(groupCount === 2 ? [sideMat, sideMat] : sideMat);
          return;
        }
        try {
          const topTex = await loadTex(entry.top!);
          if (this.disposed) {
            sideTex.dispose();
            topTex.dispose();
            sideMat.dispose();
            return;
          }
          const topMat = new THREE.MeshLambertMaterial({ map: topTex });
          // BoxGeometry's default face group order: 0=+x 1=-x 2=+y(top) 3=-y(bottom) 4=+z 5=-z
          // stairs (mergeBoxGeometries) uses 2 groups: 0=side 1=top
          this.applyMaterial(
            groupCount === 2 ? [sideMat, topMat] : [sideMat, sideMat, topMat, topMat, sideMat, sideMat],
          );
        } catch {
          if (this.disposed) {
            sideTex.dispose();
            sideMat.dispose();
            return;
          }
          this.applyMaterial(groupCount === 2 ? [sideMat, sideMat] : sideMat); // If only the top texture failed to load, use the side texture everywhere
        }
      })
      .catch(() => {
        // Not available locally (public/textures/ is gitignored, fetch-textures not run) → stays flat-colored
      });
  }

  /**
   * Called when texture loading finishes. Keeps the fallback around (no dispose),
   * stores the loaded material as texturedMaterial, and decides mesh.material based
   * on the current display mode (mesh.material stays untouched if loading finishes
   * while still in flat mode).
   */
  private applyMaterial(material: THREE.Material | THREE.Material[]): void {
    this.texturedMaterial = material;
    if (this.displayMode === 'texture') this.mesh.material = material;
  }

  /** Switches display mode. While the texture hasn't loaded, stays on the fallback even in flat mode (naturally waits for the texture) */
  setDisplayMode(mode: DisplayMode): void {
    this.displayMode = mode;
    this.mesh.material = mode === 'texture' && this.texturedMaterial ? this.texturedMaterial : this.fallbackMaterial;
  }

  /** Disposes materials in the array, skipping duplicates (the same instance reused) */
  private disposeMaterial(material: THREE.Material | THREE.Material[]): void {
    const list = Array.isArray(material) ? material : [material];
    const seen = new Set<THREE.Material>();
    for (const m of list) {
      if (seen.has(m)) continue;
      seen.add(m);
      const map = (m as THREE.MeshLambertMaterial).map;
      if (map) map.dispose();
      m.dispose();
    }
  }

  setCount(count: number): void {
    if (count > this.capacity) {
      let cap = this.capacity;
      while (cap < count) cap *= 2;
      this.resize(cap);
    }
    this.mesh.count = count;
  }

  setInstance(i: number, x: number, y: number, z: number, orientation: Orientation): void {
    let yOffset = 0;
    tmpQuaternion.identity();
    if (orientation.shape === 'slab') {
      yOffset = slabHalfOffset(orientation.half);
    } else if (orientation.shape === 'stairs') {
      tmpQuaternion.setFromAxisAngle(Y_AXIS, weirdoDirectionToYRotation(orientation.weirdoDirection));
    } else if (orientation.shape === 'full' && orientation.axis === 'x') {
      // Rotating the default (axis=y) cube 90° around Z makes the top/bottom (cap faces) point ±X
      tmpQuaternion.setFromAxisAngle(Z_AXIS, Math.PI / 2);
    } else if (orientation.shape === 'full' && orientation.axis === 'z') {
      // Likewise, rotating 90° around X makes the cap faces point ±Z
      tmpQuaternion.setFromAxisAngle(X_AXIS, Math.PI / 2);
    }

    tmpPosition.set(x + 0.5, y + 0.5 + yOffset, z + 0.5);
    tmpMatrix.compose(tmpPosition, tmpQuaternion, ONE_SCALE);
    this.mesh.setMatrixAt(i, tmpMatrix);
  }

  /** Copies the instance transform from fromIndex to toIndex as-is (used by the incremental
   *  update's swap-with-last). Doesn't go through the current world value — by the time this is
   *  called, world may already reflect other changes from the same batch, so recomputing from
   *  world would produce a wrong value if the source cell is itself deleted in the same batch
   *  (flagged in review). A direct copy of the instance buffer isn't affected by that. */
  copyInstance(fromIndex: number, toIndex: number): void {
    this.mesh.getMatrixAt(fromIndex, tmpMatrix);
    this.mesh.setMatrixAt(toIndex, tmpMatrix);
  }

  finalize(): void {
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.disposed = true;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.dispose(); // Frees InstancedMesh-specific buffers like instanceMatrix/instanceColor (geometry/material are handled separately)
    // texture/material belong exclusively to this instance (not shared with other BlockTypeMesh), so always free both
    this.disposeMaterial(this.fallbackMaterial);
    if (this.texturedMaterial) this.disposeMaterial(this.texturedMaterial);
  }

  private resize(capacity: number): void {
    const material = this.mesh.material;
    const old = this.mesh;
    const oldCount = old.count;
    this.mesh = this.createMesh(capacity, material);
    // Carry over existing instance transforms to the new mesh (a review fix: the original
    // rebuild()-only implementation re-ran setInstance() on every instance right after resize,
    // so the data loss never surfaced. The incremental-update path only calls setInstance() for
    // the single new instance, so without this copy, all existing instances would reset to their
    // initial state (origin) the moment capacity is exceeded)
    for (let i = 0; i < oldCount; i++) {
      old.getMatrixAt(i, tmpMatrix);
      this.mesh.setMatrixAt(i, tmpMatrix);
    }
    this.scene.remove(old);
    old.dispose(); // Frees only instanceMatrix/instanceColor; leaves geometry/material alone since the new mesh keeps using them
    this.scene.add(this.mesh);
    this.capacity = capacity;
  }

  private createMesh(capacity: number, material: THREE.Material | THREE.Material[]): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.geometry, material, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    return mesh;
  }
}

const tmpMatrix = new THREE.Matrix4();
const tmpPosition = new THREE.Vector3();
const tmpQuaternion = new THREE.Quaternion();
const ONE_SCALE = new THREE.Vector3(1, 1, 1);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/** Which bucket a single cell belongs to. The instance index within the bucket stays in sync with order[] */
interface CellAssignment {
  bucketKey: string;
  index: number;
}

/** The result of resolving a raw value into a bucket classification */
interface ResolvedCell {
  bucketKey: string;
  catalogIndex: number;
  upsideDown: boolean;
  orientation: Orientation;
}

/**
 * Renderer holding a separate InstancedMesh per block type.
 * stairs need a distinct geometry per upsideDown state (for normals and winding order),
 * so the bucket key is `${catalogIndex}:${upsideDown?1:0}`
 * (full/slab always use `${catalogIndex}:0`; up/down is just a translation of the instance matrix).
 *
 * Applies per-cell diffs (add/remove/update) to buckets via `onWorldChange`.
 * Keeps `registry` (cellKey → bucket + instance index) and `order` (bucket → cellKey list in
 * instance order) in sync as a pair; deletion uses swap-with-last, moving the last instance
 * into the freed index. `replaceAll` / `clear` and `markDirty()` (catalog changes, doc changes,
 * or anything whose scope isn't limited to a single cell) fall back to `rebuild()`, which
 * rescans the entire world as before.
 */
export class VoxelMesh {
  private byBucket = new Map<string, BlockTypeMesh>();
  private order = new Map<string, string[]>();
  private registry = new Map<string, CellAssignment>();
  private dirty = false;
  private needsFullRebuild = false;
  private pendingKeys = new Set<string>();
  private displayMode: DisplayMode = 'texture';

  /**
   * `loader` is replaceable. **Texture loading depends on the DOM (ImageLoader)**, so in
   * environments without a browser the default loader won't run and materials never get assigned.
   * Tests that verify which face a material lands on pass in a synchronously-resolving loader here
   * so they **exercise the same material-assignment path as production**.
   * There's a default, so normal callers don't need to change anything.
   */
  constructor(
    private scene: THREE.Scene,
    private world: WorldReader,
    private catalog: BlockDef[],
    private loader: THREE.TextureLoader = new THREE.TextureLoader(),
    private resolveTextureUrl: TextureUrlResolver = staticTextureUrl,
  ) {
    this.markDirty();
  }

  /** Switches display mode. Applies immediately to existing buckets and carries over to buckets created afterward */
  setDisplayMode(mode: DisplayMode): void {
    this.displayMode = mode;
    for (const bt of this.byBucket.values()) bt.setDisplayMode(mode);
  }

  /** Discards loaded materials so imported or removed browser textures are resolved again. */
  reloadTextures(): void {
    for (const bt of this.byBucket.values()) bt.dispose();
    this.byBucket.clear();
    this.order.clear();
    this.registry.clear();
    this.markDirty();
  }

  setCatalog(catalog: BlockDef[]): void {
    this.catalog = catalog;
    for (const bt of this.byBucket.values()) bt.dispose();
    this.byBucket.clear();
    this.order.clear();
    this.registry.clear();
    this.markDirty();
  }

  /** Receives WorldIndex content-change events. `cells` triggers an incremental update, `replaceAll` schedules a full rebuild */
  onWorldChange(event: WorldIndexChange): void {
    if (event.kind === 'cells') {
      // WorldIndex passes us a Cell (3 numeric values). Internal dedup is handled by a Set of
      // string keys, so we run it through makeCellKey here (receive it directly with no boundary adapter in between)
      for (const cell of event.cells) this.pendingKeys.add(makeCellKey(cell[0], cell[1], cell[2]));
      this.dirty = true;
      return;
    }
    // replaceAll: can't be tracked as individual diffs, so do a full rebuild on the next update()
    this.pendingKeys.clear();
    this.needsFullRebuild = true;
    this.dirty = true;
  }

  /** For factors other than world (catalog changes, group display toggles, or any change whose scope isn't confined to a single cell). Always does a full rebuild */
  markDirty(): void {
    this.pendingKeys.clear();
    this.needsFullRebuild = true;
    this.dirty = true;
  }

  /** Called every frame. Only rebuilds (fully or incrementally) when dirty */
  update(): void {
    if (!this.dirty) return;
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

  /** Resolves bucket classification + orientation from a raw value. Returns null if the catalog doesn't support it (no def) */
  private resolveCell(raw: number): ResolvedCell | null {
    const { catalogIndex, code } = unpackCell(raw);
    const def = this.catalog[catalogIndex];
    if (!def) return null;
    const orientation = decodeOrientation(def.shape, code);
    const upsideDown = orientation.shape === 'stairs' && orientation.upsideDown;
    return { bucketKey: `${catalogIndex}:${upsideDown ? 1 : 0}`, catalogIndex, upsideDown, orientation };
  }

  private applyIncremental(keys: Set<string>): void {
    for (const key of keys) {
      const [x, y, z] = parseCellKey(key);
      const raw = this.world.get(x, y, z);
      const visible = raw !== null;
      const resolved = visible ? this.resolveCell(raw) : null;
      const old = this.registry.get(key);

      if (old && resolved && old.bucketKey === resolved.bucketKey) {
        // The bucket stays the same (same catalogIndex/upsideDown), but orientation (rotation, half,
        // etc.) may have changed, so only update the instance transform
        const bt = this.byBucket.get(old.bucketKey)!;
        bt.setInstance(old.index, x, y, z, resolved.orientation);
        bt.finalize();
        continue;
      }

      if (old) this.removeFromBucket(old.bucketKey, key);
      if (resolved) this.addToBucket(resolved, key, x, y, z);
    }
  }

  private addToBucket(resolved: ResolvedCell, key: string, x: number, y: number, z: number): void {
    let bt = this.byBucket.get(resolved.bucketKey);
    let order = this.order.get(resolved.bucketKey);
    if (!bt || !order) {
      const def = this.catalog[resolved.catalogIndex];
      if (!def) return;
      bt = new BlockTypeMesh(this.scene, def, resolved.upsideDown, this.loader, this.displayMode, this.resolveTextureUrl);
      this.byBucket.set(resolved.bucketKey, bt);
      order = [];
      this.order.set(resolved.bucketKey, order);
    }
    const index = order.length;
    order.push(key);
    bt.setCount(order.length);
    bt.setInstance(index, x, y, z, resolved.orientation);
    bt.finalize();
    this.registry.set(key, { bucketKey: resolved.bucketKey, index });
  }

  private removeFromBucket(bucketKey: string, key: string): void {
    const bt = this.byBucket.get(bucketKey);
    const order = this.order.get(bucketKey);
    const old = this.registry.get(key);
    if (!bt || !order || !old) return;

    // swap-with-last: copy the last instance's transform as-is into the freed index, then pop.
    // Don't recompute from world.get() (review feedback: if movedKey itself is also slated for
    // removal within the same event batch, world has already been updated with the whole batch by
    // this point, so recomputing would produce a wrong value. A direct copy of the instance buffer
    // stays correct regardless of world's state)
    const lastIndex = order.length - 1;
    if (old.index !== lastIndex) {
      const movedKey = order[lastIndex]!; // lastIndex is order.length-1, always a valid index
      bt.copyInstance(lastIndex, old.index);
      order[old.index] = movedKey;
      this.registry.set(movedKey, { bucketKey, index: old.index });
    }
    order.pop();
    bt.setCount(order.length);
    bt.finalize();
    this.registry.delete(key);

    if (order.length === 0) {
      bt.dispose();
      this.byBucket.delete(bucketKey);
      this.order.delete(bucketKey);
    }
  }

  private rebuild(): void {
    const groups = new Map<
      string,
      { catalogIndex: number; upsideDown: boolean; cells: { key: string; x: number; y: number; z: number; orientation: Orientation }[] }
    >();

    for (const [x, y, z, raw] of this.world.entries()) {
      const resolved = this.resolveCell(raw);
      if (!resolved) continue;
      let group = groups.get(resolved.bucketKey);
      if (!group) {
        group = { catalogIndex: resolved.catalogIndex, upsideDown: resolved.upsideDown, cells: [] };
        groups.set(resolved.bucketKey, group);
      }
      group.cells.push({ key: `${x},${y},${z}`, x, y, z, orientation: resolved.orientation });
    }

    // Dispose meshes for buckets no longer in use
    for (const [key, bt] of this.byBucket) {
      if (!groups.has(key)) {
        bt.dispose();
        this.byBucket.delete(key);
        this.order.delete(key);
      }
    }

    this.registry.clear();
    for (const [bucketKey, group] of groups) {
      let bt = this.byBucket.get(bucketKey);
      if (!bt) {
        const def = this.catalog[group.catalogIndex];
        if (!def) continue;
        bt = new BlockTypeMesh(this.scene, def, group.upsideDown, this.loader, this.displayMode, this.resolveTextureUrl);
        this.byBucket.set(bucketKey, bt);
      }
      bt.setCount(group.cells.length);
      const order: string[] = [];
      group.cells.forEach((cell, i) => {
        bt.setInstance(i, cell.x, cell.y, cell.z, cell.orientation);
        order.push(cell.key);
        this.registry.set(cell.key, { bucketKey, index: i });
      });
      this.order.set(bucketKey, order);
      bt.finalize();
    }
  }
}
