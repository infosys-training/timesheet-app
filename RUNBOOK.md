# Timesheet App — Incident Response Runbook

> **Audience:** On-call engineers and SREs  
> **Last updated:** 2026-06-09  
> **Stack:** Node.js · Express · SQLite (in-memory) · React · Vite · Axios · Docker

---

## Table of Contents

1. [General Triage Checklist](#1-general-triage-checklist)
2. [Database Failures](#2-database-failures)
3. [API / Express Failures](#3-api--express-failures)
4. [Memory & Process Failures](#4-memory--process-failures)
5. [Dependency & Infrastructure Failures](#5-dependency--infrastructure-failures)
6. [Frontend Failures](#6-frontend-failures)
7. [Security Incidents](#7-security-incidents)
8. [Escalation Matrix](#8-escalation-matrix)
9. [Post-Incident Review Template](#9-post-incident-review-template)

---

## 1. General Triage Checklist

Run these steps **first** for every incident before diving into a specific section.

```bash
# 1. Verify the backend process is running
curl -sf http://localhost:3001/health | jq .

# 2. Check backend logs (last 200 lines)
docker logs --tail 200 timesheet-backend   # Docker
# OR
journalctl -u timesheet-backend -n 200     # systemd

# 3. Check Node.js process resource usage
ps aux | grep "node src/server.js"

# 4. Check disk space (relevant for CSV/PDF temp files)
df -h /tmp

# 5. Check open file descriptors
ls /proc/$(pgrep -f "node src/server.js")/fd | wc -l

# 6. Verify frontend is reachable
curl -sf http://localhost:5173/ | head -20

# 7. Run the health check script
./scripts/healthcheck.sh
```

---

## 2. Database Failures

### 2.1 In-Memory Data Loss (Process Restart)

**Symptoms:** All user data missing after a deploy or crash. API returns empty arrays for `/api/clients` and `/api/work-entries`.

**Root cause:** The app uses `sqlite3.Database(':memory:')`. Any process restart destroys all data.

**Immediate response:**
1. Confirm the process restarted: check uptime via `ps -o etime= -p $(pgrep -f "node src/server.js")`.
2. Check crash logs for the trigger (OOM kill, unhandled rejection, deploy, etc.).
3. Notify affected users that data has been lost.

**Mitigation:**
```bash
# Switch to file-based SQLite for persistence (requires code change):
# In backend/src/database/init.js, replace:
#   db = new sqlite3.Database(':memory:', ...)
# With:
#   db = new sqlite3.Database('/data/timesheet.db', ...)
# Then mount /data as a persistent volume in Docker.
```

**Prevention:**
- Move to file-based SQLite or an external database (PostgreSQL/MySQL).
- Implement automated backups if using file-based SQLite.
- Add a graceful shutdown handler to export data before process exit.

---

### 2.2 SQLite BUSY / Write Contention

**Symptoms:** Sporadic `500 Internal Server Error` on POST/PUT/DELETE requests. Logs show `SQLITE_BUSY` errors.

**Root cause:** SQLite allows only one writer at a time. Under concurrent writes, requests queue up and can timeout.

**Immediate response:**
1. Check logs: `grep "SQLITE_BUSY" /var/log/timesheet/*.log`
2. Identify if a long-running query is holding the lock.
3. Restart the backend if the lock appears stuck.

**Mitigation:**
```bash
# Enable WAL mode for better concurrency (add to initializeDatabase()):
#   database.run('PRAGMA journal_mode=WAL');
#   database.run('PRAGMA busy_timeout=5000');
```

**Prevention:**
- Enable WAL journal mode.
- Set a `busy_timeout` so SQLite retries instead of failing immediately.
- For high-concurrency workloads, migrate to PostgreSQL.

---

### 2.3 Schema Initialization Failure

**Symptoms:** Server fails to start. Logs show `Failed to start server:` followed by a SQLite error. Health check returns connection refused.

**Root cause:** `initializeDatabase()` runs table creation in `serialize()`. If any statement fails, subsequent tables may not be created.

**Immediate response:**
1. Check startup logs for the specific SQL error.
2. Verify the `sqlite3` native module is compiled for the current Node.js version:
   ```bash
   node -e "require('sqlite3')"
   ```
3. If the native module is broken, rebuild:
   ```bash
   cd backend && npm rebuild sqlite3
   ```

**Prevention:**
- Pin Node.js version in `.nvmrc` or `engines` field.
- Run `npm rebuild` as part of the Docker build.
- Add a startup health check that verifies all tables exist.

---

## 3. API / Express Failures

### 3.1 Rate Limit Exhaustion (HTTP 429)

**Symptoms:** Legitimate users receive `429 Too Many Requests`. Frontend shows generic error messages.

**Root cause:** Global rate limiter is set to 100 requests per 15 minutes per IP. Shared office IPs or automated integrations can exhaust this quickly.

**Immediate response:**
1. Identify the affected IP(s) from access logs: `grep " 429 " /var/log/timesheet/access.log`
2. Temporarily increase the limit:
   ```bash
   # Set environment variable and restart
   export RATE_LIMIT_MAX=500
   ```
3. If a single IP is abusing the API, block it at the reverse proxy level.

**Mitigation:**
- Increase `max` in the rate limiter configuration or make it configurable via env var.
- Apply rate limiting per-route instead of globally (e.g., stricter on `/api/auth/login`, relaxed on `/api/clients`).

---

### 3.2 CORS Rejection

**Symptoms:** Frontend cannot reach the backend. Browser console shows `Access-Control-Allow-Origin` errors. All API calls fail.

**Root cause:** `FRONTEND_URL` environment variable doesn't match the actual frontend origin.

**Immediate response:**
1. Check the current CORS config:
   ```bash
   echo $FRONTEND_URL
   # Should match the origin the frontend is served from
   ```
2. Fix the variable and restart:
   ```bash
   export FRONTEND_URL=https://your-actual-frontend-domain.com
   ```

**Prevention:**
- Document the required `FRONTEND_URL` value for each environment.
- Consider allowing multiple origins for staging/production.

---

### 3.3 Validation Error Storm

**Symptoms:** High volume of `400 Bad Request` responses. Logs filled with Joi validation errors.

**Root cause:** Frontend sending malformed payloads (version mismatch after deploy), or an external client using the API incorrectly.

**Immediate response:**
1. Check which endpoint and payload is triggering errors:
   ```bash
   grep "Validation error" /var/log/timesheet/*.log | tail -20
   ```
2. Compare the frontend build version against the backend API expectations.
3. If caused by a bad deploy, roll back the frontend or backend.

**Prevention:**
- Version the API (`/api/v1/...`).
- Add request/response schema documentation (OpenAPI/Swagger).

---

### 3.4 Authentication Failures (Missing x-user-email Header)

**Symptoms:** All authenticated endpoints return `401 User email required`. Users appear logged out.

**Root cause:** Frontend is not sending the `x-user-email` header. Possible causes: `localStorage` cleared, Axios interceptor broken, or proxy stripping custom headers.

**Immediate response:**
1. Test with curl:
   ```bash
   curl -H "x-user-email: test@example.com" http://localhost:3001/api/clients
   ```
2. If curl works, the issue is frontend-side — check the Axios request interceptor in `frontend/src/api/client.ts`.
3. If curl fails, the issue is backend-side — check `backend/src/middleware/auth.js`.

---

## 4. Memory & Process Failures

### 4.1 OOM Kill / High Memory Usage

**Symptoms:** Process killed unexpectedly. `dmesg | grep -i oom` shows the Node.js process. Container restarts frequently.

**Root cause:** Likely a large PDF/CSV report generation or a memory leak in the SQLite connection pool.

**Immediate response:**
1. Check if an OOM kill occurred:
   ```bash
   dmesg | grep -i "out of memory"
   docker inspect timesheet-backend | grep -A 5 "State"
   ```
2. Check current memory usage:
   ```bash
   node -e "console.log(process.memoryUsage())"
   ```
3. Restart the process and monitor.

**Mitigation:**
- Set memory limits in Docker: `--memory=512m`
- Add pagination to report queries to avoid loading unbounded result sets.
- Stream PDF/CSV output instead of buffering in memory.

---

### 4.2 Temp File Accumulation

**Symptoms:** Disk fills up in `backend/temp/` directory. CSV export starts failing with `ENOSPC`.

**Root cause:** CSV reports are written to `backend/temp/` and cleaned up after download. If the cleanup callback races or the download fails, orphan files remain.

**Immediate response:**
1. Check temp directory size:
   ```bash
   du -sh backend/temp/
   ls -lt backend/temp/ | head -20
   ```
2. Clean up old files:
   ```bash
   find backend/temp/ -name "*.csv" -mmin +60 -delete
   ```

**Prevention:**
- Add a periodic cleanup cron job.
- Stream CSV directly to the response instead of writing to disk.
- Set a tmpwatch/systemd-tmpfiles rule on the temp directory.

---

### 4.3 Unhandled Promise Rejection / Crash

**Symptoms:** Process exits with code 1. Logs show `UnhandledPromiseRejectionWarning` or `unhandledRejection`.

**Root cause:** The codebase mixes callback-style SQLite operations with async/await. A thrown error inside a callback won't be caught by the surrounding try/catch.

**Immediate response:**
1. Check the crash log for the stack trace.
2. Restart the process.
3. Identify the specific callback that threw.

**Prevention:**
- Add a global `process.on('unhandledRejection', ...)` handler in `server.js`.
- Wrap SQLite callbacks in Promises consistently.
- Use a process manager (PM2, systemd) with automatic restart.

---

## 5. Dependency & Infrastructure Failures

### 5.1 Native Module Compilation Failure (sqlite3)

**Symptoms:** `npm install` or server startup fails with `Error: Cannot find module 'sqlite3'` or `node-pre-gyp` errors.

**Root cause:** `sqlite3` is a native C++ addon. Mismatched Node.js version, missing build tools, or architecture change breaks the binary.

**Immediate response:**
1. Rebuild native modules:
   ```bash
   cd backend && npm rebuild sqlite3
   ```
2. If that fails, check build tools:
   ```bash
   which node-gyp
   apt-get install -y build-essential python3
   npm rebuild sqlite3
   ```

**Prevention:**
- Pin the Node.js version in CI and Docker.
- Use `node-pre-gyp` prebuilt binaries when available.
- Include `npm rebuild` in the Docker build step.

---

### 5.2 Missing or Invalid .env Configuration

**Symptoms:** CORS errors (wrong `FRONTEND_URL`), wrong port binding, or JWT errors.

**Immediate response:**
1. Verify `.env` exists and has correct values:
   ```bash
   cat backend/.env
   ```
2. Compare against `.env.example`:
   ```bash
   diff backend/.env backend/.env.example
   ```

**Prevention:**
- CI should validate that all required env vars are set.
- Use a library like `envalid` or `dotenv-safe` for schema validation at startup.

---

### 5.3 Docker Container Fails to Start

**Symptoms:** `docker compose up` exits immediately or health check never passes.

**Immediate response:**
1. Check container logs:
   ```bash
   docker compose logs --tail 50 backend
   ```
2. Verify the Docker image builds:
   ```bash
   docker compose build --no-cache backend
   ```
3. Check if port 3001 is already in use:
   ```bash
   lsof -i :3001
   ```

---

## 6. Frontend Failures

### 6.1 Blank Page / Vite Build Failure

**Symptoms:** Frontend shows a white screen. Browser console shows JavaScript errors or 404 for assets.

**Immediate response:**
1. Check if the frontend dev server is running:
   ```bash
   curl -sf http://localhost:5173/ | head -5
   ```
2. Rebuild the frontend:
   ```bash
   cd frontend && npm run build
   ```
3. Check for TypeScript errors:
   ```bash
   cd frontend && npx tsc --noEmit
   ```

---

### 6.2 API Proxy Failure (Vite Dev Server)

**Symptoms:** All `/api/*` requests return 404 or connection refused in development.

**Root cause:** Vite proxy configuration in `vite.config.ts` points to `http://localhost:3001` but the backend isn't running.

**Immediate response:**
1. Verify backend is running: `curl http://localhost:3001/health`
2. Check Vite proxy config in `frontend/vite.config.ts`.
3. Restart both backend and frontend dev servers.

---

### 6.3 Axios Timeout (10s)

**Symptoms:** Frontend shows loading spinners indefinitely, then error messages. Network tab shows requests timing out at 10 seconds.

**Root cause:** Backend is slow (large report generation, DB lock) or unreachable.

**Immediate response:**
1. Test the slow endpoint directly:
   ```bash
   time curl -H "x-user-email: user@example.com" http://localhost:3001/api/reports/client/1
   ```
2. Check if the DB is locked (see §2.2).
3. Check backend CPU/memory usage.

---

## 7. Security Incidents

### 7.1 Rate Limit Bypass / DDoS

**Symptoms:** Abnormally high request volume. Logs show many requests from diverse IPs.

**Immediate response:**
1. Enable stricter rate limiting or WAF rules at the reverse proxy.
2. Identify attack patterns from access logs.
3. Block offending IP ranges.

### 7.2 Header Injection (x-user-email Spoofing)

**Symptoms:** Unauthorized data access. Users seeing other users' data.

**Root cause:** The `x-user-email` header has no cryptographic verification. Any client can set it to any email.

**Immediate response:**
1. Check access logs for suspicious email patterns.
2. Consider adding JWT-based authentication.
3. Audit data access for the affected time window.

---

## 8. Escalation Matrix

| Severity | Response Time | Who to Page | Examples |
|----------|--------------|-------------|----------|
| **P1 — Critical** | ≤ 15 min | On-call + Engineering Lead | Data loss, full outage, security breach |
| **P2 — Major** | ≤ 1 hour | On-call engineer | Partial outage, auth broken, reports failing |
| **P3 — Minor** | ≤ 4 hours | Assigned engineer | Slow responses, rate limiting false positives |
| **P4 — Low** | Next business day | Backlog | UI cosmetic issues, log noise |

---

## 9. Post-Incident Review Template

```markdown
## Incident Report: [Title]

**Date:** YYYY-MM-DD
**Duration:** HH:MM start → HH:MM resolved
**Severity:** P1 / P2 / P3 / P4
**On-call:** [Name]

### Summary
[1-2 sentence description of what happened]

### Timeline
- HH:MM — [Event]
- HH:MM — [Action taken]
- HH:MM — [Resolution]

### Root Cause
[Technical explanation]

### Impact
- Users affected: [count]
- Data lost: [yes/no, details]
- Revenue impact: [if applicable]

### Action Items
- [ ] [Preventive measure 1]
- [ ] [Preventive measure 2]

### Lessons Learned
[What went well, what didn't]
```
