# Timesheet App - Incident Response Runbook

## Table of Contents

- [System Overview](#system-overview)
- [Critical Contacts](#critical-contacts)
- [Failure Modes](#failure-modes)
  - [FM-1: Database Unavailable](#fm-1-database-unavailable)
  - [FM-2: Database Corruption](#fm-2-database-corruption)
  - [FM-3: API 5xx Errors](#fm-3-api-5xx-errors)
  - [FM-4: Rate Limiting Triggered (429)](#fm-4-rate-limiting-triggered-429)
  - [FM-5: Authentication Failures](#fm-5-authentication-failures)
  - [FM-6: Memory Leak / OOM](#fm-6-memory-leak--oom)
  - [FM-7: Disk Space Exhaustion](#fm-7-disk-space-exhaustion)
  - [FM-8: Node.js Process Crash](#fm-8-nodejs-process-crash)
  - [FM-9: Docker Container Health Check Failure](#fm-9-docker-container-health-check-failure)
  - [FM-10: Frontend Unreachable](#fm-10-frontend-unreachable)
  - [FM-11: Report Generation Failure (PDF/CSV)](#fm-11-report-generation-failure-pdfcsv)
  - [FM-12: Dependency / npm Module Failure](#fm-12-dependency--npm-module-failure)
- [Escalation Matrix](#escalation-matrix)
- [Post-Incident Review](#post-incident-review)

---

## System Overview

| Component | Technology | Port | Description |
|-----------|-----------|------|-------------|
| Backend API | Node.js / Express | 3001 | REST API with SQLite database |
| Frontend | React / Vite | 5173 (dev) | Single-page application |
| Database | SQLite | N/A | File-based (prod) or in-memory (dev) |
| Container | Docker (node:20-alpine) | 3001 | Production deployment |

### Architecture

```
[Browser] → [Vite Proxy / Nginx] → [Express API :3001] → [SQLite DB]
                                         ↓
                                  /health endpoint
```

### Key Endpoints

| Endpoint | Method | Auth Required | Description |
|----------|--------|---------------|-------------|
| `/health` | GET | No | Health check |
| `/api/auth/login` | POST | No | User login |
| `/api/auth/me` | GET | Yes | Current user info |
| `/api/clients` | GET/POST/PUT/DELETE | Yes | Client CRUD |
| `/api/work-entries` | GET/POST/PUT/DELETE | Yes | Work entry CRUD |
| `/api/reports/client/:id` | GET | Yes | Client report |
| `/api/reports/export/csv/:id` | GET | Yes | CSV export |
| `/api/reports/export/pdf/:id` | GET | Yes | PDF export |

---

## Critical Contacts

| Role | Contact | Escalation Level |
|------|---------|------------------|
| On-Call Engineer | _[Fill in]_ | P1/P2 |
| Team Lead | _[Fill in]_ | P2/P3 |
| DevOps Lead | _[Fill in]_ | P1 (infrastructure) |
| Product Owner | _[Fill in]_ | P1 (communications) |

---

## Failure Modes

### FM-1: Database Unavailable

**Severity:** P1
**Symptoms:**
- All API requests returning 500 errors
- Logs show `Error opening database` or `SQLITE_CANTOPEN`
- Health check passes but authenticated endpoints fail

**Diagnosis:**

```bash
# Check if the database file exists (production)
ls -la /app/data/timesheet.db

# Check file permissions
stat /app/data/timesheet.db

# Check disk space
df -h /app/data

# Check SQLite file integrity
sqlite3 /app/data/timesheet.db "PRAGMA integrity_check;"

# Check container logs
docker logs <container_id> --tail 100
```

**Resolution:**

1. **Verify database file exists:**
   ```bash
   ls -la $DATABASE_PATH
   ```
   If missing, check if the volume mount is correct in docker-compose.

2. **Verify permissions:**
   ```bash
   # The nodejs user (UID 1001) must own the data directory
   chown -R 1001:1001 /app/data
   chmod 755 /app/data
   ```

3. **If database is locked:**
   ```bash
   # Check for stale lock files
   ls -la /app/data/timesheet.db-wal /app/data/timesheet.db-shm
   # Remove WAL files if process has crashed
   rm -f /app/data/timesheet.db-wal /app/data/timesheet.db-shm
   ```

4. **Restart the container:**
   ```bash
   docker restart <container_id>
   ```

5. **If using in-memory database (dev):** Restart the server process; data loss is expected.

**Prevention:**
- Monitor disk space on the data volume
- Set up alerts for database file permission changes
- Use file-based SQLite in production with proper volume mounts

---

### FM-2: Database Corruption

**Severity:** P1
**Symptoms:**
- `SQLITE_CORRUPT` errors in logs
- Queries returning unexpected results
- Application partially functional (some tables work, others don't)

**Diagnosis:**

```bash
# Run integrity check
sqlite3 /app/data/timesheet.db "PRAGMA integrity_check;"

# Check page count and free list
sqlite3 /app/data/timesheet.db "PRAGMA page_count; PRAGMA freelist_count;"
```

**Resolution:**

1. **Stop the application** to prevent further corruption:
   ```bash
   docker stop <container_id>
   ```

2. **Attempt repair:**
   ```bash
   sqlite3 /app/data/timesheet.db ".recover" | sqlite3 /app/data/timesheet_recovered.db
   ```

3. **Restore from backup** (if recovery fails):
   ```bash
   cp /app/data/backups/timesheet_latest.db /app/data/timesheet.db
   ```

4. **Restart the application:**
   ```bash
   docker start <container_id>
   ```

5. **Verify recovery:**
   ```bash
   curl http://localhost:3001/health
   curl -H "x-user-email: test@example.com" http://localhost:3001/api/clients
   ```

**Prevention:**
- Schedule regular database backups (e.g., hourly `cp` of the .db file)
- Use WAL mode for better crash resilience
- Never kill the container with SIGKILL during write operations

---

### FM-3: API 5xx Errors

**Severity:** P2
**Symptoms:**
- Users receiving "Internal server error" responses
- Error rate spike in monitoring
- Logs showing unhandled exceptions

**Diagnosis:**

```bash
# Check application logs for stack traces
docker logs <container_id> --tail 200 | grep -A 5 "Error"

# Check if the process is running
docker exec <container_id> ps aux

# Test health endpoint
curl -w "\n%{http_code}" http://localhost:3001/health

# Test with authentication
curl -H "x-user-email: test@example.com" http://localhost:3001/api/clients
```

**Resolution:**

1. **Identify the failing route** from access logs (morgan output):
   ```bash
   docker logs <container_id> | grep " 500 "
   ```

2. **Check for database connectivity:**
   ```bash
   curl http://localhost:3001/health
   ```

3. **If isolated to specific routes**, check for:
   - Invalid query parameters causing SQL errors
   - Missing database tables (schema migration issue)
   - File system errors (temp directory for CSV/PDF exports)

4. **If widespread**, restart the application:
   ```bash
   docker restart <container_id>
   ```

5. **If persists after restart**, check for:
   - Corrupted node_modules
   - Environment variable misconfiguration
   - Database schema mismatch

**Prevention:**
- Implement structured logging with request IDs
- Set up error rate alerts (>1% of requests returning 5xx)
- Add circuit breakers for database operations

---

### FM-4: Rate Limiting Triggered (429)

**Severity:** P3
**Symptoms:**
- Users receiving 429 "Too Many Requests" responses
- Legitimate users locked out during peak hours
- Rate limit: 100 requests per 15 minutes per IP

**Diagnosis:**

```bash
# Check how many unique IPs are hitting the rate limit
docker logs <container_id> | grep "429" | awk '{print $1}' | sort -u

# Check current rate limit configuration
grep -r "rateLimit" /app/src/server.js
```

**Resolution:**

1. **If legitimate traffic spike:**
   - Temporarily increase rate limits by updating the `max` value in server.js
   - Restart the container to apply changes

2. **If abuse/attack:**
   - Identify the offending IPs from logs
   - Block IPs at the load balancer/firewall level
   - Consider adding IP-based blocklists

3. **Adjust rate limit configuration** (if needed):
   ```javascript
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 200  // Increase from 100
   });
   ```

**Prevention:**
- Monitor rate limit hit counts
- Implement per-user rate limiting (not just IP-based)
- Add rate limit headers to help clients back off gracefully

---

### FM-5: Authentication Failures

**Severity:** P2
**Symptoms:**
- Users receiving 401 "User email required" errors
- Login endpoint returning 500 errors
- `x-user-email` header not being forwarded by proxy

**Diagnosis:**

```bash
# Test login directly
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com"}'

# Test authenticated endpoint
curl -H "x-user-email: test@example.com" http://localhost:3001/api/auth/me

# Check if the proxy is forwarding headers
curl -v -H "x-user-email: test@example.com" http://localhost:3001/api/clients 2>&1 | grep "x-user-email"
```

**Resolution:**

1. **If login fails with 500:**
   - Database is likely unavailable → see [FM-1](#fm-1-database-unavailable)

2. **If 401 errors on authenticated routes:**
   - Verify the frontend is sending the `x-user-email` header
   - Check browser localStorage for the stored email
   - Check if the Vite proxy or reverse proxy is stripping custom headers

3. **If email validation fails (400):**
   - Ensure emails match format: `^[^\s@]+@[^\s@]+\.[^\s@]+$`
   - Check for leading/trailing whitespace in the email input

**Prevention:**
- Add monitoring for 401 response rates
- Ensure proxy configurations preserve custom headers
- Add client-side email validation before API calls

---

### FM-6: Memory Leak / OOM

**Severity:** P1
**Symptoms:**
- Container being OOM-killed
- Increasing memory usage over time
- Slow response times before crash
- Docker events showing `OOMKilled`

**Diagnosis:**

```bash
# Check container memory usage
docker stats <container_id> --no-stream

# Check for OOM kills
docker inspect <container_id> | grep -i oom

# Check Node.js heap usage (if accessible)
docker exec <container_id> node -e "console.log(process.memoryUsage())"

# Check for temp file accumulation
docker exec <container_id> ls -la /app/temp/ 2>/dev/null
```

**Resolution:**

1. **Immediate mitigation** — restart the container:
   ```bash
   docker restart <container_id>
   ```

2. **Check for temp file accumulation:**
   ```bash
   # CSV/PDF report generation creates temp files
   docker exec <container_id> rm -rf /app/temp/*
   ```

3. **Set memory limits** on the container:
   ```bash
   docker update --memory=512m --memory-swap=512m <container_id>
   ```

4. **Enable Node.js heap limit:**
   ```bash
   # In Dockerfile CMD or docker-compose
   node --max-old-space-size=384 src/server.js
   ```

5. **Profile memory usage** for root cause:
   ```bash
   docker exec <container_id> node --inspect=0.0.0.0:9229 src/server.js
   # Connect Chrome DevTools to capture heap snapshot
   ```

**Common Causes:**
- Large PDF/CSV report generation without streaming
- Unclosed database connections
- Event listener accumulation
- Large request bodies (currently limited to 10MB)

**Prevention:**
- Set container memory limits
- Implement streaming for large report exports
- Add memory usage monitoring alerts at 80% threshold
- Clean up temp files after report generation (already implemented but verify)

---

### FM-7: Disk Space Exhaustion

**Severity:** P2
**Symptoms:**
- Database writes failing with `SQLITE_FULL`
- CSV/PDF exports failing
- Container logs filling up disk

**Diagnosis:**

```bash
# Check disk usage
df -h

# Check data directory size
du -sh /app/data/

# Check temp directory
du -sh /app/temp/ 2>/dev/null

# Check Docker logs size
docker inspect <container_id> --format='{{.LogPath}}' | xargs ls -lh
```

**Resolution:**

1. **Clean temp files:**
   ```bash
   docker exec <container_id> find /app/temp -mtime +1 -delete
   ```

2. **Rotate Docker logs:**
   ```bash
   truncate -s 0 $(docker inspect <container_id> --format='{{.LogPath}}')
   ```

3. **If database too large**, consider:
   - Running `VACUUM` to reclaim space
   - Archiving old work entries
   ```bash
   sqlite3 /app/data/timesheet.db "VACUUM;"
   ```

4. **Add Docker log rotation** in daemon.json:
   ```json
   {
     "log-driver": "json-file",
     "log-opts": { "max-size": "10m", "max-file": "3" }
   }
   ```

**Prevention:**
- Configure Docker log rotation
- Set up disk space alerts at 80% and 90%
- Implement data retention policies
- Schedule periodic VACUUM on SQLite database

---

### FM-8: Node.js Process Crash

**Severity:** P1
**Symptoms:**
- Container exits with non-zero code
- Application suddenly unreachable
- Health check failures triggering container restart

**Diagnosis:**

```bash
# Check container exit code
docker inspect <container_id> --format='{{.State.ExitCode}}'

# Check last logs before crash
docker logs <container_id> --tail 50

# Check for core dumps (if enabled)
ls /tmp/core.*

# Check system dmesg for OOM or segfault
dmesg | tail -20
```

**Resolution:**

1. **Check the error message** in logs:
   - `SIGTERM` / exit code 143: Graceful shutdown (normal)
   - `SIGKILL` / exit code 137: OOM killed → see [FM-6](#fm-6-memory-leak--oom)
   - `SIGSEGV` / exit code 139: Segfault in native module (sqlite3)
   - Exit code 1: Unhandled exception in startup

2. **For native module crashes (sqlite3):**
   ```bash
   # Rebuild native dependencies
   docker exec <container_id> npm rebuild sqlite3
   ```

3. **For startup failures:**
   ```bash
   # Verify environment variables
   docker exec <container_id> env | grep -E "PORT|DATABASE_PATH|NODE_ENV"
   
   # Try starting manually
   docker exec -it <container_id> node src/server.js
   ```

4. **Restart with dumb-init** (ensures proper signal handling):
   ```bash
   docker restart <container_id>
   ```

**Prevention:**
- Use `dumb-init` as PID 1 (already configured)
- Add global unhandled exception/rejection handlers
- Set restart policies: `docker run --restart=unless-stopped`
- Monitor container restart counts

---

### FM-9: Docker Container Health Check Failure

**Severity:** P2
**Symptoms:**
- Container in "unhealthy" state
- Docker orchestrator restarting container repeatedly
- Health check interval: 30s, timeout: 3s, retries: 3

**Diagnosis:**

```bash
# Check health status
docker inspect <container_id> --format='{{.State.Health.Status}}'

# Check last health check results
docker inspect <container_id> --format='{{json .State.Health}}' | jq .

# Manually test health endpoint
curl -w "\nHTTP %{http_code} in %{time_total}s\n" http://localhost:3001/health
```

**Resolution:**

1. **If health endpoint responds but slowly (>3s):**
   - Server is overloaded → check CPU and memory
   - Event loop is blocked → check for synchronous operations
   - Increase health check timeout in Dockerfile

2. **If health endpoint returns non-200:**
   - Check application logs for startup errors
   - Verify database initialization completed

3. **If container keeps restarting:**
   ```bash
   # Temporarily disable health check for debugging
   docker run --no-healthcheck <image>
   
   # Or increase retries
   docker run --health-retries=5 <image>
   ```

**Prevention:**
- Ensure health check is lightweight (no DB queries)
- Set appropriate start-period for slow startups (currently 5s)
- Monitor health check failure patterns

---

### FM-10: Frontend Unreachable

**Severity:** P2
**Symptoms:**
- Users see blank page or connection refused
- API works but UI doesn't load
- Static assets returning 404

**Diagnosis:**

```bash
# In production (served by backend)
curl -I http://localhost:3001/
curl -I http://localhost:3001/index.html

# In development
curl -I http://localhost:5173/

# Check if static files exist in container
docker exec <container_id> ls -la /app/public/
```

**Resolution:**

1. **Production (Docker):**
   - Verify frontend was built during Docker build
   - Check if `/app/public/index.html` exists in container
   - Verify `NODE_ENV=production` is set

2. **Development:**
   - Restart Vite dev server: `cd frontend && npm run dev`
   - Check if port 5173 is in use: `lsof -i :5173`
   - Verify Vite proxy config for `/api` forwarding

3. **If assets missing**, rebuild:
   ```bash
   cd frontend && npm run build
   # Then restart the production container
   ```

**Prevention:**
- Include frontend build verification in CI/CD pipeline
- Add smoke tests for static asset serving
- Monitor frontend error rates via browser error logging

---

### FM-11: Report Generation Failure (PDF/CSV)

**Severity:** P3
**Symptoms:**
- Export buttons return 500 errors
- Partial file downloads
- Temp directory filling up

**Diagnosis:**

```bash
# Check temp directory
docker exec <container_id> ls -la /app/temp/

# Check disk space
docker exec <container_id> df -h /app/temp/

# Check for file permission issues
docker exec <container_id> touch /app/temp/test && rm /app/temp/test

# Look for specific error in logs
docker logs <container_id> | grep -i "csv\|pdf\|report"
```

**Resolution:**

1. **Clean temp directory:**
   ```bash
   docker exec <container_id> rm -rf /app/temp/*
   ```

2. **If permission errors:**
   ```bash
   docker exec <container_id> chown -R nodejs:nodejs /app/temp
   ```

3. **If out of memory during large report generation:**
   - Limit the date range for reports
   - Implement pagination/streaming for large exports

4. **If pdfkit or csv-writer module errors:**
   ```bash
   docker exec <container_id> npm ls pdfkit csv-writer
   # Rebuild if needed
   ```

**Prevention:**
- Implement temp file cleanup on a schedule
- Add file size limits for exports
- Stream large reports instead of buffering in memory
- Monitor temp directory size

---

### FM-12: Dependency / npm Module Failure

**Severity:** P2
**Symptoms:**
- `MODULE_NOT_FOUND` errors on startup
- Native module compilation failures (sqlite3)
- Version incompatibilities after updates

**Diagnosis:**

```bash
# Check if node_modules exists and is complete
docker exec <container_id> ls node_modules/.package-lock.json

# Verify key dependencies
docker exec <container_id> node -e "require('express'); require('sqlite3'); console.log('OK')"

# Check Node.js version
docker exec <container_id> node --version

# Look for missing modules in logs
docker logs <container_id> | grep "Cannot find module"
```

**Resolution:**

1. **Missing modules:**
   ```bash
   # Rebuild the container
   docker build -t timesheet-app -f docker/Dockerfile .
   docker restart <container_id>
   ```

2. **Native module (sqlite3) failure:**
   ```bash
   docker exec <container_id> npm rebuild sqlite3
   # Or rebuild from scratch
   docker build --no-cache -t timesheet-app -f docker/Dockerfile .
   ```

3. **Version conflicts:**
   ```bash
   # Check for peer dependency warnings
   cd backend && npm ls
   # Fix with clean install
   rm -rf node_modules package-lock.json && npm install
   ```

**Prevention:**
- Pin Node.js version in Dockerfile (currently node:20-alpine)
- Use `npm ci` in CI/CD for reproducible installs
- Run `npm audit` regularly for vulnerability detection
- Keep dependencies updated with automated PRs

---

## Escalation Matrix

| Severity | Response Time | Escalation After | Notify |
|----------|--------------|------------------|--------|
| P1 - Critical | 15 minutes | 30 minutes | On-call + Team Lead + DevOps |
| P2 - High | 1 hour | 2 hours | On-call + Team Lead |
| P3 - Medium | 4 hours | 8 hours | On-call |
| P4 - Low | Next business day | 48 hours | Assigned engineer |

### P1 Criteria (Critical)
- Application completely down
- Data loss or corruption
- All users affected

### P2 Criteria (High)
- Major feature unusable
- Performance severely degraded
- Significant subset of users affected

### P3 Criteria (Medium)
- Minor feature broken
- Workaround available
- Small number of users affected

### P4 Criteria (Low)
- Cosmetic issues
- Non-critical feature degraded
- Single user affected with workaround

---

## Post-Incident Review

After every P1/P2 incident, complete a post-incident review within 48 hours:

1. **Timeline:** Document when the incident started, was detected, acknowledged, mitigated, and resolved.
2. **Root Cause:** Identify the underlying cause (not just the trigger).
3. **Impact:** Quantify users affected, duration, and data loss (if any).
4. **Action Items:** Create tickets for preventive measures with owners and due dates.
5. **Lessons Learned:** What went well? What could improve?

Use the provided GitHub Issue templates to document incidents and track resolution.
