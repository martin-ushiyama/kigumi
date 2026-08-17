/**
 * Shared rules for moving "items tied to an account" back and forth with work files.
 *
 * Both recipes (`MixRecipe`) and components (`ComponentTemplate`) share the same structure:
 *
 * - Hold a list on the account side (localStorage)
 * - Bundle into a work file **only the items that work references**
 * - When opening a work, add to the owner's list without removing anything
 *
 * Writing this rule in two separate places invites the accident of fixing only one, so it lives here in exactly one spot (lifted as-is from the rule introduced on the recipe side).
 */

/** The minimal shape shared by anything that goes into a library */
export interface LibraryItem {
  readonly id: string;
}

/**
 * Merge plan produced at load time.
 *
 * Planning is kept separate from applying because **reference ids need to be
 * re-pointed first**. If the owner's items were added first and then importing the
 * work failed, the items alone would grow while the work fails to load, leaving a
 * half-applied state.
 */
export interface LibraryMergePlan<T extends LibraryItem> {
  /** Items to add to the list (existing items are not included here) */
  additions: T[];
  /** File-sourced id -> id in the list. Only entries whose id was reassigned are included */
  remap: Map<string, string>;
}

/** Generate an id that doesn't collide with existing ids */
export function freshLibraryId(prefix: string, taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Plan adding file-sourced items without removing anything from the owner's list.
 *
 * **Identity is decided by content, not id.** The invariant is "never hold the same
 * content twice", collapsing the add-vs-merge decision into a single rule:
 *
 * - If the same content already exists -> don't add, merge into that id (if the id
 *   differs, record it in `remap`)
 * - If not -> add. Keep the id as-is if it's free, otherwise allocate a new one
 *
 * Matching on id alone would mean **the same item keeps reappearing under a different
 * id every time a colliding work is opened**. Overwriting the existing item
 * would corrupt the owner's data, and discarding the file's version would change the
 * appearance of the loaded work — so "merge by content" is the only way out.
 */
export function planLibraryMerge<T extends LibraryItem>(
  existing: readonly T[],
  incoming: readonly T[],
  options: {
    /** Whether the content matches (id is not compared) */
    sameContent: (a: T, b: T) => boolean;
    /** Create a copy with only the id swapped out */
    withId: (item: T, id: string) => T;
    /** Prefix used when allocating an id */
    idPrefix: string;
  },
): LibraryMergePlan<T> {
  const byId = new Map(existing.map((item) => [item.id, item]));
  const additions: T[] = [];
  const remap = new Map<string, string>();

  for (const item of incoming) {
    const twin = [...byId.values()].find((known) => options.sameContent(known, item));
    if (twin) {
      if (twin.id !== item.id) remap.set(item.id, twin.id);
      continue;
    }
    const id = byId.has(item.id) ? freshLibraryId(options.idPrefix, new Set(byId.keys())) : item.id;
    const added = options.withId(item, id);
    additions.push(added);
    byId.set(id, added);
    if (id !== item.id) remap.set(item.id, id);
  }

  return { additions, remap };
}
