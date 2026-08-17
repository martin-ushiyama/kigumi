import { expect, test, type Page } from '@playwright/test';

/**
 * Actually loads a v2 project (a format that has groups but no transform) and pins down that a group
 * can be rotated as-is right after migration (#37 B2).
 *
 * The unit tests (persistence-v3 / ops) separately check that "migration does not bake in a transform"
 * and that "the first rotation of an unset transform creates a pivot derived from the subtree bounds",
 * but only here can we guarantee that those two are **connected through the same execution path**. Every group in an
 * old file has an unset transform, so this is essentially the path the rotation UI actually touches.
 *
 * It also checks that pressing a rotation key during an in-flight drag does not fire a rotation (#41 review P1).
 */

const AUTOSAVE_KEY = 'blocksmith.project.autosave.v1';

/** Laid out in an L shape (asymmetric). With a symmetric shape the coordinate set would not change when rotated, and the test would detect nothing */
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

/** Dispatches a real PointerEvent on the canvas (CDP synthetic input arrives with detail=0, so this matches the other specs) */
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

/** Seeds a v2-format autosave and then reloads (using the very path restoreAutosave reads on startup) */
async function seedV2Project(page: Page): Promise<void> {
  const blockId = await page.evaluate(() => window.__bs.CATALOG[0]!.id);
  await page.evaluate(
    ({ key, id, cells }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          app: 'blocksmith',
          version: 2,
          name: 'a v2 work',
          // [x, y, z, blockId, orientationCode, groupIndex]; groupIndex 0 = groups[0]
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

test('a group loaded from a v2 project can be rotated with ] (the first rotation from an unset transform)', async ({ page }) => {
  await seedV2Project(page);

  const original = await occupiedCells(page);
  expect(original).toEqual(['0,0', '0,1', '1,0', '2,0']); // migration restores the world coordinates as-is

  const groupId = await selectFirstGroup(page);
  expect(await page.evaluate((id) => window.__bs.doc.tree.getNode(id)?.transform, groupId)).toBeUndefined();

  await page.keyboard.press('v'); // select tool
  await page.keyboard.press(']');

  // The first rotation creates the transform. The pivot comes from the subtree bounds (not the [0,0] placeholder)
  const transform = await page.evaluate((id) => window.__bs.doc.tree.getNode(id)?.transform, groupId);
  expect(transform?.angleSteps).toBe(3);
  expect(transform?.pivot2).toEqual([3, 1]);

  const rotated = await occupiedCells(page);
  expect(rotated).toHaveLength(4);
  expect(rotated).not.toEqual(original);

  // Three more turns return it to the original layout (it would not return if the pivot were re-derived on every rotation)
  for (let i = 0; i < 3; i++) await page.keyboard.press(']');
  expect(await occupiedCells(page)).toEqual(original);
  expect(await page.evaluate((id) => window.__bs.doc.tree.getNode(id)?.transform?.angleSteps, groupId)).toBe(0);

  // Undoing all four with Ctrl+Z returns the transform to unset (no identity is left baked in)
  for (let i = 0; i < 4; i++) await page.keyboard.press('Control+z');
  expect(await page.evaluate((id) => window.__bs.doc.tree.getNode(id)?.transform, groupId)).toBeUndefined();
  expect(await occupiedCells(page)).toEqual(original);
});

test('[ turns the other way (one ] equals three [)', async ({ page }) => {
  await seedV2Project(page);
  await selectFirstGroup(page);
  await page.keyboard.press('v');

  await page.keyboard.press(']');
  const clockwise = await occupiedCells(page);

  for (let i = 0; i < 4; i++) await page.keyboard.press('Control+z'); // return to the initial state to be safe (one real undo + extras are no-ops)
  expect(await occupiedCells(page)).toEqual(['0,0', '0,1', '1,0', '2,0']);

  for (let i = 0; i < 3; i++) await page.keyboard.press('[');
  expect(await occupiedCells(page)).toEqual(clockwise);
});


/**
 * A regression for #41 review P1. If a rotation key gets through during a ghost drag, only the rotation is committed,
 * the ghost's Document subscription becomes invalidated, and **the drag movement is silently discarded on pointerup**.
 * This pins down that no shortcut which mutates the model gets through during an in-flight gesture.
 */
test('rotation keys are refused during a group ghost drag, and the drag movement is committed as-is', async ({ page }) => {
  await seedV2Project(page);
  const groupId = await selectFirstGroup(page);
  await page.keyboard.press('v');

  const origin = await page.evaluate(() => window.__bs.cellScreenPos(0, 0, 0));
  await dispatchPointer(page, 'pointerdown', origin.x, origin.y);
  await dispatchPointer(page, 'pointermove', origin.x + 120, origin.y);
  expect(await page.evaluate(() => window.__bs.selectTool.hasActiveDrag())).toBe(true);

  const undoBefore = await page.evaluate(() => window.__bs.doc.undoStack.length);
  await page.keyboard.press(']');
  await page.keyboard.press('[');

  // Key input during a drag changes neither the transform nor the undo history
  expect(await page.evaluate((id) => window.__bs.doc.tree.getNode(id)?.transform, groupId)).toBeUndefined();
  expect(await page.evaluate(() => window.__bs.doc.undoStack.length)).toBe(undoBefore);
  expect(await occupiedCells(page)).toEqual(['0,0', '0,1', '1,0', '2,0']); // only the ghost is moving

  await dispatchPointer(page, 'pointerup', origin.x + 120, origin.y, 0);
  expect(await page.evaluate(() => window.__bs.selectTool.hasActiveDrag())).toBe(false);

  // The drag movement was not discarded and is committed as a single transaction (angleSteps stays 0)
  const after = await occupiedCells(page);
  expect(after).toHaveLength(4);
  expect(after).not.toEqual(['0,0', '0,1', '1,0', '2,0']);
  expect(await page.evaluate((id) => window.__bs.doc.tree.getNode(id)?.transform?.angleSteps, groupId)).toBe(0);
  expect(await page.evaluate(() => window.__bs.doc.undoStack.length)).toBe(undoBefore + 1);
});
