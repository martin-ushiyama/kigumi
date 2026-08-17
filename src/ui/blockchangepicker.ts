import { applyTextureBackground } from './textureframe';
import { buildIndexOf, isDrawableRecipe, type MixRecipe, type RecipeStore } from '../core/mixpalette';
import type { BlockDef } from '../core/types';
import textureManifest from '../data/textures.json';
import { createIcon } from './icons';
import { createButton, createInput, createTabList } from './primitives';
import { addBlockToRecipe, createRecipeEditor } from './recipeeditor';
import { blockName, defaultName, matchesBlockQuery, onLangChange, t } from '../state';

const MANIFEST = textureManifest as Record<string, { side: string; top?: string }>;
type PickerTab = 'blocks' | 'patterns';
type BlockView = 'grid' | 'list';
type Category = BlockDef['category'];

/**
 * **Kept as a function.** A module-level constant would bake in the language at
 * load time, leaving stale category labels behind even after switching languages
 * and reopening the picker (the same trap palette.ts hit — this one surfaced in review).
 *
 * `checkFrozenTranslations` in `scripts/architecture-lint.mjs` mechanically catches
 * this pattern in CI so it can't recur.
 */
const categoryLabel = (cat: Category): string =>
  ({
    stone: t('picker.catStone'),
    wood: t('picker.catWood'),
    soil: t('picker.catSoil'),
    misc: t('picker.catMisc'),
  })[cat];

export interface BlockChangeTarget {
  sourceIndex: number | null;
  sourceName: string;
  currentRecipeId?: string;
  onBlock: (catalogIndex: number) => void;
  onPattern: (recipe: MixRecipe) => void;
  /**
   * Hides the pattern tab. Used by callers like the toolbar swatch where only
   * a single block can be chosen. Since only one tab would remain, the tab list
   * itself isn't rendered at all.
   */
  blocksOnly?: boolean;
}

export interface BlockChangePicker {
  open: (anchor: HTMLElement, target: BlockChangeTarget) => void;
  close: () => void;
}

/**
 * Contextual replacement picker for the Usage panel.
 *
 * It is mounted once under body rather than inside the Usage render tree. Recipe
 * edits notify synchronously and redraw the side panel; keeping the popover
 * outside that tree prevents an input change from destroying the picker.
 */
export function createBlockChangePicker(catalog: BlockDef[], store: RecipeStore): BlockChangePicker {
  const popover = document.createElement('div');
  popover.id = 'block-change-picker';
  popover.className = 'block-change-picker';
  popover.setAttribute('popover', 'auto');
  popover.setAttribute('aria-label', t('picker.ariaLabel'));
  // The popover is created once, directly under body. Since render() doesn't run
  // while it's closed, the announced name would stay stuck at the language it
  // launched with until it's opened
  onLangChange(() => popover.setAttribute('aria-label', t('picker.ariaLabel')));
  document.body.appendChild(popover);

  const indexOf = buildIndexOf(catalog);
  const categories = [...new Set(catalog.map((block) => block.category))];
  let target: BlockChangeTarget | null = null;
  let activeTab: PickerTab = 'blocks';
  let activeCategory: Category | 'all' = 'all';
  let blockView: BlockView = 'grid';
  let blockQuery = '';
  let selectedRecipeId: string | null = null;
  let addingToRecipe = false;
  let anchorElement: HTMLElement | null = null;
  let emptyDraftRecipeId: string | null = null;

  function isOpen(): boolean {
    return target !== null && popover.matches(':popover-open');
  }

  function close(): void {
    if (popover.matches(':popover-open')) popover.hidePopover();
    const emptyDraft = emptyDraftRecipeId;
    target = null;
    anchorElement = null;
    addingToRecipe = false;
    emptyDraftRecipeId = null;
    if (emptyDraft && store.get(emptyDraft)?.entries.length === 0) store.remove(emptyDraft);
  }

  function positionAt(anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left - width - 10, window.innerWidth - width - 12));
    popover.style.width = `${width}px`;
    popover.style.left = `${left}px`;
    // Reset to a safe top first so the stale top from before the real measurement doesn't skew the height calculation.
    popover.style.top = '12px';
    const height = popover.getBoundingClientRect().height;
    const top = Math.max(12, Math.min(rect.top - 54, window.innerHeight - height - 12));
    popover.style.top = `${top}px`;
  }

  function blockTile(index: number, def: BlockDef, onPick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'change-picker-block';
    button.dataset.blockId = def.id;
    button.title = blockName(def);
    button.setAttribute('aria-label', blockName(def));
    const texture = MANIFEST[def.id];
    const preview = document.createElement('span');
    preview.className = `change-picker-block-preview shape-${def.shape}`;
    preview.style.backgroundColor = def.color;
    if (texture) applyTextureBackground(preview, texture.side);
    const label = document.createElement('span');
    label.textContent = blockName(def);
    button.append(preview, label);
    button.addEventListener('click', onPick);
    if (activeTab === 'blocks' && target?.sourceIndex === index) {
      button.disabled = true;
      button.setAttribute('aria-current', 'true');
    }
    return button;
  }

  function matchingBlocks(): Array<{ index: number; def: BlockDef }> {
    const query = blockQuery.trim().toLocaleLowerCase('ja');
    return catalog
      .map((def, index) => ({ index, def }))
      .filter(({ def }) => activeCategory === 'all' || def.category === activeCategory)
      .filter(({ def }) => !query || matchesBlockQuery(def, query));
  }

  function renderBlockBrowser(onPick: (index: number, def: BlockDef) => void, compact = false): HTMLElement {
    const browser = document.createElement('div');
    browser.className = compact ? 'change-picker-browser compact' : 'change-picker-browser';
    const grid = document.createElement('div');
    grid.className = 'change-picker-grid';
    const refreshGrid = (): void => {
      grid.replaceChildren();
      grid.dataset.view = blockView;
      for (const { index, def } of matchingBlocks()) grid.appendChild(blockTile(index, def, () => onPick(index, def)));
      if (!grid.children.length) {
        const empty = document.createElement('p');
        empty.className = 'change-picker-empty';
        empty.textContent = t('picker.noMatch');
        grid.appendChild(empty);
      }
    };

    const search = createInput({
      value: blockQuery,
      placeholder: t('picker.search'),
      ariaLabel: t('picker.search'),
      className: 'change-picker-search',
    });
    search.type = 'search';
    search.addEventListener('input', () => {
      blockQuery = search.value;
      // Only update the results — leave the search field itself in the DOM since it's the target of IME composition.
      refreshGrid();
    });
    const tools = document.createElement('div');
    tools.className = 'change-picker-browser-tools';
    const viewControls = document.createElement('div');
    viewControls.className = 'change-picker-view-controls';
    viewControls.setAttribute('role', 'group');
    viewControls.setAttribute('aria-label', t('picker.viewLabel'));
    for (const option of [
      { id: 'grid', label: t('picker.viewTiles'), icon: 'grid' },
      { id: 'list', label: t('picker.viewList'), icon: 'list' },
    ] as const) {
      viewControls.appendChild(createButton({
        label: '',
        ariaLabel: option.label,
        title: option.label,
        icon: createIcon(option.icon),
        variant: 'icon',
        pressed: blockView === option.id,
        onClick: () => {
          blockView = option.id;
          render();
          popover.querySelector<HTMLButtonElement>(`[aria-label="${option.label}"]`)?.focus();
        },
      }));
    }
    tools.append(search, viewControls);
    browser.appendChild(tools);

    const filters = document.createElement('div');
    filters.className = 'change-picker-filters';
    const filterOptions: Array<{ id: Category | 'all'; label: string }> = [
      { id: 'all', label: t('picker.catAll') },
      ...categories.map((category) => ({ id: category, label: categoryLabel(category) })),
    ];
    for (const filter of filterOptions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = filter.label;
      button.dataset.active = String(activeCategory === filter.id);
      button.addEventListener('click', () => {
        activeCategory = filter.id;
        render();
      });
      filters.appendChild(button);
    }
    browser.appendChild(filters);

    refreshGrid();
    browser.appendChild(grid);
    return browser;
  }

  function renderBlocks(panel: HTMLElement): void {
    panel.appendChild(renderBlockBrowser((index) => {
      const current = target;
      if (!current || index === current.sourceIndex) return;
      close();
      current.onBlock(index);
    }));
  }

  function recipeChips(recipe: MixRecipe): HTMLElement {
    const chips = document.createElement('span');
    chips.className = 'change-picker-pattern-chips';
    for (const entry of recipe.entries.slice(0, 5)) {
      const chip = document.createElement('i');
      const index = indexOf(entry.blockId);
      chip.style.background = index === undefined ? '#f0f' : catalog[index]?.color ?? '#f0f';
      chips.appendChild(chip);
    }
    return chips;
  }

  function renderPatterns(panel: HTMLElement): void {
    const header = document.createElement('div');
    header.className = 'change-picker-pattern-header';
    const label = document.createElement('strong');
    label.textContent = t('picker.tabPatterns');
    const add = createButton({
      label: t('picker.newPattern'),
      icon: createIcon('square-plus'),
      onClick: () => {
        const recipe = store.create(defaultName('recipe', { n: store.recipes.length + 1 }));
        selectedRecipeId = recipe.id;
        emptyDraftRecipeId = recipe.id;
        addingToRecipe = true;
        render();
      },
    });
    header.append(label, add);
    panel.appendChild(header);

    const list = document.createElement('div');
    list.className = 'change-picker-pattern-list';
    for (const recipe of store.recipes) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'change-picker-pattern';
      button.dataset.selected = String(recipe.id === selectedRecipeId);
      button.dataset.recipeId = recipe.id;
      button.appendChild(recipeChips(recipe));
      const name = document.createElement('span');
      name.textContent = recipe.name;
      button.appendChild(name);
      button.addEventListener('click', () => {
        selectedRecipeId = recipe.id;
        addingToRecipe = false;
        render();
      });
      list.appendChild(button);
    }
    if (!store.recipes.length) {
      const empty = document.createElement('p');
      empty.className = 'change-picker-empty';
      empty.textContent = t('picker.emptyHint');
      list.appendChild(empty);
    }
    panel.appendChild(list);

    const recipe = selectedRecipeId ? store.get(selectedRecipeId) : undefined;
    if (!recipe) return;

    const editorHead = document.createElement('div');
    editorHead.className = 'change-picker-editor-head';
    const editorTitle = document.createElement('span');
    editorTitle.textContent = t('picker.editPattern');
    const remove = createButton({
      label: '',
      ariaLabel: t('picker.deleteNamed', { name: recipe.name }),
      title: t('picker.deletePattern'),
      icon: createIcon('trash'),
      variant: 'icon',
      onClick: () => {
        if (!window.confirm(`${t('picker.deleteConfirmQ', { name: recipe.name })}
${t('picker.deleteConfirmNote')}`)) return;
        if (emptyDraftRecipeId === recipe.id) emptyDraftRecipeId = null;
        store.remove(recipe.id);
        selectedRecipeId = store.recipes[0]?.id ?? null;
        addingToRecipe = false;
        render();
      },
    });
    editorHead.append(editorTitle, remove);
    panel.appendChild(editorHead);

    const addControl = createButton({
      label: addingToRecipe ? t('picker.closeAdd') : t('picker.addBlock'),
      icon: createIcon('square-plus'),
      className: 'change-picker-add-block',
      onClick: () => {
        addingToRecipe = !addingToRecipe;
        blockQuery = '';
        activeCategory = 'all';
        render();
      },
    });
    panel.appendChild(createRecipeEditor({
      recipe,
      catalog,
      store,
      addControl,
      hint: t('picker.weightHint'),
    }));

    if (addingToRecipe) {
      panel.appendChild(renderBlockBrowser((_index, def) => {
        store.update(recipe.id, { entries: addBlockToRecipe(recipe, def.id) });
        if (emptyDraftRecipeId === recipe.id) emptyDraftRecipeId = null;
        addingToRecipe = false;
        render();
      }, true));
    }

    const apply = createButton({
      label: recipe.id === target?.currentRecipeId ? t('picker.reapplyPattern') : t('picker.applyPattern'),
      variant: 'primary',
      className: 'change-picker-apply',
      disabled: !isDrawableRecipe(recipe, indexOf),
      onClick: () => {
        const current = target;
        if (!current || !isDrawableRecipe(recipe, indexOf)) return;
        close();
        current.onPattern(recipe);
      },
    });
    panel.appendChild(apply);
  }

  function render(): void {
    if (!target) return;
    // The popover element itself is only ever created once, so the aria-label is
    // reapplied here too (setting it just once at creation would leave it stuck at
    // the launch-time language even after opening post-switch)
    popover.setAttribute('aria-label', t('picker.ariaLabel'));
    popover.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'change-picker-head';
    const title = document.createElement('div');
    const heading = document.createElement('strong');
    heading.textContent = t('picker.title');
    const source = document.createElement('span');
    source.textContent = target.sourceName;
    title.append(heading, source);
    const closeButton = createButton({
      label: '',
      ariaLabel: t('picker.closePicker'),
      title: t('picker.close'),
      icon: createIcon('close'),
      variant: 'icon',
      onClick: close,
    });
    header.append(title, closeButton);
    popover.appendChild(header);

    if (!target.blocksOnly) {
      const tabs = createTabList<PickerTab>({
        label: t('picker.method'),
        selected: activeTab,
        tabs: [
          { id: 'blocks', label: t('picker.tabBlocks'), controls: 'block-change-blocks' },
          { id: 'patterns', label: t('picker.tabPatterns'), controls: 'block-change-patterns' },
        ],
        onSelect: (tab) => {
          activeTab = tab;
          addingToRecipe = false;
          render();
          popover.querySelector<HTMLButtonElement>(`[aria-controls="block-change-${tab}"]`)?.focus();
        },
      });
      popover.appendChild(tabs);
    }

    const panel = document.createElement('div');
    panel.id = `block-change-${activeTab}`;
    panel.className = 'change-picker-panel';
    // Don't claim the `tabpanel` role when no tabs are rendered (since no
    // corresponding tab exists, this avoids leaving assistive tech with a reference
    // it can't trace back to "which tab's content is this")
    if (!target.blocksOnly) {
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', `${panel.id}-tab`);
    }
    if (activeTab === 'blocks') renderBlocks(panel);
    else renderPatterns(panel);
    popover.appendChild(panel);
    if (popover.matches(':popover-open') && anchorElement) positionAt(anchorElement);
  }

  store.subscribe(() => {
    if (isOpen()) render();
  });
  popover.addEventListener('toggle', () => {
    if (!popover.matches(':popover-open')) {
      const emptyDraft = emptyDraftRecipeId;
      target = null;
      anchorElement = null;
      addingToRecipe = false;
      emptyDraftRecipeId = null;
      if (emptyDraft && store.get(emptyDraft)?.entries.length === 0) store.remove(emptyDraft);
    }
  });
  window.addEventListener('resize', () => {
    if (isOpen() && anchorElement) positionAt(anchorElement);
  });

  return {
    open: (anchor, nextTarget) => {
      anchorElement = anchor;
      target = nextTarget;
      activeTab = !nextTarget.blocksOnly && nextTarget.currentRecipeId ? 'patterns' : 'blocks';
      activeCategory = 'all';
      blockQuery = '';
      selectedRecipeId = nextTarget.currentRecipeId ?? store.recipes[0]?.id ?? null;
      addingToRecipe = false;
      emptyDraftRecipeId = null;
      render();
      popover.showPopover();
      positionAt(anchor);
      if (activeTab === 'blocks') popover.querySelector<HTMLInputElement>('.change-picker-search')?.focus();
    },
    close,
  };
}
