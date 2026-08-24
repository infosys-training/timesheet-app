---
name: testing-timesheet-app
description: How to run and end-to-end test the timesheet-app locally (servers, email-only auth, approver role config, in-memory DB caveats).
---

# Testing timesheet-app locally

## Services
- Backend: `cd backend && npm run dev` → http://localhost:3001 (health: `/health`)
- Frontend: `cd frontend && npm run dev` → http://localhost:5173 (Vite proxies `/api` → :3001)
- SQLite is **in-memory**: every backend restart wipes all users/clients/entries. Plan test data
  creation after the last restart, and never restart mid-scenario.

## Auth
Email-only. On `/login` type any email → user is auto-created. The frontend stores it in
`localStorage.userEmail` and sends it as the `x-user-email` header on every request.
Logout button is in the top-right app bar. For API probes just pass `-H "x-user-email: someone@example.com"`.

## Approver / role config (important gotcha)
Role is derived from the `APPROVER_EMAILS` env var (comma-separated) in `backend/src/middleware/auth.js`
and reconciled on every authenticated request plus at login.

`backend/src/server.js` loads `dotenv` at the top, so `backend/.env` works:

```bash
echo 'APPROVER_EMAILS=approver@example.com' >> backend/.env && cd backend && npm run dev
```

Exporting the variable into the process (`APPROVER_EMAILS=... npm run dev`) works too.

Verify before testing: `curl -s -H "x-user-email: approver@example.com" localhost:3001/api/work-entries/pending`
should return `{"workEntries":[...]}`; a `403 Approver role required` means the value never reached the
process — check that the `.env` line has no quotes/trailing spaces and that the backend was restarted
after editing it.

The frontend only refreshes `user.role` on login / `GET /api/auth/me`, so after changing
`APPROVER_EMAILS` (and restarting the backend) you must log out and back in for the
sidebar "Approvals" item to appear/disappear.

## Approval workflow UI paths
- Employee: Clients → Add Client (needed first; Work Entries page blocks entry creation without a
  client) → Work Entries → Add Work Entry → row shows a Status chip (`draft`) and a `Submit` button.
- Approved rows have edit/delete icon buttons disabled; rejected rows show the rejection reason as a
  MUI Tooltip on the Description cell (hover it to capture the reason).
- Approver: sidebar "Approvals" → `/approvals` (Pending Approvals) with Approve / Reject
  (reason dialog). The pending list is **global across all users**, which is expected.
- Employees hitting `/approvals` directly get an info alert "You do not have permission to view
  pending approvals." (route is not blocked, only the API is).

## Devin Secrets Needed
None — auth is email-only and no external services are involved.
