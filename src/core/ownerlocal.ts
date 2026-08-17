import { makeCellKey, parseCellKey, type Cell, type CellKey } from './cell';
import type { CellRef, OwnerId } from './cellref';
import { isVoidCell, type Shape } from './orientation';
import type { EditorSceneReader } from './ownervoxels';
import {
  applyInverseTransform,
  applyTransform,
  composeResolved,
  computePivot2,
  inverseResolved,
  rotateDeltaToLocal,
  rotateRaw,
  type AngleSteps,
  type GroupTransform,
  type ResolvedTransform,
} from './transform';

/**
 * world ⇔ owner-local conversion helpers and subtree traversal (#37 B1b).
 *
 * After removing the membership index (SceneTree's `groupByCell` / `cellsByGroup`),
 * writing "which cells a group owns" / "which owner's local space a world coordinate
 * maps to" separately in each layer invites drift — forgetting to rotate the raw value,
 * or mixing up the descendant chain. **This is the single implementation of the
 * conversion rules** (#37 design rev.3: "consolidate shared helpers into Document/core").
 */

/** Minimal port requiring only transformChain (structurally satisfied by SceneTree / SceneTreeReader) */
export interface TransformChainReader {
  transformChain(id: string | null): ResolvedTransform;
}

/** Minimal port requiring only child relationships */
export interface ChildrenReader {
  childrenOf(parentId: string | null): readonly string[];
}

/** world cell -> owner-local cell. Inverse transform of the owner's entire ancestor chain */
export function worldToOwnerCell(tree: TransformChainReader, owner: OwnerId, worldCell: Cell): Cell {
  return applyInverseTransform(worldCell, tree.transformChain(owner));
}

/** owner-local cell -> world cell */
export function ownerToWorldCell(tree: TransformChainReader, owner: OwnerId, localCell: Cell): Cell {
  return applyTransform(localCell, tree.transformChain(owner));
}

/**
 * world-oriented raw -> owner-local-oriented raw.
 *
 * If only the coordinates are inverse-transformed while the raw stays world-oriented,
 * the owner's angle gets applied a second time during projection, making stairs /
 * pillars appear rotated away from what the user specified (#37 design rev.3 finding).
 * The inverse rotation is `(4 - angleSteps) % 4`.
 */
export function worldToOwnerRaw(
  tree: TransformChainReader,
  owner: OwnerId,
  worldRaw: number,
  shapeOf: (catalogIndex: number) => Shape | undefined,
): number {
  const { angleSteps } = tree.transformChain(owner);
  return rotateRaw(worldRaw, ((4 - angleSteps) % 4) as AngleSteps, shapeOf);
}

/** owner-local-oriented raw -> world-oriented raw (same rotation as projection, used so pick returns world-oriented values) */
export function ownerToWorldRaw(
  tree: TransformChainReader,
  owner: OwnerId,
  localRaw: number,
  shapeOf: (catalogIndex: number) => Shape | undefined,
): number {
  return rotateRaw(localRaw, tree.transformChain(owner).angleSteps, shapeOf);
}

/**
 * world-space delta vector -> owner-local delta vector.
 * The translation component cancels out in a delta, so only the rotation is inverted (`rotateDeltaToLocal`).
 */
export function worldDeltaToOwnerDelta(tree: TransformChainReader, owner: OwnerId, worldDelta: Cell): Cell {
  return rotateDeltaToLocal(worldDelta, tree.transformChain(owner));
}

/** owner itself + all descendant owners (pre-order). Passing `null` (root) returns cells directly under root + all groups */
export function ownersOfSubtree(tree: ChildrenReader, id: OwnerId): OwnerId[] {
  const out: OwnerId[] = [id];
  const walk = (parentId: string | null): void => {
    for (const childId of tree.childrenOf(parentId)) {
      out.push(childId);
      walk(childId);
    }
  };
  walk(id);
  return out;
}

/**
 * Enumerate `CellRef`s for every cell in a subtree (#37 B1b, successor to the old `SceneTree.collectCellsDeep`).
 *
 * **The key point is returning an array of refs, not a Set of world keys** — multiple
 * overlapping refs can project onto the same world coordinate, and collapsing to world
 * keys would lose mutation targets (#37 design: "for mutation, walk the owner/ref list directly").
 */
export function refsOfSubtree(scene: EditorSceneReader, id: OwnerId): CellRef[] {
  const out: CellRef[] = [];
  for (const owner of ownersOfSubtree(scene.tree, id)) {
    for (const [localKey] of scene.cells.entriesOf(owner)) {
      out.push({ ownerId: owner, localCell: parseCellKey(localKey) });
    }
  }
  return out;
}

/**
 * **Block count** of a subtree (formerly `SceneTree.cellCountDeep`). Counted per-ref, so overlaps count individually.
 *
 * **Does not count voids (#113).** This is "how many were placed" as shown in layer
 * rows and the inspector — what the user reads is "how many end up in the exported
 * world". A hole isn't a placed object. Use `directCellCount` when you need to check
 * actual data presence (e.g. delete guards).
 */
export function countCellsInSubtree(scene: EditorSceneReader, id: OwnerId): number {
  let total = 0;
  for (const owner of ownersOfSubtree(scene.tree, id)) {
    for (const [, raw] of scene.cells.entriesOf(owner)) {
      if (!isVoidCell(raw)) total++;
    }
  }
  return total;
}

/**
 * Number of cells an owner holds directly (descendants excluded). Used for empty-group detection.
 *
 * **Counts voids too** — unlike `countCellsInSubtree`, this isn't "how many to display"
 * but **whether data exists there**. Reporting 0 for a group that holds only voids would
 * let it slip past the delete guard and be removed along with its contents, and would
 * also get swept up in empty-group cleanup.
 */
export function directCellCount(scene: EditorSceneReader, owner: OwnerId): number {
  let total = 0;
  for (const _ of scene.cells.entriesOf(owner)) total++;
  return total;
}

/**
 * x/z bounds of every cell in the subtree, mapped into **id's own local coordinate
 * system** (used for pivot initialization in #37 B2, and also for the initial transform
 * creation in `buildTranslateGroup`).
 *
 * Descendants are mapped using only "the chain below id" — including id's own or an
 * ancestor's transform would shift a rotated group's pivot toward world space. The
 * relative chain is computed as `chain(id)⁻¹ ∘ chain(descendant)`.
 *
 * `null` when there are 0 cells (descendants empty too). The caller falls back to
 * `[0, 0]` since bounds can't be defined (#37 design rev.2 blocker 5).
 */
export function subtreeLocalBounds(
  scene: EditorSceneReader,
  id: OwnerId,
): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  const base = inverseResolved(scene.tree.transformChain(id));
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let found = false;
  for (const owner of ownersOfSubtree(scene.tree, id)) {
    const relative = composeResolved(base, scene.tree.transformChain(owner));
    for (const [localKey] of scene.cells.entriesOf(owner)) {
      const [x, , z] = applyTransform(parseCellKey(localKey), relative);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      found = true;
    }
  }
  return found ? { minX, maxX, minZ, maxZ } : null;
}

/** Convert a `CellRef`'s local cell to a canonical `CellKey` (the sole entry point for store / DocOp key generation) */
export function localKeyOf(ref: CellRef): CellKey {
  return makeCellKey(ref.localCell[0], ref.localCell[1], ref.localCell[2]);
}

/**
 * Initial value used when **creating a transform for the first time** on a group that has none set (#37 B1b).
 *
 * The pivot is taken from the subtree's local bounds. Baking in `pivot2: [0, 0]` as a
 * stand-in for "unset" would make the group's first rotation pivot around the origin
 * instead of the subtree's actual center, causing a visual jump (design rev.2 blocker 5,
 * "don't bake in placeholders").
 *
 * **Every path that materializes an unset transform must go through this** — move
 * (`buildTranslateGroup`) / reparent (`buildReparentGroup` / `buildGroup`) / extraction
 * (`snapshotSelection`) building it separately each led to only one path baking in
 * `[0, 0]`, causing drift (this actually happened, flagged in a prior code review).
 *
 * Only `[0, 0]` when there are 0 cells (descendants empty too) — since bounds can't be defined.
 */
export function initialTransformOf(scene: EditorSceneReader, id: OwnerId): GroupTransform {
  const bounds = subtreeLocalBounds(scene, id);
  return {
    angleSteps: 0,
    translate: [0, 0, 0],
    pivot2: bounds ? computePivot2(bounds) : [0, 0],
  };
}
