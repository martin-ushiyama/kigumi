import { expect, test, type Page } from '@playwright/test';

/**
 * The stacked swatches in the toolbar. They play the same role as Photoshop's foreground / background colors:
 * front = the block being placed now / back = the spare, swapped with `X`.
 *
 * The unit tests only check the state swap, but **"pressing it actually opens the picker, and only the side you
 * chose changes"** can only be walked through the real path.
 */

const ACTIVE = '#toolbar .block-swatch.active';
const SPARE = '#toolbar .block-swatch.spare';
const PICKER = '#block-change-picker';

function blockIdOf(page: Page, selector: string): Promise<string | undefined> {
  return page.locator(selector).evaluate((el) => (el as HTMLElement).dataset.blockId);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
});

test('both the front and the spare are filled from startup (the design never creates an "empty" spare)', async ({ page }) => {
  const active = await blockIdOf(page, ACTIVE);
  const spare = await blockIdOf(page, SPARE);

  expect(active).toBeTruthy();
  expect(spare).toBeTruthy();
  expect(active).not.toBe(spare);
});

test('the swap button is not hidden under the swatches and swaps them on click', async ({ page }) => {
  const before = { active: await blockIdOf(page, ACTIVE), spare: await blockIdOf(page, SPARE) };

  // An icon-only button becomes .bs-icon-button, not .bs-button. Writing the CSS against
  // .bs-button makes position have no effect at all, so it slips under the front swatch and
  // becomes unclickable (hit during implementation). Pin it down by **whether what sits at the center
  // is the element itself or one of its descendants**
  const onTop = await page.locator('#toolbar .block-swatch-swap').evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return el === hit || el.contains(hit);
  });
  expect(onTop).toBe(true);

  await page.locator('#toolbar .block-swatch-swap').click();

  await expect.poll(() => blockIdOf(page, ACTIVE)).toBe(before.spare);
  expect(await blockIdOf(page, SPARE)).toBe(before.active);
});

test('the X key swaps front and spare, and the palette selection follows along', async ({ page }) => {
  const before = { active: await blockIdOf(page, ACTIVE), spare: await blockIdOf(page, SPARE) };

  await page.keyboard.press('x');

  await expect.poll(() => blockIdOf(page, ACTIVE)).toBe(before.spare);
  expect(await blockIdOf(page, SPARE)).toBe(before.active);

  // Checks that it goes through setActiveBlock rather than a bare assignment (the path that resets the
  // orientation and drives history). If the "selected" label at the bottom of the palette caught up, it did
  const spareName = await page.locator(SPARE).evaluate((el) => (el as HTMLElement).title);
  await expect(page.locator('#palette .active-name')).not.toHaveText(spareName);

  // Check the way back too (a one-way check would also pass for an overwrite rather than a swap)
  await page.keyboard.press('x');
  expect(await blockIdOf(page, ACTIVE)).toBe(before.active);
  expect(await blockIdOf(page, SPARE)).toBe(before.spare);
});

test('Shift+X stays the selection mirror and does not swap', async ({ page }) => {
  const before = { active: await blockIdOf(page, ACTIVE), spare: await blockIdOf(page, SPARE) };

  await page.keyboard.press('Shift+x');

  expect(await blockIdOf(page, ACTIVE)).toBe(before.active);
  expect(await blockIdOf(page, SPARE)).toBe(before.spare);
});

test('the picker opened from the spare swatch shows no pattern tab, and choosing there does not move the front', async ({ page }) => {
  const activeBefore = await blockIdOf(page, ACTIVE);

  await page.locator(SPARE).click();
  await expect(page.locator(PICKER)).toBeVisible();

  // A swatch can only hold a single block, so the tab strip itself is not rendered
  await expect(page.locator(`${PICKER} [role="tablist"]`)).toHaveCount(0);
  // With no corresponding tab, it does not claim to be a tabpanel either
  await expect(page.locator(`${PICKER} .change-picker-panel`)).not.toHaveAttribute('role', 'tabpanel');

  const target = await page.evaluate(() => window.__bs.CATALOG.find((b) => b.id === 'minecraft:granite')?.id);
  await page.locator(`${PICKER} [data-block-id="${target}"]`).click();

  await expect.poll(() => blockIdOf(page, SPARE)).toBe(target);
  expect(await blockIdOf(page, ACTIVE)).toBe(activeBefore);
});

test('the picker opened from the block usage panel still shows tabs as before (a regression for sharing the picker)', async ({ page }) => {
  await page.keyboard.press('1');
  const pos = await page.evaluate(() => window.__bs.groundScreenPos(5, 5));
  await page.mouse.click(pos.x, pos.y);
  await expect.poll(() => page.evaluate(() => window.__bs.world.size)).toBe(1);

  await page.locator('#block-usage [data-testid="usage-change"]').first().click();
  await expect(page.locator(PICKER)).toBeVisible();
  await expect(page.locator(`${PICKER} [role="tab"]`)).toHaveCount(2);
});
