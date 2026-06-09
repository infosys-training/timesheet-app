# Timesheet App — Incident Response Runbook

Operational procedures for diagnosing and resolving incidents in the Employee Time Tracking Application.

**Stack**: Express.js backend (port 3001) · React/Vite frontend (port 5173) · SQLite database · JWT auth

---

## Table of Contents

1. [First Response Checklist](#1-first-response-checklist)
2. [Database Failures](#2-database-failures)
3. [API / Backend Errors](#3-api--backend-errors)
4. [Authentication Failures](#4-authentication-failures)
5. [Memory & Resource Issues](#5-memory--resource-issues)
6. [Dependency & Build Failures](#6-dependency--build-failures)
7. [Frontend Failures](#7-frontend-failures)
8. [Infrastructure & Networking](#8-infrastructure--networking)
9. [Data Loss & Recovery](#9-data-loss--recovery)
10. [Rollback Procedures](#10-rollback-procedures)

---

## 1. First Response Checklist

Run on **every** incident before drilling into a specific section:

```bash
# 1. Verify backend is reachable
curl -s http://localhost:3001/health | jq .

# 2. Check backend process
ps aux | grep "node src/server.js"

# 3. Check recent logs (Docker)
docker logs --tail 100 timesheet-app 2>&1 | tail -50

# 4. Check disk space
df -h /app/data   # production (Docker)

# 5. Check memory
free -m

# 6. Run the automated health check script
./scripts/healthcheck.sh
```

If the health endpoint returns `{"status":"OK"}`, the backend is running and the database is initialized. Proceed to the relevant failure section.

---

## 2. Database Failures

### 2.1 SQLite Database Locked (`SQLITE_BUSY`)

**Symptoms**: HTTP 500 responses with `"Database error"` in the response body; `SQLITE_BUSY` in backend logs.

**Cause**: SQLite allows only one writer at a time. Concurrent write requests under load exceed the busy timeout.

**Steps**:
1. Check backend logs for `SQLITE_BUSY` or `SQLITE_LOCKED` errors:
   ```bash
   docker logs timesheet-app 2>&1 | grep -i "sqlite_busy\|sqlite_locked"
   ```
2. Identify if a long-running query or export is holding the write lock:
   ```bash
   docker logs timesheet-app 2>&1 | grep -i "export\|csv\|pdf" | tail -10
   ```
3. If a single long-running request is the culprit, wait for it to complete (usually < 30s).
4. If contention is chronic under load, consider adding a busy timeout:
   ```javascript
   // In database/init.js — after opening the connection
   db.configure('busyTimeout', 5000); // wait up to 5s for lock
   ```
5. For persistent high-concurrency issues, evaluate migrating to PostgreSQL.

**Escalation**: If lock persists > 5 minutes, restart the backend process (see [Rollback Procedures](#10-rollback-procedures)).

---

### 2.2 Database Initialization Failure

**Symptoms**: Backend fails to start; logs show `Failed to start server` and/or `Error opening database`.

**Steps**:
1. Check startup logs:
   ```bash
   docker logs timesheet-app 2>&1 | head -30
   ```
2. **In-memory mode** (development): The database is created fresh every startup. If initialization fails, it's likely a code defect in `backend/src/database/init.js`. Check for syntax errors in the `CREATE TABLE` statements.
3. **File-based mode** (Docker production):
   ```bash
   # Check the database file exists and is writable
   docker exec timesheet-app ls -la /app/data/timesheet.db

   # Check disk space on the data volume
   docker exec timesheet-app df -h /app/data
   ```
4. If the database file is corrupted:
   ```bash
   # Back up the corrupted file
   docker exec timesheet-app cp /app/data/timesheet.db /app/data/timesheet.db.bak

   # Remove and restart (WARNING: data loss)
   docker exec timesheet-app rm /app/data/timesheet.db
   docker restart timesheet-app
   ```
5. Verify recovery:
   ```bash
   curl -s http://localhost:3001/health | jq .
   ```

**Escalation**: P1 if production data was lost. See [Data Loss & Recovery](#9-data-loss--recovery).

---

### 2.3 Data Loss on Restart (In-Memory Mode)

**Symptoms**: All clients, work entries, and user data disappear after backend restart.

**Cause**: The default configuration uses SQLite `:memory:` which does not persist across restarts.

**Steps**:
1. Confirm current mode:
   ```bash
   grep -r ":memory:" backend/src/database/init.js
   ```
2. If running in development, this is **expected behavior**. Notify affected users.
3. For production, ensure the Docker deployment uses the file-based override:
   ```bash
   # The Dockerfile copies docker/overrides/database/init.js
   # which uses DATABASE_PATH env var for file-based SQLite
   docker exec timesheet-app printenv DATABASE_PATH
   ```
4. If `DATABASE_PATH` is not set, redeploy with the correct environment variable:
   ```bash
   docker run -e DATABASE_PATH=/app/data/timesheet.db -v timesheet-data:/app/data ...
   ```

---

## 3. API / Backend Errors

### 3.1 Rate Limiting (HTTP 429)

**Symptoms**: Users receive `429 Too Many Requests`. Typically hits power users or automated integrations.

**Cause**: Express rate limiter is set to 100 requests per 15-minute window per IP.

**Steps**:
1. Confirm rate limiting is the cause:
   ```bash
   docker logs timesheet-app 2>&1 | grep "429\|rate" | tail -10
   ```
2. Identify the affected IP:
   ```bash
   docker logs timesheet-app 2>&1 | grep "429" | awk '{print $1}' | sort | uniq -c | sort -rn
   ```
3. **Immediate relief**: Restart the backend to clear in-memory rate limit counters:
   ```bash
   docker restart timesheet-app
   ```
4. **Permanent fix**: Adjust the rate limit in `backend/src/server.js`:
   ```javascript
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 500  // increase from 100
   });
   ```
5. If a single IP is abusing the API, investigate whether it's a legitimate user or an attack.

---

### 3.2 Validation Errors (HTTP 400)

**Symptoms**: Clients receive `400` with `"Validation error"` and a `details` array.

**Cause**: Request body does not match Joi validation schema.

**Steps**:
1. These are **expected errors** for malformed input. No action needed unless the error rate spikes abnormally.
2. Check if a frontend deployment introduced a schema mismatch:
   ```bash
   # Compare frontend API call payload vs backend Joi schema
   cat backend/src/validation/schemas.js
   ```
3. If a new field was added to the backend schema but the frontend hasn't been updated (or vice versa), coordinate a deployment.

---

### 3.3 Unhandled Exceptions / 500 Errors

**Symptoms**: HTTP 500 responses with generic `"Internal server error"` message.

**Steps**:
1. Check backend logs for the stack trace:
   ```bash
   docker logs timesheet-app 2>&1 | grep -A 20 "Error:" | tail -40
   ```
2. Identify if the error is in a specific route:
   ```bash
   docker logs timesheet-app 2>&1 | grep "500" | awk '{print $7}' | sort | uniq -c | sort -rn
   ```
3. Common causes:
   - **SQLite errors**: See [Database Failures](#2-database-failures)
   - **PDF generation OOM**: See [Memory Issues](#5-memory--resource-issues)
   - **Missing temp directory for CSV export**: Ensure `/app/temp` or `backend/temp` exists
4. If the error is in CSV/PDF export:
   ```bash
   # Ensure temp directory exists
   docker exec timesheet-app mkdir -p /app/temp
   # Check for orphaned temp files
   docker exec timesheet-app ls -la /app/temp/
   ```

---

## 4. Authentication Failures

### 4.1 JWT Token Issues

**Symptoms**: Users get `401 Unauthorized` despite being logged in. Frontend redirects to login page.

**Steps**:
1. Check if `JWT_SECRET` environment variable is set:
   ```bash
   docker exec timesheet-app printenv JWT_SECRET | wc -c
   # Should be > 32 characters
   ```
2. If `JWT_SECRET` changed between deployments, all existing tokens are invalidated. Users must log in again. This is expected.
3. If the secret is the default placeholder (`your-super-secret-jwt-key...`), rotate it immediately:
   ```bash
   # Generate a new secret
   openssl rand -hex 32
   # Redeploy with the new JWT_SECRET
   ```

### 4.2 Email Validation Rejections

**Symptoms**: Users cannot log in; receive `400 Invalid email format` or Joi validation error.

**Steps**:
1. Confirm the email format being sent:
   ```bash
   docker logs timesheet-app 2>&1 | grep "POST /api/auth/login" | tail -10
   ```
2. The backend validates email with regex `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`. Unusual TLDs or special characters may be rejected.
3. If a legitimate email format is being rejected, update the validation schema in `backend/src/validation/schemas.js`.

---

## 5. Memory & Resource Issues

### 5.1 High Memory Usage / OOM

**Symptoms**: Container killed by OOM; backend becomes unresponsive; `docker inspect` shows OOMKilled=true.

**Steps**:
1. Check container memory:
   ```bash
   docker stats timesheet-app --no-stream
   ```
2. Common causes:
   - **Large PDF generation**: Generating reports with thousands of work entries loads all data into memory.
   - **Temp file accumulation**: Failed CSV/PDF exports may leave orphaned files in `/app/temp`.
3. Clean up temp files:
   ```bash
   docker exec timesheet-app find /app/temp -type f -mmin +60 -delete
   ```
4. If OOM is chronic, increase container memory limit or paginate large report exports.

### 5.2 Temp File Accumulation

**Symptoms**: Disk space fills up; new CSV exports fail.

**Cause**: The CSV export creates temp files in `backend/temp/` and deletes them after download. If the download fails or the client disconnects, the file may not be cleaned up.

**Steps**:
1. Check temp directory size:
   ```bash
   du -sh backend/temp/ 2>/dev/null || echo "no temp dir"
   docker exec timesheet-app du -sh /app/temp 2>/dev/null
   ```
2. Clean files older than 1 hour:
   ```bash
   find backend/temp/ -type f -mmin +60 -delete 2>/dev/null
   docker exec timesheet-app find /app/temp -type f -mmin +60 -delete 2>/dev/null
   ```
3. Set up a cron job or scheduled task to clean temp files periodically.

---

## 6. Dependency & Build Failures

### 6.1 SQLite3 Native Module Build Failure

**Symptoms**: `npm install` fails with errors about `node-gyp`, `python`, or `sqlite3` compilation.

**Steps**:
1. Ensure build tools are installed:
   ```bash
   # Alpine (Docker)
   apk add --no-cache python3 make g++

   # Ubuntu/Debian
   sudo apt-get install -y python3 make g++ build-essential
   ```
2. If using a different Node.js version than the one the module was built for:
   ```bash
   npm rebuild sqlite3
   ```
3. As a last resort, remove and reinstall:
   ```bash
   rm -rf node_modules/sqlite3
   npm install sqlite3
   ```

### 6.2 Frontend Build Failure (TypeScript)

**Symptoms**: `npm run build` fails with TypeScript errors; Vite build exits non-zero.

**Steps**:
1. Run the TypeScript compiler to see errors:
   ```bash
   cd frontend && npx tsc --noEmit
   ```
2. Run lint to catch additional issues:
   ```bash
   cd frontend && npm run lint
   ```
3. If errors are in type definitions from `node_modules`, try clearing the cache:
   ```bash
   rm -rf frontend/node_modules/.vite
   cd frontend && npm install
   ```

### 6.3 npm Dependency Resolution Failures

**Symptoms**: `npm install` fails with peer dependency conflicts or network errors.

**Steps**:
1. Clear npm cache:
   ```bash
   npm cache clean --force
   ```
2. Remove lockfile and node_modules, then reinstall:
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```
3. If behind a corporate proxy, ensure `npm config` has the correct proxy settings.

---

## 7. Frontend Failures

### 7.1 Vite Proxy Failures (API Unreachable)

**Symptoms**: Frontend shows network errors; API calls fail with `ERR_CONNECTION_REFUSED` in browser console.

**Cause**: The Vite dev server proxies `/api` requests to `http://localhost:3001`. If the backend is down or on a different port, requests fail.

**Steps**:
1. Confirm backend is running:
   ```bash
   curl -s http://localhost:3001/health
   ```
2. Check Vite proxy config in `frontend/vite.config.ts` matches the backend port.
3. If running in Docker/production (frontend served by backend), the proxy is not used. Check that the built frontend files exist:
   ```bash
   docker exec timesheet-app ls /app/public/index.html
   ```

### 7.2 CORS Errors

**Symptoms**: Browser console shows `Access-Control-Allow-Origin` errors.

**Cause**: `FRONTEND_URL` environment variable doesn't match the actual frontend origin.

**Steps**:
1. Check the current CORS configuration:
   ```bash
   docker exec timesheet-app printenv FRONTEND_URL
   ```
2. Ensure it matches the URL where the frontend is served (e.g., `http://localhost:5173` for dev, or the production domain).
3. Update and restart:
   ```bash
   docker restart timesheet-app
   ```

---

## 8. Infrastructure & Networking

### 8.1 Port Conflicts

**Symptoms**: Backend fails to start with `EADDRINUSE`.

**Steps**:
1. Find what's using the port:
   ```bash
   lsof -i :3001
   # or
   ss -tlnp | grep 3001
   ```
2. Kill the conflicting process or change the `PORT` environment variable.

### 8.2 Docker Container Won't Start

**Symptoms**: `docker compose up` fails or container exits immediately.

**Steps**:
1. Check container logs:
   ```bash
   docker logs timesheet-app 2>&1
   ```
2. Verify the image was built successfully:
   ```bash
   docker images | grep timesheet
   ```
3. Check volume mounts:
   ```bash
   docker inspect timesheet-app | jq '.[0].Mounts'
   ```
4. Rebuild the image if necessary:
   ```bash
   docker build -t timesheet-app -f docker/Dockerfile .
   ```

---

## 9. Data Loss & Recovery

### 9.1 In-Memory Database (Development)

**Recovery**: Not possible. In-memory data is lost on restart by design. Re-create data manually or through the API.

### 9.2 File-Based SQLite (Production Docker)

**Steps**:
1. Check if a backup exists:
   ```bash
   ls -la /app/data/timesheet.db.bak 2>/dev/null
   docker exec timesheet-app ls -la /app/data/
   ```
2. If a backup exists, restore it:
   ```bash
   docker exec timesheet-app cp /app/data/timesheet.db.bak /app/data/timesheet.db
   docker restart timesheet-app
   ```
3. Verify data integrity:
   ```bash
   docker exec timesheet-app sqlite3 /app/data/timesheet.db "PRAGMA integrity_check;"
   ```

### 9.3 Preventive Measures

Set up automated backups:
```bash
# Cron job example — daily backup at 2 AM
0 2 * * * docker exec timesheet-app sqlite3 /app/data/timesheet.db ".backup /app/data/timesheet-$(date +\%Y\%m\%d).db"
```

---

## 10. Rollback Procedures

### Application Rollback

```bash
# 1. Identify the last known good image/commit
docker images | grep timesheet | head -5
git log --oneline -10

# 2. Roll back to previous image
docker stop timesheet-app
docker run -d --name timesheet-app -p 3001:3001 \
  -v timesheet-data:/app/data \
  -e JWT_SECRET=$JWT_SECRET \
  -e DATABASE_PATH=/app/data/timesheet.db \
  timesheet-app:<previous-tag>

# 3. Verify
curl -s http://localhost:3001/health | jq .
```

### Emergency Restart

```bash
# Quick restart (preserves data volume in Docker)
docker restart timesheet-app

# Full recreation
docker compose down
docker compose up -d
```

---

## Contact & Escalation

| Severity | Response Time | Escalation Path |
|----------|---------------|-----------------|
| P1 — Service Down | 15 minutes | On-call engineer → Team Lead → Engineering Manager |
| P2 — Major Degradation | 1 hour | On-call engineer → Team Lead |
| P3 — Minor Issue | 4 hours | Assigned engineer |
| P4 — Cosmetic/Low Impact | Next business day | Backlog triage |
