import { expect, test, type Page } from '@playwright/test';

/**
 * Pins down the key-binding wiring of mirroring (#63).
 *
 * The logic of `buildMirror` / `mirrorRaw` is covered by the unit tests, but
 * **whether Shift+X / Shift+Y / Shift+Z actually reach that op** depends on the matches predicate
 * in SHORTCUTS and on the router's execution order, and can only be observed here.
 *
 * camerakeys only excludes ctrl/meta/alt, so **Shift+Z has always been handled as raising the viewpoint**
 * (#65 review P1). The router does not fall through to camerakeys once something matches, so if
 * "only take it over when there is a selection" is not honored, Shift+Z with no selection becomes a dead key.
 * That boundary is pinned down here.
 *
 * It also checks that `Ctrl+Shift+Z` stays redo (it is not swallowed by mirror).
 */

const AUTOSAVE_KEY = 'blocksmith.project.autosave.v1';

/** An L shape (asymmetric). With a symmetric shape the coordinate set would not change when mirrored, and the test would detect nothing */
const L_SHAPE: [number, number, number][] = [
  [0, 0, 0],
  [1, 0, 0],
  [2, 0, 0],
  [0, 0, 1],
];

async function occupiedCells(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window.__bs.world;
    const out: string[] = [];
    for (let x = -12; x <= 12; x++)
      for (let z = -12; z <= 12; z++) if (w.get(x, 0, z) !== null) out.push(`${x},${z}`);
    return out.sort();
  });
}

async function seedProject(page: Page): Promise<void> {
  const blockId = await page.evaluate(() => window.__bs.CATALOG[0]!.id);
  await page.evaluate(
    ({ key, id, cells }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          app: 'blocksmith',
          version: 2,
          name: 'mirror test',
          blocks: cells.map(([x, y, z]) => [x, y, z, id, 0, 0]),
          groups: [{ name: 'wall', parent: -1 }],
          recipes: [],
        }),
      );
    },
    { key: AUTOSAVE_KEY, id: blockId, cells: L_SHAPE },
  );
  await page.reload();
  await expect(page.locator('#viewport')).toBeVisible();
}

async function selectFirstGroup(page: Page): Promise<string> {
  return page.evaluate(() => {
    const id = window.__bs.doc.tree.childrenOf(null)[0]!;
    window.__bs.selection.set({ kind: 'groups', ids: [id] });
    return id;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
});

test('Shift+X mirrors the selection on the X axis / two presses restore it', async ({ page }) => {
  await seedProject(page);
  const groupId = await selectFirstGroup(page);
  await page.keyboard.press('v'); // select tool

  const original = await occupiedCells(page);
  expect(original).toEqual(['0,0', '0,1', '1,0', '2,0']);

  await page.keyboard.press('Shift+X');
  const mirrored = await occupiedCells(page);
  // The bbox is x=0..2, so mirrorSum=2: x=0→2 / 1→1 / 2→0
  expect(mirrored).toEqual(['0,0', '2,0', '2,1', '1,0'].sort());

  // Mirroring does not touch the transform (it is expressed on the entity side, the design decision of #63)
  expect(await page.evaluate((id) => window.__bs.doc.tree.getNode(id)?.transform, groupId)).toBeUndefined();

  await page.keyboard.press('Shift+X');
  expect(await occupiedCells(page)).toEqual(original);
});

test('Shift+Z mirrors on the Z axis (with a selection); a bare z still raises the viewpoint', async ({ page }) => {
  await seedProject(page);
  await selectFirstGroup(page);
  await page.keyboard.press('v');

  const original = await occupiedCells(page);
  await page.keyboard.press('Shift+Z');
  const mirrored = await occupiedCells(page);
  // The bbox is z=0..1, so mirrorSum=1: z=0→1 / 1→0
  expect(mirrored).toEqual(['0,0', '1,1', '2,1', '0,1'].sort());

  await page.keyboard.press('Shift+Z');
  expect(await occupiedCells(page)).toEqual(original);

  // A bare z stays a camera operation (raise) = the model does not change
  const cameraYBefore = await page.evaluate(() => window.__bs.ctx.camera.position.y);
  await page.keyboard.down('z');
  await page.waitForTimeout(150);
  await page.keyboard.up('z');
  expect(await occupiedCells(page)).toEqual(original);
  expect(await page.evaluate(() => window.__bs.ctx.camera.position.y)).toBeGreaterThan(cameraYBefore);
});

test('Ctrl+Shift+Z stays redo (it is not swallowed by mirror)', async ({ page }) => {
  await seedProject(page);
  await selectFirstGroup(page);
  await page.keyboard.press('v');

  const original = await occupiedCells(page);
  await page.keyboard.press('Shift+X');
  const mirrored = await occupiedCells(page);
  expect(mirrored).not.toEqual(original);

  await page.keyboard.press('Control+z');
  expect(await occupiedCells(page)).toEqual(original);

  await page.keyboard.press('Control+Shift+Z');
  expect(await occupiedCells(page)).toEqual(mirrored); // the mirror was redone (not mirrored a second time)
});

test('with no selection Shift+Z is not taken over and falls through to the camera (#65 review P1)', async ({ page }) => {
  await seedProject(page);
  await page.keyboard.press('v'); // select tool, but select nothing
  await page.evaluate(() => window.__bs.selection.set({ kind: 'none' }));

  const original = await occupiedCells(page);
  const cameraYBefore = await page.evaluate(() => window.__bs.ctx.camera.position.y);

  // camerakeys accumulates a held key in update(dt), so drive it with down→wait→up
  await page.keyboard.down('Shift');
  await page.keyboard.down('z');
  await page.waitForTimeout(200);
  await page.keyboard.up('z');
  await page.keyboard.up('Shift');

  expect(await occupiedCells(page)).toEqual(original); // no mirror happened
  expect(await page.evaluate(() => window.__bs.ctx.camera.position.y)).toBeGreaterThan(cameraYBefore);
});

test('with a selection Shift+Z prefers the mirror (and does not move the camera)', async ({ page }) => {
  await seedProject(page);
  await selectFirstGroup(page);
  await page.keyboard.press('v');

  const original = await occupiedCells(page);
  const cameraYBefore = await page.evaluate(() => window.__bs.ctx.camera.position.y);

  await page.keyboard.down('Shift');
  await page.keyboard.down('z');
  await page.waitForTimeout(200);
  await page.keyboard.up('z');
  await page.keyboard.up('Shift');

  expect(await occupiedCells(page)).not.toEqual(original); // it mirrored
  expect(await page.evaluate(() => window.__bs.ctx.camera.position.y)).toBeCloseTo(cameraYBefore, 5);
});
