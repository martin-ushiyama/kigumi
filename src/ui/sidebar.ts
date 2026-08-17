import { createIcon, type IconName } from './icons';
import { createButton } from './primitives';
import { onLangChange, onStateChange, resolvedTheme, setLang, setThemePreference, state, t } from '../state';
import type { UiKey } from '../core/i18n';

export interface SidebarPanels {
  /** Mount point for the document bar (build name, save state, export). Its contents are rendered by toolbar.ts */
  documentRoot: HTMLElement;
  /** The logo button at the top of the rail. Serves as the anchor for the file-actions menu (used by toolbar.ts) */
  fileMenuAnchor: HTMLButtonElement;
  layersRoot: HTMLElement;
  paletteRoot: HTMLElement;
  recipesRoot: HTMLElement;
  componentsRoot: HTMLElement;
}

const TABS: { id: 'layers' | 'palette' | 'recipes' | 'components'; labelKey: UiKey; icon: IconName }[] = [
  { id: 'layers', labelKey: 'panel.layers', icon: 'layers' },
  { id: 'palette', labelKey: 'panel.blocks', icon: 'grid' },
  { id: 'recipes', labelKey: 'panel.recipes', icon: 'texture' },
  { id: 'components', labelKey: 'panel.components', icon: 'square-plus' },
];

/**
 * The icon rail on the far left + the panel to its right.
 *
 * Panel switching uses **a vertical rail rather than horizontal tabs.** Tabs
 * split the available width evenly, so each one gets thinner and eventually can't
 * fit its label as items are added; a rail just needs to grow taller. This is also
 * where future panels get added (same shape as Figma's File / Assets / Tools).
 *
 * The logo at the top of the rail anchors the file-actions menu. Save / load /
 * clear live here rather than next to the build name — Figma likewise gathers
 * these under a File menu hung off the app logo.
 */
export function initSidebarTabs(root: HTMLElement, railRoot: HTMLElement): SidebarPanels {
  root.innerHTML = '';
  railRoot.innerHTML = '';
  let active: (typeof TABS)[number]['id'] = 'layers';

  const fileMenuAnchor = createButton({
    label: '',
    ariaLabel: t('rail.fileActions'),
    title: t('rail.fileActionsTitle'),
    icon: createIcon('box'),
    variant: 'icon',
    className: 'rail-logo',
  });

  const railNav = document.createElement('div');
  railNav.className = 'rail-items';
  railNav.setAttribute('role', 'tablist');
  railNav.setAttribute('aria-orientation', 'vertical');
  // Multiple tablists coexist on screen at once (e.g. the change picker's "method" tabs).
  // Without a label, assistive tech can't tell which switch this is
  railNav.setAttribute('aria-label', t('rail.sidePanels'));

  /**
   * The block-name language toggle. UI labels are fixed to English, so this
   * is the only thing it switches. The OSS default is English, with this letting
   * Japanese speakers flip to JA.
   */
  const langButton = createButton({
    label: '',
    ariaLabel: t('rail.blockNameLang'),
    variant: 'icon',
    className: 'rail-lang',
    onClick: () => setLang(state.lang === 'ja' ? 'en' : 'ja'),
  });
  function syncLang(): void {
    const ja = state.lang === 'ja';
    railNav.setAttribute('aria-label', t('rail.sidePanels'));
    fileMenuAnchor.setAttribute('aria-label', t('rail.fileActions'));
    fileMenuAnchor.title = t('rail.fileActionsTitle');
    helpButton.setAttribute('aria-label', t('rail.help'));
    helpButton.title = t('rail.helpTitle');
    langButton.setAttribute('aria-label', t('rail.blockNameLang'));
    syncRail();
    langButton.textContent = ja ? 'JA' : 'EN';
    // i18n-allow: only the language-toggle button shows both languages (unreadable target language = unusable button)
    langButton.title = ja ? '表示言語: 日本語 (クリックで English)' : 'Language: English (click for 日本語)';
    langButton.setAttribute('aria-pressed', String(ja));
    syncTheme();
  }

  /**
   * The screen-theme toggle. Built the same way as the language toggle —
   * anything that "switches instantly and remembers the choice" lives on the rail
   */
  const themeButton = createButton({
    label: '',
    ariaLabel: t('rail.theme'),
    icon: createIcon('theme'),
    variant: 'icon',
    className: 'rail-theme',
    // Pressing it puts the app into **an explicitly-chosen state** (stays fixed even if the OS setting changes afterward)
    onClick: () => setThemePreference(resolvedTheme() === 'dark' ? 'light' : 'dark'),
  });
  function syncTheme(): void {
    const dark = resolvedTheme() === 'dark';
    themeButton.setAttribute('aria-label', t('rail.theme'));
    themeButton.title = dark ? t('rail.themeToLight') : t('rail.themeToDark');
    themeButton.setAttribute('aria-pressed', String(dark));
  }

  const helpButton = createButton({
    label: '',
    ariaLabel: t('rail.help'),
    title: t('rail.helpTitle'),
    icon: createIcon('help'),
    variant: 'icon',
    className: 'rail-help',
    onClick: () => window.dispatchEvent(new CustomEvent('bs-toggle-help')),
  });

  const documentBar = document.createElement('div');
  documentBar.className = 'sidebar-document';

  const panelsContainer = document.createElement('div');
  panelsContainer.className = 'sidebar-panels';

  // To keep existing CSS selectors working as-is (#palette .foo / #recipes .foo),
  // the panel divs keep their existing ids (palette.ts/recipes.ts internals are unmodified)
  const panelEls: Record<string, HTMLElement> = {
    layers: Object.assign(document.createElement('div'), { id: 'layers', className: 'tab-panel' }),
    palette: Object.assign(document.createElement('div'), { id: 'palette', className: 'tab-panel' }),
    recipes: Object.assign(document.createElement('div'), { id: 'recipes', className: 'tab-panel' }),
    components: Object.assign(document.createElement('div'), { id: 'components', className: 'tab-panel' }),
  };
  for (const tab of TABS) {
    const panel = panelEls[tab.id]!;
    // Claiming role=tab requires an association with a matching tabpanel (raised in
    // review). Hidden panels also get `hidden` set, removing them from assistive tech's reading order
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `rail-tab-${tab.id}`);
    panelsContainer.appendChild(panel);
  }

  const railButtons = new Map<string, HTMLButtonElement>();
  for (const tab of TABS) {
    const btn = createButton({
      label: '',
      ariaLabel: t(tab.labelKey),
      title: t(tab.labelKey),
      icon: createIcon(tab.icon),
      variant: 'icon',
      className: 'rail-item',
      onClick: () => {
        active = tab.id;
        syncRail();
        syncPanels();
      },
    });
    btn.setAttribute('role', 'tab');
    btn.id = `rail-tab-${tab.id}`;
    btn.setAttribute('aria-controls', tab.id);
    const label = document.createElement('span');
    label.className = 'rail-item-label';
    label.textContent = t(tab.labelKey);
    btn.appendChild(label);
    railButtons.set(tab.id, btn);
    railNav.appendChild(btn);
  }

  function syncRail(): void {
    for (const tab of TABS) {
      const btn = railButtons.get(tab.id)!;
      const on = active === tab.id;
      // Also called on language switch, so labels are re-resolved here every time
      btn.setAttribute('aria-label', t(tab.labelKey));
      btn.title = t(tab.labelKey);
      const label = btn.querySelector('.rail-item-label');
      if (label) label.textContent = t(tab.labelKey);
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
      // Roving tabindex: only the selected item is Tab-reachable (movement within the rail uses ↑↓)
      btn.tabIndex = on ? 0 : -1;
    }
  }
  function syncPanels(): void {
    for (const tab of TABS) {
      const on = active === tab.id;
      panelEls[tab.id]!.classList.toggle('active', on);
      panelEls[tab.id]!.hidden = !on;
    }
  }

  // ↑↓ / Home / End move within the rail and switch immediately (automatic activation)
  railNav.addEventListener('keydown', (e) => {
    const order = TABS.map((item) => item.id);
    const current = order.indexOf(active);
    let next = -1;
    if (e.key === 'ArrowDown') next = (current + 1) % order.length;
    else if (e.key === 'ArrowUp') next = (current - 1 + order.length) % order.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = order.length - 1;
    if (next < 0) return;
    e.preventDefault();
    // The router listens for keydown on window, so without stopping it here, the
    // arrow keys would **also leak into selection nudge-move or camera movement**.
    // Movement within the rail is fully contained right here
    e.stopPropagation();
    active = order[next]!;
    syncRail();
    syncPanels();
    railButtons.get(active)!.focus();
  });

  railRoot.append(fileMenuAnchor, railNav, themeButton, langButton, helpButton);
  // Runs the first sync only after every referenced element exists (function declarations hoist, but `const` is in the TDZ)
  syncLang();
  onLangChange(syncLang);
  onStateChange((event) => {
    if (event.kind === 'theme') syncTheme();
  });
  syncTheme();
  root.append(documentBar, panelsContainer);
  syncRail();
  syncPanels();

  return {
    documentRoot: documentBar,
    fileMenuAnchor,
    layersRoot: panelEls.layers!,
    paletteRoot: panelEls.palette!,
    recipesRoot: panelEls.recipes!,
    componentsRoot: panelEls.components!,
  };
}
