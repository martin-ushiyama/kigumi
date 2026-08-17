import { expect, test, type Page } from '@playwright/test';

/**
 * Pins down the overlay behavior of the box tool (key 3) (#46).
 *
 * A box **never overwrites existing blocks; it always stacks onto a new group**.
 * That behavior only holds on top of the "multiple refs can live at the same world coordinate" model (#37 B1b),
 * so it is verified through the real input path rather than in a unit test.
 */

async function groundScreenPos(page: Page, x: number, z: number): Promise<{ x: number; y: number }> {
  return page.evaluate(({ x: gx, z: gz }) => window.__bs.groundScreenPos(gx, gz), { x, z });
}

async function dispatchPointer(
  page: Page,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
  buttons?: number,
): Promise<void> {
  await page.evaluate(
    ({ type: t, x: px, y: py, buttons: b }) => {
      document.getElementById('viewport')!.dispatchEvent(
        new PointerEvent(t, {
          clientX: px,
          clientY: py,
          button: 0,
          buttons: b ?? (t === 'pointerup' ? 0 : 1),
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          bubbles: true,
          cancelable: true,
          detail: 1,
        }),
      );
    },
    { type, x, y, buttons },
  );
}

/** The number of cells an owner (null = unclassified) holds directly */
function cellCount(page: Page, owner: string | null): Promise<number> {
  return page.evaluate((o) => [...window.__bs.doc.scene.cells.entriesOf(o)].length, owner);
}

function rootGroups(page: Page): Promise<string[]> {
  return page.evaluate(() => [...window.__bs.doc.tree.childrenOf(null)]);
}

function worldSize(page: Page): Promise<number> {
  return page.evaluate(() => window.__bs.world.size);
}

/** Changes the palette selection (moves state.activeBlock directly, which getPaintBlock reads on commit) */
async function setActiveBlock(page: Page, catalogIndex: number): Promise<void> {
  await page.evaluate((i) => {
    window.__bs.state.activeBlock = i;
  }, catalogIndex);
}

/** Drags (x1,0,z) → (x2,0,z) with the box tool */
async function fillDrag(page: Page, x1: number, x2: number): Promise<void> {
  const from = await groundScreenPos(page, x1, 0);
  const to = await groundScreenPos(page, x2, 0);
  await page.keyboard.press('3');
  await dispatchPointer(page, 'pointerdown', from.x, from.y);
  await dispatchPointer(page, 'pointermove', to.x, to.y);
  await dispatchPointer(page, 'pointerup', to.x, to.y);
  // Extrusion (#78): releasing moves on to specifying the height. Click without moving to commit it flat
  await dispatchPointer(page, 'pointerdown', to.x, to.y);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
});

test('a box drag creates exactly one new group and puts every cell inside it (#46)', async ({ page }) => {
  expect(await rootGroups(page)).toEqual([]);

  await fillDrag(page, 0, 2);
  await expect.poll(() => worldSize(page)).toBe(3);

  const groups = await rootGroups(page);
  expect(groups).toHaveLength(1);
  expect(await cellCount(page, groups[0]!)).toBe(3);
  expect(await cellCount(page, null)).toBe(0); // nothing falls into unclassified
});

test('stacking over an existing block does not erase it; both survive under separate owners (#46)', async ({ page }) => {
  // First place one block in unclassified
  await page.keyboard.press('1');
  const pos = await groundScreenPos(page, 1, 0);
  await dispatchPointer(page, 'pointerdown', pos.x, pos.y);
  await dispatchPointer(page, 'pointerup', pos.x, pos.y);
  await expect.poll(() => cellCount(page, null)).toBe(1);

  // Sweep a box over a range that includes it
  await fillDrag(page, 0, 2);

  const groups = await rootGroups(page);
  expect(groups).toHaveLength(1);
  // The box places all 3 cells without punching a hole, and the original block is not erased either
  expect(await cellCount(page, groups[0]!)).toBe(3);
  expect(await cellCount(page, null)).toBe(1);
  // The count visible from the world stays 3 once the overlap is resolved
  await expect.poll(() => worldSize(page)).toBe(3);
});

test('a box disappears together with its group in a single undo (#46)', async ({ page }) => {
  await fillDrag(page, 0, 2);
  expect(await rootGroups(page)).toHaveLength(1);

  await page.keyboard.press('Control+z');
  expect(await rootGroups(page)).toEqual([]);
  await expect.poll(() => worldSize(page)).toBe(0);
});

test('at an overlapping coordinate the newer box becomes the winner, and undo reveals the one underneath again (#46)', async ({ page }) => {
  // Place one block of material A
  await setActiveBlock(page, 0);
  await page.keyboard.press('1');
  const pos = await groundScreenPos(page, 1, 0);
  await dispatchPointer(page, 'pointerdown', pos.x, pos.y);
  await dispatchPointer(page, 'pointerup', pos.x, pos.y);
  await expect.poll(() => cellCount(page, null)).toBe(1);

  const rawA = await page.evaluate(() => window.__bs.world.get(1, 0, 0));
  expect(rawA).not.toBeNull();

  // Sweep a box over a range that includes it, using material B
  await setActiveBlock(page, 1);
  await fillDrag(page, 0, 2);

  // What is visible at the overlapping coordinate is B (= the same raw value as a non-overlapping coordinate)
  const rawOverlap = await page.evaluate(() => window.__bs.world.get(1, 0, 0));
  const rawPureB = await page.evaluate(() => window.__bs.world.get(0, 0, 0));
  expect(rawOverlap).toBe(rawPureB);
  expect(rawOverlap).not.toBe(rawA);

  // Undo removes the whole box, and the A underneath becomes visible again
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => window.__bs.world.get(1, 0, 0))).toBe(rawA);
  await expect.poll(() => worldSize(page)).toBe(1);
  expect(await rootGroups(page)).toEqual([]);
});
