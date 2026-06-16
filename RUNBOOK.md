# Timesheet App — Incident Response Runbook

> **Owner:** Engineering Team
> **Last updated:** <!-- update on each revision -->
> **Application:** Employee Time Tracking App (Node.js/Express backend, React/Vite frontend, SQLite in-memory DB)

---

## Table of Contents

1. [General Triage Workflow](#1-general-triage-workflow)
2. [FM-1: Database — In-Memory Data Loss on Restart](#2-fm-1-database--in-memory-data-loss-on-restart)
3. [FM-2: Database — SQLite Connection / Query Errors](#3-fm-2-database--sqlite-connection--query-errors)
4. [FM-3: API — 5xx Internal Server Errors](#4-fm-3-api--5xx-internal-server-errors)
5. [FM-4: API — Rate Limiting (429 Too Many Requests)](#5-fm-4-api--rate-limiting-429-too-many-requests)
6. [FM-5: Authentication Failures](#6-fm-5-authentication-failures)
7. [FM-6: Memory Leaks / High Memory Usage](#7-fm-6-memory-leaks--high-memory-usage)
8. [FM-7: Report Generation Failures (CSV/PDF)](#8-fm-7-report-generation-failures-csvpdf)
9. [FM-8: Frontend Build / Startup Failures](#9-fm-8-frontend-build--startup-failures)
10. [FM-9: Dependency / npm Install Failures](#10-fm-9-dependency--npm-install-failures)
11. [FM-10: Docker Container Health Check Failures](#11-fm-10-docker-container-health-check-failures)
12. [Escalation Matrix](#12-escalation-matrix)
13. [Post-Incident Review Template](#13-post-incident-review-template)

---

## 1. General Triage Workflow

```
Alert received
  │
  ├─ 1. Acknowledge the incident (update status page / Slack channel)
  ├─ 2. Check health endpoint:  curl http://<host>:3001/health
  ├─ 3. Check application logs:  docker logs <container>  OR  journalctl -u timesheet-backend
  ├─ 4. Identify failure mode → jump to the relevant section below
  ├─ 5. Execute the response procedure
  ├─ 6. Verify recovery via health check script:  ./scripts/healthcheck.sh
  └─ 7. File a post-incident review (see §13)
```

### Key Endpoints Reference

| Endpoint | Method | Auth Required | Purpose |
|---|---|---|---|
| `/health` | GET | No | Application health check |
| `/api/auth/login` | POST | No | User login |
| `/api/auth/me` | GET | Yes (`x-user-email`) | Current user info |
| `/api/clients` | GET | Yes | List clients |
| `/api/work-entries` | GET | Yes | List work entries |
| `/api/reports/client/:id` | GET | Yes | Client report |
| `/api/reports/export/csv/:id` | GET | Yes | CSV export |
| `/api/reports/export/pdf/:id` | GET | Yes | PDF export |

---

## 2. FM-1: Database — In-Memory Data Loss on Restart

### Symptoms

- All user data (clients, work entries, users) disappears after a backend restart or deployment.
- Users report being logged in but seeing empty dashboards.
- API returns valid responses but with empty arrays.

### Root Cause

The application uses SQLite in-memory mode (`:memory:`). All data exists only in the process's memory and is destroyed when the process exits.

### Severity: P1 (production) / P4 (development)

### Response Procedure

1. **Confirm the data loss:**
   ```bash
   curl -s http://localhost:3001/api/clients -H "x-user-email: test@example.com" | jq '.clients | length'
   # Returns 0 if data was lost
   ```

2. **For development environments** — this is expected behavior. No action needed.

3. **For production — immediate mitigation:**
   - Switch to file-based SQLite by editing `backend/src/database/init.js`:
     ```js
     // Change:
     db = new sqlite3.Database(':memory:', ...);
     // To:
     db = new sqlite3.Database(process.env.DATABASE_PATH || './data/timesheet.db', ...);
     ```
   - Ensure the data directory exists and is writable:
     ```bash
     mkdir -p /app/data
     chown nodejs:nodejs /app/data
     ```
   - If using Docker, the `docker/Dockerfile` already configures file-based SQLite via `DATABASE_PATH=/app/data/timesheet.db`. Ensure a persistent volume is mounted:
     ```bash
     docker run -v timesheet-data:/app/data timesheet-app
     ```

4. **For production — long-term fix:**
   - Migrate to a production-grade database (PostgreSQL, MySQL).
   - Implement automated database backups.

### Prevention

- Never deploy with in-memory SQLite to production.
- Add a startup check that warns if `DATABASE_PATH` is not set in production.

---

## 3. FM-2: Database — SQLite Connection / Query Errors

### Symptoms

- API returns `500` with `{"error": "Database error"}` or `{"error": "Internal server error"}`.
- Logs show errors prefixed with `SQLITE_` (e.g., `SQLITE_BUSY`, `SQLITE_LOCKED`, `SQLITE_CORRUPT`).

### Root Cause

- **SQLITE_BUSY / SQLITE_LOCKED:** Concurrent write contention. SQLite allows only one writer at a time.
- **SQLITE_CORRUPT:** Database file corruption (disk failure, improper shutdown).
- **Connection null:** `getDatabase()` returns a stale or closed connection.

### Severity: P2

### Response Procedure

1. **Check logs for the specific SQLite error code:**
   ```bash
   grep "SQLITE_" /var/log/timesheet/*.log   # or docker logs
   ```

2. **For SQLITE_BUSY / SQLITE_LOCKED:**
   - Reduce concurrent request volume (check for runaway clients or load test in progress).
   - Verify no long-running transactions are blocking writes.
   - Consider adding `PRAGMA busy_timeout = 5000;` in `database/init.js` after DB creation:
     ```js
     database.run('PRAGMA busy_timeout = 5000');
     ```

3. **For SQLITE_CORRUPT (file-based only):**
   - Stop the application.
   - Attempt recovery: `sqlite3 /app/data/timesheet.db ".recover" | sqlite3 /app/data/timesheet_recovered.db`
   - Replace the corrupt file with the recovered copy.
   - If recovery fails, restore from the most recent backup.

4. **For null database connection:**
   - Restart the backend process. The `getDatabase()` singleton re-initializes on next call.
   ```bash
   # Docker
   docker restart timesheet-backend
   # systemd
   sudo systemctl restart timesheet-backend
   ```

5. **Verify recovery:**
   ```bash
   curl -s http://localhost:3001/health
   # Should return {"status":"OK", ...}
   ```

---

## 4. FM-3: API — 5xx Internal Server Errors

### Symptoms

- Multiple endpoints return HTTP 500.
- Frontend shows generic error messages or blank pages.
- Logs show unhandled exceptions in route handlers.

### Root Cause

- Uncaught exceptions in route handlers (e.g., null reference, malformed data).
- Database layer errors bubbling up.
- Dependency failures (PDFKit, csv-writer).

### Severity: P2

### Response Procedure

1. **Identify the failing endpoint and error:**
   ```bash
   # Check access logs for 500 responses
   grep " 500 " /var/log/timesheet/access.log | tail -20

   # Check error logs
   grep "Error:" /var/log/timesheet/error.log | tail -20
   ```

2. **Test each API group to isolate the failure:**
   ```bash
   # Health
   curl -s http://localhost:3001/health

   # Auth
   curl -s -X POST http://localhost:3001/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com"}'

   # Clients (auth required)
   curl -s http://localhost:3001/api/clients \
     -H "x-user-email: test@example.com"

   # Work entries
   curl -s http://localhost:3001/api/work-entries \
     -H "x-user-email: test@example.com"
   ```

3. **If all endpoints fail** — likely a database or middleware issue. See FM-2.

4. **If only report endpoints fail** — likely a PDFKit/csv-writer issue. See FM-7.

5. **If only a specific route fails:**
   - Check for recent code changes to that route file.
   - Check Joi validation schemas match the request payload.
   - Restart the backend and retest.

6. **Verify the error handler middleware is loaded** (in `server.js`, `app.use(errorHandler)` must come after all route registrations but before the 404 handler).

---

## 5. FM-4: API — Rate Limiting (429 Too Many Requests)

### Symptoms

- Users get HTTP 429 responses.
- Frontend shows "Too many requests" errors.
- Legitimate users are blocked.

### Root Cause

The global rate limiter allows 100 requests per 15-minute window per IP. A single power user or automated script can exhaust this quickly.

### Severity: P3

### Response Procedure

1. **Confirm rate limiting is the issue:**
   ```bash
   curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health
   # 429 = rate limited
   ```

2. **Identify the offending IP:**
   ```bash
   grep " 429 " /var/log/timesheet/access.log | awk '{print $1}' | sort | uniq -c | sort -rn | head
   ```

3. **Immediate relief — temporarily increase the limit:**
   - In `server.js`, adjust:
     ```js
     const limiter = rateLimit({
       windowMs: 15 * 60 * 1000,
       max: 500  // increased from 100
     });
     ```
   - Restart the backend.

4. **Block abusive IPs** at the reverse proxy / firewall level if applicable.

5. **Long-term — implement per-user rate limiting** instead of per-IP to avoid penalizing shared office IPs.

### Prevention

- Monitor 429 response rates.
- Implement separate rate limits for authentication vs. data endpoints.

---

## 6. FM-5: Authentication Failures

### Symptoms

- Users cannot log in — API returns 401 or frontend redirects to login repeatedly.
- `GET /api/auth/me` returns 401 or 404.
- Frontend clears `localStorage` and redirects to `/login` in a loop.

### Root Cause

- Missing `x-user-email` header (frontend not sending it).
- Invalid email format rejected by regex in `auth.js`.
- User record not found after in-memory DB restart (see FM-1).
- Frontend `localStorage` corrupted or cleared.

### Severity: P2

### Response Procedure

1. **Check if the health endpoint works (no auth needed):**
   ```bash
   curl -s http://localhost:3001/health
   ```

2. **Test login directly:**
   ```bash
   curl -s -X POST http://localhost:3001/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com"}'
   # Should return 200 or 201
   ```

3. **Test authenticated endpoint:**
   ```bash
   curl -s http://localhost:3001/api/auth/me \
     -H "x-user-email: test@example.com"
   ```

4. **If login returns 500** — database issue. See FM-2.

5. **If login works but frontend still loops:**
   - Open browser DevTools → Application → Local Storage.
   - Verify `userEmail` is stored correctly.
   - Check the Axios interceptor in `frontend/src/api/client.ts` is attaching the `x-user-email` header.
   - Check for CORS errors in the browser console (see CORS section below).

6. **CORS issues:**
   - Verify `FRONTEND_URL` in backend `.env` matches the actual frontend origin.
   - Check the browser console for `Access-Control-Allow-Origin` errors.
   ```bash
   # Verify CORS config
   grep FRONTEND_URL backend/.env
   ```

---

## 7. FM-6: Memory Leaks / High Memory Usage

### Symptoms

- Backend process memory usage grows steadily over time.
- Container gets OOM-killed.
- Responses become slow, then the process crashes.

### Root Cause

- **Unbounded in-memory SQLite:** Large datasets stored entirely in process memory.
- **Temp file accumulation:** CSV export creates temp files in `backend/temp/` that may not be cleaned up on error paths.
- **Event listener leaks:** Unclosed database connections or stream handlers.
- **Large PDF generation:** Very large reports hold all work entries in memory simultaneously.

### Severity: P2

### Response Procedure

1. **Check current memory usage:**
   ```bash
   # Process-level
   ps aux | grep "node src/server" | grep -v grep | awk '{print $6/1024 " MB"}'

   # Docker
   docker stats --no-stream timesheet-backend
   ```

2. **Check for temp file buildup:**
   ```bash
   ls -la backend/temp/ 2>/dev/null | wc -l
   du -sh backend/temp/ 2>/dev/null
   ```

3. **Clean up orphaned temp files:**
   ```bash
   find backend/temp/ -name "*.csv" -mmin +60 -delete
   ```

4. **If memory is critically high — restart the process:**
   ```bash
   docker restart timesheet-backend
   # or
   sudo systemctl restart timesheet-backend
   ```

5. **Profile memory (for investigation):**
   ```bash
   # Start Node with heap inspection
   node --inspect src/server.js
   # Attach Chrome DevTools to chrome://inspect and take heap snapshots
   ```

### Prevention

- Set container memory limits: `docker run --memory=512m`.
- Implement periodic temp file cleanup (cron job or startup routine).
- For large datasets, stream results instead of loading all into memory.
- Monitor process RSS via Prometheus / container metrics.

---

## 8. FM-7: Report Generation Failures (CSV/PDF)

### Symptoms

- CSV or PDF export endpoints return 500.
- Logs show `Error creating CSV` or PDFKit errors.
- Temp directory write failures.

### Root Cause

- The `backend/temp/` directory does not exist or is not writable.
- Disk full — temp files have accumulated.
- PDFKit crashes on very large reports (> 10,000 entries with page overflow).
- csv-writer dependency issue.

### Severity: P3

### Response Procedure

1. **Check temp directory:**
   ```bash
   ls -la backend/temp/ 2>/dev/null || echo "Directory does not exist"
   stat -f backend/temp/ 2>/dev/null  # check filesystem space
   ```

2. **Create temp directory if missing:**
   ```bash
   mkdir -p backend/temp
   chmod 755 backend/temp
   ```

3. **Check disk space:**
   ```bash
   df -h .
   ```

4. **Clean up old temp files:**
   ```bash
   find backend/temp/ -type f -mmin +60 -delete
   ```

5. **Test CSV export:**
   ```bash
   curl -s -o /dev/null -w "%{http_code}" \
     http://localhost:3001/api/reports/export/csv/1 \
     -H "x-user-email: test@example.com"
   ```

6. **Test PDF export:**
   ```bash
   curl -s -o /dev/null -w "%{http_code}" \
     http://localhost:3001/api/reports/export/pdf/1 \
     -H "x-user-email: test@example.com"
   ```

7. **If PDFKit crashes on large reports**, limit the number of entries per report or implement pagination.

---

## 9. FM-8: Frontend Build / Startup Failures

### Symptoms

- `npm run dev` fails with TypeScript or Vite errors.
- `npm run build` fails — production deployment blocked.
- Blank white page in the browser.

### Root Cause

- TypeScript compilation errors after code changes.
- Missing or mismatched dependency versions.
- Vite proxy misconfigured — `/api` requests not reaching backend.
- Environment variable `VITE_API_URL` misconfigured.

### Severity: P2 (production build) / P3 (development)

### Response Procedure

1. **Check for TypeScript errors:**
   ```bash
   cd frontend && npx tsc --noEmit
   ```

2. **Check for lint errors:**
   ```bash
   cd frontend && npm run lint
   ```

3. **Verify dependencies are installed:**
   ```bash
   cd frontend && npm ci
   ```

4. **Check Vite proxy config** in `frontend/vite.config.ts`:
   - The proxy should forward `/api` to `http://localhost:3001`.
   - Verify the backend is running on the expected port.

5. **For blank white page:**
   - Open browser DevTools → Console for JavaScript errors.
   - Check Network tab for failed API calls.
   - Verify CORS: backend `FRONTEND_URL` must match the frontend origin.

6. **For production build failures:**
   ```bash
   cd frontend && npm run build 2>&1 | head -50
   ```
   - Fix TypeScript errors before deploying.

---

## 10. FM-9: Dependency / npm Install Failures

### Symptoms

- `npm install` fails in backend or frontend.
- `sqlite3` native module compilation errors.
- npm registry unreachable.

### Root Cause

- **sqlite3:** Requires native compilation. Missing `python3`, `make`, `g++` on the system.
- **npm registry:** Network issues or registry outage.
- **Lock file conflicts:** `package-lock.json` conflicts after merge.

### Severity: P3

### Response Procedure

1. **For sqlite3 native build errors:**
   ```bash
   # Install build tools (Debian/Ubuntu)
   sudo apt-get update && sudo apt-get install -y python3 make g++

   # Alpine
   apk add --no-cache python3 make g++ gcc

   # Retry install
   cd backend && npm install
   ```

2. **For npm registry issues:**
   ```bash
   # Check registry connectivity
   npm ping

   # Check configured registry
   npm config get registry

   # Fallback to npm mirror if needed
   npm install --registry=https://registry.npmmirror.com
   ```

3. **For lock file conflicts:**
   ```bash
   rm -f package-lock.json
   npm install
   ```

4. **For Docker builds**, ensure the Dockerfile installs build dependencies in the builder stage (they are not needed in the production stage).

---

## 11. FM-10: Docker Container Health Check Failures

### Symptoms

- Container status shows `unhealthy`.
- `docker compose ps` shows restarts.
- Health check endpoint unreachable from inside the container.

### Root Cause

- Backend failed to start (port conflict, missing env vars, DB init error).
- Health check runs before the server is ready (`start-period` too short).
- Port mismatch between `EXPOSE`, `PORT` env var, and health check URL.

### Severity: P2

### Response Procedure

1. **Check container status and logs:**
   ```bash
   docker compose ps
   docker logs timesheet-backend --tail 50
   ```

2. **Test health check from inside the container:**
   ```bash
   docker exec timesheet-backend node -e \
     "require('http').get('http://localhost:3001/health', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{console.log(r.statusCode, d); process.exit(r.statusCode===200?0:1)}) })"
   ```

3. **Check environment variables:**
   ```bash
   docker exec timesheet-backend env | grep -E "PORT|NODE_ENV|DATABASE_PATH"
   ```

4. **If the server didn't start:**
   - Check for port conflicts: `docker exec timesheet-backend netstat -tlnp 2>/dev/null || ss -tlnp`
   - Check if database initialization failed in the logs.
   - Verify the `DATABASE_PATH` directory exists and is writable.

5. **Restart the container:**
   ```bash
   docker compose restart backend
   # or
   docker compose down && docker compose up -d
   ```

---

## 12. Escalation Matrix

| Severity | Response Time | Escalation Path | Communication |
|---|---|---|---|
| **P1** — Service down, data loss | 15 min | On-call → Engineering Lead → CTO | Status page update, Slack #incidents |
| **P2** — Major feature broken | 30 min | On-call → Engineering Lead | Slack #incidents |
| **P3** — Minor feature degraded | 4 hours | Assigned engineer | Slack #engineering |
| **P4** — Cosmetic / low impact | Next sprint | Backlog triage | GitHub Issue |

---

## 13. Post-Incident Review Template

After every P1/P2 incident, complete the following:

```markdown
## Post-Incident Review

**Incident ID:** INC-YYYY-NNN
**Date:** YYYY-MM-DD
**Duration:** HH:MM
**Severity:** P1/P2/P3/P4

### Summary
One-sentence description of what happened.

### Timeline
- HH:MM — Alert triggered / issue reported
- HH:MM — Acknowledged by <name>
- HH:MM — Root cause identified
- HH:MM — Fix deployed
- HH:MM — Recovery confirmed

### Root Cause
Technical explanation of why it happened.

### Impact
- Users affected: N
- Data lost: yes/no
- Revenue impact: $X

### Resolution
What was done to fix it.

### Action Items
- [ ] Action 1 — Owner — Due date
- [ ] Action 2 — Owner — Due date

### Lessons Learned
What went well, what didn't, what to improve.
```
