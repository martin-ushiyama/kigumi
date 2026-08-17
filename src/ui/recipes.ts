import type { MixRecipe, RecipeStore } from '../core/mixpalette';
import type { BlockDef } from '../core/types';
import { blockName, defaultName, onStateChange, setActiveRecipe, state, t } from '../state';
import { addBlockToRecipe, createRecipeEditor } from './recipeeditor';

export function initRecipes(root: HTMLElement, catalog: BlockDef[], store: RecipeStore): void {
  const byId = new Map(catalog.map((b, i) => [b.id, { def: b, index: i }]));
  // Expanded (being edited) and active (used for painting) are separate concepts.
  // Selecting a block in the palette shouldn't close the edit panel.
  let expandedId: string | null = null;

  function render(): void {
    root.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'recipes-header';
    const title = document.createElement('span');
    title.textContent = t('recipes.title');
    header.appendChild(title);
    const addBtn = document.createElement('button');
    addBtn.textContent = t('recipes.new');
    addBtn.addEventListener('click', () => {
      const recipe = store.create(defaultName('recipe', { n: store.recipes.length + 1 }));
      expandedId = recipe.id;
      setActiveRecipe(recipe.id);
    });
    header.appendChild(addBtn);
    root.appendChild(header);

    if (!store.recipes.length) {
      const empty = document.createElement('div');
      empty.className = 'recipes-empty';
      empty.textContent = t('recipes.emptyHint');
      root.appendChild(empty);
      return;
    }

    for (const recipe of store.recipes) {
      root.appendChild(renderRecipe(recipe));
    }
  }

  function renderRecipe(recipe: MixRecipe): HTMLElement {
    const isPainting = state.paintMode === 'mix' && state.activeRecipeId === recipe.id;
    const isExpanded = expandedId === recipe.id;
    const row = document.createElement('div');
    row.className = 'recipe' + (isPainting ? ' active' : '');

    const head = document.createElement('div');
    head.className = 'recipe-head';
    head.addEventListener('click', () => {
      expandedId = isExpanded ? null : recipe.id;
      setActiveRecipe(recipe.id);
    });

    const chips = document.createElement('span');
    chips.className = 'chips';
    for (const e of recipe.entries.slice(0, 5)) {
      const chip = document.createElement('i');
      chip.style.background = byId.get(e.blockId)?.def.color ?? '#f0f';
      chips.appendChild(chip);
    }
    head.appendChild(chips);

    const name = document.createElement('span');
    name.className = 'recipe-name';
    name.textContent = recipe.name;
    head.appendChild(name);

    if (isPainting) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = t('recipes.inUse');
      head.appendChild(badge);
    }

    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '✕';
    del.title = t('recipes.delete');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (expandedId === recipe.id) expandedId = null;
      if (state.activeRecipeId === recipe.id) setActiveRecipe(null);
      store.remove(recipe.id);
    });
    head.appendChild(del);
    row.appendChild(head);

    if (isExpanded) row.appendChild(renderEditor(recipe));
    return row;
  }

  function renderEditor(recipe: MixRecipe): HTMLElement {
    const add = document.createElement('button');
    add.className = 'add-entry';
    const activeDef = catalog[state.activeBlock];
    add.textContent = t('recipes.addBlock', { name: activeDef ? blockName(activeDef) : t('recipes.noBlockSelected') });
    add.addEventListener('click', () => {
      const id = activeDef?.id;
      if (!id) return;
      store.update(recipe.id, { entries: addBlockToRecipe(recipe, id) });
    });
    return createRecipeEditor({
      recipe,
      catalog,
      store,
      addControl: add,
      hint: t('recipes.addHint'),
    });
  }

  store.subscribe(render);
  onStateChange(render);
  render();
}
