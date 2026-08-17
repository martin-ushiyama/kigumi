import { expect, test, type Page } from '@playwright/test';

/**
 * Toggling the outlines of void blocks on and off.
 *
 * **This looks at whether the lines actually disappear, not at the button state.** A void never becomes the winner
 * and is not drawn, so the outline is shown as a hint of where it is. The problem is those lines filling the screen,
 * so nothing is really fixed unless it is confirmed that they dropped out of the rendering.
 */

const AUTOSAVE_KEY = 'blocksmith.project.autosave.v1';
const UI_KEY = 'blocksmith.ui.v1';

/** Seeds a work containing void cells (places blocks and covers them with voids) */
async function seedVoid(page: Page): Promise<void> {
  const blockId = await page.evaluate(() => window.__bs.CATALOG[0]!.id);
  await page.evaluate(
    ({ autosave, ui, id }) => {
      localStorage.setItem(
        autosave,
        JSON.stringify({
          app: 'blocksmith',
          // **Seed as v3.** Loading v1 / v2 does not know about voids and silently drops them
          // as blocks missing from the catalog (voids are a v3-and-later concept)
          version: 3,
          name: 'void',
          groups: [{ name: 'target', parent: -1 }],
          // [ownerIndex(-1=root), x, y, z, blockId, orientationCode]
          cells: [
            [0, 0, 0, 0, id, 0],
            [0, 1, 0, 0, id, 0],
            [0, 0, 1, 0, 'blocksmith:void', 0],
            [0, 1, 1, 0, 'blocksmith:void', 0],
          ],
          recipes: [],
        }),
      );
      localStorage.removeItem(ui);
    },
    { autosave: AUTOSAVE_KEY, ui: UI_KEY, id: blockId },
  );
  await page.reload();
  await expect(page.locator('#viewport')).toBeVisible();
}

/** Whether the void outlines are actually being drawn (both three.js visibility and the draw range) */
function outlineDrawn(page: Page): Promise<{ visible: boolean; drawn: number }> {
  return page.evaluate(() => {
    let found = { visible: false, drawn: 0 };
    window.__bs.ctx.scene.traverse((o) => {
      const line = o as unknown as {
        type?: string;
        visible?: boolean;
        renderOrder?: number;
        geometry?: { drawRange?: { count: number } };
      };
      // The void outline is a LineSegments at renderOrder 5 (a different thing from block edges)
      if (line.type === 'LineSegments' && line.renderOrder === 5) {
        found = { visible: !!line.visible, drawn: line.geometry?.drawRange?.count ?? 0 };
      }
    });
    return found;
  });
}

const toggle = (page: Page) => page.locator('#world-controls .display-tools button').nth(2);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
  await seedVoid(page);
});

test('the void outlines are shown by default', async ({ page }) => {
  const state = await outlineDrawn(page);
  expect(state.visible, 'it is part of the rendering').toBe(true);
  expect(state.drawn, 'lines are being drawn').toBeGreaterThan(0);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
});

test('the toggle hides the outlines, and pressing it again brings them back', async ({ page }) => {
  await toggle(page).click();
  await expect.poll(async () => (await outlineDrawn(page)).visible).toBe(false);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');

  await toggle(page).click();
  await expect.poll(async () => (await outlineDrawn(page)).visible).toBe(true);
  // **Changes made while hidden are not carried over** — the old shape must not reappear when brought back
  expect((await outlineDrawn(page)).drawn).toBeGreaterThan(0);
});

test('the choice survives a reload', async ({ page }) => {
  await toggle(page).click();
  await expect.poll(async () => (await outlineDrawn(page)).visible).toBe(false);

  await page.reload();
  await expect(page.locator('#viewport')).toBeVisible();

  expect((await outlineDrawn(page)).visible, 'it is hidden right from startup').toBe(false);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
});

test('voids added while hidden are reflected once the outlines are brought back', async ({ page }) => {
  const before = (await outlineDrawn(page)).drawn;
  await toggle(page).click();
  await expect.poll(async () => (await outlineDrawn(page)).visible).toBe(false);

  // Add one more void while it is invisible. **The raw void value is borrowed from an existing cell** —
  // hard-coding the constant on the E2E side would make the test blind to a change in the representation
  await page.evaluate(() => {
    const doc = window.__bs.doc;
    const id = [...doc.tree.childrenOf(null)][0]!;
    const existing = [...doc.scene.cells.entriesOf(id)].find(([key]) => key === '0,1,0');
    if (!existing) throw new Error('the void cell this test assumes is missing');
    doc.applyTransaction({
      ops: [{ kind: 'voxel', owner: id, key: '2,1,0', before: null, after: existing[1] }],
    });
  });

  await toggle(page).click();
  await expect.poll(async () => (await outlineDrawn(page)).drawn).toBeGreaterThan(before);
});
