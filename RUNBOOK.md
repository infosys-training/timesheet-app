# Timesheet App – Incident Response Runbook

This runbook provides step-by-step procedures for diagnosing and resolving common failure modes in the Timesheet application. The app consists of an Express/Node.js backend (port 3001), a React/Vite frontend (port 5173 dev, served statically in production), and an SQLite database (in-memory in dev, file-based in Docker).

---

## Table of Contents

1. [INC-01: Backend Health Check Failure](#inc-01-backend-health-check-failure)
2. [INC-02: SQLite Database Unavailable or Corrupt](#inc-02-sqlite-database-unavailable-or-corrupt)
3. [INC-03: In-Memory Database Data Loss on Restart](#inc-03-in-memory-database-data-loss-on-restart)
4. [INC-04: API Rate Limiting Blocking Legitimate Traffic](#inc-04-api-rate-limiting-blocking-legitimate-traffic)
5. [INC-05: Authentication Middleware Failures](#inc-05-authentication-middleware-failures)
6. [INC-06: Report Generation Failures (PDF/CSV)](#inc-06-report-generation-failures-pdfcsv)
7. [INC-07: Frontend-to-Backend Connectivity Loss](#inc-07-frontend-to-backend-connectivity-loss)
8. [INC-08: Memory Exhaustion / Node.js OOM](#inc-08-memory-exhaustion--nodejs-oom)
9. [INC-09: Dependency Vulnerability (CVE) Detected](#inc-09-dependency-vulnerability-cve-detected)
10. [INC-10: Docker Container Health Check Failure](#inc-10-docker-container-health-check-failure)

---

## INC-01: Backend Health Check Failure

**Severity:** P1 – Complete service outage  
**Symptoms:** `GET /health` returns non-200 or times out; Docker `HEALTHCHECK` reports unhealthy; frontend shows network errors on all API calls.

### Diagnosis

```bash
# 1. Check if the backend process is running
pgrep -f "node src/server.js" || echo "Backend process not running"

# 2. Test the health endpoint directly
curl -sf http://localhost:3001/health || echo "Health check FAILED"

# 3. Check backend logs for startup errors
# Dev: check terminal running `npm run dev`
# Docker: docker logs <container_id> --tail 100

# 4. Check if the port is in use by another process
lsof -i :3001
```

### Resolution

1. **Process not running:** Restart the backend.
   - Dev: `cd backend && npm run dev`
   - Docker: `docker restart <container_id>`
2. **Port conflict:** Kill the conflicting process (`kill -9 <pid>`) and restart.
3. **Database init failure:** See [INC-02](#inc-02-sqlite-database-unavailable-or-corrupt). The server calls `initializeDatabase()` on startup and exits with code 1 if it fails (`server.js:66-68`).
4. **Dependency issue:** Run `cd backend && npm install` and restart.

### Verification

```bash
curl -s http://localhost:3001/health | jq .
# Expected: {"status":"OK","timestamp":"..."}
```

---

## INC-02: SQLite Database Unavailable or Corrupt

**Severity:** P1 – All data operations fail  
**Symptoms:** API endpoints return `500 Internal server error` with `Database error` in logs; error codes prefixed with `SQLITE_` (e.g., `SQLITE_CORRUPT`, `SQLITE_BUSY`, `SQLITE_CANTOPEN`).

### Diagnosis

```bash
# 1. Check backend logs for SQLITE_ errors
grep -i "SQLITE_\|Error opening database\|Database error" <log_source>

# 2. For file-based SQLite (Docker production), check the DB file
ls -la /app/data/timesheet.db          # inside container
sqlite3 /app/data/timesheet.db "PRAGMA integrity_check;"

# 3. Check disk space (file-based mode)
df -h /app/data
```

### Resolution

**In-memory mode (development):**
1. Restart the backend – the database is re-created fresh on each startup.

**File-based mode (Docker production):**
1. **SQLITE_BUSY / lock contention:** This usually resolves on its own. If persistent, restart the container to clear locks.
2. **SQLITE_CORRUPT:**
   - Stop the container.
   - Back up the corrupt file: `cp /app/data/timesheet.db /app/data/timesheet.db.corrupt.$(date +%s)`
   - Attempt recovery: `sqlite3 /app/data/timesheet.db ".recover" | sqlite3 /app/data/timesheet_recovered.db`
   - If recovery succeeds, replace the file and restart.
   - If recovery fails, remove the file and restart (data will be lost; schema is re-created on startup).
3. **SQLITE_CANTOPEN / disk full:** Free disk space or expand the volume, then restart.

### Verification

```bash
curl -s http://localhost:3001/health | jq .
curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients | jq .
# Expected: 200 with {"clients":[...]}
```

---

## INC-03: In-Memory Database Data Loss on Restart

**Severity:** P2 – Data loss after restart (development mode)  
**Symptoms:** All clients, work entries, and user records disappear after a backend restart. This is expected behavior for in-memory SQLite but may cause confusion.

### Diagnosis

```bash
# Confirm the database mode
grep -r "':memory:'" backend/src/database/init.js
# If present, the app is using in-memory SQLite (all data lost on restart)
```

### Resolution

1. **For development:** This is by design. Seed data can be re-created after restart.
2. **For production persistence:** Deploy using the Docker configuration which uses file-based SQLite:
   - The Dockerfile sets `DATABASE_PATH=/app/data/timesheet.db`
   - `docker/overrides/database/init.js` uses file-based storage
   - Ensure the `/app/data` volume is mounted to persistent storage:
     ```bash
     docker run -v timesheet-data:/app/data <image>
     ```

### Prevention

- Always use Docker with a persistent volume for non-development environments.
- Implement database backups for the SQLite file on a schedule.

---

## INC-04: API Rate Limiting Blocking Legitimate Traffic

**Severity:** P2 – Partial service degradation  
**Symptoms:** API returns `429 Too Many Requests`; users report intermittent failures; the rate limit is 100 requests per 15-minute window per IP (`server.js:26-29`).

### Diagnosis

```bash
# 1. Check for 429 responses in access logs (morgan 'combined' format)
grep " 429 " <access_log>

# 2. Test the rate limit
for i in $(seq 1 105); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health)
  echo "Request $i: $STATUS"
done
# Requests beyond 100 should return 429
```

### Resolution

1. **Short term:** Restart the backend to reset in-memory rate limit counters.
2. **Long term:** Adjust the rate limit in `backend/src/server.js`:
   ```js
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 500  // increase from 100
   });
   ```
3. **If behind a reverse proxy:** Ensure `trust proxy` is set on Express so rate limiting applies per real client IP, not per proxy IP:
   ```js
   app.set('trust proxy', 1);
   ```

### Verification

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health
# Expected: 200
```

---

## INC-05: Authentication Middleware Failures

**Severity:** P2 – Users unable to access protected endpoints  
**Symptoms:** All authenticated endpoints return `401 User email required` or `400 Invalid email format`; login works but subsequent API calls fail.

### Diagnosis

```bash
# 1. Test with a valid x-user-email header
curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients
# Expected: 200

# 2. Test without the header (should fail)
curl -s http://localhost:3001/api/clients
# Expected: 401

# 3. Check if the frontend is sending the header
# In browser DevTools → Network tab, inspect request headers for x-user-email
```

### Resolution

1. **Missing header from frontend:** Check that `localStorage.getItem('userEmail')` returns a valid email. The Axios request interceptor in `frontend/src/api/client.ts` adds this header automatically.
2. **User not logged in:** Redirect to `/login`. The response interceptor clears `localStorage` and redirects on 401.
3. **Database error during auth:** The auth middleware queries the `users` table. If the DB is down, auth fails with 500. See [INC-02](#inc-02-sqlite-database-unavailable-or-corrupt).

### Verification

```bash
# Login first
curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}' | jq .

# Then test an authenticated endpoint
curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients | jq .
```

---

## INC-06: Report Generation Failures (PDF/CSV)

**Severity:** P3 – Feature degradation (reports unavailable)  
**Symptoms:** CSV or PDF export endpoints return 500; errors like `Error creating CSV`, `Error sending file`; temp files accumulate in `backend/temp/`.

### Diagnosis

```bash
# 1. Check temp directory
ls -la backend/temp/ 2>/dev/null || echo "Temp directory does not exist"
du -sh backend/temp/ 2>/dev/null

# 2. Check disk space
df -h .

# 3. Test CSV export
curl -s -H "x-user-email: test@example.com" \
  -o /dev/null -w "%{http_code}" \
  http://localhost:3001/api/reports/export/csv/1

# 4. Test PDF export
curl -s -H "x-user-email: test@example.com" \
  -o /dev/null -w "%{http_code}" \
  http://localhost:3001/api/reports/export/pdf/1
```

### Resolution

1. **Temp directory missing:** The CSV export creates `backend/temp/` if absent (`reports.js:110-112`). If permissions prevent this, create manually:
   ```bash
   mkdir -p backend/temp && chmod 755 backend/temp
   ```
2. **Disk full:** Clean up temp files and free disk space. Orphaned temp files from failed exports may accumulate.
   ```bash
   find backend/temp/ -name "*.csv" -mmin +60 -delete
   ```
3. **PDF generation OOM:** Large reports with thousands of entries can exhaust memory during PDF creation. Paginate data or increase Node.js memory:
   ```bash
   node --max-old-space-size=512 src/server.js
   ```
4. **Missing dependencies:** Ensure `pdfkit` and `csv-writer` are installed: `cd backend && npm install`

### Prevention

- Add a cron job or startup hook to clean `backend/temp/` files older than 1 hour.
- Add request-level limits on the number of work entries exported at once.

---

## INC-07: Frontend-to-Backend Connectivity Loss

**Severity:** P1 (production) / P3 (dev)  
**Symptoms:** Frontend shows network errors or loading spinners; browser console shows CORS errors, `ERR_CONNECTION_REFUSED`, or Axios timeout errors after 10 seconds.

### Diagnosis

```bash
# 1. Verify backend is running
curl -sf http://localhost:3001/health

# 2. Check Vite proxy config (dev mode)
cat frontend/vite.config.ts
# Proxy should forward /api → http://localhost:3001

# 3. Check CORS configuration
grep "FRONTEND_URL" backend/.env
# Must match the frontend's origin (http://localhost:5173 in dev)

# 4. Check for firewall / network issues
netstat -tlnp | grep -E "3001|5173"
```

### Resolution

1. **Backend down:** Start the backend. See [INC-01](#inc-01-backend-health-check-failure).
2. **Vite proxy misconfigured (dev):** Ensure `vite.config.ts` proxies `/api` to `http://localhost:3001`.
3. **CORS mismatch:**
   - Dev: Set `FRONTEND_URL=http://localhost:5173` in `backend/.env`
   - Production: Set `FRONTEND_URL` to the actual frontend origin.
4. **Axios timeout:** The client timeout is 10 seconds (`frontend/src/api/client.ts:13`). If the backend is slow, increase the timeout or investigate backend performance.

### Verification

```bash
# From the frontend origin, test the API
curl -s -H "Origin: http://localhost:5173" \
  -H "Access-Control-Request-Method: GET" \
  -X OPTIONS http://localhost:3001/api/clients -v 2>&1 | grep "access-control"
```

---

## INC-08: Memory Exhaustion / Node.js OOM

**Severity:** P1 – Application crash  
**Symptoms:** Process killed with `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory`; Docker container restarts repeatedly; increasing memory usage over time.

### Diagnosis

```bash
# 1. Check Node.js memory usage
node -e "console.log(process.memoryUsage())"

# 2. Monitor memory over time (Docker)
docker stats <container_id>

# 3. Check for large in-memory datasets
# The SQLite in-memory database grows with data volume
# PDF generation buffers entire documents in memory
```

### Resolution

1. **Immediate:** Restart the application to reclaim memory.
2. **Increase heap size:**
   ```bash
   node --max-old-space-size=1024 src/server.js
   ```
   Or in Docker, set the env var: `NODE_OPTIONS=--max-old-space-size=1024`
3. **Root causes to investigate:**
   - **In-memory SQLite growth:** In development, the database lives in process memory. Switch to file-based SQLite for large datasets.
   - **PDF generation:** Large reports buffer the entire PDF in memory. Implement streaming or pagination.
   - **Temp file leaks:** CSV exports write to `backend/temp/` and clean up on download, but failures may leave orphaned files holding file descriptors.

### Prevention

- Use Docker with `--memory` limits and let the orchestrator restart on OOM.
- Monitor with `process.memoryUsage()` exposed via an internal metrics endpoint.
- Use file-based SQLite in any environment handling significant data volume.

---

## INC-09: Dependency Vulnerability (CVE) Detected

**Severity:** P2 (high severity) / P3 (moderate)  
**Symptoms:** CI pipeline `pr-checks.yml` fails with "Security Audit Failed – CVE Detection"; `npm audit` reports high or critical vulnerabilities.

### Diagnosis

```bash
# 1. Run npm audit for both packages
cd backend && npm audit
cd ../frontend && npm audit

# 2. Check for specific high/critical vulns
npm audit --json | jq '.metadata.vulnerabilities | {high, critical}'
```

### Resolution

1. **Automated fix attempt:**
   ```bash
   cd backend && npm audit fix
   cd ../frontend && npm audit fix
   ```
2. **If `npm audit fix` insufficient:**
   ```bash
   npm audit fix --force  # May include breaking changes
   ```
3. **Manual resolution:** Update specific packages in `package.json` to patched versions, then `npm install`.
4. **CI bypass for Devin auto-fix PRs:** The `pr-checks.yml` workflow already skips audit for PRs from Devin (`if: "!contains(github.event.pull_request.user.login, 'devin')"`).

### Prevention

- Run `npm audit` in CI on every PR (already configured).
- Schedule weekly dependency updates via Dependabot or Renovate.
- Pin major dependency versions to avoid unexpected breaking changes.

---

## INC-10: Docker Container Health Check Failure

**Severity:** P1 – Production deployment failure  
**Symptoms:** Docker reports container as `unhealthy`; orchestrator restarts the container repeatedly; `docker inspect` shows health check failures.

### Diagnosis

```bash
# 1. Check container health status
docker inspect --format='{{json .State.Health}}' <container_id> | jq .

# 2. Check health check logs
docker inspect --format='{{range .State.Health.Log}}{{.Output}}{{end}}' <container_id>

# 3. Exec into the container to test manually
docker exec -it <container_id> node -e \
  "require('http').get('http://localhost:3001/health', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{console.log(r.statusCode,d);process.exit(r.statusCode===200?0:1)}) })"
```

### Resolution

1. **Startup timing:** The health check has `start-period: 5s` (`Dockerfile:68`). If the app takes longer to start, increase it:
   ```dockerfile
   HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
     CMD node -e "require('http').get('http://localhost:3001/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"
   ```
2. **Database init failure:** Check container logs for `Failed to start server` messages. See [INC-02](#inc-02-sqlite-database-unavailable-or-corrupt).
3. **Volume permissions:** Ensure the `/app/data` directory is writable by the `nodejs` user (UID 1001):
   ```bash
   docker exec <container_id> ls -la /app/data
   ```

### Verification

```bash
docker ps --filter "name=<container>" --format "{{.Status}}"
# Expected: "Up X minutes (healthy)"
```

---

## General Escalation Path

| Severity | Response Time | Escalation |
|----------|--------------|------------|
| P1 | Immediate | On-call engineer → Team lead within 15 min |
| P2 | < 30 min | On-call engineer → Team lead within 1 hour |
| P3 | < 4 hours | Assigned engineer during business hours |
| P4 | Next sprint | Backlog item for planned work |

## Useful Commands Quick Reference

```bash
# Start backend (dev)
cd backend && npm run dev

# Start frontend (dev)
cd frontend && npm run dev

# Run backend tests
cd backend && npm test

# Run frontend lint
cd frontend && npm run lint

# Check health
curl -s http://localhost:3001/health | jq .

# Test authenticated endpoint
curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients | jq .

# Docker build
docker build -f docker/Dockerfile -t timesheet-app .

# Docker run with persistent storage
docker run -d -p 3001:3001 -v timesheet-data:/app/data timesheet-app
```
