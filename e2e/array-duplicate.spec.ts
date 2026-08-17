import { expect, test, type Page } from '@playwright/test';

/**
 * Pins down the inspector UI wiring of array duplication.
 *
 * The delta / count logic of `buildDuplicate` is covered by the unit tests, but
 * **assembling the delta from the direction select and the count / gap inputs** is the inspector's responsibility
 * and can only be observed here (getting the bbox size + gap composition wrong produces adjacency or overlap).
 */

const AUTOSAVE_KEY = 'blocksmith.project.autosave.v1';

/** A single pillar of height 2. Its width is 1, so the difference between "gap" and the final spacing is visible */
const PILLAR: [number, number, number][] = [
  [0, 0, 0],
  [0, 1, 0],
];

async function occupiedXY(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window.__bs.world;
    const out: string[] = [];
    for (let x = -8; x <= 24; x++) for (let y = 0; y <= 4; y++) if (w.get(x, y, 0) !== null) out.push(`${x},${y}`);
    return out.sort();
  });
}

async function seedPillar(page: Page): Promise<void> {
  const blockId = await page.evaluate(() => window.__bs.CATALOG[0]!.id);
  await page.evaluate(
    ({ key, id, cells }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          app: 'blocksmith',
          version: 2,
          name: 'array duplicate test',
          blocks: cells.map(([x, y, z]) => [x, y, z, id, 0, 0]),
          groups: [{ name: 'pillar', parent: -1 }],
          recipes: [],
        }),
      );
    },
    { key: AUTOSAVE_KEY, id: blockId, cells: PILLAR },
  );
  await page.reload();
  await expect(page.locator('#viewport')).toBeVisible();
  await page.evaluate(() => {
    const id = window.__bs.doc.tree.childrenOf(null)[0]!;
    window.__bs.selection.set({ kind: 'groups', ids: [id] });
  });
}

/** Operates the array-duplication row and presses "distribute evenly" */
async function runArrayDuplicate(page: Page, dir: string, count: number, gap: number): Promise<void> {
  const row = page.locator('#inspector .inspector-array-dup');
  await expect(row).toBeVisible();
  await row.locator('select').selectOption(dir);
  const numbers = row.locator('input[type=number]');
  await numbers.nth(0).fill(String(count));
  await numbers.nth(1).fill(String(gap));
  await row.locator('button').click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
});

test('group inspector exposes Figma-style property sections and compact axis fields', async ({ page }) => {
  await seedPillar(page);

  const inspector = page.locator('#inspector');
  // The expected strings are the Japanese UI labels themselves (the default locale), so they stay as-is
  await expect(inspector.locator('.inspector-section-title')).toHaveText([
    '位置とサイズ',
    '変形',
    '配列',
    'コンポーネント',
    '操作',
  ]);
  await expect(inspector.locator('.inspector-position .inspector-prefixed-control')).toHaveCount(3);
  await expect(inspector.locator('.inspector-dimensions .inspector-prefixed-control')).toHaveCount(3);
  await expect(inspector.getByRole('button', { name: 'X軸で反転' })).toBeVisible();
  await expect(inspector.getByRole('button', { name: '左へ90°回転' })).toBeVisible();
});

test('the gap is added on top of the bbox size (a width-1 pillar + gap 2 = every 3 cells)', async ({ page }) => {
  await seedPillar(page);
  await runArrayDuplicate(page, '+x', 3, 2);

  expect(await occupiedXY(page)).toEqual(['0,0', '0,1', '3,0', '3,1', '6,0', '6,1', '9,0', '9,1'].sort());
  expect(await page.evaluate(() => window.__bs.doc.tree.childrenOf(null).length)).toBe(4); // original + 3 copies
});

test('a gap of 0 produces exact adjacency', async ({ page }) => {
  await seedPillar(page);
  await runArrayDuplicate(page, '+x', 2, 0);

  expect(await occupiedXY(page)).toEqual(['0,0', '0,1', '1,0', '1,1', '2,0', '2,1'].sort());
});

test('the negative direction (−X) can be chosen too', async ({ page }) => {
  await seedPillar(page);
  await runArrayDuplicate(page, '-x', 2, 0);
  expect(await occupiedXY(page)).toEqual(['-2,0', '-2,1', '-1,0', '-1,1', '0,0', '0,1'].sort());
});

test('the upward direction (+Y) stacks by the bbox height (each axis uses its own size, not the width)', async ({ page }) => {
  await seedPillar(page); // a pillar of height 2
  await runArrayDuplicate(page, '+y', 2, 0);
  // Height is 2, so it stacks as y=0..1 / 2..3 / 4..5
  expect(await occupiedXY(page)).toEqual(['0,0', '0,1', '0,2', '0,3', '0,4'].sort()); // the observed range only goes up to y<=4
});

test('array duplication can be undone in one Ctrl+Z (a single transaction)', async ({ page }) => {
  await seedPillar(page);
  const before = await occupiedXY(page);

  await runArrayDuplicate(page, '+x', 3, 2);
  expect(await occupiedXY(page)).not.toEqual(before);

  await page.keyboard.press('Control+z');
  expect(await occupiedXY(page)).toEqual(before);
  expect(await page.evaluate(() => window.__bs.doc.tree.childrenOf(null).length)).toBe(1);
});

test('array duplication also works from a single-block selection', async ({ page }) => {
  // Place just one unclassified block, without putting it in a group
  const blockId = await page.evaluate(() => window.__bs.CATALOG[0]!.id);
  await page.evaluate(
    ({ key, id }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          app: 'blocksmith',
          version: 2,
          name: 'single cell',
          blocks: [[0, 0, 0, id, 0, -1]],
          groups: [],
          recipes: [],
        }),
      );
    },
    { key: AUTOSAVE_KEY, id: blockId },
  );
  await page.reload();
  await expect(page.locator('#viewport')).toBeVisible();

  await page.evaluate(() => {
    const ref = { ownerId: null, localCell: [0, 0, 0] as [number, number, number] };
    window.__bs.selection.set({ kind: 'cells', cells: new Map([['-|0,0,0', { ref, worldCell: [0, 0, 0] }]]) });
  });

  // The array-duplication row shows up in the single-cell inspector as well
  await runArrayDuplicate(page, '+x', 4, 1);

  // Width 1 + gap 1 = 5 copies every 2 cells (original + 4 copies)
  expect(await occupiedXY(page)).toEqual(['0,0', '2,0', '4,0', '6,0', '8,0']);
});
