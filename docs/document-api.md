# Read/write API boundary of Document / EditorScene / WorldIndex

`Document.world` / `Document.tree` used to be exposed as concrete objects, letting any layer
call `SceneTree` mutation methods or `VoxelWorld.stage()`. This was resolved with Reader
types + protected concrete fields. Later B1b moved the source of truth to the owner-local
`EditorScene` and removed `VoxelWorld` from the runtime: what `Document` derives for reading is
now the `WorldIndex` read-model. This file is the source of truth for the naming and
responsibilities of the read APIs and the write APIs.

## Structure

```
Document (facade)
├─ protected _scene: EditorScene     (concrete, writable: { tree: SceneTree, cells: OwnerVoxelStore, patterns? })
├─ protected _index: WorldIndex      (derived world-coordinate read-model; rebuilt / diff-updated
│                                     only at transaction boundaries — one-way derivation, no dual truth)
├─ get world(): WorldIndexReader     (public, read-only; extends WorldReader, so legacy read paths still fit)
├─ get index(): WorldIndexReader     (same instance as `world`; names the "subscribing to the derived
│                                     index" intent at the call site)
├─ get tree(): SceneTreeReader       (public, read-only)
├─ get scene(): EditorSceneReader    (public, read-only; ops build DocOps / persistence serializes from it)
├─ beginSession(placementOwner)      (returns an EditSession — the window for immediate feedback during drags:
│                                     stagePreview(intents) / stageMoveRefs / commit / cancel)
├─ nextGroupId()                     (window for group ID allocation)
└─ applyTransaction / commitStaged / applyEdits / applyEditsAsNewGroup / undo / redo /
   replaceAll / clearAll / openHistorySession / closeHistorySession
   (the canonical mutation paths that record history)
```

- `render` / `input` / `ui` / `project` / `export` can only receive `doc.world` / `doc.tree` /
  `doc.scene` **as Reader types**. The write methods of `SceneTree` / `OwnerVoxelStore` /
  `WorldIndex` (`insertNode` / `removeNode` / `rename` / `setTransform` / `reparent` / `set` /
  `delete` / `clear` / `replaceAll` / `rebuildFromScene` / `applyVoxelChanges`, etc.) are
  uncallable at the type level
- The only paths by which production code mutates scene/index are **the public methods of
  `Document`** (`applyTransaction` / `commitStaged` / `applyEdits` / `applyEditsAsNewGroup` /
  `beginSession` — via the returned `EditSession` — / `openHistorySession` /
  `closeHistorySession` / `nextGroupId` / `undo` / `redo` / `replaceAll` / `clearAll` /
  `refreshDerived`)

## Guarding against mutable `GroupNode` reference leaks (`ReadonlyGroupNode`)

`SceneTreeReader.getNode` / `allNodesPreOrder` return `ReadonlyGroupNode`, not the mutable
`GroupNode`. Reason: returning the same object held in the internal `Map<string, GroupNode>`
lets the caller do

```ts
const node = doc.tree.getNode('g0');
node.name = 'mutated';        // mutates the real tree without going through Document
node.childIds.push('x');      // push also compiles while childIds is a plain string[]
```

— a loophole where **you can write even though you came through a Reader type** (found and
fixed in review, 2026-07). `ReadonlyGroupNode` makes every property `readonly` and
`childIds` a `readonly string[]`, so both property assignment and destructive array methods
are rejected at compile time.

Similarly, if `SceneTree.insertNode(node, index)` stored the passed `node` in the `Map` as-is,
the caller could later mutate it through the reference (alias) it kept, so the node is stored
after a defensive copy: `{ ...node, childIds: [...node.childIds] }`, plus a deep clone of
`transform` when present (the same alias would otherwise reach the pivot/translate
arrays inside the transform).

On the `WorldIndexReader` side, `get` / `entries` / `bounds` return primitives or by-value
tuples, `stackAt` returns a frozen defensive copy, and `ProjectionEntry` / `worldOf` results
are deeply frozen — so no leak of this kind exists.

## Why `EditSession` (`beginSession`) exists

During a drag (paint stroke, rectangle move) we need to reflect an immediate preview every
frame without polluting the undo history. The old implementation had `input/controls.ts` /
`input/selecttool.ts` hold a raw `VoxelWorld` instance and call `world.stage()` directly —
that was the concrete case of "writes bypassing Document".

Today the input layer calls `Document.beginSession(placementOwner)` and works only through the
returned `EditSession`: `stagePreview(intents)` / `stageMoveRefs(refs, delta)` reflect
into scene + index immediately without recording history, `commit()` turns the diff against
the session baseline into a single `Transaction` (via `commitStaged`), and `cancel()` restores
the baseline. The input layer never holds concrete world objects and never implements its own
baseline-restore logic.

## Building test setups: `DocumentFixture`

While production code can only touch Reader types, test setup needs low-level operations to
"build an initial state without polluting history". `DocumentFixture` in
`tests/helpers/document-fixture.ts` (a subclass of `Document`) is the only window with access
to the `protected` `_scene` / `_index`:

```ts
import { DocumentFixture } from './helpers/document-fixture';

const doc = new DocumentFixture()
  .setCells([[0, 0, 0, 1]])
  .insertGroup({ id: 'g0', name: 'G', parentId: null, childIds: [] }, 0)
  .setCellMembership('0,0,0', 'g0');

doc.stageRaw('g0', '0,0,0', null); // mimics an EditSession stage during a drag (owner-local)
doc.rawScene; // direct access to the concrete EditorScene (for operations not covered by setCells/insertGroup etc.)
doc.rawTree;  // direct access to the concrete SceneTree (same)
doc.rawCells; // direct access to the concrete OwnerVoxelStore (same)
doc.rawIndex; // direct access to the concrete WorldIndex (e.g. observing notification counts)
```

When a test needs a new low-level operation, prefer adding a thin helper method to
`DocumentFixture` first (in the same shape as `setCells` etc.), and use `rawScene` /
`rawTree` / `rawCells` / `rawIndex` directly only when that is not enough. After mutating the
scene directly, the `WorldIndex` must be rebuilt (the built-in helpers do this via an internal
`resync`) — otherwise a "cell exists in the scene but is invisible to world" state that
production can never reach becomes constructible in tests.

## CellKey (string key for cell coordinates)

The `"x,y,z"` string key is centralized in `makeCellKey` / `parseCellKey` in `core/cell.ts`
(the bottom layer of core, split out of `core/types.ts` to avoid an import
cycle; `core/types.ts` keeps a compatibility re-export so existing `from './types'` imports
still work). Every entry point that accepts a `CellKey` string from outside validates it with
`assertCanonicalLocalCellKey` (same file).

```ts
import { makeCellKey, parseCellKey, type CellKey } from '../core/cell';

const key: CellKey = makeCellKey(1, 2, 3); // "1,2,3"
const [x, y, z] = parseCellKey(key);
```

Hand-written patterns like `${x},${y},${z}` / `key.split(',').map(Number)` still remain in
many places under `editor/` / `input/` / `ui/` / `project/` / `render/`. The original scope was
"restrict world/tree mutation to Document" and did not include a full CellKey replacement (a
judgment based on the issue's note: "a minimal API boundary that does not break existing
behavior"). New code must use `makeCellKey` / `parseCellKey`. Replacing existing code is
handled in a separate issue.
