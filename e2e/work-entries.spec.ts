import { test, expect } from '@playwright/test';

const TEST_EMAIL = 'e2e-test@example.com';
const CLIENT_NAME = 'E2E Test Client';

test.describe('Work Entries Workflow', () => {
  test.describe.configure({ mode: 'serial' });

  /** Helper: login and wait for dashboard */
  async function login(page: import('@playwright/test').Page) {
    await page.goto('/login');
    await page.getByLabel('Email Address').fill(TEST_EMAIL);
    await page.getByRole('button', { name: 'Log In' }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10000 });
  }

  /** Helper: click a sidebar nav item */
  async function navigateTo(page: import('@playwright/test').Page, name: string) {
    const nav = page.locator('nav');
    await nav.getByRole('button', { name }).click();
  }

  test('Step 1: Login with email', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Time Tracker' })).toBeVisible();

    await page.getByLabel('Email Address').fill(TEST_EMAIL);
    await page.getByRole('button', { name: 'Log In' }).click();

    // Should redirect to dashboard after login
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test('Step 2: Create a client (prerequisite for work entries)', async ({ page }) => {
    await login(page);

    // Navigate to Clients page
    await navigateTo(page, 'Clients');
    await expect(page).toHaveURL(/\/clients/);
    await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();

    // Click "Add Client" button
    await page.getByRole('button', { name: /Add Client/i }).click();

    // Fill in client form dialog
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByLabel('Client Name *').fill(CLIENT_NAME);
    await page.getByLabel('Description').fill('Client for E2E testing');

    // Submit
    await page.getByRole('button', { name: 'Create' }).click();

    // Verify client appears in the table
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('cell', { name: CLIENT_NAME }).first()).toBeVisible();
  });

  test('Step 3: Create a work entry and verify it appears in the list', async ({ page }) => {
    await login(page);

    // Navigate to Work Entries page
    await navigateTo(page, 'Work Entries');
    await expect(page).toHaveURL(/\/work-entries/);
    await expect(page.getByRole('heading', { name: 'Work Entries', exact: true })).toBeVisible();

    // Click "Add Work Entry" button
    await page.getByRole('button', { name: /Add Work Entry/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    // Select client from the dropdown (MUI Select)
    const dialog = page.getByRole('dialog');
    await dialog.locator('.MuiSelect-select').click();
    await page.getByRole('option', { name: CLIENT_NAME }).click();

    // Fill in hours
    await dialog.getByLabel('Hours *').fill('4');

    // Fill in description
    await dialog.getByLabel('Description').fill('E2E test work entry');

    // Submit the form
    await dialog.getByRole('button', { name: 'Create' }).click();

    // Verify dialog closes and entry appears in the table
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('cell', { name: CLIENT_NAME }).first()).toBeVisible();
    await expect(page.getByText('4 hours').first()).toBeVisible();
    await expect(page.getByText('E2E test work entry').first()).toBeVisible();
  });

  test('Step 4: Edit the work entry', async ({ page }) => {
    await login(page);

    // Navigate to Work Entries
    await navigateTo(page, 'Work Entries');
    await expect(page).toHaveURL(/\/work-entries/);
    await expect(page.getByRole('heading', { name: 'Work Entries', exact: true })).toBeVisible();

    // Wait for entries to load
    await expect(page.getByText('E2E test work entry')).toBeVisible({ timeout: 10000 });

    // Click the edit button on our work entry row
    const entryRow = page.getByRole('row').filter({ hasText: 'E2E test work entry' });
    await entryRow.getByRole('button').filter({ has: page.locator('[data-testid="EditIcon"]') }).click();

    // Wait for dialog
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Edit Work Entry')).toBeVisible();

    // Update the hours
    const hoursField = dialog.getByLabel('Hours *');
    await hoursField.clear();
    await hoursField.fill('6');

    // Update the description
    const descField = dialog.getByLabel('Description');
    await descField.clear();
    await descField.fill('E2E test work entry - updated');

    // Submit
    await dialog.getByRole('button', { name: 'Update' }).click();

    // Verify dialog closes and updated entry appears
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText('6 hours')).toBeVisible();
    await expect(page.getByText('E2E test work entry - updated')).toBeVisible();
  });

  test('Step 5: Delete the work entry', async ({ page }) => {
    await login(page);

    // Navigate to Work Entries
    await navigateTo(page, 'Work Entries');
    await expect(page).toHaveURL(/\/work-entries/);
    await expect(page.getByRole('heading', { name: 'Work Entries', exact: true })).toBeVisible();

    // Wait for entries to load
    await expect(page.getByText('E2E test work entry - updated')).toBeVisible({ timeout: 10000 });

    // Set up dialog handler for window.confirm
    page.on('dialog', async (dialog) => {
      expect(dialog.type()).toBe('confirm');
      await dialog.accept();
    });

    // Click the delete button on our work entry row
    const entryRow = page.getByRole('row').filter({ hasText: 'E2E test work entry - updated' });
    await entryRow.getByRole('button').filter({ has: page.locator('[data-testid="DeleteIcon"]') }).click();

    // Verify the entry is removed
    await expect(page.getByText('E2E test work entry - updated')).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText('No work entries found')).toBeVisible();
  });
});
