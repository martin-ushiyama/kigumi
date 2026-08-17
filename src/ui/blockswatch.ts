import { applyTextureBackground } from './textureframe';
import type { BlockDef } from '../core/types';
import { blockName, setActiveBlock, setActiveRecipe, setSpareBlock, state, swapActiveAndSpare, t } from '../state';
import textureManifest from '../data/textures.json';
import type { BlockChangePicker } from './blockchangepicker';
import { createIcon } from './icons';
import { createButton } from './primitives';

const MANIFEST = textureManifest as Record<string, { side: string; top?: string }>;

/**
 * The stacked swatch at the left end of the toolbar. Plays the same role as
 * foreground/background color in Photoshop — front = the block placed now, back =
 * the spare. Swapped with the `X` key.
 *
 * **The spare is never "empty"** (`state.spareBlock` always points to a valid
 * catalog index). Allowing an empty spare would only add branching in three places
 * (rendering, key handling, swapping) for no benefit, so a different material is
 * seeded in from startup.
 *
 * The toolbar is rebuilt via `render()` on every `onStateChange`, so this doesn't
 * subscribe on its own — it just assembles from whatever state is current when it's called.
 */
export function createBlockSwatchPair(catalog: BlockDef[], picker: BlockChangePicker): HTMLElement {
  const pair = document.createElement('div');
  pair.className = 'block-swatch-pair';

  pair.append(
    swatchButton('spare', state.spareBlock),
    swatchButton('active', state.activeBlock),
    createButton({
      label: '',
      ariaLabel: t('swatch.swapWithKey'),
      title: t('swatch.swapWithKey'),
      icon: createIcon('swap'),
      variant: 'icon',
      className: 'block-swatch-swap',
      onClick: swapActiveAndSpare,
    }),
  );
  return pair;

  function swatchButton(role: 'active' | 'spare', index: number): HTMLButtonElement {
    const def = catalog[index];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `block-swatch ${role}`;
    button.dataset.role = role;
    if (def) {
      button.dataset.blockId = def.id;
      button.style.backgroundColor = def.color;
      const texture = MANIFEST[def.id];
      if (texture) applyTextureBackground(button, texture.side);
    }
    const label = def
      ? t(role === 'active' ? 'swatch.activeNamed' : 'swatch.spareNamed', { name: blockName(def) })
      : t(role === 'active' ? 'swatch.active' : 'swatch.spare');
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', () => openPickerFor(role, button));
    return button;
  }

  function openPickerFor(role: 'active' | 'spare', anchor: HTMLElement): void {
    const def = catalog[role === 'active' ? state.activeBlock : state.spareBlock];
    picker.open(anchor, {
      sourceIndex: role === 'active' ? state.activeBlock : state.spareBlock,
      sourceName: def ? blockName(def) : t(role === 'active' ? 'swatch.active' : 'swatch.spare'),
      // The swatch can only hold a single block. No pattern tab shown
      blocksOnly: true,
      onBlock: (catalogIndex) => {
        if (role === 'active') {
          // Re-selecting the foreground means "place this now," so clear the active mix recipe
          setActiveBlock(catalogIndex);
          setActiveRecipe(null);
        } else {
          setSpareBlock(catalogIndex);
        }
        picker.close();
      },
      onPattern: () => {
        /* No pattern tab appears since blocksOnly is set */
      },
    });
  }
}
