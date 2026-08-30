import { expect, test } from '@playwright/test';
import { zipSync } from 'fflate';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

test('imports a resource pack into IndexedDB, restores it after reload, and removes it', async ({ page }) => {
  await page.goto('/');
  const archive = zipSync({
    'sample-pack/textures/blocks/stone.png': ONE_PIXEL_PNG,
    'sample-pack/textures/blocks/grass_top.png': ONE_PIXEL_PNG,
    'sample-pack/textures/items/unrelated.png': ONE_PIXEL_PNG,
  });

  await page.locator('input[type="file"][accept*=".mcpack"]').setInputFiles({
    name: 'sample.mcpack',
    mimeType: 'application/zip',
    buffer: Buffer.from(archive),
  });

  await expect(page.locator('.texture-pack-status')).toHaveText(/^(2 loaded|2件読込済み)$/);
  await expect(page.locator('.texture-pack-remove')).toBeVisible();

  await page.reload();
  await expect(page.locator('.texture-pack-status')).toHaveText(/^(2 loaded|2件読込済み)$/);

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.texture-pack-remove').click();
  await expect(page.locator('.texture-pack-status')).toHaveText(/^(Flat fallback|未読込時はフラット)$/);
  await expect(page.locator('.texture-pack-remove')).toHaveCount(0);
});
