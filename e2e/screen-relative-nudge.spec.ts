import { expect, test, type Page } from '@playwright/test';

/**
 * Arrow-key movement is relative to **the view currently on screen**.
 *
 * The pure axis rounding is covered by the unit tests. What matters here is **whether pressing a key actually
 * moves the selection in the pressed direction on screen** — confirmed by projecting into screen coordinates.
 * Correct axis math is meaningless if the key wiring or a preventDefault sends it down another path.
 */

const AUTOSAVE_KEY = 'blocksmith.project.autosave.v1';

/** Seeds a group with a single block and leaves it selected */
async function seedSelectedBlock(page: Page): Promise<void> {
  const blockId = await page.evaluate(() => window.__bs.CATALOG[0]!.id);
  await page.evaluate(
    ({ key, id }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          app: 'blocksmith',
          version: 2,
          name: 'nudge',
          blocks: [[0, 0, 0, id, 0, 0]],
          groups: [{ name: 'target', parent: -1 }],
          recipes: [],
        }),
      );
    },
    { key: AUTOSAVE_KEY, id: blockId },
  );
  await page.reload();
  await expect(page.locator('#viewport')).toBeVisible();
  await page.evaluate(() => {
    const ids = [...window.__bs.doc.tree.childrenOf(null)];
    window.__bs.selection.set({ kind: 'groups', ids: [ids[0]!] });
  });
}

/** The current position of the selected group, how it appears on screen, and its distance from the camera */
function probe(page: Page) {
  return page.evaluate(() => {
    const id = [...window.__bs.doc.tree.childrenOf(null)][0]!;
    const t = window.__bs.doc.tree.getNode(id)?.transform?.translate ?? [0, 0, 0];
    const [tx, ty, tz] = [t[0] ?? 0, t[1] ?? 0, t[2] ?? 0];
    const cam = window.__bs.ctx.camera.position;
    return {
      translate: [tx, ty, tz] as [number, number, number],
      screen: window.__bs.cellScreenPos(tx, ty, tz),
      // "near / far" is judged by the distance from the camera. That keeps one yardstick even for viewpoints
      // like the front view, where depth does not show up as screen up/down
      distance: Math.hypot(cam.x - tx, cam.y - ty, cam.z - tz),
    };
  });
}

/** Waits until the viewpoint settles (the presets move with inertia) */
async function waitForSettled(page: Page): Promise<void> {
  let previous = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify((await probe(page)).screen);
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
  await seedSelectedBlock(page);
});

/** For each viewpoint preset, whether the four directions move as expected on screen */
const VIEWS = [
  { name: 'the default angled view', key: null },
  { name: 'the top view', key: 'Shift+Digit7' },
  { name: 'the front view', key: 'Shift+Digit1' },
  { name: 'the side view', key: 'Shift+Digit3' },
] as const;

for (const view of VIEWS) {
  test(`${view.name}: → moves right on screen and ↑ moves away from the viewer`, async ({ page }) => {
    if (view.key) await page.keyboard.press(view.key);
    await waitForSettled(page);

    const before = await probe(page);

    await page.keyboard.press('ArrowRight');
    expect((await probe(page)).screen.x, '→ goes right on screen').toBeGreaterThan(before.screen.x);
    await page.keyboard.press('ArrowLeft');

    // **"away" is not measured by screen up/down.** Some viewpoints, such as the front view, do not express
    // depth as screen up/down, so this checks whether it moved further from the camera
    await page.keyboard.press('ArrowUp');
    expect((await probe(page)).distance, '↑ moves away from the camera').toBeGreaterThan(before.distance);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect((await probe(page)).distance, '↓ moves toward the camera').toBeLessThan(before.distance);
  });
}

test('height stays screen up/down regardless of the viewpoint', async ({ page }) => {
  await waitForSettled(page);
  const before = await probe(page);
  await page.keyboard.press('PageUp');
  const after = await probe(page);
  expect(after.screen.y, 'PageUp goes up on screen').toBeLessThan(before.screen.y);
  expect(after.translate[1], 'the height goes up by 1').toBe(before.translate[1] + 1);
});

test('rotating the viewpoint makes the same key land on a different axis', async ({ page }) => {
  await page.keyboard.press('Shift+Digit1'); // front
  await waitForSettled(page);
  const beforeFront = (await probe(page)).translate;
  await page.keyboard.press('ArrowRight');
  const afterFront = (await probe(page)).translate;

  await page.keyboard.press('Shift+Digit3'); // side
  await waitForSettled(page);
  const beforeSide = (await probe(page)).translate;
  await page.keyboard.press('ArrowRight');
  const afterSide = (await probe(page)).translate;

  // In the front view X moves, in the side view Z moves — the same key lands somewhere else depending on the view
  expect(afterFront[0] - beforeFront[0], 'X moves in the front view').not.toBe(0);
  expect(afterFront[2] - beforeFront[2]).toBe(0);
  expect(afterSide[2] - beforeSide[2], 'Z moves in the side view').not.toBe(0);
  expect(afterSide[0] - beforeSide[0]).toBe(0);
});
