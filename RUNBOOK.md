# Timesheet App Incident Runbook

Operational procedures for diagnosing and resolving production incidents in the Timesheet application (Express + React + SQLite).

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Critical Endpoints](#critical-endpoints)
3. [Failure Mode 1: Database Failures](#failure-mode-1-database-failures)
4. [Failure Mode 2: API / HTTP Errors](#failure-mode-2-api--http-errors)
5. [Failure Mode 3: Memory Exhaustion](#failure-mode-3-memory-exhaustion)
6. [Failure Mode 4: Dependency & Build Failures](#failure-mode-4-dependency--build-failures)
7. [Failure Mode 5: Infrastructure & Container Failures](#failure-mode-5-infrastructure--container-failures)
8. [Failure Mode 6: Authentication & CORS Issues](#failure-mode-6-authentication--cors-issues)
9. [Escalation Matrix](#escalation-matrix)
10. [Post-Incident Checklist](#post-incident-checklist)

---

## Architecture Overview

| Component | Technology | Port | Notes |
|-----------|-----------|------|-------|
| Backend API | Express.js (Node 20) | 3001 | Serves REST API and static frontend in production |
| Frontend | React + Vite | 5173 (dev) | Bundled into `public/` for production |
| Database | SQLite | N/A | In-memory (dev), file-based `/app/data/timesheet.db` (production) |
| Auth | Email-only | N/A | `x-user-email` header, no password |
| Container | Docker (Alpine) | 3001 | Multi-stage build, `dumb-init` for signal handling |

### Key middleware

- **Rate limiter**: 100 requests per IP per 15 min window (`express-rate-limit`)
- **Helmet**: HTTP security headers
- **CORS**: Restricted to `FRONTEND_URL` origin
- **Morgan**: Combined access logging to stdout

---

## Critical Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/health` | GET | No | Liveness / readiness probe |
| `/api/auth/login` | POST | No | Create or verify user |
| `/api/auth/me` | GET | Yes | Current user info |
| `/api/clients` | GET/POST | Yes | List / create clients |
| `/api/clients/:id` | GET/PUT/DELETE | Yes | Single-client CRUD |
| `/api/work-entries` | GET/POST | Yes | List / create work entries |
| `/api/work-entries/:id` | GET/PUT/DELETE | Yes | Single-entry CRUD |
| `/api/reports/client/:id` | GET | Yes | Client hour summary |
| `/api/reports/export/csv/:id` | GET | Yes | CSV download |
| `/api/reports/export/pdf/:id` | GET | Yes | PDF download |

---

## Failure Mode 1: Database Failures

### Symptoms

- API returns `500` with `"Database error"` or `"Internal server error"`
- Server fails to start: `"Failed to start server"` in logs
- Data missing after container restart (in-memory mode)
- `SQLITE_BUSY`, `SQLITE_LOCKED`, or `SQLITE_CORRUPT` errors in stderr

### Diagnosis

```bash
# 1. Check application logs for SQLite error codes
docker logs <container> 2>&1 | grep -i "sqlite\|database\|error"

# 2. Verify the database file exists and is writable (production)
docker exec <container> ls -la /app/data/timesheet.db

# 3. Check disk space on the host volume
df -h /path/to/mounted/volume

# 4. Test the health endpoint
curl -s http://localhost:3001/health | jq .

# 5. Attempt a simple query via the app
curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients
```

### Resolution

#### Database file missing or corrupt (production)

1. Stop the container: `docker stop <container>`
2. If backups exist, restore the SQLite file:
   ```bash
   cp /backups/timesheet.db /path/to/volume/timesheet.db
   ```
3. Restart the container: `docker start <container>`
4. Verify via health check: `curl http://localhost:3001/health`

#### Disk full

1. Check disk usage: `df -h`
2. Clear temp files created by CSV exports:
   ```bash
   docker exec <container> rm -rf /app/temp/*
   ```
3. Expand the volume or free host disk space
4. Restart the container

#### Data loss after restart (in-memory mode)

This is expected behavior in development. For production, ensure `DATABASE_PATH` env var is set and the `/app/data` directory is mounted as a persistent volume:

```bash
docker run -v timesheet-data:/app/data -e DATABASE_PATH=/app/data/timesheet.db ...
```

#### Lock contention (`SQLITE_BUSY`)

1. Identify long-running operations (large CSV/PDF exports)
2. Restart the container to release locks
3. Consider adding WAL mode if contention is frequent:
   ```sql
   PRAGMA journal_mode=WAL;
   ```

---

## Failure Mode 2: API / HTTP Errors

### Symptoms

- `400 Validation error` responses with Joi details
- `404 Route not found` for previously working endpoints
- `429 Too Many Requests` from rate limiter
- `500 Internal server error` on specific routes

### Diagnosis

```bash
# 1. Check backend logs for error stack traces
docker logs <container> 2>&1 | grep -A5 "Error:"

# 2. Test specific endpoint
curl -v -H "x-user-email: test@example.com" http://localhost:3001/api/clients

# 3. Check rate limiter status (look for 429 responses in logs)
docker logs <container> 2>&1 | grep "429\|rate"

# 4. Verify route registration
curl -s http://localhost:3001/nonexistent | jq .
# Should return: {"error": "Route not found"}
```

### Resolution

#### Validation errors (400)

These are client-side issues. Check the request body against Joi schemas in `backend/src/validation/schemas.js`. Common problems:
- Missing required fields (`name` for clients, `clientId`/`hours`/`date` for work entries)
- Invalid email format
- Hours outside valid range

No server-side action required; communicate schema requirements to API consumers.

#### Rate limiting (429)

1. Default: 100 requests per IP per 15-minute window
2. For legitimate traffic spikes, adjust `max` in `backend/src/server.js`:
   ```js
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 200  // increase as needed
   });
   ```
3. Restart the server after changes

#### Unhandled 500 errors

1. Check stderr for the full stack trace
2. If the error is in a report export route, check temp directory permissions
3. If the error pattern matches `SQLITE_*`, see [Database Failures](#failure-mode-1-database-failures)

---

## Failure Mode 3: Memory Exhaustion

### Symptoms

- Container killed by OOM (Out of Memory) — Docker restart with exit code 137
- Node.js `FATAL ERROR: HEAP_LIMIT Allocation failed - JavaScript heap out of memory`
- Slow responses and increasing latency over time
- Large PDF/CSV exports hanging or timing out

### Diagnosis

```bash
# 1. Check container resource usage
docker stats <container>

# 2. Check for OOM kills in Docker events
docker events --filter event=oom --since 1h

# 3. Check Node.js heap usage (if the process is still running)
docker exec <container> node -e "console.log(process.memoryUsage())"

# 4. Check container logs for heap errors
docker logs <container> 2>&1 | grep -i "heap\|memory\|oom"
```

### Resolution

#### OOM on PDF/CSV export

Large reports can exhaust memory. Mitigation:

1. Restart the container to recover
2. Add memory limits to Docker:
   ```bash
   docker run --memory=512m --memory-swap=1g ...
   ```
3. For very large exports, consider paginating the database query in `backend/src/routes/reports.js`

#### Gradual memory growth (leak)

1. Monitor memory with `docker stats` over time
2. Schedule periodic container restarts as a stopgap:
   ```bash
   # Cron job example: restart daily at 3 AM
   0 3 * * * docker restart timesheet-app
   ```
3. Profile with `--inspect` flag if the leak persists:
   ```bash
   docker exec <container> node --inspect=0.0.0.0:9229 src/server.js
   ```

#### In-memory database growth

The SQLite in-memory DB grows with data volume. In development, restart the server to reclaim memory. In production, file-based SQLite avoids this issue.

---

## Failure Mode 4: Dependency & Build Failures

### Symptoms

- `npm install` fails with native module compilation errors (especially `sqlite3`)
- `npm audit` reports high/critical vulnerabilities (blocks PR via CI)
- Frontend build (`tsc -b && vite build`) fails with TypeScript errors
- Docker build fails at `npm ci` step

### Diagnosis

```bash
# 1. Check for native module issues
cd backend && npm ls sqlite3

# 2. Run security audit
cd frontend && npm audit --audit-level=high
cd backend && npm audit --audit-level=high

# 3. Verify Node.js version matches Dockerfile
node --version  # should be v20.x

# 4. Test frontend build
cd frontend && npm run build
```

### Resolution

#### sqlite3 native module failure

1. Ensure build tools are installed:
   ```bash
   # Alpine (Docker)
   apk add --no-cache python3 make g++
   # Ubuntu/Debian
   apt-get install -y python3 make g++
   ```
2. Rebuild the module:
   ```bash
   cd backend && npm rebuild sqlite3
   ```

#### Security vulnerabilities (CI blocking)

1. Run `npm audit fix` in the affected directory
2. If `npm audit fix` cannot resolve, manually update the package:
   ```bash
   npm install <package>@latest
   ```
3. The CI workflow (`pr-checks.yml`) auto-triggers Devin for SAST remediation on eligible PRs

#### Frontend TypeScript build errors

1. Check `frontend/tsconfig.json` for strict mode settings
2. Run `cd frontend && npx tsc --noEmit` to see all errors
3. Fix type errors before committing

---

## Failure Mode 5: Infrastructure & Container Failures

### Symptoms

- Container exits immediately on start
- Port 3001 already in use
- Docker health check failing (container shows `unhealthy`)
- Cannot reach the application from the browser

### Diagnosis

```bash
# 1. Check container status and health
docker ps -a --filter name=timesheet
docker inspect <container> --format='{{.State.Health.Status}}'

# 2. View recent health check results
docker inspect <container> --format='{{json .State.Health}}' | jq .

# 3. Check port binding
ss -tlnp | grep 3001
# or
lsof -i :3001

# 4. Check container exit reason
docker inspect <container> --format='{{.State.ExitCode}} {{.State.Error}}'

# 5. Verify environment variables
docker exec <container> env | grep -E "PORT|NODE_ENV|DATABASE_PATH|FRONTEND_URL"
```

### Resolution

#### Container won't start

1. Check logs: `docker logs <container>`
2. Common causes:
   - Missing environment variables — ensure `PORT`, `DATABASE_PATH` are set
   - Database initialization failure — check volume mounts
   - Syntax error in overrides — verify `docker/overrides/` files exist

#### Port conflict

1. Find the process using port 3001:
   ```bash
   lsof -i :3001
   ```
2. Stop the conflicting process or change the `PORT` env var

#### Health check failure

The Docker health check runs:
```
node -e "require('http').get('http://localhost:3001/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"
```

1. Exec into the container and run the check manually
2. If `/health` returns non-200, check application logs for startup errors
3. Increase `start-period` if the app needs more time to initialize

#### Frontend not loading (production)

In production, the frontend is served from `/app/public/` as static files. If pages return 404:

1. Verify the build output exists: `docker exec <container> ls /app/public/`
2. Check that the `docker/overrides/server.js` includes `express.static` middleware
3. Rebuild the Docker image to regenerate the frontend bundle

---

## Failure Mode 6: Authentication & CORS Issues

### Symptoms

- `401 User email required in x-user-email header`
- `400 Invalid email format`
- Browser console shows CORS errors
- Frontend redirects to `/login` unexpectedly

### Diagnosis

```bash
# 1. Test auth directly
curl -v -H "x-user-email: user@example.com" http://localhost:3001/api/auth/me

# 2. Check CORS configuration
curl -v -X OPTIONS -H "Origin: http://localhost:5173" http://localhost:3001/api/clients

# 3. Verify FRONTEND_URL env var
echo $FRONTEND_URL
# or in Docker:
docker exec <container> printenv FRONTEND_URL
```

### Resolution

#### Missing `x-user-email` header

All `/api/*` routes (except `/api/auth/login`) require the `x-user-email` header. Ensure the frontend Axios interceptor is attaching it from `localStorage`.

1. Check `frontend/src/api/client.ts` — the interceptor reads `localStorage.getItem('userEmail')`
2. If `localStorage` is cleared, the user must log in again

#### CORS errors

1. Verify `FRONTEND_URL` matches the actual frontend origin exactly (protocol + host + port)
2. In development: should be `http://localhost:5173`
3. In production: should match the deployed domain
4. Restart the backend after changing `FRONTEND_URL`

---

## Escalation Matrix

| Severity | Response Time | Who to Contact | Examples |
|----------|--------------|----------------|----------|
| **P1 — Critical** | Immediate (< 15 min) | On-call engineer + team lead | Complete outage, data loss, security breach |
| **P2 — High** | < 1 hour | On-call engineer | Major feature broken (can't create entries), persistent 500s |
| **P3 — Medium** | < 4 hours | Development team | Export failures, intermittent errors, degraded performance |
| **P4 — Low** | Next business day | Development team | UI glitch, non-blocking warnings, cosmetic issues |

---

## Post-Incident Checklist

- [ ] Incident timeline documented (detection → diagnosis → resolution)
- [ ] Root cause identified and recorded
- [ ] Fix deployed and verified with health check script (`scripts/health-check.sh`)
- [ ] Monitoring/alerting gap addressed (if the incident was not auto-detected)
- [ ] Runbook updated if new failure mode discovered
- [ ] GitHub issue created with appropriate severity template
- [ ] Stakeholders notified of resolution
- [ ] Blameless post-mortem scheduled (P1/P2 only)
