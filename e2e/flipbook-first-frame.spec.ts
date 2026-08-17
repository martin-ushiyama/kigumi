import { expect, test, type Page } from '@playwright/test';

/**
 * The wiring that shows only the first frame of an animated texture (16xN stacked vertically).
 *
 * The frame-count computation itself is pinned down by the unit tests (tests/textureframe.test.ts).
 * What is checked here is **whether each piece of UI actually goes through that helper** — the palette,
 * the swatches, and the change picker use background images while the layers panel uses `<img>`, so if only
 * one of those paths passes everything through untouched, the computation tests still stay green.
 *
 * Whether the real PNG really has 5 frames is not verified here (that is what `gen-texture-frames` checks when
 * fetching). This only checks that the value the helper produced reached the DOM.
 */

const AUTOSAVE_KEY = 'blocksmith.project.autosave.v1';

/** A 1x1 transparent PNG. The contents do not matter — all that is needed is that loading succeeds */
const STUB_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Stubs out fetching the texture images.
 *
 * `public/textures/` is gitignored, so **CI has no PNGs**. Depending on the real files makes
 * `layers.ts` catch the load failure in its error handler and remove the `<img>`, which passes locally
 * (where the PNGs exist) and yields 0 elements in CI. The frame count comes from `texture-frames.json`,
 * so the contents of the image returned here do not affect the check — it only has to load successfully.
 */
async function stubTextures(page: Page): Promise<void> {
  await page.route('**/textures/blocks/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: STUB_PNG }),
  );
}

/** Places one block with an animated texture and one without */
async function seedAnimatedAndPlain(page: Page): Promise<void> {
  const ids = await page.evaluate(() => {
    const animated = window.__bs.CATALOG.find((b) => b.id === 'minecraft:crimson_stem');
    const plain = window.__bs.CATALOG.find((b) => b.id === 'minecraft:stone');
    return { animated: animated?.id ?? null, plain: plain?.id ?? null };
  });
  expect(ids.animated, 'crimson_stem is in the catalog').not.toBeNull();
  expect(ids.plain, 'stone is in the catalog').not.toBeNull();

  await page.evaluate(
    ({ key, animated, plain }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          app: 'blocksmith',
          version: 2,
          name: 'flipbook',
          blocks: [
            [0, 0, 0, animated, 0, -1],
            [2, 0, 0, plain, 0, -1],
          ],
          groups: [],
          recipes: [],
        }),
      );
    },
    { key: AUTOSAVE_KEY, animated: ids.animated, plain: ids.plain },
  );
  await page.reload();
}

/** The sidebar opens on the layers tab by default. The palette is not visible until it is opened */
async function openPalette(page: Page): Promise<void> {
  await page.getByRole('tab', { name: /Blocks|ブロック/ }).click();
  await expect(page.locator('#palette')).toBeVisible();
}

test('a palette swatch shows only the first frame instead of squashing the animated texture vertically', async ({ page }) => {
  await page.goto('/');
  await openPalette(page);

  // crimson (5 frames) lives in the wood category
  await page.locator('#palette .tabs button', { hasText: /Wood|木材/ }).first().click();

  const animated = page.locator('.blocks .swatch[style*="crimson_log_side"]').first();
  await expect(animated).toBeVisible();

  // Stretch vertically by 5 frames and show the top edge. Leaving it at cover would crop the middle
  await expect(animated).toHaveCSS('background-size', '100% 500%');
  await expect(animated).toHaveCSS('background-position', '0% 0%');
});

test('a normal texture stays at unit scale (it is not distorted by being treated as animated)', async ({ page }) => {
  await page.goto('/');
  await openPalette(page);

  // Pick one non-animated texture out of the default category (stone)
  const plain = page.locator('.blocks .swatch[style*="textures/blocks/stone.png"]').first();
  await expect(plain).toBeVisible();
  await expect(plain).toHaveCSS('background-size', '100% 100%');
});

test('the toolbar swatch also shows only the first frame (blockswatch.ts)', async ({ page }) => {
  await page.goto('/');
  await openPalette(page);

  // Choosing a block with an animated texture is reflected in the current block in the toolbar
  await page.locator('#palette .tabs button', { hasText: /Wood|木材/ }).first().click();
  await page.locator('.blocks .swatch[style*="crimson_log_side"]').first().click();

  const active = page.locator('#toolbar .block-swatch.active');
  await expect(active).toHaveAttribute('style', /crimson_log_side/);
  await expect(active).toHaveCSS('background-size', '100% 500%');
  await expect(active).toHaveCSS('background-position', '0% 0%');
});

test('the preview in the block change picker also shows only the first frame (blockchangepicker.ts)', async ({ page }) => {
  await page.goto('/');

  // Open the change picker from the toolbar swatch
  await page.locator('#toolbar .block-swatch.active').click();
  const picker = page.locator('#block-change-picker');
  await expect(picker).toBeVisible();

  const preview = picker.locator('.change-picker-block-preview[style*="crimson_log_side"]').first();
  await expect(preview).toHaveCount(1);
  // The CSS has a background-size: cover rule, so this also checks that the helper's inline value wins
  await expect(preview).toHaveCSS('background-size', '100% 500%');
});

test('the layer panel icons are cropped to the same frame count (img is a separate path from background images)', async ({ page }) => {
  // An img is removed when it fails to load (the fallback). Stub the fetch before opening
  // so that the result does not depend on whether the PNGs exist
  await stubTextures(page);
  await page.goto('/');
  await seedAnimatedAndPlain(page);

  const icons = page.locator('#layers .layer-block-icon img');
  await expect(icons).toHaveCount(2);

  // The animated one: cropped by the wrapper, with the img stretched by 5 frames
  const animatedIcon = page.locator('#layers .layer-block-icon img[src*="crimson_log_side"]');
  await expect(animatedIcon).toHaveCount(1);
  await expect(animatedIcon).toHaveCSS('height', /.+/);
  const heights = await animatedIcon.evaluate((img) => ({
    imgHeight: (img as HTMLImageElement).style.height,
    wrapperOverflow: (img.parentElement as HTMLElement).style.overflow,
  }));
  expect(heights.imgHeight).toBe('500%');
  expect(heights.wrapperOverflow).toBe('hidden');

  // The normal one: not stretched
  const plainIcon = page.locator('#layers .layer-block-icon img[src$="stone.png"]');
  await expect(plainIcon).toHaveCount(1);
  const plainHeight = await plainIcon.evaluate((img) => (img as HTMLImageElement).style.height);
  expect(plainHeight).toBe('');
});
