# Timesheet Application — Incident Response Runbook

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Failure Mode 1: Database Failures](#failure-mode-1-database-failures)
- [Failure Mode 2: API / HTTP Errors](#failure-mode-2-api--http-errors)
- [Failure Mode 3: Memory Exhaustion](#failure-mode-3-memory-exhaustion)
- [Failure Mode 4: Dependency & Build Failures](#failure-mode-4-dependency--build-failures)
- [Failure Mode 5: Authentication & Authorization Issues](#failure-mode-5-authentication--authorization-issues)
- [Failure Mode 6: Report Generation Failures](#failure-mode-6-report-generation-failures)
- [Failure Mode 7: Frontend / Vite Proxy Failures](#failure-mode-7-frontend--vite-proxy-failures)
- [Failure Mode 8: Docker & Deployment Failures](#failure-mode-8-docker--deployment-failures)
- [General Diagnostics](#general-diagnostics)
- [Escalation Matrix](#escalation-matrix)
- [Post-Incident Review Checklist](#post-incident-review-checklist)

---

## Architecture Overview

```
┌──────────────┐      Vite proxy /api/*      ┌──────────────────┐
│   Frontend   │ ──────────────────────────►  │     Backend      │
│  React/Vite  │   http://localhost:5173      │  Express (3001)  │
│  Port 5173   │                              │                  │
└──────────────┘                              │  Middleware:      │
                                              │  - helmet         │
                                              │  - cors           │
                                              │  - rate-limit     │
                                              │  - morgan         │
                                              │  - auth (email)   │
                                              │                  │
                                              │  Routes:          │
                                              │  /health          │
                                              │  /api/auth/*      │
                                              │  /api/clients/*   │
                                              │  /api/work-entries│
                                              │  /api/reports/*   │
                                              └───────┬──────────┘
                                                      │
                                              ┌───────▼──────────┐
                                              │  SQLite (in-mem) │
                                              │  Singleton conn  │
                                              └──────────────────┘
```

**Key characteristics:**
- SQLite in-memory database — all data is lost on process restart.
- Email-only auth via `x-user-email` header — no passwords.
- Rate limiting: 100 requests per IP per 15-minute window.
- Request body limit: 10 MB.
- Temp files created during CSV export in `backend/temp/`.

---

## Failure Mode 1: Database Failures

### Symptoms
- HTTP 500 responses with `{"error": "Internal server error"}` or `{"error": "Database error"}`.
- `SQLITE_*` error codes in application logs.
- All data missing after a backend restart (expected behavior for in-memory mode).

### Diagnosis

```bash
# 1. Check backend logs for SQLITE_ errors
journalctl -u timesheet-backend --since "1 hour ago" | grep -i sqlite

# 2. Verify the backend process is running
pgrep -f "node src/server.js" || echo "Backend is NOT running"

# 3. Check if the health endpoint responds
curl -s http://localhost:3001/health | jq .

# 4. Test a database-touching endpoint
curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients | jq .
```

### Resolution

| Scenario | Action |
|---|---|
| **Backend crashed / restarted** | Data loss is expected with in-memory SQLite. Restart the server: `cd backend && npm run dev`. Users must re-enter data. |
| **SQLITE_BUSY / SQLITE_LOCKED** | The singleton connection may have a long-running transaction. Restart the backend process. |
| **Schema init failure** | Check `backend/src/database/init.js`. The `initializeDatabase()` function must complete before the server accepts requests. Look for errors in startup logs. |
| **SQLITE_CORRUPT** | In-memory DB corruption is rare. Restart the process to get a fresh database. |

### Prevention
- For production, switch from `:memory:` to a file-based SQLite path in `backend/src/database/init.js`.
- Add database health checks to the `/health` endpoint (see health check script).
- Implement automated backups for file-based databases.

---

## Failure Mode 2: API / HTTP Errors

### Symptoms
- HTTP 429 (Too Many Requests) — rate limit exceeded.
- HTTP 400 — validation errors from Joi.
- HTTP 404 — route not found or resource not found.
- HTTP 500 — unhandled server errors.
- CORS errors in browser console.

### Diagnosis

```bash
# 1. Check rate limiting status
# Default: 100 requests per IP per 15-minute window
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health

# 2. Test with verbose headers to see rate-limit info
curl -v http://localhost:3001/health 2>&1 | grep -i "x-ratelimit"

# 3. Check for CORS issues — verify FRONTEND_URL env var
grep FRONTEND_URL backend/.env

# 4. Review recent error logs
journalctl -u timesheet-backend --since "30 min ago" | grep -E "Error:|status.*[45][0-9]{2}"
```

### Resolution

| Scenario | Action |
|---|---|
| **429 Rate Limited** | Wait 15 minutes for the window to reset, or adjust the limit in `backend/src/server.js` (`max: 100`). |
| **400 Validation Error** | Check the `details` field in the response. Common: missing `name` for clients, invalid `email` format, `hours` > 24. |
| **CORS Blocked** | Ensure `FRONTEND_URL` in `backend/.env` matches the actual frontend origin (`http://localhost:5173` for dev). |
| **404 Route Not Found** | Verify the URL path matches one of: `/api/auth/*`, `/api/clients/*`, `/api/work-entries/*`, `/api/reports/*`, `/health`. |
| **500 Internal Error** | Check backend logs for stack traces. Common causes: database errors, missing dependencies. |

### Prevention
- Monitor HTTP status code distribution.
- Set up alerts on elevated 5xx rates.
- Keep `FRONTEND_URL` in sync with the actual frontend deployment URL.

---

## Failure Mode 3: Memory Exhaustion

### Symptoms
- Backend process killed by OOM killer.
- Increasing response latency over time.
- Node.js `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed` in logs.
- Large temp files accumulating in `backend/temp/`.

### Diagnosis

```bash
# 1. Check Node.js process memory usage
ps aux | grep "node src/server.js" | awk '{print $6 " KB"}'

# 2. Check for orphan temp files from CSV exports
du -sh backend/temp/ 2>/dev/null
ls -la backend/temp/ 2>/dev/null

# 3. Check system memory
free -h

# 4. Check for OOM kills in system logs
dmesg | grep -i "oom\|killed" | tail -5
```

### Resolution

| Scenario | Action |
|---|---|
| **Growing memory usage** | Restart the backend process. The in-memory SQLite DB grows with data and is never trimmed. |
| **Temp file accumulation** | CSV export creates temp files in `backend/temp/`. If cleanup fails, manually remove: `rm -f backend/temp/*.csv`. |
| **OOM kill** | Increase container/VM memory, or set Node.js heap limit: `node --max-old-space-size=512 src/server.js`. |
| **Large request bodies** | The 10 MB body limit (`express.json({ limit: '10mb' })`) can cause spikes. Lower if not needed. |

### Prevention
- Set Node.js `--max-old-space-size` to a safe limit.
- Add a cron job to clean up `backend/temp/` files older than 1 hour.
- Monitor process RSS memory and alert above a threshold.
- For production, use file-based SQLite to avoid keeping all data in process memory.

---

## Failure Mode 4: Dependency & Build Failures

### Symptoms
- `npm install` fails with native module build errors (especially `sqlite3`).
- Frontend build (`tsc -b && vite build`) fails with TypeScript errors.
- `MODULE_NOT_FOUND` errors at runtime.

### Diagnosis

```bash
# 1. Check Node.js version (requires 18+)
node -v

# 2. Verify native module build tools
which node-gyp || echo "node-gyp not found"
python3 --version
gcc --version

# 3. Check for missing dependencies
cd backend && npm ls --depth=0 2>&1 | grep "MISSING\|ERR"
cd frontend && npm ls --depth=0 2>&1 | grep "MISSING\|ERR"

# 4. Check for known vulnerabilities
cd backend && npm audit --production
cd frontend && npm audit --production
```

### Resolution

| Scenario | Action |
|---|---|
| **sqlite3 build failure** | Install build tools: `sudo apt-get install -y python3 make g++`. Then `cd backend && npm rebuild sqlite3`. |
| **Node version mismatch** | Use Node.js 18+. Install via nvm: `nvm install 18 && nvm use 18`. |
| **Lock file conflicts** | Delete `node_modules` and lockfile, reinstall: `rm -rf node_modules package-lock.json && npm install`. |
| **TypeScript build errors** | Run `cd frontend && npx tsc --noEmit` to see errors. Fix type issues before building. |
| **Critical npm audit findings** | Run `npm audit fix`. For breaking changes: `npm audit fix --force` (test thoroughly). |

### Prevention
- Pin Node.js version in `.nvmrc` or `engines` field.
- Run `npm audit` in CI (already configured in `sast-scan.yml`).
- Keep dependencies updated with automated PRs (Dependabot/Renovate).

---

## Failure Mode 5: Authentication & Authorization Issues

### Symptoms
- HTTP 401 `{"error": "User email required in x-user-email header"}`.
- HTTP 400 `{"error": "Invalid email format"}`.
- Users seeing other users' data (data isolation breach).
- Frontend redirect loop to `/login`.

### Diagnosis

```bash
# 1. Verify auth middleware works
curl -s http://localhost:3001/api/clients
# Expected: 401

curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients
# Expected: 200 with client list

# 2. Check if the email header is being forwarded through the proxy
# In browser DevTools > Network > check request headers for x-user-email

# 3. Verify JWT_SECRET is set (used in some login flows)
grep JWT_SECRET backend/.env
```

### Resolution

| Scenario | Action |
|---|---|
| **Missing email header** | Frontend must include `x-user-email` header via Axios interceptor. Check `frontend/src/api/client.ts`. Verify `localStorage.getItem('userEmail')` returns a value. |
| **Data isolation breach** | All queries filter by `user_email`. Verify the `WHERE user_email = ?` clause exists in every data-access query. |
| **Frontend login redirect loop** | Clear `localStorage` in the browser, then log in again. Check Axios response interceptor for 401 handling. |

### Prevention
- Audit all database queries for proper `user_email` filtering.
- Add integration tests for cross-user data access.
- For production, replace email-only auth with SSO or password-based auth.

---

## Failure Mode 6: Report Generation Failures

### Symptoms
- CSV export returns 500 or times out.
- PDF export returns empty/corrupted files.
- Disk space errors when generating reports.

### Diagnosis

```bash
# 1. Check temp directory permissions and space
ls -la backend/temp/ 2>/dev/null
df -h .

# 2. Test report endpoint directly
curl -s -H "x-user-email: test@example.com" \
  http://localhost:3001/api/reports/client/1 | jq .

# 3. Test CSV export
curl -s -o /dev/null -w "%{http_code}" \
  -H "x-user-email: test@example.com" \
  http://localhost:3001/api/reports/export/csv/1

# 4. Check for pdfkit/csv-writer errors in logs
journalctl -u timesheet-backend --since "30 min ago" | grep -iE "pdf|csv|report"
```

### Resolution

| Scenario | Action |
|---|---|
| **Temp directory missing** | The app auto-creates `backend/temp/`. If permissions deny it: `mkdir -p backend/temp && chmod 755 backend/temp`. |
| **Disk full** | Clear old temp files: `rm -f backend/temp/*.csv`. Free disk space. |
| **PDF stream errors** | PDFKit streams directly to the response. Check that the client isn't disconnecting early. |
| **Invalid client ID** | Verify the client exists and belongs to the authenticated user. |

### Prevention
- Add automated cleanup of `backend/temp/` (e.g., cron or application-level TTL).
- Set disk space alerts.
- Stream PDF/CSV directly to the response without temp files where possible.

---

## Failure Mode 7: Frontend / Vite Proxy Failures

### Symptoms
- Frontend loads but API calls fail with network errors.
- `502 Bad Gateway` from Vite dev server.
- CORS errors despite correct backend configuration.
- Blank page or React rendering errors.

### Diagnosis

```bash
# 1. Verify Vite dev server is running
pgrep -f "vite" || echo "Vite is NOT running"

# 2. Verify backend is reachable from the proxy target
curl -s http://localhost:3001/health

# 3. Check Vite proxy configuration
cat frontend/vite.config.ts

# 4. Check frontend .env
cat frontend/.env

# 5. Check browser console for errors (use browser DevTools)
```

### Resolution

| Scenario | Action |
|---|---|
| **Vite proxy 502** | Backend is not running or not reachable at `http://localhost:3001`. Start the backend first. |
| **Wrong proxy target** | Update `frontend/vite.config.ts` proxy target to match the backend's actual host/port. |
| **Build failures** | Run `cd frontend && npm run build` to check for TypeScript errors. Fix before deploying. |
| **Blank page** | Check browser console. Common: missing env vars, JS bundle errors, or React hydration issues. |

### Prevention
- Start backend before frontend in development.
- Use a process manager (e.g., `concurrently`, Docker Compose) to start both services.
- Add frontend error boundary components for graceful error display.

---

## Failure Mode 8: Docker & Deployment Failures

### Symptoms
- Container fails to start or exits immediately.
- Port binding errors.
- Environment variable misconfiguration.

### Diagnosis

```bash
# 1. Check container status
docker ps -a | grep timesheet

# 2. View container logs
docker logs <container_id> --tail 50

# 3. Check port bindings
docker port <container_id>
netstat -tlnp | grep -E "3001|5173"

# 4. Verify environment variables in container
docker exec <container_id> env | grep -E "PORT|NODE_ENV|FRONTEND_URL|JWT"
```

### Resolution

| Scenario | Action |
|---|---|
| **Port already in use** | `lsof -i :3001` to find the conflicting process. Kill it or use a different port. |
| **Container exits immediately** | Check `docker logs`. Usually a missing env var or failed DB init. |
| **Env var misconfiguration** | Verify `.env` or Docker Compose environment section. `FRONTEND_URL` must match the actual frontend URL. |
| **Docker build failure** | Check `docker/Dockerfile`. Ensure the base image has the required Node.js version. |

### Prevention
- Use Docker Compose health checks.
- Store deployment config in version control.
- Use environment-specific override files in `docker/overrides/`.

---

## General Diagnostics

### Quick Health Check

```bash
# Run the bundled health check script
./scripts/healthcheck.sh

# Or check manually:
curl -sf http://localhost:3001/health && echo "Backend OK" || echo "Backend DOWN"
curl -sf http://localhost:5173/ && echo "Frontend OK" || echo "Frontend DOWN"
```

### Log Locations

| Component | Location |
|---|---|
| Backend (dev) | stdout/stderr (morgan `combined` format) |
| Backend (systemd) | `journalctl -u timesheet-backend` |
| Backend (Docker) | `docker logs <container>` |
| Frontend (dev) | Vite terminal output |
| CI/CD | GitHub Actions workflow runs |

### Key Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3001` | Backend listen port |
| `NODE_ENV` | No | — | `development` or `production` |
| `FRONTEND_URL` | Yes | `http://localhost:5173` | Allowed CORS origin |
| `JWT_SECRET` | Yes | — | Secret for JWT signing |

---

## Escalation Matrix

| Severity | Response Time | Who to Contact | Examples |
|---|---|---|---|
| **P1 — Critical** | 15 min | On-call engineer + Engineering lead | Full outage, data loss, security breach |
| **P2 — High** | 1 hour | On-call engineer | Major feature broken, auth failures for all users |
| **P3 — Medium** | 4 hours | Assigned team | Single feature broken, report export failures |
| **P4 — Low** | Next business day | Backlog | UI cosmetic issues, minor performance degradation |

---

## Post-Incident Review Checklist

- [ ] Timeline documented (detection → diagnosis → resolution)
- [ ] Root cause identified
- [ ] Customer impact quantified (users affected, duration)
- [ ] Monitoring gap identified (how could we have detected sooner?)
- [ ] Action items created with owners and due dates
- [ ] Runbook updated if a new failure mode was encountered
- [ ] Incident report filed using the appropriate GitHub Issue template
