import { createEmitter, type Unsubscribe } from './emitter';
import { freshLibraryId, planLibraryMerge, type LibraryMergePlan } from './library';
import type { PatternPaint } from './patternpaint';
import type { GroupTransform } from './transform';
import type { CellKey } from './types';

/**
 * Component (equivalent to Figma's Component, #69).
 *
 * **Lives outside the world.** Like recipes, it's tied to an account, and only the
 * components a given piece of work uses are bundled into its work file (shared rules
 * live in `library.ts`).
 *
 * The subtree is stored as an array + parent index. This mirrors the work file's
 * `groups` representation, so export/import can round-trip without converting shape.
 * **Nested components are out of initial scope** (settled in #69), so a node only ever
 * represents a plain group.
 */
export interface ComponentNode {
  name: string;
  /** Parent index within the `nodes` array. `null` = the component's root */
  parent: number | null;
  transform?: GroupTransform;
  hidden?: boolean;
  locked?: boolean;
}

/** Per-node cell. `[nodeIndex, local key, raw value]` */
export type ComponentCell = [number, CellKey, number];

/** Per-node paint. `[nodeIndex, local key, paint]` */
export type ComponentPattern = [number, CellKey, PatternPaint];

export interface ComponentTemplate {
  readonly id: string;
  readonly name: string;
  /** `[0]` is the root. A parent always appears before its children (export order doubles as restore order) */
  readonly nodes: readonly ComponentNode[];
  readonly cells: readonly ComponentCell[];
  readonly patterns: readonly ComponentPattern[];
}

export type ComponentStoreChange = { kind: 'change' };

const STORAGE_KEY = 'blocksmith.components.v1';
const COMPONENT_ID_PREFIX = 'c';

interface ComponentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Hook for deciding how the list is represented when persisted (#142 review P1).
 *
 * A `ComponentTemplate`'s cells are raw values that include **a position within the
 * catalog**, so writing them straight to localStorage means a block that's added later
 * or a change in generation order would open as a different block. The conversion
 * to/from a stable representation (block id + orientation) belongs to the persistence
 * layer (`project/persistence`), so this only opens the hook — the assembly side
 * (main.ts) plugs in the implementation.
 *
 * When omitted, writes the raw value as-is (for tests and lists that aren't persisted).
 */
export interface ComponentCodec {
  encode(template: ComponentTemplate): unknown;
  /** null if it can't be read (drop only the corrupted entry) */
  decode(raw: unknown): ComponentTemplate | null;
}

export function cloneComponent(template: ComponentTemplate, id: string = template.id): ComponentTemplate {
  return {
    id,
    name: template.name,
    nodes: template.nodes.map((node) => ({ ...node })),
    cells: template.cells.map((cell) => [...cell] as ComponentCell),
    patterns: template.patterns.map(([index, key, paint]) => [index, key, { ...paint }] as ComponentPattern),
  };
}

/**
 * Whether two components have identical content (id is not compared).
 *
 * The only thing that matters is **whether they'd restore to the same shape**. The
 * ordering of `nodes` / `cells` / `patterns` is decided at export time, so comparing
 * with order included is fine (the same shape always produces the same order).
 */
export function sameComponent(a: ComponentTemplate, b: ComponentTemplate): boolean {
  if (a.name !== b.name) return false;
  if (a.nodes.length !== b.nodes.length || a.cells.length !== b.cells.length) return false;
  if (a.patterns.length !== b.patterns.length) return false;
  const sameNode = (x: ComponentNode, y: ComponentNode): boolean =>
    x.name === y.name &&
    x.parent === y.parent &&
    !!x.hidden === !!y.hidden &&
    !!x.locked === !!y.locked &&
    JSON.stringify(x.transform ?? null) === JSON.stringify(y.transform ?? null);
  if (!a.nodes.every((node, i) => sameNode(node, b.nodes[i]!))) return false;
  if (!a.cells.every(([n, k, v], i) => {
    const [n2, k2, v2] = b.cells[i]!;
    return n === n2 && k === k2 && v === v2;
  })) return false;
  return a.patterns.every(([n, k, paint], i) => {
    const [n2, k2, paint2] = b.patterns[i]!;
    return (
      n === n2 &&
      k === k2 &&
      paint.recipeId === paint2.recipeId &&
      paint.variant === paint2.variant &&
      paint.sourceRaw === paint2.sourceRaw &&
      paint.appliedRaw === paint2.appliedRaw
    );
  });
}

export type ComponentMergePlan = LibraryMergePlan<ComponentTemplate>;

/**
 * Plan adding file-sourced components without deleting existing ones.
 *
 * The actual rules live in `planLibraryMerge` (shared with recipes). Here we only
 * supply the definition of "same content".
 */
export function planComponentMerge(
  existing: readonly ComponentTemplate[],
  incoming: readonly ComponentTemplate[],
): ComponentMergePlan {
  return planLibraryMerge(existing, incoming, {
    sameContent: sameComponent,
    withId: cloneComponent,
    idPrefix: COMPONENT_ID_PREFIX,
  });
}

/** Manages the component list + localStorage persistence (same shape as `RecipeStore`) */
export class ComponentStore {
  templates: ComponentTemplate[] = [];
  private readonly emitter = createEmitter<ComponentStoreChange>();

  constructor(
    private storage: ComponentStorage | null = null,
    private codec: ComponentCodec | null = null,
  ) {
    this.load();
  }

  subscribe(fn: (event: ComponentStoreChange) => void): Unsubscribe {
    return this.emitter.subscribe(fn);
  }

  get(id: string): ComponentTemplate | undefined {
    return this.templates.find((t) => t.id === id);
  }

  /**
   * Allocate the next available id (same shape as `Document.nextGroupId`).
   *
   * The id is needed before registration because **the transaction that writes
   * `templateId` onto the group is built first**. If applying the transaction fails,
   * we simply don't call `add` — this avoids a state where the list grows but no
   * instance exists.
   */
  nextId(): string {
    return freshLibraryId(COMPONENT_ID_PREFIX, new Set(this.templates.map((t) => t.id)));
  }

  /** Register a template. Assumes the id was allocated via `nextId()` (ignored if duplicate) */
  add(template: ComponentTemplate): ComponentTemplate {
    if (this.get(template.id)) return template;
    const added = cloneComponent(template);
    this.templates.push(added);
    this.persist();
    return added;
  }

  /**
   * Replace by id. Adds if missing, removes if `null` (#142 review P1).
   *
   * **The hook called from history** (`Document`'s `setComponentTemplate` op). Undo /
   * redo restore "what this id used to be", so a single operation that can restore
   * both presence and absence is needed — `replace` silently drops a nonexistent id,
   * and `add` re-allocates the id, so neither works as an undo target.
   */
  set(id: string, template: ComponentTemplate | null): void {
    const index = this.templates.findIndex((t) => t.id === id);
    if (template === null) {
      if (index === -1) return;
      this.templates.splice(index, 1);
    } else if (index === -1) {
      this.templates.push(cloneComponent(template, id));
    } else {
      this.templates[index] = cloneComponent(template, id);
    }
    this.persist();
  }

  replace(template: ComponentTemplate): void {
    const index = this.templates.findIndex((t) => t.id === template.id);
    if (index === -1) return;
    this.templates[index] = cloneComponent(template);
    this.persist();
  }

  rename(id: string, name: string): void {
    const index = this.templates.findIndex((t) => t.id === id);
    if (index === -1) return;
    this.templates[index] = { ...this.templates[index]!, name };
    this.persist();
  }

  /**
   * Remove from the list.
   *
   * **Does not clean up instances here.** "Deleting a component turns its instances
   * into plain groups" (settled in #69) is an operation that lives in Document's
   * history, so the op side is what clears `templateId` (don't mix the decision to
   * delete with the decision to detach).
   */
  remove(id: string): void {
    this.templates = this.templates.filter((t) => t.id !== id);
    this.persist();
  }

  /** Apply a `planComponentMerge` plan (for work-file loading). Doesn't remove existing entries */
  applyMerge(plan: ComponentMergePlan): void {
    if (!plan.additions.length) return;
    this.templates = [...this.templates, ...plan.additions];
    this.persist();
  }

  private load(): void {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      // **Still load the rest if one entry is corrupted.** The list belongs to the user, and losing it entirely is unrecoverable
      this.templates = this.codec
        ? parsed.map((entry) => this.codec!.decode(entry)).filter((t): t is ComponentTemplate => t !== null)
        : (parsed as ComponentTemplate[]);
    } catch {
      this.templates = [];
    }
  }

  private persist(): void {
    try {
      const payload = this.codec ? this.templates.map((t) => this.codec!.encode(t)) : this.templates;
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Keep working even if localStorage is unavailable
    }
    this.emitter.notify({ kind: 'change' });
  }
}
