import { expect, test, type Page } from '@playwright/test';

/**
 * Pins down the input wiring of the layers panel (HTML5 drag & drop / Shift+arrows) with real events
 *.
 *
 * The unit tests (ops) cover `dragPayloadFor` / `buildReparentGroups` / `computeDropIndexFor` separately, but
 * **the only thing connecting them is the DOM event handlers in layers.ts**, and the wiring of
 * "read the selection on dragstart → decide the zone on drop and call the builder" only runs here.
 *
 * CDP synthetic input does not fire native HTML5 dragstart / DataTransfer, so `DragEvent` + `DataTransfer`
 * are dispatched by hand (the same approach as dispatching PointerEvent directly in the other specs).
 *
 * The Japanese UI strings asserted below (button titles, the empty-state text) are the labels of the default
 * locale, and the Japanese group names in the fixtures are deliberate (see seedNestedGroups), so both stay as-is.
 */

const AUTOSAVE_KEY = 'blocksmith.project.autosave.v1';

/** Seeds an autosave with 3 groups (one block each) and reloads */
async function seedThreeGroups(page: Page): Promise<string[]> {
  const blockId = await page.evaluate(() => window.__bs.CATALOG[0]!.id);
  await page.evaluate(
    ({ key, id }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          app: 'blocksmith',
          version: 2,
          name: 'three groups',
          // [x, y, z, blockId, orientationCode, groupIndex]
          blocks: [
            [0, 0, 0, id, 0, 0],
            [2, 0, 0, id, 0, 1],
            [4, 0, 0, id, 0, 2],
          ],
          groups: [
            { name: 'A', parent: -1 },
            { name: 'B', parent: -1 },
            { name: 'C', parent: -1 },
          ],
          recipes: [],
        }),
      );
    },
    { key: AUTOSAVE_KEY, id: blockId },
  );
  await page.reload();
  await expect(page.locator('#viewport')).toBeVisible();
  const ids = await page.evaluate(() => [...window.__bs.doc.tree.childrenOf(null)]);
  expect(ids).toHaveLength(3);
  return ids;
}

function rootChildren(page: Page): Promise<string[]> {
  return page.evaluate(() => [...window.__bs.doc.tree.childrenOf(null)]);
}

function selectionIds(page: Page): Promise<string[] | undefined> {
  return page.evaluate(() => {
    const sel = window.__bs.selection.get();
    return sel.kind === 'groups' ? [...(sel.ids ?? [])] : undefined;
  });
}

/**
 * Grabs a group row and drops it onto another group row. `zone` maps to the vertical position within the row
 * (zoneOf in layers.ts: top 25% = above / bottom 25% = below / middle = into).
 *
 * **The display puts the front on top**, so `above` goes toward the end of the sibling array (= the front).
 * This is specified by screen position, and converting it into an array index is layers.ts's job.
 *
 * The mousedown → dragstart order matches a real browser. When mousedown changes the selection, a synchronous
 * render replaces the row element, so **the row is looked up again right before dragstart** (in a real browser the
 * element under the cursor is the new one too).
 */
async function dragRowOntoRow(
  page: Page,
  sourceGroupId: string,
  targetGroupId: string,
  zone: 'above' | 'into' | 'below',
): Promise<void> {
  await page.evaluate(
    ({ sourceGroupId: src, targetGroupId: dst, zone: z }) => {
      const rowOf = (id: string): HTMLElement => {
        const el = document.querySelector<HTMLElement>(`[data-group-id="${id}"]`);
        if (!el) throw new Error(`layer row not found: ${id}`);
        return el;
      };
      const mouse = (type: string): MouseEvent =>
        new MouseEvent(type, { button: 0, buttons: 1, bubbles: true, cancelable: true });

      rowOf(src).dispatchEvent(mouse('mousedown'));

      // If mousedown changes the selection, render() runs and replaces the row element, so look it up again
      const source = rowOf(src);
      const dt = new DataTransfer();
      const drag = (type: string, clientY?: number): DragEvent =>
        new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientY });

      source.dispatchEvent(drag('dragstart'));

      const target = rowOf(dst);
      const rect = target.getBoundingClientRect();
      const ratio = z === 'above' ? 0.1 : z === 'below' ? 0.9 : 0.5;
      const clientY = rect.top + rect.height * ratio;

      target.dispatchEvent(drag('dragover', clientY));
      target.dispatchEvent(drag('drop', clientY));
      source.dispatchEvent(drag('dragend'));
    },
    { sourceGroupId, targetGroupId, zone },
  );
}



async function cameraPosition(page: import('@playwright/test').Page): Promise<{ x: number; y: number; z: number }> {
  return page.evaluate(() => ({ ...window.__bs.ctx.camera.position }));
}

/** The cell coordinates visible on the y=0 plane (winner based) */
async function occupiedCells(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window.__bs.world;
    const out: string[] = [];
    for (let x = -14; x <= 14; x++)
      for (let z = -14; z <= 14; z++) if (w.get(x, 0, z) !== null) out.push(`${x},${z}`);
    return out.sort();
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
});

test('multi-selected groups move together on a real drag and revert in one undo', async ({ page }) => {
  const [a, b, c] = await seedThreeGroups(page);

  await page.evaluate((ids) => window.__bs.selection.set({ kind: 'groups', ids }), [a!, b!]);
  const undoBefore = await page.evaluate(() => window.__bs.doc.undoStack.length);

  // Grab the selected a and drop it **above** c → the selected a and b move to the front together.
  // The display puts the front on top, so in the sibling array (front is later) they go toward the end
  await dragRowOntoRow(page, a!, c!, 'above');
  expect(await rootChildren(page)).toEqual([c, a, b]);

  // Moving 2 groups is still one undo (a single transaction)
  expect(await page.evaluate(() => window.__bs.doc.undoStack.length)).toBe(undoBefore + 1);
  await page.keyboard.press('Control+z');
  expect(await rootChildren(page)).toEqual([a, b, c]);
});

test('grabbing a row outside the selection moves the selection to it, and it stays selected after the move', async ({ page }) => {
  const [a, b, c] = await seedThreeGroups(page);

  await page.evaluate((id) => window.__bs.selection.set({ kind: 'groups', ids: [id] }), a!);
  expect(await selectionIds(page)).toEqual([a]);

  // Grab c, which is outside the selection → the selection moves to c and only c moves (a is not dragged along).
  // **Below** a means the back side, so in the sibling array it goes before a
  await dragRowOntoRow(page, c!, a!, 'below');
  expect(await rootChildren(page)).toEqual([c, a, b]);

  // What was moved is what stays selected (matching the target of the next Delete / Ctrl+D)
  expect(await selectionIds(page)).toEqual([c]);
});

test('dropping into the middle of a group row puts the selected groups inside it together', async ({ page }) => {
  const [a, b, c] = await seedThreeGroups(page);

  await page.evaluate((ids) => window.__bs.selection.set({ kind: 'groups', ids }), [b!, c!]);
  await dragRowOntoRow(page, b!, a!, 'into');

  expect(await rootChildren(page)).toEqual([a]);
  expect(await page.evaluate((id) => [...window.__bs.doc.tree.childrenOf(id)], a!)).toEqual([b, c]);

  await page.keyboard.press('Control+z');
  expect(await rootChildren(page)).toEqual([a, b, c]);
});

test('Shift+↓ / Shift+↑ grow and shrink the layer selection range', async ({ page }) => {
  const [a, b, c] = await seedThreeGroups(page);

  // The display puts the front on top, so the order is C → B → A. Anchor on the topmost, C.
  // A click makes a single selection = the anchor of the range
  await page.evaluate((id) => {
    document.querySelector<HTMLElement>(`[data-group-id="${id}"]`)!.click();
  }, c!);
  expect(await selectionIds(page)).toEqual([c]);

  await page.keyboard.press('Shift+ArrowDown');
  expect(await selectionIds(page)).toEqual([c, b]);

  await page.keyboard.press('Shift+ArrowDown');
  expect(await selectionIds(page)).toEqual([c, b, a]);

  // It does not grow past the end (the key is still consumed, so the camera does not move either)
  const camBefore = await page.evaluate(() => ({ ...window.__bs.ctx.camera.position }));
  await page.keyboard.press('Shift+ArrowDown');
  expect(await selectionIds(page)).toEqual([c, b, a]);
  expect(await page.evaluate(() => ({ ...window.__bs.ctx.camera.position }))).toEqual(camBefore);

  // Shrinking works from the same anchor
  await page.keyboard.press('Shift+ArrowUp');
  expect(await selectionIds(page)).toEqual([c, b]);
});

test('Shift+↑↓ does not move blocks (it does not leak into the nudge)', async ({ page }) => {
  const [a] = await seedThreeGroups(page);

  await page.keyboard.press('v'); // select tool (the condition under which the nudge is active)
  await page.evaluate((id) => {
    document.querySelector<HTMLElement>(`[data-group-id="${id}"]`)!.click();
  }, a!);

  const occupied = () =>
    page.evaluate(() => {
      const w = window.__bs.world;
      const out: string[] = [];
      for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) if (w.get(x, 0, z) !== null) out.push(`${x},${z}`);
      return out.sort();
    });
  const before = await occupied();

  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowUp');
  expect(await occupied()).toEqual(before);
});

/** Parent P > child C, with sibling S after it. P is returned already expanded */
async function seedNestedGroups(page: import('@playwright/test').Page): Promise<{ p: string; c: string; s: string }> {
  const blockId = await page.evaluate(() => window.__bs.CATALOG[0]!.id);
  await page.evaluate(
    ({ key, id }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          app: 'blocksmith',
          version: 2,
          name: 'nested',
          blocks: [
            [0, 0, 0, id, 0, 0],
            [2, 0, 0, id, 0, 1],
            [4, 0, 0, id, 0, 2],
          ],
          // the parent of groups[1] is groups[0].
          // Japanese names are used so the filter tests do not collide with block names / ids
          groups: [{ name: '親', parent: -1 }, { name: '子', parent: 0 }, { name: '兄弟', parent: -1 }],
          recipes: [],
        }),
      );
    },
    { key: AUTOSAVE_KEY, id: blockId },
  );
  await page.reload();
  await expect(page.locator('#viewport')).toBeVisible();
  const [p, s] = await page.evaluate(() => [...window.__bs.doc.tree.childrenOf(null)]);
  const [c] = await page.evaluate((pid) => [...window.__bs.doc.tree.childrenOf(pid)], p!);
  // Open P's caret so the child C becomes visible
  await page.evaluate((pid) => {
    document.querySelector<HTMLElement>(`[data-group-id="${pid}"] .caret`)!.click();
  }, p!);
  await expect(page.locator(`[data-group-id="${c!}"]`)).toBeVisible();
  return { p: p!, c: c!, s: s! };
}

test('selecting the parent and pressing Shift+↑ skips the child and adds the sibling (parent and child are never selected together)', async ({ page }) => {
  const { p, c, s } = await seedNestedGroups(page);

  await page.evaluate((id) => {
    document.querySelector<HTMLElement>(`[data-group-id="${id}"]`)!.click();
  }, p);
  expect(await selectionIds(page)).toEqual([p]);

  // The display puts the front on top, so the order is S → P → C. The sibling S sits **above** P.
  // "Nothing visibly changes" must not happen on the first press — it jumps straight to the sibling
  await page.keyboard.press('Shift+ArrowUp');
  expect(await selectionIds(page)).toEqual([s, p]);
  expect(await selectionIds(page)).not.toContain(c);
});

test('selecting the child and pressing Shift+↑ does not add the parent (it is consumed at the boundary, and the camera stays put)', async ({ page }) => {
  const { c } = await seedNestedGroups(page);

  await page.evaluate((id) => {
    document.querySelector<HTMLElement>(`[data-group-id="${id}"]`)!.click();
  }, c);
  expect(await selectionIds(page)).toEqual([c]);

  const camBefore = await page.evaluate(() => ({ ...window.__bs.ctx.camera.position }));
  await page.keyboard.press('Shift+ArrowUp');
  expect(await selectionIds(page)).toEqual([c]);
  expect(await page.evaluate(() => ({ ...window.__bs.ctx.camera.position }))).toEqual(camBefore);
});

test('once the selected child is hidden by collapsing the parent, Shift+↑↓ is not a layer operation and yields to the camera', async ({ page }) => {
  const { p, c } = await seedNestedGroups(page);

  await page.evaluate((id) => {
    document.querySelector<HTMLElement>(`[data-group-id="${id}"]`)!.click();
  }, c);
  expect(await selectionIds(page)).toEqual([c]);

  // Collapse P → the selection stays c while c disappears from the visible rows
  await page.evaluate((pid) => {
    document.querySelector<HTMLElement>(`[data-group-id="${pid}"] .caret`)!.click();
  }, p);
  await expect(page.locator(`[data-group-id="${c}"]`)).toHaveCount(0);
  expect(await selectionIds(page)).toEqual([c]);

  // **Stay on the place tool** — the nudge stopped looking at the tool, so if a
  // "Shift+↑↓ the layers do not claim" leaked into the nudge, a block would move here
  await page.keyboard.press('1');
  expect(await page.evaluate(() => window.__bs.state.tool)).toBe('place');

  const before = await occupiedCells(page);
  const transformBefore = await page.evaluate((id) => window.__bs.doc.tree.getNode(id)?.transform, c);

  const cameraBefore = await cameraPosition(page);

  // Hold the key down — camerakeys moves on every update() frame, so a press may not span even one frame
  await page.keyboard.down('Shift');
  await page.keyboard.down('ArrowDown');
  await page.waitForTimeout(300);
  await page.keyboard.up('ArrowDown');
  await page.keyboard.up('Shift');

  // Not claimed as a layer operation = the selection, the block positions, and the transform all stay put
  expect(await selectionIds(page)).toEqual([c]);
  expect(await occupiedCells(page)).toEqual(before);
  expect(await page.evaluate((id) => window.__bs.doc.tree.getNode(id)?.transform, c)).toEqual(transformBefore);
  // **And rather than vanishing with nobody receiving it, it is passed to the camera**
  expect(await cameraPosition(page)).not.toEqual(cameraBefore);
});

test('even with the select tool, a Shift+↑↓ the layers do not claim does not move blocks', async ({ page }) => {
  const { p, c } = await seedNestedGroups(page);

  await page.evaluate((id) => {
    document.querySelector<HTMLElement>(`[data-group-id="${id}"]`)!.click();
  }, c);
  await page.evaluate((pid) => {
    document.querySelector<HTMLElement>(`[data-group-id="${pid}"] .caret`)!.click();
  }, p);
  await expect(page.locator(`[data-group-id="${c}"]`)).toHaveCount(0);

  await page.keyboard.press('v'); // select tool (the side where the nudge was already active)
  const before = await occupiedCells(page);

  await page.keyboard.press('Shift+ArrowDown');
  expect(await occupiedCells(page)).toEqual(before);

  // Bare arrows still nudge as before (only the modified ones were restricted)
  await page.keyboard.press('ArrowDown');
  expect(await occupiedCells(page)).not.toEqual(before);
});

async function visibleGroupIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-group-id]')].map((el) => el.dataset.groupId!),
  );
}

async function typeFilter(page: import('@playwright/test').Page, text: string): Promise<void> {
  const box = page.locator('#layers .layers-search');
  await box.fill(text);
}

test('filtering leaves only the matching groups, and clearing it restores everything', async ({ page }) => {
  const [a, b, c] = await seedThreeGroups(page);
  // The display puts the front on top, so the order is C → B → A
  expect(await visibleGroupIds(page)).toEqual([c, b, a]);

  // The group names from seedThreeGroups are A / B / C
  await typeFilter(page, 'B');
  expect(await visibleGroupIds(page)).toEqual([b]);

  await typeFilter(page, 'zzz');
  expect(await visibleGroupIds(page)).toEqual([]);
  await expect(page.locator('#layers .layers-empty')).toHaveText('一致するレイヤーがない');

  await typeFilter(page, '');
  expect(await visibleGroupIds(page)).toEqual([c, b, a]);
});

test('filtering reaches inside a group even while it is collapsed', async ({ page }) => {
  const { p, c } = await seedNestedGroups(page);
  // Collapse P to hide C, then filter
  await page.evaluate((pid) => {
    document.querySelector<HTMLElement>(`[data-group-id="${pid}"] .caret`)!.click();
  }, p);
  await expect(page.locator(`[data-group-id="${c}"]`)).toHaveCount(0);

  await typeFilter(page, '子');
  // The ancestor (parent) is shown as well, so the child can be reached
  expect(await visibleGroupIds(page)).toEqual([p, c]);
});

test('Shift+↑↓ walks only the rows visible under the filter', async ({ page }) => {
  const [, b] = await seedThreeGroups(page);

  // A filter that leaves only B. A / C are out of view, so there is nowhere to walk to
  await typeFilter(page, 'B');
  expect(await visibleGroupIds(page)).toEqual([b]);

  await page.evaluate((id) => {
    document.querySelector<HTMLElement>(`[data-group-id="${id}"]`)!.click();
  }, b!);
  expect(await selectionIds(page)).toEqual([b]);

  // Ignoring the filter and growing to A / C would select rows that are not on screen
  await page.keyboard.press('Shift+ArrowDown');
  expect(await selectionIds(page)).toEqual([b]);
  await page.keyboard.press('Shift+ArrowUp');
  expect(await selectionIds(page)).toEqual([b]);
});

test('the expand-all / collapse-all buttons', async ({ page }) => {
  const { p, c } = await seedNestedGroups(page);

  await page.locator('#layers .layers-header button[title="すべて折りたたむ"]').click();
  expect(await visibleGroupIds(page)).not.toContain(c);

  await page.locator('#layers .layers-header button[title="すべて展開"]').click();
  const ids = await visibleGroupIds(page);
  expect(ids).toContain(p);
  expect(ids).toContain(c);
});

test('a caret click during filtering does not rewrite the expansion state', async ({ page }) => {
  const { p, c } = await seedNestedGroups(page);
  // seedNestedGroups returns with the parent expanded
  await expect(page.locator(`[data-group-id="${c}"]`)).toBeVisible();

  await typeFilter(page, '子');
  expect(await visibleGroupIds(page)).toEqual([p, c]);

  // Select another row first (to check that a caret click does not steal the selection)
  await page.evaluate((id) => {
    document.querySelector<HTMLElement>(`[data-group-id="${id}"]`)!.click();
  }, c);
  expect(await selectionIds(page)).toEqual([c]);

  // Pressing the parent's caret during filtering is a complete no-op — the display, the expansion state,
  // and the selection all stay put. Merely removing the listener lets the click bubble to the parent row
  // and moves the selection to the parent (the note from the second round)
  await page.locator(`[data-group-id="${p}"] .caret`).click();
  expect(await visibleGroupIds(page)).toEqual([p, c]);
  expect(await selectionIds(page)).toEqual([c]);

  // Clearing the filter keeps the expansion state from before the press (it does not collapse late)
  await typeFilter(page, '');
  expect(await visibleGroupIds(page)).toContain(c);
  expect(await selectionIds(page)).toEqual([c]);
});

test('the filter does not match catalog IDs that never appear on screen', async ({ page }) => {
  await seedThreeGroups(page);
  const blockId = await page.evaluate(() => window.__bs.CATALOG[0]!.id);

  // Searching by the catalog ID itself leaves nothing (searching by display name is covered by another test)
  await typeFilter(page, blockId);
  expect(await visibleGroupIds(page)).toEqual([]);
  await expect(page.locator('#layers .layers-empty')).toHaveText('一致するレイヤーがない');
});
