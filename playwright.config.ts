/// <reference types="node" />
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:4319',
    /**
     * **E2E runs against the Japanese UI**.
     *
     * The default language is English, but the existing specs write their locators
     * with Japanese labels, and that wording is also an asset that tells the reader
     * which operation is meant. Language switching itself is verified explicitly by
     * smoke.spec.ts, so everything else is pinned to JA to keep comparisons stable.
     * The setting comes from localStorage, so it is planted before the page loads.
     */
    storageState: {
      cookies: [],
      origins: [
        {
          origin: 'http://localhost:4319',
          localStorage: [
            { name: 'blocksmith.ui.v1', value: '{"lang":"ja"}' },
            { name: 'blocksmith.onboarding.v1', value: 'done' },
          ],
        },
      ],
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // 4319: a dedicated fixed port that avoids clashing with other long-running local services
    command: 'npm run preview -- --port 4319 --strictPort',
    url: 'http://localhost:4319',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
