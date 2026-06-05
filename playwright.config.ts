import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on',
    video: 'on',
    screenshot: 'on',
    actionTimeout: 15000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
  webServer: [
    {
      command: 'cd backend && npm run dev',
      port: 3001,
      reuseExistingServer: true,
      timeout: 30000,
    },
    {
      command: 'cd frontend && npm run dev',
      port: 5173,
      reuseExistingServer: true,
      timeout: 30000,
    },
  ],
});
