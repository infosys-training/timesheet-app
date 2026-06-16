# Timesheet App — Incident Response Runbook

> **Last updated:** 2026-06-16
> **On-call rotation:** See your team's PagerDuty / Opsgenie schedule
> **Escalation path:** On-call engineer → Team Lead → Engineering Manager

---

## Table of Contents

1. [General Incident Response Process](#1-general-incident-response-process)
2. [FM-1: Application Crash / Process Exit](#fm-1-application-crash--process-exit)
3. [FM-2: Database Failure (SQLite)](#fm-2-database-failure-sqlite)
4. [FM-3: Data Loss on Restart (In-Memory DB)](#fm-3-data-loss-on-restart-in-memory-db)
5. [FM-4: API 5xx Errors](#fm-4-api-5xx-errors)
6. [FM-5: Authentication Failures](#fm-5-authentication-failures)
7. [FM-6: Rate Limiting Blocking Legitimate Users](#fm-6-rate-limiting-blocking-legitimate-users)
8. [FM-7: Memory Leak / OOM Kill](#fm-7-memory-leak--oom-kill)
9. [FM-8: PDF/CSV Export Failures](#fm-8-pdfcsv-export-failures)
10. [FM-9: CORS / Proxy Misconfiguration](#fm-9-cors--proxy-misconfiguration)
11. [FM-10: Disk Space Exhaustion](#fm-10-disk-space-exhaustion)
12. [FM-11: Docker Container Health Check Failures](#fm-11-docker-container-health-check-failures)
13. [FM-12: Dependency Vulnerability (npm)](#fm-12-dependency-vulnerability-npm)
14. [Diagnostic Commands Quick Reference](#diagnostic-commands-quick-reference)
15. [Contact & Escalation](#contact--escalation)

---

## 1. General Incident Response Process

Every incident follows this lifecycle:

```
DETECT → TRIAGE → MITIGATE → RESOLVE → POST-MORTEM
```

| Step       | Action                                                                 |
|------------|------------------------------------------------------------------------|
| **Detect** | Alert fires (health check, monitoring, or user report)                 |
| **Triage** | Assign severity (P1–P4), open a GitHub Issue using the incident template |
| **Mitigate** | Apply the quickest fix to restore service (may be a workaround)      |
| **Resolve** | Deploy a permanent fix                                                |
| **Post-mortem** | Document timeline, root cause, and action items within 48 hours  |

### Severity Definitions

| Level | Name     | Description                                    | Response Time | Update Cadence |
|-------|----------|------------------------------------------------|---------------|----------------|
| P1    | Critical | Service completely down, all users affected     | 15 min        | Every 30 min   |
| P2    | High     | Major feature broken, significant user impact   | 1 hour        | Every 2 hours  |
| P3    | Medium   | Minor feature degraded, workaround available    | 4 hours       | Daily          |
| P4    | Low      | Cosmetic / minor issue, no user impact          | 1 business day| As needed      |

---

## FM-1: Application Crash / Process Exit

**Severity:** P1 (if production) / P3 (if dev-only)

### Symptoms
- `/health` endpoint returns connection refused
- Docker container in `Exited` / `Restarting` state
- Logs show `Failed to start server:` or uncaught exception stack trace

### Diagnosis

```bash
# Check if process is running
docker ps -a --filter "name=timesheet"

# Check recent logs
docker logs --tail 200 timesheet-app

# Check for OOM kill
docker inspect timesheet-app | jq '.[0].State'
dmesg | grep -i "oom\|killed"
```

### Resolution

1. **Read the logs** — Identify the error (DB init failure, port conflict, missing env var).
2. **Fix the root cause:**
   - Port conflict → Change `PORT` env var or stop the conflicting process.
   - Missing env var → Verify `.env` is mounted / set. Required vars: `PORT`, `NODE_ENV`, `JWT_SECRET`, `DATABASE_PATH` (production).
   - DB init failure → See [FM-2](#fm-2-database-failure-sqlite).
3. **Restart:**
   ```bash
   docker restart timesheet-app
   # or, if running directly:
   npm start
   ```
4. **Verify:**
   ```bash
   curl -s http://localhost:3001/health | jq .
   # Expected: {"status":"OK","timestamp":"..."}
   ```

### Prevention
- Use `dumb-init` (already in Dockerfile) for proper signal handling.
- Run with a process manager (PM2, systemd) outside Docker for bare-metal deploys.
- Set `restart: unless-stopped` in `docker-compose.yml`.

---

## FM-2: Database Failure (SQLite)

**Severity:** P1

### Symptoms
- API returns `{"error":"Database error","message":"An error occurred while processing your request"}`
- Logs contain `SQLITE_BUSY`, `SQLITE_CORRUPT`, `SQLITE_CANTOPEN`, or `SQLITE_FULL`

### Diagnosis

```bash
# Check for SQLite errors in logs
docker logs timesheet-app 2>&1 | grep -i "sqlite\|database error"

# Check database file integrity (production with file-based DB)
sqlite3 /app/data/timesheet.db "PRAGMA integrity_check;"

# Check disk space for DB volume
df -h /app/data
```

### Resolution by Error Code

| Error              | Cause                            | Fix                                                |
|--------------------|----------------------------------|----------------------------------------------------|
| `SQLITE_BUSY`      | Concurrent write contention      | Enable WAL mode: `PRAGMA journal_mode=WAL;`        |
| `SQLITE_CORRUPT`   | DB file corrupted                | Restore from backup; if no backup, re-initialize   |
| `SQLITE_CANTOPEN`  | File path invalid or permissions | Check `DATABASE_PATH` env var; `chown nodejs:nodejs /app/data` |
| `SQLITE_FULL`      | Disk full                        | See [FM-10](#fm-10-disk-space-exhaustion)           |

### Recovery Steps

1. **If file-based DB is corrupt:**
   ```bash
   # Attempt recovery
   sqlite3 /app/data/timesheet.db ".recover" | sqlite3 /app/data/timesheet_recovered.db
   mv /app/data/timesheet.db /app/data/timesheet.db.corrupt
   mv /app/data/timesheet_recovered.db /app/data/timesheet.db
   docker restart timesheet-app
   ```
2. **If in-memory DB (dev mode):** Restart the server — DB is re-created on startup.

### Prevention
- Use file-based SQLite in production (`DATABASE_PATH=/app/data/timesheet.db`).
- Enable WAL mode in `init.js`: `database.run('PRAGMA journal_mode=WAL');`
- Set up automated backups: `sqlite3 /app/data/timesheet.db ".backup /backups/timesheet-$(date +%Y%m%d).db"`

---

## FM-3: Data Loss on Restart (In-Memory DB)

**Severity:** P1 (if production data lost) / P4 (if dev environment)

### Symptoms
- After server restart, all users, clients, and work entries are gone.
- Login returns `201 User created` for previously existing users.

### Diagnosis

```bash
# Confirm DB mode
docker exec timesheet-app env | grep DATABASE_PATH
# If empty or ":memory:", the app is using in-memory storage
```

### Resolution

1. **Immediate:** Data cannot be recovered from an in-memory DB after restart.
2. **Permanent fix:** Switch to file-based SQLite by setting `DATABASE_PATH`:
   ```bash
   # In docker-compose.yml or .env:
   DATABASE_PATH=/app/data/timesheet.db
   ```
3. **Verify the Docker volume is mounted:**
   ```yaml
   volumes:
     - timesheet-data:/app/data
   ```

### Prevention
- **Never** use in-memory SQLite in production.
- Mount a persistent Docker volume for `/app/data`.
- Implement automated DB backups (cron or scheduled GitHub Action).

---

## FM-4: API 5xx Errors

**Severity:** P2

### Symptoms
- Frontend shows generic error messages or loading spinners that never resolve.
- Monitoring reports elevated 500-status responses.

### Diagnosis

```bash
# Check recent error logs
docker logs --tail 500 timesheet-app 2>&1 | grep -E "Error:|500|SQLITE_"

# Test individual endpoints
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health
curl -s -o /dev/null -w "%{http_code}" -H "x-user-email: test@test.com" http://localhost:3001/api/clients
curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" \
  -d '{"email":"test@test.com"}' http://localhost:3001/api/auth/login
```

### Resolution

1. **Identify the failing route** from access logs (morgan `combined` format).
2. **Check the error handler output** — the middleware in `errorHandler.js` categorizes errors:
   - Joi validation → 400 (not a 5xx, but check if schema is too strict)
   - SQLite errors → 500 (see [FM-2](#fm-2-database-failure-sqlite))
   - Unhandled errors → 500 with generic message
3. **If validation schema is rejecting valid input**, review `backend/src/validation/schemas.js`.
4. **Restart if the DB connection is in a bad state:**
   ```bash
   docker restart timesheet-app
   ```

---

## FM-5: Authentication Failures

**Severity:** P2

### Symptoms
- Users cannot log in; `POST /api/auth/login` returns 500.
- Authenticated requests return `401 User email required`.
- Frontend redirects to `/login` repeatedly.

### Diagnosis

```bash
# Test login endpoint directly
curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}'

# Test authenticated endpoint
curl -s http://localhost:3001/api/auth/me \
  -H "x-user-email: test@example.com"

# Check if the users table exists
docker exec timesheet-app node -e "
  const {getDatabase} = require('./src/database/init');
  const db = getDatabase();
  db.all('SELECT name FROM sqlite_master WHERE type=\"table\"', (e,r) => console.log(r));
"
```

### Resolution

1. **If DB tables are missing:** The database was not initialized. Restart the app so `initializeDatabase()` runs.
2. **If login returns 500:** Check for DB write errors (see [FM-2](#fm-2-database-failure-sqlite)).
3. **If the frontend sends no `x-user-email` header:** Check `localStorage` in the browser:
   ```js
   // In browser console
   localStorage.getItem('userEmail')
   ```
   If `null`, the user's session was lost — they need to log in again.

### Prevention
- Monitor the `POST /api/auth/login` endpoint with synthetic checks.
- Consider adding session persistence (e.g., JWT with `httpOnly` cookies) to survive browser storage clears.

---

## FM-6: Rate Limiting Blocking Legitimate Users

**Severity:** P2

### Symptoms
- Users receive `429 Too Many Requests`.
- Legitimate automation or bulk operations fail.

### Diagnosis

```bash
# Check current rate limit config (in server.js)
# Default: 100 requests per 15 minutes per IP
grep -A3 "rateLimit" backend/src/server.js
```

### Resolution

1. **Temporary:** Increase the limit or reset the window by restarting the server.
2. **Permanent:** Adjust rate limit parameters in `server.js`:
   ```js
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 500  // increase from 100
   });
   ```
3. **If behind a reverse proxy:** Ensure `trust proxy` is set so rate limiting applies per real client IP:
   ```js
   app.set('trust proxy', 1);
   ```

---

## FM-7: Memory Leak / OOM Kill

**Severity:** P1

### Symptoms
- Container restarts unexpectedly.
- `dmesg` shows OOM killer activity.
- Response times degrade progressively over hours/days.

### Diagnosis

```bash
# Check container memory usage
docker stats timesheet-app --no-stream

# Check for OOM kills
dmesg | grep -i "oom\|killed"

# Node.js heap stats (attach debugger or add to health check)
node -e "console.log(process.memoryUsage())"
```

### Common Leak Sources in This App

| Source                                  | Mechanism                                       |
|-----------------------------------------|-------------------------------------------------|
| PDF generation (`pdfkit`)               | Large reports hold full document in memory       |
| CSV temp files not cleaned up           | `fs.unlink` fails silently, files accumulate     |
| SQLite statement handles not finalized  | Leaked DB handles consume memory                 |
| Unclosed event listeners on `morgan`    | Accumulate per-request if misconfigured          |

### Resolution

1. **Immediate:** Restart the container.
2. **Profile:** Run with `--inspect` flag and use Chrome DevTools to take heap snapshots:
   ```bash
   node --inspect=0.0.0.0:9229 src/server.js
   ```
3. **Set memory limits in Docker:**
   ```yaml
   deploy:
     resources:
       limits:
         memory: 512M
   ```
4. **Verify temp file cleanup:** Check `backend/temp/` for orphaned CSV files.

---

## FM-8: PDF/CSV Export Failures

**Severity:** P3

### Symptoms
- Export buttons return 500 or download empty/corrupt files.
- Logs show `Error creating CSV:` or `Error sending file:`.

### Diagnosis

```bash
# Test CSV export
curl -s -o /dev/null -w "%{http_code}" \
  -H "x-user-email: test@example.com" \
  http://localhost:3001/api/reports/export/csv/1

# Check temp directory permissions
ls -la backend/temp/ 2>/dev/null || echo "temp dir does not exist"

# Check disk space
df -h .
```

### Resolution

1. **Temp dir missing:** Create it — `mkdir -p backend/temp` (the app tries to create it, but permissions may block this in containers).
2. **Disk full:** See [FM-10](#fm-10-disk-space-exhaustion).
3. **Large report timeout:** If reports with many entries time out, consider paginating the query or streaming the response.
4. **PDF rendering error:** Check `pdfkit` version compatibility: `npm ls pdfkit`.

---

## FM-9: CORS / Proxy Misconfiguration

**Severity:** P2

### Symptoms
- Browser console shows `Access-Control-Allow-Origin` errors.
- Frontend API calls fail but `curl` from the server works.

### Diagnosis

```bash
# Check CORS config
grep -A5 "cors" backend/src/server.js

# Check what FRONTEND_URL is set to
docker exec timesheet-app env | grep FRONTEND_URL

# Test CORS headers
curl -s -I -H "Origin: http://localhost:5173" http://localhost:3001/health | grep -i "access-control"
```

### Resolution

1. **Dev mode:** Ensure `FRONTEND_URL=http://localhost:5173` in `.env`.
2. **Production (Docker):** The production `server.js` sets `origin: true` (allows all same-origin). Verify the frontend is served from the same origin.
3. **Vite proxy not working:** Check `frontend/vite.config.ts` — the proxy target must match the backend port:
   ```ts
   proxy: {
     '/api': { target: 'http://localhost:3001', changeOrigin: true }
   }
   ```

---

## FM-10: Disk Space Exhaustion

**Severity:** P2

### Symptoms
- File writes fail (CSV/PDF exports, SQLite writes).
- `SQLITE_FULL` errors in logs.

### Diagnosis

```bash
df -h
du -sh /app/data /app/temp /var/log 2>/dev/null

# Find large files
find / -type f -size +100M 2>/dev/null
```

### Resolution

1. **Clean temp files:** `rm -f backend/temp/*.csv`
2. **Rotate logs:** If morgan is writing to a file, rotate or truncate.
3. **Vacuum SQLite:**
   ```bash
   sqlite3 /app/data/timesheet.db "VACUUM;"
   ```
4. **Expand disk** if running on cloud infrastructure.

---

## FM-11: Docker Container Health Check Failures

**Severity:** P2

### Symptoms
- `docker ps` shows container as `unhealthy`.
- Orchestrator (ECS, Kubernetes) keeps restarting the container.

### Diagnosis

```bash
# Check health check logs
docker inspect timesheet-app | jq '.[0].State.Health'

# Manually run the health check
docker exec timesheet-app node -e "
  require('http').get('http://localhost:3001/health', (r) => {
    let d=''; r.on('data',c=>d+=c); r.on('end',()=>console.log(r.statusCode,d));
  }).on('error', e => console.error(e.message));
"
```

### Resolution

1. **If the app hasn't started yet:** Increase `start-period` in Dockerfile HEALTHCHECK:
   ```dockerfile
   HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5
   ```
2. **If the app is crashing:** See [FM-1](#fm-1-application-crash--process-exit).
3. **If the health endpoint is slow:** The `/health` route is lightweight (no DB call), so this usually indicates CPU/memory pressure — see [FM-7](#fm-7-memory-leak--oom-kill).

---

## FM-12: Dependency Vulnerability (npm)

**Severity:** P3 (unless actively exploited → P1)

### Symptoms
- `npm audit` reports high/critical vulnerabilities.
- CI `security-audit` job fails on PR.

### Diagnosis

```bash
cd backend && npm audit
cd frontend && npm audit
```

### Resolution

1. **Auto-fix where possible:**
   ```bash
   npm audit fix
   ```
2. **If a breaking change is required:**
   ```bash
   npm audit fix --force  # WARNING: may introduce breaking changes
   npm test               # verify nothing broke
   ```
3. **If no fix is available:** Document the vulnerability and assess whether it's exploitable in your deployment context. Open a P3 issue to track it.

---

## Diagnostic Commands Quick Reference

```bash
# Service health
curl -sf http://localhost:3001/health | jq .

# Container status
docker ps -a --filter "name=timesheet"
docker logs --tail 100 timesheet-app

# DB connectivity (from inside container)
docker exec timesheet-app node -e "
  const {getDatabase}=require('./src/database/init');
  const db=getDatabase();
  db.get('SELECT 1 as ok',(e,r)=>console.log(e||r));
"

# Memory/CPU
docker stats timesheet-app --no-stream

# Disk
df -h && du -sh /app/data

# Network / CORS
curl -sI -H 'Origin: http://localhost:5173' http://localhost:3001/health

# Rate limit status (check response headers)
curl -sI http://localhost:3001/health | grep -i "ratelimit"

# NPM dependency audit
cd backend && npm audit && cd ../frontend && npm audit
```

---

## Contact & Escalation

| Role                | Contact                     |
|---------------------|-----------------------------|
| On-call engineer    | See PagerDuty / Opsgenie    |
| Team lead           | (update with your contact)  |
| Engineering manager | (update with your contact)  |
| Infrastructure      | (update with your contact)  |

> **Tip:** After every P1/P2 incident, schedule a blameless post-mortem within 48 hours and update this runbook with any new procedures discovered.
