import { test, expect } from '@playwright/test';

const API_URL = 'http://localhost:3001';
const TEST_EMAIL = 'e2e-test@example.com';
const CLIENT_NAME = 'E2E Test Client';
const WORK_ENTRY = {
  hours: '4',
  description: 'E2E test work entry',
};
const UPDATED_WORK_ENTRY = {
  hours: '6',
  description: 'E2E test work entry - updated',
};

test.describe('Work Entries Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email Address').fill(TEST_EMAIL);
    await page.getByRole('button', { name: 'Log In' }).click();
    await page.waitForURL('**/dashboard');
    await expect(page.getByText(TEST_EMAIL)).toBeVisible();
  });

  test.afterEach(async ({ request }) => {
    await request.delete(`${API_URL}/api/clients`, {
      headers: { 'x-user-email': TEST_EMAIL },
    });
  });

  test('full CRUD workflow: create client, add work entry, verify, edit, delete', async ({ page }) => {
    // Step 1: Create a client (prerequisite for work entries)
    await page.getByRole('button', { name: 'Clients' }).click();
    await page.waitForURL('**/clients');
    await page.getByRole('button', { name: 'Add Client' }).click();

    const clientDialog = page.getByRole('dialog');
    await expect(clientDialog).toBeVisible();
    await clientDialog.getByLabel('Client Name').fill(CLIENT_NAME);
    await clientDialog.getByRole('button', { name: 'Create' }).click();
    await expect(clientDialog).not.toBeVisible();
    await expect(page.getByRole('cell', { name: CLIENT_NAME }).first()).toBeVisible();

    // Step 2: Navigate to Work Entries and create a new entry
    await page.getByRole('button', { name: 'Work Entries' }).click();
    await page.waitForURL('**/work-entries');
    await page.getByRole('button', { name: 'Add Work Entry' }).click();

    const entryDialog = page.getByRole('dialog');
    await expect(entryDialog).toBeVisible();

    // Select client from MUI Select dropdown (role=combobox)
    await entryDialog.getByRole('combobox').click();
    await page.getByRole('option', { name: CLIENT_NAME }).click();

    // Fill hours
    await entryDialog.getByLabel('Hours').fill(WORK_ENTRY.hours);

    // Fill description
    await entryDialog.getByLabel('Description').fill(WORK_ENTRY.description);

    // Submit
    await entryDialog.getByRole('button', { name: 'Create' }).click();
    await expect(entryDialog).not.toBeVisible();

    // Step 3: Verify the work entry appears in the list
    await expect(page.getByText(CLIENT_NAME)).toBeVisible();
    await expect(page.getByText(`${WORK_ENTRY.hours} hours`)).toBeVisible();
    await expect(page.getByText(WORK_ENTRY.description)).toBeVisible();

    // Step 4: Edit the work entry
    const entryRow = page.getByRole('row').filter({ hasText: CLIENT_NAME });
    // Click the edit button (first icon button in the actions cell)
    await entryRow.locator('button').first().click();

    const editDialog = page.getByRole('dialog');
    await expect(editDialog).toBeVisible();
    await expect(editDialog.getByText('Edit Work Entry')).toBeVisible();

    // Update hours
    await editDialog.getByLabel('Hours').clear();
    await editDialog.getByLabel('Hours').fill(UPDATED_WORK_ENTRY.hours);

    // Update description
    await editDialog.getByLabel('Description').clear();
    await editDialog.getByLabel('Description').fill(UPDATED_WORK_ENTRY.description);

    await editDialog.getByRole('button', { name: 'Update' }).click();
    await expect(editDialog).not.toBeVisible();

    // Verify updated values
    await expect(page.getByText(`${UPDATED_WORK_ENTRY.hours} hours`)).toBeVisible();
    await expect(page.getByText(UPDATED_WORK_ENTRY.description)).toBeVisible();

    // Step 5: Delete the work entry
    page.on('dialog', (dialog) => dialog.accept());
    const updatedRow = page.getByRole('row').filter({ hasText: CLIENT_NAME });
    // Click the delete button (second icon button in the actions cell)
    await updatedRow.locator('button').nth(1).click();

    // Verify the entry is removed
    await expect(page.getByText(UPDATED_WORK_ENTRY.description)).not.toBeVisible();
    await expect(
      page.getByText('No work entries found. Add your first work entry to get started.')
    ).toBeVisible();
  });
});
