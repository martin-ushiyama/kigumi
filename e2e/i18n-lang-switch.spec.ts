import { expect, test } from '@playwright/test';

/**
 * A spec that catches **language-switch burn-in** across the whole screen.
 *
 * If code evaluates `t()` at build time and never re-renders, only that element keeps the startup language
 * even after a switch. Fixing them one by one does not help, because the next occurrence of that pattern brings it
 * back, so this sweeps **the entire screen** rather than specific elements.
 *
 * **It is only detectable in the direction of starting in JA and switching to EN.** A burned-in element keeps
 * "the language at startup", so round-tripping from an EN start leaves English behind, which cannot be told apart
 * from proper nouns (`Stone` / `blocksmith`), key names (`Ctrl+Z`), or headings deliberately left untranslated
 * (`View`). Starting in JA guarantees that any residue is Japanese = always something that should have been translated.
 * (`i18n-en.spec.ts` is pinned to an EN start, so putting this check there would let everything pass.)
 */

// The storageState in playwright.config.ts makes this start in JA (not overridden here)

test('switching the language to EN leaves no Japanese anywhere on screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();

  const toggle = page.locator('#sidebar-rail .rail-lang');
  await expect(toggle).toHaveText('JA');
  await toggle.click();
  await expect(toggle).toHaveText('EN');

  const residual = await page.evaluate(() => {
    const JA_RE = /[぀-ヿ一-鿿]/;
    const found: string[] = [];
    document.querySelectorAll('*').forEach((el) => {
      // Only the language toggle carries the name of the other language, to show what it switches to (intentional)
      if (el.closest('.rail-lang')) return;
      const label = el.id ? `#${el.id}` : el.classList[0] ? `.${el.classList[0]}` : el.tagName.toLowerCase();
      for (const attr of ['aria-label', 'title', 'placeholder']) {
        const value = el.getAttribute(attr);
        if (value && JA_RE.test(value)) found.push(`${label}[${attr}] = ${value}`);
      }
      const own = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent?.trim() ?? '')
        .join('');
      if (own && JA_RE.test(own)) found.push(`${label} = ${own}`);
    });
    return found;
  });

  expect(residual, `Japanese still remains after switching to EN: ${residual.join(' / ')}`).toEqual([]);
});
