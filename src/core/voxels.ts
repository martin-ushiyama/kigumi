import type { Cell } from './types';
import { makeCellKey } from './types';
import { createEmitter, type Unsubscribe } from './emitter';

/** VoxelWorld change notification event types (#13). stage/stageMany pass the changed cells' keys together */
export type WorldChange =
  | { kind: 'cells'; keys: readonly string[] }
  | { kind: 'replaceAll' }
  | { kind: 'clear' };

/** An edit to one cell. before/after are indices into the blocks catalog, null = air */
export interface Edit {
  x: number;
  y: number;
  z: number;
  before: number | null;
  after: number | null;
}

const key = makeCellKey;

/**
 * VoxelWorld's read-only contract. Passed to render/input/ui as this type so the write
 * methods (stage/stageMany/clear/replaceAll) can't be called on it at the type level.
 * Writes are restricted to going through Document (src/core/document.ts) (#10).
 */
export interface WorldReader {
  readonly size: number;
  get(x: number, y: number, z: number): number | null;
  has(x: number, y: number, z: number): boolean;
  entries(): IterableIterator<[number, number, number, number]>;
  bounds(): { min: Cell; max: Cell } | null;
}

/**
 * A sparse voxel space (pure storage).
 * Doesn't hold undo/redo history — Document (src/core/document.ts) manages history,
 * and this class only handles the immediate application via stage().
 */
export class VoxelWorld implements WorldReader {
  private map = new Map<string, number>();
  private readonly emitter = createEmitter<WorldChange>();

  /** #13: supports multiple subscribers, returns an unsubscribe function (the old onChange used a single callback slot, which would conflict with future multi-feature use) */
  subscribe(fn: (event: WorldChange) => void): Unsubscribe {
    return this.emitter.subscribe(fn);
  }

  get size(): number {
    return this.map.size;
  }

  get(x: number, y: number, z: number): number | null {
    return this.map.get(key(x, y, z)) ?? null;
  }

  has(x: number, y: number, z: number): boolean {
    return this.map.has(key(x, y, z));
  }

  *entries(): IterableIterator<[number, number, number, number]> {
    for (const [k, v] of this.map) {
      const parts = k.split(',');
      yield [Number(parts[0]), Number(parts[1]), Number(parts[2]), v];
    }
  }

  /** Applies one edit immediately (recording it to history is the caller's — Document's — responsibility) */
  stage(e: Edit): void {
    this.rawSet(e.x, e.y, e.z, e.after);
    this.emitter.notify({ kind: 'cells', keys: [key(e.x, e.y, e.z)] });
  }

  /** Applies multiple edits in a batch and fires the notification only once at the end (drag-moves restage thousands of cells per frame) */
  stageMany(edits: Iterable<Edit>): void {
    const keys: string[] = [];
    for (const e of edits) {
      this.rawSet(e.x, e.y, e.z, e.after);
      keys.push(key(e.x, e.y, e.z));
    }
    this.emitter.notify({ kind: 'cells', keys });
  }

  bounds(): { min: Cell; max: Cell } | null {
    if (this.map.size === 0) return null;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const [x, y, z] of this.entries()) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
  }

  clear(): void {
    this.map.clear();
    this.emitter.notify({ kind: 'clear' });
  }

  /** For project loading. Full replacement (resetting history is Document's responsibility) */
  replaceAll(cells: Iterable<[number, number, number, number]>): void {
    this.map.clear();
    for (const [x, y, z, v] of cells) this.map.set(key(x, y, z), v);
    this.emitter.notify({ kind: 'replaceAll' });
  }

  private rawSet(x: number, y: number, z: number, v: number | null): void {
    if (v === null) this.map.delete(key(x, y, z));
    else this.map.set(key(x, y, z), v);
  }
}
