import { expect, test } from '@playwright/test';

test.use({
  storageState: {
    cookies: [],
    origins: [
      {
        origin: 'http://localhost:4319',
        localStorage: [{ name: 'blocksmith.ui.v1', value: '{"lang":"ja"}' }],
      },
    ],
  },
});

test('shows once, stays dismissed, and can be replayed from Help', async ({ page }) => {
  await page.goto('/');

  const tour = page.getByRole('dialog', { name: 'クイックツアー' });
  await expect(tour).toBeVisible();
  await expect(tour.getByRole('heading', { name: 'ブロックからはじめる' })).toBeVisible();
  await tour.getByRole('button', { name: '次へ' }).click();
  await expect(tour.getByRole('heading', { name: 'くり返しを、かんたんに' })).toBeVisible();
  await tour.getByRole('button', { name: 'スキップ' }).click();
  await expect(tour).toBeHidden();

  await page.reload();
  await expect(tour).toBeHidden();

  await page.keyboard.press('h');
  await page.getByRole('button', { name: 'クイックツアーを見る' }).click();
  await expect(tour).toBeVisible();
  await expect(tour.getByRole('heading', { name: 'ブロックからはじめる' })).toBeVisible();
});
