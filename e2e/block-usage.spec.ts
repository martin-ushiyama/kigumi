import { expect, test, type Page } from '@playwright/test';

/**
 * The "block usage" panel on the right. Pins down aggregation → bulk replacement → pattern repaint
 * through real panel operations.
 *
 * The unit tests (`tests/blockusage.test.ts`) cover the aggregation and the op builders separately, but
 * **"pressing a row shown in the panel changes the world exactly that way" only holds on the real path**.
 *
 * The UI labels asserted below (getByRole names, filter text) are the Japanese strings of the default locale,
 * so they stay as-is. The recipe names used as fixtures are also part of those accessible names and are kept.
 */

const AUTOSAVE_KEY = 'blocksmith.project.autosave.v1';

/** Group A (2 of block0) / group B (1 of block1) / unclassified (1 of block0) */
async function seedProject(page: Page): Promise<{ ids: string[]; blockA: string; blockB: string }> {
  const [blockA, blockB] = await page.evaluate(() => [window.__bs.CATALOG[0]!.id, window.__bs.CATALOG[1]!.id]);
  await page.evaluate(
    ({ key, a, b }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          app: 'blocksmith',
          version: 2,
          name: 'usage aggregation test',
          blocks: [
            [0, 0, 0, a, 0, 0],
            [1, 0, 0, a, 0, 0],
            [4, 0, 0, b, 0, 1],
            [8, 0, 0, a, 0, -1], // unclassified
          ],
          groups: [
            { name: 'A', parent: -1 },
            { name: 'B', parent: -1 },
          ],
          recipes: [],
        }),
      );
    },
    { key: AUTOSAVE_KEY, a: blockA, b: blockB },
  );
  await page.reload();
  await expect(page.locator('#viewport')).toBeVisible();
  const ids = await page.evaluate(() => [...window.__bs.doc.tree.childrenOf(null)]);
  return { ids, blockA: blockA, blockB: blockB };
}

/** The rows shown in the panel (block id → count) */
function usageRows(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('#block-usage [data-testid="usage-row"]')].map((el) => [
        el.dataset.blockId!,
        el.dataset.count!,
      ]),
    ),
  );
}

function catalogIndexAt(page: Page, x: number, y: number, z: number): Promise<number | null> {
  return page.evaluate(({ x: cx, y: cy, z: cz }) => window.__bs.catalogIndexAt(cx, cy, cz), { x, y, z });
}

async function openChangePicker(page: Page, blockId: string): Promise<void> {
  await page.locator(`#block-usage [data-block-id="${blockId}"] [data-testid="usage-change"]`).click();
  await expect(page.locator('#block-change-picker')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
});

test('with nothing selected it counts the whole work (including overlaps and unclassified)', async ({ page }) => {
  const { blockA, blockB } = await seedProject(page);

  await expect(page.locator('#block-usage .usage-scope')).toHaveText('作品全体');
  expect(await usageRows(page)).toEqual({ [blockA]: '3', [blockB]: '1' });
  await expect(page.locator('#block-usage .usage-summary')).toHaveText('2 種類 / 4 個');
});

test('selecting a group narrows the breakdown to that group alone', async ({ page }) => {
  const { ids, blockA } = await seedProject(page);

  await page.evaluate((id) => window.__bs.selection.set({ kind: 'groups', ids: [id] }), ids[0]!);
  await expect(page.locator('#block-usage .usage-scope')).toHaveText('A');
  expect(await usageRows(page)).toEqual({ [blockA]: '2' }); // neither the unclassified one nor B is included
});

test('change picker: replaces with the chosen block, independent of the left palette selection, and reverts in one undo', async ({ page }) => {
  const { blockA, blockB } = await seedProject(page);
  expect(await catalogIndexAt(page, 0, 0, 0)).toBe(0);

  // Leave the left palette on a different block and choose CATALOG[2] inside the picker
  await page.evaluate(() => window.__bs.setActiveBlock(5));
  const targetId = await page.evaluate(() => window.__bs.CATALOG[2]!.id);
  const undoBefore = await page.evaluate(() => window.__bs.doc.undoStack.length);

  await openChangePicker(page, blockA);
  await page.locator(`#block-change-picker [data-block-id="${targetId}"]`).click();

  // All 3 are replaced together, and the other block is untouched
  expect(await catalogIndexAt(page, 0, 0, 0)).toBe(2);
  expect(await catalogIndexAt(page, 1, 0, 0)).toBe(2);
  expect(await catalogIndexAt(page, 8, 0, 0)).toBe(2);
  expect(await catalogIndexAt(page, 4, 0, 0)).toBe(1);

  // The panel display follows along too
  const rows = await usageRows(page);
  expect(rows[blockA]).toBeUndefined();
  expect(rows[blockB]).toBe('1');

  expect(await page.evaluate(() => window.__bs.doc.undoStack.length)).toBe(undoBefore + 1);
  await page.keyboard.press('Control+z');
  expect(await catalogIndexAt(page, 0, 0, 0)).toBe(0);
  expect(await usageRows(page)).toEqual({ [blockA]: '3', [blockB]: '1' });
});

test('a bulk replacement with a group selected does not touch anything outside that group', async ({ page }) => {
  const { ids, blockA } = await seedProject(page);

  await page.evaluate((id) => window.__bs.selection.set({ kind: 'groups', ids: [id] }), ids[0]!);
  const targetId = await page.evaluate(() => window.__bs.CATALOG[2]!.id);
  await openChangePicker(page, blockA);
  await page.locator(`#block-change-picker [data-block-id="${targetId}"]`).click();

  expect(await catalogIndexAt(page, 0, 0, 0)).toBe(2); // inside group A
  expect(await catalogIndexAt(page, 1, 0, 0)).toBe(2);
  expect(await catalogIndexAt(page, 8, 0, 0)).toBe(0); // unclassified is unchanged
});

test('pattern repaint: repaints with a mix recipe, and undo → redo yields the same result', async ({ page }) => {
  const { blockA } = await seedProject(page);

  // Build a recipe mixing CATALOG[2] and [3] in equal parts. It is not selected in the left sidebar
  await page.evaluate(() => {
    const bs = window.__bs;
    const ids = [bs.CATALOG[2]!.id, bs.CATALOG[3]!.id];
    bs.recipeStore.replaceAll([
      { id: 'r1', name: 'テスト配合', entries: ids.map((id) => ({ blockId: id, weight: 1 })) },
    ]);
  });

  await openChangePicker(page, blockA);
  await page.locator('.block-change-picker').getByRole('tab', { name: 'パターン' }).click();
  await page.locator('#block-change-picker [data-recipe-id="r1"]').click();
  await page.getByRole('button', { name: 'このパターンに変更' }).click();

  const after = await Promise.all([
    catalogIndexAt(page, 0, 0, 0),
    catalogIndexAt(page, 1, 0, 0),
    catalogIndexAt(page, 8, 0, 0),
  ]);
  // They were replaced, and each landed on one of the two blocks in the recipe
  for (const i of after) expect([2, 3]).toContain(i);
  await expect(page.locator('#block-usage [data-testid="usage-pattern-row"][data-recipe-id="r1"]')).toHaveAttribute('data-count', '3');
  const historyAfterApply = await page.evaluate(() => window.__bs.doc.undoStack.length);

  // It is retained as the recipe itself rather than the resulting block list. Changing the ratio re-projects the
  // existing 3 cells onto the new mix, but editing the recipe does not add to the block edit history.
  await page.getByRole('button', { name: 'テスト配合を編集または変更' }).click();
  await expect(page.getByRole('button', { name: 'パターンを再適用' })).toBeEnabled();
  const firstName = await page.evaluate(() => window.__bs.CATALOG[2]!.nameJa);
  const firstWeight = page.getByRole('spinbutton', { name: `${firstName}の重み`, exact: true });
  await firstWeight.fill('0');
  await firstWeight.press('Tab');
  expect(
    await Promise.all([catalogIndexAt(page, 0, 0, 0), catalogIndexAt(page, 1, 0, 0), catalogIndexAt(page, 8, 0, 0)]),
  ).toEqual([3, 3, 3]);
  expect(await page.evaluate(() => window.__bs.doc.undoStack.length)).toBe(historyAfterApply);
  await page.getByRole('button', { name: 'ピッカーを閉じる' }).click();

  await page.keyboard.press('Control+z');
  expect(await catalogIndexAt(page, 0, 0, 0)).toBe(0);
  await expect(page.locator('#block-usage [data-testid="usage-pattern-row"]')).toHaveCount(0);

  // Redo brings the pattern reference back too, re-projected at the current ratio (100% on the latter)
  await page.keyboard.press('Control+y');
  expect(
    await Promise.all([catalogIndexAt(page, 0, 0, 0), catalogIndexAt(page, 1, 0, 0), catalogIndexAt(page, 8, 0, 0)]),
  ).toEqual([3, 3, 3]);
  await expect(page.locator('#block-usage [data-testid="usage-pattern-row"][data-recipe-id="r1"]')).toHaveAttribute('data-count', '3');

  // Restoring from an autosave v5 does not bake it into "3 resulting cells"; it comes back as edit data under the same recipeId
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem('blocksmith.project.autosave.v1');
    if (!raw) return false;
    const saved = JSON.parse(raw) as {
      version?: number;
      cells?: unknown[][];
      recipes?: Array<{ id?: string; entries?: Array<{ weight?: number }> }>;
    };
    return saved.version === 5
      && saved.cells?.some((cell) => (cell[6] as { recipeId?: string } | undefined)?.recipeId === 'r1') === true
      && saved.recipes?.find((recipe) => recipe.id === 'r1')?.entries?.[0]?.weight === 0;
  })).toBe(true);
  await page.reload();
  await expect(page.locator('#viewport')).toBeVisible();
  await expect(page.locator('#block-usage [data-testid="usage-pattern-row"][data-recipe-id="r1"]')).toHaveAttribute('data-count', '3');
  expect(
    await Promise.all([catalogIndexAt(page, 0, 0, 0), catalogIndexAt(page, 1, 0, 0), catalogIndexAt(page, 8, 0, 0)]),
  ).toEqual([3, 3, 3]);
});

test('the pattern tab handles create, add blocks, and rename end to end, and can apply right away', async ({ page }) => {
  const { blockA } = await seedProject(page);
  const targetId = await page.evaluate(() => window.__bs.CATALOG[2]!.id);

  await openChangePicker(page, blockA);
  // The left rail is also a tablist for switching panels, so scope this inside the picker
  const picker = page.locator('.block-change-picker');
  const blockTab = picker.getByRole('tab', { name: 'ブロック' });
  const patternTab = picker.getByRole('tab', { name: 'パターン' });
  await blockTab.focus();
  await blockTab.press('ArrowRight');
  await expect(patternTab).toHaveAttribute('aria-selected', 'true');
  await expect(patternTab).toBeFocused();
  await page.getByRole('button', { name: '新規' }).click();
  await expect(page.getByRole('button', { name: 'このパターンに変更' })).toBeDisabled();

  const name = page.getByRole('textbox', { name: 'パターン名' });
  await name.fill('石ミックス');
  await name.press('Tab'); // fire change so it is persisted

  // A new pattern opens the add browser right away, so an empty one does not leave you unsure what to do next
  await expect(page.getByRole('button', { name: '追加を閉じる' })).toBeVisible();
  await page.locator(`#block-change-picker [data-block-id="${targetId}"]`).click();
  await expect(page.getByRole('button', { name: 'このパターンに変更' })).toBeEnabled();
  await page.getByRole('button', { name: 'このパターンに変更' }).click();

  expect(await catalogIndexAt(page, 0, 0, 0)).toBe(2);
  expect(await page.evaluate(() => window.__bs.recipeStore.recipes[0]?.name)).toBe('石ミックス');
});

test('change picker: switches between tiles and a named list, and slab / stairs shapes are distinguishable by outline', async ({ page }) => {
  const { blockA } = await seedProject(page);
  const shapedIds = await page.evaluate(() => ({
    slab: window.__bs.CATALOG.find((block) => block.shape === 'slab')?.id,
    stairs: window.__bs.CATALOG.find((block) => block.shape === 'stairs')?.id,
  }));
  expect(shapedIds.slab).toBeTruthy();
  expect(shapedIds.stairs).toBeTruthy();

  await openChangePicker(page, blockA);
  const blocks = page.locator('#block-change-picker .change-picker-grid');
  await expect(blocks).toHaveAttribute('data-view', 'grid');
  expect(
    await blocks.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
  ).toBe(6);

  const fullPreview = page.locator('#block-change-picker .change-picker-block-preview').first();
  await expect(fullPreview).toHaveCSS('border-radius', '0px');
  await expect(
    page.locator(`#block-change-picker [data-block-id="${shapedIds.slab}"] .change-picker-block-preview`),
  ).not.toHaveCSS('clip-path', 'none');
  await expect(
    page.locator(`#block-change-picker [data-block-id="${shapedIds.stairs}"] .change-picker-block-preview`),
  ).not.toHaveCSS('clip-path', 'none');
  const stairsLabel = page.locator(
    `#block-change-picker [data-block-id="${shapedIds.stairs}"] > span:last-child`,
  );
  await expect(stairsLabel).toBeHidden();

  const list = page.getByRole('button', { name: 'リスト表示' });
  await list.click();
  await expect(blocks).toHaveAttribute('data-view', 'list');
  await expect(list).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'タイル表示' })).toHaveAttribute('aria-pressed', 'false');
  await expect(stairsLabel).toBeVisible();
});

test('change picker: Japanese can be typed without the search box being replaced mid-IME-composition', async ({ page }) => {
  const { blockA } = await seedProject(page);
  await openChangePicker(page, blockA);

  const search = page.getByRole('searchbox', { name: 'ブロックを検索' });
  const original = await search.elementHandle();
  if (!original) throw new Error('the search box was not found');

  await search.dispatchEvent('compositionstart', { data: 'み' });
  await search.evaluate((element: HTMLInputElement) => {
    element.value = 'み';
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: 'み',
      inputType: 'insertCompositionText',
      isComposing: true,
    }));
  });

  await expect(search).toHaveValue('み');
  expect(await search.evaluate((element, first) => element === first, original)).toBe(true);
  await search.dispatchEvent('compositionend', { data: 'み' });
});

test('change picker: at 1280x720 the category row is not squashed and it fits within 12px of the top and bottom', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const { blockA } = await seedProject(page);
  await openChangePicker(page, blockA);

  const geometry = await page.evaluate(() => {
    const picker = document.querySelector<HTMLElement>('#block-change-picker')!.getBoundingClientRect();
    const filters = document.querySelector<HTMLElement>('.change-picker-filters')!.getBoundingClientRect();
    const grid = document.querySelector<HTMLElement>('.change-picker-grid')!.getBoundingClientRect();
    return {
      viewportHeight: window.innerHeight,
      pickerTop: picker.top,
      pickerBottom: picker.bottom,
      filtersHeight: filters.height,
      filtersBottom: filters.bottom,
      gridTop: grid.top,
    };
  });

  expect(geometry.pickerTop).toBeGreaterThanOrEqual(12);
  expect(geometry.pickerBottom).toBeLessThanOrEqual(geometry.viewportHeight - 12);
  expect(geometry.filtersHeight).toBeGreaterThanOrEqual(28);
  expect(geometry.filtersBottom).toBeLessThanOrEqual(geometry.gridTop + 1);
});

test('a picker opened after switching the language shows the category filters in the current language too', async ({ page }) => {
  const { blockA } = await seedProject(page);
  const filters = page.locator('#block-change-picker .change-picker-filters');
  const langToggle = page.locator('#sidebar-rail .rail-lang');

  // playwright.config.ts pins the startup language to JA
  await openChangePicker(page, blockA);
  await expect(filters).toContainText('石系');
  await expect(filters).toContainText('土・砂');
  await page.keyboard.press('Escape');

  // If it were burned in at the startup language it would not become English here (before the fix, only the categories stayed Japanese)
  await langToggle.click();
  await expect(langToggle).toHaveText('EN');
  await openChangePicker(page, blockA);
  await expect(filters).toContainText('Stone');
  await expect(filters).toContainText('Soil');
  await expect(filters).not.toContainText('石系');
  await page.keyboard.press('Escape');

  // Pin the way back as well (a one-way check would also pass for "re-evaluated only the first time")
  await langToggle.click();
  await expect(langToggle).toHaveText('JA');
  await openChangePicker(page, blockA);
  await expect(filters).toContainText('土・砂');
  await expect(filters).not.toContainText('Soil');
});
