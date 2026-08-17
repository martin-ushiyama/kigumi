import { expect, test, type Page } from '@playwright/test';

/**
 * Confirms on the real app that a shape fill is anchored to the face that was touched (#101).
 *
 * How the axis is decided and the geometry of the projection belong to the unit side
 * (`tests/shape-fill-face-axis.test.ts` / `tests/services/picking.test.ts`). What is checked here is
 * **whether a wall actually gets built** — while the extrusion was locked to Y, touching a side face still
 * produced a ground-anchored plane and this did not work.
 */

async function groundPos(page: Page, x: number, z: number): Promise<{ x: number; y: number }> {
  return page.evaluate(([gx, gz]) => window.__bs.groundScreenPos(gx, gz), [x, z] as [number, number]);
}

async function cellPos(page: Page, x: number, y: number, z: number): Promise<{ x: number; y: number }> {
  return page.evaluate(([cx, cy, cz]) => window.__bs.cellScreenPos(cx, cy, cz), [x, y, z] as [number, number, number]);
}

/** Enumerates the placed cells in world coordinates (cells inside groups are converted to world too) */
async function filledCells(page: Page): Promise<[number, number, number][]> {
  return page.evaluate(() => {
    const out: [number, number, number][] = [];
    for (let x = -12; x <= 12; x++) {
      for (let y = 0; y <= 24; y++) {
        for (let z = -12; z <= 12; z++) {
          if (window.__bs.catalogIndexAt(x, y, z) !== null) out.push([x, y, z]);
        }
      }
    }
    return out;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
  await page.locator('.shape-control .shape-main').click(); // to the fill tool
});

/**
 * Builds something with a side face to touch. Picks 1×1 from the ground and extrudes upward into a column.
 * (That operation itself is anchored to the top/bottom faces as before.)
 */
async function buildColumn(page: Page): Promise<void> {
  const at = await groundPos(page, 0, 0);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up(); // move to the extrusion stage with the plane still 1×1
  await page.mouse.move(at.x, at.y - 160, { steps: 6 }); // stretch upward
  await page.mouse.down();
  await page.mouse.up(); // commit
  const cells = await filledCells(page);
  expect(cells.length).toBeGreaterThan(3); // the column was built
}

test('dragging from a side face of the column spreads upward along that face (a range the ground anchor cannot reach)', async ({ page }) => {
  await buildColumn(page);
  const before = await filledCells(page);
  const columnTop = Math.max(...before.map(([, y]) => y));

  // Aim at a cell partway up the column. The cell above hides the top face, so the ray hits a **side face**
  const mid = Math.max(1, Math.floor(columnTop / 2));
  const from = await cellPos(page, 0, mid, 0);

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Diagonally up on screen. With a face-aligned plane, both the horizontal direction and Y grow
  await page.mouse.move(from.x + 90, from.y - 90, { steps: 8 });
  await expect(page.locator('#statusbar')).toContainText('×'); // a range operation is in progress
  await page.mouse.up();
  await page.mouse.down();
  await page.mouse.up(); // commit without extruding (a face one block thick)

  const after = await filledCells(page);
  expect(after.length).toBeGreaterThan(before.length);

  // There are cells outside the column (x=0, z=0) above the mid height =
  // Y grew along the face-aligned plane. That is unreachable if the plane came from a ground hit
  const grewOffColumn = after.some(([x, y, z]) => (x !== 0 || z !== 0) && y > mid);
  expect(grewOffColumn).toBe(true);
});

test('an upward-facing face still spreads horizontally as before (existing usage is not broken)', async ({ page }) => {
  const a = await groundPos(page, 2, 2);
  const b = await groundPos(page, 6, 5);

  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await page.mouse.down();
  await page.mouse.up(); // commit while still at height 1

  const cells = await filledCells(page);
  expect(cells.length).toBeGreaterThan(1);
  // It was a ground click, so Y stays 0 and it spreads across XZ
  expect(cells.every(([, y]) => y === 0)).toBe(true);
  expect(new Set(cells.map(([x]) => x)).size).toBeGreaterThan(1);
  expect(new Set(cells.map(([, , z]) => z)).size).toBeGreaterThan(1);
});
