import { expect, test, type Page } from '@playwright/test';

/**
 * E2E protecting the "Space = pan only" implementation from PR #6.
 * Covers the fifth item of Issue #8 "the E2E tests to protect first" (Space pan + tool suppression).
 *
 * A review comment (2026-07-20) noted that dragging synchronously right after the Space keydown
 * has a track record of missing the one-frame target clear problem in camerakeys.ts,
 * so an explicit wait is inserted after keydown before operating.
 */

async function worldSize(page: Page): Promise<number> {
  return page.evaluate(() => window.__bs.world.size);
}

async function cameraPos(page: Page): Promise<{ x: number; y: number; z: number }> {
  return page.evaluate(() => {
    const p = window.__bs.ctx.camera.position;
    return { x: p.x, y: p.y, z: p.z };
  });
}

async function selectionKind(page: Page): Promise<string> {
  return page.evaluate(() => window.__bs.selection.get().kind);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
});

test('3D: holding Space + left drag pans, and the place tool does not fire', async ({ page }) => {
  await page.keyboard.press('1'); // place tool
  const before = await cameraPos(page);

  const box = (await page.locator('#viewport').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.keyboard.down(' ');
  await page.waitForTimeout(100); // review note: a synchronous drag right after keydown misses the one-frame problem, so wait
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 150, cy + 80, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up(' ');

  // The place tool did not fire (it yielded to the Space pan)
  expect(await worldSize(page)).toBe(0);

  // The camera moved (it panned)
  const after = await cameraPos(page);
  const moved = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
  expect(moved).toBeGreaterThan(0.01);
});

test('3D: holding Space + left drag yields to pan during the select tool too (the independent suppression path in selecttool.ts)', async ({ page }) => {
  // Verifies the guard on the selecttool.ts side, which is a different listener from the place-tool suppression (controls.ts).
  // Dragging on an existing voxel while still on the select tool would fire a marquee / selection drag without that guard
  const groundPos = await page.evaluate(() => window.__bs.groundScreenPos(2, 2));
  await page.keyboard.press('1'); // build a footing with the place tool
  await page.mouse.click(groundPos.x, groundPos.y);
  expect(await worldSize(page)).toBe(1);

  await page.keyboard.press('v'); // select tool
  expect(await selectionKind(page)).toBe('none');
  const cellPos = await page.evaluate(() => window.__bs.cellScreenPos(2, 0, 2));
  const before = await cameraPos(page);

  await page.keyboard.down(' ');
  await page.waitForTimeout(100);
  await page.mouse.move(cellPos.x, cellPos.y);
  await page.mouse.down();
  await page.mouse.move(cellPos.x + 150, cellPos.y + 80, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up(' ');

  // No selection, marquee, or selection drag fired
  expect(await selectionKind(page)).toBe('none');
  // The pan did happen
  const after = await cameraPos(page);
  const moved = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
  expect(moved).toBeGreaterThan(0.01);
});
