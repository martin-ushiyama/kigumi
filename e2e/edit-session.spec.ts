import { expect, test, type Page } from '@playwright/test';

/**
 * Integration test for "making edit transactions atomic + introducing EditSession".
 * Confirms that pointercancel / window blur / Escape during a stroke all converge on the same termination
 * (EditSession.cancel()) and that the world and undo history match their state before the stroke began.
 *
 * **Strokes are exercised with the erase tool**. The place tool became one click = one block, so it can no
 * longer walk the "touch several cells, then terminate" path. The point is to protect the EditSession contract
 * (one undo unit even across several cells / full restoration on cancel), so this moved to the erase side, where
 * continuous strokes remain. One click = one session on the place-tool side is covered by the dedicated test at the end.
 */

async function groundScreenPos(page: Page, x: number, z: number): Promise<{ x: number; y: number }> {
  return page.evaluate(({ x: gx, z: gz }) => window.__bs.groundScreenPos(gx, gz), { x, z });
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

/** Dispatches a real PointerEvent on the canvas (page.mouse is avoided for the same reason as core-scenarios.spec.ts) */
async function dispatchPointer(
  page: Page,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  x: number,
  y: number,
  opts: { buttons?: number } = {},
): Promise<void> {
  await page.evaluate(
    ({ type: t, x: px, y: py, buttons }) => {
      const canvas = document.getElementById('viewport')!;
      const ev = new PointerEvent(t, {
        clientX: px,
        clientY: py,
        button: 0,
        buttons: buttons ?? (t === 'pointerdown' || t === 'pointermove' ? 1 : 0),
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        bubbles: true,
        cancelable: true,
        detail: 1,
      });
      canvas.dispatchEvent(ev);
    },
    { type, x, y, buttons: opts.buttons },
  );
}

/** Begins a drag stroke (down → move, touching several cells) */
async function beginStroke(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 6): Promise<void> {
  await dispatchPointer(page, 'pointerdown', from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await dispatchPointer(page, 'pointermove', x, y);
  }
}

/**
 * Lays the groundwork for an erase stroke. Places a row by dragging with the box tool (3), then switches to erase (2).
 * These tests assume **at least two erasable blocks exist**, so that is verified here
 */
async function seedRow(page: Page, x0: number, x1: number, z: number): Promise<void> {
  const from = await groundScreenPos(page, x0, z);
  const to = await groundScreenPos(page, x1, z);
  await page.keyboard.press('3');
  await dispatchPointer(page, 'pointerdown', from.x, from.y);
  await dispatchPointer(page, 'pointermove', to.x, to.y);
  await dispatchPointer(page, 'pointerup', to.x, to.y);
  // A shape fill uses extrusion, so nothing is committed on release.
  // Clicking without changing the height places it flat (height 1)
  await dispatchPointer(page, 'pointerdown', to.x, to.y);
  await expect.poll(() => worldSize(page)).toBeGreaterThan(1);
  await page.keyboard.press('2');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
});

test('pointercancel during a stroke leaves both the world and the undo history matching the state before it', async ({ page }) => {
  await seedRow(page, 0, 3, 0);
  const from = await groundScreenPos(page, 0, 0);
  const to = await groundScreenPos(page, 3, 0);
  const baselineSize = await worldSize(page);
  const baselineUndo = await undoStackLength(page);

  await beginStroke(page, from, to);
  // Mid-drag it should already be reflected on screen (blocks erased, so the world shrank).
  // This also checks **that it shrank by at least two** — a single one would not exercise the stroke contract
  await expect.poll(() => worldSize(page)).toBeLessThan(baselineSize - 1);

  await dispatchPointer(page, 'pointercancel', to.x, to.y);

  await expect.poll(() => worldSize(page)).toBe(baselineSize); // restored to the state before it began
  await expect.poll(() => undoStackLength(page)).toBe(baselineUndo); // the undo history does not grow
  await expect.poll(() => worldGet(page, 0, 0, 0)).not.toBeNull();
});

test('window blur during a stroke converges on the same termination and restores the world and undo history', async ({ page }) => {
  await seedRow(page, 1, 4, 1);
  const from = await groundScreenPos(page, 1, 1);
  const to = await groundScreenPos(page, 4, 1);
  const baselineSize = await worldSize(page);
  const baselineUndo = await undoStackLength(page);

  await beginStroke(page, from, to);
  await expect.poll(() => worldSize(page)).toBeLessThan(baselineSize - 1);

  await page.evaluate(() => window.dispatchEvent(new Event('blur')));

  await expect.poll(() => worldSize(page)).toBe(baselineSize);
  await expect.poll(() => undoStackLength(page)).toBe(baselineUndo);
});

test('Escape during a stroke converges on the same termination and restores the world and undo history', async ({ page }) => {
  await seedRow(page, 2, 5, 2);
  const from = await groundScreenPos(page, 2, 2);
  const to = await groundScreenPos(page, 5, 2);
  const baselineSize = await worldSize(page);
  const baselineUndo = await undoStackLength(page);

  await beginStroke(page, from, to);
  await expect.poll(() => worldSize(page)).toBeLessThan(baselineSize - 1);

  await page.keyboard.press('Escape');

  await expect.poll(() => worldSize(page)).toBe(baselineSize);
  await expect.poll(() => undoStackLength(page)).toBe(baselineUndo);

  // After Escape, a normal pointerup does not double-commit because the stroke was already discarded
  await dispatchPointer(page, 'pointerup', to.x, to.y);
  await expect.poll(() => worldSize(page)).toBe(baselineSize);
});

test('a normal pointerup commits as a single undo unit (symmetric with the cancel path)', async ({ page }) => {
  await seedRow(page, -2, 1, -2);
  const from = await groundScreenPos(page, -2, -2);
  const to = await groundScreenPos(page, 1, -2);
  const baselineSize = await worldSize(page);
  const baselineUndo = await undoStackLength(page);

  await beginStroke(page, from, to);
  await expect.poll(() => worldSize(page)).toBeLessThan(baselineSize - 1);

  await dispatchPointer(page, 'pointerup', to.x, to.y);

  const committedSize = await worldSize(page);
  expect(committedSize).toBeLessThan(baselineSize - 1);
  await expect.poll(() => undoStackLength(page)).toBe(baselineUndo + 1); // erasing several cells is still one undo

  await page.keyboard.press('Control+z');
  await expect.poll(() => worldSize(page)).toBe(baselineSize); // a single undo brings all of it back
});

test('the default tool is select. A click right after opening places no block', async ({ page }) => {
  expect(await page.evaluate(() => window.__bs.state.tool)).toBe('select');

  const pos = await groundScreenPos(page, 7, 7);
  await page.mouse.click(pos.x, pos.y);
  await expect.poll(() => worldSize(page)).toBe(0);
});

test('the place tool stays one click = one block even when dragged', async ({ page }) => {
  await page.keyboard.press('1');
  const from = await groundScreenPos(page, 0, 6);
  const to = await groundScreenPos(page, 5, 6);

  await beginStroke(page, from, to);
  await expect.poll(() => worldSize(page)).toBe(1); // it does not paint along the drag either

  await dispatchPointer(page, 'pointerup', to.x, to.y);
  await expect.poll(() => worldSize(page)).toBe(1);
  await expect.poll(() => undoStackLength(page)).toBe(1); // one click = one undo unit

  // The erase tool still paints along the drag as before (only place changed)
  await page.keyboard.press('2');
  await beginStroke(page, from, to);
  await dispatchPointer(page, 'pointerup', to.x, to.y);
  await expect.poll(() => worldSize(page)).toBe(0);
});

test('pressing a tool-switch key during a place stroke does not turn it into erase', async ({ page }) => {
  // Put erasable blocks **on the line the stroke passes over** (x=2..5, z=8). If the tool switched to erase,
  // these would be wiped as the stroke sweeps across — putting them on another line would not exercise the path
  await seedRow(page, 2, 5, 8);
  await page.keyboard.press('1'); // place tool
  const baseline = await worldSize(page);

  const from = await groundScreenPos(page, 0, 8); // start from empty ground (one block is placed)
  const to = await groundScreenPos(page, 5, 8); // cross the existing row
  await beginStroke(page, from, to);

  await page.keyboard.press('2'); // switch to the erase tool mid-stroke
  await beginStroke(page, from, to, 4); // sweep some more
  await dispatchPointer(page, 'pointerup', to.x, to.y);

  // It stayed on place and only added one block. The row it swept across is not erased
  await expect.poll(() => worldSize(page)).toBe(baseline + 1);
  expect(await worldGet(page, 2, 0, 8)).not.toBeNull();
  expect(await worldGet(page, 5, 0, 8)).not.toBeNull();
});

test('pressing a tool-switch key during an erase stroke does not stop it partway', async ({ page }) => {
  await seedRow(page, 0, 5, 3); // a row with the box tool → switch to erase
  const baseline = await worldSize(page);

  const from = await groundScreenPos(page, 0, 3);
  const mid = await groundScreenPos(page, 2, 3);
  const to = await groundScreenPos(page, 5, 3);

  await beginStroke(page, from, mid, 3);
  await page.keyboard.press('1'); // switch to the place tool mid-stroke
  await beginStroke(page, mid, to, 4); // keep sweeping
  await dispatchPointer(page, 'pointerup', to.x, to.y);

  // Unaffected by the switch, everything swept over is erased
  await expect.poll(() => worldSize(page)).toBeLessThan(baseline - 2);
  expect(await worldGet(page, 5, 0, 3)).toBeNull();
});

test('once the gesture is over, tool-switch keys work normally again', async ({ page }) => {
  await page.keyboard.press('1');
  const pos = await groundScreenPos(page, 9, 9);
  await dispatchPointer(page, 'pointerdown', pos.x, pos.y);
  await dispatchPointer(page, 'pointerup', pos.x, pos.y);

  await page.keyboard.press('2');
  expect(await page.evaluate(() => window.__bs.state.tool)).toBe('erase');
  await page.keyboard.press('v');
  expect(await page.evaluate(() => window.__bs.state.tool)).toBe('select');
});
