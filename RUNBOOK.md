# Timesheet App Incident Response Runbook

This document provides step-by-step procedures for diagnosing and resolving common failure modes in the Timesheet application.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Contact & Escalation](#contact--escalation)
- [INC-01: Application Not Starting](#inc-01-application-not-starting)
- [INC-02: Database Failures (SQLite)](#inc-02-database-failures-sqlite)
- [INC-03: Data Loss After Restart](#inc-03-data-loss-after-restart)
- [INC-04: API 500 Errors](#inc-04-api-500-errors)
- [INC-05: Authentication Failures](#inc-05-authentication-failures)
- [INC-06: Rate Limiting Blocking Users](#inc-06-rate-limiting-blocking-users)
- [INC-07: Report Generation Failures (CSV/PDF)](#inc-07-report-generation-failures-csvpdf)
- [INC-08: Frontend Not Loading / Blank Page](#inc-08-frontend-not-loading--blank-page)
- [INC-09: High Memory Usage / Memory Leaks](#inc-09-high-memory-usage--memory-leaks)
- [INC-10: Disk Space Exhaustion](#inc-10-disk-space-exhaustion)
- [INC-11: Docker Container Failures](#inc-11-docker-container-failures)
- [INC-12: Dependency / npm Install Failures](#inc-12-dependency--npm-install-failures)
- [INC-13: CORS Errors](#inc-13-cors-errors)
- [INC-14: Slow Response Times](#inc-14-slow-response-times)

---

## Architecture Overview

```
┌─────────────┐       ┌──────────────┐       ┌─────────────────┐
│  Frontend   │──────>│  API Gateway │──────>│  SQLite (in-mem) │
│  React/Vite │       │  Express     │       │  or file-based   │
│  :5173      │       │  :3001       │       │  (Docker)        │
└─────────────┘       └──────────────┘       └─────────────────┘
```

**Key endpoints:**
- `GET /health` — backend health check (no auth required)
- `POST /api/auth/login` — user login
- `GET /api/clients` — list clients (requires `x-user-email` header)
- `GET /api/work-entries` — list work entries (requires `x-user-email` header)
- `GET /api/reports/client/:id` — client report (requires `x-user-email` header)

---

## Contact & Escalation

| Severity | Response Time | Escalation                          |
|----------|---------------|-------------------------------------|
| P1       | 15 minutes    | On-call engineer + team lead        |
| P2       | 1 hour        | On-call engineer                    |
| P3       | 4 hours       | Assigned engineer during work hours |
| P4       | Next sprint   | Backlog triage                      |

---

## INC-01: Application Not Starting

**Severity:** P1
**Symptoms:** Server process exits immediately, port 3001 not listening, health check fails.

### Diagnosis

1. Check if the process is running:
   ```bash
   lsof -i :3001
   # or in Docker:
   docker ps -a --filter name=timesheet
   ```

2. Check application logs:
   ```bash
   # Development
   npm run dev 2>&1 | tail -50

   # Docker
   docker logs timesheet-app --tail 50
   ```

3. Verify environment variables:
   ```bash
   cat .env
   # Required: PORT, NODE_ENV, FRONTEND_URL, JWT_SECRET
   ```

4. Check Node.js version:
   ```bash
   node --version
   # Required: 18+
   ```

### Resolution

| Cause | Fix |
|-------|-----|
| Missing `.env` file | `cp .env.example .env` and configure values |
| Port already in use | `kill $(lsof -t -i:3001)` or change PORT in `.env` |
| Missing dependencies | `cd backend && npm install` |
| SQLite native module build failure | `npm rebuild sqlite3` or reinstall: `rm -rf node_modules && npm install` |
| Node.js version too old | Upgrade to Node.js 18+ |
| Database init failure | Check `init.js` for schema errors; review logs for `SQLITE_` error codes |

---

## INC-02: Database Failures (SQLite)

**Severity:** P1 (production) / P2 (development)
**Symptoms:** API returns `{"error": "Database error"}` or `{"error": "Internal server error"}`, HTTP 500 on data operations.

### Diagnosis

1. Check logs for SQLite error codes:
   ```bash
   grep -i "SQLITE_" /var/log/app.log
   # or:
   docker logs timesheet-app 2>&1 | grep -i "SQLITE_"
   ```

2. Common SQLite error codes:
   - `SQLITE_BUSY` — database is locked (concurrent writes)
   - `SQLITE_CORRUPT` — database file is corrupted (file-based mode)
   - `SQLITE_FULL` — disk full (file-based mode)
   - `SQLITE_CANTOPEN` — cannot open database file (permissions)
   - `SQLITE_READONLY` — database opened read-only

3. Verify database state:
   ```bash
   # File-based (Docker production)
   ls -la /app/data/timesheet.db
   sqlite3 /app/data/timesheet.db "PRAGMA integrity_check;"
   ```

### Resolution

| Cause | Fix |
|-------|-----|
| `SQLITE_BUSY` | Restart the application; SQLite handles one writer at a time |
| `SQLITE_CORRUPT` (file-based) | Restore from backup: `cp /app/data/timesheet.db.bak /app/data/timesheet.db` |
| `SQLITE_CANTOPEN` | Fix permissions: `chown nodejs:nodejs /app/data/timesheet.db` |
| `SQLITE_FULL` | Free disk space (see [INC-10](#inc-10-disk-space-exhaustion)) |
| In-memory DB lost connection | Restart application; data is not recoverable (see [INC-03](#inc-03-data-loss-after-restart)) |

---

## INC-03: Data Loss After Restart

**Severity:** P2
**Symptoms:** All clients, work entries, and user data are gone after backend restart.

### Diagnosis

1. Check database mode:
   ```bash
   grep "memory" backend/src/database/init.js
   # If `:memory:` is found, the app uses in-memory storage
   ```

2. Verify restart occurred:
   ```bash
   docker logs timesheet-app 2>&1 | grep "Server running on port"
   ```

### Resolution

- **Immediate:** Data in an in-memory database is **not recoverable** after a restart. Inform affected users.
- **Preventive (production):** Switch to file-based SQLite by modifying `backend/src/database/init.js`:
  ```javascript
  // Change:
  db = new sqlite3.Database(':memory:');
  // To:
  db = new sqlite3.Database(process.env.DATABASE_PATH || './data/timesheet.db');
  ```
- The Docker production build already uses file-based SQLite via `docker/overrides/database/init.js`.
- **Long-term:** Implement automated database backups for file-based mode.

---

## INC-04: API 500 Errors

**Severity:** P2
**Symptoms:** Multiple endpoints returning HTTP 500, JSON body `{"error": "Internal server error"}`.

### Diagnosis

1. Check which endpoints are failing:
   ```bash
   curl -s http://localhost:3001/health
   curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients
   curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/work-entries
   ```

2. Check application logs for stack traces:
   ```bash
   docker logs timesheet-app 2>&1 | grep -A 5 "Error:"
   ```

3. Verify database is responsive:
   ```bash
   curl -s http://localhost:3001/health
   # If health returns 200 but API routes fail, issue is likely in route handlers
   ```

### Resolution

| Cause | Fix |
|-------|-----|
| Database connection lost | Restart application to reinitialize DB singleton |
| Unhandled exception in route handler | Check error logs, fix the code, redeploy |
| Validation schema rejecting valid input | Check `validation/schemas.js` for overly strict rules |
| Missing required fields in DB operations | Review request payloads against Joi schemas |

### Error Handler Reference

The app catches errors in `middleware/errorHandler.js`:
- Joi validation errors → 400
- SQLite errors (`err.code.startsWith('SQLITE_')`) → 500
- All other errors → status from error object or 500

---

## INC-05: Authentication Failures

**Severity:** P2
**Symptoms:** Users cannot log in, `401 Unauthorized` on all authenticated endpoints.

### Diagnosis

1. Test login directly:
   ```bash
   curl -X POST http://localhost:3001/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email": "test@example.com"}'
   ```

2. Test authenticated request:
   ```bash
   curl -H "x-user-email: test@example.com" http://localhost:3001/api/auth/me
   ```

3. Check if the issue is the `x-user-email` header not being sent:
   - Open browser DevTools → Network tab
   - Verify the header is present on API requests

### Resolution

| Cause | Fix |
|-------|-----|
| Missing `x-user-email` header | Check frontend `ApiClient` interceptor in `frontend/src/api/client.ts` |
| Invalid email format | Email must match `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` |
| `localStorage` cleared | User must log in again; email is stored in `localStorage` |
| DB error during user lookup | Check database health (see [INC-02](#inc-02-database-failures-sqlite)) |

---

## INC-06: Rate Limiting Blocking Users

**Severity:** P3
**Symptoms:** Users receive `429 Too Many Requests`, legitimate requests being blocked.

### Diagnosis

1. Check current rate limit configuration in `server.js`:
   ```
   windowMs: 15 * 60 * 1000  (15 minutes)
   max: 100                    (100 requests per window per IP)
   ```

2. Identify if a single IP is generating excessive requests:
   ```bash
   docker logs timesheet-app 2>&1 | grep "429"
   ```

### Resolution

- **Immediate:** Restart the application to reset rate limit counters (in-memory store).
- **Adjust limits** in `backend/src/server.js`:
  ```javascript
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200 // increase if legitimate traffic exceeds 100/15min
  });
  ```
- **Long-term:** Use an external rate limit store (Redis) for multi-instance deployments and configure per-route limits.

---

## INC-07: Report Generation Failures (CSV/PDF)

**Severity:** P3
**Symptoms:** CSV or PDF export returns 500, blank files, or download never completes.

### Diagnosis

1. Test report endpoint:
   ```bash
   # Get a valid client ID first
   curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients

   # Test CSV export
   curl -s -H "x-user-email: test@example.com" \
     http://localhost:3001/api/reports/export/csv/1 -o report.csv

   # Test PDF export
   curl -s -H "x-user-email: test@example.com" \
     http://localhost:3001/api/reports/export/pdf/1 -o report.pdf
   ```

2. Check for temp directory issues (CSV):
   ```bash
   ls -la backend/temp/
   df -h  # Check disk space
   ```

3. Check logs for PDF/CSV generation errors:
   ```bash
   docker logs timesheet-app 2>&1 | grep -E "Error (creating|sending) (CSV|file)"
   ```

### Resolution

| Cause | Fix |
|-------|-----|
| Temp directory does not exist (CSV) | `mkdir -p backend/temp` — the code creates it, but permission errors may prevent this |
| Disk full preventing temp file writes | Free disk space (see [INC-10](#inc-10-disk-space-exhaustion)) |
| PDFKit error on large reports | PDF generation streams directly to response; large reports may timeout. Consider pagination |
| Client not found (404) | Verify the client ID belongs to the authenticated user |
| Orphan temp files accumulating | Clean: `rm -f backend/temp/*.csv` |

---

## INC-08: Frontend Not Loading / Blank Page

**Severity:** P2
**Symptoms:** White screen, React errors in console, no content rendered.

### Diagnosis

1. Check if the frontend dev server is running:
   ```bash
   lsof -i :5173
   ```

2. Check if the backend is reachable from the frontend:
   ```bash
   curl -s http://localhost:3001/health
   ```

3. Check browser console for errors (F12 → Console tab).

4. Verify Vite proxy configuration in `frontend/vite.config.ts`:
   ```bash
   cat frontend/vite.config.ts
   # Ensure /api is proxied to http://localhost:3001
   ```

### Resolution

| Cause | Fix |
|-------|-----|
| Frontend dev server not running | `cd frontend && npm run dev` |
| Backend unreachable | Start backend: `cd backend && npm run dev` |
| Vite proxy misconfigured | Verify `VITE_API_URL` or proxy config in `vite.config.ts` |
| Build errors (production) | `cd frontend && npm run build` and check TypeScript errors |
| CORS blocking API requests | See [INC-13](#inc-13-cors-errors) |

---

## INC-09: High Memory Usage / Memory Leaks

**Severity:** P2
**Symptoms:** Application becomes slow over time, Node.js process consuming excessive memory, eventual OOM kill.

### Diagnosis

1. Check memory usage:
   ```bash
   # Process level
   ps aux | grep node
   # or
   top -p $(pgrep -f "node src/server.js")

   # Docker
   docker stats timesheet-app --no-stream
   ```

2. Common memory leak sources in this application:
   - **In-memory SQLite** — database grows with all data stored in RAM
   - **Orphan temp files** — CSV exports create temp files in `backend/temp/`
   - **Unclosed PDF streams** — if PDF generation errors occur mid-stream
   - **Morgan logger** — `combined` format logs every request to stdout

3. Check database size (in-memory estimation):
   ```bash
   curl -s -H "x-user-email: admin@example.com" http://localhost:3001/api/work-entries | wc -c
   ```

### Resolution

- **Immediate:** Restart the application to reclaim memory.
- **Preventive:**
  - Switch to file-based SQLite in production to move data off-heap.
  - Implement periodic cleanup of `backend/temp/` directory.
  - Set Node.js memory limits: `node --max-old-space-size=512 src/server.js`
  - Add `--max-http-header-size` if large headers are a concern.
- **Monitoring:** Add memory usage to health check endpoint.

---

## INC-10: Disk Space Exhaustion

**Severity:** P2
**Symptoms:** Write operations fail, CSV export fails, Docker container unhealthy.

### Diagnosis

1. Check disk usage:
   ```bash
   df -h
   du -sh /app/data/      # SQLite database (Docker)
   du -sh backend/temp/   # Temp CSV files
   du -sh /var/log/        # Log files
   ```

2. Find large files:
   ```bash
   find / -type f -size +100M 2>/dev/null
   ```

### Resolution

1. Clean orphan temp files:
   ```bash
   rm -f backend/temp/*.csv
   ```
2. Rotate/truncate logs:
   ```bash
   truncate -s 0 /var/log/app.log
   ```
3. If database file is large, consider archiving old work entries.
4. Increase disk allocation for the Docker volume.

---

## INC-11: Docker Container Failures

**Severity:** P1
**Symptoms:** Container exits, health check failing, cannot access application.

### Diagnosis

1. Check container status:
   ```bash
   docker ps -a --filter name=timesheet
   docker inspect timesheet-app --format='{{.State.Status}} {{.State.ExitCode}}'
   ```

2. Check container logs:
   ```bash
   docker logs timesheet-app --tail 100
   ```

3. Check Docker health check:
   ```bash
   docker inspect timesheet-app --format='{{json .State.Health}}'
   ```

4. Verify volume mounts:
   ```bash
   docker inspect timesheet-app --format='{{json .Mounts}}'
   # Ensure /app/data is mounted for persistent storage
   ```

### Resolution

| Cause | Fix |
|-------|-----|
| Container OOM killed | Increase memory limit: `docker run --memory=1g ...` |
| Health check failing | Check if port 3001 is listening inside container |
| Volume permission denied | `chown -R 1001:1001 /path/to/host/data` (matches nodejs user in Dockerfile) |
| Image build failure | Rebuild: `docker build -f docker/Dockerfile -t timesheet-app .` |
| Stale container | Remove and recreate: `docker rm -f timesheet-app && docker run ...` |

---

## INC-12: Dependency / npm Install Failures

**Severity:** P3
**Symptoms:** `npm install` fails, `sqlite3` native module build errors, missing modules at runtime.

### Diagnosis

1. Check Node.js and npm versions:
   ```bash
   node --version  # Requires 18+
   npm --version
   ```

2. Check for native module build failures:
   ```bash
   npm install 2>&1 | grep -i "error\|ERR!"
   # sqlite3 requires native compilation tools
   ```

3. Verify lock file consistency:
   ```bash
   npm ci  # Strict install from lock file
   ```

### Resolution

| Cause | Fix |
|-------|-----|
| Missing build tools (sqlite3) | Install: `apt-get install -y build-essential python3` (Debian) or `apk add --no-cache make gcc g++ python3` (Alpine) |
| Stale `node_modules` | `rm -rf node_modules package-lock.json && npm install` |
| npm registry unreachable | Check network, try: `npm config set registry https://registry.npmjs.org/` |
| Lock file mismatch | Delete `package-lock.json` and regenerate with `npm install` |

---

## INC-13: CORS Errors

**Severity:** P3
**Symptoms:** Browser console shows `CORS policy` errors, API requests blocked.

### Diagnosis

1. Check CORS configuration in `server.js`:
   ```javascript
   cors({
     origin: process.env.FRONTEND_URL || 'http://localhost:5173',
     credentials: true
   })
   ```

2. Verify the `FRONTEND_URL` environment variable:
   ```bash
   echo $FRONTEND_URL
   ```

3. Test with curl (bypasses CORS):
   ```bash
   curl -H "Origin: http://localhost:5173" \
        -H "Access-Control-Request-Method: GET" \
        -X OPTIONS http://localhost:3001/api/clients -v
   ```

### Resolution

| Cause | Fix |
|-------|-----|
| `FRONTEND_URL` mismatch | Set `FRONTEND_URL` to match the actual frontend origin (including port) |
| Missing protocol in URL | Include `http://` or `https://` in `FRONTEND_URL` |
| Multiple frontend origins needed | Update CORS config to accept an array of origins |
| Production reverse proxy stripping headers | Configure proxy to pass CORS headers through |

---

## INC-14: Slow Response Times

**Severity:** P3
**Symptoms:** API responses taking >2 seconds, frontend showing loading spinners for extended periods, Axios timeout errors (10s).

### Diagnosis

1. Test endpoint response times:
   ```bash
   time curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients
   time curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/work-entries
   ```

2. Check system resources:
   ```bash
   top -bn1 | head -20
   free -h
   iostat -x 1 3
   ```

3. Check if SQLite is the bottleneck:
   - Large datasets without proper indexing
   - Concurrent read/write contention

### Resolution

| Cause | Fix |
|-------|-----|
| Large unindexed queries | Indexes exist on `user_email`, `client_id`, `date` — verify with `EXPLAIN QUERY PLAN` |
| Too many work entries in a single response | Add pagination to API endpoints |
| Resource contention | Scale up server resources or migrate to a client-server database |
| Network latency (frontend timeout) | Increase Axios timeout from 10s in `frontend/src/api/client.ts` |

---

## Post-Incident Checklist

After resolving any incident:

- [ ] Update incident issue with root cause and resolution
- [ ] Notify affected users of resolution
- [ ] Determine if a code change is needed to prevent recurrence
- [ ] Create follow-up tasks for preventive measures
- [ ] Update this runbook if new failure modes were discovered
- [ ] Schedule a post-mortem for P1/P2 incidents
