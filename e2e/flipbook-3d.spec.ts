import { expect, test, type Page } from '@playwright/test';

/**
 * Cutting out the first frame on the 3D side (the fifth consumer).
 *
 * The UI side (background images / `<img>`) is covered by `flipbook-first-frame.spec.ts`. 3D is a separate path
 * where `voxelmesh.ts` sets `repeat` / `offset` on a three.js texture, and **the vertical direction is inverted
 * compared with CSS** (flipY). The UI-side tests stay green even if this path passes everything through untouched.
 *
 * The PNGs are gitignored and absent in CI, so fetching them is stubbed out. The frame count comes from
 * `texture-frames.json`, so the contents of the returned image do not affect the result.
 */

const AUTOSAVE_KEY = 'blocksmith.project.autosave.v1';

const STUB_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function stubTextures(page: Page): Promise<void> {
  await page.route('**/textures/blocks/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: STUB_PNG }),
  );
}

/** Places one block with an animated texture and one without */
async function seed(page: Page): Promise<void> {
  const ids = await page.evaluate(() => ({
    animated: window.__bs.CATALOG.find((b) => b.id === 'minecraft:crimson_stem')?.id ?? null,
    plain: window.__bs.CATALOG.find((b) => b.id === 'minecraft:stone')?.id ?? null,
  }));
  expect(ids.animated).not.toBeNull();
  expect(ids.plain).not.toBeNull();

  await page.evaluate(
    ({ key, animated, plain }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          app: 'blocksmith',
          version: 2,
          name: 'flipbook-3d',
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

/**
 * Collects the vertical repeat / offset of textures from the materials in the scene.
 *
 * `BlockTypeMesh` is internal, so it is left alone and the **materials actually used for rendering** are walked
 * from the scene instead (the values used for display are the source of truth).
 */
async function textureUv(page: Page): Promise<{ url: string; repeatY: number; offsetY: number }[]> {
  return page.evaluate(async () => {
    // Texture loading is asynchronous. Wait until material.map is populated
    const deadline = Date.now() + 5000;
    const collect = (): { url: string; repeatY: number; offsetY: number }[] => {
      const out: { url: string; repeatY: number; offsetY: number }[] = [];
      window.__bs.ctx.scene.traverse((obj: { material?: unknown }) => {
        const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
        for (const m of mats as { map?: { image?: { src?: string }; repeat: { y: number }; offset: { y: number } } }[]) {
          if (!m.map?.image?.src) continue;
          out.push({ url: m.map.image.src, repeatY: m.map.repeat.y, offsetY: m.map.offset.y });
        }
      });
      return out;
    };
    let found = collect();
    while (found.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      found = collect();
    }
    return found;
  });
}

test('3D: an animated texture has its UV shrunk to just the first frame', async ({ page }) => {
  await stubTextures(page);
  await page.goto('/');
  await seed(page);

  const uvs = await textureUv(page);
  const animated = uvs.filter((u) => u.url.includes('crimson_log_side'));
  expect(animated.length, 'the crimson texture is loaded into the 3D scene').toBeGreaterThan(0);

  for (const u of animated) {
    // There are 5 frames, so vertically it is 1/5. With flipY = true the top frame sits at offset 4/5
    expect(u.repeatY).toBeCloseTo(0.2, 5);
    expect(u.offsetY).toBeCloseTo(0.8, 5);
  }
});

test('3D: a normal texture stays at unit scale (it is not distorted by being treated as animated)', async ({ page }) => {
  await stubTextures(page);
  await page.goto('/');
  await seed(page);

  const uvs = await textureUv(page);
  const plain = uvs.filter((u) => /\/stone\.png/.test(u.url));
  expect(plain.length, 'the stone texture is loaded into the 3D scene').toBeGreaterThan(0);

  for (const u of plain) {
    expect(u.repeatY).toBe(1);
    expect(u.offsetY).toBe(0);
  }
});

test('3D and CSS point in opposite vertical directions (so flipping only one of them is noticed)', async ({ page }) => {
  await stubTextures(page);
  await page.goto('/');
  await seed(page);

  const uvs = await textureUv(page);
  const animated = uvs.find((u) => u.url.includes('crimson_log_side'));
  expect(animated).toBeDefined();

  // In 3D the offset is non-zero (the origin is at the bottom, so it is pushed upward)
  expect(animated!.offsetY).toBeGreaterThan(0);

  // On the CSS side it stays at 0% (the origin is at the top). Equal values would mean one of them is flipped
  await page.getByRole('tab', { name: /Blocks|ブロック/ }).click();
  await page.locator('#palette .tabs button', { hasText: /Wood|木材/ }).first().click();
  const swatch = page.locator('.blocks .swatch[style*="crimson_log_side"]').first();
  await expect(swatch).toHaveCSS('background-position', '0% 0%');
});
