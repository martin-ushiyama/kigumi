import type { UiKey } from '../core/i18n';
import { onLangChange, state, t } from '../state';

/**
 * Wires the text hardcoded into index.html into the language switch (raised in review).
 *
 * Round 1 review found that static markup text was left un-translatable. The cause
 * was that neither the `src/**` grep nor the string-extraction pass ever looked at
 * index.html. Patching each discovered spot individually would just let the same
 * gap reopen every time new text is added to static markup.
 *
 * So instead, static markup text is required to always flow through here:
 *
 * | Attribute | Effect |
 * |---|---|
 * | `data-i18n-text="<UiKey>"` | Fills `textContent` in the current language |
 * | `data-i18n-aria="<UiKey>"` | Fills `aria-label` in the current language |
 *
 * `<html lang>` is kept in sync too (it affects screen reader pronunciation and
 * browser translation detection). index.html itself stays fixed in English by
 * default; this overwrites it at runtime.
 *
 * Writing a Japanese literal into static markup gets caught in CI by
 * `checkDisplayLiterals` (scripts/architecture-lint.mjs), so this path can't be bypassed.
 */
export function initStaticLabels(root: ParentNode = document): void {
  function render(): void {
    for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-text]')) {
      const key = el.dataset.i18nText as UiKey | undefined;
      if (key) el.textContent = t(key);
    }
    for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
      const key = el.dataset.i18nAria as UiKey | undefined;
      if (key) el.setAttribute('aria-label', t(key));
    }
    document.documentElement.lang = state.lang;
  }
  render();
  onLangChange(render);
}
