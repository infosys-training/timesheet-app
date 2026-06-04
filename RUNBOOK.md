# Timesheet App — Incident Response Runbook

> **Owner:** On-call engineering team
> **Last updated:** 2025-06-04

---

## Table of Contents

1. [General Triage Workflow](#1-general-triage-workflow)
2. [Database Failures](#2-database-failures)
3. [API / Backend Errors](#3-api--backend-errors)
4. [Authentication Failures](#4-authentication-failures)
5. [Rate Limiting Issues](#5-rate-limiting-issues)
6. [Report Generation Failures (PDF / CSV)](#6-report-generation-failures-pdf--csv)
7. [Frontend / Proxy Failures](#7-frontend--proxy-failures)
8. [Memory & Resource Exhaustion](#8-memory--resource-exhaustion)
9. [Docker / Container Failures](#9-docker--container-failures)
10. [Dependency & Supply-Chain Failures](#10-dependency--supply-chain-failures)
11. [Data Loss (In-Memory DB Restart)](#11-data-loss-in-memory-db-restart)
12. [Contact & Escalation](#12-contact--escalation)

---

## 1. General Triage Workflow

Use this checklist every time an incident is raised, regardless of category.

1. **Acknowledge** — Respond in the incident channel within the SLA for the priority level (see issue templates for SLA targets).
2. **Assess impact** — How many users are affected? Is the app fully down or partially degraded?
3. **Check health endpoint** — `curl http://<host>:3001/health` — a `200 {"status":"OK"}` confirms the backend process is alive.
4. **Check logs** — `docker logs <container>` or the process stdout if running directly.
5. **Run the health-check script** — `./scripts/health-check.sh http://localhost:3001` for a full endpoint sweep.
6. **Classify** — Assign a priority (P1–P4) and open an incident issue using the matching GitHub template.
7. **Mitigate** — Apply the relevant procedure below.
8. **Resolve & document** — Update the incident issue with root cause, timeline, and follow-up items.

---

## 2. Database Failures

### 2.1 SQLite File Cannot Be Opened (Production)

**Symptoms:** `500 Internal server error` on all data endpoints; logs show `Error opening database: SQLITE_CANTOPEN`.

**Procedure:**

1. SSH into the host / exec into the container:
   ```bash
   docker exec -it <container> sh
   ```
2. Check the database path and permissions:
   ```bash
   ls -la /app/data/timesheet.db
   # Expected: owned by nodejs (UID 1001), rw permissions
   ```
3. Check disk space:
   ```bash
   df -h /app/data
   ```
4. If the file is missing, check if the volume mount is correct in your compose/run command:
   ```bash
   docker inspect <container> | grep -A5 Mounts
   ```
5. If permissions are wrong:
   ```bash
   chown 1001:1001 /app/data/timesheet.db
   chmod 644 /app/data/timesheet.db
   ```
6. Restart the container:
   ```bash
   docker restart <container>
   ```

### 2.2 Database Locked (`SQLITE_BUSY`)

**Symptoms:** Intermittent `500` errors; logs show `SQLITE_BUSY: database is locked`.

**Procedure:**

1. Identify long-running queries or concurrent writers. SQLite allows only one writer at a time.
2. Check for zombie processes holding the lock:
   ```bash
   fuser /app/data/timesheet.db
   ```
3. If a backup or external process holds the lock, terminate it.
4. As a short-term fix, restart the application:
   ```bash
   docker restart <container>
   ```
5. **Long-term:** Consider enabling WAL mode by adding to database init:
   ```sql
   PRAGMA journal_mode=WAL;
   ```

### 2.3 Database Corruption

**Symptoms:** `SQLITE_CORRUPT` or `SQLITE_NOTADB` in logs.

**Procedure:**

1. Stop the application to prevent further writes.
2. Attempt an integrity check:
   ```bash
   sqlite3 /app/data/timesheet.db "PRAGMA integrity_check;"
   ```
3. If corruption is minor, try to dump and reload:
   ```bash
   sqlite3 /app/data/timesheet.db ".dump" > backup.sql
   mv /app/data/timesheet.db /app/data/timesheet.db.corrupt
   sqlite3 /app/data/timesheet.db < backup.sql
   ```
4. If unrecoverable, restore from the most recent backup.
5. Restart the application.

### 2.4 Schema Migration Failure

**Symptoms:** Server fails to start; logs show `Failed to start server` with a SQL error during `initializeDatabase()`.

**Procedure:**

1. Review the error message — it usually indicates a column or table conflict.
2. All schema uses `CREATE TABLE IF NOT EXISTS`, so this is rare. If a column was added manually and conflicts, back up the DB and drop/recreate the table.
3. Restart after fixing.

---

## 3. API / Backend Errors

### 3.1 Server Won't Start

**Symptoms:** Process exits immediately; health endpoint unreachable.

**Procedure:**

1. Check logs for the startup error:
   ```bash
   docker logs <container> --tail 50
   ```
2. Common causes:
   - **Port already in use:** `Error: listen EADDRINUSE :::3001` — kill the conflicting process or change `PORT`.
   - **Missing dependency:** `Cannot find module 'xyz'` — run `npm install` or rebuild the container.
   - **Database init failure:** See [Section 2](#2-database-failures).
3. Restart after resolving.

### 3.2 Unhandled Promise Rejection / Crash Loop

**Symptoms:** Container restarts repeatedly; logs show `UnhandledPromiseRejectionWarning`.

**Procedure:**

1. Capture the full stack trace from logs.
2. Identify the originating route or middleware.
3. If the crash is in a database callback, check DB connectivity (Section 2).
4. Deploy a hotfix or roll back to the previous image:
   ```bash
   docker run -d <previous-image-tag>
   ```

### 3.3 Validation Errors Spike (Joi)

**Symptoms:** Surge in `400 Validation error` responses.

**Procedure:**

1. This is usually a client-side issue (bad payload). Check if a frontend deployment introduced a schema mismatch.
2. Review the `details` array in the 400 response body to understand which field is failing.
3. Compare the frontend request payload against the Joi schemas in `backend/src/validation/schemas.js`.

---

## 4. Authentication Failures

### 4.1 All Requests Return 401

**Symptoms:** Every authenticated endpoint returns `{"error":"User email required in x-user-email header"}`.

**Procedure:**

1. Verify the frontend is sending the `x-user-email` header. Open browser DevTools → Network tab → check request headers.
2. Check that `localStorage.getItem('userEmail')` returns a value in the browser console.
3. If the Vite proxy is stripping headers, check `frontend/vite.config.ts` proxy settings.
4. In production (Docker), verify CORS and Helmet are not blocking the custom header.

### 4.2 User Auto-Creation Failures

**Symptoms:** New users get `500 Failed to create user` on first login.

**Procedure:**

1. Check database connectivity (Section 2).
2. Verify the `users` table exists:
   ```bash
   sqlite3 /app/data/timesheet.db ".tables"
   ```
3. Check for unique constraint violations if the email already exists with different casing.

---

## 5. Rate Limiting Issues

### 5.1 Legitimate Users Blocked (429 Too Many Requests)

**Symptoms:** Users receive `429` after moderate usage; current limit is 100 requests per 15 minutes per IP.

**Procedure:**

1. Confirm the user is actually rate-limited (not a different error).
2. If behind a reverse proxy / load balancer, ensure `trust proxy` is set so rate limiting uses the real client IP, not the proxy IP:
   ```js
   app.set('trust proxy', 1);
   ```
3. Temporarily increase the limit by setting the environment variable or editing `server.js`:
   ```js
   max: 200
   ```
4. Restart the application.
5. **Long-term:** Consider per-user rate limiting instead of per-IP.

---

## 6. Report Generation Failures (PDF / CSV)

### 6.1 CSV Export Fails

**Symptoms:** `500 Failed to generate CSV report`; logs may show `ENOSPC` or `EACCES`.

**Procedure:**

1. Check disk space on the host:
   ```bash
   df -h
   ```
2. Check the temp directory exists and is writable:
   ```bash
   ls -la backend/temp/   # or /app/temp/ in Docker
   ```
3. If disk is full, clean up old temp files:
   ```bash
   rm -f backend/temp/*.csv
   ```
4. The app auto-cleans temp files after download, but crashes can leave orphans.

### 6.2 PDF Export Fails

**Symptoms:** `500 Failed to generate PDF report`; PDFKit errors in logs.

**Procedure:**

1. Same disk-space checks as CSV.
2. If the error is related to fonts or rendering, check that `pdfkit` and its dependencies are installed:
   ```bash
   npm ls pdfkit
   ```
3. For very large reports (thousands of entries), the PDF may exhaust memory — see Section 8.

### 6.3 Temp File Accumulation

**Symptoms:** Disk usage grows over time in the `temp/` directory.

**Procedure:**

1. List orphaned files:
   ```bash
   find backend/temp/ -name "*.csv" -mmin +60
   ```
2. Remove them:
   ```bash
   find backend/temp/ -name "*.csv" -mmin +60 -delete
   ```
3. Consider a cron job for periodic cleanup.

---

## 7. Frontend / Proxy Failures

### 7.1 Vite Dev Proxy Not Forwarding (Development)

**Symptoms:** Frontend shows network errors; API calls fail with CORS or connection refused.

**Procedure:**

1. Ensure the backend is running on port 3001:
   ```bash
   curl http://localhost:3001/health
   ```
2. Check `frontend/vite.config.ts` — the proxy target must match the backend port.
3. Restart the Vite dev server:
   ```bash
   cd frontend && npm run dev
   ```

### 7.2 Static File Serving Broken (Production)

**Symptoms:** In Docker, navigating to the app shows a blank page or 404.

**Procedure:**

1. Verify the frontend build artifacts exist:
   ```bash
   docker exec <container> ls /app/public/
   # Should contain index.html, assets/, etc.
   ```
2. If missing, the Docker build stage may have failed. Rebuild:
   ```bash
   docker build -f docker/Dockerfile -t timesheet-app .
   ```
3. Check that `docker/overrides/server.js` has the static file serving middleware.

### 7.3 CORS Errors in Browser

**Symptoms:** Browser console shows `Access-Control-Allow-Origin` errors.

**Procedure:**

1. In development, check that `FRONTEND_URL` in `backend/.env` matches the Vite dev server URL (`http://localhost:5173`).
2. In production, CORS is set to same-origin (`true`). If the frontend is served from a different domain, update the CORS origin in `docker/overrides/server.js`.

---

## 8. Memory & Resource Exhaustion

### 8.1 Node.js Out of Memory (OOM)

**Symptoms:** Process killed by OS; `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed` in logs.

**Procedure:**

1. Check container memory limits:
   ```bash
   docker stats <container>
   ```
2. Common triggers:
   - Generating a PDF/CSV report for a client with thousands of entries.
   - Large request body (limit is 10 MB).
3. Increase the Node.js heap if needed:
   ```bash
   NODE_OPTIONS="--max-old-space-size=512" node src/server.js
   ```
4. **Long-term:** Add pagination to report endpoints; stream large exports instead of buffering.

### 8.2 High CPU / Event Loop Lag

**Symptoms:** Responses become very slow; health check times out.

**Procedure:**

1. Identify heavy operations via logs (morgan combined format includes response times if piped to a log aggregator).
2. Profile with:
   ```bash
   node --prof src/server.js
   ```
3. Common cause: synchronous SQLite operations blocking the event loop during large queries.

---

## 9. Docker / Container Failures

### 9.1 Container Health Check Failing

**Symptoms:** Docker marks the container as `unhealthy`; orchestrator may restart it.

**Procedure:**

1. The health check runs:
   ```bash
   node -e "require('http').get('http://localhost:3001/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"
   ```
2. Exec into the container and run it manually to see the error.
3. If the server is up but slow, the 3-second timeout may be too short. Increase `--timeout` in the Dockerfile `HEALTHCHECK` directive.

### 9.2 Container Fails to Build

**Symptoms:** `docker build` errors out.

**Procedure:**

1. Check which stage failed (frontend-builder, backend-builder, production).
2. Common causes:
   - `npm ci` failure due to lockfile mismatch — regenerate `package-lock.json`.
   - `sqlite3` native addon build failure — ensure `node:20-alpine` has the required build tools, or use a prebuilt binary.
3. Rebuild with `--no-cache`:
   ```bash
   docker build --no-cache -f docker/Dockerfile -t timesheet-app .
   ```

### 9.3 Data Volume Not Mounted

**Symptoms:** Data disappears on container restart.

**Procedure:**

1. Verify the volume mount:
   ```bash
   docker inspect <container> | grep -A10 Mounts
   ```
2. Ensure you are running with a persistent volume:
   ```bash
   docker run -v timesheet-data:/app/data ...
   ```

---

## 10. Dependency & Supply-Chain Failures

### 10.1 npm Install Fails in CI/CD

**Symptoms:** CI pipeline fails at the install step.

**Procedure:**

1. Check the npm registry is reachable.
2. Clear the npm cache: `npm cache clean --force`.
3. If a specific package version was unpublished, update `package-lock.json`.
4. Check for known vulnerabilities: `npm audit`.

### 10.2 Vulnerable Dependency Detected

**Symptoms:** SonarCloud or the `sast-scan` / CVE workflow flags a vulnerability.

**Procedure:**

1. Review the advisory in the CI output or GitHub Security tab.
2. Attempt to update the vulnerable package:
   ```bash
   npm update <package>
   ```
3. If a major version bump is needed, test thoroughly before merging.
4. The repo has an auto-remediation workflow (`.github/workflows/sast-scan.yml`) that may create a fix PR automatically.

---

## 11. Data Loss (In-Memory DB Restart)

**Symptoms (Development):** All data disappears after the backend process restarts.

**Explanation:** The development database uses SQLite `:memory:`, which is ephemeral.

**Procedure:**

1. This is expected behavior in development.
2. Re-seed data by logging in and re-creating clients/entries.
3. **For persistent dev data**, switch to a file-based database by setting `DATABASE_PATH` in `backend/.env`:
   ```
   DATABASE_PATH=./data/dev.db
   ```

---

## 12. Contact & Escalation

| Priority | Response SLA | Escalation Path |
|----------|-------------|-----------------|
| P1 — Critical | 15 min acknowledge, 1 hr mitigate | On-call → Engineering Lead → VP Eng |
| P2 — Major | 30 min acknowledge, 4 hr mitigate | On-call → Engineering Lead |
| P3 — Minor | 1 business day | On-call → Team backlog |
| P4 — Low | Best effort | Team backlog |

### Useful Links

- **Health check:** `GET /health`
- **Application logs:** `docker logs <container>` or process stdout
- **GitHub repo:** `infosys-training/timesheet-app`
- **CI/CD:** `.github/workflows/pr-checks.yml`, `.github/workflows/sast-scan.yml`
- **Health-check script:** `scripts/health-check.sh`
