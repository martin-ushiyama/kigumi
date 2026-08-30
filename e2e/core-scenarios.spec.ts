import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

/**
 * The five scenarios of "the E2E tests to protect first".
 * To aim click coordinates at an arbitrary cell without depending on the camera's default position,
 * window.__bs.groundScreenPos/cellScreenPos (the E2E-only helpers in main.ts) are used.
 * - groundScreenPos(x,z): when clicking still-empty ground (y=0) to place something new
 * - cellScreenPos(x,y,z): when clicking a voxel that is already placed (projected at its center, y+0.5)
 */

async function groundScreenPos(page: Page, x: number, z: number): Promise<{ x: number; y: number }> {
  return page.evaluate(({ x: gx, z: gz }) => window.__bs.groundScreenPos(gx, gz), { x, z });
}

async function cellScreenPos(page: Page, x: number, y: number, z: number): Promise<{ x: number; y: number }> {
  return page.evaluate(({ x: cx, y: cy, z: cz }) => window.__bs.cellScreenPos(cx, cy, cz), { x, y, z });
}

async function worldGet(page: Page, x: number, y: number, z: number): Promise<number | null> {
  return page.evaluate(({ x: gx, y: gy, z: gz }) => window.__bs.world.get(gx, gy, gz), { x, y, z });
}

async function worldSize(page: Page): Promise<number> {
  return page.evaluate(() => window.__bs.world.size);
}

async function undoStackLength(page: Page): Promise<number> {
  return page.evaluate(() => window.__bs.doc.undoStack.length);
}

/** Finds the first of all currently placed cells (for cases where the coordinates cannot be decided up front) */
async function findAnyCell(page: Page): Promise<{ x: number; y: number; z: number } | null> {
  return page.evaluate(() => {
    const w = window.__bs.world;
    for (let x = -50; x <= 50; x++)
      for (let z = -50; z <= 50; z++) if (w.get(x, 0, z) !== null) return { x, y: 0, z };
    return null;
  });
}

/**
 * Dispatches a real PointerEvent on the canvas (page.mouse down/move cannot be used because with Chromium's CDP
 * synthetic input pointerdown.detail is always 0, which fails the "e.detail === 1 decides whether this is a single
 * click" check in selecttool.ts. A real event is fired from JS with detail specified explicitly).
 */
async function dispatchPointer(
  page: Page,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
  opts: { buttons?: number; detail?: number } = {},
): Promise<void> {
  await page.evaluate(
    ({ type: t, x: px, y: py, buttons, detail }) => {
      const canvas = document.getElementById('viewport')!;
      const ev = new PointerEvent(t, {
        clientX: px,
        clientY: py,
        button: 0,
        buttons: buttons ?? (t === 'pointerup' ? 0 : 1),
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        bubbles: true,
        cancelable: true,
        detail: detail ?? 1,
      });
      canvas.dispatchEvent(ev);
    },
    { type, x, y, buttons: opts.buttons, detail: opts.detail },
  );
}

/** Drags the selected cells from screen coordinates (from → to) with real events */
async function dragSelection(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 10): Promise<void> {
  await dispatchPointer(page, 'pointerdown', from.x, from.y, { detail: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await dispatchPointer(page, 'pointermove', x, y);
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
});

test('a click is a normal placement even while Shift is held (the Shift+click range was removed)', async ({ page }) => {
  const pos = await groundScreenPos(page, 6, 6);

  await page.keyboard.press('1'); // place tool
  await page.keyboard.down('Shift');
  await page.mouse.click(pos.x, pos.y);
  await page.keyboard.up('Shift');

  // It used to wait for the first point of a range and place nothing. Now it simply places one block
  await expect.poll(() => worldSize(page)).toBe(1);
  expect(await worldGet(page, 6, 0, 6)).not.toBeNull();
});

test('1. place → erase → undo/redo', async ({ page }) => {
  const pos = await groundScreenPos(page, 2, 2);

  await page.keyboard.press('1'); // place tool
  await page.mouse.click(pos.x, pos.y);
  await expect.poll(() => worldSize(page)).toBe(1);

  await page.keyboard.press('2'); // erase tool
  await page.mouse.click(pos.x, pos.y);
  await expect.poll(() => worldSize(page)).toBe(0);

  await page.keyboard.press('Control+z'); // undo the erase
  await expect.poll(() => worldSize(page)).toBe(1);

  await page.keyboard.press('Control+z'); // undo the placement
  await expect.poll(() => worldSize(page)).toBe(0);

  await page.keyboard.press('Control+Shift+z'); // redo the placement
  await expect.poll(() => worldSize(page)).toBe(1);

  await page.keyboard.press('Control+Shift+z'); // redo the erase
  await expect.poll(() => worldSize(page)).toBe(0);
});

test('2. selection drag → commit/cancel', async ({ page }) => {
  const groundPos = await groundScreenPos(page, 3, 3);

  await page.keyboard.press('1');
  await page.mouse.click(groundPos.x, groundPos.y);
  await expect.poll(() => worldSize(page)).toBe(1);
  const placed = await findAnyCell(page);
  expect(placed).not.toBeNull();
  const origin = await cellScreenPos(page, placed!.x, placed!.y, placed!.z);
  const baselineUndoLen = await undoStackLength(page);

  await page.keyboard.press('v'); // select tool
  await page.mouse.click(origin.x, origin.y); // click to select
  await expect.poll(() => page.evaluate(() => window.__bs.selection.get().kind)).toBe('cells');

  // pointerdown on the selected cell → move to drag → commit on pointerup
  await dragSelection(page, origin, { x: origin.x + 200, y: origin.y });
  await dispatchPointer(page, 'pointerup', origin.x + 200, origin.y, { buttons: 0 });

  // The original position is now empty (it moved somewhere = it was committed)
  await expect.poll(() => worldGet(page, placed!.x, placed!.y, placed!.z)).toBeNull();
  await expect.poll(() => undoStackLength(page)).toBe(baselineUndoLen + 1);
  await expect.poll(() => worldSize(page)).toBe(1); // it moved rather than disappeared

  // Start another drag at the new position → cancel with Escape mid-move
  const moved = await findAnyCell(page);
  expect(moved).not.toBeNull();
  const movedPos = await cellScreenPos(page, moved!.x, moved!.y, moved!.z);
  await page.mouse.click(movedPos.x, movedPos.y); // select again (the previous drag released the pointer capture)
  await dragSelection(page, movedPos, { x: movedPos.x + 200, y: movedPos.y });
  await page.keyboard.press('Escape');
  await dispatchPointer(page, 'pointerup', movedPos.x + 200, movedPos.y, { buttons: 0 });

  // It was cancelled, so the undo history does not grow and the position is back (still baseline+1)
  await expect.poll(() => undoStackLength(page)).toBe(baselineUndoLen + 1);
  await expect.poll(() => worldGet(page, moved!.x, moved!.y, moved!.z)).not.toBeNull();
});

test('3. group → hide → lock → multi-select', async ({ page }) => {
  const posA = await groundScreenPos(page, 4, 4);
  const posB = await groundScreenPos(page, 6, 4);
  const posC = await groundScreenPos(page, 8, 4);

  await page.keyboard.press('1');
  await page.mouse.click(posA.x, posA.y);
  await page.mouse.click(posB.x, posB.y);
  await page.mouse.click(posC.x, posC.y);
  await expect.poll(() => worldSize(page)).toBe(3);

  // Select A + B and group them
  await page.keyboard.press('v');
  await page.mouse.click(posA.x, posA.y);
  await page.keyboard.down('Control');
  await page.mouse.click(posB.x, posB.y);
  await page.keyboard.up('Control');
  await page.keyboard.press('Control+g');

  const groupRows = page.locator('[data-testid="layer-row-group"]');
  await expect(groupRows).toHaveCount(1);
  const groupId = await groupRows.first().getAttribute('data-group-id');
  expect(groupId).not.toBeNull();

  // Hide
  await groupRows.first().locator('[data-testid="layer-hide-btn"]').click();
  await expect.poll(() => page.evaluate((id) => window.__bs.doc.tree.getNode(id!)?.hidden, groupId)).toBe(true);
  await groupRows.first().locator('[data-testid="layer-hide-btn"]').click(); // restore it (so it does not affect what follows)

  // Lock
  await groupRows.first().locator('[data-testid="layer-lock-btn"]').click();
  await expect.poll(() => page.evaluate((id) => window.__bs.doc.tree.getNode(id!)?.locked, groupId)).toBe(true);
  // While locked it is excluded by selection sanitize (per the README spec), so unlock it for the multi-select test below
  await groupRows.first().locator('[data-testid="layer-lock-btn"]').click();
  await expect.poll(() => page.evaluate((id) => window.__bs.doc.tree.getNode(id!)?.locked, groupId)).toBe(false);

  // Group C on its own to create a second target for multi-select
  await page.mouse.click(posC.x, posC.y);
  await page.keyboard.press('Control+g');
  await expect(groupRows).toHaveCount(2);

  // Multi-select via Ctrl+click in the layers panel
  await groupRows.nth(0).click();
  await groupRows.nth(1).click({ modifiers: ['Control'] });
  const sel = await page.evaluate(() => window.__bs.selection.get());
  expect(sel.kind).toBe('groups');
  expect(sel.ids).toHaveLength(2);
});

test('4. save/load, and the existing work survives loading malformed JSON', async ({ page }) => {
  const pos = await groundScreenPos(page, 5, 5);
  await page.keyboard.press('1');
  await page.mouse.click(pos.x, pos.y);
  await expect.poll(() => worldSize(page)).toBe(1);
  const placed = await findAnyCell(page);
  expect(placed).not.toBeNull();

  // Save and grab the downloaded JSON from the always-visible backup action.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.document-save').click(),
  ]);
  const savedPath = await download.path();
  expect(savedPath).not.toBeNull();
  const savedJson = await readFile(savedPath, 'utf-8');
  expect(() => {
    JSON.parse(savedJson);
  }).not.toThrow();

  // Clear everything (auto-accept window.confirm)
  page.once('dialog', (d) => d.accept());
  await page.locator('.rail-logo').click();
  await page.locator('.document-file-menu button', { hasText: 'クリア' }).click();
  await expect.poll(() => worldSize(page)).toBe(0);

  // Load the saved JSON to restore it
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({ name: 'project.blocksmith.json', mimeType: 'application/json', buffer: Buffer.from(savedJson) });
  await expect.poll(() => worldSize(page)).toBe(1);
  await expect.poll(() => worldGet(page, placed!.x, placed!.y, placed!.z)).not.toBeNull();

  // Loading malformed JSON (unparseable) keeps the existing work intact
  await fileInput.setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{not valid json') });
  await expect(page.locator('#statusbar')).toContainText('読込失敗');
  await expect.poll(() => worldSize(page)).toBe(1); // the one existing block is still there
  await expect.poll(() => worldGet(page, placed!.x, placed!.y, placed!.z)).not.toBeNull();
});
