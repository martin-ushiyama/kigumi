import type { Document } from '../core/document';
import { buildIndexOf, type MixRecipe, type RecipeStore } from '../core/mixpalette';
import { ownersOfSubtree } from '../core/ownerlocal';
import { activePatternAt } from '../core/patternpaint';
import type { BlockDef } from '../core/types';
import { collectBlockAndPatternUsage, totalBlockCount, type BlockUsageScope } from '../editor/blockusage';
import { buildApplyPatternUsage, buildReplacePatternUsage, buildReplaceUsage, commitOpResult } from '../editor/ops';
import type { SelectionStore } from '../editor/selection';
import type { BlockChangePicker } from './blockchangepicker';
import { createButton } from './primitives';
import { createIcon } from './icons';
import { blockName, onLangChange, opError, t } from '../state';

/**
 * The "Block usage" panel on the right side.
 *
 * Each row opens a Figma-like picker to run **block replacement** or **pattern
 * paint**. It doesn't depend on the left sidebar's selection state — the picker
 * itself handles choosing the replacement target and editing the pattern, self-contained.
 *
 * The aggregation scope follows the current selection:
 * - group selected → that subtree
 * - otherwise (nothing selected / cells selected) → the whole build
 *
 * Cell selection collapses to the whole world because counting the breakdown of
 * "a few cells picked at random" carries no useful information. Only two scopes are
 * meaningful: a group, or everything.
 */
export function initBlockUsage(
  root: HTMLElement,
  doc: Document,
  selection: SelectionStore,
  getCatalog: () => BlockDef[],
  recipeStore: RecipeStore,
  toast: (msg: string) => void,
  /**
   * The block-change picker. **Exactly one instance** is created in the
   * composition root and handed around. The toolbar's stacked swatch opens the same
   * instance too — generating one here as well would leave two popovers with the
   * same id hanging off the body.
   */
  picker: BlockChangePicker,
): void {
  const reader = {
    entriesOf: (ownerId: string | null) => doc.scene.cells.entriesOf(ownerId),
    owners: () => doc.scene.cells.owners(),
    ownersOfSubtree: (id: string) => ownersOfSubtree(doc.tree, id),
  };

  function currentScope(): { scope: BlockUsageScope; label: string } {
    const sel = selection.get();
    if (sel.kind === 'groups' && sel.ids.length) {
      const names = sel.ids.map((id) => doc.tree.getNode(id)?.name ?? '?');
      return {
        scope: { kind: 'groups', ids: sel.ids },
        label: names.length === 1 ? (names[0] as string) : t('usage.groups', { count: names.length }),
      };
    }
    return { scope: { kind: 'world' }, label: t('usage.whole') };
  }

  /** The owners contained in the scope (replacement target range — uses the same range as aggregation) */
  function ownersInScope(scope: BlockUsageScope): Iterable<string | null> {
    if (scope.kind === 'world') return [...reader.owners()];
    const out = new Set<string | null>();
    for (const id of scope.ids) for (const owner of reader.ownersOfSubtree(id)) out.add(owner);
    return out;
  }

  // The block catalog is immutable for the app's lifetime. Aggregation, shape lookup, and the picker all share the same snapshot.
  const catalog = getCatalog();
  const shapeOf = (catalogIndex: number) => catalog[catalogIndex]?.shape;
  const indexOf = buildIndexOf(catalog);

  function replaceWith(scope: BlockUsageScope, from: number, pick: () => number | null, what: string): void {
    const result = buildReplaceUsage(doc, ownersInScope(scope), from, pick, shapeOf);
    if (commitOpResult(doc, selection, result, toast, opError) && 'tx' in result) {
      toast(t('usage.opResult', { count: result.tx.ops.length.toLocaleString(), what }));
    }
  }

  function swatch(def: BlockDef): HTMLElement {
    const el = document.createElement('span');
    el.className = 'usage-swatch';
    el.style.background = def.color;
    el.title = def.id;
    return el;
  }

  function applyPattern(scope: BlockUsageScope, from: number, recipe: MixRecipe): void {
    const result = buildApplyPatternUsage(doc, ownersInScope(scope), from, recipe, indexOf, shapeOf);
    if (commitOpResult(doc, selection, result, toast, opError) && 'tx' in result) {
      const count = result.tx.ops.filter((op) => op.kind === 'setPattern').length;
      toast(t('usage.appliedTo', { count: count.toLocaleString() }));
    }
  }

  function replacePattern(
    scope: BlockUsageScope,
    recipeId: string,
    replacement: { kind: 'block'; catalogIndex: number } | { kind: 'pattern'; recipe: MixRecipe },
  ): void {
    const result = buildReplacePatternUsage(doc, ownersInScope(scope), recipeId, replacement, indexOf, shapeOf);
    if (commitOpResult(doc, selection, result, toast, opError) && 'tx' in result) {
      const count = result.tx.ops.filter((op) => op.kind === 'setPattern').length;
      const action = replacement.kind === 'pattern' && replacement.recipe.id === recipeId
        ? t('usage.patternReshuffled')
        : t('usage.blockChanged');
      toast(`${count.toLocaleString()} ${action}`);
    }
  }

  function render(): void {
    // Don't keep using the scope from when the picker was opened once Selection /
    // Document changes. RecipeStore notifications don't trigger this render, so
    // editing inside the picker won't close it.
    picker.close();
    root.innerHTML = '';

    const { scope, label } = currentScope();
    const head = document.createElement('div');
    head.className = 'usage-head';
    const title = document.createElement('h2');
    title.textContent = t('usage.title');
    const scopeEl = document.createElement('span');
    scopeEl.className = 'usage-scope';
    scopeEl.textContent = label;
    scopeEl.title = t('usage.scope', { label });
    head.append(title, scopeEl);
    root.appendChild(head);

    const usage = collectBlockAndPatternUsage(reader, scope, (owner, key) => {
      if (!doc.scene.patterns) return null;
      return activePatternAt(doc.scene.patterns, doc.scene.cells, owner, key)?.recipeId ?? null;
    });
    const entries = usage.blocks;
    const patterns = usage.patterns.map(({ recipeId, count }) => ({
      recipeId,
      count,
      recipe: recipeStore.get(recipeId),
    }));
    if (!entries.length && !patterns.length) {
      const empty = document.createElement('p');
      empty.className = 'usage-empty';
      empty.textContent = scope.kind === 'world' ? t('usage.empty') : t('usage.emptyGroup');
      root.appendChild(empty);
      return;
    }

    const summary = document.createElement('p');
    summary.className = 'usage-summary';
    summary.textContent = t('usage.summary', { kinds: entries.length + patterns.length, total: (totalBlockCount(entries) + patterns.reduce((sum, item) => sum + item.count, 0)).toLocaleString() });
    root.appendChild(summary);

    const max = Math.max(entries[0]?.count ?? 0, patterns[0]?.count ?? 0);
    const list = document.createElement('ul');
    list.className = 'usage-list';

    for (const { recipeId, recipe, count } of patterns) {
      const li = document.createElement('li');
      li.className = 'usage-row usage-pattern-row';
      li.dataset.testid = 'usage-pattern-row';
      li.dataset.recipeId = recipeId;
      li.dataset.count = String(count);

      const preview = document.createElement('span');
      preview.className = 'usage-swatch usage-pattern-swatch';
      const colors = (recipe?.entries ?? [])
        .map((entry) => catalog[indexOf(entry.blockId) ?? -1]?.color)
        .filter((color): color is string => !!color);
      preview.style.background = colors.length
        ? `linear-gradient(135deg, ${colors.map((color, i) => `${color} ${(i / colors.length) * 100}% ${((i + 1) / colors.length) * 100}%`).join(', ')})`
        : 'var(--bs-surface-control)';

      const name = document.createElement('span');
      name.className = 'usage-name';
      name.textContent = recipe?.name ?? t('usage.unknownPattern');
      name.title = recipeId;

      const num = document.createElement('span');
      num.className = 'usage-count';
      num.textContent = count.toLocaleString();

      const bar = document.createElement('span');
      bar.className = 'usage-bar';
      bar.style.width = `${Math.max(2, Math.round((count / max) * 100))}%`;

      const actions = document.createElement('span');
      actions.className = 'usage-actions';
      const changeBtn = createButton({
        label: '',
        ariaLabel: t('usage.editOrChangeOf', { name: name.textContent ?? '' }),
        title: t('usage.editMixOf', { name: name.textContent ?? '' }),
        icon: createIcon('replace'),
        variant: 'icon',
        className: 'usage-change-button',
        onClick: (event) => picker.open(event.currentTarget as HTMLButtonElement, {
          sourceIndex: null,
          sourceName: name.textContent ?? t('usage.pattern'),
          currentRecipeId: recipeId,
          onBlock: (nextIndex) => replacePattern(scope, recipeId, { kind: 'block', catalogIndex: nextIndex }),
          onPattern: (nextRecipe) => replacePattern(scope, recipeId, { kind: 'pattern', recipe: nextRecipe }),
        }),
      });
      actions.append(changeBtn);
      li.append(preview, name, num, actions, bar);
      list.appendChild(li);
    }

    for (const { catalogIndex, count } of entries) {
      const def = catalog[catalogIndex];
      if (!def) continue; // Skip entries outside the catalog (e.g. loading an older build)

      const li = document.createElement('li');
      li.className = 'usage-row';
      li.dataset.testid = 'usage-row';
      li.dataset.blockId = def.id;
      li.dataset.count = String(count);

      const name = document.createElement('span');
      name.className = 'usage-name';
      name.textContent = blockName(def);
      name.title = def.id;

      const num = document.createElement('span');
      num.className = 'usage-count';
      num.textContent = count.toLocaleString();

      // A plain number makes it hard to read differences in magnitude, so draw a bar scaled with the max count at 100%
      const bar = document.createElement('span');
      bar.className = 'usage-bar';
      bar.style.width = `${Math.max(2, Math.round((count / max) * 100))}%`;

      const actions = document.createElement('span');
      actions.className = 'usage-actions';

      const changeBtn = createButton({
        label: '',
        ariaLabel: t('usage.changeAriaOf', { name: blockName(def) }),
        title: t('usage.changeTargetOf', { name: blockName(def) }),
        icon: createIcon('replace'),
        variant: 'icon',
        className: 'usage-change-button',
        onClick: (event) => picker.open(event.currentTarget as HTMLButtonElement, {
          sourceIndex: catalogIndex,
          sourceName: blockName(def),
          onBlock: (nextIndex) => replaceWith(scope, catalogIndex, () => nextIndex, t('usage.replaced')),
          onPattern: (recipe) => applyPattern(scope, catalogIndex, recipe),
        }),
      });
      changeBtn.dataset.testid = 'usage-change';

      actions.append(changeBtn);
      li.append(swatch(def), name, num, actions, bar);
      list.appendChild(li);
    }
    root.appendChild(list);
  }

  doc.subscribe(render);

  onLangChange(render); // Follows block-name language switches
  selection.subscribe(render);
  render();
}
