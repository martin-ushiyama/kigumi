import { expect, test } from '@playwright/test';

test('small screens show the desktop requirement instead of an unusable editor', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const guidance = page.locator('#mobile-guidance');
  await expect(guidance).toBeVisible();
  await expect(guidance).toHaveAttribute('role', 'dialog');
  await expect(guidance).toHaveAttribute('aria-modal', 'true');
  await expect(guidance.locator('h1')).toHaveText('PCで開いてください');
  await expect(guidance).toContainText('スマートフォンには対応していません');

  const box = (await guidance.boundingBox())!;
  expect(box).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  expect(await guidance.evaluate((el) => getComputedStyle(el).zIndex)).toBe('1000');
});

test('desktop screens keep the guidance out of the editor', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');

  await expect(page.locator('#mobile-guidance')).toBeHidden();
  await expect(page.locator('#viewport')).toBeVisible();
});
