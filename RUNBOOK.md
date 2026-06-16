# Timesheet Application Runbook

## Overview

The Timesheet App is a full-stack web application for tracking employee hourly work across clients.

**Architecture:**
- **Backend:** Node.js / Express server on port 3001 (`backend/src/server.js`)
- **Frontend:** React (TypeScript, Vite) — in dev on port 5173, in Docker served as static files
- **Database:** SQLite — in-memory by default, file-based (`/app/data/timesheet.db`) in Docker
- **Deployment:** Docker with `dumb-init`, non-root `nodejs` user
- **Health endpoint:** `GET /health` returns `{ status: "OK", timestamp }` (see `backend/src/server.js` line 40)

---

## Prerequisites

### Tools
- `curl` (HTTP diagnostics)
- `node` v20+ (local runs)
- `docker` / `docker compose` (container deployment)
- `sqlite3` CLI (database inspection)

### Access
- Shell access to the host running the container
- Read access to application logs (`docker logs`)

### Environment Variables
| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Express listen port |
| `NODE_ENV` | `development` | `production` in Docker |
| `JWT_SECRET` | *(set in .env)* | Secret for signing JWT tokens |
| `DATABASE_PATH` | `:memory:` | SQLite path; `/app/data/timesheet.db` in Docker |
| `FRONTEND_URL` | `http://localhost:5173` | Allowed CORS origin |

---

## Failure Mode 1: Database Unavailable / Corruption

### Symptoms
- 500 errors on all data endpoints (`/api/clients`, `/api/work-entries`, etc.)
- `SQLITE_CANTOPEN` or `SQLITE_CORRUPT` in logs
- Health check (`/health`) may still return 200 (it does not query the DB)

### Diagnosis
1. **Check health endpoint:**
   ```bash
   curl -s http://localhost:3001/health | jq .
   ```
2. **Check container logs for DB errors:**
   ```bash
   docker logs <container> 2>&1 | grep -i "Error opening database"
   ```
   The error originates from `backend/src/database/init.js` lines 15-17 (dev) or `docker/overrides/database/init.js` lines 25-28 (Docker).
3. **Check if DB file exists (Docker / file-based mode):**
   ```bash
   docker exec <container> ls -la /app/data/timesheet.db
   docker exec <container> sqlite3 /app/data/timesheet.db "PRAGMA integrity_check;"
   ```
   File-based path setup: `docker/overrides/database/init.js` lines 18-23.

### Resolution
- **In-memory mode (dev):** Restart the server. Data is ephemeral (see `README.md` line 9).
  ```bash
  # Local dev
  cd backend && npm run dev
  ```
- **File-based mode (Docker):**
  1. Check volume mount: `docker inspect <container> | jq '.[0].Mounts'`
  2. Check disk space: `df -h` on the host
  3. Restore from backup if available
  4. If corrupted, attempt recovery:
     ```bash
     sqlite3 /app/data/timesheet.db ".dump" > dump.sql
     mv /app/data/timesheet.db /app/data/timesheet.db.corrupt
     sqlite3 /app/data/timesheet.db < dump.sql
     ```

### Prevention
- Use file-based SQLite in production (set `DATABASE_PATH`)
- Set up regular backups of `/app/data/timesheet.db`
- Monitor disk space on the Docker volume

---

## Failure Mode 2: API Errors / 500 Internal Server Error

### Symptoms
- Clients receiving 500 responses
- Error middleware triggered (see `backend/src/middleware/errorHandler.js`)

### Diagnosis
1. **Check morgan access logs** (combined format, `server.js` line 33):
   ```bash
   docker logs <container> 2>&1 | grep "\" 500 "
   ```
2. **Look for "Database error:" log lines** in route handlers (e.g., `backend/src/routes/clients.js` line 44):
   ```bash
   docker logs <container> 2>&1 | grep "Database error:"
   ```
3. **Check for Joi validation errors** (400s). The error handler at `backend/src/middleware/errorHandler.js` lines 5-9 formats Joi errors. Verify request payloads against schemas in `backend/src/validation/schemas.js`.

### Resolution
- **Joi validation errors (400):** Fix the client request payload to match the schema.
- **Database errors (500):** Follow [Failure Mode 1](#failure-mode-1-database-unavailable--corruption).
- **PDF/CSV generation failures:** Check temp directory permissions and disk space. CSV writes to `backend/temp/` (see `backend/src/routes/reports.js` lines 106-112). PDF is streamed via PDFKit (lines 187-240).
  ```bash
  docker exec <container> ls -la /app/backend/temp/
  docker exec <container> df -h /app
  ```

### Prevention
- Monitor error rates via logs
- Add structured logging (e.g., JSON log format)
- Set up alerting on 5xx spikes

---

## Failure Mode 3: Rate Limiting / 429 Too Many Requests

### Symptoms
- Users locked out
- 429 responses from the server

### Diagnosis
The global rate limiter is configured at `backend/src/server.js` lines 26-29:
```js
windowMs: 15 * 60 * 1000, // 15 minutes
max: 100                   // per IP
```
Check if the client IP is hitting the limit:
```bash
docker logs <container> 2>&1 | grep "429"
```

### Resolution
- **Wait** for the 15-minute window to expire.
- **Restart the server** to reset in-memory rate limit counters:
  ```bash
  docker restart <container>
  ```

### Prevention
- Adjust `windowMs` and `max` values in `server.js` for your expected traffic
- Consider adding Redis-backed rate limiting for production (preserves counters across restarts and supports distributed deployments)

---

## Failure Mode 4: Authentication Failures

### Symptoms
- 401 responses
- Users unable to log in
- Error message: `"User email required in x-user-email header"`

### Diagnosis
1. **Check that `x-user-email` header is being sent.** The auth middleware requires it (`backend/src/middleware/auth.js` lines 7-8):
   ```bash
   curl -v http://localhost:3001/api/clients 2>&1 | grep "< HTTP"
   # Should return 401 without header
   curl -H "x-user-email: user@test.com" http://localhost:3001/api/clients
   ```
2. **Verify email format validation** (`auth.js` lines 12-13). Invalid emails return 400.
3. **Check frontend localStorage** for `userEmail` key. The Axios interceptor reads it at `frontend/src/api/client.ts` lines 20-26.

### Resolution
- **Client-side:** Clear browser localStorage and re-login.
  ```js
  localStorage.clear(); // in browser console
  ```
- **Server-side:** If the DB lookup at `auth.js` line 20 fails, follow [Failure Mode 1](#failure-mode-1-database-unavailable--corruption).

### Prevention
- Monitor auth error rates
- Consider adding SSO integration for production

---

## Failure Mode 5: Memory Exhaustion / OOM

### Symptoms
- Container killed (`OOMKilled`)
- Node.js heap out of memory errors
- Slow responses, increasing latency

### Diagnosis
1. **Check OOMKilled status:**
   ```bash
   docker inspect <container> | jq '.[0].State.OOMKilled'
   ```
2. **Monitor Node.js heap:**
   ```bash
   docker exec <container> node -e "console.log(process.memoryUsage())"
   ```
3. **Check for large PDF exports.** PDFKit creates in-memory documents (`backend/src/routes/reports.js` lines 187-240). Large datasets can cause high memory usage.
4. **Check for orphaned temp CSV files** (`reports.js` lines 103-136):
   ```bash
   docker exec <container> ls -la /app/backend/temp/
   ```

### Resolution
1. **Restart the container:**
   ```bash
   docker restart <container>
   ```
2. **Clean temp directory:**
   ```bash
   docker exec <container> rm -f /app/backend/temp/*.csv
   ```
3. **Increase heap limit:**
   ```bash
   # In Dockerfile CMD or docker-compose
   node --max-old-space-size=512 src/server.js
   ```

### Prevention
- Set Docker memory limits (`docker run --memory=512m`)
- Add pagination to report exports for large datasets
- Implement temp file cleanup on startup
- Monitor container memory usage

---

## Failure Mode 6: Docker / Container Failures

### Symptoms
- Container won't start
- Health check failing
- Volume mount issues

### Diagnosis
1. **Check Docker health check.** It hits `http://localhost:3001/health` (`docker/Dockerfile` lines 68-69):
   ```bash
   docker inspect <container> | jq '.[0].State.Health'
   ```
2. **Check container logs:**
   ```bash
   docker logs <container> --tail 50
   ```
3. **Verify volume mount for `/app/data`:**
   ```bash
   docker inspect <container> | jq '.[0].Mounts'
   ```

### Resolution
- **Native module issues (`sqlite3`):** Rebuild the image. The `sqlite3` npm package includes native bindings that must match the container OS.
  ```bash
  docker build --no-cache -f docker/Dockerfile -t timesheet-app .
  ```
- **Permission issues:** The Dockerfile creates a `nodejs` user (UID 1001) at lines 38-39 and a data directory at line 54. Ensure the volume is writable:
  ```bash
  docker exec <container> id
  # Should show uid=1001(nodejs)
  sudo chown -R 1001:1001 /path/to/host/volume
  ```
- **Signal handling:** The container uses `dumb-init` (Dockerfile line 72) for proper PID 1 signal forwarding. If the container doesn't stop gracefully, check the entrypoint.

### Prevention
- Pin base image versions (currently `node:20-alpine`)
- Test builds in CI
- Use named Docker volumes for `/app/data`

---

## Failure Mode 7: Frontend Unreachable

### Symptoms
- Blank page in browser
- 404 on frontend routes
- API works but UI doesn't load

### Diagnosis
- **Docker (production):** Frontend is served as static files from `/app/public` (Dockerfile line 51). Verify the build output was copied correctly:
  ```bash
  docker exec <container> ls -la /app/public/
  docker exec <container> ls /app/public/index.html
  ```
- **Development:** Check that Vite dev server is running on port 5173:
  ```bash
  curl -s http://localhost:5173/ | head -5
  ```

### Resolution
1. **Rebuild frontend:**
   ```bash
   cd frontend && npm run build
   ```
2. **Verify CORS config** matches `FRONTEND_URL` env var (`server.js` line 21):
   ```bash
   echo $FRONTEND_URL
   # Should match the origin the browser is using
   ```
3. **Docker rebuild:**
   ```bash
   docker build -f docker/Dockerfile -t timesheet-app .
   docker restart <container>
   ```

### Prevention
- CI/CD build verification step
- Smoke tests for frontend routes after deploy
- Monitor for 404 errors on expected routes

---

## Escalation Matrix

| Priority | Description | Response Time | Action |
|----------|-------------|---------------|--------|
| **P1 — Critical** | Service down, data loss, security breach | Page on-call immediately | All hands, war room |
| **P2 — Major** | Significant degradation, major feature unavailable | Notify team within 1 hour | Investigate and mitigate |
| **P3 — Minor** | Partial degradation, workaround available | Address within business day | Schedule fix |
| **P4 — Low** | Cosmetic issue, minor inconvenience | Backlog | Prioritize in next sprint |

---

## Useful Commands

### Quick Diagnostics
```bash
# Health check
curl -s http://localhost:3001/health | jq .

# Container status
docker ps --filter name=timesheet
docker inspect <container> | jq '.[0].State'

# Recent logs
docker logs <container> --tail 100

# Error grep
docker logs <container> 2>&1 | grep -E "(Error|SQLITE_|500|error)"

# Resource usage
docker stats <container> --no-stream
```

### Database
```bash
# Check DB integrity (file-based)
docker exec <container> sqlite3 /app/data/timesheet.db "PRAGMA integrity_check;"

# List tables
docker exec <container> sqlite3 /app/data/timesheet.db ".tables"

# Count records
docker exec <container> sqlite3 /app/data/timesheet.db "SELECT 'users', COUNT(*) FROM users UNION ALL SELECT 'clients', COUNT(*) FROM clients UNION ALL SELECT 'work_entries', COUNT(*) FROM work_entries;"

# Backup
docker exec <container> sqlite3 /app/data/timesheet.db ".backup /app/data/timesheet_backup.db"
```

### API Smoke Tests
```bash
# Login
curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com"}' | jq .

# List clients (authenticated)
curl -s http://localhost:3001/api/clients \
  -H "x-user-email: test@test.com" | jq .

# Check rate limit headers
curl -s -I http://localhost:3001/health | grep -i "ratelimit"
```

### Container Management
```bash
# Restart
docker restart <container>

# Rebuild
docker build -f docker/Dockerfile -t timesheet-app .

# Shell into container
docker exec -it <container> /bin/sh

# Check disk space
docker exec <container> df -h /app/data
```
