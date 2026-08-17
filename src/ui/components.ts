import type { ComponentStore, ComponentTemplate } from '../core/component';
import { layoutComponentThumb, THUMB_CELL_HEIGHT, THUMB_CELL_WIDTH } from '../core/componentthumb';
import type { BlockDef } from '../core/types';
import { unpackCell } from '../core/orientation';
import { onLangChange, onStateChange, setPendingComponent, state, t } from '../state';

/**
 * The components list (#69 Step 3).
 *
 * The fourth panel in the left rail. Plays the same role as Figma's Assets panel —
 * it lists belongings that are **tied to the account, not the build** (same as the
 * mix-recipe panel).
 *
 * Each row is **a name + a thumbnail.** A component is just a shape, so a name
 * alone doesn't say what it is. Thumbnail layout comes from `componentthumb.ts`
 * (the same shape always renders the same image).
 */

export interface ComponentsPanelOpts {
  /** Notify the outside when placement mode is entered/exited (so pressing again can cancel it) */
  onPendingChange?: () => void;
  /**
   * Remove from the list (#69). **Doesn't delete placed instances** — removing from
   * the list and destroying the build are separate decisions, so instances are left
   * behind as plain groups. The op that clears `templateId` gets recorded in
   * history (on the Document side), which the caller owns.
   */
  onRemove?: (template: ComponentTemplate) => void;
  /** Enter editing its contents (#69). Hides everything else and shows only the component */
  onEdit?: (template: ComponentTemplate) => void;
  /** The component currently being edited (null = not editing). While editing, other operations are hidden */
  getEditingId?: () => string | null;
  /** Finish editing */
  onFinishEdit?: () => void;
}

/** Render size per thumbnail cell (px). Sized to fit within a row's height */
const CELL_PX = 7;
const THUMB_PADDING = 3;

/**
 * Draw the thumbnail to a canvas.
 *
 * Each cell is painted with three faces: top (bright) / left (dark) / right
 * (medium). **No light source is placed** — each face just gets a fixed brightness
 * multiplier, so the same shape always produces the same image.
 */
function drawThumb(canvas: HTMLCanvasElement, template: ComponentTemplate, colorOf: (raw: number) => string): void {
  const layout = layoutComponentThumb(template);
  const width = Math.max(1, Math.ceil(layout.width * CELL_PX) + THUMB_PADDING * 2);
  const height = Math.max(1, Math.ceil(layout.height * CELL_PX) + THUMB_PADDING * 2);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return; // Just a blank slot in environments that can't render this (the list itself still works)

  const halfW = (THUMB_CELL_WIDTH * CELL_PX) / 2;
  const halfH = (THUMB_CELL_HEIGHT * CELL_PX) / 2;

  for (const cell of layout.cells) {
    const x = cell.x * CELL_PX + THUMB_PADDING + halfW;
    const y = cell.y * CELL_PX + THUMB_PADDING + halfH;
    const base = colorOf(cell.raw);

    // Top face
    ctx.fillStyle = shade(base, 1);
    ctx.beginPath();
    ctx.moveTo(x, y - halfH);
    ctx.lineTo(x + halfW, y);
    ctx.lineTo(x, y + halfH);
    ctx.lineTo(x - halfW, y);
    ctx.closePath();
    ctx.fill();

    // Left face
    ctx.fillStyle = shade(base, 0.62);
    ctx.beginPath();
    ctx.moveTo(x - halfW, y);
    ctx.lineTo(x, y + halfH);
    ctx.lineTo(x, y + halfH + halfH * 2);
    ctx.lineTo(x - halfW, y + halfH * 2);
    ctx.closePath();
    ctx.fill();

    // Right face
    ctx.fillStyle = shade(base, 0.8);
    ctx.beginPath();
    ctx.moveTo(x + halfW, y);
    ctx.lineTo(x, y + halfH);
    ctx.lineTo(x, y + halfH + halfH * 2);
    ctx.lineTo(x + halfW, y + halfH * 2);
    ctx.closePath();
    ctx.fill();
  }
}

/** Apply a brightness multiplier to `#rrggbb` (a simple trick just to convey face orientation) */
function shade(hex: string, factor: number): string {
  const value = parseInt(hex.slice(1), 16);
  const channel = (shift: number) =>
    Math.max(0, Math.min(255, Math.round(((value >> shift) & 0xff) * factor)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

export function initComponents(
  root: HTMLElement,
  catalog: BlockDef[],
  store: ComponentStore,
  opts: ComponentsPanelOpts,
): { refresh: () => void } {
  /** The component currently being renamed */
  let renamingId: string | null = null;
  const colorOf = (raw: number): string => catalog[unpackCell(raw).catalogIndex]?.color ?? '#888888';

  function render(): void {
    root.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'recipes-header';
    const title = document.createElement('span');
    title.textContent = t('components.title');
    header.appendChild(title);
    root.appendChild(header);

    if (!store.templates.length) {
      const empty = document.createElement('p');
      empty.className = 'panel-empty';
      empty.textContent = t('components.emptyHint');
      root.appendChild(empty);
      return;
    }

    // While editing, show only that one item and a "finish" button. **Leaving
    // everything else touchable would let operations proceed on a hidden build
    // where they can't be seen.**
    const editingId = opts.getEditingId?.() ?? null;
    if (editingId !== null) {
      const editing = store.templates.find((template) => template.id === editingId);
      const banner = document.createElement('div');
      banner.className = 'component-editing';
      const label = document.createElement('span');
      label.textContent = t('components.editing', { name: editing?.name ?? '' });
      banner.appendChild(label);
      const finish = document.createElement('button');
      finish.textContent = t('components.finishEdit');
      finish.addEventListener('click', () => opts.onFinishEdit?.());
      banner.appendChild(finish);
      root.appendChild(banner);
      return;
    }

    const list = document.createElement('ul');
    list.className = 'component-list';
    for (const template of store.templates) {
      const item = document.createElement('li');
      item.className = 'component-item';

      const thumb = document.createElement('canvas');
      thumb.className = 'component-thumb';
      drawThumb(thumb, template, colorOf);
      item.appendChild(thumb);

      // Renaming happens in-place (same feel as renaming a layer). Components made
      // from the same shape end up with identical default names, so **piling up
      // indistinguishable entries** is the worst outcome to avoid.
      if (renamingId === template.id) {
        const input = document.createElement('input');
        input.className = 'component-name-input';
        input.type = 'text';
        input.value = template.name;
        // **Enter must not route through blur.** If a re-render has already
        // replaced the input, blur never fires and the typed name gets silently
        // discarded (hit this on real hardware).
        let done = false;
        const commit = (): void => {
          if (done) return; // Avoid writing the name twice from blur and Enter both firing
          done = true;
          const next = input.value.trim();
          if (next && next !== template.name) store.rename(template.id, next);
          renamingId = null;
          render();
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            done = true;
            renamingId = null;
            render();
          }
        });
        item.appendChild(input);
        queueMicrotask(() => {
          input.focus();
          input.select();
        });
      } else {
        const name = document.createElement('span');
        name.className = 'component-name';
        name.textContent = template.name;
        name.title = t('components.renameHint');
        name.addEventListener('dblclick', () => {
          renamingId = template.id;
          render();
        });
        item.appendChild(name);
      }

      // Pressing enters placement mode, pressing again exits it. **The placement location is decided by a click** (#69 Step 3b)
      const pending = state.pendingComponentId === template.id;
      const place = document.createElement('button');
      place.textContent = pending ? t('components.placing') : t('components.place');
      place.setAttribute('aria-pressed', String(pending));
      place.addEventListener('click', () => {
        setPendingComponent(pending ? null : template.id);
        opts.onPendingChange?.();
        render();
      });
      item.appendChild(place);

      const edit = document.createElement('button');
      edit.textContent = t('components.edit');
      edit.addEventListener('click', () => opts.onEdit?.(template));
      item.appendChild(edit);

      const remove = document.createElement('button');
      remove.className = 'component-remove';
      remove.textContent = '×';
      remove.title = t('components.remove');
      remove.setAttribute('aria-label', t('components.remove'));
      remove.addEventListener('click', () => {
        if (state.pendingComponentId === template.id) setPendingComponent(null);
        opts.onRemove?.(template);
        store.remove(template.id);
        render();
      });
      item.appendChild(remove);

      list.appendChild(item);
    }
    root.appendChild(list);
  }

  store.subscribe(render);
  // Redraw when the language changes. **The list's heading and empty-state hint
  // are assembled here**, so subscribing only to store / state would leave them
  // stuck in the old language after a switch (#142 review P1)
  onLangChange(render);
  // Placement mode can also change from the canvas side (confirmed by a click /
  // exited on placement), so keep the button display following state — redrawing
  // only at the moment of the click would leave the display stale
  onStateChange((event) => {
    if (event.kind === 'pendingComponent') render();
  });
  render();
  return { refresh: render };
}
