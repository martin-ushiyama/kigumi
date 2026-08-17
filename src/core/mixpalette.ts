import type { BlockDef } from './types';
import { createEmitter, type Unsubscribe } from './emitter';
import { freshLibraryId, planLibraryMerge, type LibraryMergePlan } from './library';

/** RecipeStore's change-notification event kind (#13). Only one kind, since persist() is the sole change path */
export type RecipeStoreChange = { kind: 'change' };

/** A recipe entry. Keyed by blockId (index isn't used, so it survives catalog reordering) */
export interface MixEntry {
  blockId: string;
  weight: number;
}

export interface MixRecipe {
  id: string;
  name: string;
  entries: MixEntry[];
}

const STORAGE_KEY = 'blocksmith.recipes.v1';

interface RecipeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Keep only the entries usable for sampling (#48 review finding).
 *
 * **The condition for "can this be drawn" lives in exactly one place.** If
 * `sampleRecipe` and `isDrawableRecipe` each wrote the same condition separately,
 * a change to only one would create "enabled in the UI but can't actually draw" or
 * "can draw but disabled in the UI".
 */
function drawableEntries(
  recipe: MixRecipe,
  indexOf: (blockId: string) => number | undefined,
): MixEntry[] {
  return recipe.entries.filter((e) => e.weight > 0 && indexOf(e.blockId) !== undefined);
}

/** Weighted sampling. rng can be swapped out for testing */
export function sampleRecipe(
  recipe: MixRecipe,
  indexOf: (blockId: string) => number | undefined,
  rng: () => number = Math.random,
): number | null {
  const valid = drawableEntries(recipe, indexOf);
  if (!valid.length) return null;
  const total = valid.reduce((sum, e) => sum + e.weight, 0);
  let r = rng() * total;
  for (const e of valid) {
    r -= e.weight;
    if (r <= 0) return indexOf(e.blockId)!;
  }
  return indexOf(valid[valid.length - 1]!.blockId)!;
}

/**
 * Whether a recipe can actually be sampled (#48 review finding, P1).
 *
 * `RecipeStore.create()` **creates a recipe with empty entries and selects it**, so
 * "a recipe is selected" alone doesn't guarantee it's usable. `sampleRecipe` also
 * returns null when all weights are 0 or below, or when the only blockIds present
 * aren't in the catalog.
 *
 * **The check goes through the same `drawableEntries` as `sampleRecipe`** — copying
 * the condition instead would let the UI and actual processing diverge if only one
 * side changed (#48 review finding, second pass).
 */
export function isDrawableRecipe(recipe: MixRecipe, indexOf: (blockId: string) => number | undefined): boolean {
  return drawableEntries(recipe, indexOf).length > 0;
}

/** A recipe's weighted average color (for ghost display) */
export function averageColor(recipe: MixRecipe, catalog: BlockDef[]): string {
  const byId = new Map(catalog.map((b) => [b.id, b.color]));
  let r = 0, g = 0, b = 0, total = 0;
  for (const e of recipe.entries) {
    const hex = byId.get(e.blockId);
    if (!hex || e.weight <= 0) continue;
    r += parseInt(hex.slice(1, 3), 16) * e.weight;
    g += parseInt(hex.slice(3, 5), 16) * e.weight;
    b += parseInt(hex.slice(5, 7), 16) * e.weight;
    total += e.weight;
  }
  if (total === 0) return '#ffffff';
  const to2 = (v: number) => Math.round(v / total).toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

/** Build a blockId -> index reverse lookup from the catalog */
export function buildIndexOf(catalog: BlockDef[]): (blockId: string) => number | undefined {
  const map = new Map(catalog.map((b, i) => [b.id, i]));
  return (blockId) => map.get(blockId);
}

/** Whether two recipes are identical (name + entries match exactly). id is not compared */
function sameRecipe(a: MixRecipe, b: MixRecipe): boolean {
  if (a.name !== b.name || a.entries.length !== b.entries.length) return false;
  return a.entries.every((e, i) => e.blockId === b.entries[i]!.blockId && e.weight === b.entries[i]!.weight);
}

function cloneRecipe(recipe: MixRecipe, id: string = recipe.id): MixRecipe {
  return { id, name: recipe.name, entries: recipe.entries.map((e) => ({ ...e })) };
}

const RECIPE_ID_PREFIX = 'r';

/**
 * Recipe merge plan for when a work file is loaded.
 *
 * The plan is kept separate from `applyMerge` so it can be built ahead of time,
 * because **cells' `recipeId` needs to be re-pointed first**. If the store were
 * rewritten and then the Document side failed, recipes alone would grow while the
 * work fails to load, leaving a half-applied state (same reasoning as `loadProject`'s
 * two-stage defense).
 */
export type RecipeMergePlan = LibraryMergePlan<MixRecipe>;

/**
 * Plan adding file-sourced recipes without deleting existing ones (#126).
 *
 * The actual rules live in `planLibraryMerge` (shared with components, #69).
 * Here we only supply the definition of a recipe's "same content".
 */
export function planRecipeMerge(existing: MixRecipe[], incoming: MixRecipe[]): RecipeMergePlan {
  return planLibraryMerge(existing, incoming, {
    sameContent: sameRecipe,
    withId: cloneRecipe,
    idPrefix: RECIPE_ID_PREFIX,
  });
}

/** Manages the recipe list + localStorage persistence */
export class RecipeStore {
  recipes: MixRecipe[] = [];
  private readonly emitter = createEmitter<RecipeStoreChange>();

  constructor(private storage: RecipeStorage | null = null) {
    this.load();
  }

  /** #13: supports multiple subscribers, returns an unsubscribe function */
  subscribe(fn: (event: RecipeStoreChange) => void): Unsubscribe {
    return this.emitter.subscribe(fn);
  }

  get(id: string): MixRecipe | undefined {
    return this.recipes.find((r) => r.id === id);
  }

  create(name: string): MixRecipe {
    const recipe: MixRecipe = {
      id: freshLibraryId(RECIPE_ID_PREFIX, new Set(this.recipes.map((r) => r.id))),
      name,
      entries: [],
    };
    this.recipes.push(recipe);
    this.persist();
    return recipe;
  }

  update(id: string, patch: Partial<Pick<MixRecipe, 'name' | 'entries'>>): void {
    const recipe = this.get(id);
    if (!recipe) return;
    Object.assign(recipe, patch);
    this.persist();
  }

  remove(id: string): void {
    this.recipes = this.recipes.filter((r) => r.id !== id);
    this.persist();
  }

  /**
   * Replace the entire list. **For e2e setup only** (via `window.__bs`).
   *
   * **Never used for loading work files.** It would wipe out existing recipes, so
   * loading always goes through `planRecipeMerge` + `applyMerge` instead (#69 precursor).
   */
  replaceAll(recipes: MixRecipe[]): void {
    this.recipes = recipes.map((r) => cloneRecipe(r));
    this.persist();
  }

  /**
   * Apply a `planRecipeMerge` plan (for work-file loading).
   *
   * **Doesn't remove existing recipes.** Recipes belong to the user, not the work —
   * this is to prevent "opened someone else's work and my own recipes disappeared"
   * (#69 precursor).
   */
  applyMerge(plan: RecipeMergePlan): void {
    if (!plan.additions.length) return;
    this.recipes = [...this.recipes, ...plan.additions];
    this.persist();
  }

  private load(): void {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (raw) this.recipes = JSON.parse(raw) as MixRecipe[];
    } catch {
      this.recipes = [];
    }
  }

  private persist(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.recipes));
    } catch {
      // Keep working even if localStorage is unavailable
    }
    this.emitter.notify({ kind: 'change' });
  }
}
