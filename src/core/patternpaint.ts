import { parseCellKey, type Cell, type CellKey } from './cell';
import { makeCellRefKey, parseCellRefKey, type CellRef, type CellRefKey, type CellRefRemap, type OwnerId } from './cellref';
import { createEmitter, type Unsubscribe } from './emitter';
import type { MixRecipe } from './mixpalette';
import { defaultCode, packCell, unpackCell, type Shape } from './orientation';
import type { OwnerCellReader } from './ownervoxels';

/** Edit-time data for a "live pattern" applied to a cell. */
export interface PatternPaint {
  readonly recipeId: string;
  /**
   * Which arrangement number this is when the same recipe is reapplied
   * (0 or greater, less than `PATTERN_VARIANTS`).
   *
   * **The pattern itself isn't stored here** — it's derived from world coordinates
   * every time (`patternSampleAt`). Baking in the sampled position would mean
   * duplication / component expansion copies the binding along with it, so
   * **every instance would end up with the same pattern**. To satisfy "pattern
   * painting is a coordinate-driven algorithm", position-dependent
   * data is never persisted.
   */
  readonly variant: number;
  /** Orientation before the pattern was applied. Only carried over when mixed into the same shape */
  readonly sourceRaw: number;
  /** Fallback value left in cells. The binding stays valid only while it matches the current raw */
  readonly appliedRaw: number;
}

export interface PatternPaintReader {
  readonly size: number;
  has(owner: OwnerId, key: CellKey): boolean;
  get(owner: OwnerId, key: CellKey): PatternPaint | undefined;
  allEntries(): IterableIterator<[OwnerId, CellKey, PatternPaint]>;
}

export function clonePatternPaint(paint: PatternPaint): PatternPaint {
  return { ...paint };
}

/** Binding equality check (`null` = "no binding" is also comparable). Used by the side that builds ops from diffs */
export function samePatternPaint(a: PatternPaint | null, b: PatternPaint | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.recipeId === b.recipeId &&
    a.variant === b.variant &&
    a.sourceRaw === b.sourceRaw &&
    a.appliedRaw === b.appliedRaw
  );
}

export class PatternPaintStore implements PatternPaintReader {
  private readonly byRef = new Map<CellRefKey, PatternPaint>();
  private readonly emitter = createEmitter<{ kind: 'change' }>();

  subscribe(fn: () => void): Unsubscribe {
    return this.emitter.subscribe(fn);
  }

  get size(): number {
    return this.byRef.size;
  }

  has(owner: OwnerId, key: CellKey): boolean {
    return this.byRef.has(makeCellRefKey({ ownerId: owner, localCell: parseCellKey(key) }));
  }

  get(owner: OwnerId, key: CellKey): PatternPaint | undefined {
    const paint = this.byRef.get(makeCellRefKey({ ownerId: owner, localCell: parseCellKey(key) }));
    return paint ? clonePatternPaint(paint) : undefined;
  }

  set(ref: CellRef, paint: PatternPaint): void {
    this.byRef.set(makeCellRefKey(ref), clonePatternPaint(paint));
    this.emitter.notify({ kind: 'change' });
  }

  write(owner: OwnerId, key: CellKey, paint: PatternPaint | null): void {
    const refKey = makeCellRefKey({ ownerId: owner, localCell: parseCellKey(key) });
    if (paint === null) this.byRef.delete(refKey);
    else this.byRef.set(refKey, clonePatternPaint(paint));
    this.emitter.notify({ kind: 'change' });
  }

  /**
   * Write multiple refs together, firing **a single notification** (staged remap for cell drag).
   *
   * During a drag, each pointermove rebuilds from the baseline, so calling `write` for
   * every selected cell × every move fires that many notifications. Batch the writes
   * to collapse it into one notification.
   */
  writeMany(entries: Iterable<[CellRef, PatternPaint | null]>): void {
    let changed = false;
    for (const [ref, paint] of entries) {
      const refKey = makeCellRefKey(ref);
      if (paint === null) changed = this.byRef.delete(refKey) || changed;
      else {
        this.byRef.set(refKey, clonePatternPaint(paint));
        changed = true;
      }
    }
    if (changed) this.emitter.notify({ kind: 'change' });
  }

  *allEntries(): IterableIterator<[OwnerId, CellKey, PatternPaint]> {
    for (const [key, paint] of this.byRef) {
      const ref = parseCellRefKey(key);
      yield [ref.ownerId, `${ref.localCell[0]},${ref.localCell[1]},${ref.localCell[2]}`, clonePatternPaint(paint)];
    }
  }

  replaceAll(entries: Iterable<[OwnerId, CellKey, PatternPaint]>): void {
    this.byRef.clear();
    for (const [owner, key, paint] of entries) {
      this.byRef.set(makeCellRefKey({ ownerId: owner, localCell: parseCellKey(key) }), clonePatternPaint(paint));
    }
    this.emitter.notify({ kind: 'change' });
  }

  clear(): void {
    if (!this.byRef.size) return;
    this.byRef.clear();
    this.emitter.notify({ kind: 'change' });
  }

  /** Follows the same transaction boundary as Document's refRemap. Returns true if anything changed. */
  remap(remap: CellRefRemap): boolean {
    const moves: Array<[CellRefKey, CellRef | null, PatternPaint]> = [];
    for (const [oldKey, nextRef] of remap) {
      const paint = this.byRef.get(oldKey);
      if (paint) moves.push([oldKey, nextRef, paint]);
    }
    if (!moves.length) return false;
    for (const [oldKey] of moves) this.byRef.delete(oldKey);
    for (const [, nextRef, paint] of moves) {
      if (nextRef) this.byRef.set(makeCellRefKey(nextRef), paint);
    }
    this.emitter.notify({ kind: 'change' });
    return true;
  }
}

export function activePatternAt(
  patterns: PatternPaintReader,
  cells: OwnerCellReader,
  owner: OwnerId,
  key: CellKey,
): PatternPaint | null {
  const paint = patterns.get(owner, key);
  return paint && cells.get(owner, key) === paint.appliedRaw ? paint : null;
}

function hashText32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

function avalanche32(value: number): number {
  let hash = value;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/**
 * Progressive rank that divides the x-z plane into a 4x4 grid, independent per y-layer.
 * 25% / 50% / 75% land on exact counts within each region; ratios that don't divide
 * evenly into 16 cells (e.g. thirds) wobble by ±1 cell via jitter at the rank boundary.
 * A plain coordinate hash produces parallel streaks, and independent randomness allows
 * local clumping, so per-region rotated/flipped stratified sampling balances ratio
 * accuracy with visual quality.
 */
const STRATIFIED_RANKS_4 = [
  0, 8, 12, 4,
  13, 5, 1, 9,
  7, 15, 11, 3,
  10, 2, 6, 14,
] as const;

/** Total number of arrangements cycled through when the same recipe is reapplied. */
export const PATTERN_VARIANTS = 16;

/**
 * Build a stratified sample from **world coordinates**.
 *
 * The key point is seeding from world, not owner:
 *
 * - **Pattern changes when position changes** — duplication / component expansion
 *   doesn't give every instance the same pattern. Moving (dragging) also changes the
 *   pattern, but that's accepted as a consequence of "a coordinate-driven algorithm"
 * - **Pattern is stable across save -> load** — group ids get re-allocated, but world
 *   coordinates are preserved (this satisfies a point flagged in review, without
 *   baking in the sampled position)
 *
 * World coordinates aren't a cell's identity (see `cellref.ts`), but what's used here
 * is **position as a seed for the pattern**, not identity.
 */
export function patternSampleAt(recipeId: string, worldCell: Cell, layoutVariant = 0): number {
  const [x, y, z] = worldCell;
  const tileX = Math.floor(x / 4);
  const tileZ = Math.floor(z / 4);
  const variantKey = layoutVariant === 0 ? recipeId : `${recipeId}\0${layoutVariant}`;
  let seed = avalanche32(hashText32(variantKey));
  seed = avalanche32(seed ^ Math.imul(tileX, 0x8da6b343));
  seed = avalanche32(seed ^ Math.imul(y, 0xd8163841));
  seed = avalanche32(seed ^ Math.imul(tileZ, 0xcb1ab31f));

  let localX = positiveModulo(x, 4);
  let localZ = positiveModulo(z, 4);
  if ((seed & 1) !== 0) localX = 3 - localX;
  if ((seed & 2) !== 0) localZ = 3 - localZ;
  if ((seed & 4) !== 0) [localX, localZ] = [localZ, localX];

  const localIndex = localZ * 4 + localX;
  const rank = STRATIFIED_RANKS_4[localIndex]!;
  const jitter = avalanche32(seed ^ Math.imul(localIndex + 1, 0x9e3779b1)) / 0x1_0000_0000;
  return (rank + jitter) / 16;
}

/**
 * Next arrangement number when a recipe is "reapplied".
 *
 * Previously the variant was reverse-derived from the sampled position (`sample`) by
 * brute-forcing all 16 possibilities. Now that `PatternPaint` holds the variant
 * directly, a simple cycle is enough. Out-of-range / non-integer values (from legacy
 * data) are treated as coming right before 0.
 */
export function nextPatternVariant(currentVariant: number): number {
  if (!Number.isInteger(currentVariant) || currentVariant < 0 || currentVariant >= PATTERN_VARIANTS) return 1 % PATTERN_VARIANTS;
  return (currentVariant + 1) % PATTERN_VARIANTS;
}

export function samplePattern(
  recipe: MixRecipe,
  sample: number,
  indexOf: (blockId: string) => number | undefined,
): number | null {
  const valid = recipe.entries.filter((entry) => entry.weight > 0 && indexOf(entry.blockId) !== undefined);
  if (!valid.length) return null;
  const total = valid.reduce((sum, entry) => sum + entry.weight, 0);
  let value = sample * total;
  for (const entry of valid) {
    value -= entry.weight;
    if (value <= 0) return indexOf(entry.blockId)!;
  }
  return indexOf(valid[valid.length - 1]!.blockId)!;
}

/** Always picks the same entry from world coordinates and recipe id. Doesn't retain a random sequence across ratio changes. */
export function samplePatternAt(
  recipe: MixRecipe,
  worldCell: Cell,
  indexOf: (blockId: string) => number | undefined,
  variant = 0,
): number | null {
  return samplePattern(recipe, patternSampleAt(recipe.id, worldCell, variant), indexOf);
}

/**
 * Resolve the current display raw value from a binding.
 *
 * The sampled position isn't retained — it's **derived from the world coordinates at
 * that moment**. The same binding produces a different pattern depending on
 * where it's placed.
 */
export function resolvePatternRaw(
  paint: PatternPaint,
  worldCell: Cell,
  recipe: MixRecipe | undefined,
  indexOf: (blockId: string) => number | undefined,
  shapeOf: (catalogIndex: number) => Shape | undefined,
): number {
  if (!recipe) return paint.appliedRaw;
  const nextIndex = samplePattern(recipe, patternSampleAt(recipe.id, worldCell, paint.variant), indexOf);
  if (nextIndex === null) return paint.appliedRaw;
  const source = unpackCell(paint.sourceRaw);
  const nextShape = shapeOf(nextIndex) ?? 'full';
  const code = shapeOf(source.catalogIndex) === nextShape ? source.code : defaultCode(nextShape);
  return packCell(nextIndex, code);
}
