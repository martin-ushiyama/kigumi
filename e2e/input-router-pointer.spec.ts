import { expect, test, type Page } from '@playwright/test';

/**
 * Regression check for Issue #12 PR2 (unifying pointer handling in InputRouter).
 * Confirms that a Fill tool drag through controls.ts (the edit-tools route) still produces the same result
 * after being turned into a handler.
 */

async function groundScreenPos(page: Page, x: number, z: number): Promise<{ x: number; y: number }> {
  return page.evaluate(({ x: gx, z: gz }) => window.__bs.groundScreenPos(gx, gz), { x, z });
}

async function worldSize(page: Page): Promise<number> {
  return page.evaluate(() => window.__bs.world.size);
}

async function selectionKind(page: Page): Promise<string> {
  return page.evaluate(() => window.__bs.selection.get().kind);
}

/** Dispatches a real PointerEvent on the canvas (same reason as core-scenarios.spec.ts: CDP synthetic input arrives with detail=0) */
async function dispatchPointer(
  page: Page,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  x: number,
  y: number,
  opts: { button?: number; buttons?: number; detail?: number; shiftKey?: boolean } = {},
): Promise<void> {
  await page.evaluate(
    ({ type: t, x: px, y: py, button, buttons, detail, shiftKey }) => {
      const canvas = document.getElementById('viewport')!;
      const ev = new PointerEvent(t, {
        clientX: px,
        clientY: py,
        button: button ?? 0,
        buttons: buttons ?? (t === 'pointerup' ? 0 : 1),
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        bubbles: true,
        cancelable: true,
        detail: detail ?? 1,
        shiftKey: shiftKey ?? false,
      });
      canvas.dispatchEvent(ev);
    },
    { type, x, y, button: opts.button, buttons: opts.buttons, detail: opts.detail, shiftKey: opts.shiftKey },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
});

test('a Fill tool drag commits the range (claim onMove → onUp commit)', async ({ page }) => {
  const from = await groundScreenPos(page, 0, 0);
  const to = await groundScreenPos(page, 2, 0);

  await page.keyboard.press('3'); // Fill tool
  await dispatchPointer(page, 'pointerdown', from.x, from.y);
  await dispatchPointer(page, 'pointermove', to.x, to.y);
  await dispatchPointer(page, 'pointerup', to.x, to.y);
  // Extrusion (#78): nothing is committed on release. Click without changing the height to commit
  await dispatchPointer(page, 'pointerdown', to.x, to.y);

  // The 3 cells from 0,0 to 2,0 are placed (a box at y=0, 3 wide × 1 high × 1 deep)
  await expect.poll(() => worldSize(page)).toBe(3);
});

test('pressing Escape during a Fill tool drag places nothing (claim.onCancel)', async ({ page }) => {
  const from = await groundScreenPos(page, 5, 0);
  const to = await groundScreenPos(page, 7, 0);

  await page.keyboard.press('3');
  await dispatchPointer(page, 'pointerdown', from.x, from.y);
  await dispatchPointer(page, 'pointermove', to.x, to.y);
  await page.keyboard.press('Escape');
  await dispatchPointer(page, 'pointerup', to.x, to.y, { buttons: 0 });

  await expect.poll(() => worldSize(page)).toBe(0);
});

/**
 * Having a fillAnchor but no claim does not mean a drag is in progress (a regression from review #25).
 * That state used to be the wait for the first point of a Shift+click range, but that was removed in #103,
 * so the only remaining state of this shape is the height stage of a shape fill (button released, extruding).
 */
test('isDragging() stays false during the height stage of a shape fill (the button is released)', async ({ page }) => {
  await page.keyboard.press('3'); // box tool
  const a = await groundScreenPos(page, 6, 6);
  const b = await groundScreenPos(page, 8, 8);

  expect(await page.evaluate(() => window.__bs.editorControls.isDragging())).toBe(false);
  await dispatchPointer(page, 'pointerdown', a.x, a.y);
  await dispatchPointer(page, 'pointermove', b.x, b.y, { buttons: 1 });
  await dispatchPointer(page, 'pointerup', b.x, b.y, { buttons: 0 });

  // It advanced to the height stage (the fillAnchor remains), but the button is released = no drag in progress
  expect(await page.evaluate(() => window.__bs.editorControls.isDragging())).toBe(false);

  await page.keyboard.press('Escape'); // do not carry the height stage over to the following tests
});

/**
 * A regression from the #12 PR3 review (PR #26): InputRouter.broadcastCancel() calls endActiveClaim()
 * (claim.onCancel = cancelDrag/cancelMarquee) first, then escapeHandlers (including selectTool.cancelActive).
 * Before the claim unification, selectTool.cancelActive() alone handled exactly one step of the
 * "drag / marquee / rangeAnchor / clear selection" priority chain, but afterwards claim.onCancel has already
 * handled drag/marquee, so cancelActive() could not detect that and cascaded all the way to clearing the
 * selection (found 2026-07-21). This confirms the selection is preserved on the Escape
 * (broadcastCancel reason='escape') path.
 */
test.describe('#12 PR3 regression: an existing selection is not cleared by mistake when a claim is cancelled', () => {
  async function placeAndSelect(page: Page, gx: number, gz: number): Promise<{ x: number; y: number }> {
    const groundPos = await groundScreenPos(page, gx, gz);
    await page.keyboard.press('1'); // place tool
    await page.mouse.click(groundPos.x, groundPos.y);
    await page.keyboard.press('v'); // select tool
    await page.mouse.click(groundPos.x, groundPos.y); // select with a normal click
    await expect.poll(() => selectionKind(page)).toBe('cells');
    return groundPos;
  }

  test('Escape during a selection drag cancels the drag while keeping the original selection', async ({ page }) => {
    const origin = await placeAndSelect(page, -8, -8);

    await dispatchPointer(page, 'pointerdown', origin.x, origin.y, { detail: 1 });
    await dispatchPointer(page, 'pointermove', origin.x + 100, origin.y);
    expect(await page.evaluate(() => window.__bs.selectTool.hasActiveDrag())).toBe(true);

    await page.keyboard.press('Escape');
    await dispatchPointer(page, 'pointerup', origin.x + 100, origin.y, { buttons: 0 });

    expect(await page.evaluate(() => window.__bs.selectTool.hasActiveDrag())).toBe(false);
    expect(await selectionKind(page)).toBe('cells'); // it must not fall to 'none'
  });

  test('Escape during a marquee cancels the marquee while keeping the existing selection', async ({ page }) => {
    // Start the marquee on empty ground away from the selected cell (a click on a selected cell is treated as a drag)
    const selectedPos = await placeAndSelect(page, -10, -10);
    void selectedPos;
    const marqueeStart = await groundScreenPos(page, -6, -6);

    await dispatchPointer(page, 'pointerdown', marqueeStart.x, marqueeStart.y, { detail: 1 });
    await dispatchPointer(page, 'pointermove', marqueeStart.x + 60, marqueeStart.y + 60);
    expect(await page.evaluate(() => window.__bs.selectTool.isDragging())).toBe(true);

    await page.keyboard.press('Escape');
    await dispatchPointer(page, 'pointerup', marqueeStart.x + 60, marqueeStart.y + 60, { buttons: 0 });

    expect(await page.evaluate(() => window.__bs.selectTool.isDragging())).toBe(false);
    expect(await selectionKind(page)).toBe('cells'); // the selection from before the marquee is kept
  });

  test('a drag cancelled by pointercancel does not block a later unrelated Escape from clearing the selection (stale flag regression)', async ({ page }) => {
    // pointercancel does not go through broadcastCancel (endActiveClaim is called directly), so the flag marking
    // "one step of the selection-clearing priority chain already handled" is not consumed unless it is scoped by
    // reason, and it lingers to be wrongly swallowed by a later unrelated Escape (claimCancelledThisBroadcast going stale).
    const origin = await placeAndSelect(page, -16, -16);

    await dispatchPointer(page, 'pointerdown', origin.x, origin.y, { detail: 1 });
    await dispatchPointer(page, 'pointermove', origin.x + 100, origin.y);
    expect(await page.evaluate(() => window.__bs.selectTool.hasActiveDrag())).toBe(true);

    await dispatchPointer(page, 'pointercancel', origin.x + 100, origin.y);
    expect(await page.evaluate(() => window.__bs.selectTool.hasActiveDrag())).toBe(false);
    expect(await selectionKind(page)).toBe('cells'); // pointercancel discards only the drag and keeps the selection

    // An Escape with no drag / marquee / rangeAnchor left. Clearing the selection should work normally
    await page.keyboard.press('Escape');
    expect(await selectionKind(page)).toBe('none');
  });
});
