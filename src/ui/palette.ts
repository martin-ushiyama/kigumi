import { applyTextureBackground } from './textureframe';
import type { Shape } from '../core/orientation';
import type { BlockDef } from '../core/types';
import { blockName, onStateChange, setActiveBlock, state, t } from '../state';
import textureManifest from '../data/textures.json';

const MANIFEST = textureManifest as Record<string, { side: string; top?: string }>;

type Category = BlockDef['category'];

/**
 * **Kept as a function.** A module-level constant would bake in the language at
 * load time, leaving stale labels behind even after a re-render on language switch (#70)
 */
const categoryLabel = (cat: Category): string =>
  ({ stone: t('palette.stone'), wood: t('palette.wood'), soil: t('palette.soil'), misc: t('palette.misc') })[cat];

const SHAPE_ORDER: Record<Shape, number> = { full: 0, slab: 1, stairs: 2 };
/** Same as above: a module-level constant would bake in the language on switch (#70) */
const shapeLabel = (shape: Shape): string =>
  ({ full: '', slab: t('palette.slab'), stairs: t('palette.stairs') })[shape];

export function initPalette(root: HTMLElement, catalog: BlockDef[]): void {
  const categories = [...new Set(catalog.map((b) => b.category))];
  let activeCategory: Category = categories[0] ?? 'stone';

  function renderSwatch(index: number, def: BlockDef): HTMLButtonElement {
    const swatch = document.createElement('button');
    swatch.className = `swatch shape-${def.shape}` + (index === state.activeBlock ? ' active' : '');
    swatch.style.backgroundColor = def.color;
    const entry = MANIFEST[def.id];
    if (entry) applyTextureBackground(swatch, entry.side);
    swatch.title = blockName(def);
    swatch.addEventListener('click', () => setActiveBlock(index));
    return swatch;
  }

  function renderRecent(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'recent';
    const grid = document.createElement('div');
    grid.className = 'recent-grid';
    for (let i = 0; i < 10; i++) {
      const index = state.recentBlocks[i];
      if (index === undefined) {
        const empty = document.createElement('div');
        empty.className = 'swatch empty';
        grid.appendChild(empty);
        continue;
      }
      const def = catalog[index];
      if (!def) continue;
      grid.appendChild(renderSwatch(index, def));
    }
    wrap.appendChild(grid);
    return wrap;
  }

  function render(): void {
    root.innerHTML = '';

    root.appendChild(renderRecent());

    const tabs = document.createElement('div');
    tabs.className = 'tabs';
    for (const cat of categories) {
      const btn = document.createElement('button');
      btn.textContent = categoryLabel(cat);
      btn.className = cat === activeCategory ? 'active' : '';
      btn.addEventListener('click', () => {
        activeCategory = cat;
        render();
      });
      tabs.appendChild(btn);
    }
    root.appendChild(tabs);

    // Group by materialGroup (preserving first-seen order) → within a group, order by shape (full<slab<stairs)
    const groupOrder: string[] = [];
    const groups = new Map<string, { index: number; def: BlockDef }[]>();
    catalog.forEach((def, index) => {
      if (def.category !== activeCategory) return;
      if (!groups.has(def.materialGroup)) {
        groupOrder.push(def.materialGroup);
        groups.set(def.materialGroup, []);
      }
      groups.get(def.materialGroup)!.push({ index, def });
    });
    for (const list of groups.values()) list.sort((a, b) => SHAPE_ORDER[a.def.shape] - SHAPE_ORDER[b.def.shape]);

    const blocks = document.createElement('div');
    blocks.className = 'blocks';
    for (const key of groupOrder) {
      for (const { index, def } of groups.get(key)!) {
        blocks.appendChild(renderSwatch(index, def));
      }
    }
    root.appendChild(blocks);

    const activeName = document.createElement('div');
    activeName.className = 'active-name';
    const active = catalog[state.activeBlock];
    activeName.textContent = active ? t('palette.selected', { name: `${blockName(active)}${active.shape !== 'full' ? ` [${shapeLabel(active.shape)}]` : ''}` }) : '';
    root.appendChild(activeName);
  }

  onStateChange(render);
  render();
}
