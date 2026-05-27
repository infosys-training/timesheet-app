# Timesheet App Incident Response Runbook

## Table of Contents

- [Overview](#overview)
- [Architecture Summary](#architecture-summary)
- [Critical Endpoints](#critical-endpoints)
- [Failure Modes and Response Procedures](#failure-modes-and-response-procedures)
  - [FM-1: Database Connection Failure](#fm-1-database-connection-failure)
  - [FM-2: Database Corruption / Schema Errors](#fm-2-database-corruption--schema-errors)
  - [FM-3: API Unresponsive (Express Server Down)](#fm-3-api-unresponsive-express-server-down)
  - [FM-4: High Memory Usage / Memory Leak](#fm-4-high-memory-usage--memory-leak)
  - [FM-5: Rate Limiting Blocking Legitimate Traffic](#fm-5-rate-limiting-blocking-legitimate-traffic)
  - [FM-6: CORS Misconfiguration](#fm-6-cors-misconfiguration)
  - [FM-7: Frontend Build / Serving Failure](#fm-7-frontend-build--serving-failure)
  - [FM-8: PDF/CSV Report Generation Failure](#fm-8-pdfcsv-report-generation-failure)
  - [FM-9: Authentication Middleware Failure](#fm-9-authentication-middleware-failure)
  - [FM-10: Dependency Vulnerability / Supply Chain Failure](#fm-10-dependency-vulnerability--supply-chain-failure)
  - [FM-11: Disk Space Exhaustion (Production)](#fm-11-disk-space-exhaustion-production)
  - [FM-12: Docker Container Health Check Failure](#fm-12-docker-container-health-check-failure)
- [Escalation Matrix](#escalation-matrix)
- [Post-Incident Review Template](#post-incident-review-template)

---

## Overview

This runbook provides step-by-step procedures for diagnosing and resolving incidents affecting the Timesheet App. It covers the backend (Express/Node.js API with SQLite), the frontend (React/Vite SPA), and the Docker production deployment.

**On-call expectations:** Acknowledge P1/P2 incidents within 15 minutes. Begin investigation immediately. Post status updates every 30 minutes until resolved.

---

## Architecture Summary

```
                   ┌─────────────┐
                   │   Browser   │
                   └──────┬──────┘
                          │
              ┌───────────┴───────────┐
              │  Frontend (React/Vite) │  Port 5173 (dev) / static (prod)
              │  Proxy: /api -> :3001  │
              └───────────┬───────────┘
                          │
              ┌───────────┴───────────┐
              │  Backend (Express)     │  Port 3001
              │  - Helmet (security)   │
              │  - Rate limiter        │
              │  - Morgan (logging)    │
              │  - Joi (validation)    │
              └───────────┬───────────┘
                          │
              ┌───────────┴───────────┐
              │  SQLite Database       │
              │  - In-memory (dev)     │
              │  - File-based (prod)   │
              │    /app/data/timesheet │
              └───────────────────────┘
```

**Key routes:**

| Route                          | Method   | Description                |
| ------------------------------ | -------- | -------------------------- |
| `/health`                      | GET      | Health check               |
| `/api/auth/login`              | POST     | Login (email-only)         |
| `/api/auth/me`                 | GET      | Current user info          |
| `/api/clients`                 | GET/POST | List/create clients        |
| `/api/clients/:id`             | GET/PUT/DELETE | Client CRUD           |
| `/api/work-entries`            | GET/POST | List/create work entries   |
| `/api/work-entries/:id`        | GET/PUT/DELETE | Work entry CRUD       |
| `/api/reports/client/:id`      | GET      | Client report (JSON)       |
| `/api/reports/export/csv/:id`  | GET      | Export CSV                 |
| `/api/reports/export/pdf/:id`  | GET      | Export PDF                 |

---

## Critical Endpoints

These endpoints must be functional for the application to operate:

1. **`GET /health`** - Application liveness check
2. **`POST /api/auth/login`** - User authentication
3. **`GET /api/clients`** - Core data retrieval
4. **`GET /api/work-entries`** - Core data retrieval
5. **`GET /api/reports/client/:id`** - Reporting functionality

---

## Failure Modes and Response Procedures

### FM-1: Database Connection Failure

**Severity:** P1 - All data operations are blocked.

**Symptoms:**
- All API endpoints return `500 Internal server error`
- Server logs show `Error opening database` or `SQLITE_CANTOPEN`
- Health check passes (it does not query the database) but all other routes fail

**Diagnosis:**

```bash
# Check server logs
docker logs <container_id> 2>&1 | grep -i "database\|sqlite\|error"

# Verify database file exists and is writable (production)
docker exec <container_id> ls -la /app/data/timesheet.db

# Check disk space
docker exec <container_id> df -h /app/data

# Test database connectivity from within the container
docker exec <container_id> node -e "
  const sqlite3 = require('sqlite3').verbose();
  const db = new sqlite3.Database(process.env.DATABASE_PATH || ':memory:');
  db.get('SELECT 1', (err) => {
    console.log(err ? 'FAIL: ' + err.message : 'OK');
    db.close();
  });
"
```

**Resolution:**

1. **In-memory mode (dev):** Restart the server. Data loss is expected with in-memory SQLite.
   ```bash
   npm run dev   # Development
   ```

2. **File-based mode (production):**
   ```bash
   # Check file permissions
   docker exec <container_id> ls -la /app/data/

   # If permission issue, fix ownership
   docker exec -u root <container_id> chown nodejs:nodejs /app/data/timesheet.db

   # If database file is corrupted, restore from backup
   docker cp /path/to/backup/timesheet.db <container_id>:/app/data/timesheet.db

   # Restart the container
   docker restart <container_id>
   ```

3. **If disk is full:** See [FM-11](#fm-11-disk-space-exhaustion-production).

---

### FM-2: Database Corruption / Schema Errors

**Severity:** P1 - Data integrity compromised.

**Symptoms:**
- Errors like `SQLITE_CORRUPT`, `SQLITE_SCHEMA`, or `no such table`
- Some queries succeed while others fail
- Server starts but operations on specific tables fail

**Diagnosis:**

```bash
# Check SQLite integrity
docker exec <container_id> node -e "
  const sqlite3 = require('sqlite3').verbose();
  const db = new sqlite3.Database(process.env.DATABASE_PATH);
  db.get('PRAGMA integrity_check', (err, row) => {
    console.log(err ? 'ERROR: ' + err.message : JSON.stringify(row));
    db.close();
  });
"

# Verify all expected tables exist
docker exec <container_id> node -e "
  const sqlite3 = require('sqlite3').verbose();
  const db = new sqlite3.Database(process.env.DATABASE_PATH);
  db.all(\"SELECT name FROM sqlite_master WHERE type='table'\", (err, rows) => {
    console.log(err ? 'ERROR: ' + err.message : rows.map(r => r.name).join(', '));
    db.close();
  });
"
```

**Expected tables:** `users`, `clients`, `work_entries`

**Resolution:**

1. If integrity check fails, restore from the most recent backup:
   ```bash
   docker stop <container_id>
   cp /app/data/timesheet.db /app/data/timesheet.db.corrupt.$(date +%s)
   cp /path/to/backup/timesheet.db /app/data/timesheet.db
   docker start <container_id>
   ```

2. If tables are missing, the `initializeDatabase()` function uses `CREATE TABLE IF NOT EXISTS`, so restarting the server should recreate them:
   ```bash
   docker restart <container_id>
   ```
   **Note:** Missing tables after restart indicate a deeper issue with the schema initialization — check `src/database/init.js`.

---

### FM-3: API Unresponsive (Express Server Down)

**Severity:** P1 - Complete service outage.

**Symptoms:**
- `/health` returns no response or connection refused
- Frontend displays network errors on all pages
- Docker health check reports `unhealthy`

**Diagnosis:**

```bash
# Check if the container is running
docker ps -a | grep timesheet

# Check container health
docker inspect --format='{{.State.Health.Status}}' <container_id>

# View recent logs
docker logs --tail 100 <container_id>

# Check if the process is running inside the container
docker exec <container_id> ps aux

# Check port binding
docker port <container_id>

# Test health endpoint directly
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health
```

**Resolution:**

1. **Container stopped:** Restart it.
   ```bash
   docker start <container_id>
   ```

2. **Process crashed inside container:** Check logs for the root cause, then restart.
   ```bash
   docker logs --tail 200 <container_id>
   docker restart <container_id>
   ```

3. **Port conflict:** Another process may be using port 3001.
   ```bash
   lsof -i :3001
   # Kill the conflicting process or remap the port
   docker run -p 3002:3001 ...
   ```

4. **Out of memory (OOM killed):**
   ```bash
   docker inspect <container_id> | grep -i oom
   dmesg | grep -i "out of memory"
   # Increase memory limits
   docker update --memory=512m <container_id>
   ```

---

### FM-4: High Memory Usage / Memory Leak

**Severity:** P2 - Degraded performance, potential crash.

**Symptoms:**
- Increasing response times over hours/days
- Container memory usage grows continuously
- OOMKilled events in Docker
- Node.js `heap out of memory` errors in logs

**Diagnosis:**

```bash
# Check container resource usage
docker stats <container_id> --no-stream

# Check Node.js heap usage
docker exec <container_id> node -e "
  const used = process.memoryUsage();
  Object.entries(used).forEach(([k, v]) =>
    console.log(k + ': ' + Math.round(v / 1024 / 1024 * 100) / 100 + ' MB')
  );
"

# Check for large temp files from report generation
docker exec <container_id> du -sh /app/temp 2>/dev/null || echo "No temp dir"
docker exec <container_id> ls -la /app/temp 2>/dev/null
```

**Likely causes:**
- CSV report generation creates temp files in `backend/temp/` that may not get cleaned up if the download fails mid-stream.
- PDF generation pipes directly to the response stream, but errors during streaming can leave resources open.
- SQLite connection singleton should prevent connection leaks, but verify only one connection exists.

**Resolution:**

1. **Immediate relief:** Restart the container.
   ```bash
   docker restart <container_id>
   ```

2. **Clean up temp files:**
   ```bash
   docker exec <container_id> rm -f /app/temp/*.csv
   ```

3. **Set memory limits to prevent host impact:**
   ```bash
   docker update --memory=512m --memory-swap=1g <container_id>
   ```

4. **Long-term fix:** Add a cron job or startup cleanup for stale temp files. Consider streaming CSV output directly to the response instead of writing to disk.

---

### FM-5: Rate Limiting Blocking Legitimate Traffic

**Severity:** P2 - Users unable to access the application.

**Symptoms:**
- Users receive `429 Too Many Requests` responses
- Application appears down for some users but not others
- Happens during peak usage or when many users share an IP (e.g., office NAT)

**Diagnosis:**

```bash
# Check current rate limit configuration in server.js
# Default: 100 requests per 15-minute window per IP
grep -A3 "rateLimit" backend/src/server.js

# Check for 429 responses in logs
docker logs <container_id> 2>&1 | grep "429\| rate"
```

**Resolution:**

1. **Temporary increase:** Modify the rate limit configuration and redeploy.
   ```javascript
   // In server.js, increase the limit
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 500  // Increase from 100
   });
   ```

2. **Exclude health checks from rate limiting** (if monitoring tools are consuming the quota): Move the `/health` route above the rate limiter middleware.

3. **Use environment variable for rate limit:**
   ```javascript
   max: parseInt(process.env.RATE_LIMIT_MAX) || 100
   ```

---

### FM-6: CORS Misconfiguration

**Severity:** P2 - Frontend cannot communicate with backend.

**Symptoms:**
- Browser console shows `Access-Control-Allow-Origin` errors
- API calls fail from the frontend but succeed from curl/Postman
- Happens after domain or port changes

**Diagnosis:**

```bash
# Check the FRONTEND_URL environment variable
docker exec <container_id> printenv FRONTEND_URL

# Test CORS headers
curl -I -H "Origin: https://your-frontend-domain.com" http://localhost:3001/health

# Check server.js CORS config
grep -A4 "cors(" backend/src/server.js
```

**Resolution:**

1. Set the correct `FRONTEND_URL` environment variable:
   ```bash
   # In .env or Docker environment
   FRONTEND_URL=https://your-actual-frontend-domain.com
   ```

2. For multiple origins, update the CORS configuration in `server.js`:
   ```javascript
   app.use(cors({
     origin: process.env.FRONTEND_URL?.split(',') || 'http://localhost:5173',
     credentials: true
   }));
   ```

3. Redeploy after changes.

---

### FM-7: Frontend Build / Serving Failure

**Severity:** P2 - Users cannot access the UI.

**Symptoms:**
- Blank page or Vite error screen in browser
- 404 on frontend assets
- TypeScript compilation errors during build
- Vite proxy errors (dev mode)

**Diagnosis:**

```bash
# Check if frontend build artifacts exist (production)
docker exec <container_id> ls -la /app/public/

# Check Vite proxy configuration (development)
cat frontend/vite.config.ts

# Attempt a fresh build
cd frontend && npm run build

# Check for TypeScript errors
cd frontend && npx tsc --noEmit
```

**Resolution:**

1. **Dev mode — Vite proxy failure:**
   ```bash
   # Ensure backend is running on port 3001 first
   cd backend && npm run dev &
   cd frontend && npm run dev
   ```

2. **Production — missing build artifacts:**
   ```bash
   # Rebuild the Docker image
   docker build -f docker/Dockerfile -t timesheet-app .
   docker run -p 3001:3001 timesheet-app
   ```

3. **TypeScript errors:** Fix type errors reported by `npx tsc --noEmit`, then rebuild.

---

### FM-8: PDF/CSV Report Generation Failure

**Severity:** P3 - Reporting degraded, core CRUD still works.

**Symptoms:**
- Export buttons fail or download empty files
- Server logs show `Error creating CSV` or `Error sending file`
- Temp directory fills up with orphaned files
- `ENOSPC` errors (disk full)

**Diagnosis:**

```bash
# Check temp directory
docker exec <container_id> ls -la /app/temp/ 2>/dev/null

# Check disk space
docker exec <container_id> df -h

# Test report generation directly
curl -H "x-user-email: test@example.com" \
  http://localhost:3001/api/reports/export/csv/1 -o test.csv
```

**Resolution:**

1. **Clean up orphaned temp files:**
   ```bash
   docker exec <container_id> find /app/temp -name "*.csv" -mmin +60 -delete
   ```

2. **Disk full:** Free space or expand the volume. See [FM-11](#fm-11-disk-space-exhaustion-production).

3. **Permission issue on temp directory:**
   ```bash
   docker exec -u root <container_id> mkdir -p /app/temp
   docker exec -u root <container_id> chown nodejs:nodejs /app/temp
   ```

---

### FM-9: Authentication Middleware Failure

**Severity:** P2 - Users cannot access protected routes.

**Symptoms:**
- All authenticated routes return `401 User email required in x-user-email header`
- Login works but subsequent requests fail
- Frontend redirects to `/login` repeatedly

**Diagnosis:**

```bash
# Verify the x-user-email header is being sent
# Check browser DevTools Network tab for the header

# Test with curl
curl -H "x-user-email: test@example.com" http://localhost:3001/api/clients

# Check if the auth middleware can reach the database
curl -X POST -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}' http://localhost:3001/api/auth/login
```

**Resolution:**

1. **Frontend not sending header:** Check `frontend/src/api/client.ts` — the Axios interceptor reads `userEmail` from `localStorage`. Verify it is set after login.

2. **Database issue in auth middleware:** The auth middleware queries the `users` table on every request. If the database connection is broken, all authenticated routes fail. See [FM-1](#fm-1-database-connection-failure).

3. **Clear browser state and re-login:**
   ```javascript
   localStorage.removeItem('userEmail');
   // Navigate to /login
   ```

---

### FM-10: Dependency Vulnerability / Supply Chain Failure

**Severity:** P3 (known vulnerability) / P1 (active exploit).

**Symptoms:**
- `npm audit` reports high/critical vulnerabilities
- CI pipeline (`pr-checks.yml`) fails on security audit
- SonarCloud quality gate fails (`sast-scan.yml`)

**Diagnosis:**

```bash
# Run audit for both packages
cd backend && npm audit
cd frontend && npm audit

# Check for outdated packages
cd backend && npm outdated
cd frontend && npm outdated
```

**Resolution:**

1. **Auto-fix compatible updates:**
   ```bash
   cd backend && npm audit fix
   cd frontend && npm audit fix
   ```

2. **Breaking changes requiring manual intervention:**
   ```bash
   npm audit fix --force  # Use with caution — may introduce breaking changes
   npm test               # Verify nothing is broken
   ```

3. **If a dependency is compromised:** Pin to the last known-good version in `package.json` and investigate before upgrading.

---

### FM-11: Disk Space Exhaustion (Production)

**Severity:** P1 - Database writes fail, reports cannot be generated.

**Symptoms:**
- `SQLITE_FULL` or `ENOSPC` errors in logs
- Database writes fail but reads succeed
- Report exports fail

**Diagnosis:**

```bash
# Check disk usage
docker exec <container_id> df -h
docker exec <container_id> du -sh /app/data /app/temp 2>/dev/null

# Check Docker volume usage
docker system df

# Find large files
docker exec <container_id> find / -type f -size +10M 2>/dev/null
```

**Resolution:**

1. **Clean up temp files:**
   ```bash
   docker exec <container_id> rm -rf /app/temp/*
   ```

2. **Clean up Docker resources:**
   ```bash
   docker system prune -f
   docker volume prune -f
   ```

3. **Expand the volume or migrate to a larger disk.**

4. **Long-term:** Add monitoring alerts for disk usage > 80%.

---

### FM-12: Docker Container Health Check Failure

**Severity:** P2 - Orchestrator may restart the container in a loop.

**Symptoms:**
- `docker inspect` shows `unhealthy` status
- Container restarts repeatedly
- Orchestrator (Docker Compose, Kubernetes) marks the service as down

**Diagnosis:**

```bash
# Check health check status and history
docker inspect --format='{{json .State.Health}}' <container_id> | jq

# Check what the health check command returns
docker exec <container_id> node -e "
  require('http').get('http://localhost:3001/health', (r) => {
    let data = '';
    r.on('data', d => data += d);
    r.on('end', () => { console.log(r.statusCode, data); process.exit(r.statusCode === 200 ? 0 : 1); });
  }).on('error', e => { console.log('FAIL:', e.message); process.exit(1); });
"
```

**Resolution:**

1. If the app is starting slowly, increase the health check start period:
   ```dockerfile
   HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5
   ```

2. If the app is genuinely down, check server logs and follow [FM-3](#fm-3-api-unresponsive-express-server-down).

---

## Escalation Matrix

| Severity | Response Time | Escalation Path                          |
| -------- | ------------- | ---------------------------------------- |
| P1       | 15 min        | On-call engineer -> Team lead -> VP Eng  |
| P2       | 1 hour        | On-call engineer -> Team lead            |
| P3       | 4 hours       | Assigned engineer                        |
| P4       | Next sprint   | Backlog                                  |

---

## Post-Incident Review Template

After resolving any P1 or P2 incident, complete a post-incident review within 48 hours:

1. **Incident Summary:** What happened?
2. **Timeline:** When was it detected? When was it resolved?
3. **Root Cause:** What was the underlying cause?
4. **Impact:** How many users were affected? What data was lost?
5. **Detection:** How was the incident detected? Could it have been detected sooner?
6. **Resolution:** What steps resolved the incident?
7. **Prevention:** What changes will prevent recurrence?
8. **Action Items:** Specific tasks with owners and deadlines.
