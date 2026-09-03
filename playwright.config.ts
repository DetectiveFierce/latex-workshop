import { defineConfig, devices } from '@playwright/test';

const extendedBrowsers = process.env.E2E_ALL_BROWSERS === 'true';
const ipad = extendedBrowsers || process.env.E2E_IPAD === 'true';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github']] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173/latex-workshop/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    ...(extendedBrowsers ? [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }] : []),
    ...(ipad ? [{ name: 'ipad-webkit', use: { ...devices['iPad Pro 11'] } }] : []),
  ],
  expect: { timeout: 15_000 },
  timeout: 150_000,
});
