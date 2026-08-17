import { expect, test, type Page } from '@playwright/test';

/**
 * Pins down the persistence and edit mode of the component list against the real assembly in main.ts.
 *
 * The unit tests cover `ComponentStore` and `endComponentEdit` separately, but
 * **how the list is assembled and wired to localStorage** exists only in main.ts.
 * Restoring on startup depends on the initialization order, so without going through here
 * "saved it, but the list is empty after a restart" slips past (the whole list vanished).
 */

const AUTOSAVE_KEY = 'blocksmith.project.autosave.v1';
const COMPONENTS_KEY = 'blocksmith.components.v1';

/** Seeds one group of two blocks through autosave and returns its id */
async function seedOneGroup(page: Page): Promise<string> {
  const blockId = await page.evaluate(() => window.__bs.CATALOG[0]!.id);
  await page.evaluate(
    ({ autosaveKey, componentsKey, id }) => {
      localStorage.removeItem(componentsKey); // start from an empty list every time
      localStorage.setItem(
        autosaveKey,
        JSON.stringify({
          app: 'blocksmith',
          version: 2,
          name: 'component check',
          blocks: [
            [0, 0, 0, id, 0, 0],
            [0, 1, 0, id, 0, 0],
          ],
          groups: [{ name: 'pillar', parent: -1 }],
          recipes: [],
        }),
      );
    },
    { autosaveKey: AUTOSAVE_KEY, componentsKey: COMPONENTS_KEY, id: blockId },
  );
  await page.reload();
  await expect(page.locator('#viewport')).toBeVisible();
  const ids = await page.evaluate(() => [...window.__bs.doc.tree.childrenOf(null)]);
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

/** Opens the list panel (the fourth item on the rail) */
async function openComponentsPanel(page: Page): Promise<void> {
  await page.locator('#sidebar-rail .rail-item').nth(3).click();
  await expect(page.locator('#sidebar-left #components.active')).toHaveCount(1);
}

/** The names shown in the list */
function listedNames(page: Page): Promise<string[]> {
  return page.locator('#components .component-name').allTextContents();
}

/** Turns the selected group into a component (the inspector button).
 *  The hasText strings below are the Japanese UI labels of the default locale, so they stay as-is */
async function makeComponent(page: Page, groupId: string): Promise<void> {
  await page.evaluate((id) => window.__bs.selection.set({ kind: 'groups', ids: [id] }), groupId);
  await page.locator('#inspector button', { hasText: 'コンポーネントにする' }).click();
}

test('a component that was created is still listed after a reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
  const groupId = await seedOneGroup(page);

  await makeComponent(page, groupId);
  await openComponentsPanel(page);
  expect(await listedNames(page)).toContain('pillar');

  await page.reload();
  await expect(page.locator('#viewport')).toBeVisible();
  await openComponentsPanel(page);

  // **This is the real test.** If restoring on startup fails, the list comes back empty
  expect(await listedNames(page), 'it is still listed after a restart').toContain('pillar');
});

test('a component with no instances placed yet can still be edited and committed', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
  const groupId = await seedOneGroup(page);

  await makeComponent(page, groupId);
  // Delete the placed instance (= the original group) so that zero placements remain
  await page.evaluate((id) => window.__bs.selection.set({ kind: 'groups', ids: [id] }), groupId);
  await page.locator('#inspector button', { hasText: '削除' }).click();
  await expect.poll(() => page.evaluate(() => window.__bs.doc.tree.childrenOf(null).length)).toBe(0);

  await openComponentsPanel(page);
  await page.locator('#components button', { hasText: '中身を直す' }).click();
  await expect(page.locator('#components button', { hasText: '直し終えた' })).toHaveCount(1);

  await page.locator('#components button', { hasText: '直し終えた' }).click();

  // Did it leave edit mode = is "edit contents" back and "done editing" gone
  await expect(page.locator('#components button', { hasText: '直し終えた' }), 'it left edit mode').toHaveCount(0);
  await expect(page.locator('#components button', { hasText: '中身を直す' })).toHaveCount(1);
});
