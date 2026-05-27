# Timesheet App Incident Response Runbook

This runbook provides step-by-step procedures for diagnosing and resolving common failure modes in the Employee Time Tracking Application.

**Architecture:** React/TypeScript frontend (Vite, port 5173) + Express/Node.js backend (port 3001) + SQLite database. Vite proxies `/api` requests to the backend in development; Docker serves both from a single container in production.

---

## Table of Contents

1. [General Triage](#1-general-triage)
2. [Backend Not Starting / Process Crash](#2-backend-not-starting--process-crash)
3. [Database Failures](#3-database-failures)
4. [API Errors (5xx on Authenticated Routes)](#4-api-errors-5xx-on-authenticated-routes)
5. [Authentication / Login Failures](#5-authentication--login-failures)
6. [Rate Limiting Blocking Legitimate Users](#6-rate-limiting-blocking-legitimate-users)
7. [Frontend Not Loading / Build Failures](#7-frontend-not-loading--build-failures)
8. [Vite Proxy / CORS Errors (Development)](#8-vite-proxy--cors-errors-development)
9. [Report Export Failures (CSV/PDF)](#9-report-export-failures-csvpdf)
10. [Memory Leaks / High Memory Usage](#10-memory-leaks--high-memory-usage)
11. [Dependency Failures (npm install)](#11-dependency-failures-npm-install)
12. [Docker Container Issues](#12-docker-container-issues)
13. [Data Loss (In-Memory Database)](#13-data-loss-in-memory-database)
14. [Contact & Escalation](#14-contact--escalation)

---

## 1. General Triage

Run these steps first for any incident before diving into a specific section.

### 1.1 Verify the Health Endpoint

```bash
curl -s http://localhost:3001/health | jq .
```

Expected response:
```json
{ "status": "OK", "timestamp": "2025-01-01T00:00:00.000Z" }
```

If this fails, the backend process is down or unreachable; proceed to [Section 2](#2-backend-not-starting--process-crash).

### 1.2 Check Process Status

```bash
# Development (nodemon)
ps aux | grep nodemon

# Production (PM2)
pm2 status

# Docker
docker ps --filter name=timesheet
```

### 1.3 Check Logs

```bash
# Development
# Logs are printed to the terminal running `npm run dev`

# PM2
pm2 logs time-tracker-api --lines 100

# Docker
docker logs <container_id> --tail 100
```

### 1.4 Check Resource Usage

```bash
# Memory and CPU
top -p $(pgrep -f "node.*server.js")

# Disk (production with file-based SQLite)
df -h /app/data
```

---

## 2. Backend Not Starting / Process Crash

**Symptoms:** Health endpoint unreachable, `ECONNREFUSED` on port 3001, process exits immediately.

### Diagnosis

1. Check for port conflicts:
   ```bash
   lsof -i :3001
   ```
2. Review startup error in logs; the server logs `Failed to start server:` before calling `process.exit(1)`.
3. Verify environment file exists:
   ```bash
   ls -la backend/.env
   ```

### Resolution

| Cause | Fix |
|-------|-----|
| Port already in use | Kill the conflicting process: `kill -9 $(lsof -ti :3001)` then restart |
| Missing `.env` file | `cp backend/.env.example backend/.env` and set `FRONTEND_URL=http://localhost:5173` |
| Missing `node_modules` | `cd backend && npm install` |
| SQLite native module error | `cd backend && npm rebuild sqlite3` |
| Node.js version mismatch | Verify `node -v` is 18+; use `nvm use 18` if needed |
| Database init failure | Check for SQLite errors in logs; see [Section 3](#3-database-failures) |

### Restart Procedure

```bash
# Development
cd backend && npm run dev

# PM2
pm2 restart time-tracker-api

# Docker
docker restart <container_id>
```

---

## 3. Database Failures

**Symptoms:** API returns `500` with `"Database error"` or `"Internal server error"`, SQLite error codes in logs (e.g., `SQLITE_BUSY`, `SQLITE_CORRUPT`, `SQLITE_CANTOPEN`).

### 3.1 In-Memory Database (Development)

The development database is in-memory (`:memory:`). It is created fresh on every server start.

| Error | Cause | Fix |
|-------|-------|-----|
| `SQLITE_ERROR: no such table` | Database not initialized | Restart the backend; `initializeDatabase()` runs automatically on start |
| Queries failing after restart | Expected: in-memory DB is ephemeral | Inform users that data loss on restart is by design |

### 3.2 File-Based Database (Production / Docker)

Production uses `DATABASE_PATH` env var (default: `/app/data/timesheet.db`).

| Error | Cause | Fix |
|-------|-------|-----|
| `SQLITE_CANTOPEN` | Database directory missing or no write permission | `mkdir -p /app/data && chown nodejs:nodejs /app/data` |
| `SQLITE_CORRUPT` | Disk failure or unclean shutdown | Restore from backup; see below |
| `SQLITE_BUSY` | Concurrent writes (rare with single process) | Restart the application |
| `SQLITE_FULL` | Disk is full | Free disk space: `df -h /app/data` |

### Recovery: Corrupt Database

```bash
# 1. Stop the application
pm2 stop time-tracker-api  # or docker stop <container>

# 2. Backup the corrupt file
cp /app/data/timesheet.db /app/data/timesheet.db.corrupt.$(date +%s)

# 3. Attempt SQLite recovery
sqlite3 /app/data/timesheet.db ".recover" | sqlite3 /app/data/timesheet_recovered.db

# 4. Verify the recovered database
sqlite3 /app/data/timesheet_recovered.db "SELECT count(*) FROM users;"

# 5. Replace and restart
mv /app/data/timesheet_recovered.db /app/data/timesheet.db
pm2 restart time-tracker-api
```

---

## 4. API Errors (5xx on Authenticated Routes)

**Symptoms:** Endpoints under `/api/clients`, `/api/work-entries`, or `/api/reports` return HTTP 500.

### Diagnosis

1. Reproduce the failing request:
   ```bash
   curl -v -H "x-user-email: test@example.com" http://localhost:3001/api/clients
   ```
2. Check backend logs for the specific error message.
3. Verify the database is accessible (see [Section 3](#3-database-failures)).

### Common Causes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `"Internal server error"` on all routes | DB connection lost | Restart the backend |
| `"Validation error"` (400) | Malformed request body | Check request payload matches Joi schema |
| `"Client not found"` (404) | Client ID doesn't exist or belongs to another user | Verify client ownership |
| Timeout on report export | Large dataset causing slow queries | Add date range filters; check query performance |

### Validate Request Payloads

Client creation:
```json
{ "name": "required string", "description": "optional", "department": "optional", "email": "optional valid email" }
```

Work entry creation:
```json
{ "clientId": 1, "hours": 8.0, "description": "optional", "date": "2025-01-01" }
```

---

## 5. Authentication / Login Failures

**Symptoms:** Login returns errors, `/api/auth/me` returns 401, users cannot access protected routes.

### Diagnosis

1. Test login:
   ```bash
   curl -X POST http://localhost:3001/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email": "test@example.com"}'
   ```
2. Test authenticated route:
   ```bash
   curl -H "x-user-email: test@example.com" http://localhost:3001/api/auth/me
   ```

### Common Causes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Login returns 400 | Invalid email format | Ensure email passes `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` |
| Login returns 429 | Rate limited (5 attempts per 15 min) | Wait for rate limit window to expire or restart backend |
| Authenticated route returns 401 | Missing `x-user-email` header | Ensure frontend sends the header; check `localStorage` for `userEmail` |
| Authenticated route returns 500 | Database error during user lookup | See [Section 3](#3-database-failures) |
| Frontend redirects to `/login` loop | 401 triggers interceptor clearing localStorage | Clear browser storage and re-login |

---

## 6. Rate Limiting Blocking Legitimate Users

**Symptoms:** Users receive HTTP 429 "Too Many Requests" responses.

### Diagnosis

```bash
# Check rate limit configuration in server.js
# Global: 100 requests per 15 minutes per IP
# Login: 5 attempts per 15 minutes per IP
```

### Resolution

- **Immediate relief:** Restart the backend to reset rate limit counters (in-memory store).
- **Adjust limits:** Modify `rateLimit` configuration in `backend/src/server.js`:
  ```javascript
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200  // increase if needed
  });
  ```
- **Production:** Use a shared rate limit store (e.g., Redis) if running behind a load balancer, since the default in-memory store is per-process.

---

## 7. Frontend Not Loading / Build Failures

**Symptoms:** Blank page at `http://localhost:5173`, build errors, TypeScript compilation failures.

### Diagnosis

1. Check if the dev server is running:
   ```bash
   lsof -i :5173
   ```
2. Check browser console for errors (F12 > Console tab).
3. Try building:
   ```bash
   cd frontend && npm run build
   ```

### Common Causes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `EADDRINUSE :5173` | Port conflict | Kill conflicting process or set a different port in `vite.config.ts` |
| TypeScript errors on build | Type mismatches after dependency update | Run `cd frontend && npx tsc --noEmit` to see errors; fix types |
| Missing modules | `node_modules` out of date | `cd frontend && rm -rf node_modules && npm install` |
| Blank page, no console errors | Backend is down, API calls fail silently | Start the backend first |
| `ERR_MODULE_NOT_FOUND` | ESM import issue | Verify `"type": "module"` in `package.json` and import paths |

### Build & Verify

```bash
cd frontend
npm install
npm run lint       # Check for lint errors
npm run build      # TypeScript + Vite build
npm run preview    # Preview production build on port 4173
```

---

## 8. Vite Proxy / CORS Errors (Development)

**Symptoms:** `Network Error` in browser, CORS errors in console, API calls return `ERR_CONNECTION_REFUSED`.

### Diagnosis

1. Verify backend is running on port 3001.
2. Check Vite proxy config in `frontend/vite.config.ts`:
   ```typescript
   server: {
     proxy: {
       '/api': {
         target: 'http://localhost:3001',
         changeOrigin: true,
       }
     }
   }
   ```
3. Check backend CORS setting in `.env`:
   ```
   FRONTEND_URL=http://localhost:5173
   ```

### Resolution

| Symptom | Fix |
|---------|-----|
| Proxy 502 errors | Start the backend: `cd backend && npm run dev` |
| CORS error in browser | Ensure `FRONTEND_URL` in backend `.env` matches the frontend origin |
| `/health` works but `/api/*` fails | Check that Vite proxy is configured; restart `npm run dev` in frontend |

---

## 9. Report Export Failures (CSV/PDF)

**Symptoms:** CSV or PDF downloads fail, return 500, or produce empty/corrupt files.

### Diagnosis

1. Test report endpoint:
   ```bash
   curl -H "x-user-email: test@example.com" \
     http://localhost:3001/api/reports/client/1
   ```
2. Test CSV export:
   ```bash
   curl -H "x-user-email: test@example.com" \
     http://localhost:3001/api/reports/export/csv/1 -o report.csv
   ```
3. Check for temp directory issues:
   ```bash
   ls -la backend/temp/
   ```

### Common Causes

| Symptom | Cause | Fix |
|---------|-------|-----|
| CSV export 500 | `temp/` directory not writable | `mkdir -p backend/temp && chmod 755 backend/temp` |
| PDF generation error | PDFKit dependency issue | `cd backend && npm rebuild` |
| Empty export file | No work entries for the client | Verify data exists with the report endpoint |
| Large export timeout | Too many records | Filter by date range or paginate |
| Temp files accumulating | Cleanup failure after download | Manually clean: `rm -f backend/temp/*.csv` |

---

## 10. Memory Leaks / High Memory Usage

**Symptoms:** Application becomes slow over time, Node.js process memory grows continuously, eventual OOM kill.

### Diagnosis

1. Monitor memory usage:
   ```bash
   # Single snapshot
   ps -o pid,rss,vsz,comm -p $(pgrep -f "node.*server.js")

   # Continuous monitoring
   watch -n 5 'ps -o pid,rss,vsz -p $(pgrep -f "node.*server.js")'
   ```
2. Check Node.js heap:
   ```bash
   node -e "console.log(process.memoryUsage())"
   ```

### Known Risk Areas

- **SQLite in-memory database:** The entire database resides in process memory. Large datasets will increase RSS proportionally.
- **Temp file accumulation:** CSV exports create files in `backend/temp/`; failed cleanup leaks disk and potentially file descriptors.
- **Unbounded query results:** Routes like `GET /api/work-entries` return all entries without pagination.
- **Morgan logging:** `combined` format logs every request to stdout; high traffic can create backpressure if stdout is piped to a slow consumer.

### Mitigation

```bash
# Set Node.js heap limit
NODE_OPTIONS="--max-old-space-size=512" npm run dev

# Restart periodically with PM2
pm2 restart time-tracker-api --cron "0 */6 * * *"

# Monitor with Docker
docker stats <container_id>
```

---

## 11. Dependency Failures (npm install)

**Symptoms:** `npm install` fails, native module compilation errors, version conflicts.

### Diagnosis

```bash
# Check Node.js version (requires 18+)
node -v
npm -v

# Verbose install
cd backend && npm install --verbose 2>&1 | tail -50
```

### Common Causes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `node-pre-gyp` error for sqlite3 | Missing build tools | Install: `apt-get install build-essential python3` (Debian/Ubuntu) |
| `ERESOLVE` peer dependency conflict | Version conflict | Try `npm install --legacy-peer-deps` |
| `EACCES` permission error | Running npm as root | Use `--unsafe-perm` or fix directory ownership |
| Lock file conflict | Stale `package-lock.json` | `rm package-lock.json && npm install` |
| Network timeout | Registry unreachable | Check network; try `npm config set registry https://registry.npmjs.org/` |

---

## 12. Docker Container Issues

**Symptoms:** Container won't start, health check failing, container restarts in a loop.

### Diagnosis

```bash
# Check container status
docker ps -a --filter name=timesheet

# View logs
docker logs <container_id> --tail 200

# Inspect health check
docker inspect --format='{{json .State.Health}}' <container_id> | jq .

# Shell into container
docker exec -it <container_id> /bin/sh
```

### Common Causes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Health check failing | App not listening on 0.0.0.0 | Docker override server.js binds to `0.0.0.0`; ensure override is applied |
| Container restart loop | Database init failure | Check `DATABASE_PATH` env var and volume mount permissions |
| "Permission denied" on `/app/data` | Volume ownership mismatch | `chown 1001:1001 /path/to/host/data` |
| Image build failure | Node.js version or npm ci failure | Check Dockerfile uses `node:20-alpine`; clear Docker cache: `docker build --no-cache` |

### Docker Restart Procedure

```bash
# Restart with preserved data
docker restart <container_id>

# Full rebuild and restart
docker compose down
docker compose build --no-cache
docker compose up -d
```

---

## 13. Data Loss (In-Memory Database)

**Symptoms:** All clients and work entries disappear after backend restart.

### Explanation

This is expected behavior. The development database uses SQLite `:memory:`, which does not persist across restarts.

### Prevention (Production)

1. Use file-based SQLite by setting `DATABASE_PATH` environment variable:
   ```bash
   DATABASE_PATH=/app/data/timesheet.db
   ```
2. The Docker image already configures this via `docker/overrides/database/init.js`.
3. Set up regular backups of the database file:
   ```bash
   # Cron job for daily backup
   0 2 * * * cp /app/data/timesheet.db /app/backups/timesheet.db.$(date +\%Y\%m\%d)
   ```

---

## 14. Contact & Escalation

| Severity | Response Time | Action |
|----------|---------------|--------|
| **P1 - Critical** | 15 minutes | Application completely down in production; data corruption. Page on-call immediately. |
| **P2 - High** | 1 hour | Major feature broken (auth, report exports); significant user impact. Notify on-call. |
| **P3 - Medium** | 4 hours | Minor feature degraded; workaround available. File a GitHub issue. |
| **P4 - Low** | Next business day | Cosmetic issues, minor bugs, performance improvements. File a GitHub issue. |

### Escalation Path

1. **First Responder:** On-call engineer triages using this runbook
2. **Escalation:** If unresolved within response time, escalate to team lead
3. **Post-Incident:** Create a post-mortem document for any P1/P2 incident
