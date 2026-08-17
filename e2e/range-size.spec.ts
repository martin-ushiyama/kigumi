import { expect, test, type Page } from '@playwright/test';

/**
 * The dimension readout during a range operation (#83).
 *
 * The counting itself (inclusive of both ends / cell count / upper limit) belongs to `tests/rangesize.test.ts`.
 * What is checked here is **when it appears**: only during an operation, and gone once committed.
 * Showing it permanently would leave a meaningless number sitting there while nothing is happening.
 */

const STATUS = '#statusbar';

async function groundPos(page: Page, x: number, z: number): Promise<{ x: number; y: number }> {
  // Use an explicit tuple. A plain array becomes number | undefined under noUncheckedIndexedAccess
  return page.evaluate(([gx, gz]) => window.__bs.groundScreenPos(gx, gz), [x, z] as [number, number]);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
  // The default is the place tool. A range operation (plane → extrusion) only happens with the fill tool
  await page.locator('.shape-control .shape-main').click();
});

test('while nothing is being operated, no dimensions are shown and the usage hint is shown instead', async ({ page }) => {
  await expect(page.locator(STATUS)).not.toContainText('×');
  await expect(page.locator(STATUS)).toContainText('WASD');
});

test('during an operation the hint is withdrawn and swapped for the dimensions (the row does not grow)', async ({ page }) => {
  const a = await groundPos(page, 2, 2);
  const b = await groundPos(page, 5, 5);

  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 });

  await expect(page.locator(STATUS)).toContainText('×');
  await expect(page.locator(STATUS)).not.toContainText('WASD');

  await page.mouse.up();
  await page.keyboard.press('Escape');
  await expect(page.locator(STATUS)).toContainText('WASD');
});

test('X × 1 × Z is shown while dragging the plane', async ({ page }) => {
  const a = await groundPos(page, 2, 2);
  const b = await groundPos(page, 6, 4);

  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 });

  // 2..6 = 5 blocks, 2..4 = 3 blocks. The height is not decided yet, so it is 1
  await expect(page.locator(STATUS)).toContainText('5 × 1 × 3 = 15');

  await page.mouse.up();
  await page.mouse.down();
  await page.mouse.up(); // commit while still at height 1
});

test('only Y changes during the extrusion', async ({ page }) => {
  const a = await groundPos(page, 2, 2);
  const b = await groundPos(page, 4, 4);

  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await expect(page.locator(STATUS)).toContainText('3 × 1 × 3');
  await page.mouse.up();

  // Releasing moves to the height stage. Moving up grows Y while X and Z stay put
  await page.mouse.move(b.x, b.y - 120, { steps: 6 });
  const text = await page.locator(STATUS).textContent();
  expect(text).toMatch(/3 × \d+ × 3/);
  expect(text).not.toContain('3 × 1 × 3'); // the height has changed

  await page.mouse.down();
  await page.mouse.up();
});

test('it disappears once committed', async ({ page }) => {
  const a = await groundPos(page, 2, 2);
  const b = await groundPos(page, 4, 4);

  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await expect(page.locator(STATUS)).toContainText('×');
  await page.mouse.up();
  await page.mouse.down();
  await page.mouse.up();

  await expect(page.locator(STATUS)).not.toContainText('×');
});

/**
 * Right after committing, the completion toast takes over the status bar, so looking only at that moment makes it
 * seem like the dimensions are gone. This also confirms they do not come back after the toast withdraws
 * (#83 review: on the Shift+click path, since removed, the old dimensions reappeared about 2.5 seconds later).
 */
test('after committing, the dimensions do not come back once the toast disappears', async ({ page }) => {
  const a = await groundPos(page, 2, 2);
  const b = await groundPos(page, 4, 4);

  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await expect(page.locator(STATUS)).toContainText('3 × 1 × 3');
  await page.mouse.up();
  await page.mouse.down();
  await page.mouse.up();

  // Wait not for the toast to be up, but for it to withdraw and the normal display (the usage hint) to return.
  // Once the hint is back the toast is gone = leftover dimensions would be visible here
  await expect(page.locator(STATUS)).toContainText('WASD', { timeout: 8000 });
  await expect(page.locator(STATUS)).not.toContainText('×');
});

test('it also disappears when aborted with Escape', async ({ page }) => {
  const a = await groundPos(page, 2, 2);
  const b = await groundPos(page, 5, 5);

  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await expect(page.locator(STATUS)).toContainText('×');

  await page.mouse.up();
  await page.keyboard.press('Escape');

  await expect(page.locator(STATUS)).not.toContainText('×');
});
