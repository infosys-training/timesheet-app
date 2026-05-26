# Timesheet Application Runbook

## Table of Contents
- [Overview & Architecture](#overview--architecture)
- [Prerequisites](#prerequisites)
- [Health Check Procedures](#health-check-procedures)
- [Incident Response Procedures](#incident-response-procedures)
  - [P1: Application Down / Database Failure](#p1-application-down--database-failure)
  - [P1: Data Loss (In-Memory DB Restart)](#p1-data-loss-in-memory-db-restart)
  - [P1: Docker Container Crash Loop](#p1-docker-container-crash-loop)
  - [P2: Rate Limiting Blocking Legitimate Users](#p2-rate-limiting-blocking-legitimate-users)
  - [P2: Memory Growth / OOM](#p2-memory-growth--oom)
  - [P2: CORS / Auth Failures Blocking All Users](#p2-cors--auth-failures-blocking-all-users)
  - [P2: Native Module (sqlite3) Build Failure on Deploy](#p2-native-module-sqlite3-build-failure-on-deploy)
  - [P3: CSV/PDF Export Failures](#p3-csvpdf-export-failures)
  - [P3: Temp File Accumulation](#p3-temp-file-accumulation)
  - [P3: Validation Errors Spike](#p3-validation-errors-spike)
  - [P4: Slow Query Performance](#p4-slow-query-performance)
  - [P4: Log Noise / Morgan Output Issues](#p4-log-noise--morgan-output-issues)
- [Escalation Matrix](#escalation-matrix)
- [Post-Incident Review Template](#post-incident-review-template)

---

## Overview & Architecture

The Timesheet Application is a full-stack Node.js/React application for tracking employee work hours across clients.

**Key components:**

| Component | Technology | Port | Notes |
|-----------|-----------|------|-------|
| Backend API | Express.js (Node.js) | 3001 (configurable via `PORT` env var) | Serves REST API and static frontend in production |
| Frontend | React + TypeScript + Vite | 5173 (dev only) | Built and served as static files in production |
| Database (dev) | SQLite in-memory (`:memory:`) | N/A | **All data lost on restart** |
| Database (prod/Docker) | SQLite file-based | N/A | Path controlled by `DATABASE_PATH` env var (default: `/app/data/timesheet.db`) |

**Authentication:** Email-only via `x-user-email` header with DB lookup on every request (`backend/src/middleware/auth.js`).

**Key configuration:**
- `PORT` — server listen port (default `3001`) — `backend/src/server.js:16`
- `FRONTEND_URL` — CORS origin (default `http://localhost:5173`) — `backend/src/server.js:21`
- `DATABASE_PATH` — production SQLite file path (Docker only) — `docker/overrides/database/init.js:15`
- Body parsing limit: `10mb` — `backend/src/server.js:36`
- Docker runs as non-root user `nodejs:1001` — `docker/Dockerfile:38-39`

---

## Prerequisites

- **CLI tools:** `curl`, `jq`, `docker`, `docker compose`, `node` (v18+)
- **Access:** SSH or shell access to the host running the application
- **Monitoring:** Access to application logs (`docker logs` or process stdout)
- **Health check script:** `scripts/healthcheck.sh` (see [Health Check Procedures](#health-check-procedures))

---

## Health Check Procedures

### Quick Manual Check

```bash
# Basic health check
curl -s http://localhost:3001/health | jq .
# Expected: {"status":"OK","timestamp":"2026-05-26T..."}

# Check if API is responding with auth
curl -s -H "x-user-email: healthcheck@test.com" http://localhost:3001/api/clients
# Expected: 200 with JSON array

# Docker container status
docker ps --filter "name=timesheet" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
docker inspect --format='{{.State.Health.Status}}' <container_name>
```

### Automated Health Check

Run the comprehensive health check script:

```bash
./scripts/healthcheck.sh                        # Default: http://localhost:3001
./scripts/healthcheck.sh http://your-host:3001  # Custom target
```

The script tests all critical endpoints, verifies read/write paths, and checks response times. See `scripts/healthcheck.sh` for details.

---

## Incident Response Procedures

### P1: Application Down / Database Failure

**Symptoms:**
- `/health` endpoint returns non-200 or times out
- Users report "Cannot connect" or "Internal server error" on all requests
- Monitoring alerts for host/container unreachable
- Logs show `SQLITE_CANTOPEN`, `SQLITE_CORRUPT`, or `SQLITE_IOERR`

**Detection:**
```bash
# Check health endpoint
curl -sf --max-time 5 http://localhost:3001/health || echo "HEALTH CHECK FAILED"

# Check for SQLite errors in logs
docker logs <container> 2>&1 | grep -i "SQLITE_" | tail -20

# Check process status
docker ps -a --filter "name=timesheet"
# Or if running natively:
pgrep -f "node src/server.js"
```

**Impact Assessment:**
- **Complete service outage** — no users can access the application
- All API endpoints return errors or time out
- No data can be read or written

**Step-by-Step Resolution:**

1. Confirm the failure:
   ```bash
   curl -sf --max-time 5 http://localhost:3001/health
   echo "Exit code: $?"
   ```

2. Check application logs for root cause:
   ```bash
   docker logs --tail 100 <container> 2>&1
   ```

3. If the process exited (server.js calls `process.exit(1)` on startup failure — `server.js:67-68`):
   ```bash
   # Docker: check exit code
   docker inspect --format='{{.State.ExitCode}}' <container>
   # Restart
   docker restart <container>
   ```

4. If database file is corrupted (production/Docker with file-based SQLite):
   ```bash
   # Check database file integrity
   docker exec <container> ls -la /app/data/timesheet.db
   # If corrupt, restore from backup
   docker cp /path/to/backup/timesheet.db <container>:/app/data/timesheet.db
   docker restart <container>
   ```

5. If the database directory is missing or has wrong permissions:
   ```bash
   docker exec <container> ls -la /app/data/
   # Fix permissions (container runs as nodejs:1001)
   docker exec -u root <container> chown -R 1001:1001 /app/data
   ```

6. Verify recovery:
   ```bash
   curl -s http://localhost:3001/health | jq .
   ./scripts/healthcheck.sh
   ```

**Verification:**
- `/health` returns `{"status":"OK","timestamp":"..."}`
- All endpoints return expected responses
- Run `./scripts/healthcheck.sh` — all checks pass

**Prevention:**
- Set up external uptime monitoring on `/health`
- Configure Docker restart policy: `--restart=unless-stopped`
- Schedule regular SQLite database backups (production)
- Monitor disk space on the volume hosting `DATABASE_PATH`

---

### P1: Data Loss (In-Memory DB Restart)

**Symptoms:**
- Users report all their clients and work entries are gone
- API returns empty arrays for previously populated data
- Logs show "Connected to SQLite in-memory database" after a restart

**Detection:**
```bash
# Check if server recently restarted
docker logs --tail 50 <container> | grep "Connected to SQLite"

# Check uptime
docker inspect --format='{{.State.StartedAt}}' <container>

# Verify database is in-memory (dev mode)
grep ":memory:" backend/src/database/init.js
```

**Impact Assessment:**
- **Complete data loss** — all users, clients, and work entries are gone
- Affects all users simultaneously
- Data is **not recoverable** from an in-memory database

**Step-by-Step Resolution:**

1. Confirm data loss:
   ```bash
   curl -s -H "x-user-email: admin@test.com" http://localhost:3001/api/clients
   # Returns empty array []
   ```

2. Determine environment:
   - **Development (in-memory):** Data loss is expected on restart (`backend/src/database/init.js:14` uses `:memory:`). Inform users.
   - **Production (Docker):** Check if `DATABASE_PATH` is correctly set:
     ```bash
     docker exec <container> env | grep DATABASE_PATH
     docker exec <container> ls -la /app/data/timesheet.db
     ```

3. If production and file-based DB was expected but not configured:
   ```bash
   # Ensure DATABASE_PATH is set in docker-compose or docker run
   # Default: /app/data/timesheet.db (see docker/overrides/database/init.js:15)
   docker stop <container>
   # Re-run with correct env var and volume mount
   docker run -e DATABASE_PATH=/app/data/timesheet.db -v timesheet-data:/app/data ...
   ```

4. If backup exists, restore:
   ```bash
   docker cp /path/to/backup/timesheet.db <container>:/app/data/timesheet.db
   docker restart <container>
   ```

**Verification:**
- Query known data: `curl -s -H "x-user-email: known@user.com" http://localhost:3001/api/clients`
- Data persists across restart: `docker restart <container> && sleep 5 && curl ...`

**Prevention:**
- **Never use in-memory SQLite in production.** Always set `DATABASE_PATH` env var and mount a persistent volume.
- Schedule automated backups of `/app/data/timesheet.db`
- Document clearly which environment uses which database mode
- Add startup log check to alerting: if "in-memory" appears in production logs, alert immediately

---

### P1: Docker Container Crash Loop

**Symptoms:**
- `docker ps` shows container restarting repeatedly
- Health check status is `unhealthy`
- Logs show repeated startup and exit messages

**Detection:**
```bash
# Check restart count and status
docker inspect --format='{{.RestartCount}} restarts, status={{.State.Status}}, health={{.State.Health.Status}}' <container>

# Watch for crash loop
docker ps -a --filter "name=timesheet" --format "table {{.Status}}"

# Check Docker health check (interval=30s, retries=3 — Dockerfile:68-69)
docker inspect --format='{{range .State.Health.Log}}{{.ExitCode}} {{.Output}}{{end}}' <container>
```

**Impact Assessment:**
- Application is intermittently available or completely down
- Each restart in dev mode causes data loss (in-memory DB)
- Users experience connection resets

**Step-by-Step Resolution:**

1. Stop the crash loop temporarily:
   ```bash
   docker update --restart=no <container>
   docker stop <container>
   ```

2. Check logs for the root cause:
   ```bash
   docker logs --tail 200 <container> 2>&1
   ```

3. Common causes and fixes:
   - **Port conflict:** Check if port 3001 is in use: `ss -tlnp | grep 3001`
   - **Missing env vars:** Verify `.env` or environment configuration
   - **Database file permissions:** `ls -la /app/data/` inside container
   - **OOM kill:** `docker inspect --format='{{.State.OOMKilled}}' <container>` and `dmesg | grep -i oom`
   - **Native module issue:** Check for sqlite3 build errors in logs

4. Fix the root cause and restart:
   ```bash
   docker update --restart=unless-stopped <container>
   docker start <container>
   ```

5. Monitor for stability:
   ```bash
   # Watch for 5 minutes
   watch -n 10 'docker inspect --format="restarts={{.RestartCount}} status={{.State.Status}} health={{.State.Health.Status}}" <container>'
   ```

**Verification:**
- Container stays running for >5 minutes without restart
- Health check returns `healthy`
- `./scripts/healthcheck.sh` passes all checks

**Prevention:**
- Set memory limits: `docker run --memory=512m`
- Use `dumb-init` for proper signal handling (already configured in Dockerfile)
- Monitor restart count metrics
- Set up alerting on container health status transitions

---

### P2: Rate Limiting Blocking Legitimate Users

**Symptoms:**
- Users receive `429 Too Many Requests` responses
- Reports of "application is slow" or "requests are failing"
- Heavy API usage from a single user or IP

**Detection:**
```bash
# Check for 429 responses in logs
docker logs <container> 2>&1 | grep " 429 " | tail -20

# Test rate limit status
for i in $(seq 1 5); do
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/health
done

# Current limit: 100 requests per 15 minutes per IP (server.js:26-29)
```

**Impact Assessment:**
- Affected users cannot make any API calls for the remainder of the 15-minute window
- Other users on different IPs are unaffected
- Frontend shows errors on all actions (create, edit, delete, navigate)

**Step-by-Step Resolution:**

1. Identify affected IPs from logs:
   ```bash
   docker logs <container> 2>&1 | grep " 429 " | awk '{print $1}' | sort | uniq -c | sort -rn
   ```

2. Determine if traffic is legitimate or abusive:
   - Legitimate: user performing bulk operations (e.g., importing many entries)
   - Abusive: bot or scraper

3. For immediate relief (restart resets the rate limit counters):
   ```bash
   docker restart <container>
   ```

4. For a longer-term fix, adjust rate limits in `backend/src/server.js:26-29`:
   ```javascript
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 200  // Increase from 100 if legitimate traffic exceeds limit
   });
   ```

5. If the issue is a specific abusive IP, block it at the reverse proxy / firewall level.

**Verification:**
- Affected users can make API calls again
- `curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health` returns `200`
- Monitor for recurrence over the next 15-minute window

**Prevention:**
- Consider per-route rate limits (stricter on auth, relaxed on reads)
- Add rate limit headers to responses so clients can self-throttle
- Implement a whitelist for known internal IPs or service accounts
- Monitor 429 response rates in dashboards

---

### P2: Memory Growth / OOM

**Symptoms:**
- Application becomes slow over time
- Container killed by OOM killer
- Node.js `heap out of memory` errors in logs
- `docker inspect` shows `OOMKilled: true`

**Detection:**
```bash
# Check OOM kill status
docker inspect --format='{{.State.OOMKilled}}' <container>

# Check container memory usage
docker stats --no-stream <container>

# Check host-level OOM events
dmesg | grep -i "out of memory" | tail -10

# Check Node.js heap usage (if app is running)
curl -s http://localhost:3001/health  # At least confirm it responds
```

**Impact Assessment:**
- Degraded performance for all users
- If OOM-killed, equivalent to P1 (application down + potential data loss in dev mode)
- Repeated OOM kills cause crash loop

**Step-by-Step Resolution:**

1. Confirm memory issue:
   ```bash
   docker stats --no-stream <container>
   docker inspect --format='{{.State.OOMKilled}}' <container>
   ```

2. If OOM-killed, restart with higher memory limit:
   ```bash
   docker update --memory=1g <container>
   docker restart <container>
   ```

3. Check for memory leaks:
   - Large file uploads (body parsing limit is 10MB — `server.js:36`)
   - PDF generation for very large reports (PDFKit streams to response — `reports.js:187-240`)
   - Unclosed database connections
   - Temp file accumulation in `backend/temp/`

4. Profile if persistent:
   ```bash
   # Run with Node.js heap inspection
   docker exec <container> node --max-old-space-size=512 src/server.js
   ```

**Verification:**
- Memory usage stabilizes (check with `docker stats`)
- No OOM kills for 24+ hours
- Application response times are normal

**Prevention:**
- Set container memory limits: `--memory=512m --memory-swap=1g`
- Add Node.js heap size limit: `--max-old-space-size=512`
- Monitor memory usage trends
- Implement request size limits (already 10MB — consider lowering)
- Clean up temp files regularly (see [Temp File Accumulation](#p3-temp-file-accumulation))

---

### P2: CORS / Auth Failures Blocking All Users

**Symptoms:**
- Frontend shows "Network Error" or CORS-related errors in browser console
- API calls from the browser fail with no response body
- `401 Unauthorized` on all authenticated requests
- Browser dev tools show preflight (OPTIONS) request failures

**Detection:**
```bash
# Check CORS configuration
docker exec <container> env | grep FRONTEND_URL
# Default: http://localhost:5173 (server.js:21)

# Test CORS headers
curl -s -I -X OPTIONS \
  -H "Origin: http://your-frontend-url" \
  -H "Access-Control-Request-Method: GET" \
  http://localhost:3001/api/clients

# Test auth header handling
curl -s -H "x-user-email: test@test.com" http://localhost:3001/api/auth/me
```

**Impact Assessment:**
- **All users blocked** if CORS is misconfigured
- **All authenticated requests fail** if auth middleware has issues
- Frontend appears to load but all API calls fail

**Step-by-Step Resolution:**

1. Identify the failure type:
   - **CORS:** Browser console shows `Access-Control-Allow-Origin` errors
   - **Auth:** API returns `401` with `"User email required in x-user-email header"`

2. For CORS issues:
   ```bash
   # Check what FRONTEND_URL is set to
   docker exec <container> env | grep FRONTEND_URL
   
   # It must match the exact origin the frontend is served from
   # Fix: update FRONTEND_URL env var to match actual frontend URL
   docker stop <container>
   docker run -e FRONTEND_URL=https://your-actual-frontend-url ...
   ```

3. For auth middleware issues (`backend/src/middleware/auth.js`):
   - Verify the `x-user-email` header is being sent by the frontend
   - Check if the database is accessible (auth does a DB lookup every request)
   - Test directly:
     ```bash
     curl -s -H "x-user-email: test@test.com" http://localhost:3001/api/auth/me
     ```

4. If database is the root cause of auth failures, see [P1: Application Down / Database Failure](#p1-application-down--database-failure).

**Verification:**
- Frontend can successfully make API calls
- `curl -s -H "x-user-email: test@test.com" http://localhost:3001/api/clients` returns 200
- Browser dev tools show no CORS or 401 errors

**Prevention:**
- Document the required `FRONTEND_URL` value for each environment
- Add CORS origin validation to deployment checklists
- Monitor 401 error rates — a sudden spike indicates a systemic issue
- Test CORS in CI/CD pipeline after deploy

---

### P2: Native Module (sqlite3) Build Failure on Deploy

**Symptoms:**
- Deployment fails with errors like `node-pre-gyp ERR!` or `Cannot find module 'sqlite3'`
- Container build fails at `npm ci` step
- Application crashes on startup with `Error: Cannot find module './build/Release/node_sqlite3.node'`

**Detection:**
```bash
# Check build logs for sqlite3 errors
docker build . 2>&1 | grep -i "sqlite\|node-pre-gyp\|gyp ERR"

# Check if sqlite3 native module is present
docker exec <container> ls -la node_modules/sqlite3/build/Release/

# Check Node.js version matches build target
docker exec <container> node --version
```

**Impact Assessment:**
- Deployment is blocked — new version cannot be released
- Running instances are unaffected until they restart
- Rollback to previous working image is possible

**Step-by-Step Resolution:**

1. Check the Node.js version in the build environment:
   ```bash
   # Dockerfile uses node:20-alpine (Dockerfile:1, 19, 30)
   docker exec <container> node --version
   ```

2. If the issue is a missing build toolchain (Alpine needs these for native modules):
   ```bash
   # In Dockerfile, before npm ci, add:
   RUN apk add --no-cache python3 make g++
   ```

3. If pre-built binaries are not available for the platform:
   ```bash
   # Force rebuild from source
   npm ci --build-from-source
   ```

4. If the issue is a version mismatch between build and runtime:
   ```bash
   # Ensure the same Node.js version is used in build and runtime stages
   # Both should use node:20-alpine (check Dockerfile)
   ```

5. Rebuild and test:
   ```bash
   docker build -t timesheet-app -f docker/Dockerfile .
   docker run --rm timesheet-app node -e "require('sqlite3')"
   ```

**Verification:**
- Docker build completes without errors
- `node -e "require('sqlite3')"` succeeds inside the container
- Application starts and `/health` returns OK

**Prevention:**
- Pin Node.js version explicitly in Dockerfile
- Cache `node_modules` in CI to speed up rebuilds
- Test the Docker build in CI before deploying
- Consider using `better-sqlite3` (synchronous, easier to build) as an alternative

---

### P3: CSV/PDF Export Failures

**Symptoms:**
- Users click "Export CSV" or "Export PDF" and get an error or empty file
- Logs show `Error creating CSV` or `Error sending file`
- 500 errors on `/api/reports/export/csv/:clientId` or `/api/reports/export/pdf/:clientId`

**Detection:**
```bash
# Check for export errors in logs
docker logs <container> 2>&1 | grep -i "error.*csv\|error.*pdf\|error.*file\|error.*temp" | tail -20

# Test CSV export
curl -s -o /dev/null -w "%{http_code}" \
  -H "x-user-email: test@test.com" \
  http://localhost:3001/api/reports/export/csv/1

# Test PDF export
curl -s -o /dev/null -w "%{http_code}" \
  -H "x-user-email: test@test.com" \
  http://localhost:3001/api/reports/export/pdf/1

# Check temp directory (CSV uses temp files — reports.js:103-136)
docker exec <container> ls -la /app/temp/ 2>/dev/null || echo "temp dir missing"
```

**Impact Assessment:**
- Export functionality unavailable
- Core read/write operations (clients, work entries) are unaffected
- Users cannot generate reports but can still view data in the UI

**Step-by-Step Resolution:**

1. Identify which export is failing (CSV, PDF, or both):
   - CSV creates temp files in `backend/temp/` (`reports.js:106`) and cleans up after sending
   - PDF streams directly to response using PDFKit (`reports.js:187-240`)

2. For CSV failures:
   ```bash
   # Check if temp directory exists and is writable
   docker exec <container> ls -la /app/temp/ 2>/dev/null
   
   # Create it if missing
   docker exec <container> mkdir -p /app/temp
   
   # Check disk space
   docker exec <container> df -h /app/temp
   ```

3. For PDF failures:
   - Usually caused by very large reports or corrupted data
   - Check for specific PDFKit errors in logs
   - Test with a small client (few work entries)

4. For permission issues (container runs as `nodejs:1001`):
   ```bash
   docker exec -u root <container> chown -R 1001:1001 /app/temp
   ```

**Verification:**
- CSV export downloads successfully
- PDF export downloads successfully
- No errors in application logs during export

**Prevention:**
- Ensure the temp directory is created at container startup
- Add disk space monitoring
- Consider streaming CSV directly to response (like PDF) to avoid temp files
- Add export functionality to health check script

---

### P3: Temp File Accumulation

**Symptoms:**
- Disk usage growing on the application host
- `backend/temp/` directory contains many `.csv` files
- Possible disk full errors

**Detection:**
```bash
# Check temp directory size and file count
docker exec <container> du -sh /app/temp/ 2>/dev/null
docker exec <container> find /app/temp/ -type f | wc -l

# Check for old temp files (should be cleaned up after download — reports.js:132-135)
docker exec <container> find /app/temp/ -type f -mmin +60

# Check disk usage
docker exec <container> df -h /
```

**Impact Assessment:**
- Gradual disk space consumption
- If disk fills: database writes fail, export fails, potential application crash
- Not immediately user-facing unless disk is nearly full

**Step-by-Step Resolution:**

1. Clean up accumulated temp files:
   ```bash
   docker exec <container> find /app/temp/ -type f -name "*.csv" -mmin +60 -delete
   ```

2. Check why cleanup is failing. The code in `reports.js:132-135` attempts `fs.unlink` after download:
   ```bash
   # Look for cleanup errors in logs
   docker logs <container> 2>&1 | grep "Error deleting temp file" | tail -20
   ```

3. If cleanup errors are due to permissions:
   ```bash
   docker exec -u root <container> chown -R 1001:1001 /app/temp
   ```

**Verification:**
- `find /app/temp/ -type f | wc -l` shows 0 or very few files
- Disk usage is at acceptable levels
- New exports create and clean up temp files correctly

**Prevention:**
- Add a cron job or startup task to clean old temp files:
  ```bash
  find /app/temp/ -type f -mmin +60 -delete
  ```
- Monitor temp directory size
- Consider implementing streaming CSV export to avoid temp files entirely
- Add temp directory cleanup to Docker `ENTRYPOINT` script

---

### P3: Validation Errors Spike

**Symptoms:**
- Increase in 400 Bad Request responses
- Logs show Joi validation errors (`err.isJoi` — `errorHandler.js:5`)
- Users report form submission failures

**Detection:**
```bash
# Count validation errors in recent logs
docker logs --since 1h <container> 2>&1 | grep -c "Validation error"

# Look at the specific validation failures
docker logs --since 1h <container> 2>&1 | grep "Validation error" | tail -20

# Test with known good data
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "x-user-email: test@test.com" \
  -d '{"name":"Test Client"}' \
  http://localhost:3001/api/clients
```

**Impact Assessment:**
- Users cannot create or update records that fail validation
- Read operations are unaffected
- May indicate a frontend bug sending malformed data, or a schema change mismatch

**Step-by-Step Resolution:**

1. Identify the pattern — which endpoints and which fields are failing:
   ```bash
   docker logs --since 1h <container> 2>&1 | grep "Validation error" -A 2
   ```

2. Check if a recent deployment changed validation schemas (`backend/src/validation/schemas.js`):
   ```bash
   git log --oneline -10 -- backend/src/validation/schemas.js
   ```

3. If frontend is sending old data format:
   - Clear browser cache / hard refresh
   - Redeploy frontend if it's a version mismatch

4. If validation is too strict:
   - Review and adjust Joi schemas in `backend/src/validation/schemas.js`

**Verification:**
- Validation error rate returns to baseline
- Users can successfully create/update records
- Test critical paths via `./scripts/healthcheck.sh`

**Prevention:**
- Keep frontend and backend validation schemas in sync
- Add integration tests covering common data patterns
- Monitor 400 error rate trends

---

### P4: Slow Query Performance

**Symptoms:**
- API responses take >2 seconds
- Users report the app feels sluggish
- Health check script flags slow endpoints

**Detection:**
```bash
# Time a request
curl -s -o /dev/null -w "time_total: %{time_total}s\n" \
  -H "x-user-email: test@test.com" \
  http://localhost:3001/api/work-entries

# Run health check with timing
./scripts/healthcheck.sh

# Check for slow queries in logs (morgan logs include response time)
docker logs <container> 2>&1 | awk '{print $NF}' | sort -n | tail -20
```

**Impact Assessment:**
- Degraded user experience
- No data loss or functional impact
- May indicate growing dataset or missing indexes

**Step-by-Step Resolution:**

1. Identify slow endpoints by reviewing logs or running timed requests.

2. Check database size (production):
   ```bash
   docker exec <container> ls -lh /app/data/timesheet.db
   ```

3. Verify indexes exist (indexes are created in `database/init.js`):
   ```bash
   docker exec <container> node -e "
     const db = require('./src/database/init').getDatabase();
     db.all(\"SELECT name FROM sqlite_master WHERE type='index'\", (e,r) => console.log(r));
   "
   ```

4. Existing indexes:
   - `idx_clients_user_email` on `clients(user_email)`
   - `idx_work_entries_client_id` on `work_entries(client_id)`
   - `idx_work_entries_user_email` on `work_entries(user_email)`
   - `idx_work_entries_date` on `work_entries(date)`

5. If dataset is very large, consider:
   - Adding composite indexes for common query patterns
   - Implementing pagination on list endpoints
   - Archiving old work entries

**Verification:**
- Response times under 2 seconds for all endpoints
- `./scripts/healthcheck.sh` shows no timing warnings

**Prevention:**
- Monitor response times in dashboards
- Set up alerts for P95 latency thresholds
- Review query plans periodically as data grows
- Consider adding pagination if datasets grow beyond a few thousand rows

---

### P4: Log Noise / Morgan Output Issues

**Symptoms:**
- Logs are excessively verbose, making it hard to find real errors
- Health check endpoint generates log entries every 30 seconds (Docker health check interval)
- Log storage fills up quickly
- Morgan format doesn't include useful information

**Detection:**
```bash
# Check log volume
docker logs --since 1h <container> 2>&1 | wc -l

# Check for health check noise
docker logs --since 1h <container> 2>&1 | grep "GET /health" | wc -l

# Current format: 'combined' (server.js:33)
```

**Impact Assessment:**
- No user-facing impact
- Operational impact: harder to diagnose issues, higher storage costs
- May mask real errors in noisy logs

**Step-by-Step Resolution:**

1. Filter out health check requests from logs by customizing Morgan:
   ```javascript
   app.use(morgan('combined', {
     skip: (req) => req.url === '/health'
   }));
   ```

2. If logs are too verbose, switch to a less verbose format:
   ```javascript
   app.use(morgan('short'));  // or 'tiny'
   ```

3. For Docker, configure log rotation:
   ```bash
   docker run --log-opt max-size=50m --log-opt max-file=3 ...
   ```

4. Set up structured logging (e.g., JSON format) for better parsing by log aggregation tools.

**Verification:**
- Log volume is reduced to a manageable level
- Health check entries are filtered out or less frequent
- Real errors are still visible and searchable

**Prevention:**
- Configure log rotation in Docker Compose or daemon config
- Use structured logging in production
- Set up log aggregation (ELK, CloudWatch, etc.)
- Exclude health check paths from access logs

---

## Escalation Matrix

| Priority | Response Time | Escalation Path | Communication |
|----------|--------------|-----------------|---------------|
| **P1 — Critical** | Immediate (< 15 min) | On-call engineer → Team lead → Engineering manager | Notify all stakeholders immediately |
| **P2 — High** | < 1 hour | On-call engineer → Team lead | Notify team channel |
| **P3 — Medium** | < 4 hours | Assigned engineer | Update ticket |
| **P4 — Low** | Next business day | Assigned engineer | Update ticket |

**Escalation triggers:**
- P1 not resolved within 30 minutes → escalate to Team Lead
- P2 not resolved within 2 hours → escalate to Team Lead
- Any incident affecting data integrity → immediately escalate to Engineering Manager
- Security-related incident → immediately notify Security Team

**Contact channels:**
- Primary: Team Slack/Teams channel
- Secondary: PagerDuty / on-call rotation
- Fallback: Direct phone call to Team Lead

---

## Post-Incident Review Template

Use this template for all P1 and P2 incidents. P3/P4 reviews are optional but recommended for recurring issues.

```markdown
# Post-Incident Review: [Incident Title]

## Incident Summary
- **Date/Time:** [ISO timestamp]
- **Duration:** [Total time from detection to resolution]
- **Priority:** [P1/P2/P3/P4]
- **Incident Commander:** [Name]

## Timeline
| Time (UTC) | Event |
|------------|-------|
| HH:MM | Incident detected via [alert/user report/health check] |
| HH:MM | On-call engineer engaged |
| HH:MM | Root cause identified |
| HH:MM | Fix deployed |
| HH:MM | Incident resolved, monitoring confirmed |

## Root Cause
[Detailed technical explanation of why the incident occurred]

## Impact
- **Users affected:** [Number/percentage]
- **Duration of impact:** [Time]
- **Data loss:** [Yes/No — if yes, describe extent]
- **SLA impact:** [Yes/No]

## What Went Well
- [List things that worked during the response]

## What Could Be Improved
- [List areas for improvement]

## Action Items
| Action | Owner | Due Date | Status |
|--------|-------|----------|--------|
| [Preventive measure] | [Name] | [Date] | [Open/Done] |

## Lessons Learned
[Key takeaways for the team]
```

Use the GitHub issue templates (`.github/ISSUE_TEMPLATE/`) to file incident tickets during the response. Refer to the appropriate priority template (P1–P4) based on severity.
