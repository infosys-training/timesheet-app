# Timesheet Application — Incident Response Runbook

This document provides step-by-step response procedures for common failure modes in the Timesheet Application. It covers database issues, API errors, memory leaks, and dependency failures.

---

## Table of Contents

1. [Database Issues](#1-database-issues)
2. [API Errors](#2-api-errors)
3. [Memory Leaks](#3-memory-leaks)
4. [Dependency Failures](#4-dependency-failures)
5. [General Incident Response Checklist](#5-general-incident-response-checklist)

---

## 1. Database Issues

### 1.1 In-Memory Database Data Loss (Development)

**Symptoms:** All data disappears after server restart; users report missing entries.

**Root Cause:** The development environment uses SQLite `:memory:` which is ephemeral.

**Response Steps:**
1. Confirm the environment is development (check `DATABASE_PATH` env var is unset).
2. This is expected behavior in development — data does not persist across restarts.
3. If this occurs in production, verify the Docker container is using the file-based SQLite override (`docker/overrides/database/init.js`).
4. Check the volume mount for `/app/data` is correctly configured in your deployment.

**Prevention:** Always deploy with `DATABASE_PATH=/app/data/timesheet.db` and a persistent volume.

---

### 1.2 SQLite Lock Contention / SQLITE_BUSY Errors

**Symptoms:** HTTP 500 responses with `"Database error"` message; logs show `SQLITE_BUSY`.

**Root Cause:** Multiple concurrent write operations exceed SQLite's single-writer lock.

**Response Steps:**
1. Check application logs for `SQLITE_BUSY` or `SQLITE_LOCKED` errors:
   ```bash
   docker logs <container_id> 2>&1 | grep -i "sqlite"
   ```
2. Identify high-traffic write endpoints (`POST /api/work-entries`, `POST /api/clients`).
3. Reduce concurrent write load by scaling horizontally behind a queue, or enable WAL mode:
   ```sql
   PRAGMA journal_mode=WAL;
   ```
4. If the database is corrupted, restore from backup:
   ```bash
   cp /app/data/timesheet.db.backup /app/data/timesheet.db
   ```
5. Restart the application:
   ```bash
   docker restart timesheet-app
   ```

**Prevention:** Enable WAL mode in `database/init.js`; implement write retry logic with exponential backoff.

---

### 1.3 Database File Corruption (Production)

**Symptoms:** Application fails to start; logs show `SQLITE_CORRUPT` or `SQLITE_NOTADB`.

**Response Steps:**
1. Stop the application immediately to prevent further corruption:
   ```bash
   docker stop timesheet-app
   ```
2. Create a backup of the corrupted file:
   ```bash
   cp /app/data/timesheet.db /app/data/timesheet.db.corrupted.$(date +%s)
   ```
3. Attempt integrity check:
   ```bash
   sqlite3 /app/data/timesheet.db "PRAGMA integrity_check;"
   ```
4. If recoverable, export and reimport:
   ```bash
   sqlite3 /app/data/timesheet.db ".dump" > /tmp/dump.sql
   sqlite3 /app/data/timesheet_new.db < /tmp/dump.sql
   mv /app/data/timesheet_new.db /app/data/timesheet.db
   ```
5. If unrecoverable, restore from the most recent backup.
6. Restart the application.

**Prevention:** Schedule regular database backups; use checksums to detect corruption early.

---

### 1.4 Disk Space Exhaustion

**Symptoms:** Write operations fail; logs show `SQLITE_FULL` or filesystem errors.

**Response Steps:**
1. Check disk usage on the data volume:
   ```bash
   df -h /app/data
   du -sh /app/data/timesheet.db
   ```
2. Remove old temp files from the CSV/PDF export directory:
   ```bash
   rm -f /app/temp/*.csv /app/temp/*.pdf
   ```
3. If the database has grown unexpectedly, run `VACUUM`:
   ```bash
   sqlite3 /app/data/timesheet.db "VACUUM;"
   ```
4. Expand the volume or migrate to a larger disk if needed.
5. Restart the application.

**Prevention:** Set up disk usage monitoring and alerts at 80% capacity; schedule periodic `VACUUM`.

---

## 2. API Errors

### 2.1 Rate Limiting (HTTP 429)

**Symptoms:** Users receive `429 Too Many Requests`; legitimate users locked out.

**Root Cause:** Default rate limit is 100 requests per 15-minute window per IP.

**Response Steps:**
1. Identify the affected IP addresses in access logs:
   ```bash
   docker logs <container_id> 2>&1 | grep "429"
   ```
2. Determine if traffic is legitimate or malicious (DDoS/bot).
3. For legitimate traffic spikes, temporarily increase the limit by setting `RATE_LIMIT_MAX` env var and restarting.
4. For malicious traffic, block the offending IPs at the load balancer/firewall level.
5. Monitor for continued 429s after mitigation.

**Prevention:** Implement per-user rate limiting (by email) instead of per-IP; add allowlists for internal services.

---

### 2.2 Authentication Failures (HTTP 401)

**Symptoms:** Users cannot access protected endpoints; `"User email required in x-user-email header"` error.

**Root Cause:** Missing or malformed `x-user-email` header in requests.

**Response Steps:**
1. Verify the frontend is sending the header (check browser DevTools → Network tab).
2. Check `localStorage` for `userEmail` key — if empty, user needs to re-login.
3. If the issue is proxy-related, verify the Vite proxy or reverse proxy is not stripping custom headers:
   ```bash
   curl -H "x-user-email: test@example.com" http://localhost:3001/api/auth/me
   ```
4. Check CORS configuration if requests originate from unexpected origins.
5. Review recent deployments for changes to auth middleware.

**Prevention:** Add request logging for auth failures; implement proper session-based auth for production.

---

### 2.3 Validation Errors (HTTP 400)

**Symptoms:** Users receive `"Validation error"` with details array; form submissions rejected.

**Root Cause:** Request body does not match Joi validation schemas.

**Response Steps:**
1. Check the error response `details` array for the specific field failures.
2. Common causes:
   - `hours` exceeds 24 or is negative.
   - `date` is not in ISO format.
   - `email` is not valid format.
   - `name` is empty or exceeds 255 characters.
3. If the issue is frontend-related, verify form validation matches backend schemas.
4. If the schemas are too restrictive, update `backend/src/validation/schemas.js`.

**Prevention:** Keep frontend and backend validation in sync; add integration tests for edge cases.

---

### 2.4 Request Body Too Large (HTTP 413)

**Symptoms:** Large requests fail with payload too large error.

**Root Cause:** Express body parser limit set to 10MB (`express.json({ limit: '10mb' })`).

**Response Steps:**
1. Identify which endpoint is receiving oversized payloads.
2. If legitimate, increase the limit in `server.js`.
3. If malicious, block at the reverse proxy level.

**Prevention:** Validate payload sizes on the frontend before submission.

---

### 2.5 CORS Errors

**Symptoms:** Browser console shows CORS policy errors; API requests blocked.

**Root Cause:** `FRONTEND_URL` env var does not match the requesting origin.

**Response Steps:**
1. Check the configured `FRONTEND_URL`:
   ```bash
   echo $FRONTEND_URL
   ```
2. Verify it matches the actual frontend URL (including protocol and port).
3. Update the environment variable and restart:
   ```bash
   export FRONTEND_URL=https://your-frontend-domain.com
   ```
4. For multiple origins, modify the CORS configuration in `server.js`.

**Prevention:** Use environment-specific `.env` files; validate CORS config in CI.

---

## 3. Memory Leaks

### 3.1 Temp File Accumulation from Report Exports

**Symptoms:** Disk space decreases over time; `/app/temp/` directory grows unbounded.

**Root Cause:** CSV/PDF export temp files not cleaned up on error paths in `routes/reports.js`.

**Response Steps:**
1. Check the temp directory size:
   ```bash
   du -sh /app/temp/
   ls -la /app/temp/ | wc -l
   ```
2. Remove orphaned temp files (older than 1 hour):
   ```bash
   find /app/temp/ -type f -mmin +60 -delete
   ```
3. Monitor the application logs for `"Error deleting temp file"` messages.
4. Restart the application if memory is also affected.

**Prevention:** Add a periodic cleanup cron job; implement streaming responses instead of temp files.

---

### 3.2 Node.js Heap Growth

**Symptoms:** Container memory usage steadily increases; eventual OOM kill.

**Root Cause:** Large report generation (PDFKit) for clients with many entries; uncollected references.

**Response Steps:**
1. Check container memory usage:
   ```bash
   docker stats timesheet-app --no-stream
   ```
2. If memory exceeds 80% of limit, restart the container:
   ```bash
   docker restart timesheet-app
   ```
3. Capture a heap snapshot for analysis:
   ```bash
   # Send SIGUSR2 to Node.js process
   docker exec timesheet-app kill -USR2 1
   ```
4. Review recent report generation requests for unusually large datasets.
5. Implement pagination for report queries if datasets are large.

**Prevention:** Set `--max-old-space-size` in Node.js; add memory limit alerts; paginate large queries.

---

### 3.3 Event Loop Blocking

**Symptoms:** All API requests become slow or time out simultaneously; health check fails.

**Root Cause:** Synchronous operations (large PDF generation, database serialization) blocking the event loop.

**Response Steps:**
1. Check if the health endpoint responds:
   ```bash
   curl -w "%{time_total}s" http://localhost:3001/health
   ```
2. If response time > 5s, the event loop is likely blocked.
3. Restart the application immediately for user recovery.
4. Identify the blocking operation from logs (look for large report requests just before the incident).
5. Implement worker threads or streaming for expensive operations.

**Prevention:** Add event loop lag monitoring; set request timeouts; offload heavy computation.

---

## 4. Dependency Failures

### 4.1 Frontend-Backend Connectivity (Vite Proxy)

**Symptoms:** Frontend shows network errors; API calls return `ERR_CONNECTION_REFUSED`.

**Root Cause:** Backend not running or Vite proxy misconfigured (`vite.config.ts` proxies `/api` to `localhost:3001`).

**Response Steps:**
1. Verify the backend is running:
   ```bash
   curl http://localhost:3001/health
   ```
2. If backend is down, check logs and restart:
   ```bash
   cd backend && npm run dev
   ```
3. If backend is up but proxy fails, check `vite.config.ts` target matches the backend port.
4. Verify no port conflict (another process using port 3001):
   ```bash
   lsof -i :3001
   ```

**Prevention:** Add startup dependency checks; use Docker Compose for local development.

---

### 4.2 npm Dependency Installation Failures

**Symptoms:** `npm install` fails; native modules (sqlite3) fail to compile.

**Root Cause:** Missing build tools, incompatible Node.js version, or network issues.

**Response Steps:**
1. Check Node.js version matches requirements (v20):
   ```bash
   node --version
   ```
2. For `sqlite3` native module failures, install build dependencies:
   ```bash
   # Ubuntu/Debian
   sudo apt-get install -y build-essential python3
   # Alpine
   apk add --no-cache python3 make g++
   ```
3. Clear npm cache and retry:
   ```bash
   npm cache clean --force
   rm -rf node_modules package-lock.json
   npm install
   ```
4. If behind a corporate proxy, configure npm:
   ```bash
   npm config set proxy http://proxy:port
   npm config set https-proxy http://proxy:port
   ```

**Prevention:** Pin Node.js version with `.nvmrc`; use Docker for consistent build environments.

---

### 4.3 Docker Build Failures

**Symptoms:** `docker build` fails; image cannot be created.

**Response Steps:**
1. Check which build stage fails (frontend-builder, backend-builder, production).
2. For frontend build failures:
   ```bash
   cd frontend && npm run build
   ```
   Fix any TypeScript or bundling errors.
3. For backend dependency failures, ensure `package-lock.json` is committed and up to date.
4. For the production stage, verify `docker/overrides/` files exist and are syntactically correct.
5. Clear Docker build cache if stale layers are the issue:
   ```bash
   docker builder prune
   ```

**Prevention:** Run `npm run build` in CI before Docker build; keep lockfiles committed.

---

### 4.4 Security Vulnerability in Dependencies

**Symptoms:** `npm audit` reports critical vulnerabilities; CI security scans fail.

**Response Steps:**
1. Run audit to identify vulnerable packages:
   ```bash
   cd backend && npm audit
   cd frontend && npm audit
   ```
2. Apply automated fixes where safe:
   ```bash
   npm audit fix
   ```
3. For breaking changes, manually update the package:
   ```bash
   npm install <package>@latest
   ```
4. Run tests to verify no regressions:
   ```bash
   cd backend && npm test
   ```
5. If a vulnerability cannot be patched immediately, document the risk and create a tracking issue.

**Prevention:** Enable Dependabot or Renovate; integrate `npm audit` into CI pipeline.

---

## 5. General Incident Response Checklist

### Immediate Actions (First 5 Minutes)

- [ ] Acknowledge the incident and assign an owner.
- [ ] Determine severity (P1–P4) based on user impact.
- [ ] Check the health endpoint: `curl http://<host>:3001/health`
- [ ] Review application logs: `docker logs <container_id> --tail 100`
- [ ] Check resource usage: `docker stats timesheet-app --no-stream`

### Investigation (5–30 Minutes)

- [ ] Identify the failure category (Database / API / Memory / Dependency).
- [ ] Follow the relevant section above for detailed steps.
- [ ] Capture relevant logs and metrics before any restarts.
- [ ] Communicate status to stakeholders.

### Recovery

- [ ] Apply the fix or workaround.
- [ ] Verify recovery via health check and manual testing.
- [ ] Monitor for recurrence for at least 15 minutes.

### Post-Incident

- [ ] Write a post-mortem within 48 hours.
- [ ] File issues for preventive measures.
- [ ] Update this runbook if new failure modes were discovered.
- [ ] Schedule a review meeting if severity was P1 or P2.

---

## Quick Reference: Critical Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Application health check |
| `/api/auth/login` | POST | User authentication |
| `/api/auth/me` | GET | Current user info |
| `/api/clients` | GET/POST | Client management |
| `/api/clients/:id` | GET/PUT/DELETE | Single client operations |
| `/api/work-entries` | GET/POST | Work entry management |
| `/api/work-entries/:id` | GET/PUT/DELETE | Single entry operations |
| `/api/reports/client/:id` | GET | Client report |
| `/api/reports/export/csv/:id` | GET | CSV export |
| `/api/reports/export/pdf/:id` | GET | PDF export |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Backend server port |
| `FRONTEND_URL` | `http://localhost:5173` | Allowed CORS origin |
| `DATABASE_PATH` | `:memory:` | SQLite database path (file path for persistence) |
| `NODE_ENV` | `development` | Environment mode |

---

*Last updated: June 2026*
