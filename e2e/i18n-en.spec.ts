import { expect, test, type Page } from '@playwright/test';

/**
 * **A spec that walks the real wiring with the English default left in place**.
 *
 * The other specs are pinned to JA by the storageState in playwright.config.ts. That is because the existing
 * locators are written in Japanese, but **that pinning hides missing translations on the English side**.
 * In fact, the first review missed gaps in the toolbar, toasts, and export notifications exactly this way.
 *
 * Here the storageState is overridden so the app starts in English, and each path is checked for
 * **no Japanese leaking into the strings shown on screen**.
 */

// Unlike the other specs, this omits the UI preference so the app starts with the English default.
// The tour is marked complete because this suite exercises the editor underneath it; the dedicated
// onboarding spec covers the first-visit path in both UI languages.
test.use({
  storageState: {
    cookies: [],
    origins: [
      {
        origin: 'http://localhost:4319',
        localStorage: [{ name: 'blocksmith.onboarding.v1', value: 'done' }],
      },
    ],
  },
});

const JA = /[\u3040-\u30ff\u4e00-\u9fff]/;

/** Whether Japanese shows up anywhere on screen (block names are expected to be in English too) */
async function findJapanese(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).evaluateAll((els) =>
    els
      .flatMap((el) => [el.textContent ?? '', el.getAttribute('title') ?? '', el.getAttribute('aria-label') ?? ''])
      .filter((s) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(s)),
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
  await expect(page.locator('#sidebar-rail .rail-lang')).toHaveText('EN'); // the default really is English
});

test('no Japanese appears anywhere in the shell (rail / panels / toolbar / status bar)', async ({ page }) => {
  await page.keyboard.press('1');
  const pos = await page.evaluate(() => window.__bs.groundScreenPos(5, 5));
  await page.mouse.click(pos.x, pos.y);
  await expect.poll(() => page.evaluate(() => window.__bs.world.size)).toBe(1);

  // Only the language-toggle tooltip is **intentionally bilingual**. English users need to be told that
  // Japanese exists, so it is the one thing excluded here
  for (const sel of [
    '#sidebar-rail *:not(.rail-lang)',
    '#sidebar-left *',
    '#toolbar *',
    '#world-controls *',
    '#inspector *',
    '#block-usage *',
  ]) {
    expect(await findJapanese(page, sel), `Japanese remains in ${sel}`).toEqual([]);
  }
  expect(page.locator('#statusbar')).toBeTruthy();
  expect(JA.test((await page.locator('#statusbar').textContent()) ?? '')).toBe(false);
});

/**
 * The aria-label on the regions themselves (the container elements).
 *
 * The existing checks looked at **descendants**, as in `#toolbar *`, so an aria-label put on `#toolbar`
 * itself was out of scope.
 */
test('no Japanese appears in region names (the aria-label on a container itself)', async ({ page }) => {
  for (const sel of ['#sidebar-rail', '#toolbar', '#world-controls', '#block-usage']) {
    const label = await page.locator(sel).getAttribute('aria-label');
    expect(label, `${sel} has no aria-label`).toBeTruthy();
    expect(JA.test(label ?? ''), `Japanese remains in the aria-label of ${sel}: ${label}`).toBe(false);
  }
});

test('<html lang> follows the display language', async ({ page }) => {
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.locator('#sidebar-rail .rail-lang').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
});

test('region names follow along when the language is switched', async ({ page }) => {
  await page.locator('#sidebar-rail .rail-lang').click();
  await expect(page.locator('#sidebar-rail .rail-lang')).toHaveText('JA');
  // After the switch it becomes Japanese = the static markup was re-rendered through t()
  await expect.poll(() => page.locator('#toolbar').getAttribute('aria-label')).toMatch(JA);

  // Switching back to English restores it (closes a bug where only one direction works)
  await page.locator('#sidebar-rail .rail-lang').click();
  expect(JA.test((await page.locator('#toolbar').getAttribute('aria-label')) ?? '')).toBe(false);
});

test('no Japanese appears in the help panel', async ({ page }) => {
  await page.keyboard.press('h');
  await expect(page.locator('.help-panel')).toBeVisible();
  expect(await findJapanese(page, '.help-panel *')).toEqual([]);
});

test('no Japanese appears in edit toasts (bulk placement by shape fill)', async ({ page }) => {
  const status = page.locator('#statusbar');

  // A shape fill (drag → commit at height 1) reports the count in a toast
  await page.keyboard.press('3');
  const a = await page.evaluate(() => window.__bs.groundScreenPos(0, 0));
  const b = await page.evaluate(() => window.__bs.groundScreenPos(2, 2));
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  await page.mouse.down();
  await page.mouse.up(); // commit while still at height 1

  await expect.poll(async () => (await status.textContent()) ?? '').toContain('Placed');
  expect(JA.test((await status.textContent()) ?? '')).toBe(false);
});

test('no Japanese appears in failure toasts for operations (errors from the editor layer)', async ({ page }) => {
  await page.keyboard.press('v');
  // Copy with nothing selected → "Nothing selected to copy"
  await page.keyboard.press('Control+c');
  const status = page.locator('#statusbar');
  await expect.poll(async () => (await status.textContent()) ?? '').toContain('Nothing selected');
  expect(JA.test((await status.textContent()) ?? '')).toBe(false);
});

test('no Japanese appears in export failure notifications (the throw → toast path)', async ({ page }) => {
  // Export with no blocks at all → the export layer throws and ProjectService shows a toast
  await page.locator('#sidebar-left .document-export').click();
  const status = page.locator('#statusbar');
  await expect.poll(async () => (await status.textContent()) ?? '').toContain('No blocks');
  expect(JA.test((await status.textContent()) ?? '')).toBe(false);
});

async function loadFile(page: Page, name: string, body: string): Promise<void> {
  await page.locator('#sidebar-rail .rail-logo').click();
  await page.locator('.document-file-menu button', { hasText: 'Load' }).click();
  await page
    .locator('input[type="file"][accept*="application/json"]')
    .setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(body) });
}

test('no Japanese appears in load failure notifications (a syntax error)', async ({ page }) => {
  await loadFile(page, 'broken.json', '{ not json');

  const status = page.locator('#statusbar');
  await expect.poll(async () => (await status.textContent()) ?? '').toContain('Load failed');
  expect(JA.test((await status.textContent()) ?? '')).toBe(false);
});

/**
 * A syntax error only surfaces the browser's own English `SyntaxError`, so this
 * walks **the path that goes through the validation throws in `persistence.ts`** (JSON that parses but
 * fails validation) with the English default. This is the very wiring that was missed until the third round.
 *
 * Those throws were Japanese when this was written and have since been translated. The guard stays because what it
 * pins down is the boundary — a raw `e.message` must never reach the toast — not the language the message
 * happens to be in today.
 */
test('no Japanese appears in load failure notifications (JSON that parses but fails validation)', async ({ page }) => {
  const status = page.locator('#statusbar');

  for (const [label, project] of [
    ['app mismatch', { app: 'other', version: 1, name: 'x', blocks: [], recipes: [] }],
    ['groups is not an array', { app: 'blocksmith', version: 2, name: 'x', groups: 'no', blocks: [], recipes: [] }],
    ['an element of blocks is malformed', { app: 'blocksmith', version: 1, name: 'x', blocks: [[1, 2]], recipes: [] }],
  ] as const) {
    await loadFile(page, 'invalid.json', JSON.stringify(project));
    await expect.poll(async () => (await status.textContent()) ?? '').toContain('Load failed');
    const text = (await status.textContent()) ?? '';
    expect(JA.test(text), `${label}: Japanese leaked into the toast: ${text}`).toBe(false);
  }
});
