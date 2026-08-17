import type { MixRecipe, RecipeStore } from '../core/mixpalette';
import type { BlockDef } from '../core/types';
import { createIcon } from './icons';
import { createButton, createInput } from './primitives';
import { blockName, t } from '../state';

export interface RecipeEditorOptions {
  recipe: MixRecipe;
  catalog: BlockDef[];
  store: RecipeStore;
  addControl?: HTMLElement;
  hint?: string;
}

/** A recipe entry is added or incremented through this single path in every UI. */
export function addBlockToRecipe(recipe: MixRecipe, blockId: string): MixRecipe['entries'] {
  const exists = recipe.entries.some((entry) => entry.blockId === blockId);
  return exists
    ? recipe.entries.map((entry) =>
        entry.blockId === blockId ? { ...entry, weight: entry.weight + 1 } : entry,
      )
    : [...recipe.entries, { blockId, weight: 1 }];
}

/** Shared recipe editor used by the sidebar and the contextual block picker. */
export function createRecipeEditor(options: RecipeEditorOptions): HTMLDivElement {
  const { recipe, catalog, store } = options;
  const byId = new Map(catalog.map((block) => [block.id, block]));
  const editor = document.createElement('div');
  editor.className = 'recipe-editor';

  const nameInput = createInput({
    value: recipe.name,
    ariaLabel: t('recipeEditor.name'),
    className: 'recipe-name-input',
  });
  nameInput.addEventListener('change', () => store.update(recipe.id, { name: nameInput.value.trim() || recipe.name }));
  editor.appendChild(nameInput);

  const total = recipe.entries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  for (const [index, entry] of recipe.entries.entries()) {
    const def = byId.get(entry.blockId);
    const line = document.createElement('div');
    line.className = 'recipe-entry';

    const chip = document.createElement('i');
    chip.className = 'recipe-entry-swatch';
    chip.style.background = def?.color ?? '#f0f';
    line.appendChild(chip);

    const label = document.createElement('span');
    label.className = 'recipe-entry-name';
    label.textContent = def ? blockName(def) : entry.blockId;
    line.appendChild(label);

    const weight = createInput({
      type: 'number',
      value: String(entry.weight),
      ariaLabel: t('recipeEditor.weightOf', { name: label.textContent ?? '' }),
      className: 'recipe-entry-weight',
    });
    weight.min = '0';
    weight.step = '1';
    weight.addEventListener('change', () => {
      const entries = recipe.entries.map((current, currentIndex) =>
        currentIndex === index
          ? { ...current, weight: Math.max(0, Number(weight.value) || 0) }
          : current,
      );
      store.update(recipe.id, { entries });
    });
    line.appendChild(weight);

    const pct = document.createElement('span');
    pct.className = 'recipe-entry-percent';
    pct.textContent = total > 0 ? `${Math.round((Math.max(0, entry.weight) / total) * 100)}%` : '—';
    line.appendChild(pct);

    const remove = createButton({
      label: '',
      ariaLabel: t('recipeEditor.removeOf', { name: label.textContent ?? '' }),
      title: t('recipeEditor.remove'),
      icon: createIcon('trash'),
      variant: 'icon',
      onClick: () => store.update(recipe.id, {
        entries: recipe.entries.filter((_, currentIndex) => currentIndex !== index),
      }),
    });
    line.appendChild(remove);
    editor.appendChild(line);
  }

  if (!recipe.entries.length) {
    const empty = document.createElement('p');
    empty.className = 'recipe-editor-empty';
    empty.textContent = t('recipeEditor.addToCreate');
    editor.appendChild(empty);
  }
  if (options.addControl) editor.appendChild(options.addControl);
  if (options.hint) {
    const hint = document.createElement('p');
    hint.className = 'recipe-editor-hint';
    hint.textContent = options.hint;
    editor.appendChild(hint);
  }
  return editor;
}
