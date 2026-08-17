import { expect, test, type Page } from '@playwright/test';

/**
 * Pins down the two regressions raised in the review (#24) of Issue #12 PR1
 * (unifying keyboard handling in InputRouter):
 * - With the select tool and nothing selected / mid-drag, arrow keys should fall back to camerakeys camera movement
 *   (the nudge entry in SHORTCUTS must not claim them exclusively)
 * - Delete/Backspace must not preventDefault when there is nothing to delete
 */

async function groundScreenPos(page: Page, x: number, z: number): Promise<{ x: number; y: number }> {
  return page.evaluate(({ x: gx, z: gz }) => window.__bs.groundScreenPos(gx, gz), { x, z });
}

async function cellScreenPos(page: Page, x: number, y: number, z: number): Promise<{ x: number; y: number }> {
  return page.evaluate(({ x: cx, y: cy, z: cz }) => window.__bs.cellScreenPos(cx, cy, cz), { x, y, z });
}

async function worldSize(page: Page): Promise<number> {
  return page.evaluate(() => window.__bs.world.size);
}

async function cameraPosition(page: Page): Promise<{ x: number; y: number; z: number }> {
  return page.evaluate(() => {
    const p = window.__bs.ctx.camera.position;
    return { x: p.x, y: p.y, z: p.z };
  });
}


async function selectionKind(page: Page): Promise<string> {
  return page.evaluate(() => window.__bs.selection.get().kind);
}

async function occupied(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window.__bs.world;
    const out: string[] = [];
    for (let x = -14; x <= 14; x++)
      for (let z = -14; z <= 14; z++) if (w.get(x, 0, z) !== null) out.push(`${x},${z}`);
    return out.sort();
  });
}

/** Dispatches a real PointerEvent on the canvas (CDP synthetic input arrives with detail=0) */
async function dispatchPointer(
  page: Page,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
  opts: { buttons?: number } = {},
): Promise<void> {
  await page.evaluate(
    ({ type: t, x: px, y: py, buttons: b }) => {
      document.getElementById('viewport')!.dispatchEvent(
        new PointerEvent(t, {
          clientX: px, clientY: py, button: 0,
          buttons: b ?? (t === 'pointerup' ? 0 : 1),
          pointerId: 1, pointerType: 'mouse', isPrimary: true,
          bubbles: true, cancelable: true, detail: 1,
        }),
      );
    },
    { type, x, y, buttons: opts.buttons },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
});

test('arrow keys move the camera when nothing is selected (the nudge entry does not claim them)', async ({ page }) => {
  await page.keyboard.press('v'); // switch to the select tool (nothing selected)
  const before = await cameraPosition(page);

  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(300); // room for the update() loop to run a few frames
  await page.keyboard.up('ArrowRight');

  const after = await cameraPosition(page);
  expect(after).not.toEqual(before);
});

test('with the select tool and a selection, arrow keys nudge and the camera does not move', async ({ page }) => {
  const pos = await groundScreenPos(page, 4, 4);
  await page.keyboard.press('1'); // place
  await page.mouse.click(pos.x, pos.y);
  await expect.poll(() => worldSize(page)).toBe(1);

  await page.keyboard.press('v'); // to the select tool
  const cellPos = await cellScreenPos(page, 4, 0, 4);
  await page.mouse.click(cellPos.x, cellPos.y); // click to select

  const sel = await page.evaluate(() => window.__bs.selection.get());
  expect(sel.kind).toBe('cells');

  const cameraBefore = await cameraPosition(page);
  await page.keyboard.press('ArrowRight');
  const cameraAfter = await cameraPosition(page);
  expect(cameraAfter).toEqual(cameraBefore); // the camera did not move (the nudge consumed it)

  // After the nudge it is no longer at the original coordinate (4,0,4) and exists exactly once somewhere else
  const cellsAfter = await page.evaluate(() => {
    const w = window.__bs.world;
    let count = 0;
    let stillAtOrigin = false;
    for (let x = -10; x <= 10; x++)
      for (let z = -10; z <= 10; z++) {
        if (w.get(x, 0, z) !== null) {
          count++;
          if (x === 4 && z === 4) stillAtOrigin = true;
        }
      }
    return { count, stillAtOrigin };
  });
  expect(cellsAfter.count).toBe(1);
  expect(cellsAfter.stillAtOrigin).toBe(false);
});

test('Delete with no selection breaks nothing and does not change the world (it does not preventDefault)', async ({ page }) => {
  await page.keyboard.press('v'); // select tool, nothing selected
  const before = await worldSize(page);
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  const after = await worldSize(page);
  expect(after).toBe(before);
});

test('Delete with a selection deletes the selection', async ({ page }) => {
  const pos = await groundScreenPos(page, 5, 5);
  await page.keyboard.press('1');
  await page.mouse.click(pos.x, pos.y);
  await expect.poll(() => worldSize(page)).toBe(1);

  await page.keyboard.press('v');
  const cellPos = await cellScreenPos(page, 5, 0, 5);
  await page.mouse.click(cellPos.x, cellPos.y);
  await expect(async () => {
    const sel = await page.evaluate(() => window.__bs.selection.get());
    expect(sel.kind).toBe('cells');
  }).toPass();

  await page.keyboard.press('Delete');
  await expect.poll(() => worldSize(page)).toBe(0);
});

test('even while still on the place tool, arrow keys nudge when there is a selection (#53)', async ({ page }) => {
  // Place one block with the place tool, then click the layer-panel row to select it while staying on that tool
  // (without switching to select = the state right after choosing from the layers panel)
  const pos = await groundScreenPos(page, 4, 4);
  await page.keyboard.press('1');
  await page.mouse.click(pos.x, pos.y);
  await expect.poll(() => worldSize(page)).toBe(1);

  await page.locator('#layers .layer-row-cell').first().click();
  const sel = await page.evaluate(() => window.__bs.selection.get());
  expect(sel.kind).toBe('cells');
  expect(await page.evaluate(() => window.__bs.state.tool)).toBe('place'); // the tool is still place

  const cameraBefore = await cameraPosition(page);
  await page.keyboard.press('ArrowRight');
  expect(await cameraPosition(page)).toEqual(cameraBefore); // the camera does not move

  // It was nudged, so it is no longer at the original coordinate
  const stillAtOrigin = await page.evaluate(() => window.__bs.world.get(4, 0, 4) !== null);
  expect(stillAtOrigin).toBe(false);
  await expect.poll(() => worldSize(page)).toBe(1);
});

test('arrow keys during a selection drag do not nudge and are passed to the camera (#53 review, third round)', async ({ page }) => {
  // Place one block, grab it with the select tool, and **stay mid-drag without releasing the button**
  const pos = await groundScreenPos(page, 4, 4);
  await page.keyboard.press('1');
  await page.mouse.click(pos.x, pos.y);
  await expect.poll(() => worldSize(page)).toBe(1);

  await page.keyboard.press('v');
  const cell = await cellScreenPos(page, 4, 0, 4);
  await page.mouse.click(cell.x, cell.y); // select first, then grab (grabbing with nothing selected starts a marquee)
  expect(await selectionKind(page)).toBe('cells');

  await dispatchPointer(page, 'pointerdown', cell.x, cell.y);
  await dispatchPointer(page, 'pointermove', cell.x + 120, cell.y);
  expect(await page.evaluate(() => window.__bs.selectTool.hasActiveDrag())).toBe(true);

  const cellsBefore = await occupied(page);
  const cameraBefore = await cameraPosition(page);

  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(300);
  await page.keyboard.up('ArrowRight');

  // No nudge runs (it would conflict with the drag)
  expect(await occupied(page)).toEqual(cellsBefore);
  // **And rather than nobody receiving it, the camera moves**
  expect(await cameraPosition(page)).not.toEqual(cameraBefore);

  await dispatchPointer(page, 'pointerup', cell.x + 120, cell.y, { buttons: 0 });
});
