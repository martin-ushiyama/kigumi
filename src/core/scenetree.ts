import {
  assertValidGroupTransform,
  cloneTransform,
  composeTransform,
  IDENTITY_RESOLVED,
  IDENTITY_TRANSFORM,
  type GroupTransform,
  type ResolvedTransform,
} from './transform';

/**
 * Pure data structure for the group tree (hierarchy + visibility/lock + transform + sibling order),
 * independent of three.js/DOM. Assumes mutating methods are called only by Document when applying
 * an op (a direct call bypassing Document is a responsibility violation).
 *
 * **Does not hold cell membership** (#37 B1b). The old implementation expressed "1 cell = 1 group"
 * via a bidirectional index of `groupByCell` / `cellsByGroup`, but in the owner-local model,
 * membership *is* `OwnerVoxelStore` holding cells keyed by owner — keeping a copy on the tree side
 * would create a duplicate source of truth. Queries that need a cell set were moved to helpers in
 * `core/ownerlocal.ts` (`refsOfSubtree` / `countCellsInSubtree` / `directCellCount`) and WorldIndex's
 * facade (`ownerAtWorld` / `isWorldCellHidden` / `isWorldCellLocked`).
 */
export interface GroupNode {
  id: string; // runtime id "g0","g1"... (monotonic counter, regenerated on load)
  name: string;
  parentId: string | null; // null = root
  childIds: string[]; // ordered child group ids only (cells are never child nodes)
  /** Hidden (excluded from rendering and picking). Defaults to false when omitted (no existing createGroup call site needs to change) */
  hidden?: boolean;
  /** Locked (excluded from selection / place / delete / fill editing). Defaults to false when omitted */
  locked?: boolean;
  /** Transform relative to the parent group's coordinate system (#37). Defaults to identity when omitted. GroupTransform is deep readonly at the type level */
  transform?: GroupTransform;
  /**
   * Which component this group is an instance of (#69). Omitted = plain group.
   *
   * **Instances also hold cells like a normal group** (#69 option B). Adding an owner with no
   * actual entity would force `refsOfSubtree` / `buildMirror` / `buildDuplicate` / `WorldIndex` to
   * all carry branching logic for it, so a reference-based approach was not adopted. Only the mark increases here.
   */
  templateId?: string;
}

/**
 * A read-only view of GroupNode. Making `childIds` a `readonly string[]` too also forbids
 * destructive array mutation like `node.childIds.push(...)` at compile time
 * (the `readonly` property modifier alone doesn't protect the array's contents, #19 review finding).
 */
export type ReadonlyGroupNode = {
  readonly [K in keyof GroupNode]: GroupNode[K] extends string[] ? readonly string[] : GroupNode[K];
};

/**
 * SceneTree's read-only contract. Pass this type to render/input/ui so that write methods
 * (insertNode/removeNode/rename/setHidden/setLocked/setTransform/reparent/clear/replaceAll)
 * cannot be called at the type level. Writes are restricted to going through Document
 * (src/core/document.ts) (#10). `getNode`/`allNodesPreOrder` return `ReadonlyGroupNode` — passing
 * the same object as the internal Map as a mutable `GroupNode` would let the caller rewrite the
 * real tree via property assignment or `childIds.push()` without going through Document
 * (#19 review finding). `nextId` has the side effect of issuing group ids (idCounter++), so it's
 * excluded from the Reader and consolidated behind Document.nextGroupId().
 */
export interface SceneTreeReader {
  getNode(id: string): ReadonlyGroupNode | undefined;
  childrenOf(parentId: string | null): readonly string[];
  outermostAncestor(id: string): string;
  isAncestor(a: string, b: string): boolean;
  isHiddenEffective(id: string | null): boolean;
  isLockedEffective(id: string | null): boolean;
  instanceRootOf(id: string | null, isLiveTemplate?: (templateId: string) => boolean): string | null;
  commonAncestor(parents: (string | null)[]): string | null;
  allNodesPreOrder(): IterableIterator<ReadonlyGroupNode>;
  transformChain(id: string | null): ResolvedTransform;
}

export class SceneTree implements SceneTreeReader {
  private nodes = new Map<string, GroupNode>();
  private rootChildIds: string[] = [];
  private idCounter = 0;

  // ---- reads ----

  getNode(id: string): ReadonlyGroupNode | undefined {
    return this.nodes.get(id);
  }

  childrenOf(parentId: string | null): readonly string[] {
    if (parentId === null) return this.rootChildIds;
    return this.nodes.get(parentId)?.childIds ?? [];
  }

  /** Walks the parentId chain up to directly under root. Returns as-is if already directly under root */
  outermostAncestor(id: string): string {
    let current = this.nodes.get(id);
    if (!current) return id;
    while (current.parentId !== null) {
      const parent = this.nodes.get(current.parentId);
      if (!parent) break;
      current = parent;
    }
    return current.id;
  }

  /** Whether a is a (strict) ancestor of b. a === b is false */
  isAncestor(a: string, b: string): boolean {
    let current = this.nodes.get(b);
    while (current) {
      if (current.parentId === a) return true;
      if (current.parentId === null) return false;
      current = this.nodes.get(current.parentId);
    }
    return false;
  }

  /** True if hidden is set on self or any ancestor (same inheritance as Figma). Cells themselves are out of scope, see cellIsHidden */
  isHiddenEffective(id: string | null): boolean {
    let current = id === null ? undefined : this.nodes.get(id);
    while (current) {
      if (current.hidden) return true;
      current = current.parentId === null ? undefined : this.nodes.get(current.parentId);
    }
    return false;
  }

  /**
   * The id of the nearest component instance among self or ancestors (#69).
   *
   * **The contents of an instance are not editable.** Even if fixed internally, it gets overwritten
   * the moment the component is edited (the propagated version wins), so touching it produces an
   * edit that vanishes. Make it a single path: detach first if you want to change something individually.
   */
  instanceRootOf(id: string | null, isLiveTemplate: (templateId: string) => boolean = () => true): string | null {
    let current = id === null ? undefined : this.nodes.get(id);
    while (current) {
      // **A mark is a weak reference.** Even if a mark for a component removed from the library
      // remains, it's treated as just a plain group (same handling as when a paint's referenced
      // recipe is deleted, #142 review P1)
      if (current.templateId != null && isLiveTemplate(current.templateId)) return current.id;
      current = current.parentId === null ? undefined : this.nodes.get(current.parentId);
    }
    return null;
  }

  /** True if locked is set on self or any ancestor (same inheritance as Figma) */
  isLockedEffective(id: string | null): boolean {
    let current = id === null ? undefined : this.nodes.get(id);
    while (current) {
      if (current.locked) return true;
      current = current.parentId === null ? undefined : this.nodes.get(current.parentId);
    }
    return false;
  }

  /**
   * Folds the transform of the entire ancestor chain into a single discrete affine (ResolvedTransform) (#37).
   * Same ancestor walk as isHiddenEffective. id === null (root) is identity.
   * A node with no transform set composes in as identity.
   */
  transformChain(id: string | null): ResolvedTransform {
    let resolved = IDENTITY_RESOLVED;
    let current = id === null ? undefined : this.nodes.get(id);
    while (current) {
      resolved = composeTransform(current.transform ?? IDENTITY_TRANSFORM, resolved);
      current = current.parentId === null ? undefined : this.nodes.get(current.parentId);
    }
    return resolved;
  }

  /** Returns the chain including root (root first). id === null yields just [null] */
  private chainToRoot(id: string | null): (string | null)[] {
    const chain: (string | null)[] = [];
    let current = id;
    while (current !== null) {
      chain.unshift(current);
      current = this.nodes.get(current)?.parentId ?? null;
    }
    chain.unshift(null);
    return chain;
  }

  /** LCA. If any input is null (root), root is the common ancestor, so returns null */
  commonAncestor(parents: (string | null)[]): string | null {
    if (parents.length === 0) return null;
    const chains = parents.map((p) => this.chainToRoot(p));
    const minLen = Math.min(...chains.map((c) => c.length));
    let common: string | null = null;
    for (let i = 0; i < minLen; i++) {
      const candidate = chains[0]![i]!;
      if (chains.every((c) => c[i] === candidate)) common = candidate;
      else break;
    }
    return common;
  }

  *allNodesPreOrder(): IterableIterator<ReadonlyGroupNode> {
    yield* this.walkPreOrder(this.rootChildIds);
  }

  private *walkPreOrder(childIds: readonly string[]): IterableIterator<GroupNode> {
    for (const id of childIds) {
      const node = this.nodes.get(id);
      if (!node) continue;
      yield node;
      yield* this.walkPreOrder(node.childIds);
    }
  }

  nextId(): string {
    return `g${this.idCounter++}`;
  }

  // ---- mutations — called only by Document when applying an op ----

  /**
   * If the caller-passed node were held as-is, an alias left with the caller could rewrite
   * internal state without going through Document (#19 review finding). To sever ownership,
   * a defensive copy (childIds cloned as a separate array too) is held instead.
   */
  insertNode(node: GroupNode, index: number): void {
    // Allowing a duplicate id would let Map.set silently overwrite the existing node, while also
    // inserting the same id twice into the parent's childIds. On rollback (deleteGroup's inverse =
    // removeNode), there's no way to tell "which g0" it was, causing an incident where existing
    // group data is lost (#22 3rd-round review finding)
    if (this.nodes.has(node.id)) throw new Error(`Tried to create a group id that already exists: ${node.id}`);
    // A new group is always created with empty childIds (invariant per DocOp.createGroup's type
    // comment). Without validating this, merely passing a node's own id inside its childIds would
    // create a self-cycle in the tree, sending traversal methods like allNodesPreOrder into an
    // infinite loop (#22 4th-round review finding)
    if (node.childIds.length > 0) throw new Error(`A new group's childIds must be empty: ${node.id}`);
    // transform gets the same defensive copy + invariant validation as childIds (#37 — don't rely
    // solely on persistence validation, validate at the core boundary too: an invalid-parity pivot2
    // would knock a 90-degree rotation off the grid)
    if (node.transform !== undefined) assertValidGroupTransform(node.transform);
    const owned: GroupNode = {
      ...node,
      childIds: [...node.childIds],
      ...(node.transform !== undefined ? { transform: cloneTransform(node.transform) } : {}),
    };
    const siblings = owned.parentId === null ? this.rootChildIds : this.nodes.get(owned.parentId)?.childIds;
    if (!siblings) throw new Error(`Parent group not found: ${owned.parentId}`);
    siblings.splice(index, 0, owned.id);
    this.nodes.set(owned.id, owned);
  }

  /**
   * Only a node with no child groups can be removed (throws if it has children).
   *
   * **Rejecting deletion of a group that has cells is Document's responsibility** (#37 B1b). The
   * old implementation also checked `cellsOf(id).size > 0` here, but with the membership index
   * removed this safeguard disappears too, so the "direct cell count 0 and child count 0" check was
   * moved to Document's transaction final state (`Document.assertGroupRemovable`). The tree alone
   * can only know whether it has its own children.
   */
  removeNode(id: string): void {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Tried to delete a group that doesn't exist: ${id}`);
    if (this.childrenOf(id).length > 0) {
      throw new Error(`Cannot delete a group that has child groups: ${id}`);
    }
    const siblings = node.parentId === null ? this.rootChildIds : this.nodes.get(node.parentId)?.childIds;
    if (siblings) {
      const idx = siblings.indexOf(id);
      if (idx !== -1) siblings.splice(idx, 1);
    }
    this.nodes.delete(id);
  }

  rename(id: string, name: string): void {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Tried to rename a group that doesn't exist: ${id}`);
    node.name = name;
  }

  setHidden(id: string, hidden: boolean): void {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Tried to change the visibility of a group that doesn't exist: ${id}`);
    node.hidden = hidden;
  }

  setLocked(id: string, locked: boolean): void {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Tried to change the lock state of a group that doesn't exist: ${id}`);
    node.locked = locked;
  }

  /**
   * Bulk-remaps component ids (#69, for merging during project load).
   *
   * Aligns the id a loaded artwork's group points to with the id re-issued on the library side.
   * **Not put into Document's history** — used against an independent scene before import, not yet
   * a live scene (`loadProject` calls this before `doc.replaceAll`).
   */
  remapTemplateIds(remap: ReadonlyMap<string, string>): void {
    if (!remap.size) return;
    for (const node of this.nodes.values()) {
      if (node.templateId === undefined) continue;
      const next = remap.get(node.templateId);
      if (next !== undefined) node.templateId = next;
    }
  }

  /** Attaches/detaches the mark that a group is a component instance (#69). `null` reverts it to a plain group */
  setTemplateId(id: string, templateId: string | null): void {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Tried to change the component mark of a group that doesn't exist: ${id}`);
    if (templateId === null) delete node.templateId;
    else node.templateId = templateId;
  }

  /**
   * Sets a group's transform (#37). Runtime-validated at the core boundary (angleSteps 0-3 /
   * each component a safe integer / pivot2's x/z parity match). Doesn't hold the caller's `t`
   * directly — deep-copies it (same alias-severing as insertNode's childIds, same pattern as #19).
   *
   * `undefined` restores to "transform not set" (property deletion). The v2 migration omits the
   * transform under the contract "initialize the pivot from the bounds center on first rotation"
   * (#38 review), so undoing the first rotation needs a path back to the unset state — replacing
   * with identity would bake in pivot=[0,0], breaking the contract by making the next rotation pivot around the origin.
   */
  setTransform(id: string, t: GroupTransform | undefined): void {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Tried to change the transform of a group that doesn't exist: ${id}`);
    if (t === undefined) {
      delete node.transform;
      return;
    }
    assertValidGroupTransform(t);
    node.transform = cloneTransform(t);
  }

  reparent(id: string, parentId: string | null, index: number): void {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Tried to reparent a group that doesn't exist: ${id}`);
    // Making self, or a descendant of self, the new parent would create a cycle in the parentId
    // chain, sending traversal methods like outermostAncestor/isAncestor into an infinite loop
    // (#22 3rd-round review finding)
    if (parentId !== null && (parentId === id || this.isAncestor(id, parentId))) {
      throw new Error(`Reparent would create a circular reference: ${id} → ${parentId}`);
    }
    const newSiblings = parentId === null ? this.rootChildIds : this.nodes.get(parentId)?.childIds;
    if (!newSiblings) throw new Error(`Parent group not found: ${parentId}`);
    const oldSiblings = node.parentId === null ? this.rootChildIds : this.nodes.get(node.parentId)?.childIds;
    if (oldSiblings) {
      const idx = oldSiblings.indexOf(id);
      if (idx !== -1) oldSiblings.splice(idx, 1);
    }
    node.parentId = parentId;
    newSiblings.splice(index, 0, id);
  }

  clear(): void {
    this.nodes.clear();
    this.rootChildIds = [];
    // idCounter is not reset (keeps nextId's uniqueness across the session)
  }

  /**
   * For project loading. Assumes nodes are in pre-order (parents come before children).
   *
   * Previously this wrote directly to the Map here independently of insertNode, so adding an
   * invariant check like duplicate-id rejection to insertNode's side wasn't reflected on this path
   * (#22 4th-round review finding: trying to separately maintain the same invariant across multiple
   * independent implementations means one gets fixed while the other is overlooked). Changed to
   * call insertNode instead, consolidating the validation logic into one place.
   */
  replaceAll(nodes: GroupNode[]): void {
    this.clear();
    for (const node of nodes) {
      const siblings = node.parentId === null ? this.rootChildIds : this.nodes.get(node.parentId)?.childIds;
      if (!siblings) throw new Error(`Parent group not found (pre-order violation): ${node.parentId}`);
      // childIds gets pushed into the parent's childIds and rebuilt by the child node's own
      // processing, so the input's childIds is ignored and inserted empty (also consistent with
      // insertNode's own "must be empty" validation)
      this.insertNode({ ...node, childIds: [] }, siblings.length);
      this.reserveId(node.id);
    }
  }

  /**
   * Reflects an externally-brought-in id (project load, rollback snapshot) into the id-issuance
   * counter (#37 B1b). Without this, `nextId()` right after importing a `g0` issued by a different
   * tree would return the same `g0`, causing the next group creation to collide with the existing
   * group (throws via insertNode's duplicate-id rejection; actually hit on the v3 load path).
   */
  private reserveId(id: string): void {
    const m = /^g(\d+)$/.exec(id);
    if (!m) return;
    const n = Number(m[1]);
    if (Number.isSafeInteger(n) && n >= this.idCounter) this.idCounter = n + 1;
  }
}
