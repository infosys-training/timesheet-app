# Timesheet App Runbook

Operational runbook for the Timesheet application. Covers common failure modes, diagnostic steps, and resolution procedures.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Service Endpoints](#service-endpoints)
- [Failure Modes](#failure-modes)
  - [FM-1: Database Initialization Failure](#fm-1-database-initialization-failure)
  - [FM-2: Database Corruption / Data Loss (In-Memory)](#fm-2-database-corruption--data-loss-in-memory)
  - [FM-3: SQLite Lock Contention](#fm-3-sqlite-lock-contention)
  - [FM-4: Disk Full (Production File-Based SQLite)](#fm-4-disk-full-production-file-based-sqlite)
  - [FM-5: API Rate Limit Exhaustion](#fm-5-api-rate-limit-exhaustion)
  - [FM-6: Authentication Failures](#fm-6-authentication-failures)
  - [FM-7: Validation Errors Spike](#fm-7-validation-errors-spike)
  - [FM-8: PDF/CSV Report Generation Failure](#fm-8-pdfcsv-report-generation-failure)
  - [FM-9: Temp File Accumulation](#fm-9-temp-file-accumulation)
  - [FM-10: Memory Exhaustion](#fm-10-memory-exhaustion)
  - [FM-11: Node.js Process Crash](#fm-11-nodejs-process-crash)
  - [FM-12: Frontend Build / Serving Failure](#fm-12-frontend-build--serving-failure)
  - [FM-13: Docker Container Health Check Failure](#fm-13-docker-container-health-check-failure)
  - [FM-14: Dependency Vulnerability (npm audit)](#fm-14-dependency-vulnerability-npm-audit)
  - [FM-15: CORS / Proxy Misconfiguration](#fm-15-cors--proxy-misconfiguration)
- [General Diagnostics](#general-diagnostics)
- [Escalation Contacts](#escalation-contacts)

---

## Architecture Overview

```
┌────────────┐     Vite Proxy      ┌────────────┐     Singleton     ┌──────────┐
│  Frontend  │  ── /api/* ──────>  │  Backend   │  ─────────────>   │  SQLite  │
│  React SPA │  (port 5173 dev)    │  Express   │                   │  DB      │
│  Vite      │                     │  (port 3001)│                  │ (memory/ │
└────────────┘                     └────────────┘                   │  file)   │
                                                                    └──────────┘
```

- **Frontend**: React + TypeScript + Vite (port 5173 in dev, static files in production)
- **Backend**: Express.js on Node.js 20 (port 3001)
- **Database**: SQLite -- in-memory for dev/test, file-based (`/app/data/timesheet.db`) in production Docker
- **Auth**: Email-only via `x-user-email` header (no passwords/tokens)
- **Rate Limiting**: 100 requests per 15 minutes per IP
- **Containerization**: Docker with multi-stage build, `dumb-init` for signal handling

## Service Endpoints

| Endpoint | Method | Auth Required | Description |
|---|---|---|---|
| `/health` | GET | No | Health check |
| `/api/auth/login` | POST | No | Login / create user |
| `/api/auth/me` | GET | Yes | Current user info |
| `/api/clients` | GET/POST/DELETE | Yes | Client CRUD |
| `/api/clients/:id` | GET/PUT/DELETE | Yes | Single client ops |
| `/api/work-entries` | GET/POST | Yes | Work entry CRUD |
| `/api/work-entries/:id` | GET/PUT/DELETE | Yes | Single entry ops |
| `/api/reports/client/:id` | GET | Yes | Client report |
| `/api/reports/export/csv/:id` | GET | Yes | CSV export |
| `/api/reports/export/pdf/:id` | GET | Yes | PDF export |

---

## Failure Modes

### FM-1: Database Initialization Failure

**Severity**: P1 -- Complete service outage  
**Symptoms**: Server fails to start, logs show `Failed to start server` followed by `process.exit(1)`

#### Diagnosis

```bash
# Check application logs
docker logs <container_id> 2>&1 | grep -i "database\|error\|failed"

# For non-Docker deployments
journalctl -u timesheet-app | tail -50
```

#### Root Causes

1. **Corrupt SQLite file** (production only): The file at `DATABASE_PATH` is corrupt
2. **Permission denied**: Process cannot read/write the database directory
3. **Missing native module**: `sqlite3` npm package not compiled for the target platform

#### Resolution

1. **Corrupt database file**:
   ```bash
   # Back up the existing file
   cp /app/data/timesheet.db /app/data/timesheet.db.bak.$(date +%s)

   # Attempt recovery with sqlite3 CLI
   sqlite3 /app/data/timesheet.db ".recover" | sqlite3 /app/data/timesheet_recovered.db

   # If recovery succeeds, replace the original
   mv /app/data/timesheet_recovered.db /app/data/timesheet.db

   # Restart the service
   docker restart <container_id>
   ```

2. **Permission denied**:
   ```bash
   # Check ownership (should be nodejs:nodejs, UID/GID 1001)
   ls -la /app/data/

   # Fix permissions
   chown -R 1001:1001 /app/data/
   chmod 755 /app/data/
   chmod 644 /app/data/timesheet.db
   ```

3. **Native module issue**:
   ```bash
   # Rebuild sqlite3 for the current platform
   npm rebuild sqlite3
   ```

---

### FM-2: Database Corruption / Data Loss (In-Memory)

**Severity**: P2 (dev/staging), P1 (if mistakenly used in production)  
**Symptoms**: All data disappears after server restart

#### Diagnosis

```bash
# Verify which database mode is in use
grep -r "DATABASE_PATH\|:memory:" backend/src/database/init.js
echo $DATABASE_PATH
```

#### Root Cause

The development configuration uses `:memory:` SQLite. All data is lost when the Node.js process stops.

#### Resolution

1. Confirm production uses the Docker override (`docker/overrides/database/init.js`) which reads `DATABASE_PATH`
2. Ensure `DATABASE_PATH` is set in the environment:
   ```bash
   echo "DATABASE_PATH=/app/data/timesheet.db" >> .env
   ```
3. Verify Docker volume is mounted for persistence:
   ```bash
   docker inspect <container_id> | jq '.[0].Mounts'
   ```

---

### FM-3: SQLite Lock Contention

**Severity**: P2  
**Symptoms**: Intermittent `SQLITE_BUSY` errors, slow API responses, 500 errors on write operations

#### Diagnosis

```bash
# Check logs for SQLITE_ errors
docker logs <container_id> 2>&1 | grep "SQLITE_"

# Check if multiple processes are accessing the DB
fuser /app/data/timesheet.db
```

#### Resolution

1. Ensure only one Node.js process accesses the database at a time (no cluster mode)
2. Enable WAL mode for better concurrent read performance:
   ```sql
   PRAGMA journal_mode=WAL;
   ```
3. Add a busy timeout to the SQLite connection:
   ```javascript
   db.configure('busyTimeout', 5000);
   ```

---

### FM-4: Disk Full (Production File-Based SQLite)

**Severity**: P1  
**Symptoms**: Write operations fail with `SQLITE_FULL`, new entries cannot be created, CSV/PDF exports fail

#### Diagnosis

```bash
# Check disk usage
df -h /app/data/

# Check database file size
ls -lh /app/data/timesheet.db

# Check temp directory
du -sh /app/backend/temp/
```

#### Resolution

1. **Immediate**: Clear temp files generated by CSV exports:
   ```bash
   rm -f /app/backend/temp/*.csv
   ```
2. **Short-term**: Expand the Docker volume or host partition
3. **Long-term**: Implement data archival/rotation for old work entries

---

### FM-5: API Rate Limit Exhaustion

**Severity**: P3  
**Symptoms**: Users receive HTTP 429 responses, frontend shows connection errors

#### Diagnosis

```bash
# Check logs for rate-limited requests
docker logs <container_id> 2>&1 | grep "429\|rate"

# Current configuration: 100 requests per 15-minute window per IP
```

#### Root Cause

The rate limiter is configured at 100 requests per 15 minutes per IP. Heavy usage, automated scripts, or a shared NAT IP can exhaust this.

#### Resolution

1. **Immediate**: If a specific IP needs unblocking, restart the server (rate limit state is in-memory)
2. **Short-term**: Increase the limit in `server.js`:
   ```javascript
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 500  // increase from 100
   });
   ```
3. **Long-term**: Implement per-user rate limiting using the `x-user-email` header as the key

---

### FM-6: Authentication Failures

**Severity**: P2  
**Symptoms**: Users get 401 errors, cannot access any authenticated endpoints

#### Diagnosis

```bash
# Test auth directly
curl -v http://localhost:3001/api/auth/me \
  -H "x-user-email: test@example.com"

# Check if header is being passed through proxy
curl -v http://localhost:5173/api/auth/me \
  -H "x-user-email: test@example.com"
```

#### Root Causes

1. **Missing header**: Frontend not sending `x-user-email` (localStorage cleared)
2. **Invalid email format**: Regex validation rejects the email
3. **Database error**: Cannot query/create user record

#### Resolution

1. Verify the frontend stores the email in `localStorage` under key `userEmail`
2. Check browser DevTools > Application > Local Storage for the presence of `userEmail`
3. If the database is the issue, see [FM-1](#fm-1-database-initialization-failure)

---

### FM-7: Validation Errors Spike

**Severity**: P3  
**Symptoms**: Increase in 400-status responses, users unable to create/update resources

#### Diagnosis

```bash
# Check logs for validation errors
docker logs <container_id> 2>&1 | grep "Validation error"

# Test with known-good payload
curl -X POST http://localhost:3001/api/clients \
  -H "Content-Type: application/json" \
  -H "x-user-email: test@example.com" \
  -d '{"name": "Test Client"}'
```

#### Root Cause

Joi schema validation is rejecting input. Common cases:
- Client name exceeds 255 characters
- Work entry hours > 24 or <= 0
- Invalid ISO date format
- Missing required fields

#### Resolution

1. Review the Joi schemas in `backend/src/validation/schemas.js`
2. Check if a frontend update changed the payload format
3. Verify the `Content-Type: application/json` header is set

---

### FM-8: PDF/CSV Report Generation Failure

**Severity**: P2  
**Symptoms**: Report downloads fail with 500 error, partial/corrupt files downloaded

#### Diagnosis

```bash
# Check for temp directory issues
ls -la backend/temp/ 2>/dev/null || echo "temp dir missing"

# Check disk space
df -h .

# Test report endpoint
curl -v http://localhost:3001/api/reports/export/csv/1 \
  -H "x-user-email: test@example.com" \
  -o test_report.csv
```

#### Root Causes

1. **Temp directory**: CSV export writes to `backend/temp/` -- directory may not exist or be unwritable
2. **Disk space**: No room for temp files
3. **Large dataset**: Too many work entries causing memory pressure during PDF generation
4. **Client not found**: Invalid client ID or user does not own the client

#### Resolution

1. Ensure the temp directory exists and is writable:
   ```bash
   mkdir -p backend/temp
   chmod 755 backend/temp
   ```
2. For large reports, consider pagination or streaming
3. Check disk space per [FM-4](#fm-4-disk-full-production-file-based-sqlite)

---

### FM-9: Temp File Accumulation

**Severity**: P3  
**Symptoms**: Disk usage grows over time, eventually leads to FM-4

#### Diagnosis

```bash
# Count and size temp files
find backend/temp/ -name "*.csv" | wc -l
du -sh backend/temp/
```

#### Root Cause

CSV report exports create temp files that are deleted after download. If the download is interrupted or the cleanup callback fails, files accumulate.

#### Resolution

1. **Immediate**: Clean up orphaned temp files:
   ```bash
   find backend/temp/ -name "*.csv" -mmin +60 -delete
   ```
2. **Long-term**: Add a cron job or startup cleanup:
   ```bash
   # Add to crontab
   0 * * * * find /app/backend/temp/ -name "*.csv" -mmin +60 -delete
   ```

---

### FM-10: Memory Exhaustion

**Severity**: P1  
**Symptoms**: Container OOMKilled, Node.js process crashes with `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed`

#### Diagnosis

```bash
# Check container memory usage
docker stats <container_id>

# Check Node.js heap usage (if process is still running)
curl http://localhost:3001/health
# If response is slow or absent, memory is likely exhausted

# Check for OOM kills
dmesg | grep -i "oom\|killed"
```

#### Root Causes

1. **In-memory SQLite growth**: Large datasets in dev mode
2. **PDF generation**: `pdfkit` creates in-memory buffers for large reports
3. **Request body**: 10MB JSON body limit could be abused
4. **Memory leak**: Unclosed database connections or event listeners

#### Resolution

1. Set container memory limits:
   ```bash
   docker run --memory=512m --memory-swap=512m ...
   ```
2. Monitor with:
   ```bash
   docker stats --format "table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}"
   ```
3. Reduce JSON body size limit if 10MB is excessive
4. Ensure production uses file-based SQLite to reduce in-process memory

---

### FM-11: Node.js Process Crash

**Severity**: P1  
**Symptoms**: Service unreachable, container restarts, health check failures

#### Diagnosis

```bash
# Check container status
docker ps -a | grep timesheet

# Check exit code and logs
docker inspect <container_id> --format='{{.State.ExitCode}}'
docker logs --tail 100 <container_id>
```

#### Root Causes

1. **Unhandled exception**: An error that bypasses the Express error handler
2. **Signal handling**: Container not receiving SIGTERM properly (mitigated by `dumb-init`)
3. **Startup failure**: See [FM-1](#fm-1-database-initialization-failure)

#### Resolution

1. Add restart policy to Docker:
   ```bash
   docker run --restart=unless-stopped ...
   ```
2. Check logs for the crash stack trace and fix the root cause
3. Verify `dumb-init` is the entrypoint (Dockerfile uses `ENTRYPOINT ["dumb-init", "--"]`)

---

### FM-12: Frontend Build / Serving Failure

**Severity**: P2 (production), P3 (dev)  
**Symptoms**: Blank page, 404 on frontend routes, missing static assets

#### Diagnosis

```bash
# Check if static files exist (production)
ls -la /app/public/
ls -la /app/public/assets/

# Check if Vite dev server is running (development)
curl http://localhost:5173/

# Check Vite proxy to backend
curl http://localhost:5173/api/auth/me -H "x-user-email: test@example.com"
```

#### Root Causes

1. **Build failure**: `npm run build` failed in the Docker multi-stage build
2. **Missing public directory**: Static files not copied from the build stage
3. **Vite proxy down**: Dev proxy to backend not configured or backend not running

#### Resolution

1. **Production**: Rebuild the Docker image:
   ```bash
   docker build -f docker/Dockerfile -t timesheet-app .
   ```
2. **Development**: Restart both servers:
   ```bash
   cd backend && npm run dev &
   cd frontend && npm run dev &
   ```

---

### FM-13: Docker Container Health Check Failure

**Severity**: P2  
**Symptoms**: Container marked unhealthy, orchestrator may restart it

#### Diagnosis

```bash
# Check health status
docker inspect <container_id> --format='{{.State.Health.Status}}'

# View recent health check results
docker inspect <container_id> --format='{{json .State.Health}}' | jq '.Log[-3:]'
```

#### Root Cause

The Dockerfile HEALTHCHECK hits `http://localhost:3001/health` every 30 seconds. Failure to respond within 3 seconds (after 3 retries) marks the container unhealthy.

#### Resolution

1. Check if the Node.js process is running inside the container:
   ```bash
   docker exec <container_id> ps aux
   ```
2. Test health endpoint from inside the container:
   ```bash
   docker exec <container_id> node -e "require('http').get('http://localhost:3001/health', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>console.log(d)); })"
   ```
3. If the process is running but slow, check [FM-10](#fm-10-memory-exhaustion)

---

### FM-14: Dependency Vulnerability (npm audit)

**Severity**: P2-P3 (depending on severity of CVE)  
**Symptoms**: CI pipeline fails on `security-audit` job, PR blocked

#### Diagnosis

```bash
# Run audit for both frontend and backend
cd frontend && npm audit --json | jq '.metadata.vulnerabilities'
cd backend && npm audit --json | jq '.metadata.vulnerabilities'
```

#### Resolution

1. **Automatic fix**:
   ```bash
   npm audit fix
   ```
2. **Manual fix** (for breaking changes):
   ```bash
   npm audit
   # Review each vulnerability and update the specific package
   npm install <package>@<patched-version>
   ```
3. The CI pipeline (`pr-checks.yml`) has a Devin auto-fix integration for SAST/CVE failures

---

### FM-15: CORS / Proxy Misconfiguration

**Severity**: P2  
**Symptoms**: Browser console shows CORS errors, API requests blocked, `Access-Control-Allow-Origin` header missing

#### Diagnosis

```bash
# Check CORS preflight
curl -v -X OPTIONS http://localhost:3001/api/clients \
  -H "Origin: http://localhost:5173" \
  -H "Access-Control-Request-Method: GET"

# Check environment variable
echo $FRONTEND_URL
```

#### Root Causes

1. **Dev**: `FRONTEND_URL` not set to `http://localhost:5173`
2. **Production**: CORS origin not matching the actual frontend URL
3. **Vite proxy**: `vite.config.ts` proxy target not pointing to backend

#### Resolution

1. **Dev**: Set in backend `.env`:
   ```
   FRONTEND_URL=http://localhost:5173
   ```
2. **Production**: The Docker override sets `origin: true` for production, allowing same-origin requests
3. Verify `vite.config.ts` has the correct proxy target (`http://localhost:3001`)

---

## General Diagnostics

### Quick Health Check

```bash
# Run the health check script
./scripts/health-check.sh http://localhost:3001

# Or manually
curl -s http://localhost:3001/health | jq .
```

### Log Analysis

```bash
# Application logs (Docker)
docker logs --tail 200 -f <container_id>

# Filter for errors only
docker logs <container_id> 2>&1 | grep -iE "error|fail|crash|SQLITE_"

# Morgan access logs (stdout)
docker logs <container_id> 2>&1 | grep -E "^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+"
```

### Database Inspection

```bash
# Connect to SQLite (production file-based)
sqlite3 /app/data/timesheet.db

# Check table sizes
SELECT 'users' AS tbl, COUNT(*) AS cnt FROM users
UNION ALL SELECT 'clients', COUNT(*) FROM clients
UNION ALL SELECT 'work_entries', COUNT(*) FROM work_entries;

# Check database integrity
PRAGMA integrity_check;
```

### Resource Monitoring

```bash
# Container resource usage
docker stats --no-stream

# Node.js process info
docker exec <container_id> node -e "console.log(JSON.stringify(process.memoryUsage(), null, 2))"
```

---

## Escalation Contacts

| Level | Condition | Action |
|---|---|---|
| L1 | Service degraded, workaround available | Follow runbook procedures, monitor |
| L2 | Service down, runbook steps ineffective | Escalate to development team lead |
| L3 | Data loss or security incident | Escalate to engineering management and security team |

Update this table with your team's actual contacts and on-call rotation.
