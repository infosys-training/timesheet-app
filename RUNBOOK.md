# Timesheet Application - Operational Runbook

**Last Updated:** 2026-05-26

> See `scripts/health-check.sh` for automated health verification.

---

## Table of Contents

- [Quick Reference](#quick-reference)
- [Section 1: Database Failures](#section-1-database-failures)
- [Section 2: API Errors (4xx/5xx)](#section-2-api-errors-4xx5xx)
- [Section 3: Memory Issues](#section-3-memory-issues)
- [Section 4: Rate Limiting Lockouts](#section-4-rate-limiting-lockouts)
- [Section 5: Authentication/JWT Failures](#section-5-authenticationjwt-failures)
- [Section 6: Startup Failures](#section-6-startup-failures)
- [Section 7: Frontend Unavailable](#section-7-frontend-unavailable)
- [Section 8: Export Failures (CSV/PDF)](#section-8-export-failures-csvpdf)
- [Contacts / Escalation](#contacts--escalation)

---

## Quick Reference

| Symptom | Section |
|---|---|
| 500 errors with "Database error" in responses | [Section 1: Database Failures](#section-1-database-failures) |
| All data disappeared after restart | [Section 1: Database Failures](#section-1-database-failures) |
| 400 Validation Error responses | [Section 2: API Errors](#section-2-api-errors-4xx5xx) |
| 401 Unauthorized responses | [Section 2: API Errors](#section-2-api-errors-4xx5xx) |
| 500 Internal Server Error | [Section 2: API Errors](#section-2-api-errors-4xx5xx) |
| 404 Route Not Found | [Section 2: API Errors](#section-2-api-errors-4xx5xx) |
| Slow responses, OOM kills | [Section 3: Memory Issues](#section-3-memory-issues) |
| 429 Too Many Requests | [Section 4: Rate Limiting Lockouts](#section-4-rate-limiting-lockouts) |
| All users getting 401, login broken | [Section 5: Authentication/JWT Failures](#section-5-authenticationjwt-failures) |
| Server exits immediately with code 1 | [Section 6: Startup Failures](#section-6-startup-failures) |
| Blank page, assets not loading | [Section 7: Frontend Unavailable](#section-7-frontend-unavailable) |
| 500 on CSV/PDF export endpoints | [Section 8: Export Failures](#section-8-export-failures-csvpdf) |

---

## Section 1: Database Failures

### Symptom

- HTTP 500 errors with `"Database error"` in JSON responses
- Server logs showing `SQLITE_` error codes

**Reference:** `backend/src/middleware/errorHandler.js` lines 12-18 — SQLite errors are caught when `err.code` starts with `SQLITE_` and returned as 500 with `{ error: "Database error" }`.

### 1.1 In-Memory Database Data Loss

The application uses an in-memory SQLite database by default (`backend/src/database/init.js` line 14: `:memory:`). **All data is wiped when the server process restarts.**

**Diagnosis steps:**

1. Check if the server recently restarted:
   ```bash
   pm2 logs          # if using pm2
   docker logs <container>  # if using Docker
   ```
2. Verify the database was initialized — `initializeDatabase()` is called in `server.js` lines 59-69 during `startServer()`. Check logs for `"Database tables created successfully"`.
3. If the application is empty after restart, this is expected behavior for the in-memory database.

**If production needs persistence:**

Switch to file-based SQLite by setting the `DATABASE_PATH` environment variable (see `docker/Dockerfile` line 59 for the Docker default: `/app/data/timesheet.db`). The Docker override at `docker/overrides/database/init.js` reads this variable to use a file-based database instead of `:memory:`.

### 1.2 SQLite File Corruption (Docker Mode)

When running in Docker with file-based SQLite:

1. Check the database file: `/app/data/timesheet.db`
2. Verify disk space on the mounted volume:
   ```bash
   df -h /app/data/
   ```
3. Check file permissions (the `nodejs` user with UID 1001 must own the file):
   ```bash
   ls -la /app/data/timesheet.db
   ```
4. If corrupted, restore from backup:
   ```bash
   cp /path/to/backup/timesheet.db /app/data/timesheet.db
   chown 1001:1001 /app/data/timesheet.db
   ```

### 1.3 Connection Issues

The singleton pattern in `init.js` (`getDatabase()` function) means a `null` `db` variable indicates no active connection. If the database connection is lost:

1. Check server logs for `"Error opening database"` messages.
2. Restart the service:
   ```bash
   pm2 restart timesheet    # pm2
   docker restart <container>  # Docker
   ```

---

## Section 2: API Errors (4xx/5xx)

### 2.1 400 Validation Errors

**Cause:** Joi schema validation failures.

**Reference:** `backend/src/validation/schemas.js` — defines schemas for clients, work entries, and email.

**Key validation rules:**
- `clientSchema`: `name` required (1-255 chars), `email` must be valid format
- `workEntrySchema`: `clientId` (positive integer), `hours` (positive, max 24), `date` (ISO format) all required
- `emailSchema`: valid email required

**Action:** Check request payloads against the schemas. This is a client-side issue, not a service failure. Review the `details` array in the error response for specific field errors.

### 2.2 401 Authentication Failures

**Cause:** Missing or invalid `x-user-email` header.

**Reference:** `backend/src/middleware/auth.js` lines 7-8 — the middleware checks for the `x-user-email` header and returns 401 if missing.

**Diagnosis steps:**

1. Verify the frontend is sending the `x-user-email` header with requests.
2. Check browser `localStorage` for the `userEmail` key:
   ```javascript
   // In browser console
   localStorage.getItem('userEmail')
   ```
3. If the header is present but the email format is invalid, a 400 is returned instead (line 13-14).
4. Ensure the user has logged in via `POST /api/auth/login` first.

### 2.3 500 Internal Server Errors

**Diagnosis steps:**

1. Check server logs for stack traces (`morgan` logs in `combined` format).
2. Common causes:
   - **Database unavailable** — see [Section 1](#section-1-database-failures)
   - **Disk full** — CSV/PDF exports write to disk; see [Section 8](#section-8-export-failures-csvpdf)
   - **Malformed data** — unexpected null values or type mismatches in database

### 2.4 404 Route Not Found

**Reference:** `server.js` lines 54-56 — catch-all handler returns 404 for unmatched routes.

**Diagnosis steps:**

1. Verify the request URL uses the correct API prefix: `/api/`
2. Valid route prefixes:
   - `/api/auth/` — authentication
   - `/api/clients/` — client management
   - `/api/work-entries/` — work entry management
   - `/api/reports/` — reporting and exports
3. The `/health` endpoint is at the root level (no `/api/` prefix).

---

## Section 3: Memory Issues

### Symptom

- Slow API responses
- OOM (Out of Memory) kills in Docker
- Increasing memory usage in process metrics

### 3.1 In-Memory SQLite Growth

The in-memory database grows with data volume since all tables and indexes reside in process memory.

**Monitoring:**
```javascript
// Check memory usage
console.log(process.memoryUsage());
```

**Mitigation:**
- If memory growth is unbounded, switch to file-based SQLite by setting `DATABASE_PATH` environment variable.
- Consider periodic data archival for long-running instances.

### 3.2 PDF Generation Memory Spikes

**Reference:** `backend/src/routes/reports.js` lines 186-240 — PDFKit creates document streams in memory.

Large reports (many work entries) can cause significant memory spikes during PDF generation.

**Mitigation:**
- Limit report date ranges or entry counts via request parameters.
- Add pagination to the report generation logic.
- Monitor memory before and after PDF generation requests.

### 3.3 Temp File Accumulation

**Reference:** `backend/src/routes/reports.js` lines 103-136 — CSV exports create temporary files in the `backend/temp/` directory. If `fs.unlink` fails (line 132-135), temp files accumulate.

**Cleanup:**
```bash
rm -rf backend/temp/*
```

**Prevention:** Add a periodic cleanup cron job or monitor the temp directory size.

---

## Section 4: Rate Limiting Lockouts

### Symptom

Users receiving HTTP 429 Too Many Requests responses.

### Details

**Reference:** `server.js` lines 26-29 — rate limiter is configured at **100 requests per 15-minute window** per IP address.

```javascript
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100
});
```

### Response Steps

1. **Identify affected IPs:** Check server logs (morgan `combined` format includes client IP).
2. **Wait for window expiry:** The 15-minute window resets automatically.
3. **Immediate relief:** Restart the service to reset the rate limiter state (all counters are in-memory).
4. **Adjust limits:** For persistent issues, modify the `max` value in `server.js` line 28.

---

## Section 5: Authentication/JWT Failures

### Symptom

All users getting 401 responses; login not working.

### 5.1 JWT Secret Missing or Changed

**Reference:** `README.md` lines 110-116 — the `JWT_SECRET` environment variable must be set in the backend `.env` file.

- If `JWT_SECRET` is not set, token generation/verification will fail.
- If `JWT_SECRET` is changed, **all existing tokens are invalidated** — all users must log in again.

**Diagnosis:**
```bash
# Check if JWT_SECRET is set
grep JWT_SECRET backend/.env
```

### 5.2 CORS Blocking Requests

**Reference:** `server.js` lines 20-23 — the `FRONTEND_URL` environment variable controls the allowed CORS origin.

```javascript
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));
```

- If `FRONTEND_URL` does not match the actual frontend origin, browsers will block requests with CORS errors.
- Check browser console for CORS-related error messages.

**Fix:**
```bash
# Update FRONTEND_URL to match the actual frontend URL
FRONTEND_URL=https://your-frontend-domain.com
```

---

## Section 6: Startup Failures

### Symptom

Server process exits immediately with exit code 1.

### Details

**Reference:** `server.js` lines 59-69 — `startServer()` calls `process.exit(1)` if initialization fails.

Check logs for the `"Failed to start server"` message, which includes the error details.

### Common Causes and Fixes

1. **Port 3001 already in use:**
   ```bash
   lsof -i :3001
   # Kill the conflicting process, or change PORT env var
   ```

2. **Database initialization failure:**
   - Check for SQLite library issues: `npm ls sqlite3`
   - Verify native bindings are compiled for the current platform
   - In Docker, ensure the `node_modules` were built inside the container

3. **Missing dependencies:**
   ```bash
   cd backend && npm install
   ```

4. **Wrong Node.js version:**
   ```bash
   node --version   # Requires Node.js 18+
   ```

---

## Section 7: Frontend Unavailable

### Symptom

Blank page in browser, static assets not loading, or connection refused on frontend port.

### 7.1 Docker / Production Mode

**Reference:** `docker/overrides/server.js` — in production, the frontend is served as static files from `/app/public`.

1. Verify build artifacts exist:
   ```bash
   ls -la /app/public/
   # Should contain index.html, assets/, etc.
   ```
2. If missing, the frontend build stage may have failed during Docker image creation.

### 7.2 Development Mode

The Vite dev server runs on port 5173.

1. Check if the dev server is running:
   ```bash
   lsof -i :5173
   ```
2. Start it if needed:
   ```bash
   cd frontend && npm run dev
   ```

### 7.3 CORS Issues

Check the browser developer console for CORS errors. Verify the `FRONTEND_URL` environment variable matches the frontend origin — see [Section 5.2](#52-cors-blocking-requests).

---

## Section 8: Export Failures (CSV/PDF)

### Symptom

HTTP 500 responses on `/api/reports/export/csv/:id` or `/api/reports/export/pdf/:id`.

### 8.1 CSV Export Failures

**Reference:** `backend/src/routes/reports.js` line 106 — CSV export requires a writable temp directory at `backend/temp/`.

**Diagnosis:**
1. Check disk space:
   ```bash
   df -h
   ```
2. Check directory permissions:
   ```bash
   ls -la backend/temp/
   ```
3. The directory is created automatically if it does not exist (line 109-112), but the parent directory must be writable.

### 8.2 PDF Export Failures

**Reference:** `backend/src/routes/reports.js` lines 186-240 — PDFKit streams the PDF directly to the HTTP response.

**Common causes:**
- Memory exhaustion for very large reports (many work entries).
- Stream errors if the client disconnects mid-download.

**Diagnosis:**
1. Check server logs for stack traces.
2. Monitor memory usage during PDF generation.
3. For large reports, consider limiting the date range or number of entries.

---

## Contacts / Escalation

| Role | Contact | Responsibility |
|---|---|---|
| On-Call Engineer | _TBD_ | First responder for P1/P2 incidents |
| Backend Lead | _TBD_ | Database, API, and server issues |
| Frontend Lead | _TBD_ | UI, build, and CORS issues |
| DevOps / Infrastructure | _TBD_ | Docker, deployment, and hosting |
| Engineering Manager | _TBD_ | Escalation for unresolved P1 incidents |

### Escalation Policy

1. **P1 (Critical):** Page on-call immediately. All hands until resolved. Post-incident review within 48 hours.
2. **P2 (Major):** Notify on-call within 15 minutes. Resolve within 4 hours.
3. **P3 (Minor):** Address during next business day.
4. **P4 (Low):** Add to backlog for next sprint.

> Use the GitHub issue templates in `.github/ISSUE_TEMPLATE/` to file incident reports.
