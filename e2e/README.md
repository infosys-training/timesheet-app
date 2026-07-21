# E2E Tests (Playwright)

End-to-end tests for the timesheet app covering the core user workflows:

1. Login flow
2. Create a client
3. Create a work entry for that client
4. Verify the work entry appears in the list
5. Reports page shows correct totals

## Running

```bash
cd e2e
npm install
npx playwright install chromium
npm test            # headless
npm run test:headed # headed (visible browser)
npm run report      # open the HTML report
```

Playwright automatically starts the backend (`:3001`) and frontend (`:5173`)
via the `webServer` config, so you do not need to start them manually.
Each run uses a unique login email, so its dataset is isolated in the
in-memory SQLite database.
