# Timesheet App — Incident Response Runbook

> **Audience**: On-call engineers and SREs  
> **Stack**: Node.js / Express backend (port 3001), React / Vite frontend (port 5173), SQLite database  
> **Health endpoint**: `GET /health` → `{ "status": "OK", "timestamp": "..." }`

---

## Table of Contents

1. [General Triage Procedure](#1-general-triage-procedure)
2. [FM-1: Database Connection / Initialization Failure](#fm-1-database-connection--initialization-failure)
3. [FM-2: In-Memory Data Loss on Restart](#fm-2-in-memory-data-loss-on-restart)
4. [FM-3: SQLite Lock / Busy Errors](#fm-3-sqlite-lock--busy-errors)
5. [FM-4: API 5xx Errors](#fm-4-api-5xx-errors)
6. [FM-5: Rate Limiting Exhaustion (HTTP 429)](#fm-5-rate-limiting-exhaustion-http-429)
7. [FM-6: Authentication / Header Misconfiguration](#fm-6-authentication--header-misconfiguration)
8. [FM-7: Memory Leaks — Unbounded In-Memory DB Growth](#fm-7-memory-leaks--unbounded-in-memory-db-growth)
9. [FM-8: Temp File Accumulation (CSV/PDF Exports)](#fm-8-temp-file-accumulation-csvpdf-exports)
10. [FM-9: Report Generation Failures (PDFKit / csv-writer)](#fm-9-report-generation-failures-pdfkit--csv-writer)
11. [FM-10: Dependency / Build Failures](#fm-10-dependency--build-failures)
12. [FM-11: Frontend ↔ Backend Connectivity (Vite Proxy)](#fm-11-frontend--backend-connectivity-vite-proxy)
13. [FM-12: Docker / Container Health Failures](#fm-12-docker--container-health-failures)
14. [FM-13: CORS Misconfiguration](#fm-13-cors-misconfiguration)

---

## 1. General Triage Procedure

Use this for **every** incident before diving into a specific failure mode.

```
1. Acknowledge the alert within SLA (P1: 5 min, P2: 15 min, P3: 1 hr, P4: 1 business day).
2. Check the health endpoint:
     curl http://localhost:3001/health
3. Check process status:
     # Bare-metal
     ps aux | grep "node src/server.js"
     # Docker
     docker compose ps
4. Tail logs:
     # Bare-metal (stdout/stderr)
     journalctl -u timesheet-backend -f   # or pm2 logs
     # Docker
     docker compose logs -f --tail=200 backend
5. Identify the failure mode from the sections below.
6. Follow the specific resolution steps.
7. Confirm recovery via the health-check script:
     node scripts/health-check.js
8. File a post-incident issue using the appropriate template (.github/ISSUE_TEMPLATE/).
```

---

## FM-1: Database Connection / Initialization Failure

**Symptoms**: Server fails to start, logs show `Error opening database` or `Failed to start server`.

**Impact**: Complete service outage — no API requests can be served.

**Root cause**: SQLite file path is inaccessible (Docker volume mount missing, permissions), or the `sqlite3` native module failed to load.

### Resolution

```bash
# 1. Check if the sqlite3 module loads
node -e "require('sqlite3')"

# 2. If it fails, rebuild native bindings
cd backend && npm rebuild sqlite3

# 3. For Docker — verify the volume mount
docker compose config | grep -A5 volumes

# 4. Check file permissions (production file-based DB)
ls -la /data/timesheet.db          # path from DATABASE_PATH env var
chmod 664 /data/timesheet.db       # if permission denied

# 5. Restart the service
npm run start  # or docker compose restart backend
```

### Verification

```bash
curl http://localhost:3001/health
# Expected: {"status":"OK","timestamp":"..."}
```

---

## FM-2: In-Memory Data Loss on Restart

**Symptoms**: All user data disappears after a process restart or deployment.

**Impact**: Complete data loss (P1 if production uses in-memory mode).

**Root cause**: The default dev config uses `sqlite3.Database(':memory:')`. If `DATABASE_PATH` is not set in production, data lives only in process memory.

### Resolution

```bash
# 1. Confirm the database mode
echo $DATABASE_PATH            # should be a file path in production

# 2. If empty/unset, configure persistent storage
export DATABASE_PATH=/data/timesheet.db

# 3. For Docker, verify docker/overrides/database/init.js is used
#    and DATABASE_PATH is set in docker-compose environment

# 4. Restart with persistent storage
docker compose up -d backend
```

### Prevention

- Always set `DATABASE_PATH` in production environments.
- Add a startup check that warns if `:memory:` is used in `NODE_ENV=production`.
- Implement regular database backups for file-based SQLite.

---

## FM-3: SQLite Lock / Busy Errors

**Symptoms**: API returns `500` errors intermittently. Logs show `SQLITE_BUSY` or `SQLITE_LOCKED`.

**Impact**: Degraded service — write operations fail while reads may succeed.

**Root cause**: SQLite allows only one writer at a time. Concurrent write requests (especially under load) can exceed the default busy timeout.

### Resolution

```bash
# 1. Check for concurrent write load
# Look for SQLITE_BUSY in logs
grep -i "SQLITE_BUSY\|SQLITE_LOCKED" /var/log/timesheet/*.log

# 2. Temporary: reduce concurrent traffic
# The rate limiter (100 req/15 min per IP) should help, but check if
# multiple backend instances are sharing the same DB file

# 3. Confirm only ONE process writes to the DB
ps aux | grep "node.*server.js" | grep -v grep
# If more than one: stop extras

# 4. Restart the backend to clear any stuck locks
kill -SIGTERM <pid> && npm run start
```

### Prevention

- Ensure only one backend process writes to a given SQLite file.
- Consider adding `PRAGMA busy_timeout = 5000;` in `initializeDatabase()`.
- For high write concurrency, evaluate migrating to PostgreSQL.

---

## FM-4: API 5xx Errors

**Symptoms**: Clients receive `500 Internal Server Error` on various endpoints.

**Impact**: Partial or complete outage depending on scope.

**Root cause**: Unhandled exceptions in route handlers, database errors, or middleware failures.

### Resolution

```bash
# 1. Identify the failing endpoint(s)
# Check logs for "Database error:" or "Error:" prefixes
docker compose logs backend --tail=500 | grep -E "Error:|500"

# 2. Test each API route group
curl http://localhost:3001/health
curl -H "x-user-email: test@example.com" http://localhost:3001/api/auth/me
curl -H "x-user-email: test@example.com" http://localhost:3001/api/clients
curl -H "x-user-email: test@example.com" http://localhost:3001/api/work-entries

# 3. If DB-related errors, follow FM-1 / FM-3

# 4. If validation-related (Joi), check request payloads in logs

# 5. Restart if needed
npm run start  # or docker compose restart backend
```

### Escalation

If errors persist after restart and DB is healthy, check for recent code changes — roll back if necessary.

---

## FM-5: Rate Limiting Exhaustion (HTTP 429)

**Symptoms**: Legitimate users receive `429 Too Many Requests`.

**Impact**: Users unable to use the application; appears as downtime from their perspective.

**Root cause**: Rate limit is set to **100 requests per 15-minute window per IP**. Shared NAT/proxy environments may exhaust this quickly.

### Resolution

```bash
# 1. Identify affected IPs (check morgan combined logs)
docker compose logs backend --tail=1000 | grep " 429 "

# 2. Temporary: restart to clear rate-limit counters (in-memory store)
docker compose restart backend

# 3. Longer-term: adjust the limit in server.js
#    Current: windowMs: 15 * 60 * 1000, max: 100
#    Consider increasing max for trusted environments
```

### Prevention

- Use a persistent rate-limit store (e.g., `rate-limit-redis`) so restarts don't reset counters.
- Configure `express-rate-limit` to trust proxy headers if behind a reverse proxy (`app.set('trust proxy', 1)`).
- Set higher limits for authenticated users.

---

## FM-6: Authentication / Header Misconfiguration

**Symptoms**: All authenticated endpoints return `401 User email required in x-user-email header`.

**Impact**: Application unusable for all users.

**Root cause**: The frontend Axios interceptor reads `localStorage.getItem('userEmail')` and sets the `x-user-email` header. If localStorage is cleared, the header is missing.

### Resolution

```bash
# 1. Verify the frontend sends the header
# Open browser DevTools → Network → check request headers for x-user-email

# 2. Test directly
curl -H "x-user-email: test@example.com" http://localhost:3001/api/auth/me
# Should return user info, not 401

# 3. If the backend rejects valid emails, check the regex in auth.js:
#    /^[^\s@]+@[^\s@]+\.[^\s@]+$/

# 4. If the header is stripped by a reverse proxy, configure it to pass through
# Nginx example:
#   proxy_set_header x-user-email $http_x_user_email;
```

---

## FM-7: Memory Leaks — Unbounded In-Memory DB Growth

**Symptoms**: Backend process RSS grows steadily over time; eventual OOM kill.

**Impact**: Service crash when memory limit is reached.

**Root cause**: In-memory SQLite grows with data volume. No eviction or archival policy exists.

### Resolution

```bash
# 1. Check current memory usage
ps -o pid,rss,vsz,command -p $(pgrep -f "node.*server.js")

# 2. If RSS exceeds threshold (e.g., >512 MB), graceful restart
kill -SIGTERM <pid>
# Note: in-memory data is lost — see FM-2

# 3. Monitor with Docker
docker stats --no-stream timesheet-backend
```

### Prevention

- Use file-based SQLite in production (`DATABASE_PATH`).
- Set `--max-old-space-size` for the Node.js process.
- Add process memory monitoring (e.g., Prometheus `/metrics` endpoint).
- Implement data archival for old work entries.

---

## FM-8: Temp File Accumulation (CSV/PDF Exports)

**Symptoms**: Disk space fills up in the `backend/temp/` directory.

**Impact**: Subsequent exports fail; potential disk-full cascading failures.

**Root cause**: The CSV export route (`reports.js`) creates temp files and deletes them after download. If the download is interrupted or the cleanup callback fails, orphaned files remain.

### Resolution

```bash
# 1. Check temp directory
ls -la backend/temp/
du -sh backend/temp/

# 2. Clean orphaned files (older than 1 hour)
find backend/temp/ -type f -mmin +60 -delete

# 3. Verify disk space
df -h .
```

### Prevention

- Add a cron job or startup task to purge `backend/temp/*.csv` files older than 1 hour.
- Consider streaming CSV/PDF directly to the response instead of writing temp files.
- Set filesystem alerts for disk usage > 80%.

---

## FM-9: Report Generation Failures (PDFKit / csv-writer)

**Symptoms**: `/api/reports/export/pdf/:clientId` or `/api/reports/export/csv/:clientId` returns `500`.

**Impact**: Users cannot export reports; core feature degraded.

**Root cause**: PDFKit or csv-writer throws during generation (corrupt data, missing temp directory, out of memory for large reports).

### Resolution

```bash
# 1. Test export manually
curl -H "x-user-email: test@example.com" \
     http://localhost:3001/api/reports/export/csv/1 -o test.csv

# 2. Ensure temp directory exists and is writable
mkdir -p backend/temp && chmod 755 backend/temp

# 3. Check for very large datasets
curl -H "x-user-email: test@example.com" \
     http://localhost:3001/api/reports/client/1
# If entryCount is extremely large, the export may OOM

# 4. Check logs for specific error
docker compose logs backend | grep -i "csv\|pdf\|report"
```

### Prevention

- Add pagination / row limits for exports.
- Stream PDF/CSV generation instead of buffering in memory.
- Add try/catch with specific error messages in the export routes.

---

## FM-10: Dependency / Build Failures

**Symptoms**: `npm install` or `npm run build` fails. CI pipeline rejects PRs.

**Impact**: Cannot deploy new versions; development blocked.

**Root cause**: Breaking changes in dependencies, npm registry outage, or `sqlite3` native compilation failure.

### Resolution

```bash
# 1. Backend
cd backend
rm -rf node_modules package-lock.json
npm install

# 2. If sqlite3 fails to compile
npm rebuild sqlite3
# Or install pre-built binary
npm install sqlite3 --build-from-source

# 3. Frontend
cd frontend
rm -rf node_modules package-lock.json
npm install

# 4. Verify build
cd frontend && npm run build

# 5. Run tests
cd backend && npm test
```

### Prevention

- Pin exact dependency versions or use `package-lock.json` consistently.
- Run `npm audit` regularly and address vulnerabilities.
- Keep Node.js version consistent across dev/CI/production.

---

## FM-11: Frontend ↔ Backend Connectivity (Vite Proxy)

**Symptoms**: Frontend shows network errors; API calls fail with `ECONNREFUSED` or CORS errors in dev.

**Impact**: Application unusable in development.

**Root cause**: Vite dev server proxies `/api` to `http://localhost:3001`. If the backend is not running, all API calls fail.

### Resolution

```bash
# 1. Verify the backend is running
curl http://localhost:3001/health

# 2. If not running, start it
cd backend && npm run dev

# 3. Check the Vite proxy config (frontend/vite.config.ts)
#    target should match the backend port

# 4. Check the backend .env
cat backend/.env | grep FRONTEND_URL
# Should be http://localhost:5173 for dev

# 5. Restart both services
cd backend && npm run dev &
cd frontend && npm run dev &
```

---

## FM-12: Docker / Container Health Failures

**Symptoms**: `docker compose ps` shows containers as `unhealthy` or `restarting`.

**Impact**: Service outage in containerized environments.

**Root cause**: Health check fails, container crashes on startup, or volume mounts are misconfigured.

### Resolution

```bash
# 1. Check container status
docker compose ps

# 2. View logs for the failing container
docker compose logs backend --tail=100

# 3. Check health endpoint from inside the container
docker compose exec backend curl -f http://localhost:3001/health

# 4. Verify environment variables
docker compose exec backend env | grep -E "PORT|DATABASE_PATH|NODE_ENV|FRONTEND_URL"

# 5. Rebuild and restart
docker compose down
docker compose build --no-cache
docker compose up -d
```

---

## FM-13: CORS Misconfiguration

**Symptoms**: Browser console shows `Access-Control-Allow-Origin` errors. API calls fail from the frontend but succeed via `curl`.

**Impact**: Frontend cannot communicate with backend; application unusable.

**Root cause**: `FRONTEND_URL` env var does not match the actual frontend origin; or the production `cors({ origin: true })` setting is overridden.

### Resolution

```bash
# 1. Check current CORS origin config
cat backend/.env | grep FRONTEND_URL

# 2. For dev, ensure it matches Vite port
#    Expected: FRONTEND_URL=http://localhost:5173

# 3. Test CORS headers
curl -v -H "Origin: http://localhost:5173" http://localhost:3001/health 2>&1 | grep -i "access-control"

# 4. Update .env and restart
echo "FRONTEND_URL=http://localhost:5173" >> backend/.env
cd backend && npm run dev
```

---

## Appendix: Key File Locations

| Component | Path |
|---|---|
| Backend entry point | `backend/src/server.js` |
| Database initialization | `backend/src/database/init.js` |
| API routes | `backend/src/routes/{auth,clients,workEntries,reports}.js` |
| Auth middleware | `backend/src/middleware/auth.js` |
| Error handler | `backend/src/middleware/errorHandler.js` |
| Validation schemas | `backend/src/validation/schemas.js` |
| Frontend API client | `frontend/src/api/client.ts` |
| Vite proxy config | `frontend/vite.config.ts` |
| Docker overrides | `docker/overrides/` |
| Health check script | `scripts/health-check.js` |
| CI workflows | `.github/workflows/` |

## Appendix: Useful Commands Quick Reference

```bash
# Start dev (both services)
(cd backend && npm run dev) & (cd frontend && npm run dev)

# Run backend tests
cd backend && npm test

# Lint frontend
cd frontend && npm run lint

# Health check
curl http://localhost:3001/health

# Automated health check
node scripts/health-check.js

# Docker full restart
docker compose down && docker compose up -d --build
```
