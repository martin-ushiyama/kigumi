# blocksmith design system

## Purpose

Manage the blocksmith UI as a shared contract that can absorb new features, rather than a pile
of per-feature CSS and DOM generation.
From Figma UI3 we adopt the interaction principles — canvas first, context-dependent inspector,
collapsible panels. From the Figma Simple Design System we adopt the
`tokens → primitives → compositions` structure. We do not port SDS's visual appearance or its
website-oriented parts directly.

## Layer boundaries

1. `design-system.css` — colors, spacing, dimensions, typography, radii, shadows, motion, and shared states. Knows nothing about app state.
2. `ui/primitives.ts` — DOM primitives such as Button, IconButton, Input, Divider. Depends on no other module.
3. Editor components — Tabs, Panel, InspectorSection, LayerRow, BlockSwatch, etc. Receive display state, emit DOM events.
4. Feature compositions — Toolbar, Layers, Palette, Recipes, Inspector. Own the store, domain operations, and undo boundaries.
5. Shell — left panel, center canvas, right panel, toolbar, status. Owns only placement, panel widths, and collapsing.

Primitives must not access `Document`, `SelectionStore`, or the global `state` directly.
`ui/primitives.ts` stays dependency-free including type imports, enforced by architecture-lint.

## Tokens

### Primitive

- Colors: `--bs-color-*`
- Spacing: `--bs-space-*`
- Radii: `--bs-radius-*`
- Typography: `--bs-font-size-*`
- Control heights: `--bs-control-height-*`
- Motion & shadows: `--bs-duration-*`, `--bs-ease-*`, `--bs-shadow-*`

Raw CSS values live only in primitive tokens.

### Semantic

- Surfaces: `--bs-surface-*`
- Text: `--bs-content-*`
- Borders: `--bs-border-*`
- Actions: `--bs-action-*`
- States: `--bs-state-*`

Semantic tokens are always aliases to primitive tokens. Feature CSS prefers semantic tokens.
Future light/high-contrast support swaps values per mode while keeping the semantic names.

### Compatibility aliases

To migrate without rewriting all existing CSS at once, `--panel-bg`, `--text`, and the like
remain for now as aliases to semantic tokens. Never put new raw values into compatibility aliases.

## State contracts

Do not collapse state semantics into a generic `selected`.

- ToolButton / toggle buttons: `data-pressed` + `aria-pressed`
- Tabs: a dedicated component with `aria-selected`, `aria-controls`, `aria-labelledby`, roving `tabindex`, and ←/→, Home/End keys
- Tree selection: `data-selected` + `aria-selected`
- Scene state: `data-hidden`, `data-locked`

`.active` stays only as a compatibility measure during migration and is never the canonical
form for new APIs.

## Implementation status

### Implemented in the foundation PR

- tokens / semantic tokens / compatibility aliases
- Button / IconButton
- TextInput / NumberInput
- Divider
- primitive dependency ban and CSS token contract checks

### Follow-up adoption PRs

- ToolButton and Toolbar
- Tabs / TabPanel (ARIA and keyboard contract implemented together)
- Panel / PanelHeader / InspectorSection
- LayerRow / TreeItem / BlockSwatch
- Tooltip / EmptyState

Feature adoption happens individually on the latest `main`. Do not mix diffs of the old
Toolbar, Sidebar, Inspector, or Layers into the foundation PR.

## Testing policy

- tokens: every reference in `src/**/*.css` is defined; semantic tokens are aliases to primitives.
- primitives: verify classes, state attributes, and event emission.
- components: verify state matrix, keyboard, and ARIA.
- features: verify up to command emission; domain results are delegated to existing unit tests.
- E2E: narrow to the representative path — pick tool → place → select → edit in Inspector → undo.
- visual regression: when adopting a component, pin default / hover / focus / disabled / pressed / selected.

## References

- [Figma UI3 design rationale](https://www.figma.com/blog/our-approach-to-designing-ui3/)
- [Figma UI3 navigation guide](https://help.figma.com/hc/en-us/articles/23954856027159-Navigating-UI3)
- [Figma Simple Design System](https://github.com/figma/sds)
- [Tokens, variables, and styles](https://help.figma.com/hc/en-us/articles/18490793776023-Update-1-Tokens-variables-and-styles)
