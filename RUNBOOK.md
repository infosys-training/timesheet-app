# Timesheet Application — Incident Response Runbook

This runbook provides step-by-step procedures for diagnosing and resolving common failure modes in the Employee Time Tracking Application.

---

## Table of Contents

1. [General Triage](#1-general-triage)
2. [Database Failures](#2-database-failures)
3. [API / Backend Errors](#3-api--backend-errors)
4. [Authentication Failures](#4-authentication-failures)
5. [Memory Leaks & Resource Exhaustion](#5-memory-leaks--resource-exhaustion)
6. [Dependency / npm Failures](#6-dependency--npm-failures)
7. [Report Generation Failures (PDF/CSV)](#7-report-generation-failures-pdfcsv)
8. [Rate Limiting Issues](#8-rate-limiting-issues)
9. [Frontend / Vite Proxy Failures](#9-frontend--vite-proxy-failures)
10. [Docker / Container Failures](#10-docker--container-failures)
11. [Data Loss (In-Memory DB Restart)](#11-data-loss-in-memory-db-restart)
12. [Escalation Matrix](#12-escalation-matrix)

---

## 1. General Triage

**When any incident is reported, start here.**

### Step 1 — Verify the health endpoint

```bash
curl -s http://localhost:3001/health | jq .
```

Expected response:

```json
{ "status": "OK", "timestamp": "2025-01-01T00:00:00.000Z" }
```

If the endpoint does not return `200 OK`, the backend process is down or unreachable. Proceed to [Section 3](#3-api--backend-errors).

### Step 2 — Check backend logs

```bash
# Development (nodemon)
# Logs are written to stdout; check the terminal running `npm run dev`

# Docker / Production
docker logs <container_name> --tail 200 --timestamps
```

### Step 3 — Check frontend availability

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:5173
# Expected: 200
```

### Step 4 — Classify severity

| Priority | Criteria | Response Target |
|----------|----------|-----------------|
| **P1** | Complete service outage; all users affected | 15 min acknowledge, 1 hr resolve |
| **P2** | Major feature broken (e.g., cannot create work entries); many users affected | 30 min acknowledge, 4 hrs resolve |
| **P3** | Minor feature degraded (e.g., CSV export broken); workaround exists | 4 hrs acknowledge, 24 hrs resolve |
| **P4** | Cosmetic / low-impact issue | Next business day |

---

## 2. Database Failures

### Symptoms

- API returns `500` with `"Database error"` message
- Backend logs show `SQLITE_` prefixed error codes
- Tables missing or schema not initialized

### Common Error Codes

| Error Code | Meaning |
|------------|---------|
| `SQLITE_BUSY` | Database is locked (concurrent writes) |
| `SQLITE_CORRUPT` | Database file is corrupted (production file-based mode) |
| `SQLITE_FULL` | Disk full (production file-based mode) |
| `SQLITE_CANTOPEN` | Cannot open database file (permissions / path issue) |
| `SQLITE_READONLY` | File or volume is read-only |

### Diagnosis

```bash
# Check if database singleton is initialized
curl -s http://localhost:3001/api/auth/me -H "x-user-email: test@test.com" | jq .

# In production (file-based SQLite), check the database file
ls -la /app/data/timesheet.db        # inside container
docker exec <container> ls -la /app/data/
```

### Resolution — Development (in-memory)

1. Restart the backend process; the in-memory database is re-created on startup:
   ```bash
   # If using nodemon, save any file to trigger restart, or:
   cd backend && npm run dev
   ```
2. Note: **all data will be lost** — this is expected for in-memory mode.

### Resolution — Production (file-based SQLite)

1. **SQLITE_CANTOPEN / permissions:**
   ```bash
   docker exec <container> ls -la /app/data/
   # Ensure the nodejs user (UID 1001) owns the data directory
   docker exec -u root <container> chown -R nodejs:nodejs /app/data
   ```

2. **SQLITE_FULL:**
   ```bash
   # Check disk usage
   docker exec <container> df -h /app/data
   # Free space or expand the volume, then restart
   docker restart <container>
   ```

3. **SQLITE_CORRUPT:**
   ```bash
   # Attempt recovery with sqlite3 CLI
   docker exec <container> sh -c "sqlite3 /app/data/timesheet.db '.recover' | sqlite3 /app/data/timesheet_recovered.db"
   docker exec <container> mv /app/data/timesheet_recovered.db /app/data/timesheet.db
   docker restart <container>
   ```
   If recovery fails, restore from the most recent backup (see your backup strategy).

4. **SQLITE_BUSY (locking):**
   - The application uses a singleton database connection, so this is rare.
   - Check for runaway queries or external processes accessing the file.
   - Restart the container to release locks.

---

## 3. API / Backend Errors

### Symptoms

- Health endpoint (`/health`) unreachable or returns non-200
- All API calls return connection errors or `502 Bad Gateway`
- Frontend shows network error banners

### Diagnosis

```bash
# Check if the Node.js process is running
ps aux | grep "node src/server.js"

# Check port binding
lsof -i :3001
# or
ss -tlnp | grep 3001

# Check backend logs for startup errors
# Docker:
docker logs <container> --tail 50
```

### Resolution

1. **Process not running / crashed on startup:**
   ```bash
   # Check startup logs for "Failed to start server" message
   cd backend && npm run dev
   # Or in Docker:
   docker restart <container>
   ```
   Common startup failures:
   - Port 3001 already in use → kill the other process or change `PORT` env var
   - Missing environment variables → verify `.env` file exists with required values
   - Database initialization failed → see [Section 2](#2-database-failures)

2. **Process running but unresponsive:**
   ```bash
   # Check for event loop blocking / high CPU
   top -p $(pgrep -f "node src/server.js")

   # Force restart
   kill -9 $(pgrep -f "node src/server.js")
   cd backend && npm run dev
   ```

3. **Validation errors (400 responses):**
   - Check request body matches Joi schemas defined in `backend/src/validation/schemas.js`
   - Email must be valid format; `hours` must be positive and ≤ 24; `date` must be ISO format

---

## 4. Authentication Failures

### Symptoms

- API returns `401 User email required in x-user-email header`
- API returns `400 Invalid email format`
- Frontend redirects to login page unexpectedly

### Diagnosis

```bash
# Test auth flow directly
curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}' | jq .

# Test authenticated request
curl -s http://localhost:3001/api/auth/me \
  -H "x-user-email: test@example.com" | jq .
```

### Resolution

1. **Missing `x-user-email` header:**
   - Frontend stores the email in `localStorage` under key `userEmail` and sends it via Axios interceptor.
   - Check browser DevTools → Application → Local Storage for the `userEmail` key.
   - Clear localStorage and re-login if the value is corrupt.

2. **User creation failing (500 on login):**
   - Database is likely down. See [Section 2](#2-database-failures).

3. **Unexpected 401 redirect loop:**
   - The Axios response interceptor clears `localStorage.userEmail` on any 401 and redirects to `/login`.
   - If the backend is returning 401 erroneously, check the `authenticateUser` middleware in `backend/src/middleware/auth.js`.

---

## 5. Memory Leaks & Resource Exhaustion

### Symptoms

- Backend becomes progressively slower over time
- Node.js process consumes increasing memory
- Out-of-memory (OOM) kills in Docker
- `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory`

### Diagnosis

```bash
# Check process memory
ps -o pid,rss,vsz,comm -p $(pgrep -f "node src/server.js")

# Docker stats
docker stats <container> --no-stream

# Check Node.js heap (if --inspect is enabled)
# Connect Chrome DevTools to node --inspect for heap snapshots
```

### Known Risk Areas

- **In-memory SQLite**: All data lives in process memory. Large datasets grow the heap unboundedly.
- **PDF generation (PDFKit)**: Generating large PDFs for clients with many work entries may spike memory.
- **CSV export temp files**: Written to `backend/temp/` directory. Leaked files consume disk.
- **Unclosed database callbacks**: The callback-based SQLite API can leak if error paths skip cleanup.

### Resolution

1. **Immediate relief — restart:**
   ```bash
   docker restart <container>
   # or
   kill $(pgrep -f "node src/server.js") && cd backend && npm run dev
   ```

2. **Set memory limits in Docker:**
   ```bash
   docker run --memory=512m --memory-swap=512m <image>
   ```

3. **Clean up temp files:**
   ```bash
   rm -f backend/temp/*.csv
   # In Docker:
   docker exec <container> rm -f /app/temp/*.csv
   ```

4. **For production**, switch from in-memory SQLite to file-based (already done in Docker override) and monitor with:
   ```bash
   docker stats --format "table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}"
   ```

---

## 6. Dependency / npm Failures

### Symptoms

- `npm install` fails with network or resolution errors
- `MODULE_NOT_FOUND` errors at runtime
- Native module build failures (e.g., `sqlite3` requires node-gyp)

### Diagnosis

```bash
# Check Node.js version (requires 18+)
node -v

# Check for native module issues
cd backend && npm ls sqlite3

# Verify lockfile integrity
npm ci --dry-run
```

### Resolution

1. **Network errors during install:**
   ```bash
   npm cache clean --force
   npm install --prefer-offline
   ```

2. **sqlite3 native module build failure:**
   ```bash
   # Ensure build tools are installed
   # Ubuntu/Debian:
   sudo apt-get install -y build-essential python3
   # Alpine (Docker):
   apk add --no-cache make gcc g++ python3

   cd backend && npm rebuild sqlite3
   ```

3. **Lockfile out of sync:**
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```

4. **Wrong Node.js version:**
   ```bash
   # Use nvm to switch
   nvm install 20
   nvm use 20
   ```

---

## 7. Report Generation Failures (PDF/CSV)

### Symptoms

- CSV or PDF export endpoints return 500
- Downloaded files are empty or corrupted
- `Error creating CSV` or `Error generating PDF` in backend logs

### Diagnosis

```bash
# Test CSV export
curl -s -o /dev/null -w "%{http_code}" \
  http://localhost:3001/api/reports/export/csv/1 \
  -H "x-user-email: test@example.com"

# Check temp directory permissions
ls -la backend/temp/ 2>/dev/null || echo "temp dir does not exist"

# Check disk space
df -h .
```

### Resolution

1. **Temp directory missing or not writable:**
   ```bash
   mkdir -p backend/temp
   chmod 755 backend/temp
   ```

2. **Disk full:**
   ```bash
   # Clean old temp files
   find backend/temp -name "*.csv" -mmin +60 -delete
   # Free disk space
   ```

3. **PDFKit crash on large reports:**
   - If a client has thousands of entries, the PDF may exceed memory.
   - Implement pagination or set a max export limit as a long-term fix.

4. **Client not found (404):**
   - Verify the `clientId` exists and belongs to the authenticated user.

---

## 8. Rate Limiting Issues

### Symptoms

- API returns `429 Too Many Requests`
- Legitimate users blocked after high activity
- Automated scripts / integrations fail

### Diagnosis

```bash
# Current rate limit: 100 requests per 15 minutes per IP
# Check response headers for rate limit info
curl -v http://localhost:3001/health 2>&1 | grep -i "ratelimit\|retry-after"
```

### Resolution

1. **Temporary relief** — restart the backend to reset rate limit counters (in-memory store):
   ```bash
   docker restart <container>
   ```

2. **Adjust limits** — modify `backend/src/server.js`:
   ```javascript
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 200  // increase limit
   });
   ```

3. **For API integrations**, consider exempting internal IPs or adding an API key bypass.

---

## 9. Frontend / Vite Proxy Failures

### Symptoms

- Frontend loads but API calls fail with CORS or network errors
- `ERR_CONNECTION_REFUSED` in browser console
- Login works but data doesn't load

### Diagnosis

```bash
# Check if Vite dev server is running
lsof -i :5173

# Check if backend is reachable from Vite proxy
curl -s http://localhost:3001/health

# Check CORS configuration
curl -v -X OPTIONS http://localhost:3001/api/clients \
  -H "Origin: http://localhost:5173" 2>&1 | grep -i "access-control"
```

### Resolution

1. **Backend not running:**
   - Start the backend first: `cd backend && npm run dev`
   - Then start the frontend: `cd frontend && npm run dev`

2. **CORS misconfiguration:**
   - Verify `FRONTEND_URL` in `backend/.env` matches the frontend origin (`http://localhost:5173`).
   - The Vite dev server proxies `/api` to the backend, so CORS should not typically be an issue in development.

3. **Vite proxy not configured:**
   - Check `frontend/vite.config.ts` for proxy configuration forwarding `/api` to `http://localhost:3001`.

---

## 10. Docker / Container Failures

### Symptoms

- Container exits immediately after starting
- Health check fails repeatedly
- Container runs but app is inaccessible

### Diagnosis

```bash
# Check container status
docker ps -a | grep timesheet

# Check container logs
docker logs <container> --tail 100

# Check health check status
docker inspect <container> | jq '.[0].State.Health'

# Check resource usage
docker stats <container> --no-stream
```

### Resolution

1. **Container exits on start:**
   - Check logs for startup errors (database init, port conflicts, missing env vars).
   - Ensure required environment variables are set:
     ```bash
     docker run -e NODE_ENV=production -e PORT=3001 -e DATABASE_PATH=/app/data/timesheet.db <image>
     ```

2. **Health check failing:**
   - The health check runs: `node -e "require('http').get('http://localhost:3001/health', ...)"` every 30 seconds.
   - If the app takes longer than 5 seconds to start, increase `--start-period`.

3. **Data directory permissions:**
   ```bash
   # Ensure /app/data is writable by UID 1001 (nodejs user)
   docker exec -u root <container> chown -R 1001:1001 /app/data
   ```

4. **Volume not mounted:**
   ```bash
   docker run -v timesheet-data:/app/data <image>
   ```

---

## 11. Data Loss (In-Memory DB Restart)

### Symptoms

- All clients, work entries, and user data disappear
- Users report being logged out and data missing after a server restart

### Context

In development mode, the application uses an **in-memory SQLite database** (`':memory:'`). All data is lost when the Node.js process restarts. This is by design for development, but can be surprising.

### Resolution

1. **Development** — this is expected behavior. Inform users that development mode does not persist data.

2. **Production** — ensure the Docker deployment uses file-based SQLite:
   - Verify `DATABASE_PATH=/app/data/timesheet.db` is set
   - Verify the data volume is mounted: `-v timesheet-data:/app/data`
   - The Docker override at `docker/overrides/database/init.js` handles this automatically

3. **Backups** (production):
   ```bash
   # Backup the SQLite database
   docker exec <container> sqlite3 /app/data/timesheet.db ".backup /app/data/backup_$(date +%Y%m%d).db"

   # Copy backup out of container
   docker cp <container>:/app/data/backup_$(date +%Y%m%d).db ./backups/
   ```

---

## 12. Escalation Matrix

| Level | Who | When |
|-------|-----|------|
| **L1 — On-call engineer** | First responder | Initial triage, restart services, apply known fixes from this runbook |
| **L2 — Backend team** | Application developers | Database corruption, code-level bugs, schema issues |
| **L3 — Infrastructure / DevOps** | Platform team | Docker/container issues, volume/disk problems, network configuration |
| **L4 — Security team** | Security engineers | Authentication bypass, rate limit evasion, data exposure |

### Communication Channels

- **P1/P2**: Immediately notify the on-call channel and create a GitHub Issue using the incident template.
- **P3/P4**: Create a GitHub Issue using the appropriate incident template.
- **Post-incident**: Conduct a blameless post-mortem within 48 hours for P1/P2 incidents.
