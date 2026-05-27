# Timesheet App - Incident Response Runbook

This document provides step-by-step procedures for diagnosing and resolving common failures in the Timesheet application.

---

## Table of Contents

1. [Application Overview](#application-overview)
2. [Critical Endpoints](#critical-endpoints)
3. [Failure Mode 1: Database Failures](#failure-mode-1-database-failures)
4. [Failure Mode 2: API / Express Server Errors](#failure-mode-2-api--express-server-errors)
5. [Failure Mode 3: Memory Leaks and Resource Exhaustion](#failure-mode-3-memory-leaks-and-resource-exhaustion)
6. [Failure Mode 4: Authentication Failures](#failure-mode-4-authentication-failures)
7. [Failure Mode 5: Dependency and Build Failures](#failure-mode-5-dependency-and-build-failures)
8. [Failure Mode 6: Report Generation Failures (PDF/CSV)](#failure-mode-6-report-generation-failures-pdfcsv)
9. [Failure Mode 7: Frontend / Proxy Failures](#failure-mode-7-frontend--proxy-failures)
10. [Failure Mode 8: Docker / Container Failures](#failure-mode-8-docker--container-failures)
11. [Failure Mode 9: Rate Limiting and CORS Issues](#failure-mode-9-rate-limiting-and-cors-issues)
12. [Escalation Procedures](#escalation-procedures)
13. [Post-Incident Checklist](#post-incident-checklist)

---

## Application Overview

| Component | Technology | Default Port |
|-----------|------------|-------------|
| Backend API | Node.js + Express | 3001 |
| Frontend SPA | React + Vite | 5173 (dev) |
| Database | SQLite (in-memory dev / file-based prod) | N/A |
| Reverse Proxy (dev) | Vite dev server | 5173 -> 3001 |
| Container Runtime | Docker (node:20-alpine) | 3001 |

**Key environment variables:**

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | Backend listen port | `3001` |
| `NODE_ENV` | Runtime mode | `development` |
| `FRONTEND_URL` | Allowed CORS origin | `http://localhost:5173` |
| `JWT_SECRET` | Token signing key | *(must be set)* |
| `DATABASE_PATH` | SQLite file path (prod) | `/app/data/timesheet.db` |

---

## Critical Endpoints

| Endpoint | Method | Auth Required | Purpose |
|----------|--------|---------------|---------|
| `/health` | GET | No | Application health check |
| `/api/auth/login` | POST | No | User login |
| `/api/auth/me` | GET | Yes | Current user info |
| `/api/clients` | GET | Yes | List clients |
| `/api/work-entries` | GET | Yes | List work entries |
| `/api/reports/client/:id` | GET | Yes | Client report |
| `/api/reports/export/csv/:id` | GET | Yes | CSV export |
| `/api/reports/export/pdf/:id` | GET | Yes | PDF export |

---

## Failure Mode 1: Database Failures

### Symptoms
- HTTP 500 responses with `"Database error"` message
- Backend logs showing `SQLITE_*` error codes
- Data loss after server restart (in-memory mode)
- `"Error opening database"` in startup logs

### Diagnosis

```bash
# 1. Check backend logs for SQLite errors
docker logs <container_id> 2>&1 | grep -i "sqlite\|database"

# 2. Verify database file exists and is writable (production only)
ls -la /app/data/timesheet.db
df -h /app/data

# 3. Check disk space
df -h

# 4. Test database connectivity via health endpoint
curl -s http://localhost:3001/health | jq .
```

### Resolution

#### In-Memory Database Lost (Development)

1. This is expected behavior. The in-memory SQLite database is destroyed on every server restart.
2. Restart the backend server: `cd backend && npm run dev`
3. The database schema will be recreated automatically on startup.
4. **Mitigation**: For persistent data, switch to file-based SQLite by modifying `backend/src/database/init.js` to use a file path instead of `:memory:`.

#### SQLite File Corruption (Production)

1. Stop the application:
   ```bash
   docker stop <container_id>
   ```
2. Back up the corrupted database:
   ```bash
   cp /app/data/timesheet.db /app/data/timesheet.db.corrupt.$(date +%s)
   ```
3. Attempt to recover using SQLite tools:
   ```bash
   sqlite3 /app/data/timesheet.db ".recover" | sqlite3 /app/data/timesheet_recovered.db
   ```
4. If recovery succeeds, replace the database:
   ```bash
   mv /app/data/timesheet_recovered.db /app/data/timesheet.db
   ```
5. Restart the container:
   ```bash
   docker start <container_id>
   ```
6. If recovery fails, restore from the most recent backup and restart.

#### Disk Full (Production)

1. Check disk usage:
   ```bash
   df -h /app/data
   du -sh /app/data/*
   ```
2. Remove old temp files created by CSV export:
   ```bash
   rm -f /app/backend/temp/*.csv
   ```
3. If SQLite WAL files are large, run a checkpoint:
   ```bash
   sqlite3 /app/data/timesheet.db "PRAGMA wal_checkpoint(TRUNCATE);"
   ```
4. Consider increasing disk allocation or archiving old data.

---

## Failure Mode 2: API / Express Server Errors

### Symptoms
- HTTP 500 on any API endpoint
- `"Internal server error"` JSON responses
- Process crash with unhandled exception
- No response (connection refused on port 3001)

### Diagnosis

```bash
# 1. Check if the backend process is running
pgrep -f "node src/server.js" || echo "Backend is NOT running"

# 2. Check for port conflicts
lsof -i :3001

# 3. Check recent logs
docker logs --tail 100 <container_id>

# 4. Test health endpoint
curl -v http://localhost:3001/health

# 5. Check for validation errors (Joi)
curl -s http://localhost:3001/api/auth/login -X POST \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}' | jq .
```

### Resolution

#### Server Not Starting

1. Check for port conflicts:
   ```bash
   lsof -i :3001
   kill <conflicting_pid>
   ```
2. Verify environment variables are set:
   ```bash
   cat backend/.env
   ```
3. Check Node.js version (requires 18+):
   ```bash
   node --version
   ```
4. Reinstall dependencies:
   ```bash
   cd backend && rm -rf node_modules && npm install
   ```
5. Start the server:
   ```bash
   npm run dev
   ```

#### Unhandled Exceptions Crashing the Process

1. Check logs for the stack trace.
2. If the error is in a route handler, the `errorHandler` middleware should catch it. If it does not, the error may be in async code without proper `try/catch`.
3. In production, ensure a process manager (e.g., `dumb-init` in Docker) is used to handle signals properly.
4. Restart the process:
   ```bash
   docker restart <container_id>
   ```

#### Request Body Too Large

1. The backend is configured with a 10 MB JSON body limit (`express.json({ limit: '10mb' })`).
2. If payloads exceed this, the client will receive a `413 Payload Too Large` error.
3. Increase the limit in `backend/src/server.js` if necessary.

---

## Failure Mode 3: Memory Leaks and Resource Exhaustion

### Symptoms
- Increasing memory consumption over time
- Slow response times
- `ENOMEM` errors in logs
- Docker container OOM-killed
- Temp files accumulating in `backend/temp/`

### Diagnosis

```bash
# 1. Check container memory usage
docker stats <container_id> --no-stream

# 2. Check Node.js process memory
kill -USR2 <node_pid>  # Trigger heap dump if --inspect is enabled

# 3. Check for leaked temp files from CSV export
ls -la backend/temp/ 2>/dev/null
du -sh backend/temp/ 2>/dev/null

# 4. Check open file descriptors
ls /proc/<node_pid>/fd | wc -l
```

### Resolution

#### PDF Generation Memory Leak

1. The PDF export (`/api/reports/export/pdf/:clientId`) uses PDFKit to stream documents. If the response is aborted mid-stream, the PDF document may not be finalized.
2. Monitor memory after heavy PDF export usage.
3. Restart the backend if memory exceeds acceptable thresholds:
   ```bash
   docker restart <container_id>
   ```
4. Set a memory limit on the container:
   ```bash
   docker run --memory=512m ...
   ```

#### CSV Temp File Accumulation

1. The CSV export writes temporary files to `backend/temp/`. These should be cleaned up after download, but may be orphaned if the download fails.
2. Clean up manually:
   ```bash
   find backend/temp/ -name "*.csv" -mmin +60 -delete
   ```
3. Consider adding a cron job or scheduled cleanup task.

#### Node.js Heap Growth

1. Set a heap limit:
   ```bash
   node --max-old-space-size=256 src/server.js
   ```
2. Profile memory usage with `--inspect`:
   ```bash
   node --inspect src/server.js
   ```
3. Open Chrome DevTools at `chrome://inspect` to take heap snapshots.

---

## Failure Mode 4: Authentication Failures

### Symptoms
- HTTP 401 on authenticated endpoints
- `"User email required in x-user-email header"` error
- `"Invalid email format"` error
- Users unable to log in
- Frontend redirecting to `/login` repeatedly

### Diagnosis

```bash
# 1. Test login endpoint
curl -s http://localhost:3001/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}' | jq .

# 2. Test authenticated endpoint with email header
curl -s http://localhost:3001/api/clients \
  -H "x-user-email: test@example.com" | jq .

# 3. Check browser localStorage for stored email
# In browser console: localStorage.getItem('userEmail')
```

### Resolution

#### Missing x-user-email Header

1. The frontend stores the user's email in `localStorage` and sends it via the `x-user-email` header on every request.
2. If `localStorage` is cleared, the user must log in again.
3. Check the Axios interceptor in `frontend/src/api/client.ts` to ensure headers are being sent.

#### Email Validation Rejection

1. The backend validates email format using the regex `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`.
2. Ensure the email provided matches this pattern.

#### User Record Not Created

1. If the database is in-memory and was restarted, all user records are lost.
2. The auth middleware auto-creates users on first request, so login again to recreate the record.

---

## Failure Mode 5: Dependency and Build Failures

### Symptoms
- `npm install` fails
- `npm run build` fails with TypeScript errors
- Docker build fails
- Vulnerabilities reported by `npm audit`

### Diagnosis

```bash
# 1. Check Node.js version
node --version  # Requires 18+

# 2. Check for outdated dependencies
cd backend && npm outdated
cd frontend && npm outdated

# 3. Audit for vulnerabilities
cd backend && npm audit
cd frontend && npm audit

# 4. Verify lockfile integrity
cd backend && npm ci
cd frontend && npm ci
```

### Resolution

#### npm Install Failures

1. Clear npm cache:
   ```bash
   npm cache clean --force
   ```
2. Remove node_modules and lockfile, then reinstall:
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```
3. If `sqlite3` native compilation fails, install build tools:
   ```bash
   # On Alpine (Docker)
   apk add --no-cache python3 make g++
   # On Ubuntu/Debian
   sudo apt-get install -y build-essential python3
   ```

#### TypeScript Build Failures (Frontend)

1. Run the type checker:
   ```bash
   cd frontend && npx tsc --noEmit
   ```
2. Fix reported type errors before rebuilding.
3. Rebuild:
   ```bash
   npm run build
   ```

#### Vulnerability Remediation

1. Run `npm audit fix` to auto-fix where possible.
2. For breaking changes: `npm audit fix --force` (test thoroughly after).
3. If a vulnerability cannot be fixed, document the risk and create a tracking issue.

---

## Failure Mode 6: Report Generation Failures (PDF/CSV)

### Symptoms
- HTTP 500 on `/api/reports/export/csv/:clientId` or `/api/reports/export/pdf/:clientId`
- `"Failed to generate CSV report"` error
- Empty or corrupted downloaded files
- `"Error sending file"` in logs
- Temp directory permission errors

### Diagnosis

```bash
# 1. Check if temp directory exists and is writable
ls -la backend/temp/ 2>/dev/null || echo "Temp dir does not exist"

# 2. Check disk space
df -h

# 3. Test report data endpoint first
curl -s http://localhost:3001/api/reports/client/1 \
  -H "x-user-email: test@example.com" | jq .

# 4. Check for file permission issues
stat backend/temp/ 2>/dev/null
```

### Resolution

1. Ensure the `backend/temp/` directory exists and is writable:
   ```bash
   mkdir -p backend/temp
   chmod 755 backend/temp
   ```
2. Verify the client exists and has work entries before exporting.
3. Check disk space; CSV/PDF generation requires temporary disk writes.
4. Clean up orphaned temp files:
   ```bash
   find backend/temp/ -name "*.csv" -mmin +60 -delete
   ```
5. Restart the backend if PDFKit is in a bad state.

---

## Failure Mode 7: Frontend / Proxy Failures

### Symptoms
- Blank page or loading spinner that never resolves
- `ERR_CONNECTION_REFUSED` in browser console
- `502 Bad Gateway` from Vite proxy
- API calls timing out (10-second Axios timeout configured)
- CORS errors in browser console

### Diagnosis

```bash
# 1. Check if frontend dev server is running
pgrep -f "vite" || echo "Vite is NOT running"

# 2. Check if backend is reachable from the proxy
curl -s http://localhost:3001/health | jq .

# 3. Check Vite proxy configuration
cat frontend/vite.config.ts

# 4. Check browser console for errors (open DevTools -> Console)
```

### Resolution

#### Vite Dev Server Not Running

1. Start the frontend:
   ```bash
   cd frontend && npm run dev
   ```

#### Backend Unreachable (Proxy 502)

1. The Vite dev server proxies `/api` requests to `http://localhost:3001`.
2. Ensure the backend is running on port 3001.
3. Check that `PORT` in `backend/.env` matches the Vite proxy target.

#### CORS Errors

1. The backend allows CORS from `FRONTEND_URL` (default `http://localhost:5173`).
2. If the frontend is served from a different origin, update `FRONTEND_URL` in `backend/.env`.
3. In production (Docker), the frontend is served by the backend itself, so CORS is not needed.

#### Axios Timeout

1. The frontend API client has a 10-second timeout.
2. If the backend is slow (e.g., large report generation), consider increasing the timeout in `frontend/src/api/client.ts`.

---

## Failure Mode 8: Docker / Container Failures

### Symptoms
- Container fails to start
- Health check failing (`unhealthy` status)
- Container OOM-killed
- Build fails during `npm ci`

### Diagnosis

```bash
# 1. Check container status
docker ps -a | grep timesheet

# 2. Check health status
docker inspect --format='{{.State.Health.Status}}' <container_id>

# 3. View health check logs
docker inspect --format='{{json .State.Health}}' <container_id> | jq .

# 4. View container logs
docker logs --tail 200 <container_id>

# 5. Check resource usage
docker stats <container_id> --no-stream
```

### Resolution

#### Container Fails Health Check

1. The Docker health check hits `http://localhost:3001/health` every 30 seconds.
2. If the backend is slow to start, increase `--start-period` in the Dockerfile.
3. Check backend logs for startup errors.

#### OOM-Killed

1. Increase container memory limit:
   ```bash
   docker run --memory=1g ...
   ```
2. Investigate memory leak (see Failure Mode 3).

#### Build Failures

1. Ensure multi-stage build dependencies are available (node:20-alpine).
2. If `npm ci` fails, check that `package-lock.json` is committed and up to date.
3. For native module compilation (sqlite3), ensure build tools are available in the builder stage.

#### Data Directory Permissions

1. The Dockerfile creates `/app/data` owned by `nodejs:nodejs` (UID 1001).
2. If mounting a host volume, ensure the host directory has correct permissions:
   ```bash
   chown 1001:1001 /path/to/host/data
   ```

---

## Failure Mode 9: Rate Limiting and CORS Issues

### Symptoms
- HTTP 429 `Too Many Requests` responses
- Legitimate users locked out
- CORS preflight failures in browser

### Diagnosis

```bash
# 1. Check rate limit headers in response
curl -v http://localhost:3001/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}' 2>&1 | grep -i "ratelimit\|retry-after"

# 2. Check CORS headers
curl -v -X OPTIONS http://localhost:3001/api/clients \
  -H "Origin: http://localhost:5173" \
  -H "Access-Control-Request-Method: GET" 2>&1 | grep -i "access-control"
```

### Resolution

#### Rate Limit Exceeded

1. The general rate limit is 100 requests per 15-minute window per IP.
2. Wait for the window to expire, or restart the backend to reset the in-memory rate limit counters.
3. To adjust limits, modify `backend/src/server.js`:
   ```javascript
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 200  // increase as needed
   });
   ```

#### CORS Preflight Failures

1. Ensure `FRONTEND_URL` in `backend/.env` matches the exact origin of the frontend (including protocol and port).
2. If multiple origins are needed, update the CORS configuration in `backend/src/server.js`.

---

## Escalation Procedures

| Severity | Response Time | Escalation Path |
|----------|--------------|-----------------|
| **P1 - Critical** (service down) | Immediate | On-call engineer -> Team lead -> Engineering manager |
| **P2 - Major** (degraded service) | < 30 min | On-call engineer -> Team lead |
| **P3 - Minor** (partial feature failure) | < 4 hours | Assigned engineer |
| **P4 - Low** (cosmetic / non-urgent) | Next business day | Product backlog |

### Communication Channels

- **Immediate**: Page on-call via PagerDuty / Slack `#incidents` channel
- **Status Updates**: Post updates every 30 minutes for P1, every 2 hours for P2
- **Post-Incident**: Schedule a blameless retrospective within 48 hours for P1/P2

---

## Post-Incident Checklist

- [ ] Incident timeline documented (detection -> diagnosis -> resolution)
- [ ] Root cause identified
- [ ] Affected users notified
- [ ] Monitoring / alerting gaps identified and tickets created
- [ ] Data recovery confirmed (if applicable)
- [ ] Temporary workarounds removed and permanent fixes deployed
- [ ] Runbook updated with lessons learned
- [ ] Post-incident review scheduled (for P1/P2)
