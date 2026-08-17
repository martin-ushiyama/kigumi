import {
  cloneComponent,
  type ComponentCell,
  type ComponentNode,
  type ComponentPattern,
  type ComponentTemplate,
} from '../core/component';
import type { Document, DocOp, HistorySessionMark } from '../core/document';
import { isValidCell, OP_MAX_CELLS } from '../core/limits';
import { activePatternAt } from '../core/patternpaint';
import {
  applyTransform,
  composeResolved,
  composeTransform,
  computePivot2,
  IDENTITY_RESOLVED,
  IDENTITY_TRANSFORM,
  type GroupTransform,
  type ResolvedTransform,
} from '../core/transform';
import { makeCellKey, parseCellKey, type Cell, type CellKey } from '../core/types';
import type { OpResult } from './ops';
import type { NormalizedSelection } from './selection';

/**
 * Registering and placing a component.
 *
 * **An instance also holds cells like a regular group** (option B). Adding an owner
 * with no physical body would force every existing builder to carry a branch for it, so
 * a reference-based approach isn't used. All this creates is "a regular group + a
 * `templateId` marker".
 *
 * Nothing special is done for paint. `PatternPaint` doesn't hold the pattern itself and
 * always derives it from world coordinates (`patternSampleAt`), so **the pattern
 * changes whenever the placement location changes** — this structurally satisfies "the
 * pattern-paint algorithm is decided by coordinates".
 */

/** Result of registering. Call `store.add(template)` only after the tx has applied successfully */
export interface CreateComponentResult {
  template: ComponentTemplate;
  /** Turns the original group into an instance (= writes `templateId`) */
  tx: { ops: DocOp[] };
}

/**
 * Extracts the selected group as a component, turning that group itself into an
 * instance.
 *
 * `id` is received from the caller because **the transaction is built before
 * registering into the list** (taken via `ComponentStore.nextId()`). If applying the tx
 * fails, we simply skip registering, avoiding a state where the list grew but no
 * instance exists.
 */
export function buildCreateComponent(
  doc: Document,
  sel: NormalizedSelection,
  id: string,
): OpResult | CreateComponentResult {
  if (sel.kind !== 'groups' || sel.ids.length !== 1) return { error: 'componentNeedsOneGroup' };
  const rootId = sel.ids[0]!;
  const rootNode = doc.tree.getNode(rootId);
  if (!rootNode) return { error: 'groupNotFound' };
  // **Only look at a live marker** — a group whose marker points to a component that's
  // been removed from the list is just a regular group, so it can be made into a
  // component again
  if (doc.templateIdOf(rootId) !== null) return { error: 'componentAlreadyInstance' };
  // **Refuse if an instance exists among the descendants**. Nesting is
  // out of initial scope, and extracting as-is would drop the child's marker and
  // collapse it into a regular group — an unrequested detach. Checking only the root
  // wouldn't guard against this, so the whole selected subtree is checked first
  if (hasInstanceDescendant(doc, rootId)) return { error: 'componentNestedInstance' };

  const nodes: ComponentNode[] = [];
  const cells: ComponentCell[] = [];
  const patterns: ComponentPattern[] = [];
  const indexOfGroup = new Map<string, number>();

  // The root's transform isn't carried out — where it's placed is decided each time it's
  // placed. A child's transform is part of the shape, so it's kept as-is
  const collect = (groupId: string, parent: number | null): void => {
    const node = doc.tree.getNode(groupId);
    if (!node) return;
    const myIndex = nodes.length;
    nodes.push({
      name: node.name,
      parent,
      ...(node.hidden !== undefined ? { hidden: node.hidden } : {}),
      ...(node.locked !== undefined ? { locked: node.locked } : {}),
      ...(parent !== null && node.transform !== undefined ? { transform: node.transform } : {}),
    });
    indexOfGroup.set(groupId, myIndex);
    for (const [localKey, raw] of doc.scene.cells.entriesOf(groupId)) {
      cells.push([myIndex, localKey, raw]);
      const paint = doc.scene.patterns
        ? activePatternAt(doc.scene.patterns, doc.scene.cells, groupId, localKey)
        : null;
      if (paint) patterns.push([myIndex, localKey, paint]);
    }
    for (const childId of doc.tree.childrenOf(groupId)) collect(childId, myIndex);
  };
  collect(rootId, null);

  if (!cells.length) return { error: 'componentEmpty' };

  const template: ComponentTemplate = { id, name: rootNode.name, nodes, cells, patterns };
  return {
    template,
    tx: { ops: [{ kind: 'setGroupTemplateId', id: rootId, before: null, after: id }] },
  };
}

/**
 * Whether a live instance exists within the subtree (excluding itself).
 *
 * A dead marker (a component not in the list) doesn't count — that's just a regular
 * group, so extracting it along with the rest loses nothing
 */
function hasInstanceDescendant(doc: Document, rootId: string): boolean {
  const walk = (id: string): boolean =>
    doc.tree.childrenOf(id).some((childId) => doc.templateIdOf(childId) !== null || walk(childId));
  return walk(rootId);
}

/** Narrows whether `buildCreateComponent`'s return value is an error */
export function isCreateComponentError(
  result: OpResult | CreateComponentResult,
): result is OpResult {
  return 'error' in result;
}

/**
 * Places a component at world coordinates.
 *
 * Cell local coordinates are placed as-is from the component, and **the position is
 * loaded onto the root group's translate** (same design as `buildDuplicate` — content
 * that's already rotated doesn't lose its shape).
 */
export function buildPlaceComponent(
  doc: Document,
  template: ComponentTemplate,
  worldOrigin: [number, number, number],
): OpResult {
  if (!template.nodes.length) return { error: 'componentNotFound' };
  if (template.cells.length > OP_MAX_CELLS) {
    return {
      error: 'tooManyTargets',
      errorVars: { max: OP_MAX_CELLS.toLocaleString() },
    };
  }

  // Check up front, before building the op, whether the placed result fits within range
  // (don't leave things half-placed on failure)
  for (const [dx, dy, dz] of componentPlacementOffsets(template)) {
    if (!isValidCell(dx + worldOrigin[0], dy + worldOrigin[1], dz + worldOrigin[2])) {
      return { error: 'outOfRangePlaceComponent' };
    }
  }

  const ops: DocOp[] = [];
  const newIds = template.nodes.map(() => doc.nextGroupId());
  const rootIndex = doc.tree.childrenOf(null).length;
  // The placement position **goes onto the root's translate** (same design as
  // `buildDuplicate`). Shifting cell local coordinates would break the shape of content
  // that has rotation
  const rootTransform = placementTransform(template, worldOrigin);

  template.nodes.forEach((node, i) => {
    const parentId = node.parent === null ? null : newIds[node.parent]!;
    ops.push({
      kind: 'createGroup',
      node: {
        id: newIds[i]!,
        name: node.name,
        parentId,
        childIds: [],
        ...(node.hidden !== undefined ? { hidden: node.hidden } : {}),
        ...(node.locked !== undefined ? { locked: node.locked } : {}),
        ...(node.parent === null ? { transform: rootTransform } : node.transform !== undefined ? { transform: node.transform } : {}),
        // Only the root carries the "this is an instance" marker. Child groups inside are just structure
        ...(node.parent === null ? { templateId: template.id } : {}),
      },
      index: node.parent === null ? rootIndex : template.nodes.filter((n, j) => n.parent === node.parent && j < i).length,
    });
  });

  for (const [nodeIndex, localKey, raw] of template.cells) {
    ops.push({ kind: 'voxel', owner: newIds[nodeIndex]!, key: localKey, before: null, after: raw });
  }
  for (const [nodeIndex, localKey, paint] of template.patterns) {
    ops.push({ kind: 'setPattern', owner: newIds[nodeIndex]!, key: localKey, before: null, after: paint });
  }

  return { tx: { ops }, newSelection: { kind: 'groups', ids: [newIds[0]!] } };
}

/**
 * Builds the placement position as the root group's transform.
 *
 * The rotation center (`pivot2`) is decided **from the component's contents**. Making
 * this `[0, 0]` would center a rotation right after placing on the origin, sending an
 * instance placed far away flying off (same contract as using the bounds center for a
 * transform-unset group's first rotation).
 */
export function placementTransform(
  template: ComponentTemplate,
  worldOrigin: [number, number, number],
): GroupTransform {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, y, z] of componentProjectedCells(template)) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const pivot2 = Number.isFinite(minX) ? computePivot2({ minX, maxX, minZ, maxZ }) : ([0, 0] as const);
  // **Subtract off the location it was made at.** Cells are owner-local, but for a group
  // with no transform, local == world, so a component made high up or far away has that
  // position baked into its cell coordinates. Placing it as-is would put it away from
  // the click position
  const [ox, oy, oz] = componentMinCorner(template);
  return {
    angleSteps: 0,
    translate: [worldOrigin[0] - ox, worldOrigin[1] - oy, worldOrigin[2] - oz],
    pivot2: [pivot2[0], pivot2[1]],
  };
}

/**
 * Folds each node's transform up to the root, collapsing the component into **a single
 * flat cell list**.
 *
 * **This is the source of truth for everything placement-related.** The min corner,
 * ghost preview, placement result, and range checks all read this. Using
 * `template.cells`'s local coordinates as-is would offset "the location shown" from "the
 * location actually placed" by however much a child node was moved.
 *
 * **The root's transform is not applied.** It gets swapped in at the placement position
 * when placing, so what's being looked at here is "the shape of the contents as seen
 * from the root".
 */
export function componentProjectedCells(template: ComponentTemplate): Cell[] {
  // A parent always comes before itself in the array (`ComponentTemplate`'s invariant), so this folds in a single forward pass
  const resolved: ResolvedTransform[] = [];
  for (const node of template.nodes) {
    if (node.parent === null) {
      resolved.push(IDENTITY_RESOLVED);
      continue;
    }
    const own = composeTransform(node.transform ?? IDENTITY_TRANSFORM, IDENTITY_RESOLVED);
    resolved.push(composeResolved(resolved[node.parent]!, own));
  }
  return template.cells.map(([nodeIndex, localKey]) =>
    applyTransform(parseCellKey(localKey), resolved[nodeIndex] ?? IDENTITY_RESOLVED),
  );
}

/**
 * The minimum corner of the range a component occupies (the origin if there are no
 * cells).
 *
 * **The reference point for placement position.** This is what gets aligned to the
 * clicked location
 */
export function componentMinCorner(template: ComponentTemplate): [number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  for (const [x, y, z] of componentProjectedCells(template)) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
  }
  return Number.isFinite(minX) ? [minX, minY, minZ] : [0, 0, 0];
}

/**
 * The world cells that get filled when placed (for the placement preview / overlap
 * check).
 *
 * The shape with the min corner aligned to the click position. **The ghost preview is
 * also built from this** — computing coordinates separately would let the shown
 * location and the placed location diverge
 */
export function componentWorldCells(
  template: ComponentTemplate,
  worldOrigin: [number, number, number],
): CellKey[] {
  return componentPlacementOffsets(template).map(([x, y, z]) =>
    makeCellKey(x + worldOrigin[0], y + worldOrigin[1], z + worldOrigin[2]),
  );
}

/** Projected cells with the min corner shifted to the origin (relative to the click position. The shape the ghost preview reads) */
export function componentPlacementOffsets(template: ComponentTemplate): Cell[] {
  const [ox, oy, oz] = componentMinCorner(template);
  return componentProjectedCells(template).map(([x, y, z]) => [x - ox, y - oy, z - oz]);
}

/** Reverts instances of a component removed from the list back to plain groups (don't mix "decide to remove" with "decide to detach") */
export function buildDetachInstancesOf(doc: Document, templateId: string): OpResult {
  const ops: DocOp[] = [];
  for (const node of doc.tree.allNodesPreOrder()) {
    if (node.templateId !== templateId) continue;
    ops.push({ kind: 'setGroupTemplateId', id: node.id, before: node.templateId, after: null });
  }
  if (!ops.length) return { error: 'componentNotFound' };
  return { tx: { ops } };
}

export { cloneComponent };

/**
 * Propagates an edit to a component out to all of that component's instances (Step
 * 2).
 *
 * **Built as a single transaction.** Applying per-instance would leave a work with "only
 * some instances updated" if it failed partway, and undo would need as many steps as
 * there are instances. Bundled into one, they all advance together and all revert
 * together.
 *
 * ## What's kept and what's replaced
 *
 * | | Treatment |
 * |---|---|
 * | Root's transform (placement position/orientation) | **Kept**. Where it's placed isn't the component's to own |
 * | Root's name | **Kept**. Doesn't erase a name given after placement |
 * | Root's `templateId` | Kept (the "this is an instance" marker) |
 * | Root's contents (cells, paint, child groups) | **Replaced with the component's** |
 *
 * **If an instance was edited directly, that edit is lost here.** "Sync wins" is this
 * approach's contract. Detach first if you want to change one instance
 * individually.
 */
export function buildSyncInstancesOf(doc: Document, template: ComponentTemplate): OpResult {
  if (!template.nodes.length) return { error: 'componentNotFound' };

  // **Having none placed at all is not a failure.** There's simply nothing to sync, so
  // an empty tx is returned — turning this into an error would mean editing a component
  // that hasn't been placed anywhere could never finalize, leaving no way out of edit
  // mode either
  const roots = [...doc.tree.allNodesPreOrder()].filter((node) => node.templateId === template.id);
  if (!roots.length) return { tx: { ops: [] } };
  if (roots.length * template.cells.length > OP_MAX_CELLS) {
    return { error: 'tooManyTargets', errorVars: { max: OP_MAX_CELLS.toLocaleString() } };
  }

  const ops: DocOp[] = [];

  for (const root of roots) {
    // Check up front, before building the op, whether the placed result fits within
    // range (don't leave things half-placed on failure). **Look at projected cells
    // through the world coordinates produced by that instance's effective transform**
    // — measuring with the raw local key plus only the root's translate
    // added would miss child-node moves and root rotation, letting it slip past this
    // check. If it only fails on the applied-time invariant, that's after the history
    // session has closed, breaking the state along with everything that was being edited
    const chain = doc.tree.transformChain(root.id);
    for (const cell of componentProjectedCells(template)) {
      const [x, y, z] = applyTransform(cell, chain);
      if (!isValidCell(x, y, z)) return { error: 'outOfRangePlaceComponent' };
    }

    // Collapse the existing contents: descendant groups are deleted along with their contents, and the root's cells/paint are emptied
    const clear = (id: string, removeGroup: boolean): void => {
      for (const childId of [...doc.tree.childrenOf(id)]) clear(childId, true);
      for (const [localKey] of doc.scene.cells.entriesOf(id)) {
        const paint = doc.scene.patterns?.get(id, localKey) ?? null;
        if (paint) ops.push({ kind: 'setPattern', owner: id, key: localKey, before: paint, after: null });
        ops.push({
          kind: 'voxel',
          owner: id,
          key: localKey,
          before: doc.scene.cells.get(id, localKey) ?? null,
          after: null,
        });
      }
      if (!removeGroup) return;
      const node = doc.tree.getNode(id);
      if (!node) return;
      ops.push({ kind: 'deleteGroup', node: { ...node, childIds: [] }, index: doc.tree.childrenOf(node.parentId).indexOf(id) });
    };
    clear(root.id, false);

    // Rebuild the component's contents. The root reuses the existing one, so only child groups get new ids
    const idOfNode = template.nodes.map((_, i) => (i === 0 ? root.id : doc.nextGroupId()));
    template.nodes.forEach((node, i) => {
      if (i === 0) return; // The root is kept (transform / name / templateId all preserved as-is)
      ops.push({
        kind: 'createGroup',
        node: {
          id: idOfNode[i]!,
          name: node.name,
          parentId: idOfNode[node.parent ?? 0]!,
          childIds: [],
          ...(node.hidden !== undefined ? { hidden: node.hidden } : {}),
          ...(node.locked !== undefined ? { locked: node.locked } : {}),
          ...(node.transform !== undefined ? { transform: node.transform } : {}),
        },
        index: template.nodes.filter((n, j) => n.parent === node.parent && j < i && j > 0).length,
      });
    });
    for (const [nodeIndex, localKey, raw] of template.cells) {
      ops.push({ kind: 'voxel', owner: idOfNode[nodeIndex]!, key: localKey, before: null, after: raw });
    }
    for (const [nodeIndex, localKey, paint] of template.patterns) {
      ops.push({ kind: 'setPattern', owner: idOfNode[nodeIndex]!, key: localKey, before: null, after: paint });
    }
  }

  return { tx: { ops } };
}

/**
 * Detaches a single instance from its component (Figma's "Detach instance" Step 2).
 *
 * The contents stay as-is; only the `templateId` marker is removed. **From then on, it
 * won't follow further edits to the component.** Unlike "decide to remove"
 * (`buildDetachInstancesOf`), this detaches just one instance within the work.
 */
export function buildDetachInstance(doc: Document, groupId: string): OpResult {
  const node = doc.tree.getNode(groupId);
  if (!node) return { error: 'groupNotFound' };
  if (node.templateId === undefined || node.templateId === null) return { error: 'componentNotFound' };
  return {
    tx: { ops: [{ kind: 'setGroupTemplateId', id: groupId, before: node.templateId, after: null }] },
    newSelection: { kind: 'groups', ids: [groupId] },
  };
}

/**
 * Enters component edit mode.
 *
 * **Hides everything else and shows only the component's contents.** An instance's
 * contents aren't normally editable, so fixing one needs a place to show "the component
 * itself".
 *
 * What's shown is a single working group. Since it's **not an instance** (holds no
 * `templateId`), it can be edited as a regular group. On exit, the contents are written
 * back to the component.
 *
 * **Entering itself is not recorded in history.** The caller opens a history session
 * with `Document.openHistorySession()`, and on exit, `closeHistorySession()` rolls back
 * everything changed during editing. The only thing that remains in the work is the
 * single change "the instance became a new shape" (recording intermediate steps in
 * history would restore the editing screen on an undo after exiting, leaving the mode
 * flag set without the mode itself review P1).
 */
export function buildEnterComponentEdit(
  doc: Document,
  template: ComponentTemplate,
  worldOrigin: [number, number, number] = [0, 0, 0],
): OpResult {
  const placed = buildPlaceComponent(doc, template, worldOrigin);
  if ('error' in placed) return placed;

  const ops: DocOp[] = [];
  // Hide what's already there (don't touch anything already hidden — that would add more to restore on exit)
  for (const node of doc.tree.childrenOf(null)) {
    const target = doc.tree.getNode(node);
    if (!target || target.hidden) continue;
    ops.push({ kind: 'setGroupHidden', id: node, before: false, after: true });
  }
  ops.push(...placed.tx.ops);

  // The working group doesn't carry an instance marker (so it can be touched as a regular group)
  const workingId = (placed.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;
  ops.push({ kind: 'setGroupTemplateId', id: workingId, before: template.id, after: null });

  return { tx: { ops }, newSelection: { kind: 'groups', ids: [workingId] } };
}

/**
 * Exits component edit mode.
 *
 * Extracts the working group's contents, writes them back to the component, and
 * propagates them to placed instances. The working group is deleted and hidden items
 * are restored. **All bundled into one transaction.**
 *
 * @returns `template` is the component after being written back (the caller updates the list)
 */
export function collectComponentEdit(
  doc: Document,
  workingGroupId: string,
  template: ComponentTemplate,
): OpResult | { template: ComponentTemplate } {
  const sel = { kind: 'groups', ids: [workingGroupId] } as NormalizedSelection;
  const collected = buildCreateComponent(doc, sel, template.id);
  if (isCreateComponentError(collected)) return collected;
  // Keep the original name (don't carry back the working name given for edit mode)
  return { template: { ...collected.template, name: template.name } };
}

/**
 * State that only exists for the duration of edit mode.
 *
 * **One-to-one with the history session.** Holding this separately as a screen-side
 * variable would let an undo remove just the session's prerequisite (the working group)
 * with no way to exit. Housing the history marker here keeps entering and exiting always
 * paired
 */
export interface ComponentEditSession {
  readonly templateId: string;
  readonly workingGroupId: string;
  readonly historyMark: HistorySessionMark;
}

/**
 * Enters edit mode. **Opens the history session, then shows the contents.**
 *
 * Changes made after entering are enclosed within the session and roll back entirely
 * via `endComponentEdit`
 */
export function beginComponentEdit(
  doc: Document,
  template: ComponentTemplate,
  worldOrigin: [number, number, number] = [0, 0, 0],
): OpResult | { session: ComponentEditSession; newSelection: NormalizedSelection } {
  const entered = buildEnterComponentEdit(doc, template, worldOrigin);
  if ('error' in entered) return entered;
  const historyMark = doc.openHistorySession(entered.tx);
  const workingGroupId = (entered.newSelection as { kind: 'groups'; ids: string[] }).ids[0]!;
  return {
    session: { templateId: template.id, workingGroupId, historyMark },
    newSelection: entered.newSelection as NormalizedSelection,
  };
}

/**
 * Exits edit mode. If `save` is false, discards without writing back.
 *
 * **Either path rolls back and closes the session.** The only thing that remains in the
 * work is the single change "the instance became a new shape" — items hidden for
 * editing and the working group don't remain in history either.
 *
 * @returns `template` is the component after being written back (null when discarded). The caller writes it to the list
 */
/**
 * The result of exiting edit mode. **The session is already closed by the time this is
 * returned.**
 *
 * `failed` means "exited, but couldn't write back" — the caller should collapse edit
 * mode and then surface the reason (surfacing only a reason without exiting would leave
 * things stuck)
 */
export interface EndComponentEditResult {
  template: ComponentTemplate | null;
  failed?: OpResult;
}

export function endComponentEdit(
  doc: Document,
  session: ComponentEditSession,
  template: ComponentTemplate | undefined,
  save: boolean,
): OpResult | EndComponentEditResult {
  // Read before rolling back (the working group disappears once rolled back)
  const collected = save && template ? collectComponentEdit(doc, session.workingGroupId, template) : null;
  if (collected && !('template' in collected)) return collected;

  // From here on, the session is closed. **Edit mode ends no matter what happens** —
  // if it rolled back but the mode flag stayed set, there'd be no way left to exit
  //
  doc.closeHistorySession(session.historyMark);
  if (!collected) return { template: null };

  const synced = buildSyncInstancesOf(doc, collected.template);
  if (!('tx' in synced)) return { template: null, failed: synced };
  // **Bundles replacing the definition with rebuilding the instances into one** (raised in
  // review P1). Being in separate history entries would let undo revert only one side,
  // mixing shapes that differ despite sharing an id. Document overwrites `before` with
  // the measured value, so it's enough to declare only `after` here
  doc.applyTransaction({
    ops: [
      { kind: 'setComponentTemplate', id: collected.template.id, before: null, after: collected.template },
      ...synced.tx.ops,
    ],
  });
  return { template: collected.template };
}
