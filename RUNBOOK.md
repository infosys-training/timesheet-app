# Timesheet App Incident Response Runbook

## Table of Contents

- [Overview](#overview)
- [Severity Levels](#severity-levels)
- [General Triage Procedure](#general-triage-procedure)
- [INC-01: Database Failure (SQLite)](#inc-01-database-failure-sqlite)
- [INC-02: Backend API Unresponsive](#inc-02-backend-api-unresponsive)
- [INC-03: Authentication Failures](#inc-03-authentication-failures)
- [INC-04: Memory Exhaustion / OOM](#inc-04-memory-exhaustion--oom)
- [INC-05: Rate Limiting Blocking Legitimate Users](#inc-05-rate-limiting-blocking-legitimate-users)
- [INC-06: PDF/CSV Export Failures](#inc-06-pdfcsv-export-failures)
- [INC-07: Frontend Build / Serving Failures](#inc-07-frontend-build--serving-failures)
- [INC-08: Dependency Vulnerability / Supply Chain Issue](#inc-08-dependency-vulnerability--supply-chain-issue)
- [INC-09: Docker Container Crashes](#inc-09-docker-container-crashes)
- [INC-10: Data Loss (In-Memory DB Restart)](#inc-10-data-loss-in-memory-db-restart)
- [INC-11: CORS / Proxy Misconfiguration](#inc-11-cors--proxy-misconfiguration)
- [INC-12: Disk Full (Temp Files / Logs)](#inc-12-disk-full-temp-files--logs)
- [Post-Incident Review Template](#post-incident-review-template)
- [Contacts](#contacts)

---

## Overview

This runbook covers the **timesheet-app**, a full-stack application (Express + React) for tracking employee labor hours. It uses SQLite for storage, Joi for validation, PDFKit/csv-writer for exports, and is optionally deployed via Docker.

**Architecture summary:**

```
Browser (React/Vite :5173)
  └─ Vite proxy /api/* ──► Express API (:3001)
                              ├─ /health
                              ├─ /api/auth/*
                              ├─ /api/clients/*
                              ├─ /api/work-entries/*
                              └─ /api/reports/*
                                    └─ SQLite (in-memory or file-based)
```

---

## Severity Levels

| Level | Name | Definition | Response SLA |
|-------|------|-----------|-------------|
| P1 | Critical | Service is down for all users; data loss occurring | 15 min acknowledge, 1 hr mitigate |
| P2 | Major | Core functionality degraded (e.g., exports broken, auth intermittent) | 30 min acknowledge, 4 hr mitigate |
| P3 | Minor | Non-critical feature impacted; workaround available | 4 hr acknowledge, 24 hr mitigate |
| P4 | Low | Cosmetic issue, minor inconvenience, or improvement request | 1 business day acknowledge |

---

## General Triage Procedure

1. **Confirm the symptom.** Reproduce the issue or verify via the health check script (`scripts/health-check.sh`).
2. **Check logs.** `docker logs <container>` or `journalctl -u timesheet-app` or directly in the terminal running the process.
3. **Identify the component.** Is it backend (Express), frontend (Vite/React), database (SQLite), or infrastructure (Docker, network)?
4. **Correlate with recent changes.** Check the last deploy, merged PRs, or dependency updates.
5. **Mitigate first, root-cause later.** Restart, rollback, or apply a workaround before deep-diving.
6. **Communicate.** Open an incident issue using the appropriate template and post status updates.
7. **Document.** Fill out the post-incident review after resolution.

---

## INC-01: Database Failure (SQLite)

**Symptoms:** API returns `500` with `"Database error"` message; logs show `SQLITE_*` error codes.

**Possible causes:**
- File-based DB: disk full, file permissions changed, DB file corrupted.
- In-memory DB: process crash wiped the database; schema init race condition.
- Concurrent writes exceeding SQLite's single-writer lock.

**Diagnosis:**

```bash
# Check if backend is running
curl -s http://localhost:3001/health | jq .

# Look for SQLITE_ errors in logs
docker logs <container> 2>&1 | grep -i "SQLITE_"

# (File-based) Check database file
ls -la /app/data/timesheet.db
file /app/data/timesheet.db
sqlite3 /app/data/timesheet.db "PRAGMA integrity_check;"

# Check disk space
df -h /app/data/
```

**Mitigation:**

1. **File permissions:** `chmod 664 /app/data/timesheet.db && chown nodejs:nodejs /app/data/timesheet.db`
2. **Disk full:** Free space or expand volume, then restart the backend.
3. **Corrupted DB:** Restore from backup. If no backup exists, delete the DB file and restart (data will be re-initialized with empty tables).
4. **In-memory DB crash:** Restart the backend process — the DB will be recreated. Note: all data is lost for in-memory mode.

**Prevention:**
- Use file-based SQLite in production (`DATABASE_PATH` env var).
- Schedule regular backups of the `.db` file.
- Monitor disk usage on the data volume.

---

## INC-02: Backend API Unresponsive

**Symptoms:** `/health` returns no response or times out; frontend shows network errors.

**Possible causes:**
- Process crashed (unhandled exception, OOM kill).
- Port 3001 in use by another process.
- Database initialization failed on startup.

**Diagnosis:**

```bash
# Check if process is running
pgrep -a node
# or in Docker
docker ps -a | grep timesheet

# Check port usage
lsof -i :3001
# or
ss -tlnp | grep 3001

# Check container logs for crash
docker logs --tail 100 <container>

# Check for OOM kills
dmesg | grep -i "oom\|killed"
```

**Mitigation:**

1. **Restart the backend:**
   - Bare metal: `npm start` or `npm run dev` in `backend/`
   - Docker: `docker restart <container>`
2. **Port conflict:** Kill the conflicting process (`kill <PID>`) and restart.
3. **DB init failure:** Check database diagnostics (see INC-01), then restart.
4. **Persistent crash loop:** Check logs for the stack trace, roll back to the last working version.

---

## INC-03: Authentication Failures

**Symptoms:** Users cannot log in; API returns `401` or `500` on `/api/auth/login` or protected routes.

**Possible causes:**
- Missing `x-user-email` header (client-side bug or proxy stripping headers).
- Database not initialized (users table missing).
- Email validation rejecting valid addresses (regex mismatch).

**Diagnosis:**

```bash
# Test login directly
curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}' | jq .

# Test authenticated endpoint
curl -s http://localhost:3001/api/auth/me \
  -H "x-user-email: test@example.com" | jq .

# Check if users table exists (file-based DB)
sqlite3 /app/data/timesheet.db ".tables"
```

**Mitigation:**

1. **Missing header:** Verify the frontend Axios interceptor is attaching `x-user-email`. Check `localStorage.getItem('userEmail')` in the browser console.
2. **DB not initialized:** Restart the backend to trigger `initializeDatabase()`.
3. **Proxy stripping headers:** Ensure reverse proxy (nginx, etc.) passes `x-user-email` through.

---

## INC-04: Memory Exhaustion / OOM

**Symptoms:** Process killed by OS; `dmesg` shows OOM; container restarts repeatedly.

**Possible causes:**
- Large PDF/CSV export processing many work entries.
- Memory leak from unclosed database connections.
- Node.js heap exhaustion under sustained load.

**Diagnosis:**

```bash
# Check memory usage
free -m
docker stats <container>

# Check for OOM kills
dmesg | tail -20 | grep -i oom

# Check Node.js heap (if process is still running)
kill -USR2 <node_pid>  # generates a heap snapshot if --inspect is enabled
```

**Mitigation:**

1. **Immediate:** Restart the container/process with a higher memory limit: `docker run -m 512m ...`
2. **Large exports:** Limit the date range or number of entries per export.
3. **Leak investigation:** Enable `--inspect` flag and capture heap snapshots with Chrome DevTools.

**Prevention:**
- Set Docker memory limits (`deploy.resources.limits.memory` in compose).
- Add pagination to report queries.
- Monitor container memory via `docker stats` or a monitoring tool.

---

## INC-05: Rate Limiting Blocking Legitimate Users

**Symptoms:** Users receive `429 Too Many Requests` during normal usage.

**Possible causes:**
- Default limit (100 req / 15 min per IP) is too low for the user's workflow.
- Multiple users sharing a single IP (NAT, VPN, corporate proxy).

**Diagnosis:**

```bash
# Check rate limit headers in response
curl -si http://localhost:3001/health | grep -i "ratelimit\|retry"

# Check how many requests the user has made
# (review morgan/combined access logs)
docker logs <container> 2>&1 | grep "<user-ip>" | wc -l
```

**Mitigation:**

1. **Short-term:** Increase the limit in `backend/src/server.js`:
   ```js
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 500  // increase as needed
   });
   ```
2. **Targeted:** Add per-user rate limiting keyed on `x-user-email` instead of IP.
3. **If under attack:** Keep rate limits and investigate the source IPs.

---

## INC-06: PDF/CSV Export Failures

**Symptoms:** `/api/reports/export/csv/:clientId` or `/api/reports/export/pdf/:clientId` returns `500`.

**Possible causes:**
- Temp directory (`backend/temp/`) does not exist or lacks write permissions.
- Disk full — CSV file cannot be written.
- PDFKit error on large datasets.
- Client has zero work entries (edge case).

**Diagnosis:**

```bash
# Test export
curl -s -o /dev/null -w "%{http_code}" \
  -H "x-user-email: test@example.com" \
  http://localhost:3001/api/reports/export/csv/1

# Check temp directory
ls -la backend/temp/ 2>/dev/null || echo "temp dir missing"

# Check disk
df -h .

# Check logs
docker logs <container> 2>&1 | grep -i "csv\|pdf\|export"
```

**Mitigation:**

1. **Missing temp dir:** `mkdir -p backend/temp && chmod 755 backend/temp`
2. **Disk full:** Free disk space, then retry.
3. **Large export OOM:** Limit the query with date filters, or stream the PDF instead of buffering.

---

## INC-07: Frontend Build / Serving Failures

**Symptoms:** Blank page in browser; Vite dev server won't start; `npm run build` fails.

**Possible causes:**
- Missing `node_modules` — dependencies not installed.
- TypeScript compilation errors.
- Vite config issue or port conflict (5173).
- Environment variable `VITE_API_URL` misconfigured.

**Diagnosis:**

```bash
# Check if dev server is running
curl -s -o /dev/null -w "%{http_code}" http://localhost:5173

# Check for build errors
cd frontend && npm run build 2>&1

# Check port
lsof -i :5173
```

**Mitigation:**

1. **Missing deps:** `cd frontend && npm install`
2. **TS errors:** Fix type errors shown in `npm run build` output.
3. **Port conflict:** Kill conflicting process or change port in `vite.config.ts`.
4. **Docker (production):** Frontend is pre-built and served as static files by Express. Check that `public/` directory exists in the container.

---

## INC-08: Dependency Vulnerability / Supply Chain Issue

**Symptoms:** CI/CD pipeline fails on SAST or CVE scan; SonarCloud quality gate blocks merge.

**Possible causes:**
- Known vulnerability in a transitive dependency.
- New CVE published for an existing package version.
- Lockfile out of sync with `package.json`.

**Diagnosis:**

```bash
# Backend audit
cd backend && npm audit

# Frontend audit
cd frontend && npm audit

# Check SonarCloud dashboard
# (see sonar-project.properties for project key)
```

**Mitigation:**

1. **Auto-remediation:** The repo has a Devin auto-fix workflow in `.github/workflows/sast-scan.yml`. Check if it has already created a remediation PR.
2. **Manual fix:** `npm audit fix` or `npm audit fix --force` (test thoroughly after).
3. **Pin a safe version:** Override the vulnerable transitive dep in `package.json` overrides field.
4. **Accept risk (P4):** If the vulnerability is not exploitable in this context, document the rationale and suppress the finding.

---

## INC-09: Docker Container Crashes

**Symptoms:** Container exits immediately; health check fails; `docker ps` shows restart loop.

**Possible causes:**
- Database path volume not mounted.
- Missing environment variables (`PORT`, `DATABASE_PATH`).
- Override files (`docker/overrides/`) out of sync with source.

**Diagnosis:**

```bash
# Check container status and exit code
docker ps -a | grep timesheet
docker inspect <container> --format='{{.State.ExitCode}}'

# Check logs
docker logs --tail 50 <container>

# Verify volume mounts
docker inspect <container> --format='{{json .Mounts}}' | jq .

# Verify health check
docker inspect <container> --format='{{json .State.Health}}' | jq .
```

**Mitigation:**

1. **Missing volume:** Re-run with volume mount: `docker run -v timesheet-data:/app/data ...`
2. **Missing env vars:** Ensure `PORT`, `NODE_ENV`, and `DATABASE_PATH` are set.
3. **Override mismatch:** Compare `docker/overrides/server.js` with `backend/src/server.js` to ensure compatibility.
4. **Rebuild image:** `docker build -f docker/Dockerfile -t timesheet-app .`

---

## INC-10: Data Loss (In-Memory DB Restart)

**Symptoms:** All clients and work entries are gone after a restart.

**Root cause:** The development configuration uses SQLite `:memory:`, which is wiped when the process stops.

**Mitigation:**

1. **Inform users:** This is expected behavior in development/demo mode.
2. **Switch to file-based SQLite for production:**
   - Set `DATABASE_PATH=/app/data/timesheet.db` environment variable.
   - Use the Docker build which includes `docker/overrides/database/init.js` for file-based storage.
3. **Backup strategy for file-based DB:**
   ```bash
   # Simple backup
   sqlite3 /app/data/timesheet.db ".backup '/backups/timesheet-$(date +%Y%m%d).db'"
   ```

---

## INC-11: CORS / Proxy Misconfiguration

**Symptoms:** Browser console shows CORS errors; API calls fail from frontend but work via `curl`.

**Possible causes:**
- `FRONTEND_URL` env var does not match the actual frontend origin.
- Reverse proxy not forwarding `Origin` or `Access-Control-*` headers.
- Vite proxy config not forwarding `/api` to backend.

**Diagnosis:**

```bash
# Check current CORS config
grep FRONTEND_URL backend/.env

# Test CORS preflight
curl -si -X OPTIONS http://localhost:3001/api/clients \
  -H "Origin: http://localhost:5173" \
  -H "Access-Control-Request-Method: GET" | head -20
```

**Mitigation:**

1. **Fix `FRONTEND_URL`** in `backend/.env` to match the actual frontend URL (e.g., `http://localhost:5173`).
2. **Vite proxy:** Ensure `vite.config.ts` has the `/api` proxy pointing to `http://localhost:3001`.
3. **Production reverse proxy:** Add appropriate `Access-Control-*` headers in nginx/Caddy config.

---

## INC-12: Disk Full (Temp Files / Logs)

**Symptoms:** Exports fail; database writes fail; container becomes unresponsive.

**Possible causes:**
- CSV temp files not cleaned up after failed downloads.
- Morgan access logs growing without rotation.
- SQLite WAL/journal files consuming space.

**Diagnosis:**

```bash
df -h
du -sh backend/temp/ 2>/dev/null
du -sh /app/data/ 2>/dev/null

# Find large files
find / -type f -size +100M 2>/dev/null
```

**Mitigation:**

1. **Clean temp files:** `rm -f backend/temp/*.csv`
2. **Rotate logs:** Configure log rotation for morgan output or use an external log aggregator.
3. **Expand disk:** Increase the volume size if running in cloud infrastructure.

---

## Post-Incident Review Template

After resolving any P1 or P2 incident, complete this review within 48 hours:

```markdown
### Incident Review: [INC-XXX] Title

**Date:** YYYY-MM-DD
**Duration:** Start time – End time (total minutes)
**Severity:** P1/P2/P3/P4
**Responders:** @names

#### Summary
One paragraph describing what happened.

#### Timeline
- HH:MM — Alert triggered / user report
- HH:MM — Responder acknowledged
- HH:MM — Root cause identified
- HH:MM — Mitigation applied
- HH:MM — Full resolution confirmed

#### Root Cause
Description of the underlying issue.

#### What Went Well
- ...

#### What Could Be Improved
- ...

#### Action Items
| Action | Owner | Due Date |
|--------|-------|----------|
| ... | @name | YYYY-MM-DD |
```

---

## Contacts

| Role | Contact |
|------|---------|
| On-call engineer | See team rotation schedule |
| Backend owner | Check `CODEOWNERS` or team lead |
| Frontend owner | Check `CODEOWNERS` or team lead |
| Infrastructure | DevOps / Platform team |
