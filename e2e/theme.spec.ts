import { expect, test, type Page } from '@playwright/test';

/**
 * The screen theme.
 *
 * Pins down that **CSS and 3D look at the same theme**. A state where only one of them switches shows up as
 * "the UI is dark but only the viewport is bright", so both are checked in a single test.
 */

const UI_KEY = 'blocksmith.ui.v1';

function themeButton(page: Page) {
  return page.locator('#sidebar-rail .rail-theme');
}

/** The current appearance (the CSS side and the 3D side) */
function snapshot(page: Page) {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const scene = window.__bs.ctx.scene;
    let ground: string | null = null;
    let grid: string | null = null;
    scene.traverse((o) => {
      const mesh = o as unknown as {
        type?: string;
        geometry?: { type?: string; attributes?: { color?: { array: ArrayLike<number> } } };
        material?: { color?: { getHexString(): string } };
      };
      if (!ground && mesh.geometry?.type === 'PlaneGeometry' && mesh.material?.color) {
        ground = `#${mesh.material.color.getHexString()}`;
      }
      // The grid uses per-line vertex colors. **The leading numbers are used as a fingerprint as-is** —
      // writing concrete colors would mean fixing the test every time the theme is adjusted,
      // so this only checks "did it change with the theme"
      if (!grid && mesh.type === 'GridHelper' && mesh.geometry?.attributes?.color) {
        grid = [...Array.from(mesh.geometry.attributes.color.array).slice(0, 6)].map((v) => v.toFixed(4)).join(',');
      }
    });
    return {
      attr: document.documentElement.dataset.theme ?? null,
      colorScheme: cs.colorScheme,
      canvas: cs.getPropertyValue('--bs-surface-canvas').trim(),
      text: cs.getPropertyValue('--bs-content-primary').trim(),
      sceneBackground: `#${scene.background.getHexString()}`,
      ground,
      grid,
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
  await page.evaluate((key) => localStorage.removeItem(key), UI_KEY);
  await page.reload();
  await expect(page.locator('#viewport')).toBeVisible();
});

test('the toggle switches the UI and the 3D scene to dark together', async ({ page }) => {
  const light = await snapshot(page);
  expect(light.attr).toBe('light');
  expect(light.sceneBackground).toBe('#e5e7ea');

  await themeButton(page).click();

  const dark = await snapshot(page);
  expect(dark.attr, 'the attribute becomes dark').toBe('dark');
  expect(dark.colorScheme, 'the OS-level default colors are pushed to dark too').toBe('dark');
  expect(dark.canvas, 'the paper gets darker').not.toBe(light.canvas);
  expect(dark.text, 'the text gets brighter').not.toBe(light.text);
  expect(dark.sceneBackground, 'the 3D background darkens along with it').not.toBe(light.sceneBackground);
  expect(dark.ground, 'the neutral 3D ground follows too').not.toBe(light.ground);
  expect(dark.grid, 'the 3D grid follows too').not.toBe(light.grid);
});

test('the chosen theme survives a reload', async ({ page }) => {
  await themeButton(page).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');

  await page.reload();
  await expect(page.locator('#viewport')).toBeVisible();

  const after = await snapshot(page);
  expect(after.attr).toBe('dark');
  expect(after.sceneBackground, 'the 3D scene is dark right from startup').toBe('#101317');
});

test('a saved choice outweighs the OS setting', async ({ page }) => {
  // Even if the OS is dark, it opens in light when light was chosen
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(
    (key) => localStorage.setItem(key, JSON.stringify({ theme: 'light' })),
    UI_KEY,
  );
  await page.reload();
  await expect(page.locator('#viewport')).toBeVisible();

  expect((await snapshot(page)).attr).toBe('light');
});

test('with nothing saved it follows the OS setting', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate((key) => localStorage.removeItem(key), UI_KEY);
  await page.reload();
  await expect(page.locator('#viewport')).toBeVisible();

  expect((await snapshot(page)).attr).toBe('dark');
});

test('without an explicit choice, changing other settings keeps it following the OS', async ({ page }) => {
  // Leave the theme alone and switch only the language (which triggers a save)
  await page.locator('#sidebar-rail .rail-lang').click();
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}') as { theme?: string }, UI_KEY);
  expect(saved.theme, 'a theme that was never chosen is not baked into the save').toBeUndefined();

  // In that state, it follows along when the OS switches to dark
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
});

test('after an explicit choice it does not move when the OS changes', async ({ page }) => {
  await themeButton(page).click(); // explicitly light → dark
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');

  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(150);

  expect((await snapshot(page)).attr, 'the choice is not overwritten by the OS').toBe('dark');
});

test('the meadow theme stays daytime even in dark mode', async ({ page }) => {
  // **Look at the meadow in light first, then compare that dark matches it.**
  // Pinning concrete colors would make the value depend on whether the grass texture (optional to fetch)
  // is present, producing a test that only passes locally
  await page.locator('#world-controls .display-tools button').first().click(); // ground: to meadow
  const lightSnapshot = await snapshot(page);
  const lightGrass = lightSnapshot.ground;
  const lightGrid = lightSnapshot.grid;

  await themeButton(page).click();

  const dark = await snapshot(page);
  expect(dark.attr).toBe('dark');
  expect(dark.ground, 'how the grass looks does not change with the theme').toBe(lightGrass);
  expect(dark.grid, 'the meadow grid does not change with the theme either').toBe(lightGrid);
  const skyVisible = await page.evaluate(() => {
    let visible = false;
    window.__bs.ctx.scene.traverse((o) => {
      const mesh = o as unknown as { geometry?: { type?: string }; visible?: boolean };
      if (mesh.geometry?.type === 'SphereGeometry') visible = !!mesh.visible;
    });
    return visible;
  });
  expect(skyVisible, 'the sky stays visible').toBe(true);
});
