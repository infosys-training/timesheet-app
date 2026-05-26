# Timesheet App — Incident Response Runbook

> Last updated: 2026-05-26
>
> **Stack**: Node.js / Express backend (port 3001), React / Vite frontend (port 5173), SQLite in-memory database, Docker production deployment.

---

## Table of Contents

1. [General Triage Checklist](#1-general-triage-checklist)
2. [Database Failures](#2-database-failures)
3. [API / Backend Errors](#3-api--backend-errors)
4. [Authentication Failures](#4-authentication-failures)
5. [Rate Limiting Issues](#5-rate-limiting-issues)
6. [Memory & Resource Exhaustion](#6-memory--resource-exhaustion)
7. [Report Generation Failures (CSV / PDF)](#7-report-generation-failures-csv--pdf)
8. [Frontend / Proxy Failures](#8-frontend--proxy-failures)
9. [Dependency & Supply-Chain Issues](#9-dependency--supply-chain-issues)
10. [Docker / Production Deployment Failures](#10-docker--production-deployment-failures)
11. [CI/CD Pipeline Failures](#11-cicd-pipeline-failures)
12. [Complete Outage (Service Down)](#12-complete-outage-service-down)
13. [Escalation Contacts](#13-escalation-contacts)

---

## 1. General Triage Checklist

Run this checklist **first** for every incident before diving into a specific section.

| # | Step | Command / Action |
|---|------|-----------------|
| 1 | Confirm the health endpoint responds | `curl -sf http://localhost:3001/health` |
| 2 | Check backend process is running | `ps aux \| grep 'node.*server.js'` |
| 3 | Check frontend process is running | `ps aux \| grep vite` (dev) or verify static files served (prod) |
| 4 | Review backend logs | `docker logs <container>` or terminal / journalctl output |
| 5 | Check available memory | `free -m` or `docker stats` |
| 6 | Check disk space (temp files, logs) | `df -h` |
| 7 | Verify environment variables | Confirm `.env` files exist in `backend/` and `frontend/` |
| 8 | Run the health check script | `bash scripts/health-check.sh` |

---

## 2. Database Failures

### 2.1 — SQLite In-Memory Data Loss on Restart

**Symptoms**: All data disappears after a server restart or container recreation.

**Root Cause**: The application uses `sqlite3.Database(':memory:')` — data lives only in process memory (see `backend/src/database/init.js`).

**Immediate Response**:
1. This is **expected behavior** for the in-memory configuration.
2. Communicate to affected users that data is non-persistent by design in development.

**Permanent Fix**:
1. For production persistence, switch to file-based SQLite by changing the database path:
   ```js
   // backend/src/database/init.js
   db = new sqlite3.Database('/data/timesheet.db');
   ```
2. The Docker override (`docker/overrides/server.js`) may already handle this — verify the production database init module.
3. Mount a Docker volume for `/data` to survive container restarts.

---

### 2.2 — Database Initialization Failure

**Symptoms**: Server fails to start with `Failed to start server:` in logs. Process exits with code 1.

**Immediate Response**:
1. Check logs for specific SQLite error codes (e.g., `SQLITE_CANTOPEN`, `SQLITE_CORRUPT`).
2. For in-memory mode, a restart should resolve the issue since a fresh DB is created.
3. For file-based mode:
   ```bash
   # Check file permissions
   ls -la /data/timesheet.db
   # Check disk space
   df -h /data
   # Verify directory exists
   mkdir -p /data && chown node:node /data
   ```
4. Restart the backend: `npm run dev` or restart the Docker container.

**Escalation**: If the error persists after restart, escalate to P1 — the backend cannot serve any requests without a working database.

---

### 2.3 — SQLITE_ Runtime Errors

**Symptoms**: API returns `{"error": "Database error", "message": "An error occurred while processing your request"}` (HTTP 500). Logs show errors prefixed with `SQLITE_`.

**Immediate Response**:
1. Identify the specific error code in logs:
   - `SQLITE_BUSY` — concurrent write contention. Reduce parallel writes or implement WAL mode.
   - `SQLITE_FULL` — disk full (file-based) or memory exhausted (in-memory).
   - `SQLITE_CORRUPT` — database corruption. Requires restart (in-memory) or restore from backup (file-based).
   - `SQLITE_CONSTRAINT` — foreign key violation. This is an application-level bug.
2. For `SQLITE_BUSY`, consider enabling WAL mode:
   ```js
   database.run('PRAGMA journal_mode=WAL');
   ```
3. For memory exhaustion, see [Section 6](#6-memory--resource-exhaustion).

---

## 3. API / Backend Errors

### 3.1 — HTTP 500 Internal Server Error

**Symptoms**: API calls return 500 responses. The error handler in `backend/src/middleware/errorHandler.js` catches unhandled errors.

**Immediate Response**:
1. Check backend logs for the full stack trace (`Error:` prefix in Morgan output).
2. Identify the failing route — check if the error is in `/api/auth`, `/api/clients`, `/api/work-entries`, or `/api/reports`.
3. Verify the database singleton is initialized: call `GET /health`. If health returns OK but API routes fail, the issue is route-specific.
4. If the error is a Joi validation issue surfaced as 500 instead of 400, check request payloads against the schemas in `backend/src/validation/schemas.js`.

**Common Causes**:
- Database connection lost (singleton `db` variable became null unexpectedly).
- Missing or malformed `x-user-email` header bypassing auth middleware.
- Null reference when accessing query results.

---

### 3.2 — HTTP 404 on Valid Routes

**Symptoms**: Known API routes return `{"error": "Route not found"}`.

**Immediate Response**:
1. Confirm the request path starts with `/api/` (e.g., `/api/clients`, not `/clients`).
2. In production (Docker), verify the override `server.js` is correctly copied and API routes are registered before the SPA catch-all `app.get('*', ...)`.
3. Confirm the backend process is using the correct `server.js` entry point.

---

### 3.3 — Validation Errors (HTTP 400)

**Symptoms**: API returns `{"error": "Validation error", "details": [...]}`.

**Response**: This is **expected behavior** — Joi validation is working correctly. Share the `details` array with the caller so they can fix their request payload. Common issues:
- Missing required `name` field when creating a client.
- `hours` value exceeding 24 or not positive.
- Invalid ISO date format for work entries.
- Invalid email format.

---

## 4. Authentication Failures

### 4.1 — HTTP 401 Unauthorized

**Symptoms**: `{"error": "User email required in x-user-email header"}`.

**Immediate Response**:
1. Verify the client is sending the `x-user-email` header. The frontend stores the email in `localStorage` and attaches it via an Axios request interceptor (`frontend/src/api/client.ts`).
2. If the frontend redirects to `/login` unexpectedly, check that `localStorage.getItem('userEmail')` returns a value in the browser console.
3. Verify CORS is not stripping custom headers — check the `FRONTEND_URL` in `backend/.env` matches the actual frontend origin.

### 4.2 — User Auto-Creation Failures

**Symptoms**: Login succeeds but subsequent API calls fail with 500.

**Immediate Response**:
1. The auth middleware (`backend/src/middleware/auth.js`) auto-creates users on first request. If the `INSERT INTO users` fails, the user won't be created.
2. Check for `SQLITE_CONSTRAINT` errors — the email may already exist with different casing.
3. Verify the `users` table was created during DB initialization.

---

## 5. Rate Limiting Issues

### 5.1 — HTTP 429 Too Many Requests

**Symptoms**: Legitimate users receive 429 responses after moderate usage.

**Immediate Response**:
1. Current limit: **100 requests per IP per 15-minute window** (see `server.js` rate limiter config).
2. If this is a legitimate traffic spike, temporarily increase the limit:
   ```js
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 500  // increased from 100
   });
   ```
3. If behind a reverse proxy, ensure `trust proxy` is configured so rate limiting applies per real client IP, not per proxy IP:
   ```js
   app.set('trust proxy', 1);
   ```
4. Restart the backend after changes.

---

## 6. Memory & Resource Exhaustion

### 6.1 — Node.js Heap Out of Memory

**Symptoms**: Process crashes with `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory`.

**Immediate Response**:
1. Restart the process immediately to restore service.
2. Increase the heap limit if needed:
   ```bash
   NODE_OPTIONS="--max-old-space-size=2048" npm start
   ```
3. Investigate root cause:
   - **In-memory SQLite growth**: Large datasets stored entirely in memory. Monitor with `process.memoryUsage()`.
   - **PDF generation**: Large reports create significant memory pressure in `pdfkit`. Check if a report with many entries triggered the OOM.
   - **Unclosed streams or event listeners**: Check for memory leak patterns.

### 6.2 — Temp File Accumulation

**Symptoms**: Disk fills up over time; CSV export starts failing.

**Immediate Response**:
1. CSV exports write to `backend/temp/` and attempt cleanup after download. If cleanup fails, files accumulate.
   ```bash
   # Check temp directory size
   du -sh backend/temp/
   # Clean up stale temp files (older than 1 hour)
   find backend/temp/ -type f -mmin +60 -delete
   ```
2. Consider adding a periodic cleanup cron job.

---

## 7. Report Generation Failures (CSV / PDF)

### 7.1 — CSV Export Fails

**Symptoms**: `{"error": "Failed to generate CSV report"}` (HTTP 500).

**Immediate Response**:
1. Check that the `backend/temp/` directory exists and is writable:
   ```bash
   mkdir -p backend/temp && chmod 755 backend/temp
   ```
2. Check disk space: `df -h`.
3. Verify the `csv-writer` package is installed: `ls backend/node_modules/csv-writer`.
4. Check for file permission errors in logs.

### 7.2 — PDF Export Fails or Produces Empty File

**Symptoms**: PDF download is empty or the request hangs / times out.

**Immediate Response**:
1. PDF is generated via `pdfkit` and streamed directly to the response (no temp file).
2. If the response hangs, the PDF stream may not be finalizing — check for errors in `doc.pipe(res)` or `doc.end()`.
3. For very large reports (hundreds of entries), the PDF generation can be slow. Consider adding a timeout or pagination.
4. Verify `pdfkit` is installed: `ls backend/node_modules/pdfkit`.

---

## 8. Frontend / Proxy Failures

### 8.1 — Vite Proxy Errors (Development)

**Symptoms**: Frontend shows network errors; API calls fail with `ERR_CONNECTION_REFUSED` or CORS errors.

**Immediate Response**:
1. Verify the backend is running on port 3001: `curl http://localhost:3001/health`.
2. Check `frontend/vite.config.ts` — the proxy should forward `/api` to `http://localhost:3001`.
3. Restart the Vite dev server: `cd frontend && npm run dev`.
4. If CORS errors appear, verify `FRONTEND_URL` in `backend/.env` is `http://localhost:5173`.

### 8.2 — Frontend Build Failures

**Symptoms**: `tsc -b && vite build` fails with TypeScript or build errors.

**Immediate Response**:
1. Run `cd frontend && npm run lint` to identify linting issues.
2. Run `cd frontend && npx tsc --noEmit` for TypeScript errors.
3. Clear the build cache: `rm -rf frontend/node_modules/.vite` and retry.
4. Ensure all dependencies are installed: `cd frontend && npm install`.

### 8.3 — Blank Page in Production

**Symptoms**: Production deployment shows a white page, no React content renders.

**Immediate Response**:
1. Check that the Docker override `server.js` is serving the correct static path:
   ```js
   const publicPath = path.join(__dirname, '..', 'public');
   ```
2. Verify the frontend was built and files exist in the expected directory.
3. Check the Content Security Policy in the Helmet config — it may be blocking inline scripts.
4. Open browser DevTools → Console for JavaScript errors.

---

## 9. Dependency & Supply-Chain Issues

### 9.1 — npm Audit Vulnerabilities

**Symptoms**: CI pipeline fails on the Security Audit job; `npm audit` reports high/critical vulnerabilities.

**Immediate Response**:
1. Run `npm audit` in both `backend/` and `frontend/` directories.
2. Attempt automatic fix: `npm audit fix`.
3. For breaking changes: `npm audit fix --force` (test thoroughly after).
4. If a patch is unavailable, evaluate the vulnerability's impact and document an exception if acceptable.
5. The PR checks workflow (`pr-checks.yml`) automatically flags these — review the PR comment for details.

### 9.2 — Dependency Installation Failures

**Symptoms**: `npm install` fails with network errors, permission errors, or version conflicts.

**Immediate Response**:
1. Clear the npm cache: `npm cache clean --force`.
2. Remove `node_modules` and lockfile, then reinstall:
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```
3. Check Node.js version — the project uses Node 20 in CI.
4. For `sqlite3` native module build failures, ensure build tools are installed:
   ```bash
   sudo apt-get install -y build-essential python3
   ```

---

## 10. Docker / Production Deployment Failures

### 10.1 — Container Fails to Start

**Symptoms**: Docker container exits immediately after starting.

**Immediate Response**:
1. Check container logs: `docker logs <container_name>`.
2. Verify environment variables are set (PORT, NODE_ENV, FRONTEND_URL).
3. Confirm the override files in `docker/overrides/` were correctly copied into the image.
4. Check that the database init path is valid for the production configuration.

### 10.2 — CORS Errors in Production

**Symptoms**: Browser console shows CORS policy errors on API requests.

**Immediate Response**:
1. In production, the Docker override uses `origin: true` when `NODE_ENV=production` (allows same-origin).
2. Verify `NODE_ENV=production` is set in the container environment.
3. If the frontend and backend are on different origins, configure the `FRONTEND_URL` environment variable.

---

## 11. CI/CD Pipeline Failures

### 11.1 — PR Quality Checks Failing

**Symptoms**: PR checks (security audit, test coverage) fail on GitHub Actions.

**Immediate Response**:
1. Review the failing job in the GitHub Actions tab.
2. For **Security Audit** failures: See [Section 9.1](#91--npm-audit-vulnerabilities).
3. For **Test Coverage** failures: Run `cd backend && npm run test:coverage` locally and fix failing tests.
4. Note: Jobs with `if: "!contains(github.event.pull_request.user.login, 'devin')"` are skipped for Devin-authored PRs.

### 11.2 — SonarCloud / SAST Failures

**Symptoms**: SonarCloud quality gate fails; code smells or security hotspots detected.

**Immediate Response**:
1. Review findings in the SonarCloud dashboard (see `sonar-project.properties` for project key).
2. Address security hotspots first, then bugs, then code smells.
3. Ensure test coverage meets the configured threshold.

---

## 12. Complete Outage (Service Down)

**Priority**: P1 — Immediate response required.

### Step-by-Step Recovery

1. **Assess scope**: Is it backend only, frontend only, or both?
   ```bash
   curl -sf http://localhost:3001/health && echo "Backend OK" || echo "Backend DOWN"
   curl -sf http://localhost:5173 && echo "Frontend OK" || echo "Frontend DOWN"
   ```

2. **Check process status**:
   ```bash
   ps aux | grep -E 'node|vite'
   docker ps  # if using Docker
   ```

3. **Review logs** for crash reason — look for uncaught exceptions, OOM kills, or segfaults.

4. **Restart services**:
   ```bash
   # Development
   cd backend && npm run dev &
   cd frontend && npm run dev &

   # Docker
   docker-compose restart
   ```

5. **Verify recovery**: Run `bash scripts/health-check.sh`.

6. **Post-incident**: File a P1 incident issue using the GitHub Issue template and schedule a post-mortem within 24 hours.

---

## 13. Escalation Contacts

| Role | Responsibility | When to Engage |
|------|---------------|----------------|
| On-Call Engineer | First responder for all incidents | All P1/P2 incidents |
| Backend Lead | Database, API, and server issues | Database corruption, persistent 500 errors |
| Frontend Lead | UI, build, and proxy issues | Build failures, blank page in production |
| DevOps / Platform | Docker, CI/CD, infrastructure | Container failures, CI pipeline issues |
| Security Lead | Vulnerability assessment and response | Critical CVEs, data exposure incidents |

> **Tip**: Use the GitHub Issue templates in `.github/ISSUE_TEMPLATE/` to file incidents with consistent structure and priority classification.
