import { expect, test } from '@playwright/test';

/**
 * The UI strings asserted throughout this file (rail labels, save-state text, button names) are the Japanese
 * strings of the default locale that playwright.config.ts pins to, so they stay as-is.
 */

test('the app starts and the Figma-style shell and viewport are displayed', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/');

  await expect(page.locator('#viewport')).toBeVisible();
  await expect(page.locator('#sidebar-left .sidebar-document')).toBeVisible();
  await expect(page.locator('#toolbar')).toBeVisible();
  await expect(page.locator('#sidebar-left')).toBeVisible();
  await expect(page.locator('#world-controls')).toBeVisible();
  await expect(page.locator('#inspector')).toBeVisible();
  // 2 stacked swatches + the swap + 5 edit tools + the shape dropdown caret + undo / redo.
  // Adding shapes does not add tool buttons (a single caret folds all the shapes away)
  await expect(page.locator('#toolbar button')).toHaveCount(11);
  await expect(page.locator('#world-controls button')).toHaveCount(6); // 3 viewpoints + ground + texture

  const editor = await page.locator('#editor-area').boundingBox();
  const toolbar = await page.locator('#toolbar').boundingBox();
  expect(editor).not.toBeNull();
  expect(toolbar).not.toBeNull();
  expect(toolbar!.x).toBeGreaterThanOrEqual(editor!.x);
  expect(toolbar!.x + toolbar!.width).toBeLessThanOrEqual(editor!.x + editor!.width);

  expect(errors, `console/page errors: ${errors.join('\n')}`).toEqual([]);
});

test('the document bar fits inside the left sidebar, and the canvas and right panel start at the top edge', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();

  // The old top bar band is gone. The canvas and right panel can use the screen from its very top
  await expect(page.locator('#topbar')).toHaveCount(0);
  const editor = (await page.locator('#editor-area').boundingBox())!;
  const rightPanel = (await page.locator('#right-panel').boundingBox())!;
  expect(editor.y).toBe(0);
  expect(rightPanel.y).toBe(0);

  // It fits within 248px of width (a horizontal scrollbar would mean the wrapping broke)
  const sidebar = page.locator('#sidebar-left');
  expect(await sidebar.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);

  // Only "export" is permanently visible. Save / load / clear live inside the menu.
  // The menu itself is a child of documentBar (so it is thrown away together when render rebuilds it),
  // hence counting by "is it permanently visible"
  const bar = (await page.locator('#sidebar-left .sidebar-document').boundingBox())!;
  await expect(page.locator('#sidebar-left .sidebar-document .bs-button:visible')).toHaveCount(1);

  // The weight of a filled button comes from its area, not its color. At full width it would be the strongest
  // element in a white panel, so it sits on the same row as the save state at content width
  const exportBox = (await page.locator('#sidebar-left .document-export').boundingBox())!;
  expect(exportBox.width).toBeLessThan(bar.width * 0.45);
  const stateBox = (await page.locator('#sidebar-left .document-save-state').boundingBox())!;
  expect(Math.abs(exportBox.y - stateBox.y)).toBeLessThan(20); // the same row
  expect(exportBox.height).toBeLessThanOrEqual(32); // it did not wrap

  // The header must not squeeze the canvas. Back when 4 buttons were always expanded with horizontal tabs
  // it was 260px, which felt heavy next to Figma's rail
  const headerBottom = await page
    .locator('#sidebar-left .sidebar-document')
    .evaluate((el) => Math.round(el.getBoundingClientRect().bottom));
  expect(headerBottom).toBeLessThanOrEqual(120);
});

test('panel switching happens on the icon rail at the far left', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();

  // Horizontal tabs were dropped. They moved to a vertical rail so each item does not get thinner as items are added
  await expect(page.locator('#sidebar-left .sidebar-tabs')).toHaveCount(0);
  const items = page.locator('#sidebar-rail .rail-item');
  await expect(items).toHaveCount(4);

  const panel = (id: string) => page.locator(`#sidebar-left #${id}.active`);
  await expect(panel('layers')).toHaveCount(1);

  await items.nth(1).click();
  await expect(panel('palette')).toHaveCount(1);
  await expect(items.nth(1)).toHaveAttribute('aria-selected', 'true');

  await items.nth(2).click();
  await expect(panel('recipes')).toHaveCount(1);

  await items.nth(3).click();
  await expect(panel('components')).toHaveCount(1);
  await expect(items.nth(3)).toHaveAttribute('aria-selected', 'true');

  // ↑ steps back one, Home jumps to the first (automatic activation)
  await items.nth(3).press('ArrowUp');
  await expect(panel('recipes')).toHaveCount(1);
  await page.locator('#sidebar-rail .rail-items').press('Home');
  await expect(panel('layers')).toHaveCount(1);
});

test('arrow keys on the rail do not leak through to the canvas — with a selection (the nudge path)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();

  // With a selection, arrowsClaimedByNudge takes the arrows. A leak would nudge the block
  await page.keyboard.press('1');
  const pos = await page.evaluate(() => window.__bs.groundScreenPos(5, 5));
  await page.mouse.click(pos.x, pos.y);
  await expect.poll(() => page.evaluate(() => window.__bs.world.size)).toBe(1);

  const occupied = () =>
    page.evaluate(() => {
      for (let x = -12; x <= 12; x++)
        for (let z = -12; z <= 12; z++) if (window.__bs.world.get(x, 0, z) !== null) return `${x},${z}`;
      return null;
    });
  const cellBefore = await occupied();

  await page.keyboard.press('v');
  await page.mouse.click(pos.x, pos.y);
  await expect.poll(() => page.evaluate(() => window.__bs.selection.get().kind)).not.toBe('none');

  const items = page.locator('#sidebar-rail .rail-item');
  await items.nth(0).focus();
  await items.nth(0).press('ArrowDown');
  await items.nth(1).press('ArrowDown');
  await items.nth(2).press('ArrowUp');

  await expect(page.locator('#sidebar-left #palette.active')).toHaveCount(1);
  expect(await occupied()).toBe(cellBefore);
});

test('arrow keys on the rail do not leak through to the canvas — with nothing selected (the camera path)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();

  // **With no selection, arrowsClaimedByNudge returns false and the arrows go to camerakeys** (main.ts:278).
  // The with-a-selection case alone never walks this path
  await page.keyboard.press('v');
  await page.evaluate(() => window.__bs.selection.set({ kind: 'none' }));
  await expect.poll(() => page.evaluate(() => window.__bs.selection.get().kind)).toBe('none');

  const camera = () => page.evaluate(() => ({ ...window.__bs.ctx.camera.position }));
  const before = await camera();

  // camerakeys accumulates a held key in update(dt), so drive it with down → wait → up
  const rail = page.locator('#sidebar-rail .rail-item');
  await rail.nth(0).focus();
  await page.keyboard.down('ArrowDown');
  await page.waitForTimeout(250);
  await page.keyboard.up('ArrowDown');

  await expect(page.locator('#sidebar-left #palette.active')).toHaveCount(1); // the switch does happen
  expect(await camera()).toEqual(before); // the camera does not move
});

test('every tablist on screen has a name and they are distinguishable from each other', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();

  // Also open the picker so that two tablists exist at the same time.
  // The block usage list shows rows for "blocks that are placed", so place one first
  await page.keyboard.press('1');
  const pos = await page.evaluate(() => window.__bs.groundScreenPos(5, 5));
  await page.mouse.click(pos.x, pos.y);
  await expect.poll(() => page.evaluate(() => window.__bs.world.size)).toBe(1);
  // Grab it by testid rather than by text (it became an icon-only button)
  await page.locator('#block-usage [data-testid="usage-change"]').first().click();
  await expect(page.locator('.block-change-picker')).toBeVisible();

  const names = await page
    .locator('[role="tablist"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
  expect(names.length).toBeGreaterThanOrEqual(2);
  expect(names).not.toContain(null); // an unnamed tablist makes it unclear which switch it is
  expect(new Set(names).size).toBe(names.length); // no duplicate names
  expect(names).toContain('サイドパネル');
});

test('rail items are associated with their tabpanels', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();

  const items = page.locator('#sidebar-rail .rail-item');
  for (let i = 0; i < 4; i++) {
    const tab = items.nth(i);
    const controls = await tab.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    const panel = page.locator(`#${controls}`);
    await expect(panel).toHaveAttribute('role', 'tabpanel');
    await expect(panel).toHaveAttribute('aria-labelledby', (await tab.getAttribute('id'))!);
  }

  // Unselected panels also get hidden (taking them out of the screen-reader reading order)
  await expect(page.locator('#sidebar-left #layers')).not.toHaveAttribute('hidden', /.*/);
  await expect(page.locator('#sidebar-left #palette')).toHaveAttribute('hidden', /.*/);
  await expect(page.locator('#sidebar-left #recipes')).toHaveAttribute('hidden', /.*/);
});

test('the rail is pinned to the far left of the three-column layout', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();

  const rail = (await page.locator('#sidebar-rail').boundingBox())!;
  const panel = (await page.locator('#sidebar-left').boundingBox())!;
  const canvas = (await page.locator('#editor-area').boundingBox())!;
  expect(rail.x).toBe(0);
  expect(Math.round(panel.x)).toBe(Math.round(rail.x + rail.width));
  expect(Math.round(canvas.x)).toBe(Math.round(panel.x + panel.width));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('the file menu opens next to the logo on the rail and closes on toggle', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();

  const button = page.locator('#sidebar-rail .rail-logo');
  const menu = page.locator('.document-file-menu');
  await expect(menu).toBeHidden();

  await button.click();
  await expect(menu).toBeVisible();
  await expect(menu.locator('button')).toHaveCount(3);

  const anchor = (await button.boundingBox())!;
  const box = (await menu.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(anchor.x + anchor.width); // pushed out to the right of the rail
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

  // Pressing the same button again closes it (light-dismiss and the manual toggle must not double-fire)
  await button.click();
  await expect(menu).toBeHidden();
});

test('buttons do not inherit the browser default of 16px', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();

  // With only font: inherit, .bs-button inherits body's 16px and stands out against the 13px UI around it.
  // Places that go even smaller (11px etc.) are deliberate, so this checks "the default 16px is not left behind"
  const sizes = await page
    .locator('.bs-button')
    .evaluateAll((els) => [...new Set(els.map((el) => getComputedStyle(el).fontSize))].sort());
  expect(sizes.length).toBeGreaterThan(0);
  expect(sizes).not.toContain('16px');
});

test('the save state sits right below the work name and follows through to autosave completion', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();

  const saveState = page.locator('#sidebar-left .document-save-state');
  const nameInput = page.locator('#project-name');
  const nameBox = (await nameInput.boundingBox())!;
  const stateBox = (await saveState.boundingBox())!;
  expect(stateBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height);

  await nameInput.fill('保存状態テスト');
  await nameInput.press('Tab'); // fire change to schedule the autosave
  await expect(saveState).toHaveAttribute('data-state', 'pending');
  await expect(saveState).toHaveText('未保存の変更あり');

  await expect(saveState).toHaveAttribute('data-state', 'saved');
  await expect(saveState).toHaveText(/^自動保存 \d{2}:\d{2}$/);
  expect(
    await page.evaluate(() => {
      const raw = localStorage.getItem('blocksmith.project.autosave.v1');
      return raw ? (JSON.parse(raw) as { name?: string }).name : null;
    }),
  ).toBe('保存状態テスト');

  // Switching tools rebuilds the document bar, but the save state is drawn back
  await page.locator('#toolbar [aria-label^="削除"]').click();
  await expect(saveState).toHaveText(/^自動保存 \d{2}:\d{2}$/);
});

test('the language toggle switches the UI and block names, and the choice survives a reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
  await page.keyboard.press('1');
  const pos = await page.evaluate(() => window.__bs.groundScreenPos(5, 5));
  await page.mouse.click(pos.x, pos.y);
  await expect.poll(() => page.evaluate(() => window.__bs.world.size)).toBe(1);

  // playwright.config.ts pins it to JA, so first confirm that it really is JA
  const toggle = page.locator('#sidebar-rail .rail-lang');
  await expect(toggle).toHaveText('JA');
  await expect(page.locator('#sidebar-rail .rail-item').first()).toContainText('レイヤー');
  await expect(page.locator('#block-usage')).toContainText('使用ブロック');

  await toggle.click();
  await expect(toggle).toHaveText('EN');
  await expect(page.locator('#sidebar-rail .rail-item').first()).toContainText('Layers');
  await expect(page.locator('#block-usage')).toContainText('Blocks in use');
  // The block names go English too (from the official en_US.lang)
  await expect(page.locator('#block-usage')).toContainText('Stone');

  // The contents of panels that are not open follow along as well. The components list builds its heading and
  // its empty-state hint by hand, so without subscribing to language changes it stays Japanese
  await page.locator('#sidebar-rail .rail-item').nth(3).click();
  const components = page.locator('#sidebar-left #components');
  await expect(components).not.toContainText('コンポーネント');
  await expect(components).toContainText('Components');

  // The setting persists in localStorage
  await page.reload();
  await expect(page.locator('#viewport')).toBeVisible();
  await expect(page.locator('#sidebar-rail .rail-lang')).toHaveText('EN');
  await expect(page.locator('#sidebar-rail .rail-item').first()).toContainText('Layers');
});

test('a default name is decided by the language at creation time and does not change retroactively', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();

  // Place a block and group it while still in JA → the default name is the Japanese word for "group"
  await page.keyboard.press('1');
  const pos = await page.evaluate(() => window.__bs.groundScreenPos(5, 5));
  await page.mouse.click(pos.x, pos.y);
  await expect.poll(() => page.evaluate(() => window.__bs.world.size)).toBe(1);
  await page.keyboard.press('v');
  await page.mouse.click(pos.x, pos.y);
  await page.keyboard.press('Control+g');
  await expect.poll(() => page.evaluate(() => window.__bs.doc.tree.childrenOf(null).length)).toBe(1);

  const name = () => page.evaluate(() => window.__bs.doc.tree.getNode(window.__bs.doc.tree.childrenOf(null)[0]!)!.name);
  expect(await name()).toBe('グループ');

  // Switching to EN **does not change the name, which is work data**
  await page.locator('#sidebar-rail .rail-lang').click();
  await expect(page.locator('#sidebar-rail .rail-lang')).toHaveText('EN');
  expect(await name()).toBe('グループ');
});

/**
 * Tab is not claimed by a 2D/3D switch.
 *
 * Removing 2D mode handed it back to the browser's standard focus movement. **Both "2D does not appear" and
 * "focus left the original element" are weak assertions** — the former was never going to appear, and the latter
 * would also pass for a broken implementation that swallows Tab and merely blurs (focus falling to body).
 * This pins down **that focus advanced to the known next element**.
 */
test('Tab works as the browser standard focus movement and no 2D UI appears', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();

  await page.locator('#project-name').focus();
  await expect(page.locator('#project-name')).toBeFocused();

  await page.keyboard.press('Tab');

  // Focus really advanced to the next element in tab order (swallow + blur would drop to body and fail here)
  await expect(page.locator('.document-export')).toBeFocused();
  // The three-view container does not exist in the DOM at all (a secondary assertion)
  await expect(page.locator('#panes2d')).toHaveCount(0);
});

test('View controls stay grouped by orientation and appearance', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();

  const controls = page.locator('#world-controls');
  await expect(controls.locator('.world-control-row')).toHaveCount(2);
  await expect(controls.locator('.world-control-label')).toHaveText(['視点', '表示']);
  await expect(controls.locator('.view-tools button')).toHaveCount(3);
  await expect(controls.locator('.display-tools button')).toHaveCount(3);

  await expect(controls.getByRole('button', { name: '上面ビュー' })).toBeVisible();
  await expect(controls.getByRole('button', { name: '正面ビュー' })).toBeVisible();
  await expect(controls.getByRole('button', { name: '側面ビュー' })).toBeVisible();
});
