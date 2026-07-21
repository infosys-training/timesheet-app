import { test, expect } from '@playwright/test';
import {
  login,
  TEST_EMAIL,
  CLIENT_NAME,
  ENTRIES,
  EXPECTED_TOTAL_HOURS,
  EXPECTED_ENTRY_COUNT,
} from './helpers';

// The workflows are dependent (client -> work entry -> report), so run serially.
test.describe.serial('Timesheet core user workflows', () => {
  test('1. Login flow', async ({ page }) => {
    await login(page);
    // The logged-in user's email is shown in the top bar.
    await expect(page.getByText(TEST_EMAIL)).toBeVisible();
  });

  test('2. Create a client', async ({ page }) => {
    await login(page);
    await page.getByRole('button', { name: 'Clients', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Clients', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Add Client' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Add New Client')).toBeVisible();
    await dialog.getByLabel('Client Name').fill(CLIENT_NAME);
    await dialog.getByLabel('Department').fill('Engineering');
    await dialog.getByLabel('Email').fill('contact@acme.com');
    await dialog.getByLabel('Description').fill('Primary client for E2E tests');
    await dialog.getByRole('button', { name: 'Create' }).click();

    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole('cell', { name: CLIENT_NAME, exact: true })
    ).toBeVisible();
  });

  test('3. Create a work entry for that client', async ({ page }) => {
    await login(page);
    await page.getByRole('button', { name: 'Work Entries', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Work Entries', exact: true })).toBeVisible();

    for (const entry of ENTRIES) {
      await page.getByRole('button', { name: 'Add Work Entry' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText('Add New Work Entry')).toBeVisible();

      // Select the client from the MUI dropdown (rendered as a combobox).
      await dialog.getByRole('combobox').click();
      await page.getByRole('option', { name: CLIENT_NAME }).click();

      await dialog.getByLabel('Hours').fill(String(entry.hours));
      await dialog.getByLabel('Description').fill(entry.description);
      // Date defaults to today, which is valid.
      await dialog.getByRole('button', { name: 'Create' }).click();
      await expect(dialog).toBeHidden();
    }
  });

  test('4. Work entries appear in the list', async ({ page }) => {
    await login(page);
    await page.getByRole('button', { name: 'Work Entries', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Work Entries', exact: true })).toBeVisible();

    for (const entry of ENTRIES) {
      const row = page.getByRole('row').filter({ hasText: entry.description });
      await expect(row).toBeVisible();
      await expect(row.getByText(CLIENT_NAME)).toBeVisible();
      await expect(row.getByText(`${entry.hours} hours`)).toBeVisible();
    }
  });

  test('5. Reports page shows correct totals', async ({ page }) => {
    await login(page);
    await page.getByRole('button', { name: 'Reports', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();

    await page.getByRole('combobox').click();
    await page.getByRole('option', { name: CLIENT_NAME }).click();

    // Total Hours card
    const totalHoursCard = page
      .locator('.MuiCard-root')
      .filter({ hasText: 'Total Hours' });
    await expect(totalHoursCard).toContainText(EXPECTED_TOTAL_HOURS.toFixed(2));

    // Total Entries card
    const totalEntriesCard = page
      .locator('.MuiCard-root')
      .filter({ hasText: 'Total Entries' });
    await expect(totalEntriesCard).toContainText(String(EXPECTED_ENTRY_COUNT));

    // Every entry is listed in the report table.
    for (const entry of ENTRIES) {
      await expect(
        page.getByRole('row').filter({ hasText: entry.description })
      ).toBeVisible();
    }
  });
});
