# Timesheet App — Incident Response Runbook

This runbook covers the most common failure modes for the timesheet-app and provides step-by-step procedures for diagnosing and resolving each one.

**Stack summary:** Node.js/Express backend (port 3001), React/Vite frontend (port 5173 dev / served as static files in production), SQLite database (in-memory for dev, file-based in Docker production), email-only auth via `x-user-email` header.

---

## Table of Contents

1. [General Triage](#1-general-triage)
2. [Database Failures (SQLite)](#2-database-failures-sqlite)
3. [API / Express Server Errors](#3-api--express-server-errors)
4. [Authentication Failures](#4-authentication-failures)
5. [Rate Limiting Issues](#5-rate-limiting-issues)
6. [Memory Leaks / High Memory Usage](#6-memory-leaks--high-memory-usage)
7. [Dependency Failures (npm / node_modules)](#7-dependency-failures-npm--node_modules)
8. [Report Generation Failures (CSV / PDF)](#8-report-generation-failures-csv--pdf)
9. [Frontend Build / Serve Failures](#9-frontend-build--serve-failures)
10. [Docker / Container Failures](#10-docker--container-failures)
11. [CI/CD Pipeline Failures](#11-cicd-pipeline-failures)
12. [Contacts & Escalation](#12-contacts--escalation)

---

## 1. General Triage

Run these checks first for **any** incident:

```bash
# 1. Health check
curl -sf http://localhost:3001/health | jq .

# 2. Backend process alive?
pgrep -fa "node.*server.js"

# 3. Recent logs (Docker)
docker logs --tail 200 <container_name>

# 4. Disk / memory / CPU
df -h /app/data          # (production — SQLite file location)
free -m
top -bn1 | head -20

# 5. Network / port check
ss -tlnp | grep 3001
```

If the health check returns `{"status":"OK"}`, the backend is running and the database is accessible. Proceed to the specific failure section below.

---

## 2. Database Failures (SQLite)

### Symptoms

- API responses return `500` with `{"error":"Database error"}` or `{"error":"Internal server error"}`
- Backend logs show errors prefixed with `SQLITE_`
- Health check passes but all data-mutating requests fail

### Common Causes

| Cause | Environment | Notes |
|---|---|---|
| **In-memory DB lost on restart** | Development | By design — all data is ephemeral |
| **Database file locked** | Production (Docker) | Another process or stale lock on `/app/data/timesheet.db` |
| **Disk full** | Production (Docker) | Volume at `DATABASE_PATH` ran out of space |
| **Corrupt database file** | Production (Docker) | Unclean shutdown, disk error |
| **Schema init race condition** | Any | Concurrent startup before `initializeDatabase()` resolves |

### Response Steps

#### 2a. Development (in-memory)

1. **Accept data loss is normal.** Restarting the backend always clears the database.
2. Restart the backend:
   ```bash
   cd backend && npm run dev
   ```
3. If SQLite errors persist without a restart, check `node_modules/sqlite3` native bindings:
   ```bash
   cd backend && npm rebuild sqlite3
   ```

#### 2b. Production (file-based SQLite in Docker)

1. **Check disk space:**
   ```bash
   docker exec <container> df -h /app/data
   ```
   If full, free space or expand the volume.

2. **Check for stale locks:**
   ```bash
   docker exec <container> ls -la /app/data/timesheet.db*
   ```
   If `.db-wal` or `.db-shm` files are very large or stale, the database may need recovery.

3. **Attempt integrity check:**
   ```bash
   docker exec <container> node -e "
     const sqlite3 = require('sqlite3').verbose();
     const db = new sqlite3.Database('/app/data/timesheet.db');
     db.get('PRAGMA integrity_check', (err, row) => {
       console.log(err || row);
       db.close();
     });
   "
   ```
   - `{ integrity_check: 'ok' }` → database is healthy; problem is elsewhere.
   - Errors → restore from backup or recreate the database.

4. **Recover from backup (if available):**
   ```bash
   docker cp /backups/timesheet.db <container>:/app/data/timesheet.db
   docker restart <container>
   ```

5. **Last resort — recreate database:**
   ```bash
   docker exec <container> rm /app/data/timesheet.db*
   docker restart <container>
   ```
   > ⚠️ This destroys all existing data.

---

## 3. API / Express Server Errors

### Symptoms

- `curl http://localhost:3001/health` returns connection refused or non-200
- Frontend shows network errors / blank pages
- Logs show unhandled exceptions or `EADDRINUSE`

### Response Steps

1. **Check if the process is running:**
   ```bash
   pgrep -fa "node.*server.js"
   ```

2. **Check for port conflicts:**
   ```bash
   ss -tlnp | grep 3001
   ```
   If another process holds port 3001, kill it or change `PORT` in `.env`.

3. **Check logs for crash reason:**
   ```bash
   # Docker
   docker logs --tail 100 <container>
   # Development
   # Check terminal running `npm run dev`
   ```

4. **Common errors and fixes:**

   | Error | Fix |
   |---|---|
   | `EADDRINUSE` | Kill the existing process on port 3001: `kill $(lsof -t -i:3001)` |
   | `Cannot find module '...'` | Run `cd backend && npm install` |
   | `Failed to start server: ...` | Database init failed — see [Section 2](#2-database-failures-sqlite) |
   | Unhandled promise rejection | Check recent code changes; the `errorHandler` middleware should catch most errors |

5. **Restart the server:**
   ```bash
   # Development
   cd backend && npm run dev

   # Production (Docker)
   docker restart <container>
   ```

---

## 4. Authentication Failures

### Symptoms

- Requests return `401 User email required in x-user-email header`
- Requests return `400 Invalid email format`
- Frontend redirects to `/login` unexpectedly

### Response Steps

1. **Verify the `x-user-email` header is being sent:**
   ```bash
   curl -H "x-user-email: test@example.com" http://localhost:3001/api/clients
   ```

2. **Check `localStorage` in the browser:**
   Open DevTools → Application → Local Storage → look for `userEmail`. If missing, the user needs to log in again.

3. **Check CORS configuration:**
   Ensure `FRONTEND_URL` in `backend/.env` matches the origin of the frontend (e.g., `http://localhost:5173` for dev).

4. **Check the users table:**
   ```bash
   # In dev (in-memory), the user is created on first request.
   # If the DB was restarted, the user no longer exists — they just need to log in again.
   ```

---

## 5. Rate Limiting Issues

### Symptoms

- API returns `429 Too Many Requests`
- Legitimate users are blocked

### Context

The backend limits each IP to **100 requests per 15-minute window** (`express-rate-limit`).

### Response Steps

1. **Confirm rate limiting is the cause:**
   ```bash
   curl -v http://localhost:3001/health 2>&1 | grep "< HTTP"
   # Look for 429 status code
   ```

2. **Wait for the window to expire** (15 minutes), or restart the server to reset all counters.

3. **If legitimate traffic exceeds limits**, increase the `max` value in `backend/src/server.js`:
   ```js
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 100  // ← increase this
   });
   ```

---

## 6. Memory Leaks / High Memory Usage

### Symptoms

- Container OOM-killed or Node.js process crashes with `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed`
- Gradual increase in RSS memory over hours/days
- Slow responses under normal load

### Common Causes

- Large PDF/CSV report generation for clients with thousands of work entries
- Accumulation of temp CSV files in `backend/temp/` if cleanup fails
- SQLite caching behavior under heavy read load

### Response Steps

1. **Check current memory usage:**
   ```bash
   # Docker
   docker stats <container> --no-stream

   # Process-level
   ps -o pid,rss,vsz,comm -p $(pgrep -f "node.*server.js")
   ```

2. **Clean up temp files:**
   ```bash
   rm -f backend/temp/*.csv
   # or in Docker:
   docker exec <container> sh -c "rm -f /app/temp/*.csv"
   ```

3. **Take a heap snapshot (development):**
   ```bash
   kill -USR2 $(pgrep -f "node.*server.js")
   # Or use --inspect flag and Chrome DevTools
   node --inspect src/server.js
   ```

4. **Restart to recover immediately:**
   ```bash
   docker restart <container>
   ```

5. **Long-term:** Monitor memory with container resource limits:
   ```bash
   docker run --memory=512m --memory-swap=512m <image>
   ```

---

## 7. Dependency Failures (npm / node_modules)

### Symptoms

- `Cannot find module 'express'` (or any dependency)
- `npm install` fails with network or permission errors
- Native module errors for `sqlite3` (e.g., `NODE_MODULE_VERSION mismatch`)

### Response Steps

1. **Reinstall dependencies:**
   ```bash
   cd backend && rm -rf node_modules && npm install
   cd frontend && rm -rf node_modules && npm install
   ```

2. **Rebuild native modules (sqlite3):**
   ```bash
   cd backend && npm rebuild sqlite3
   ```

3. **Node.js version mismatch:**
   ```bash
   node --version   # Should be 18+ (20 recommended)
   ```
   If the version is wrong, switch with `nvm use 20` or install the correct version.

4. **npm registry unreachable:**
   ```bash
   npm ping
   # If it fails, check network/proxy settings
   npm config get registry
   ```

5. **Lock file conflicts:** Delete `package-lock.json` and re-run `npm install` as a last resort.

---

## 8. Report Generation Failures (CSV / PDF)

### Symptoms

- `GET /api/reports/export/csv/:clientId` returns `500 Failed to generate CSV report`
- `GET /api/reports/export/pdf/:clientId` hangs or returns incomplete data
- Temp directory fills up with orphaned `.csv` files

### Response Steps

1. **Check temp directory permissions:**
   ```bash
   ls -la backend/temp/
   # In Docker:
   docker exec <container> ls -la /app/temp/
   ```

2. **Check disk space** (CSV/PDF writes require temp disk):
   ```bash
   df -h
   ```

3. **Manually clean orphaned temp files:**
   ```bash
   find backend/temp/ -name "*.csv" -mmin +60 -delete
   ```

4. **Test with a small dataset:**
   ```bash
   curl -H "x-user-email: test@example.com" \
     http://localhost:3001/api/reports/export/csv/1 -o test.csv
   ```
   If this works, the issue is likely related to dataset size or memory.

5. **For large reports**, consider adding streaming/pagination to the export endpoints.

---

## 9. Frontend Build / Serve Failures

### Symptoms

- `npm run build` fails in `frontend/`
- Blank page when accessing the frontend
- Vite dev server won't start
- TypeScript compilation errors

### Response Steps

1. **Check build output:**
   ```bash
   cd frontend && npm run build 2>&1
   ```

2. **TypeScript errors:**
   ```bash
   cd frontend && npx tsc --noEmit
   ```

3. **Lint errors:**
   ```bash
   cd frontend && npm run lint
   ```

4. **Vite proxy not forwarding to backend:**
   Check `frontend/vite.config.ts` — ensure the proxy target matches the backend URL (`http://localhost:3001`).

5. **Clear Vite cache:**
   ```bash
   cd frontend && rm -rf node_modules/.vite && npm run dev
   ```

---

## 10. Docker / Container Failures

### Symptoms

- `docker build` fails
- Container exits immediately after start
- Health check failures (`unhealthy` status)

### Response Steps

1. **Check container status and logs:**
   ```bash
   docker ps -a | grep timesheet
   docker logs <container>
   ```

2. **Health check debugging:**
   ```bash
   docker inspect --format='{{json .State.Health}}' <container> | jq .
   ```

3. **Build failures:**
   ```bash
   docker build -f docker/Dockerfile -t timesheet-app .
   ```
   Common issues:
   - `npm ci` fails → check `package-lock.json` consistency
   - Multi-stage copy errors → ensure paths in Dockerfile match repo structure

4. **Data volume issues:**
   ```bash
   docker volume inspect timesheet-data
   # Ensure /app/data is mounted and writable
   ```

5. **Rebuild from scratch:**
   ```bash
   docker build --no-cache -f docker/Dockerfile -t timesheet-app .
   ```

---

## 11. CI/CD Pipeline Failures

### Symptoms

- GitHub Actions PR checks fail
- Security audit (`npm audit`) blocks merge
- Test coverage drops below threshold

### Response Steps

1. **Security audit failure (CVE detection):**
   ```bash
   cd frontend && npm audit
   # Fix:
   npm audit fix
   # If fix isn't available, evaluate overrides or wait for upstream patch
   ```

2. **Test coverage failure:**
   ```bash
   cd backend && npm run test:coverage
   ```
   Check the coverage report and add tests for uncovered code.

3. **SAST scan failure:**
   Check `.github/workflows/sast-scan.yml` for the specific tool and rules. Review the PR comment posted by the workflow for details.

4. **Devin auto-fix PRs:**
   The CI pipeline may trigger automatic remediation via Devin AI. Check for auto-created PRs if a CVE or SAST issue is detected.

---

## 12. Contacts & Escalation

| Severity | Response Time | Escalation |
|---|---|---|
| **P1 — Critical** (service down, data loss) | Immediate | Page on-call engineer → Notify team lead within 15 min |
| **P2 — Major** (degraded functionality, partial outage) | < 30 min | Notify on-call engineer → Team lead within 1 hour |
| **P3 — Minor** (non-critical bug, workaround available) | < 4 hours | Create GitHub issue → Assign to team |
| **P4 — Low** (cosmetic, improvement) | Next sprint | Create GitHub issue → Backlog |

### Escalation Checklist

- [ ] Incident detected — start timer
- [ ] Initial assessment — identify severity (P1–P4)
- [ ] Create GitHub issue using the appropriate incident template
- [ ] Begin response procedure from this runbook
- [ ] Communicate status to stakeholders
- [ ] Document root cause and resolution
- [ ] Schedule post-mortem (P1/P2 only)
- [ ] Update this runbook if a new failure mode was discovered
