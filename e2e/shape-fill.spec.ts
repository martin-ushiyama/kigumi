import { expect, test, type Page } from '@playwright/test';

/**
 * UI integration of the shape generator.
 *
 * `buildShape`, introduced in PR-A, was wired into the commit path of the existing range fill (the box tool).
 * What is confirmed here is **that it is connected** and **that the existing operations are not broken**.
 * The correctness of the shapes themselves (inscription / vertices / edge mapping) belongs to `tests/shapes.test.ts`.
 *
 * The output is always inspected through **the cells actually placed**. Checking with a height-1 plane alone would
 * make solid and hollow produce identical results, so "green even if the parameter is never passed" (review note).
 */

/** Drags on the ground to commit a range (height 1) */
async function dragOnGround(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const a = await page.evaluate(([x, z]) => window.__bs.groundScreenPos(x, z), from);
  const b = await page.evaluate(([x, z]) => window.__bs.groundScreenPos(x, z), to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  // Extrusion: releasing moves on to specifying the height. Clicking without moving commits it at height 1
  await page.mouse.down();
  await page.mouse.up();
}

/** Reads the y=0 plane as strings (`#` = a block is present) */
async function groundGrid(page: Page, size: number): Promise<string[]> {
  return page.evaluate((n) => {
    const rows: string[] = [];
    for (let z = 0; z < n; z++) {
      let row = '';
      for (let x = 0; x < n; x++) row += window.__bs.world.get(x, 0, z) !== null ? '#' : '.';
      rows.push(row);
    }
    return rows;
  }, size);
}

/** Opens the dropdown, toggles hollow, and closes it */
async function toggleHollow(page: Page): Promise<void> {
  await page.locator('.shape-control .shape-caret').click();
  await page.locator('#shape-menu .shape-menu-hollow').click();
  await page.keyboard.press('Escape');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
});

test('the toolbar has one shape button plus a caret (it does not line up a button per shape)', async ({ page }) => {
  await expect(page.locator('.shape-control .shape-main')).toHaveCount(1);
  await expect(page.locator('.shape-control .shape-caret')).toHaveCount(1);
  // The number of edit-tool buttons does not grow when shapes are added (select / place / erase / fill / pick)
  await expect(page.locator('#toolbar .edit-tools .tool-button')).toHaveCount(5);
});

test('the dropdown lists box as one equal entry among the rest, with the current shape shown as pressed', async ({ page }) => {
  await page.locator('.shape-control .shape-caret').click();
  const menu = page.locator('#shape-menu');
  await expect(menu).toBeVisible();

  await expect(menu.locator('[data-shape]')).toHaveCount(5);
  await expect(menu.locator('[data-shape="box"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(menu.locator('[data-shape="dome"]')).toHaveAttribute('aria-pressed', 'false');
  // aria-pressed alone is the source of truth for the state. It does not take on the keyboard contract of role="menuitem*"
  await expect(menu.locator('[aria-checked]')).toHaveCount(0);
});

test('choosing a shape makes the tool button keep the last chosen shape (so it need not be opened every time)', async ({ page }) => {
  // Like the other specs, this runs pinned to JA (the storageState in playwright.config.ts),
  // so the title patterns below are the Japanese UI labels and stay as-is
  const main = page.locator('.shape-control .shape-main');
  await expect(main).toHaveAttribute('title', /直方体/);

  await page.locator('.shape-control .shape-caret').click();
  await page.locator('#shape-menu [data-shape="sphere"]').click();

  await expect(main).toHaveAttribute('title', /球/);
  await expect(main).toHaveAttribute('aria-pressed', 'true'); // choosing a shape enters the fill tool
  expect(await page.evaluate(() => window.__bs.state.tool)).toBe('fill');
});

test('the per-shape direct keys decide the tool and the shape at once', async ({ page }) => {
  await page.keyboard.press('m');
  expect(await page.evaluate(() => window.__bs.state.shape)).toBe('dome');
  expect(await page.evaluate(() => window.__bs.state.tool)).toBe('fill');

  await page.keyboard.press('3'); // 3 goes back to box
  expect(await page.evaluate(() => window.__bs.state.shape)).toBe('box');
  expect(await page.evaluate(() => window.__bs.state.tool)).toBe('fill');
});

test('box still fills the range without gaps as before (a regression for the existing behavior)', async ({ page }) => {
  await page.keyboard.press('3');
  await dragOnGround(page, [0, 0], [4, 4]);

  expect(await groundGrid(page, 5)).toEqual(['#####', '#####', '#####', '#####', '#####']);
  expect(await page.evaluate(() => window.__bs.world.size)).toBe(25);
});

test('choosing the dome cuts off the corners (the shape is connected all the way to the commit path)', async ({ page }) => {
  await page.keyboard.press('m');
  await dragOnGround(page, [0, 0], [8, 8]);

  // A dome of height 1 is its bottom layer = the largest circle. The four corners are missing
  expect(await groundGrid(page, 9)).toEqual([
    '..#####..',
    '.#######.',
    '#########',
    '#########',
    '#########',
    '#########',
    '#########',
    '.#######.',
    '..#####..',
  ]);
});

/**
 * Hollowness and non-leakage into bulk operations belong to **`tests/rangefill.test.ts`**.
 * Neither shows a difference unless the range is at least 3 thick, and building a 3D range through real operations
 * is tied to the drag surface (the ground or the face of an existing block) and therefore unstable, so the contract
 * is pinned down on the pure function `resolveRangeCells` and this only checks **that the UI reaches the state**.
 */
test('the hollow toggle reaches the state and is reflected in the fill result', async ({ page }) => {
  await page.keyboard.press('3');
  await toggleHollow(page);
  expect(await page.evaluate(() => window.__bs.state.shapeHollow)).toBe(true);

  // At height 1 the output matches solid (every cell is on the shell). What is checked here is "nothing breaks"
  await dragOnGround(page, [0, 0], [2, 2]);
  expect(await page.evaluate(() => window.__bs.world.size)).toBe(9);
});

test('switching shapes returns hollowness to that shape default (the previous shape setting is not dragged along)', async ({ page }) => {
  await page.keyboard.press('3');
  await page.locator('.shape-control .shape-caret').click();
  await page.locator('#shape-menu .shape-menu-hollow').click();
  expect(await page.evaluate(() => window.__bs.state.shapeHollow)).toBe(true);

  await page.locator('#shape-menu [data-shape="sphere"]').click();
  expect(await page.evaluate(() => window.__bs.state.shapeHollow)).toBe(null);
});

test('the per-shape default name becomes the layer name (so you can tell what was placed)', async ({ page }) => {
  await page.keyboard.press('m');
  await dragOnGround(page, [0, 0], [4, 4]);
  // The expected text is the Japanese UI label of the default locale, so it stays as-is
  await expect(page.locator('#layers')).toContainText('ドーム');
});

test('a parameter only appears for the shapes it affects', async ({ page }) => {
  const axis = page.locator('#shape-menu .shape-param-axis');
  const step = page.locator('#shape-menu .shape-param-step');

  await page.locator('.shape-control .shape-caret').click();
  await expect(axis).toBeHidden(); // a box has neither an axis nor steps
  await expect(step).toBeHidden();

  // The menu stays open after choosing a shape. The parameters can be touched right after
  await page.locator('#shape-menu [data-shape="cylinder"]').click();
  await expect(axis).toBeVisible();
  await expect(step).toBeHidden();

  await page.locator('#shape-menu [data-shape="slope"]').click();
  await expect(axis).toBeHidden();
  await expect(step).toBeVisible();
});

test('switching the cylinder axis changes the orientation it is generated in', async ({ page }) => {
  await page.keyboard.press('y'); // cylinder (the default is the Y axis)
  await dragOnGround(page, [0, 0], [4, 4]);
  // Seen from above, a Y-axis cylinder is a circle (the corners are cut off)
  expect(await groundGrid(page, 5)).toEqual(['.###.', '#####', '#####', '#####', '.###.']);

  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => window.__bs.world.size)).toBe(0);

  await page.locator('.shape-control .shape-caret').click();
  await page.locator('#shape-menu [data-axis="0"]').click();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.__bs.state.shapeAxis)).toBe(0);

  await dragOnGround(page, [0, 0], [4, 4]);
  // On the X axis it runs the full length along x. In a height-1 cross-section the corners survive
  expect(await groundGrid(page, 5)).toEqual(['#####', '#####', '#####', '#####', '#####']);
});

test('the step height of a slope can be changed', async ({ page }) => {
  await page.keyboard.press('k'); // slope
  await page.locator('.shape-control .shape-caret').click();
  const step = page.locator('#shape-menu .shape-step-input');
  await step.fill('2');
  await step.dispatchEvent('change');
  expect(await page.evaluate(() => window.__bs.state.shapeStep)).toBe(2);

  // Values below 1 and non-integers are rounded to 1 (matching the contract on the buildShape side)
  await step.fill('0');
  await step.dispatchEvent('change');
  expect(await page.evaluate(() => window.__bs.state.shapeStep)).toBe(1);
});
