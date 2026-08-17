import type { Document } from '../core/document';
import { isValidCell, isValidLocalCell } from '../core/limits';
import {
  planComponentMerge,
  type ComponentCell,
  type ComponentNode,
  type ComponentPattern,
  type ComponentStore,
  type ComponentTemplate,
} from '../core/component';
import { planRecipeMerge, type MixRecipe, type RecipeStore } from '../core/mixpalette';
import {
  VOID_CATALOG_INDEX,
  VOID_CELL,
  isValidOrientationCode,
  isVoidCell,
  packCell,
  unpackCell,
} from '../core/orientation';
import { SceneTree, type GroupNode } from '../core/scenetree';
import { assertValidGroupTransform, type AngleSteps, type GroupTransform } from '../core/transform';
import { OwnerVoxelStore, assertValidEditorScene, type EditorScene, type EditorSceneReader } from '../core/ownervoxels';
import { activePatternAt, PATTERN_VARIANTS, PatternPaintStore, type PatternPaint } from '../core/patternpaint';
import { assertCanonicalLocalCellKey } from '../core/cell';
import { makeCellKey, type CellKey } from '../core/types';
import type { BlockDef } from '../core/types';
import { FALLBACK_PROJECT_NAME } from '../core/i18n';

/**
 * Project JSON. **Always written as v5**, v1-v4 are read-only.
 * - version 1: blocks only ([x,y,z,blockId,code?]), no groups
 * - version 2: adds the group tree. blocks' 6th element is an index into the groups array (-1 = root).
 *   groups is pre-order (parent always has a lower index), parent is that array's index (-1 = root)
 * - version 3: owner-local cells + group transform (see section below)
 * - version 4: v3 + per-cell live pattern binding (metadata carries a lottery position `sample`)
 * - version 5: pattern metadata's `sample` becomes `variant` (the pattern is now derived from world coordinates)
 */
export interface ProjectFileV1 {
  app: 'blocksmith';
  version: 1;
  name: string;
  blocks: [number, number, number, string, number?][];
  recipes: MixRecipe[];
}
export interface ProjectFileV2 {
  app: 'blocksmith';
  version: 2;
  name: string;
  /** [x, y, z, blockId, orientationCode, groupIndex]; groupIndex -1 = root */
  blocks: [number, number, number, string, number, number][];
  /** pre-order. parent is an index into this array, -1 = root. Invariant: parent < own index (structurally forbids cycles).
   *  hidden/locked default to false when omitted (backward compat with older v2 files) */
  groups: { name: string; parent: number; hidden?: boolean; locked?: boolean }[];
  recipes: MixRecipe[];
}
/**
 * Export/autosave is **always v4**.
 *
 * v2 cannot express owner-local coordinates or group transforms — it's a format built on
 * "1 world-coordinate cell = 1 value + single ownership", so saving a rotated group or an
 * overlap always loses information.
 * **Reading** v1-v3 is still accepted via migration in `validateProjectV3`.
 */
export type ProjectFile = ProjectFileV5;

const AUTOSAVE_KEY = 'blocksmith.project.autosave.v1'; // key name kept as-is (contents distinguished by version, so existing users' autosaves aren't orphaned)

/**
 * The id used to represent a void cell in the saved format.
 *
 * Cells are saved as a blockId string, but void has no id since it's not in the catalog.
 * **Don't use a Mojang-style name like `minecraft:air`** — the policy is to not let anything
 * not actually from Mojang claim the `minecraft:` prefix (same rule as catalog ID matching).
 * Using the `blocksmith:` namespace makes "this is a blocksmith concept" readable from the id itself.
 */
export const VOID_BLOCK_ID = 'blocksmith:void';

/**
 * State carried in the save alongside the work itself (scene / recipes).
 *
 * **Pass by name.** Incidental state like this will keep growing over time; with positional
 * arguments the caller has no way to notice a forgotten or reordered argument (it silently
 * gets filled with a default).
 */
export interface ProjectExtras {
  /** Components used by this work. Only ones with an instance are included */
  components?: readonly ComponentTemplate[];
  /** Export count. Not written to the save when 0 */
  exportRevision?: number;
}

/** Current Document to the save format. v1-v4 are read-only, export is always v5. */
export function serializeProject(
  name: string,
  doc: Document,
  catalog: BlockDef[],
  recipes: MixRecipe[],
  extras: ProjectExtras = {},
): ProjectFileV5 {
  return serializeProjectV5(name, doc.scene, catalog, recipes, extras);
}

export interface ValidatedProject {
  name: string;
  cells: [number, number, number, number][];
  /** Group index corresponding to cells[i] (reference into the groups array). null = no owner. Always null for v1 */
  cellGroupIndex: (number | null)[];
  groups: { name: string; parent: number; hidden: boolean; locked: boolean }[];
  recipes: MixRecipe[];
  skipped: number;
}

/**
 * Validates the whole load payload into a temporary structure before returning it. On exception,
 * nothing is applied (this is the pre-stage for an atomic load).
 * This never calls doc.nextGroupId() here — assigning group ids (a side effect) only happens
 * after validation has fully succeeded, in the caller (loadProject), to preserve atomicity.
 */
export function validateProject(
  data: unknown,
  indexOf: (blockId: string) => number | undefined,
): ValidatedProject {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Not a blocksmith project file');
  }
  const d = data as Record<string, unknown>;
  if (d.app !== 'blocksmith') {
    throw new Error('Not a blocksmith project file (app mismatch)');
  }
  if (d.version !== 1 && d.version !== 2) {
    throw new Error('Not a blocksmith project file (version mismatch)');
  }
  const version = d.version;
  const name = typeof d.name === 'string' ? d.name : FALLBACK_PROJECT_NAME;

  const groups: { name: string; parent: number; hidden: boolean; locked: boolean }[] = [];
  if (version === 2) {
    if (!Array.isArray(d.groups)) throw new Error('groups is not an array');
    d.groups.forEach((g, i) => {
      if (typeof g !== 'object' || g === null) throw new Error(`groups[${i}] is invalid`);
      const gr = g as Record<string, unknown>;
      if (typeof gr.name !== 'string') throw new Error(`groups[${i}].name is invalid`);
      if (typeof gr.parent !== 'number' || !Number.isInteger(gr.parent) || gr.parent < -1 || gr.parent >= i) {
        throw new Error(`groups[${i}].parent is invalid (${String(gr.parent)})`);
      }
      if (gr.hidden !== undefined && typeof gr.hidden !== 'boolean') {
        throw new Error(`groups[${i}].hidden is invalid`);
      }
      if (gr.locked !== undefined && typeof gr.locked !== 'boolean') {
        throw new Error(`groups[${i}].locked is invalid`);
      }
      groups.push({ name: gr.name, parent: gr.parent, hidden: !!gr.hidden, locked: !!gr.locked });
    });
  }

  if (!Array.isArray(d.blocks)) throw new Error('blocks is not an array');
  const cells: [number, number, number, number][] = [];
  const cellGroupIndex: (number | null)[] = [];
  const seenCoords = new Set<string>();
  let skipped = 0;
  const allowedLengths = version === 1 ? [4, 5] : [4, 5, 6];
  for (const [i, entry] of d.blocks.entries()) {
    if (!Array.isArray(entry) || !allowedLengths.includes(entry.length)) {
      throw new Error(`blocks[${i}] is invalid (element count is none of ${allowedLengths.join('/')})`);
    }
    const [x, y, z, blockId, orientationCode, groupIndex] = entry as unknown[];
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number' || typeof blockId !== 'string') {
      throw new Error(`blocks[${i}] is invalid (coordinates are not numbers, or blockId is not a string)`);
    }
    if (!isValidCell(x, y, z)) {
      throw new Error(`blocks[${i}] is invalid (out-of-range or invalid coordinate: ${x}, ${y}, ${z})`);
    }
    let code = 0;
    if (orientationCode !== undefined) {
      if (!isValidOrientationCode(orientationCode)) {
        throw new Error(`blocks[${i}].orientationCode is invalid (${JSON.stringify(orientationCode)})`);
      }
      code = orientationCode;
    }
    let groupIdx: number | null = null;
    if (version === 2 && groupIndex !== undefined) {
      if (typeof groupIndex !== 'number' || !Number.isInteger(groupIndex) || groupIndex < -1 || groupIndex >= groups.length) {
        throw new Error(`blocks[${i}].groupIndex is invalid (${JSON.stringify(groupIndex)})`);
      }
      if (groupIndex !== -1) groupIdx = groupIndex;
    }
    const index = indexOf(blockId);
    if (index === undefined) {
      skipped++; // Skip unknown blocks (for future catalog compatibility). Discard the corresponding groupIdx too
      continue;
    }
    // In v1/v2, world coordinates are the cell's identity, so a duplicate coordinate leaves it
    // undecided which ownership is correct. Even after migration to owner-local, one side would
    // silently vanish, so this rejects it here before applying anything
    // (v3 only rejects the same local coordinate within the same owner; overlaps across owners are allowed)
    const coordKey = `${x},${y},${z}`;
    if (seenCoords.has(coordKey)) {
      throw new Error(`blocks[${i}] is invalid (the same coordinate appears more than once: ${x}, ${y}, ${z})`);
    }
    seenCoords.add(coordKey);
    cells.push([x, y, z, packCell(index, code)]);
    cellGroupIndex.push(groupIdx);
  }

  const recipes: MixRecipe[] = [];
  if (d.recipes !== undefined) {
    if (!Array.isArray(d.recipes)) throw new Error('recipes is not an array');
    for (const [i, r] of d.recipes.entries()) {
      if (typeof r !== 'object' || r === null) throw new Error(`recipes[${i}] is invalid`);
      const rec = r as Record<string, unknown>;
      if (typeof rec.id !== 'string' || typeof rec.name !== 'string' || !Array.isArray(rec.entries)) {
        throw new Error(`recipes[${i}] is invalid (id/name/entries)`);
      }
      const entries = rec.entries.map((e, j) => {
        if (typeof e !== 'object' || e === null) throw new Error(`recipes[${i}].entries[${j}] is invalid`);
        const entry = e as Record<string, unknown>;
        if (typeof entry.blockId !== 'string' || typeof entry.weight !== 'number' || !Number.isFinite(entry.weight) || entry.weight < 0) {
          throw new Error(`recipes[${i}].entries[${j}] is invalid (blockId/weight)`);
        }
        return { blockId: entry.blockId, weight: entry.weight };
      });
      recipes.push({ id: rec.id, name: rec.name, entries });
    }
  }

  return { name, cells, cellGroupIndex, groups, recipes, skipped };
}

/**
 * Atomic load. For all of v1-v4, `loadProjectV3`
 * validates -> builds an independent EditorScene, then that scene is brought into the Document.
 *
 * If validation throws, the Document is never touched, so any existing work stays as-is.
 * `Document.replaceAll` itself has full restoration from a snapshot, so even if a runtime
 * invariant violation is found during import, it fails while preserving the current state
 * (two layers of defense).
 *
 * Group ids are freshly assigned by `loadProjectV3`, and `SceneTree.replaceAll` advances the
 * assignment counter on import — so ids coming from the file never collide with ids issued by
 * a later Ctrl+G.
 */
/**
 * Reads the export count from the saved data.
 *
 * **Treats a corrupted value as 0 instead of failing the whole load** — the count isn't part of
 * the work itself, so it's worse for it to block the work from opening. Recounting from 0 leaves
 * a possibility that the next export drops the revision, but that's easier to notice than
 * blindly trusting a corrupted value (it just falls back to the known symptom of "importing
 * doesn't trigger an update").
 */
export function readExportRevision(data: unknown): number {
  const value = (data as { exportRevision?: unknown } | null)?.exportRevision;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

export function loadProject(
  data: unknown,
  doc: Document,
  indexOf: (blockId: string) => number | undefined,
  store: RecipeStore,
  componentStore?: ComponentStore,
): { name: string; loaded: number; skipped: number; exportRevision: number } {
  const { scene, name, recipes, components, loaded, skipped } = loadProjectV3(data, indexOf);

  // Recipes and components both belong to the user, not the work. Loading adds to the existing
  // ones without clearing them.
  // The merge plan is built first, and reference ids are remapped **before importing into the
  // Document** — if the lists were rewritten first, a later throw from doc.replaceAll would
  // leave a state where only the inventory grew but the work never got imported
  const plan = planRecipeMerge(store.recipes, recipes);
  if (plan.remap.size && scene.patterns) {
    scene.patterns.replaceAll(
      [...scene.patterns.allEntries()].map(([owner, key, paint]) => {
        const nextId = plan.remap.get(paint.recipeId);
        return [owner, key, nextId ? { ...paint, recipeId: nextId } : paint] as const;
      }),
    );
  }

  const componentPlan = componentStore ? planComponentMerge(componentStore.templates, components) : null;
  if (componentPlan?.remap.size) {
    // Remap the component id a group points to, to the id reassigned on the inventory side
    scene.tree.remapTemplateIds(componentPlan.remap);
  }

  doc.replaceAll(scene);
  store.applyMerge(plan);
  if (componentPlan) componentStore!.applyMerge(componentPlan);
  return { name, loaded, skipped, exportRevision: readExportRevision(data) };
}

/**
 * Autosave. **Returns whether the write succeeded.**
 *
 * The write can fail, e.g. from exceeding storage capacity. Silently swallowing that would let
 * the caller move on assuming "it saved" — for a value like the export count, where **the
 * correctness of the next operation depends on the save succeeding**, that would leave it
 * reusing the old revision and stuck unable to update
 *.
 *
 * @returns true if the write succeeded
 */
export function autosave(project: ProjectFile): boolean {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(project));
    return true;
  } catch {
    return false;
  }
}

export function loadAutosave(): ProjectFile | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    return raw ? (JSON.parse(raw) as ProjectFile) : null;
  } catch {
    return null;
  }
}

// ---- version 3: owner-local cells + group transform ----
//
// v3 is the persisted form of the editing model (EditorScene). Cell coordinates are in the
// owner (group)'s local coordinates, which round-trips overlaps where multiple owners project
// onto the same world coordinate
// (v1/v2's "duplicate coordinates are rejected" rule assumed world coordinates were a unique id;
// in v3 that's replaced by a per-owner rule: same local coordinate within the same owner = rejected,
// across different owners = allowed).
//
// In PR A, the existing loadProject/serializeProject (v2, wired directly to Document) is left
// unchanged; the v3 path imports/exports an independent EditorScene. Wiring it to the live
// Document is PR B's responsibility.

export interface ProjectFileV3 {
  app: 'blocksmith';
  version: 3;
  name: string;
  /** pre-order. parent is an index into this array, -1 = root. Omitted transform = identity
   *  (migration from v2 omits transform — the contract is to initialize around the bounds center on the first rotation, PR B) */
  groups: {
    name: string;
    parent: number;
    hidden?: boolean;
    locked?: boolean;
    /** If this is a component instance, its id. **Optional = a plain group** */
    templateId?: string;
    transform?: { angleSteps: AngleSteps; translate: [number, number, number]; pivot2: [number, number] };
  }[];
  /** [ownerIndex, x, y, z, blockId, orientationCode]. ownerIndex -1 = root, coordinates are owner-local */
  cells: [number, number, number, number, string, number][];
  recipes: MixRecipe[];
}

/**
 * **Read-only** (current writers emit v5). Older format where pattern metadata carries a lottery position `sample`.
 */
export interface ProjectFileV4 extends Omit<ProjectFileV3, 'version' | 'cells'> {
  version: 4;
  /**
   * The first 6 elements are the same as v3. Only cells with a pattern get
   * `{ recipeId, sample, sourceBlockId, sourceOrientationCode }` appended.
   */
  cells: Array<
    | [number, number, number, number, string, number]
    | [
        number,
        number,
        number,
        number,
        string,
        number,
        { recipeId: string; sample: number; sourceBlockId: string; sourceOrientationCode: number },
      ]
  >;
}

/**
 * v4 + pattern metadata's `sample` -> `variant` replacement.
 *
 * Patterns are now derived from world coordinates, so the lottery position is no longer
 * persisted. **This is an incompatible replacement of a required field, so the version bumps** —
 * if it kept claiming version 4 under a different schema, an old reader would accept the new
 * file as v4 and then fail on the missing `sample`. The new reader reads both
 * v4 (sample) and v5 (variant), so existing works aren't lost.
 */
export interface ProjectFileV5 extends Omit<ProjectFileV4, 'version' | 'cells'> {
  version: 5;
  /**
   * Components used by this work. **Optional**.
   *
   * The version isn't bumped for this, because both `components` and `groups[].templateId`
   * are **backward-compatible additions**. An old reader can still open a new file — the
   * instance marker just gets dropped, leaving an ordinary group (bumping the version for v5
   * was for an incompatible replacement of a required field, a different situation).
   */
  components?: SerializedComponentTemplate[];
  /**
   * Export count.
   *
   * **The work file remembers this.** Bedrock ignores imports with "same pack identity + same
   * or lower revision", so re-exporting to trigger an update needs a monotonically increasing
   * number. Keeping it only in the local browser means it drops back down the moment you switch
   * PCs or clear the browser, and updates stop working again.
   *
   * Optional (absent in older work files). Recounts from 0 if absent
   */
  exportRevision?: number;
  cells: Array<
    | [number, number, number, number, string, number]
    | [
        number,
        number,
        number,
        number,
        string,
        number,
        { recipeId: string; variant: number; sourceBlockId: string; sourceOrientationCode: number },
      ]
  >;
}

/**
 * A component as saved.
 *
 * **Cells are stored as block id + orientation, not catalog order.** The raw value held by
 * `ComponentTemplate` includes a position within the catalog, so if blocks are added or the
 * generation order changes, the same file would open as a different block. This matches what
 * the work's own cells have always done.
 */
export interface SerializedComponentTemplate {
  id: string;
  name: string;
  nodes: ComponentNode[];
  /** `[nodeIndex, local key, block id, orientation code]` */
  cells: [number, CellKey, string, number][];
  /** `[nodeIndex, local key, paint]` */
  patterns: [number, CellKey, SerializedComponentPaint][];
}

/** A paint as saved. `sourceRaw` / `appliedRaw` opened into the same "id + orientation" form as the work itself */
export interface SerializedComponentPaint {
  recipeId: string;
  variant: number;
  sourceBlockId: string;
  sourceOrientationCode: number;
  appliedBlockId: string;
  appliedOrientationCode: number;
}

/** raw value -> "block id + orientation". null if not in the catalog (caller drops it) */
function openRaw(raw: number, catalog: BlockDef[]): { blockId: string; code: number } | null {
  if (isVoidCell(raw)) return { blockId: VOID_BLOCK_ID, code: 0 };
  const { catalogIndex, code } = unpackCell(raw);
  const def = catalog[catalogIndex];
  return def ? { blockId: def.id, code } : null;
}

/** "block id + orientation" -> raw value. null for an unknown block */
function packBlock(blockId: string, code: number, indexOf: (id: string) => number | undefined): number | null {
  if (blockId === VOID_BLOCK_ID) return VOID_CELL;
  const index = indexOf(blockId);
  return index === undefined ? null : packCell(index, code);
}

/**
 * Component to the saved form. **Drops cells not in the catalog** (same rule as the work's own cells).
 */
export function serializeComponentTemplate(
  template: ComponentTemplate,
  catalog: BlockDef[],
): SerializedComponentTemplate {
  const cells: SerializedComponentTemplate['cells'] = [];
  for (const [nodeIndex, key, raw] of template.cells) {
    const opened = openRaw(raw, catalog);
    if (opened) cells.push([nodeIndex, key, opened.blockId, opened.code]);
  }
  const patterns: SerializedComponentTemplate['patterns'] = [];
  for (const [nodeIndex, key, paint] of template.patterns) {
    const source = openRaw(paint.sourceRaw, catalog);
    const applied = openRaw(paint.appliedRaw, catalog);
    if (!source || !applied) continue; // Don't carry out a paint whose source can't be resolved (restoring it would become a different block)
    patterns.push([
      nodeIndex,
      key,
      {
        recipeId: paint.recipeId,
        variant: paint.variant,
        sourceBlockId: source.blockId,
        sourceOrientationCode: source.code,
        appliedBlockId: applied.blockId,
        appliedOrientationCode: applied.code,
      },
    ]);
  }
  return {
    id: template.id,
    name: template.name,
    nodes: template.nodes.map((node) => ({ ...node })),
    cells,
    patterns,
  };
}

export interface ValidatedProjectV3 {
  name: string;
  groups: {
    name: string;
    parent: number;
    hidden: boolean;
    locked: boolean;
    /** If this is a component instance, its id */
    templateId?: string;
    transform?: GroupTransform;
  }[];
  /** [ownerIndex(-1=root), x, y, z, packedValue]. Coordinates are owner-local */
  cells: [number, number, number, number, number][];
  patterns: [number, number, number, number, PatternPaint][];
  recipes: MixRecipe[];
  /** Components used by the work. Always empty for files older than v4 */
  components: ComponentTemplate[];
  skipped: number;
}

/** Purely reshapes validated v1/v2 data into v3 form. No transform is attached (treated as identity), local coordinates = world coordinates */
export function migrateV2ToV3(v: ValidatedProject): ValidatedProjectV3 {
  return {
    name: v.name,
    groups: v.groups.map((g) => ({ ...g })),
    cells: v.cells.map(([x, y, z, value], i) => {
      const groupIdx = v.cellGroupIndex[i];
      return [groupIdx ?? -1, x, y, z, value] as [number, number, number, number, number];
    }),
    recipes: v.recipes,
    patterns: [],
    components: [],
    skipped: v.skipped,
  };
}

/**
 * Reads the placement number from a cell's pattern metadata. **The required field differs per version**:
 *
 * - v5: `variant` (integer >= 0 and < `PATTERN_VARIANTS`)
 * - v4: `sample` (lottery position 0..1). **Discards it and returns 0** — since patterns are
 *   now derived from world coordinates, a baked-in lottery position is meaningless. The pattern
 *   of an opened work will change
 *
 * `null` if the shape can't be read (the caller rejects it as "invalid format"). Checking strictly
 * per version prevents a file that only has one of the two fields from passing as "the other version".
 */
function readPatternVariant(pattern: Record<string, unknown>, version: 4 | 5): number | null {
  if (version === 5) {
    const { variant } = pattern;
    return typeof variant === 'number' && Number.isInteger(variant) && variant >= 0 && variant < PATTERN_VARIANTS
      ? variant
      : null;
  }
  const { sample } = pattern;
  return typeof sample === 'number' && Number.isFinite(sample) && sample >= 0 && sample < 1 ? 0 : null;
}

/**
 * Accepts v1-v4 and normalizes it into the runtime's common shape, ValidatedProjectV3.
 * v1/v2 go through the existing validateProject (unchanged) and are then reshaped via migrateV2ToV3.
 * Zero side effects (this is the pre-stage for an atomic load, same design as the existing validateProject).
 */
export function validateProjectV3(
  data: unknown,
  indexOf: (blockId: string) => number | undefined,
): ValidatedProjectV3 {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Not a blocksmith project file');
  }
  const d = data as Record<string, unknown>;
  if (d.app !== 'blocksmith') {
    throw new Error('Not a blocksmith project file (app mismatch)');
  }
  if (d.version === 1 || d.version === 2) {
    return migrateV2ToV3(validateProject(data, indexOf));
  }
  if (d.version === 4 || d.version === 5) {
    // v4 and v5 have the same cells shape; only the required field of the pattern metadata differs
    const patternVersion = d.version;
    if (!Array.isArray(d.cells)) throw new Error('cells is not an array');
    const v4Cells = d.cells as unknown[];
    const v3Cells = v4Cells.map((entry, i) => {
      if (!Array.isArray(entry) || (entry.length !== 6 && entry.length !== 7)) {
        throw new Error(`cells[${i}] is invalid (v${patternVersion} element count is not 6/7)`);
      }
      return (entry as unknown[]).slice(0, 6);
    });
    const base = validateProjectV3({ ...d, version: 3, cells: v3Cells }, indexOf);
    const patterns: ValidatedProjectV3['patterns'] = [];
    for (const [i, entry] of v4Cells.entries()) {
      const [ownerIndex, x, y, z, appliedBlockId, appliedCode, metadata] = entry as unknown[];
      if (metadata === undefined) continue;
      if (typeof metadata !== 'object' || metadata === null) throw new Error(`cells[${i}][6] is invalid (pattern metadata)`);
      const pattern = metadata as Record<string, unknown>;
      // v4 carries a lottery position `sample`. Since patterns are now derived from world
      // coordinates, this is discarded and treated as variant 0 (the pattern of the opened
      // work changes, but the file still opens).
      const variant = readPatternVariant(pattern, patternVersion);
      if (
        typeof pattern.recipeId !== 'string' ||
        variant === null ||
        typeof pattern.sourceBlockId !== 'string' ||
        !isValidOrientationCode(pattern.sourceOrientationCode)
      ) {
        throw new Error(`cells[${i}][6] is invalid (pattern metadata format)`);
      }
      const appliedIndex = typeof appliedBlockId === 'string' ? indexOf(appliedBlockId) : undefined;
      const sourceIndex = indexOf(pattern.sourceBlockId);
      // Cells with a missing catalog entry are skipped just like base. If only the source is
      // missing, a displayable fallback cell is kept and only the pattern metadata is dropped.
      if (appliedIndex === undefined || sourceIndex === undefined) continue;
      patterns.push([
        ownerIndex as number,
        x as number,
        y as number,
        z as number,
        {
          recipeId: pattern.recipeId,
          variant,
          sourceRaw: packCell(sourceIndex, pattern.sourceOrientationCode),
          appliedRaw: packCell(appliedIndex, appliedCode as number),
        },
      ]);
    }
    return { ...base, patterns };
  }
  if (d.version !== 3) {
    throw new Error('Not a blocksmith project file (version mismatch)');
  }
  const name = typeof d.name === 'string' ? d.name : FALLBACK_PROJECT_NAME;

  if (!Array.isArray(d.groups)) throw new Error('groups is not an array');
  const groups: ValidatedProjectV3['groups'] = [];
  d.groups.forEach((g, i) => {
    if (typeof g !== 'object' || g === null) throw new Error(`groups[${i}] is invalid`);
    const gr = g as Record<string, unknown>;
    if (typeof gr.name !== 'string') throw new Error(`groups[${i}].name is invalid`);
    if (typeof gr.parent !== 'number' || !Number.isInteger(gr.parent) || gr.parent < -1 || gr.parent >= i) {
      throw new Error(`groups[${i}].parent is invalid (${String(gr.parent)})`);
    }
    if (gr.hidden !== undefined && typeof gr.hidden !== 'boolean') throw new Error(`groups[${i}].hidden is invalid`);
    if (gr.locked !== undefined && typeof gr.locked !== 'boolean') throw new Error(`groups[${i}].locked is invalid`);
    if (gr.templateId !== undefined && typeof gr.templateId !== 'string') {
      throw new Error(`groups[${i}].templateId is invalid`);
    }
    const transform = validateTransform(gr.transform, `groups[${i}].transform`);
    groups.push({
      name: gr.name,
      parent: gr.parent,
      hidden: !!gr.hidden,
      locked: !!gr.locked,
      ...(gr.templateId !== undefined ? { templateId: gr.templateId } : {}),
      ...(transform ? { transform } : {}),
    });
  });

  if (!Array.isArray(d.cells)) throw new Error('cells is not an array');
  const cells: ValidatedProjectV3['cells'] = [];
  // Duplicate keys are per-owner: the same local coordinate within the same owner is rejected, across owners it's allowed
  const seenPerOwner = new Set<string>();
  let skipped = 0;
  for (const [i, entry] of d.cells.entries()) {
    if (!Array.isArray(entry) || entry.length !== 6) {
      throw new Error(`cells[${i}] is invalid (element count is not 6)`);
    }
    const [ownerIndex, x, y, z, blockId, orientationCode] = entry as unknown[];
    if (
      typeof ownerIndex !== 'number' ||
      !Number.isInteger(ownerIndex) ||
      ownerIndex < -1 ||
      ownerIndex >= groups.length
    ) {
      throw new Error(`cells[${i}].ownerIndex is invalid (${JSON.stringify(ownerIndex)})`);
    }
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number' || typeof blockId !== 'string') {
      throw new Error(`cells[${i}] is invalid (coordinates are not numbers, or blockId is not a string)`);
    }
    // Since these are owner-local coordinates, use isValidLocalCell instead of isValidCell (which requires y>=0)
    if (!isValidLocalCell(x, y, z)) {
      throw new Error(`cells[${i}] is invalid (out-of-range or invalid local coordinate: ${x}, ${y}, ${z})`);
    }
    if (!isValidOrientationCode(orientationCode)) {
      throw new Error(`cells[${i}].orientationCode is invalid (${JSON.stringify(orientationCode)})`);
    }
    // A void cell doesn't exist in the catalog, so it can't be looked up via indexOf.
    // **Distinguish it with a dedicated id** — without this branch it would fall through to
    // skipped, and a save/load round-trip would silently fill in the hole
    const index = blockId === VOID_BLOCK_ID ? VOID_CATALOG_INDEX : indexOf(blockId);
    if (index === undefined) {
      skipped++;
      continue;
    }
    const dedupKey = `${ownerIndex}:${x},${y},${z}`;
    if (seenPerOwner.has(dedupKey)) {
      throw new Error(`cells[${i}] is invalid (the same local coordinate appears more than once within owner ${ownerIndex}: ${x}, ${y}, ${z})`);
    }
    seenPerOwner.add(dedupKey);
    // Void has no orientation, so the file's code is ignored and collapsed to 0
    cells.push([ownerIndex, x, y, z, index === VOID_CATALOG_INDEX ? VOID_CELL : packCell(index, orientationCode)]);
  }

  const recipes: MixRecipe[] = [];
  if (d.recipes !== undefined) {
    if (!Array.isArray(d.recipes)) throw new Error('recipes is not an array');
    for (const [i, r] of d.recipes.entries()) {
      if (typeof r !== 'object' || r === null) throw new Error(`recipes[${i}] is invalid`);
      const rec = r as Record<string, unknown>;
      if (typeof rec.id !== 'string' || typeof rec.name !== 'string' || !Array.isArray(rec.entries)) {
        throw new Error(`recipes[${i}] is invalid (id/name/entries)`);
      }
      const entries = rec.entries.map((e, j) => {
        if (typeof e !== 'object' || e === null) throw new Error(`recipes[${i}].entries[${j}] is invalid`);
        const en = e as Record<string, unknown>;
        if (typeof en.blockId !== 'string' || typeof en.weight !== 'number' || !Number.isFinite(en.weight) || en.weight < 0) {
          throw new Error(`recipes[${i}].entries[${j}] is invalid (blockId/weight)`);
        }
        return { blockId: en.blockId, weight: en.weight };
      });
      recipes.push({ id: rec.id, name: rec.name, entries });
    }
  }

  return { name, groups, cells, patterns: [], recipes, components: validateComponents(d.components, indexOf), skipped };
}

/**
 * Validates a saved group transform.
 *
 * **Kept in one place.** The same shape (`GroupTransform`) appears both on a work's groups and
 * on a component's nodes, so copying the validation would leave one side more lenient (raised in
 * review P1: the node side was let through unchecked). `where` receives the path of the field
 * being validated (e.g. `groups[0].transform`), which is what the diagnostics are keyed on.
 *
 * @returns undefined if not given
 */
function validateTransform(raw: unknown, where: string): GroupTransform | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null) throw new Error(`${where} is invalid`);
  const t = raw as Record<string, unknown>;
  if (
    !Array.isArray(t.translate) ||
    t.translate.length !== 3 ||
    !t.translate.every((n) => typeof n === 'number') ||
    !Array.isArray(t.pivot2) ||
    t.pivot2.length !== 2 ||
    !t.pivot2.every((n) => typeof n === 'number') ||
    typeof t.angleSteps !== 'number'
  ) {
    throw new Error(`${where} is invalid (format)`);
  }
  const candidate: GroupTransform = {
    angleSteps: t.angleSteps as AngleSteps,
    translate: [t.translate[0] as number, t.translate[1] as number, t.translate[2] as number],
    pivot2: [t.pivot2[0] as number, t.pivot2[1] as number],
  };
  try {
    assertValidGroupTransform(candidate); // angleSteps range / safe integer / pivot2 parity match
  } catch (e) {
    throw new Error(`${where} is invalid: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  return candidate;
}

/**
 * Validates and reads back components bundled with the file.
 *
 * **Optional**. Absent from files older than v4, or from works that don't use components.
 * Throws if the shape is broken — silently dropping it would leave an instance (`templateId`)
 * pointing at a group with no content. **Blocks not in the catalog** are an exception, and are
 * silently dropped just like the work's own cells (so files made with a future catalog can still open).
 */
export function validateComponents(
  raw: unknown,
  indexOf: (blockId: string) => number | undefined,
): ComponentTemplate[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('components is not an array');
  return raw.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`components[${i}] is invalid`);
    const c = entry as Record<string, unknown>;
    if (typeof c.id !== 'string' || typeof c.name !== 'string') {
      throw new Error(`components[${i}] is invalid (id/name)`);
    }
    if (!Array.isArray(c.nodes) || !c.nodes.length) throw new Error(`components[${i}].nodes is invalid`);
    if (!Array.isArray(c.cells)) throw new Error(`components[${i}].cells is invalid`);
    const nodes: ComponentNode[] = c.nodes.map((n, j) => {
      if (typeof n !== 'object' || n === null) throw new Error(`components[${i}].nodes[${j}] is invalid`);
      const node = n as Record<string, unknown>;
      if (typeof node.name !== 'string') throw new Error(`components[${i}].nodes[${j}].name is invalid`);
      // Parent must precede self (structurally forbids cycles, same rule as groups' parent)
      if (node.parent !== null && (typeof node.parent !== 'number' || !Number.isInteger(node.parent) || node.parent < 0 || node.parent >= j)) {
        throw new Error(`components[${i}].nodes[${j}].parent is invalid`);
      }
      if (node.hidden !== undefined && typeof node.hidden !== 'boolean') {
        throw new Error(`components[${i}].nodes[${j}].hidden is invalid`);
      }
      if (node.locked !== undefined && typeof node.locked !== 'boolean') {
        throw new Error(`components[${i}].nodes[${j}].locked is invalid`);
      }
      const transform = validateTransform(node.transform, `components[${i}].nodes[${j}].transform`);
      return {
        name: node.name,
        parent: node.parent,
        ...(node.hidden !== undefined ? { hidden: node.hidden } : {}),
        ...(node.locked !== undefined ? { locked: node.locked } : {}),
        ...(transform ? { transform } : {}),
      };
    });

    /** The common part of a `[nodeIndex, local key, ...]` entry tied to a node. Rejects an out-of-range index / non-canonical key */
    const validateNodeEntry = (entry: unknown, kind: string, j: number): [number, CellKey, unknown] => {
      if (!Array.isArray(entry) || entry.length !== 3) {
        throw new Error(`components[${i}].${kind}[${j}] is invalid (element count)`);
      }
      const [nodeIndex, key, value] = entry as [unknown, unknown, unknown];
      if (typeof nodeIndex !== 'number' || !Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= nodes.length) {
        throw new Error(`components[${i}].${kind}[${j}].nodeIndex is invalid (${String(nodeIndex)})`);
      }
      if (typeof key !== 'string') throw new Error(`components[${i}].${kind}[${j}].key is invalid`);
      // Only reports the location mechanically (this string ends up embedded in the core-side throw, it never crosses the display boundary)
      assertCanonicalLocalCellKey(key, `components[${i}].${kind}[${j}]`);
      return [nodeIndex, key, value];
    };

    const cells: ComponentCell[] = [];
    c.cells.forEach((entry, j) => {
      // 4 elements: `[nodeIndex, key, block id, orientation]` (raised in review, migrated away from raw values)
      if (!Array.isArray(entry) || entry.length !== 4) {
        throw new Error(`components[${i}].cells[${j}] is invalid (element count)`);
      }
      const [nodeIndex, key] = validateNodeEntry([entry[0], entry[1], null], 'cells', j);
      const [, , blockId, code] = entry as [unknown, unknown, unknown, unknown];
      if (typeof blockId !== 'string') throw new Error(`components[${i}].cells[${j}].blockId is invalid`);
      if (!isValidOrientationCode(code)) throw new Error(`components[${i}].cells[${j}].orientationCode is invalid`);
      const raw = packBlock(blockId, code, indexOf);
      if (raw === null) return; // Drop unknown blocks (same as the work's own cells)
      cells.push([nodeIndex, key, raw]);
    });

    const rawPatterns = c.patterns === undefined ? [] : c.patterns;
    if (!Array.isArray(rawPatterns)) throw new Error(`components[${i}].patterns is invalid`);
    const patterns: ComponentPattern[] = [];
    rawPatterns.forEach((entry, j) => {
      const [nodeIndex, key, paint] = validateNodeEntry(entry, 'patterns', j);
      if (typeof paint !== 'object' || paint === null) {
        throw new Error(`components[${i}].patterns[${j}].paint is invalid`);
      }
      const p = paint as Record<string, unknown>;
      if (
        typeof p.recipeId !== 'string' ||
        typeof p.variant !== 'number' ||
        !Number.isInteger(p.variant) ||
        p.variant < 0 ||
        p.variant >= PATTERN_VARIANTS ||
        typeof p.sourceBlockId !== 'string' ||
        !isValidOrientationCode(p.sourceOrientationCode) ||
        typeof p.appliedBlockId !== 'string' ||
        !isValidOrientationCode(p.appliedOrientationCode)
      ) {
        throw new Error(`components[${i}].patterns[${j}].paint is invalid`);
      }
      const sourceRaw = packBlock(p.sourceBlockId, p.sourceOrientationCode, indexOf);
      const appliedRaw = packBlock(p.appliedBlockId, p.appliedOrientationCode, indexOf);
      if (sourceRaw === null || appliedRaw === null) return; // Drop a paint referencing an unknown block
      patterns.push([nodeIndex, key, { recipeId: p.recipeId, variant: p.variant, sourceRaw, appliedRaw }]);
    });

    return { id: c.id, name: c.name, nodes, cells, patterns };
  });
}

/**
 * Validates v1-v4 data and returns an independent EditorScene.
 * Does not connect to the live Document (PR B's responsibility). After assembly, owner
 * consistency is validated with assertValidEditorScene (two layers of defense: the validator layer and the core layer).
 */
export function loadProjectV3(
  data: unknown,
  indexOf: (blockId: string) => number | undefined,
): {
  scene: EditorScene;
  name: string;
  recipes: MixRecipe[];
  components: ComponentTemplate[];
  loaded: number;
  skipped: number;
} {
  const validated = validateProjectV3(data, indexOf);

  const tree = new SceneTree();
  const idByIndex = validated.groups.map(() => tree.nextId());
  const nodes: GroupNode[] = validated.groups.map((g, i) => ({
    id: idByIndex[i]!,
    name: g.name,
    parentId: g.parent === -1 ? null : idByIndex[g.parent]!,
    childIds: [],
    hidden: g.hidden,
    locked: g.locked,
    ...(g.templateId !== undefined ? { templateId: g.templateId } : {}),
    ...(g.transform ? { transform: g.transform } : {}),
  }));
  tree.replaceAll(nodes);

  const cells = new OwnerVoxelStore();
  for (const [ownerIndex, x, y, z, value] of validated.cells) {
    const owner = ownerIndex === -1 ? null : idByIndex[ownerIndex]!;
    cells.set(owner, makeCellKey(x, y, z), value);
  }

  const patterns = new PatternPaintStore();
  patterns.replaceAll(validated.patterns.map(([ownerIndex, x, y, z, paint]) => [
    ownerIndex === -1 ? null : idByIndex[ownerIndex]!,
    makeCellKey(x, y, z),
    paint,
  ]));
  const scene: EditorScene = { tree, cells, patterns };
  assertValidEditorScene(scene);
  return {
    scene,
    name: validated.name,
    recipes: validated.recipes,
    components: validated.components,
    loaded: validated.cells.length,
    skipped: validated.skipped,
  };
}

/**
 * Writes an EditorScene out in v3 form. Owner consistency is validated before writing —
 * this never falls back to "demote to root (-1) because the index can't be found" for a scene
 * with an invalid owner (never silently write out a broken v3; throw if it can't be resolved).
 */
export function serializeProjectV3(
  name: string,
  scene: EditorSceneReader,
  catalog: BlockDef[],
  recipes: MixRecipe[],
): ProjectFileV3 {
  assertValidEditorScene(scene);
  const { groups, nodes, indexOfGroup } = serializeProjectStructure(scene);
  const cells: ProjectFileV3['cells'] = [];
  for (const owner of [null, ...nodes.map((node) => node.id)] as Array<string | null>) {
    const ownerIndex = owner === null ? -1 : indexOfGroup.get(owner);
    if (ownerIndex === undefined) throw new Error(`serializeProjectV3: could not resolve owner index ("${owner}")`);
    for (const [key, raw] of scene.cells.entriesOf(owner)) {
      const { catalogIndex, code } = unpackCell(raw);
      const def = catalog[catalogIndex];
      if (!def) continue;
      const [x, y, z] = key.split(',').map(Number) as [number, number, number];
      cells.push([ownerIndex, x, y, z, def.id, code]);
    }
  }

  return { app: 'blocksmith', version: 3, name, groups, cells, recipes };
}

function serializeProjectStructure(scene: EditorSceneReader) {
  const groups: ProjectFileV3['groups'] = [];
  const indexOfGroup = new Map<string, number>();
  const nodes = [...scene.tree.allNodesPreOrder()];
  for (const node of nodes) {
    const idx = groups.length;
    indexOfGroup.set(node.id, idx);
    const parentIndex = node.parentId !== null ? (indexOfGroup.get(node.parentId) ?? -1) : -1;
    groups.push({
      name: node.name,
      parent: parentIndex,
      hidden: !!node.hidden,
      locked: !!node.locked,
      ...(node.templateId !== undefined ? { templateId: node.templateId } : {}),
      ...(node.transform
        ? {
            transform: {
              angleSteps: node.transform.angleSteps,
              translate: [node.transform.translate[0], node.transform.translate[1], node.transform.translate[2]] as [
                number,
                number,
                number,
              ],
              pivot2: [node.transform.pivot2[0], node.transform.pivot2[1]] as [number, number],
            },
          }
        : {}),
    });
  }
  return { groups, nodes, indexOfGroup };
}

/** Keeps v3's coordinate and group representation as-is, and appends only the live pattern bindings at the end. */
export function serializeProjectV5(
  name: string,
  scene: EditorSceneReader,
  catalog: BlockDef[],
  recipes: MixRecipe[],
  extras: ProjectExtras = {},
): ProjectFileV5 {
  const { components = [], exportRevision = 0 } = extras;
  assertValidEditorScene(scene);
  const { groups, nodes, indexOfGroup } = serializeProjectStructure(scene);
  const recipeIds = new Set(recipes.map((recipe) => recipe.id));
  // Recipes belong to the account, so what's passed in includes ones unrelated to this work.
  // **Only bundle the recipes actually referenced by a written paint** — including all of them
  // would turn the work file into "an export of the recipe library", leaking unused recipes into
  // the account of whoever opens it
  const usedRecipeIds = new Set<string>();
  const cells: ProjectFileV5['cells'] = [];

  for (const owner of [null, ...nodes.map((node) => node.id)] as Array<string | null>) {
    const index = owner === null ? -1 : indexOfGroup.get(owner);
    if (index === undefined) throw new Error(`serializeProjectV5: could not resolve owner index ("${owner}")`);
    for (const [key, raw] of scene.cells.entriesOf(owner)) {
      const [vx, vy, vz] = key.split(',').map(Number) as [number, number, number];
      // A void cell is not in the catalog so it falls through to `!def`. **Write it out
      // with a dedicated id** — dropping it would silently fill the hole on a save/load
      // round-trip (data loss). Void never has a pattern
      if (isVoidCell(raw)) {
        cells.push([index, vx, vy, vz, VOID_BLOCK_ID, 0]);
        continue;
      }
      const { catalogIndex, code } = unpackCell(raw);
      const def = catalog[catalogIndex];
      if (!def) continue;
      const [x, y, z] = [vx, vy, vz];
      const base: [number, number, number, number, string, number] = [index, x, y, z, def.id, code];
      const paint = scene.patterns ? activePatternAt(scene.patterns, scene.cells, owner, key) : null;
      if (!paint || !recipeIds.has(paint.recipeId)) {
        cells.push(base);
        continue;
      }
      const source = unpackCell(paint.sourceRaw);
      const sourceDef = catalog[source.catalogIndex];
      if (!sourceDef) {
        cells.push(base);
        continue;
      }
      usedRecipeIds.add(paint.recipeId);
      cells.push([
        ...base,
        {
          recipeId: paint.recipeId,
          variant: paint.variant,
          sourceBlockId: sourceDef.id,
          sourceOrientationCode: source.code,
        },
      ]);
    }
  }

  // Components are treated the same as recipes — **only bundle ones that actually have an
  // instance**. Including all of them would turn the work file into "an export of the
  // component inventory", leaking unused ones into the inventory of whoever opens it (the same shape as the recipe side)
  const usedTemplateIds = new Set(groups.map((group) => group.templateId).filter((id): id is string => !!id));
  const usedComponents = components
    .filter((component) => usedTemplateIds.has(component.id))
    .map((component) => serializeComponentTemplate(component, catalog));

  return {
    app: 'blocksmith',
    version: 5,
    name,
    groups,
    cells,
    recipes: recipes.filter((recipe) => usedRecipeIds.has(recipe.id)),
    ...(usedComponents.length ? { components: usedComponents } : {}),
    // Don't write it when 0 (avoid bloating the save for a work that has never been exported)
    ...(exportRevision > 0 ? { exportRevision } : {}),
  };
}
