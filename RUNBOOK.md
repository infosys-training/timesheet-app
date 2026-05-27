# Timesheet App — Incident Response Runbook

This runbook provides step-by-step procedures for diagnosing and resolving common failure modes in the timesheet application.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Failure Modes](#failure-modes)
   - [FM-1: Database Initialization Failure](#fm-1-database-initialization-failure)
   - [FM-2: In-Memory Data Loss on Restart](#fm-2-in-memory-data-loss-on-restart)
   - [FM-3: SQLite Errors During Queries](#fm-3-sqlite-errors-during-queries)
   - [FM-4: API 500 Internal Server Errors](#fm-4-api-500-internal-server-errors)
   - [FM-5: Rate Limiting Blocking Legitimate Users](#fm-5-rate-limiting-blocking-legitimate-users)
   - [FM-6: Authentication Failures](#fm-6-authentication-failures)
   - [FM-7: Report Generation Failures (CSV/PDF)](#fm-7-report-generation-failures-csvpdf)
   - [FM-8: Frontend Cannot Reach Backend](#fm-8-frontend-cannot-reach-backend)
   - [FM-9: Memory Exhaustion](#fm-9-memory-exhaustion)
   - [FM-10: Docker Health Check Failures](#fm-10-docker-health-check-failures)
   - [FM-11: Dependency / Build Failures](#fm-11-dependency--build-failures)
   - [FM-12: CORS Errors](#fm-12-cors-errors)
3. [Escalation Matrix](#escalation-matrix)
4. [Post-Incident Checklist](#post-incident-checklist)

---

## Architecture Overview

```
┌─────────────┐      Vite Proxy (/api)      ┌──────────────────┐
│  React SPA  │  ──────────────────────────► │  Express API     │
│  (port 5173)│                              │  (port 3001)     │
└─────────────┘                              │                  │
                                             │  Middleware:      │
                                             │  - helmet         │
                                             │  - cors           │
                                             │  - rate-limit     │
                                             │  - morgan         │
                                             │  - errorHandler   │
                                             │                  │
                                             │  Routes:          │
                                             │  /health          │
                                             │  /api/auth        │
                                             │  /api/clients     │
                                             │  /api/work-entries│
                                             │  /api/reports     │
                                             └────────┬─────────┘
                                                      │
                                             ┌────────▼─────────┐
                                             │  SQLite           │
                                             │  (in-memory dev / │
                                             │   file-based prod)│
                                             └──────────────────┘
```

**Key endpoints:**
| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health check |
| `/api/auth/login` | POST | Email-based login |
| `/api/auth/me` | GET | Current user info |
| `/api/clients` | GET/POST/DELETE | Client CRUD |
| `/api/clients/:id` | GET/PUT/DELETE | Single client ops |
| `/api/work-entries` | GET/POST | Work entry CRUD |
| `/api/work-entries/:id` | GET/PUT/DELETE | Single entry ops |
| `/api/reports/client/:id` | GET | Client report JSON |
| `/api/reports/export/csv/:id` | GET | CSV export |
| `/api/reports/export/pdf/:id` | GET | PDF export |

---

## Failure Modes

### FM-1: Database Initialization Failure

**Severity:** P1 — Application cannot start  
**Symptoms:**
- Server exits with `Failed to start server` in logs
- `/health` endpoint unreachable
- Error: `Error opening database`

**Diagnosis:**
```bash
# Check server logs
docker logs <container_id> 2>&1 | grep -i "database\|sqlite\|error"

# In development, check terminal output for:
# "Error opening database:" or "Failed to start server:"
```

**Resolution:**
1. **Development (in-memory):**
   - Verify `sqlite3` is installed: `cd backend && npm ls sqlite3`
   - Reinstall native bindings: `cd backend && npm rebuild sqlite3`
   - If on a different Node version than originally built: `npm rebuild`
2. **Production (file-based):**
   - Verify database directory exists and is writable:
     ```bash
     ls -la /app/data/
     # Container user (nodejs:1001) must own this directory
     docker exec <container> stat /app/data/
     ```
   - Check disk space: `df -h /app/data/`
   - If corrupt, remove and let the app recreate: `rm /app/data/timesheet.db`
3. Restart the application after fixing.

---

### FM-2: In-Memory Data Loss on Restart

**Severity:** P2 — Data loss  
**Symptoms:**
- All users, clients, and work entries disappear after restart
- Users must re-login and re-create all data

**Diagnosis:**
```bash
# Confirm which database mode is in use
grep -r ":memory:" backend/src/database/init.js
# If ":memory:" is found, data is not persisted
```

**Resolution:**
1. This is **expected behavior** in development mode (SQLite in-memory).
2. For production, ensure the Docker image uses the file-based override:
   ```bash
   # Verify the Docker build copies the overrides
   grep "overrides" docker/Dockerfile
   # Ensure DATABASE_PATH env var is set
   echo $DATABASE_PATH  # Should be /app/data/timesheet.db
   ```
3. If running outside Docker in production, switch `init.js` to use file-based storage:
   ```js
   const dbPath = process.env.DATABASE_PATH || ':memory:';
   db = new sqlite3.Database(dbPath, ...);
   ```
4. Set up regular backups of `/app/data/timesheet.db` via cron or volume snapshots.

---

### FM-3: SQLite Errors During Queries

**Severity:** P2  
**Symptoms:**
- HTTP 500 responses with `{"error": "Database error"}`
- Logs show errors prefixed with `SQLITE_`

**Diagnosis:**
```bash
# Check for common SQLite error codes in logs
docker logs <container_id> 2>&1 | grep "SQLITE_"

# Common codes:
# SQLITE_BUSY   — Database is locked (concurrent write)
# SQLITE_CORRUPT — Database file corruption
# SQLITE_FULL   — Disk full
# SQLITE_IOERR  — I/O error on disk
```

**Resolution:**
| Error Code | Action |
|---|---|
| `SQLITE_BUSY` | Reduce concurrent writes; SQLite allows only one writer at a time. Restart the app. Consider adding WAL mode: `PRAGMA journal_mode=WAL;` |
| `SQLITE_CORRUPT` | Stop the app. Restore from backup or delete the DB file to reinitialize. |
| `SQLITE_FULL` | Free disk space. Check with `df -h`. Remove old temp files in `backend/temp/`. |
| `SQLITE_IOERR` | Check filesystem health. Verify volume mounts in Docker. |

---

### FM-4: API 500 Internal Server Errors

**Severity:** P2  
**Symptoms:**
- Clients see generic error messages
- Logs show stack traces in the `errorHandler` middleware

**Diagnosis:**
```bash
# Check server logs for the error details
docker logs <container_id> 2>&1 | grep "Error:" | tail -20

# In development
# Look at terminal running `npm run dev` for Express error output

# Test a specific endpoint
curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients | jq .
```

**Resolution:**
1. Identify the failing route from the morgan access log (`combined` format).
2. Check if it's a database error (see FM-3) or a code error.
3. For validation errors (Joi), the response will be 400 with details — these are user errors, not incidents.
4. For unexpected 500s:
   - Check if the `getDatabase()` singleton returned a valid connection.
   - Verify the database tables exist: connect to the DB and run `.tables`.
   - Restart the application to reinitialize the database.

---

### FM-5: Rate Limiting Blocking Legitimate Users

**Severity:** P3  
**Symptoms:**
- Users receive HTTP 429 Too Many Requests
- Error: `Too many requests, please try again later`
- Affects all endpoints globally

**Diagnosis:**
```bash
# Current rate limit config: 100 requests per 15 minutes per IP
# Check if a reverse proxy is forwarding all traffic from a single IP
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health
# 429 = rate limited
```

**Resolution:**
1. **Immediate:** Restart the server to clear the in-memory rate limit counters.
2. **Short-term:** Increase the limit in `server.js`:
   ```js
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 500 // increase from 100
   });
   ```
3. **Long-term:** If behind a load balancer, ensure `trust proxy` is set so rate limiting uses the real client IP:
   ```js
   app.set('trust proxy', 1);
   ```
4. Exclude the `/health` endpoint from rate limiting if health checks are consuming quota.

---

### FM-6: Authentication Failures

**Severity:** P2  
**Symptoms:**
- HTTP 401: `User email required in x-user-email header`
- HTTP 400: `Invalid email format`
- Users redirected to login page unexpectedly

**Diagnosis:**
```bash
# Verify the header is being sent
curl -v http://localhost:3001/api/auth/me 2>&1 | grep -i "x-user-email"

# Test with a valid email
curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/auth/me | jq .
```

**Resolution:**
1. **Missing header:** Check that the frontend's Axios interceptor is attaching `x-user-email` from `localStorage`.
   - Verify `localStorage.getItem('userEmail')` returns a value in the browser console.
2. **Invalid email:** Ensure email matches the regex: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
3. **Unexpected 401 on frontend:**
   - The Axios response interceptor clears `localStorage` and redirects on 401.
   - If the backend restarted (in-memory mode), the user record is gone — the auth middleware will auto-create the user on the next request, so the issue is likely a missing header.

---

### FM-7: Report Generation Failures (CSV/PDF)

**Severity:** P3  
**Symptoms:**
- HTTP 500 on `/api/reports/export/csv/:id` or `/api/reports/export/pdf/:id`
- Error: `Failed to generate CSV report`
- Incomplete or corrupted downloads

**Diagnosis:**
```bash
# CSV: Check temp directory permissions
ls -la backend/temp/

# PDF: Check for pdfkit errors in logs
docker logs <container_id> 2>&1 | grep -i "pdf\|csv\|report"

# Test report endpoint directly
curl -s -H "x-user-email: test@example.com" \
  http://localhost:3001/api/reports/client/1 | jq .
```

**Resolution:**
1. **CSV generation:**
   - Ensure the `backend/temp/` directory exists and is writable.
   - In Docker, the temp directory is relative to `/app/src/routes/../../temp` → `/app/temp`.
   - Create it: `mkdir -p /app/temp && chown nodejs:nodejs /app/temp`
   - Check disk space: `df -h`
2. **PDF generation:**
   - PDFs stream directly to the response (no temp file), so disk space is not the issue.
   - Large reports with many entries may hit memory limits (see FM-9).
   - Check if the client exists and has work entries.
3. **Temp file cleanup:** The CSV handler deletes temp files after sending. If the app crashes mid-export, stale files may accumulate:
   ```bash
   find backend/temp/ -name "*.csv" -mmin +60 -delete
   ```

---

### FM-8: Frontend Cannot Reach Backend

**Severity:** P1 — Application unusable  
**Symptoms:**
- Frontend shows network errors or loading spinners indefinitely
- Browser console: `ERR_CONNECTION_REFUSED` or `504 Gateway Timeout`
- API calls to `/api/*` fail

**Diagnosis:**
```bash
# Check if backend is running
curl -s http://localhost:3001/health | jq .

# Check if the Vite dev server proxy is configured
grep -A5 "proxy" frontend/vite.config.ts

# Check if the backend port matches
grep "PORT" backend/.env
```

**Resolution:**
1. **Backend not running:**
   - Start it: `cd backend && npm run dev`
   - Check for port conflicts: `lsof -i :3001`
2. **Proxy misconfiguration (dev):**
   - Verify `vite.config.ts` proxy target is `http://localhost:3001`
   - Restart the Vite dev server after config changes
3. **Production (Docker):**
   - The backend serves the frontend static files from `/app/public`.
   - No proxy needed — both served on port 3001.
   - Verify the frontend build exists: `ls /app/public/index.html`
4. **CORS issues:** See FM-12.
5. **Axios timeout:** The frontend client has a 10-second timeout. For slow report generation, consider increasing it for report endpoints.

---

### FM-9: Memory Exhaustion

**Severity:** P1  
**Symptoms:**
- Node.js process crashes with `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed`
- Container OOM-killed
- Progressively slower response times

**Diagnosis:**
```bash
# Check Node.js memory usage
node -e "console.log(process.memoryUsage())"

# Docker memory stats
docker stats <container_id> --no-stream

# Check for OOM kills
dmesg | grep -i "oom\|killed"
```

**Resolution:**
1. **In-memory SQLite:** The database grows without bound in memory.
   - Monitor row counts: query `SELECT COUNT(*) FROM work_entries;`
   - In production, use the file-based SQLite override (see FM-2).
2. **Large PDF generation:** Reports with thousands of entries consume significant memory.
   - Consider paginating reports or setting a max entry limit.
3. **Request body limit:** Express is configured with `10mb` body limit. Reduce if not needed.
4. **Increase Node.js heap:** `node --max-old-space-size=1024 src/server.js`
5. **Docker memory limit:** Set appropriate memory limits in Docker:
   ```bash
   docker run --memory=512m --memory-swap=512m ...
   ```

---

### FM-10: Docker Health Check Failures

**Severity:** P2  
**Symptoms:**
- Docker reports container as `unhealthy`
- Container restarts in orchestrated environments (Docker Compose, ECS, K8s)

**Diagnosis:**
```bash
# Check health check status
docker inspect --format='{{json .State.Health}}' <container_id> | jq .

# Check health check logs
docker inspect --format='{{range .State.Health.Log}}{{.Output}}{{end}}' <container_id>

# Manual health check
docker exec <container_id> node -e \
  "require('http').get('http://localhost:3001/health', (r) => { \
    let d=''; r.on('data',c=>d+=c); r.on('end',()=>{console.log(r.statusCode,d); process.exit(r.statusCode===200?0:1)})})"
```

**Resolution:**
1. Check if the application started successfully (see FM-1).
2. Health check config: `interval=30s, timeout=3s, start-period=5s, retries=3`.
3. If the app takes longer to start, increase `start-period`:
   ```dockerfile
   HEALTHCHECK --start-period=15s ...
   ```
4. If `/health` is being rate-limited (see FM-5), exclude it from the rate limiter.

---

### FM-11: Dependency / Build Failures

**Severity:** P3  
**Symptoms:**
- `npm install` or `npm ci` fails
- Docker build fails at dependency installation stage
- Runtime errors about missing modules

**Diagnosis:**
```bash
# Check Node.js version
node --version  # Expected: 20.x (per Dockerfile)

# Check for lockfile issues
cd backend && npm ci 2>&1 | tail -20
cd frontend && npm ci 2>&1 | tail -20

# Check for native module issues (sqlite3)
cd backend && npm rebuild sqlite3
```

**Resolution:**
1. **Version mismatch:** Ensure Node.js 20.x is installed (matches Dockerfile).
2. **Lockfile out of sync:** Delete `node_modules` and `package-lock.json`, then `npm install`.
3. **sqlite3 native build failure:**
   - Install build tools: `apt-get install build-essential python3`
   - On Alpine (Docker): `apk add build-base python3`
4. **Network issues:** If npm registry is unreachable, check DNS and proxy settings.
5. **Frontend build failure (`tsc -b && vite build`):**
   - Check for TypeScript errors: `cd frontend && npx tsc --noEmit`
   - Review recent code changes for type errors.

---

### FM-12: CORS Errors

**Severity:** P3  
**Symptoms:**
- Browser console: `Access to XMLHttpRequest blocked by CORS policy`
- Requests work from `curl` but fail from the browser

**Diagnosis:**
```bash
# Check current CORS configuration
grep -A3 "cors" backend/src/server.js

# Check FRONTEND_URL env var
echo $FRONTEND_URL

# Test CORS headers
curl -v -H "Origin: http://localhost:5173" http://localhost:3001/health 2>&1 | grep -i "access-control"
```

**Resolution:**
1. Verify `FRONTEND_URL` environment variable matches the frontend origin:
   - Development: `http://localhost:5173`
   - Production: The actual domain
2. Update `.env`: `FRONTEND_URL=http://localhost:5173`
3. Restart the backend after changing environment variables.
4. In development, the Vite proxy bypasses CORS for `/api` routes. If you're seeing CORS errors, the request may not be going through the proxy — check the request URL in browser DevTools.

---

## Escalation Matrix

| Severity | Response Time | Notify | Examples |
|---|---|---|---|
| **P1 — Critical** | 15 min | On-call + Engineering Lead | App down, data loss in production, security breach |
| **P2 — High** | 1 hour | On-call engineer | Database errors, auth failures, partial outage |
| **P3 — Medium** | 4 hours | Engineering team | Rate limiting, report generation issues, CORS |
| **P4 — Low** | Next business day | Ticket queue | UI glitches, non-critical dependency updates |

## Post-Incident Checklist

- [ ] **Mitigate:** Apply immediate fix or workaround
- [ ] **Communicate:** Notify affected users/stakeholders
- [ ] **Document:** File a GitHub Issue using the incident template
- [ ] **Root cause:** Identify and document the root cause
- [ ] **Fix:** Implement and deploy a permanent fix
- [ ] **Verify:** Confirm the fix resolves the issue
- [ ] **Retrospective:** Schedule if P1/P2; update runbook if procedures changed
- [ ] **Monitor:** Add or improve monitoring/alerting to catch recurrence
