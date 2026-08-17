import { expect, test, type Page } from '@playwright/test';

/**
 * The axis gizmo (#148).
 *
 * Pins down that **the directions you read change as the viewpoint rotates**. The label positions and their
 * intensity are derived from the camera every frame, so getting the sign of the projection wrong turns into a
 * quiet lie like "it appears on the right but says −X".
 */

/** The label positions (px) relative to the center of the gizmo, and their intensity */
function labels(page: Page) {
  return page.evaluate(() => {
    const box = document.querySelector('.axis-gizmo')!.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    return [...document.querySelectorAll<HTMLElement>('.axis-gizmo-label')].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        label: el.textContent ?? '',
        x: Math.round(r.left + r.width / 2 - cx),
        y: Math.round(r.top + r.height / 2 - cy),
        opacity: Number(getComputedStyle(el).opacity),
      };
    });
  });
}

const at = (rows: Awaited<ReturnType<typeof labels>>, label: string) => rows.find((r) => r.label === label)!;

/**
 * Waits until the viewpoint has finished moving.
 *
 * The viewpoint presets move with inertia, and **the intensity carries a transition animation too**. Reading
 * mid-flight catches a value that is only correct at that instant, such as "looking straight down but one side is
 * faded". Two identical readings in a row are treated as settled
 */
async function waitForSettled(page: Page): Promise<void> {
  let previous = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await labels(page));
        const stable = now === previous;
        previous = now;
        return stable;
      },
      { timeout: 6000, intervals: [120] },
    )
    .toBe(true);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
  await expect(page.locator('.axis-gizmo')).toBeVisible();
});

test('height (Y) is not shown — it is always screen up/down and obvious without looking (#148)', async ({ page }) => {
  const rows = await labels(page);
  expect(rows.map((r) => r.label).sort()).toEqual(['+X', '+Z', '−X', '−Z']);
});

test('in the top view the four horizontal axes spread up, down, left, and right (#148)', async ({ page }) => {
  await page.keyboard.press('Shift+Digit7');
  await waitForSettled(page);

  const rows = await labels(page);
  // +X on the right, −X on the left (looking straight down, so there is no vertical offset)
  expect(at(rows, '+X').x).toBeGreaterThan(20);
  expect(at(rows, '−X').x).toBeLessThan(-20);
  // Z spreads along the vertical direction of the screen
  expect(Math.abs(at(rows, '+Z').x)).toBeLessThanOrEqual(2);
  expect(at(rows, '+Z').y).toBeGreaterThan(20);
  expect(at(rows, '−Z').y).toBeLessThan(-20);

  // **All of them are parallel to the screen, so none is faded** (cutting at 0 would fade all four).
  // The intensity can be caught mid-transition, so check with a margin that still distinguishes them (faded = 0.4)
  for (const row of rows) expect(row.opacity, `${row.label} is not faded`).toBeGreaterThan(0.9);
});

test('in the front view only the axis pointing away is faded (#148)', async ({ page }) => {
  await page.keyboard.press('Shift+Digit1');
  await waitForSettled(page);

  const rows = await labels(page);
  expect(at(rows, '−Z').opacity, 'the far side is faded').toBeLessThan(0.6);
  expect(at(rows, '+Z').opacity, 'the near side is solid').toBeGreaterThan(0.9);
  expect(at(rows, '+X').opacity, 'an axis parallel to the screen stays solid').toBeGreaterThan(0.9);
  expect(at(rows, '−X').opacity).toBeGreaterThan(0.9);
});

test('the labels follow when the viewpoint is rotated (#148)', async ({ page }) => {
  const before = at(await labels(page), '+X');

  await page.keyboard.press('Shift+Digit3'); // to the side view
  await waitForSettled(page);

  const after = at(await labels(page), '+X');
  expect({ x: after.x, y: after.y }).not.toEqual({ x: before.x, y: before.y });
});

test('the labels stay readable in dark mode (#148)', async ({ page }) => {
  await page.locator('#sidebar-rail .rail-theme').click();
  const contrast = await page.evaluate(() => {
    const lum = (c: string) => {
      const m = c.match(/[\d.]+/g)!;
      const [r, g, b] = m.slice(0, 3).map(Number).map((v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const el = document.querySelector<HTMLElement>('.axis-gizmo-label')!;
    const box = document.querySelector<HTMLElement>('.axis-gizmo')!;
    const l1 = lum(getComputedStyle(el).color);
    const l2 = lum(getComputedStyle(box).backgroundColor);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
});
