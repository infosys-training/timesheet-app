# Incident Response Runbook - Employee Time Tracking Application

> **Last updated:** 2026-06-05
> **On-call escalation:** File an issue using the appropriate [GitHub Issue template](.github/ISSUE_TEMPLATE/).

---

## Table of Contents

1. [General Incident Response Procedure](#1-general-incident-response-procedure)
2. [Database Failures (SQLite)](#2-database-failures-sqlite)
3. [API / Express Server Errors](#3-api--express-server-errors)
4. [Authentication & JWT Failures](#4-authentication--jwt-failures)
5. [Memory Leaks & Resource Exhaustion](#5-memory-leaks--resource-exhaustion)
6. [Dependency & npm Failures](#6-dependency--npm-failures)
7. [Frontend (Vite/React) Failures](#7-frontend-vitereact-failures)
8. [Rate Limiting & CORS Issues](#8-rate-limiting--cors-issues)
9. [PDF/CSV Export Failures](#9-pdfcsv-export-failures)
10. [Docker / Container Failures](#10-docker--container-failures)
11. [Health Check Reference](#11-health-check-reference)

---

## 1. General Incident Response Procedure

### Triage

| Step | Action |
|------|--------|
| 1 | Acknowledge the alert and open a GitHub Issue using the matching severity template (P1-P4). |
| 2 | Determine scope: single user, all users, or full outage. |
| 3 | Check the `/health` endpoint: `curl -s http://localhost:3001/health` |
| 4 | Review application logs: `docker logs <container>` or the process stdout. |
| 5 | If P1/P2, notify stakeholders immediately and begin mitigation. |

### Severity Definitions

| Severity | Meaning | Response SLA |
|----------|---------|-------------|
| **P1 - Critical** | Full outage; no users can access the application | Acknowledge in 15 min, mitigate in 1 hr |
| **P2 - High** | Major feature broken (e.g., cannot submit time entries) | Acknowledge in 30 min, mitigate in 4 hr |
| **P3 - Medium** | Degraded experience (e.g., exports failing, slow responses) | Acknowledge in 4 hr, resolve in 24 hr |
| **P4 - Low** | Cosmetic or minor issue with a workaround | Resolve in 1 week |

---

## 2. Database Failures (SQLite)

### 2a. In-Memory Database Lost (Server Restart)

**Symptoms:** All data disappears; users see empty dashboards after a deploy or restart.

**Root cause:** The app uses SQLite `:memory:` — all data lives only in the Node.js process.

**Response:**
1. Confirm the restart occurred: check process uptime or container restart count.
   ```bash
   # Docker
   docker inspect --format='{{.State.StartedAt}}' <container>
   # PM2
   pm2 show time-tracking-backend | grep uptime
   ```
2. Communicate to affected users that data has been reset.
3. If this is production, switch to file-based SQLite immediately:
   - Edit `backend/src/database/init.js`: change `':memory:'` to a file path such as `/app/data/timesheet.db`.
   - Ensure the data directory is on a persistent volume.
4. Redeploy.

**Prevention:** Use the Docker image which already uses file-based SQLite at `/app/data/timesheet.db`. Ensure the volume is mounted: `docker run -v timesheet-data:/app/data ...`

### 2b. Database Initialization Failure

**Symptoms:** Server fails to start; logs show `Error opening database` or `Failed to start server`.

**Response:**
1. Check logs for the specific SQLite error.
   ```bash
   # Look for the error
   grep -i "error opening database\|SQLITE_" /var/log/app.log
   ```
2. If file-based SQLite: verify the path exists and the process has write permissions.
   ```bash
   ls -la /app/data/
   stat /app/data/timesheet.db
   ```
3. If permissions issue:
   ```bash
   chown nodejs:nodejs /app/data/
   chmod 755 /app/data/
   ```
4. If the database file is corrupted:
   ```bash
   sqlite3 /app/data/timesheet.db "PRAGMA integrity_check;"
   ```
   - If corrupt, restore from backup or delete the file (data loss) and let the app re-create it.
5. Restart the application.

### 2c. Database Query Errors (SQLITE_* Codes)

**Symptoms:** API returns `500` with `"Database error"` message; logs show errors prefixed `SQLITE_`.

**Response:**
1. Identify the specific error code in logs (e.g., `SQLITE_BUSY`, `SQLITE_LOCKED`, `SQLITE_CORRUPT`).
2. **SQLITE_BUSY / SQLITE_LOCKED:** Concurrent write contention.
   - Reduce concurrent writes or add WAL mode: `PRAGMA journal_mode=WAL;`
3. **SQLITE_CORRUPT:** Database file is damaged.
   - Restore from backup; if unavailable, delete and re-initialize.
4. **SQLITE_FULL:** Disk is full.
   ```bash
   df -h
   ```
   - Free space or expand the volume, then restart.

---

## 3. API / Express Server Errors

### 3a. Server Won't Start (Port Already in Use)

**Symptoms:** `EADDRINUSE` error on startup.

**Response:**
1. Find what's using the port:
   ```bash
   lsof -i :3001
   # or
   ss -tlnp | grep 3001
   ```
2. Kill the conflicting process or change `PORT` in `.env`.
3. Restart.

### 3b. Unhandled Exceptions / Process Crash

**Symptoms:** Server exits unexpectedly; returns 502 behind a reverse proxy.

**Response:**
1. Check the last lines of stdout/stderr for the stack trace.
2. Look for unhandled promise rejections or uncaught exceptions.
3. If reproducible, capture the request that triggers it (check `morgan` access logs).
4. Deploy a fix or roll back to the previous known-good version.
5. Ensure a process manager (PM2, systemd, Docker restart policy) is configured to auto-restart.
   ```bash
   # Docker restart policy check
   docker inspect --format='{{.HostConfig.RestartPolicy.Name}}' <container>
   ```

### 3c. 404 on Valid Routes

**Symptoms:** Requests to known endpoints return `"Route not found"`.

**Response:**
1. Verify the request path includes the `/api/` prefix (e.g., `/api/clients`, not `/clients`).
2. Check that route files are loaded in `server.js` — look for `app.use('/api/...')` lines.
3. If recently deployed, confirm the correct version of code is running.

### 3d. Validation Errors (400)

**Symptoms:** API returns `400` with `"Validation error"` and a details array.

**Response:**
1. This is expected behavior — the request body doesn't match the Joi schema.
2. Inspect the `details` array in the response to identify which field failed.
3. Correct the client-side request payload.

---

## 4. Authentication & JWT Failures

### 4a. 401 Unauthorized on All Requests

**Symptoms:** Every authenticated endpoint returns `401`.

**Response:**
1. Confirm the client is sending the `x-user-email` header (not a Bearer token — this app uses email-based auth via the `x-user-email` header).
2. Verify the email format passes validation: `^[^\s@]+@[^\s@]+\.[^\s@]+$`
3. If the header is present and valid, check the database to see if user creation is failing:
   ```bash
   curl -v -H "x-user-email: test@example.com" http://localhost:3001/api/auth/me
   ```
4. Check for middleware ordering issues in `server.js`.

### 4b. User Cannot Log In (Login Endpoint Fails)

**Symptoms:** `POST /api/auth/login` returns 500.

**Response:**
1. Verify the request body is `{ "email": "user@example.com" }`.
2. Check if the database is initialized (see Section 2).
3. Look for `INSERT` errors in logs — possible unique constraint violation or DB lock.

---

## 5. Memory Leaks & Resource Exhaustion

### 5a. Node.js Process Memory Growing Unbounded

**Symptoms:** Increasing RSS over time; eventual OOM kill or extreme slowdown.

**Response:**
1. Check current memory usage:
   ```bash
   # If running in Docker
   docker stats <container>
   # Direct process
   ps aux | grep node
   ```
2. Take a heap snapshot for analysis:
   ```bash
   kill -USR2 <pid>   # if --inspect is enabled
   ```
3. Common causes in this app:
   - Temp CSV/PDF files not cleaned up in `backend/temp/` (see `reports.js` export).
   - SQLite connections not properly closed.
   - Large query result sets held in memory.
4. Mitigation:
   ```bash
   # Clean up temp files
   find /app/temp -name "*.csv" -mmin +60 -delete
   find /app/temp -name "*.pdf" -mmin +60 -delete
   ```
5. Restart the process if memory is critically high.
6. Set a memory limit:
   ```bash
   node --max-old-space-size=512 src/server.js
   ```

### 5b. Too Many Open File Descriptors

**Symptoms:** `EMFILE: too many open files` errors.

**Response:**
1. Check current limit: `ulimit -n`
2. Increase if needed: `ulimit -n 65536`
3. Check for file descriptor leaks — temp files from CSV/PDF exports not being closed:
   ```bash
   ls -la /app/backend/temp/ | wc -l
   ```
4. Clean up and restart.

---

## 6. Dependency & npm Failures

### 6a. npm install Fails

**Symptoms:** Application can't start because `node_modules` is missing or incomplete.

**Response:**
1. Clear and reinstall:
   ```bash
   cd backend && rm -rf node_modules package-lock.json && npm install
   cd frontend && rm -rf node_modules package-lock.json && npm install
   ```
2. If network errors, check proxy/registry configuration:
   ```bash
   npm config get registry
   ```
3. If `sqlite3` native module fails to build:
   ```bash
   npm rebuild sqlite3
   # or install build tools
   apt-get install -y python3 make g++
   npm install
   ```

### 6b. Security Vulnerability in Dependencies

**Symptoms:** `npm audit` reports high/critical CVEs; CI pipeline fails on security check.

**Response:**
1. Run audit:
   ```bash
   cd backend && npm audit
   cd frontend && npm audit
   ```
2. Apply automatic fixes where possible:
   ```bash
   npm audit fix
   ```
3. For breaking changes:
   ```bash
   npm audit fix --force   # may introduce breaking changes
   ```
4. Test thoroughly after upgrading.
5. If a vulnerability cannot be fixed, document the risk and add an exception.

### 6c. Node.js Version Incompatibility

**Symptoms:** Syntax errors, unsupported features, or native module failures after a Node.js upgrade.

**Response:**
1. Verify the running Node.js version: `node -v` (requires 18+).
2. Check `package.json` for any `engines` field.
3. Use nvm or the project's specified version manager to switch.

---

## 7. Frontend (Vite/React) Failures

### 7a. Vite Dev Server Won't Start

**Symptoms:** `npm run dev` in frontend fails.

**Response:**
1. Check for port conflicts on `5173`:
   ```bash
   lsof -i :5173
   ```
2. Verify `node_modules` exists: `ls frontend/node_modules/.package-lock.json`
3. Clear Vite cache:
   ```bash
   cd frontend && rm -rf node_modules/.vite && npm run dev
   ```

### 7b. API Proxy Errors (Vite -> Backend)

**Symptoms:** Frontend shows network errors; API calls fail with connection refused.

**Response:**
1. Verify the backend is running on port `3001`.
2. Check `frontend/vite.config.ts` — the proxy target must be `http://localhost:3001`.
3. If running in Docker or behind a reverse proxy, ensure the frontend's `VITE_API_URL` or proxy config points to the correct backend address.
4. Check CORS configuration in `backend/src/server.js` — `FRONTEND_URL` env var must match the frontend origin.

### 7c. Frontend Build Fails (TypeScript Errors)

**Symptoms:** `npm run build` fails with type errors.

**Response:**
1. Run `cd frontend && npx tsc --noEmit` to see all type errors.
2. Fix the reported issues or check if a dependency update introduced breaking type changes.
3. Verify `tsconfig.json` settings match the project requirements.

---

## 8. Rate Limiting & CORS Issues

### 8a. 429 Too Many Requests

**Symptoms:** Users get `429` responses; legitimate traffic is being throttled.

**Response:**
1. The default limit is 100 requests per 15 minutes per IP (see `server.js`).
2. If legitimate traffic exceeds this, increase the limit:
   ```js
   // server.js
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 500  // increase as needed
   });
   ```
3. Consider per-user rate limiting instead of per-IP if behind a load balancer.
4. Ensure `X-Forwarded-For` is trusted if behind a proxy:
   ```js
   app.set('trust proxy', 1);
   ```

### 8b. CORS Blocked Requests

**Symptoms:** Browser console shows `Access-Control-Allow-Origin` errors.

**Response:**
1. Verify `FRONTEND_URL` in the backend `.env` matches the exact origin (protocol + host + port).
2. If multiple frontends need access, update the CORS config to accept an array.
3. In development, ensure the Vite proxy is handling API requests (path should start with `/api`).

---

## 9. PDF/CSV Export Failures

### 9a. Export Returns 500

**Symptoms:** `/api/reports/export/csv/:clientId` or `/api/reports/export/pdf/:clientId` returns 500.

**Response:**
1. Check if the `backend/temp/` directory exists and is writable:
   ```bash
   ls -la backend/temp/
   mkdir -p backend/temp && chmod 755 backend/temp
   ```
2. Check disk space: `df -h`
3. For PDF-specific errors, check if `pdfkit` can load fonts — it requires system fonts.
4. Verify the client exists and belongs to the requesting user.

### 9b. Temp Files Accumulating

**Symptoms:** Disk space consumed by old export files in `backend/temp/`.

**Response:**
1. Clean up manually:
   ```bash
   find backend/temp -type f -mmin +60 -delete
   ```
2. Add a cron job for periodic cleanup:
   ```bash
   0 * * * * find /app/backend/temp -type f -mmin +60 -delete
   ```

---

## 10. Docker / Container Failures

### 10a. Container Won't Start

**Symptoms:** `docker run` exits immediately.

**Response:**
1. Check logs: `docker logs <container>`
2. Verify the image was built successfully: `docker images | grep timesheet`
3. Ensure environment variables are set:
   ```bash
   docker run -e NODE_ENV=production -e JWT_SECRET=<secret> ...
   ```
4. Check the Docker health check: the container runs `node -e "require('http').get('http://localhost:3001/health', ...)"` every 30s.

### 10b. Container Health Check Failing

**Symptoms:** Docker reports container as unhealthy.

**Response:**
1. Exec into the container and test manually:
   ```bash
   docker exec <container> node -e "require('http').get('http://localhost:3001/health', (r) => { console.log(r.statusCode); r.resume(); })"
   ```
2. Check if the app is binding to `0.0.0.0` (not `127.0.0.1`).
3. Review the health check config in the Dockerfile:
   ```
   HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3
   ```

### 10c. Data Volume Not Mounted

**Symptoms:** Data disappears on container restart even though file-based SQLite is configured.

**Response:**
1. Verify volume mount:
   ```bash
   docker inspect <container> | jq '.[].Mounts'
   ```
2. Ensure the mount target is `/app/data` and the volume is persistent:
   ```bash
   docker run -v timesheet-data:/app/data ...
   ```

---

## 11. Health Check Reference

The application exposes a health endpoint at `GET /health` that returns:

```json
{ "status": "OK", "timestamp": "2026-06-05T12:00:00.000Z" }
```

### Using the Health Check Script

A comprehensive health check script is provided at `scripts/healthcheck.sh`. Run it to validate all critical endpoints:

```bash
# Default (backend on localhost:3001, frontend on localhost:5173)
./scripts/healthcheck.sh

# Custom ports
BACKEND_URL=http://localhost:3001 FRONTEND_URL=http://localhost:5173 ./scripts/healthcheck.sh
```

The script tests:
- Backend health endpoint
- Authentication flow (login + user info)
- Client CRUD operations
- Work entry CRUD operations
- Report generation and export endpoints
- Frontend availability
- Response time thresholds

Exit codes: `0` = all checks passed, `1` = one or more checks failed.

---

## Appendix: Key File Locations

| File | Purpose |
|------|---------|
| `backend/src/server.js` | Express app entry point, middleware, routes |
| `backend/src/database/init.js` | SQLite connection & schema init |
| `backend/src/middleware/auth.js` | Email-based authentication |
| `backend/src/middleware/errorHandler.js` | Centralized error handling |
| `backend/src/routes/auth.js` | Login & user endpoints |
| `backend/src/routes/clients.js` | Client CRUD |
| `backend/src/routes/workEntries.js` | Work entry CRUD |
| `backend/src/routes/reports.js` | Reports & CSV/PDF export |
| `backend/src/validation/schemas.js` | Joi validation schemas |
| `frontend/vite.config.ts` | Vite config with API proxy |
| `frontend/src/api/client.ts` | Axios API client |
| `docker/Dockerfile` | Production Docker image |
| `backend/.env` | Backend environment variables |
| `frontend/.env` | Frontend environment variables |
