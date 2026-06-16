# Timesheet App - Incident Response Runbook

## Table of Contents

- [Overview](#overview)
- [Architecture Summary](#architecture-summary)
- [Incident Severity Classification](#incident-severity-classification)
- [Failure Mode 1: Database Issues](#failure-mode-1-database-issues)
- [Failure Mode 2: API Errors](#failure-mode-2-api-errors)
- [Failure Mode 3: Memory and Resource Exhaustion](#failure-mode-3-memory-and-resource-exhaustion)
- [Failure Mode 4: Dependency and Build Failures](#failure-mode-4-dependency-and-build-failures)
- [Failure Mode 5: Authentication and Authorization Failures](#failure-mode-5-authentication-and-authorization-failures)
- [Failure Mode 6: Frontend / Proxy Failures](#failure-mode-6-frontend--proxy-failures)
- [Failure Mode 7: Docker and Deployment Failures](#failure-mode-7-docker-and-deployment-failures)
- [General Diagnostics](#general-diagnostics)
- [Escalation Matrix](#escalation-matrix)
- [Post-Incident Review Checklist](#post-incident-review-checklist)

---

## Overview

This runbook provides step-by-step procedures for diagnosing and resolving incidents affecting the Timesheet App. It is intended for on-call engineers and operations staff.

**Key contacts:**
- Repository: `infosys-training/timesheet-app`
- Health check endpoint: `GET /health`
- Backend port: `3001` (Express + Node.js)
- Frontend port: `5173` (Vite dev) / served from `/public` in production
- Database: SQLite (in-memory in dev, file-based in production at `/app/data/timesheet.db`)

---

## Architecture Summary

```
[Browser] --> [Vite Dev Proxy :5173] --> [Express API :3001] --> [SQLite DB]
                                              |
                                     /api/auth      (email-only auth)
                                     /api/clients   (CRUD)
                                     /api/work-entries (CRUD)
                                     /api/reports   (JSON, CSV, PDF export)
                                     /health        (health check)
```

**Production (Docker):**
```
[Browser] --> [Express :3001] --> [SQLite file: /app/data/timesheet.db]
                  |
           Serves static frontend from /public
```

Middleware chain: `helmet` -> `cors` -> `rateLimit (100/15min)` -> `morgan` -> `json parser` -> routes -> `errorHandler` -> `404 handler`

---

## Incident Severity Classification

| Severity | Definition | Response Time | Examples |
|----------|-----------|---------------|----------|
| **P1** | Complete service outage, data loss | 15 min | DB corruption, server crash loop, data loss |
| **P2** | Major feature degraded, partial outage | 30 min | All API routes returning 500, auth broken |
| **P3** | Minor feature impacted, workaround exists | 4 hours | CSV/PDF export failing, single route error |
| **P4** | Cosmetic, low-impact | 1 business day | Slow response times, log noise |

---

## Failure Mode 1: Database Issues

### 1.1 In-Memory Database Data Loss (Dev)

**Symptoms:** All data disappears after a server restart; users report empty client lists and work entries.

**Cause:** The development database uses SQLite `:memory:`, which is ephemeral.

**Diagnosis:**
```bash
# Check if the server recently restarted
journalctl -u timesheet-backend --since "1 hour ago" | grep -i "restart\|start\|error"

# Verify database mode
grep -r ":memory:" backend/src/database/init.js
```

**Resolution:**
1. This is expected behavior in development. Data does not persist across restarts.
2. For persistent dev data, switch to file-based SQLite by modifying `backend/src/database/init.js`:
   ```js
   db = new sqlite3.Database('./data/dev.db');
   ```
3. For production, ensure Docker is using the production override at `docker/overrides/database/init.js` which uses `DATABASE_PATH=/app/data/timesheet.db`.

**Prevention:** Inform developers that dev mode is ephemeral. Use Docker for any testing that requires data persistence.

---

### 1.2 SQLite Database Corruption (Production)

**Symptoms:** 500 errors on all database-backed routes; error logs show `SQLITE_CORRUPT` or `SQLITE_NOTADB`.

**Diagnosis:**
```bash
# Check container logs for SQLite errors
docker logs <container_id> 2>&1 | grep -i "sqlite\|corrupt\|database"

# Verify database file integrity (exec into container)
docker exec <container_id> ls -la /app/data/timesheet.db

# Check disk space on the host volume
df -h /path/to/mounted/data
```

**Resolution:**
1. **Stop the application** to prevent further corruption:
   ```bash
   docker stop <container_id>
   ```
2. **Backup the corrupt database file** before any recovery attempt:
   ```bash
   cp /app/data/timesheet.db /app/data/timesheet.db.corrupt.$(date +%s)
   ```
3. **Attempt recovery** using SQLite CLI:
   ```bash
   sqlite3 /app/data/timesheet.db ".recover" | sqlite3 /app/data/timesheet_recovered.db
   ```
4. **Validate recovered data:**
   ```bash
   sqlite3 /app/data/timesheet_recovered.db "PRAGMA integrity_check;"
   sqlite3 /app/data/timesheet_recovered.db "SELECT count(*) FROM users; SELECT count(*) FROM clients; SELECT count(*) FROM work_entries;"
   ```
5. **Replace and restart:**
   ```bash
   mv /app/data/timesheet_recovered.db /app/data/timesheet.db
   docker start <container_id>
   ```

**Prevention:** Implement regular database backups. Ensure the Docker volume has adequate disk space. Avoid abrupt container termination (`docker stop` sends SIGTERM; `docker kill` may corrupt).

---

### 1.3 Database Lock Contention

**Symptoms:** Intermittent 500 errors, especially on write operations. Logs show `SQLITE_BUSY` or `SQLITE_LOCKED`.

**Diagnosis:**
```bash
# Check application logs for lock-related errors
docker logs <container_id> 2>&1 | grep -i "busy\|locked\|SQLITE_BUSY"

# Check concurrent connections
docker exec <container_id> node -e "
  const db = require('better-sqlite3')('/app/data/timesheet.db', {readonly: true});
  console.log(db.pragma('journal_mode'));
  console.log(db.pragma('busy_timeout'));
"
```

**Resolution:**
1. **Increase busy timeout** by adding to database initialization:
   ```js
   db.run('PRAGMA busy_timeout = 5000;'); // 5 second wait before SQLITE_BUSY
   ```
2. **Enable WAL mode** for better concurrent read/write performance:
   ```js
   db.run('PRAGMA journal_mode = WAL;');
   ```
3. **Restart the container** if the database is deadlocked:
   ```bash
   docker restart <container_id>
   ```

**Prevention:** Consider WAL mode as default in production init. For high-concurrency scenarios, evaluate migrating to PostgreSQL.

---

### 1.4 Schema Initialization Failure

**Symptoms:** Server fails to start; logs show `Failed to start server` with database table creation errors.

**Diagnosis:**
```bash
# Check startup logs
docker logs <container_id> 2>&1 | head -50

# Verify the init.js file is correct
docker exec <container_id> cat /app/src/database/init.js
```

**Resolution:**
1. Verify the correct `init.js` is deployed (dev vs production override).
2. Check that the SQLite database file path is writable:
   ```bash
   docker exec <container_id> ls -la /app/data/
   docker exec <container_id> touch /app/data/test_write && echo "writable" || echo "NOT writable"
   ```
3. If permissions are wrong, fix ownership:
   ```bash
   docker exec -u root <container_id> chown -R nodejs:nodejs /app/data
   ```
4. Restart the container.

---

## Failure Mode 2: API Errors

### 2.1 Rate Limiting (429 Too Many Requests)

**Symptoms:** Clients receive `429 Too Many Requests` responses. Legitimate users are blocked.

**Diagnosis:**
```bash
# Check rate limit configuration
grep -A5 "rateLimit" backend/src/server.js
# Current: 100 requests per 15-minute window per IP

# Check for abnormal traffic patterns
docker logs <container_id> 2>&1 | grep "429" | wc -l
```

**Resolution:**
1. If a single IP is causing the issue, it may be a legitimate heavy user or an attack. Check the Morgan access logs to identify the IP.
2. **Temporary increase** of the rate limit (requires redeployment):
   ```js
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 500  // increased from 100
   });
   ```
3. **If under DDoS**, consider adding IP-based blocking upstream (reverse proxy, WAF, or cloud provider).

**Prevention:** Implement per-user rate limiting rather than per-IP. Add a reverse proxy (nginx) with its own rate limiting for defense-in-depth.

---

### 2.2 Unhandled 500 Internal Server Errors

**Symptoms:** API routes return `500` status with `{"error": "Internal server error"}`.

**Diagnosis:**
```bash
# Check error logs - the errorHandler middleware logs all errors
docker logs <container_id> 2>&1 | grep -i "error:" | tail -20

# Check if it's database-related
docker logs <container_id> 2>&1 | grep -i "database error" | tail -10

# Test the health endpoint
curl -s http://localhost:3001/health | jq .
```

**Resolution:**
1. If the health endpoint responds OK but API routes fail, check database connectivity:
   ```bash
   curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients
   ```
2. If all routes fail, restart the application:
   ```bash
   docker restart <container_id>
   ```
3. If the issue persists, check for resource exhaustion (see [Memory and Resource Exhaustion](#failure-mode-3-memory-and-resource-exhaustion)).

---

### 2.3 Validation Errors (400 Bad Request)

**Symptoms:** API returns `{"error": "Validation error", "details": [...]}`.

**Cause:** Request body does not match Joi validation schemas (see `backend/src/validation/schemas.js`).

**Diagnosis:**
```bash
# Common validation constraints:
# - client.name: required, 1-255 chars
# - workEntry.hours: required, positive, max 24
# - workEntry.date: required, ISO format
# - email: valid email format
```

**Resolution:** This is typically a client-side bug. Check the frontend code that submits the request and ensure it matches the schema.

---

### 2.4 CSV/PDF Export Failures

**Symptoms:** Report exports return 500 errors. Logs show file I/O errors.

**Diagnosis:**
```bash
# Check temp directory
docker exec <container_id> ls -la /app/temp/ 2>/dev/null || echo "temp dir missing"

# Check disk space
docker exec <container_id> df -h /app/

# Check for leftover temp files
docker exec <container_id> find /app/temp -name "*.csv" -mmin +60
```

**Resolution:**
1. Ensure the temp directory exists and is writable:
   ```bash
   docker exec <container_id> mkdir -p /app/temp
   docker exec -u root <container_id> chown nodejs:nodejs /app/temp
   ```
2. Clean up stale temp files:
   ```bash
   docker exec <container_id> find /app/temp -name "*.csv" -mmin +60 -delete
   ```
3. If disk is full, free space or expand the volume.

**Prevention:** Implement a scheduled cleanup job for the temp directory. The current code cleans up after download, but failures can leave orphan files.

---

## Failure Mode 3: Memory and Resource Exhaustion

### 3.1 Node.js Heap Out of Memory

**Symptoms:** Process crashes with `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory`.

**Diagnosis:**
```bash
# Check container memory usage
docker stats <container_id> --no-stream

# Check Node.js heap usage (if accessible)
docker exec <container_id> node -e "console.log(process.memoryUsage())"
```

**Resolution:**
1. **Immediate**: Restart the container:
   ```bash
   docker restart <container_id>
   ```
2. **Increase heap limit** if needed (update CMD in Dockerfile or docker run):
   ```bash
   docker run ... node --max-old-space-size=512 src/server.js
   ```
3. **Investigate root cause**:
   - Large PDF generation (PDFKit holds document in memory)
   - In-memory SQLite growing with data volume
   - Unreleased event listeners

**Prevention:** Set container memory limits. Monitor memory usage via Docker stats or a monitoring solution. Consider streaming for large PDF/CSV exports.

---

### 3.2 Temp File Disk Exhaustion

**Symptoms:** CSV export fails; disk full errors in logs.

**Diagnosis:**
```bash
# Check disk usage
docker exec <container_id> df -h
docker exec <container_id> du -sh /app/temp/
```

**Resolution:**
1. Clean up temp files:
   ```bash
   docker exec <container_id> rm -f /app/temp/*.csv
   ```
2. Expand the volume if necessary.

---

## Failure Mode 4: Dependency and Build Failures

### 4.1 npm Install / Build Failures

**Symptoms:** `npm ci` or `npm run build` fails during Docker build or CI.

**Diagnosis:**
```bash
# Check for lock file mismatches
diff <(node -e "console.log(require('./package.json').dependencies)") package-lock.json

# Check Node.js version
node --version  # Expected: 20.x

# Check for native module build failures (sqlite3)
npm ls sqlite3
```

**Resolution:**
1. **Lock file mismatch**: Regenerate `package-lock.json`:
   ```bash
   rm package-lock.json && npm install
   ```
2. **sqlite3 native build failure**: Ensure build tools are available:
   ```bash
   # In Docker (Alpine)
   apk add --no-cache python3 make g++
   ```
3. **Vite/TypeScript build errors**: Run `tsc -b` separately to isolate type errors from build errors.

---

### 4.2 Vulnerability (CVE) Scan Failures

**Symptoms:** CI pipeline blocks PR due to SAST or CVE scan failures (`.github/workflows/sast-scan.yml`).

**Diagnosis:**
```bash
# Run local audit
cd backend && npm audit
cd frontend && npm audit
```

**Resolution:**
1. **Auto-fix available**: `npm audit fix`
2. **Breaking change required**: `npm audit fix --force` (test thoroughly)
3. **False positive**: Add to `.github/workflows/sast-scan.yml` ignore list if justified.

---

## Failure Mode 5: Authentication and Authorization Failures

### 5.1 Missing or Invalid x-user-email Header

**Symptoms:** All authenticated API calls return `401 Unauthorized` with `{"error": "User email required in x-user-email header"}`.

**Diagnosis:**
```bash
# Test with explicit header
curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients

# Check frontend is sending the header
# The Axios interceptor reads from localStorage.getItem('userEmail')
```

**Resolution:**
1. Verify the frontend stores the email after login:
   ```js
   // Check browser: localStorage.getItem('userEmail')
   ```
2. Verify the Axios interceptor is attaching the header (see `frontend/src/api/client.ts` lines 20-31).
3. If CORS is blocking headers, check the `FRONTEND_URL` env var matches the actual frontend origin.

---

### 5.2 CORS Rejection

**Symptoms:** Browser console shows `Access-Control-Allow-Origin` errors. API requests fail from the frontend.

**Diagnosis:**
```bash
# Check configured CORS origin
grep "FRONTEND_URL" backend/.env
# Or in production:
docker exec <container_id> printenv | grep FRONTEND

# Test CORS preflight
curl -s -X OPTIONS -H "Origin: http://localhost:5173" -H "Access-Control-Request-Method: GET" http://localhost:3001/api/clients -v 2>&1 | grep "Access-Control"
```

**Resolution:**
1. Ensure `FRONTEND_URL` in `.env` matches the actual frontend URL.
2. In production (Docker), the frontend is served from the same origin (`/public`), so CORS should not be an issue.
3. If deploying frontend and backend separately, update the CORS origin:
   ```bash
   FRONTEND_URL=https://your-frontend-domain.com
   ```

---

## Failure Mode 6: Frontend / Proxy Failures

### 6.1 Vite Proxy Connection Refused (Dev)

**Symptoms:** Frontend shows network errors; browser console shows `502 Bad Gateway` or `ECONNREFUSED` for `/api/*` requests.

**Diagnosis:**
```bash
# Check if backend is running
curl -s http://localhost:3001/health

# Check Vite proxy config
cat frontend/vite.config.ts
# Should proxy /api to http://localhost:3001
```

**Resolution:**
1. Start the backend first: `cd backend && npm run dev`
2. Then start the frontend: `cd frontend && npm run dev`
3. Verify backend is accessible on port 3001.

---

### 6.2 Frontend Build / TypeScript Errors

**Symptoms:** `npm run build` in frontend fails with TypeScript compilation errors.

**Diagnosis:**
```bash
cd frontend && npx tsc --noEmit
```

**Resolution:**
1. Fix type errors reported by the compiler.
2. Check that `frontend/src/types/api.ts` matches the current backend API response shapes.

---

## Failure Mode 7: Docker and Deployment Failures

### 7.1 Docker Build Failure

**Symptoms:** `docker build` fails at one of the multi-stage build steps.

**Diagnosis:**
```bash
# Build with verbose output
docker build -f docker/Dockerfile -t timesheet-app . --progress=plain 2>&1 | tail -50
```

**Resolution:**
- **Frontend build fails**: Check TypeScript/Vite errors (see 6.2).
- **Backend dependency install fails**: Check sqlite3 native build (see 4.1).
- **Override files missing**: Ensure `docker/overrides/server.js` and `docker/overrides/database/init.js` exist.

---

### 7.2 Container Health Check Failing

**Symptoms:** Container shows `unhealthy` status in `docker ps`.

**Diagnosis:**
```bash
# Check health check logs
docker inspect <container_id> --format='{{json .State.Health}}' | jq .

# Check container logs
docker logs <container_id> --tail 20

# Test health endpoint manually
docker exec <container_id> node -e "require('http').get('http://localhost:3001/health', (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>console.log(r.statusCode,d)); })"
```

**Resolution:**
1. If the app is running but health check fails, check that port 3001 is correct.
2. If the app is not running, check container logs for startup errors.
3. Rebuild the container if the health check command itself is broken.

---

## General Diagnostics

### Quick Health Check Commands

```bash
# Backend health
curl -sf http://localhost:3001/health | jq .

# Backend API smoke test
curl -sf -H "x-user-email: test@example.com" http://localhost:3001/api/clients | jq .

# Frontend dev server
curl -sf http://localhost:5173/ > /dev/null && echo "Frontend OK" || echo "Frontend DOWN"

# Docker container status
docker ps --filter "name=timesheet" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

### Log Locations

| Component | Dev Mode | Docker |
|-----------|---------|--------|
| Backend | stdout (terminal) | `docker logs <container>` |
| Frontend | stdout (terminal) | Built into backend static serving |
| Access logs | Morgan `combined` format in stdout | Same |

### Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Backend server port |
| `NODE_ENV` | `development` | Environment mode |
| `FRONTEND_URL` | `http://localhost:5173` | CORS allowed origin |
| `JWT_SECRET` | (from .env) | JWT signing key |
| `DATABASE_PATH` | (none / in-memory) | Production SQLite file path |

---

## Escalation Matrix

| Severity | First Responder | Escalation | Time to Escalate |
|----------|----------------|-----------|-----------------|
| P1 | On-call engineer | Team lead + Ops | 15 min if not mitigated |
| P2 | On-call engineer | Team lead | 1 hour if not resolved |
| P3 | Assigned developer | On-call engineer | End of business day |
| P4 | Assigned developer | N/A | Next sprint |

---

## Post-Incident Review Checklist

- [ ] **Timeline**: Document when the incident started, was detected, and resolved
- [ ] **Root cause**: Identify the underlying cause (not just the symptom)
- [ ] **Impact**: Quantify affected users, data loss, and downtime duration
- [ ] **Detection**: How was the incident detected? Can detection be improved?
- [ ] **Response**: Was the runbook followed? Were any steps missing or wrong?
- [ ] **Prevention**: What changes prevent recurrence? (code fix, monitoring, process)
- [ ] **Action items**: Create tickets for all follow-up work with owners and deadlines
- [ ] **Runbook update**: Update this runbook with any new findings
