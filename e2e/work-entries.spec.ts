import { test, expect } from '@playwright/test';

const TEST_EMAIL = 'e2e-test@example.com';
const CLIENT_NAME = 'E2E Test Client';

test.describe('Work Entries Workflow', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email Address').fill(TEST_EMAIL);
    await page.getByRole('button', { name: 'Log In' }).click();
    await page.waitForURL('**/dashboard');
  });

  test('full CRUD lifecycle: create, verify, edit, and delete a work entry', async ({ page }) => {
    // --- Step 1: Create a client (prerequisite for work entries) ---
    await page.getByRole('button', { name: 'Clients' }).click();
    await page.waitForURL('**/clients');

    await page.getByRole('button', { name: 'Add Client' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByLabel('Client Name').fill(CLIENT_NAME);
    await page.getByRole('dialog').getByLabel('Description').fill('Client for E2E testing');
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    await expect(page.getByRole('cell', { name: CLIENT_NAME }).first()).toBeVisible();

    // --- Step 2: Navigate to Work Entries and create an entry ---
    await page.getByRole('button', { name: 'Work Entries' }).click();
    await page.waitForURL('**/work-entries');

    await page.getByRole('button', { name: 'Add Work Entry' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    // MUI Select: click the combobox to open the dropdown, pick the first matching option
    await page.getByRole('dialog').getByRole('combobox').click();
    await page.getByRole('option', { name: CLIENT_NAME }).first().click();

    // Fill hours
    await page.getByRole('dialog').getByRole('spinbutton', { name: 'Hours' }).fill('4');

    // Fill description
    await page.getByRole('dialog').getByRole('textbox', { name: 'Description' }).fill('Initial E2E test work entry');

    // Submit
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    // --- Step 3: Verify the work entry appears in the list ---
    await expect(page.getByText(CLIENT_NAME).first()).toBeVisible();
    await expect(page.getByText('4 hours')).toBeVisible();
    await expect(page.getByText('Initial E2E test work entry')).toBeVisible();

    // --- Step 4: Edit the work entry ---
    const entryRow = page.getByRole('row').filter({ hasText: CLIENT_NAME });
    await entryRow.getByRole('button').filter({ has: page.locator('[data-testid="EditIcon"]') }).click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Edit Work Entry')).toBeVisible();

    // Update hours
    const hoursInput = page.getByRole('dialog').getByRole('spinbutton', { name: 'Hours' });
    await hoursInput.clear();
    await hoursInput.fill('6');

    // Update description
    const descriptionInput = page.getByRole('dialog').getByRole('textbox', { name: 'Description' });
    await descriptionInput.clear();
    await descriptionInput.fill('Updated E2E test work entry');

    await page.getByRole('dialog').getByRole('button', { name: 'Update' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    // Verify updated values
    await expect(page.getByText('6 hours')).toBeVisible();
    await expect(page.getByText('Updated E2E test work entry')).toBeVisible();

    // --- Step 5: Delete the work entry ---
    page.on('dialog', (dialog) => dialog.accept());

    const updatedRow = page.getByRole('row').filter({ hasText: CLIENT_NAME });
    await updatedRow.getByRole('button').filter({ has: page.locator('[data-testid="DeleteIcon"]') }).click();

    await expect(page.getByText('Updated E2E test work entry')).toBeHidden();
    await expect(page.getByText('No work entries found')).toBeVisible();
  });
});
