import { expect, test, type Page } from '@playwright/test';

/**
 * The real wiring of repainting a selection (#64 PR-C).
 *
 * The semantics of replacement (narrowing by block type / carrying the orientation over / rebinding) belong to
 * `tests/replace-selection.test.ts`. What is verified here is
 * **that an inspector operation reaches the repaint of the selection scope**.
 */

/** Places a row of blocks on the ground */
async function placeRow(page: Page, cells: [number, number][]): Promise<void> {
  await page.keyboard.press('1'); // place tool
  for (const [x, z] of cells) {
    const pos = await page.evaluate(
      (c: [number, number]) => window.__bs.groundScreenPos(c[0], c[1]),
      [x, z] as [number, number],
    );
    await page.mouse.click(pos.x, pos.y);
  }
  await expect.poll(() => page.evaluate(() => window.__bs.world.size)).toBe(cells.length);
}

/** Selects world cells (they sit directly under root, so owner is null and local = world) */
async function selectCells(page: Page, cells: [number, number, number][]): Promise<void> {
  await page.evaluate((list) => {
    const entries = list.map(([x, y, z]) => {
      const ref = { ownerId: null, localCell: [x, y, z] as [number, number, number] };
      return [`-|${x},${y},${z}`, { ref, worldCell: [x, y, z] as [number, number, number] }] as const;
    });
    window.__bs.selection.set({ kind: 'cells', cells: new Map(entries) });
  }, cells);
}

/** Reads the catalogIndex (interpreting the packed representation is left to the __bs side, #96) */
async function blockAt(page: Page, x: number, y: number, z: number): Promise<number | null> {
  return page.evaluate(
    (c: [number, number, number]) => window.__bs.catalogIndexAt(c[0], c[1], c[2]),
    [x, y, z] as [number, number, number],
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
});

test('the repaint section appears in the inspector for a multi-selection', async ({ page }) => {
  await placeRow(page, [
    [0, 0],
    [1, 0],
  ]);
  await selectCells(page, [
    [0, 0, 0],
    [1, 0, 0],
  ]);

  await expect(page.locator('#inspector .inspector-repaint')).toBeVisible();
  await expect(page.locator('#inspector .inspector-repaint button')).toHaveCount(1); // solid-color mode, so only the block repaint
});

test('only the selected cells are repainted to the palette block', async ({ page }) => {
  await placeRow(page, [
    [0, 0],
    [1, 0],
    [2, 0],
  ]);
  const before = await blockAt(page, 0, 0, 0);

  // Change the selected block in the palette
  await page.evaluate(() => window.__bs.setActiveBlock(3));
  await selectCells(page, [
    [0, 0, 0],
    [1, 0, 0],
  ]);
  await page.locator('#inspector .inspector-repaint button').first().click();

  expect(await blockAt(page, 0, 0, 0)).toBe(3);
  expect(await blockAt(page, 1, 0, 0)).toBe(3);
  expect(await blockAt(page, 2, 0, 0), 'anything outside the selection is unchanged').toBe(before);
});

test('no narrowing control is shown when the selection has only one block type (it would be meaningless)', async ({ page }) => {
  await placeRow(page, [
    [0, 0],
    [1, 0],
  ]);
  await selectCells(page, [
    [0, 0, 0],
    [1, 0, 0],
  ]);
  await expect(page.locator('#inspector .inspector-repaint-scope')).toHaveCount(0);
});

test('for a mixed selection, the block types actually present can be narrowed down with their counts', async ({ page }) => {
  await page.evaluate(() => window.__bs.setActiveBlock(0));
  await placeRow(page, [[0, 0]]);
  await page.evaluate(() => window.__bs.setActiveBlock(3));
  const pos = await page.evaluate(() => window.__bs.groundScreenPos(1, 0));
  await page.mouse.click(pos.x, pos.y);
  await expect.poll(() => page.evaluate(() => window.__bs.world.size)).toBe(2);

  await selectCells(page, [
    [0, 0, 0],
    [1, 0, 0],
  ]);
  const scope = page.locator('#inspector .inspector-repaint-scope');
  await expect(scope).toBeVisible();
  await expect(scope.locator('option')).toHaveCount(3); // "all" + 2 block types

  // Repaint only the blocks with index 0 to index 5
  await scope.selectOption('0');
  await page.evaluate(() => window.__bs.setActiveBlock(5));
  await selectCells(page, [
    [0, 0, 0],
    [1, 0, 0],
  ]);
  await scope.selectOption('0');
  await page.locator('#inspector .inspector-repaint button').first().click();

  expect(await blockAt(page, 0, 0, 0)).toBe(5);
  expect(await blockAt(page, 1, 0, 0), 'a block type excluded by the narrowing is unchanged').toBe(3);
});

/**
 * #64 PR-C review: the inspector only subscribed to doc / selection / language, so
 * **switching the palette block while keeping a multi-selection did not re-render it**.
 * The label stayed on the old block name while a click applied the current activeBlock, which is inconsistent.
 */
test('the button follows along when the palette block changes while the selection is kept', async ({ page }) => {
  await placeRow(page, [
    [0, 0],
    [1, 0],
  ]);
  await selectCells(page, [
    [0, 0, 0],
    [1, 0, 0],
  ]);

  const button = page.locator('#inspector .inspector-repaint button[data-block]');
  await page.evaluate(() => window.__bs.setActiveBlock(3));
  await expect(button).toHaveAttribute('data-block', '3');

  await page.evaluate(() => window.__bs.setActiveBlock(5));
  await expect(button, 'the label follows even while the selection is kept').toHaveAttribute('data-block', '5');

  await button.click();
  expect(await blockAt(page, 0, 0, 0), 'the block that was displayed is the one applied').toBe(5);
});

test('the pattern-repaint button follows along when the active recipe is switched', async ({ page }) => {
  await page.evaluate(() => {
    window.__bs.recipeStore.replaceAll([
      { id: 'r1', name: 'mix A', entries: [{ blockId: window.__bs.CATALOG[3]!.id, weight: 1 }] },
      { id: 'r2', name: 'mix B', entries: [{ blockId: window.__bs.CATALOG[5]!.id, weight: 1 }] },
    ]);
  });
  await placeRow(page, [
    [0, 0],
    [1, 0],
  ]);
  await selectCells(page, [
    [0, 0, 0],
    [1, 0, 0],
  ]);

  const patternButton = page.locator('#inspector .inspector-repaint button[data-recipe]');
  await expect(patternButton, 'it is absent in solid-color mode').toHaveCount(0);

  await page.evaluate(() => window.__bs.setActiveRecipe('r1'));
  await expect(patternButton).toHaveAttribute('data-recipe', 'r1');

  await page.evaluate(() => window.__bs.setActiveRecipe('r2'));
  await expect(patternButton, 'it follows the recipe switch').toHaveAttribute('data-recipe', 'r2');

  await page.evaluate(() => window.__bs.setActiveRecipe(null));
  await expect(patternButton, 'it disappears when going back to solid color').toHaveCount(0);
});
