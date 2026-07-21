import { Page, expect } from '@playwright/test';

/** A unique email per test run so each run starts with an isolated dataset
 * (backend isolates data per x-user-email). */
export const TEST_EMAIL = `e2e-${Date.now()}@example.com`;

export const CLIENT_NAME = 'Acme Corporation';

/** Entries created during the run. Totals are derived from these. */
export const ENTRIES = [
  { hours: 8, description: 'Backend API development' },
  { hours: 2.5, description: 'Code review' },
];

export const EXPECTED_TOTAL_HOURS = ENTRIES.reduce((s, e) => s + e.hours, 0); // 10.5
export const EXPECTED_ENTRY_COUNT = ENTRIES.length;

/** Log in through the UI and land on the dashboard. */
export async function login(page: Page, email: string = TEST_EMAIL) {
  await page.goto('/login');
  await page.getByLabel('Email Address').fill(email);
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}
