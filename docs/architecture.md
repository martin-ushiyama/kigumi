# Layer dependency rules

The blocksmith source is split into directories under `src/` by responsibility.
As the codebase grows, dependencies tend to tangle, so we **fix the allowed dependency
direction to one way**: `core` / `editor` are guarded by ESLint (`no-restricted-imports`,
`eslint.config.js`), and the whole layer graph is checked by `scripts/architecture-lint.mjs`
(run in CI via `tests/architecture.test.ts`), which mechanically detects imports going the
wrong way.

The read/write API boundary of `Document` / `VoxelWorld` / `SceneTree` (who is allowed to
mutate world/tree) is out of scope for this file — see [docs/document-api.md](document-api.md).

## Dependency direction

```
core (domain)
    ↓
editor (application)
    ↓
input, ui, render, project, export
    ↓
state (global store)
    ↓
services (aggregated services)
    ↓
main (composition root)
```

- Arrows mean "the upper layer does not know the lower layer". `core` must not depend on any other directory
- `input` / `ui` / `render` / `project` / `export` sit on the same tier. Dependencies within this tier (e.g. `input` → `render`) are allowed (UI actions call the renderer directly by design). What is forbidden is **a lower layer depending on an upper layer** (`core` → `input`, etc.)
- `state.ts` is the global store holding the app-wide mutable state. `input` / `ui` / `render` / `project` / `export` reading and writing it **as values and functions** is a legitimate use (same structure as components reading a Redux store). The only forbidden direction is "borrowing types from `state.ts`" — no layer (other than `main.ts`, the composition root) may type-import from it. Cross-cutting domain types live in `core`; types that describe the store itself (`AppState` / `AppStateChange` / `Theme` / `ThemePreference`) do live in `state.ts` (see "Where shared contracts live" below)
- `services/` holds aggregated services created and injected by `main.ts` (#14: `ProjectService` etc. — the home for "domain logic other than initialization" extracted from `main.ts`). It may depend on the 5-tier layers / `state`, but the 5-tier layers / `state` never depend on `services/` — only `main.ts` depends on it (prevents cycles). Direct dependencies on DOM/Three.js are kept minimal; when needed, they are injected as functions from the caller (`main.ts`), e.g. `toast`
- `main.ts` is the composition root. It wires and boots all layers and is **imported by no one** (there is no path by which a lower layer depends on `main.ts`)
- `data/` (static catalogs: `blocks.json` etc.) is plain data referenced from `core`, so it is outside the dependency rules

## Responsibilities per layer

| Directory | Responsibility | Allowed dependencies |
|---|---|---|
| `core/` | Domain model (Document, VoxelWorld, orientation math, coordinate transforms, shared types, etc.). Pure computation with no DOM / Three.js dependency | None (self-contained; external libraries only) |
| `editor/` | Composition of domain operations (ops, selection, clipboard, rangefill). Never touches UI or the renderer directly, never references DOM globals | `core` only |
| `input/` | Pointer/keyboard input, raycasting, tool behavior | `core` / `editor` / same tier (`ui` / `render` / `project` / `export`) / `state` (values only) |
| `ui/` | DOM manipulation (palette, inspector, layer panel, etc.) | Same as above |
| `render/` | Three.js scene and mesh generation | Same as above |
| `project/` | Save/load (localStorage / autosave) | Same as above |
| `export/` | .mcpack / .mcstructure / NBT writing | Same as above |
| `state.ts` | App-wide mutable state (global store). Defines the store's own types (`AppState` / `AppStateChange` / `Theme` / `ThemePreference`) and re-exports some `core` types (`Axis` / `DisplayMode` / `Lang` / `ShapeKind` / `Tool`); no other layer may type-import from it | `core` |
| `services/` | Aggregated services extracted from `main.ts` (project save/load/autosave, pick/view/render and other non-DOM, non-initialization logic) | `core` / `editor` / same tier (`input` / `ui` / `render` / `project` / `export`) / `state` (values only) |
| `main.ts` | Boot sequence, wiring of all layers | All layers |

## Where shared contracts live

Types needed by multiple layers live in **`core`**, split by responsibility — not in the place
that first used the type, and not in `state.ts`:

- `core/types.ts` — the block catalog contract (`BlockDef`), raycasting's `Hit`, display mode's `DisplayMode`, tool kind's `Tool`
- `core/cell.ts` — coordinate primitives (`Cell` / `CellKey`; `core/types.ts` re-exports them so the existing `from './types'` path keeps working)
- `core/i18n.ts` — `Lang` and the translation key types (`UiKey` etc.)
- `core/shapes.ts` — `ShapeKind`
- `core/axis.ts` — `Axis`

`state.ts` sits outside this rule in one direction only: it **may define types that belong to
the store itself** (`AppState`, `AppStateChange`, `Theme`, `ThemePreference`), but no other
layer may import types from it — cross-cutting domain types must not accrete there.

- ❌ Defining `Hit` in `input/picking.ts` and having `core/` modules import it from there
  → makes core depend on input (found and fixed in 2026-07 #9)
- ❌ Defining `DisplayMode` / `Tool` in `state.ts` and having `render/voxelmesh.ts` or `ui/toolbar.ts`
  borrow them via `import type { ... } from '../state'` → value dependencies (the `state` object etc.)
  are allowed, but borrowing domain types from `state.ts` erodes the "shared types live in `core`" rule and
  turns `state.ts` into a de facto second domain layer (found and fixed in the 2026-07 #17 review)
- ✅ Define the type in the responsible `core` module and have each layer import it from there
  directly. `state.ts` may `export type { ... }` as a re-export (it currently re-exports
  `Axis` / `DisplayMode` / `Lang` / `ShapeKind` / `Tool`), but only `main.ts` — the composition
  root, which the check exempts — consumes types through `state.ts`

`checkStateTypeImports` in `scripts/architecture-lint.mjs` mechanically forbids type-only imports
from `state.ts` in every file except `main.ts` (composition root) and `state.ts` itself.
Because it parses the AST via the TypeScript Compiler API, it consistently catches
not only `import type {...}` / `type X` inside mixed imports, but also
`import type * as X from '../state'` (namespace imports), `import('../state').Tool` (ImportTypeNode),
and extension variations like `from '../state.js'` (the earlier regex-based implementation depended on
the ` {} ` form and exact extension matches, leaving loopholes; found and fixed in the 2026-07 #18 review).

## Where to put a new feature

1. **Pure computation / data structure that never touches DOM/Three.js?** → `core/`
2. **An "operation" composed only of `core` types and functions? (editing logic that becomes an undo target)** → `editor/`
3. **Handles input events?** → `input/`
4. **Builds DOM elements?** → `ui/`
5. **Touches Three.js scenes/meshes?** → `render/`
6. **File save/load?** → `project/`
7. **Writing to an external format?** → `export/`
8. **A type or constant needed by multiple layers?** → the responsible `core` module (`core/types.ts` / `core/cell.ts` / `core/i18n.ts` / `core/shapes.ts` / `core/axis.ts`, ...). Never in `state.ts` — only types that describe the store itself (`AppState` etc.) belong there
9. **A bloated part of `main.ts` initialization (a chain of domain logic spanning the 5-tier layers, receiving DOM/Three.js via injection)?** → `services/`

When in doubt, decide by whether the layer you want to depend on can still respect the dependency direction above.

## Mechanical checks

Three lines of defense.

1. **`no-restricted-imports` / `no-restricted-globals` in `eslint.config.js`** (`npm run lint`, required in CI): catches forbidden imports from `src/core/**` and `src/editor/**` right in the editor. The relative path depth is fixed (`../input/*` etc.) and it only sees static imports in `{}` form, so it cannot follow nested subdirectories, dynamic imports, or namespace imports. It is an immediate-feedback aid; the real guards are 2 and 3 below
2. **`scripts/architecture-lint.mjs`** (run by vitest from `tests/architecture.test.ts`; part of `npm test`, so required in CI): parses each file's AST via the TypeScript Compiler API, resolves import statements to absolute file paths, then judges the layer. It works consistently across static imports / dynamic imports / re-exports / ImportTypeNode / namespace imports / extension variations. It checks:
   - `checkLayerDependencies`: violations across the whole layer dependency graph (`core`/`editor`/5-tier layers/`state`/`main`)
   - `checkStateTypeImports`: the ban on type-only imports from `state.ts` (detects every import syntax; `main.ts` and `state.ts` itself are exempt)
3. **`tsconfig.editor.json`** (wired into `npm run typecheck`, required in CI): type-checks only `src/editor/**` with a dedicated tsconfig whose `lib` excludes `DOM` / `DOM.Iterable`. Using DOM globals or DOM types like `document` or `HTMLElement` under editor then fails to compile structurally, banning the entire DOM lib without maintaining a fixed identifier list (the `no-restricted-globals` approach limited to 5 main identifiers could not detect type references like `HTMLElement`; found and fixed in the 2026-07 #18 review)

`tests/architecture.test.ts` also contains regression tests confirming that "removing a guard is actually detected" (including the 4 patterns surfaced in review: dynamic import / namespace type import / extension variation / DOM types). Loosening a rule makes this test fail.
