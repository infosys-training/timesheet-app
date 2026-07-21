import { defineConfig, devices } from '@playwright/test';

/**
 * E2E tests for the timesheet app.
 * Backend runs on :3001, frontend (Vite) on :5173.
 * Playwright starts both servers automatically via the webServer config.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    video: 'on',
    screenshot: 'only-on-failure',
    // Optional slow-motion for demos/recordings: PW_SLOWMO=350 npm run test:headed
    launchOptions: { slowMo: Number(process.env.PW_SLOWMO) || 0 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'npm run dev --prefix ../backend',
      port: 3001,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'npm run dev --prefix ../frontend',
      port: 5173,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
