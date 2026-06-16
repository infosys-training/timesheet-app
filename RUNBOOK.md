# Timesheet App — Incident Response Runbook

> **Audience:** On-call engineers and SREs responsible for the Employee Time Tracking application.
> **Stack:** Node.js/Express backend (port 3001), React/Vite frontend (port 5173 dev / served by backend in prod), SQLite database, JWT auth.

---

## Table of Contents

1. [General Triage Workflow](#1-general-triage-workflow)
2. [FM-1: Backend Process Crash / Unresponsive](#2-fm-1-backend-process-crash--unresponsive)
3. [FM-2: Database Failures (SQLite)](#3-fm-2-database-failures-sqlite)
4. [FM-3: Data Loss on Restart (In-Memory DB)](#4-fm-3-data-loss-on-restart-in-memory-db)
5. [FM-4: Authentication / JWT Failures](#5-fm-4-authentication--jwt-failures)
6. [FM-5: API Errors (5xx on Route Handlers)](#6-fm-5-api-errors-5xx-on-route-handlers)
7. [FM-6: Rate Limiting Blocking Legitimate Users](#7-fm-6-rate-limiting-blocking-legitimate-users)
8. [FM-7: Frontend Build / Serving Failures](#8-fm-7-frontend-build--serving-failures)
9. [FM-8: Memory Leaks / High Resource Usage](#9-fm-8-memory-leaks--high-resource-usage)
10. [FM-9: PDF/CSV Export Failures](#10-fm-9-pdfcsv-export-failures)
11. [FM-10: CORS / Proxy Misconfiguration](#11-fm-10-cors--proxy-misconfiguration)
12. [FM-11: Dependency Vulnerabilities / Failures](#12-fm-11-dependency-vulnerabilities--failures)
13. [FM-12: Docker Container Health Check Failures](#13-fm-12-docker-container-health-check-failures)
14. [Appendix A: Key Endpoints](#appendix-a-key-endpoints)
15. [Appendix B: Environment Variables](#appendix-b-environment-variables)
16. [Appendix C: Contacts & Escalation](#appendix-c-contacts--escalation)

---

## 1. General Triage Workflow

For **every** incident, follow these steps before diving into the specific failure mode:

```
1. Acknowledge the alert / page.
2. Check health endpoint:
     curl -sf http://<host>:3001/health | jq .
3. Check backend process status:
     # systemd
     systemctl status timesheet-backend
     # Docker
     docker ps --filter name=timesheet
     docker inspect --format='{{.State.Health.Status}}' <container>
4. Tail recent logs:
     # systemd / bare metal
     journalctl -u timesheet-backend --since "10 min ago" --no-pager
     # Docker
     docker logs --since 10m <container>
5. Classify severity (P1–P4) and open a GitHub Issue using the
   appropriate incident template.
6. Follow the relevant Failure Mode section below.
7. After resolution, fill in the post-incident timeline on the issue.
```

---

## 2. FM-1: Backend Process Crash / Unresponsive

### Symptoms
- `/health` returns non-200 or times out.
- Users see "Network Error" or blank pages.
- Process manager shows the Node process is absent or restarting in a loop.

### Diagnosis

```bash
# Check if the process is running
pgrep -af "node src/server.js"

# Check exit code / restart count
# Docker:
docker inspect --format='{{.RestartCount}}' <container>
# systemd:
systemctl show timesheet-backend --property=NRestarts

# Check recent logs for fatal errors
docker logs --tail 100 <container> 2>&1 | grep -i "error\|fatal\|EADDRINUSE"
```

### Resolution

| Cause | Action |
|---|---|
| `EADDRINUSE` — port 3001 already bound | `lsof -i :3001` → kill stale process, then restart |
| Uncaught exception / unhandled rejection | Check stack trace in logs; hot-fix or roll back the last deploy |
| Out-of-memory kill (OOMKilled) | See [FM-8](#9-fm-8-memory-leaks--high-resource-usage) |
| Database init failure on startup | See [FM-2](#3-fm-2-database-failures-sqlite) |

```bash
# Restart
# Docker:
docker restart <container>
# systemd:
sudo systemctl restart timesheet-backend
# dev:
cd backend && npm run dev
```

### Verification
```bash
curl -sf http://localhost:3001/health | jq .
# Expected: {"status":"OK","timestamp":"..."}
```

---

## 3. FM-2: Database Failures (SQLite)

### Symptoms
- API routes return `500` with `{"error":"Database error"}` or `{"error":"Internal server error"}`.
- Log entries show `SQLITE_` prefixed error codes.
- Application starts but all CRUD operations fail.

### Diagnosis

```bash
# Check for SQLite-specific errors in logs
docker logs <container> 2>&1 | grep -i "SQLITE_"

# Common SQLite error codes:
#   SQLITE_BUSY    — database locked (concurrent write contention)
#   SQLITE_CORRUPT — database file corruption
#   SQLITE_FULL    — disk full (file-based SQLite in production)
#   SQLITE_CANTOPEN — file permissions or missing path

# For file-based SQLite (production Docker):
ls -la /app/data/timesheet.db          # inside container
docker exec <container> ls -la /app/data/
df -h /app/data/                        # check disk space
```

### Resolution

| Cause | Action |
|---|---|
| `SQLITE_BUSY` | Reduce concurrent writers; SQLite allows only one writer at a time. If persistent, add `PRAGMA busy_timeout = 5000;` to `init.js` |
| `SQLITE_CORRUPT` | Restore from backup: `cp /backups/timesheet.db /app/data/timesheet.db` then restart |
| `SQLITE_FULL` | Free disk space: `df -h`, clean old logs/temp files, expand volume |
| `SQLITE_CANTOPEN` | Fix permissions: `chown nodejs:nodejs /app/data/timesheet.db`, verify `DATABASE_PATH` env var |
| In-memory DB lost | This is by design in dev; see [FM-3](#4-fm-3-data-loss-on-restart-in-memory-db) |

### Verification
```bash
# Test a database-touching endpoint
curl -sf http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@check.com"}' | jq .
```

---

## 4. FM-3: Data Loss on Restart (In-Memory DB)

### Symptoms
- All data disappears after backend restart or container recreation.
- Users report "all my clients/entries are gone."

### Root Cause
Development mode uses SQLite `:memory:` — data exists only in process memory. This is **expected behavior** in dev but must not be used in production.

### Resolution (Production)

Ensure the Docker image uses the production overrides at `docker/overrides/database/init.js`, which stores data at the file path specified by `DATABASE_PATH`:

```bash
# Verify the container is using file-based storage
docker exec <container> env | grep DATABASE_PATH
# Expected: DATABASE_PATH=/app/data/timesheet.db

# Verify the data file exists
docker exec <container> ls -la /app/data/timesheet.db

# If data was lost, restore from backup
docker cp /backups/timesheet.db <container>:/app/data/timesheet.db
docker restart <container>
```

### Prevention
- Use a persistent Docker volume for `/app/data`.
- Schedule regular backups of the SQLite database file.
- Never run the in-memory configuration in production.

---

## 5. FM-4: Authentication / JWT Failures

### Symptoms
- Login returns `401` or `500`.
- Authenticated requests fail with `{"error":"User email required in x-user-email header"}`.
- Users are logged out unexpectedly or cannot access resources.

### Diagnosis

```bash
# Check JWT_SECRET is set
docker exec <container> env | grep JWT_SECRET
# If empty or default, tokens will be invalid after restart

# Test login directly
curl -s http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com"}' | jq .

# Test authenticated request
curl -s http://localhost:3001/api/auth/me \
  -H 'x-user-email: test@example.com' | jq .

# Check rate limiter isn't blocking login
docker logs <container> 2>&1 | grep -i "rate"
```

### Resolution

| Cause | Action |
|---|---|
| `JWT_SECRET` not set / changed | Set a stable `JWT_SECRET` in `.env`; restart. All existing sessions will be invalidated |
| `x-user-email` header missing | Frontend bug — check `client.ts` interceptor adds the header |
| User not found after DB reset | Expected if in-memory DB; user will be auto-created on next login |
| Rate limit hit (5 logins/15 min) | Wait for window to expire, or temporarily increase limit |

---

## 6. FM-5: API Errors (5xx on Route Handlers)

### Symptoms
- Specific API routes return `500 Internal Server Error`.
- Error handler logs `Error:` followed by stack trace.

### Diagnosis

```bash
# Check which endpoints are failing
docker logs <container> 2>&1 | grep '"POST\|"GET\|"PUT\|"DELETE' | grep ' 5[0-9][0-9] '

# Look for the stack trace
docker logs <container> 2>&1 | grep -A 10 "Error:"

# Test each route group
curl -sf http://localhost:3001/health
curl -s http://localhost:3001/api/clients -H 'x-user-email: test@example.com'
curl -s http://localhost:3001/api/work-entries -H 'x-user-email: test@example.com'
curl -s http://localhost:3001/api/reports/client/1 -H 'x-user-email: test@example.com'
```

### Resolution

| Cause | Action |
|---|---|
| Validation error (Joi) | Check request body matches schema; returns 400, not 500 — if 500, there's a bug |
| Unhandled promise rejection | Check for missing `try/catch` or `.catch()` in route handler; hot-fix |
| `TypeError` / `ReferenceError` | Code bug — check recent deploy diff, roll back if needed |
| Database error | See [FM-2](#3-fm-2-database-failures-sqlite) |

---

## 7. FM-6: Rate Limiting Blocking Legitimate Users

### Symptoms
- Users receive `429 Too Many Requests`.
- Happens especially behind a shared NAT/VPN where many users share one IP.

### Diagnosis

```bash
# Check rate limiter config in server.js:
#   windowMs: 15 * 60 * 1000  (15 minutes)
#   max: 100 requests per window per IP

# Check how many requests an IP is making
docker logs <container> 2>&1 | grep '<client-ip>' | wc -l
```

### Resolution

1. **Immediate:** If legitimate users are blocked, restart the server to reset rate limit counters.
2. **Short-term:** Increase `max` in `server.js` rate limiter config, or add trusted IPs to a whitelist.
3. **Long-term:** Implement per-user rate limiting (keyed by `x-user-email`) instead of per-IP.

---

## 8. FM-7: Frontend Build / Serving Failures

### Symptoms
- Users see a blank page or "Cannot GET /" in production.
- TypeScript/Vite build errors during deployment.
- Static assets 404 in production.

### Diagnosis

```bash
# Check if built assets exist (Docker production)
docker exec <container> ls -la /app/public/

# Check nginx or reverse proxy logs if applicable
# Check browser console for 404s on .js/.css files

# Try building locally
cd frontend && npm run build
```

### Resolution

| Cause | Action |
|---|---|
| Missing `/app/public/` in container | Rebuild Docker image: `docker build -f docker/Dockerfile -t timesheet-app .` |
| TypeScript errors during build | Fix type errors: `cd frontend && npx tsc --noEmit` |
| Vite proxy not working (dev) | Ensure backend is running on port 3001; check `vite.config.ts` proxy config |
| `NODE_ENV` not `production` | The server only serves static files when `NODE_ENV=production`; check env |

---

## 9. FM-8: Memory Leaks / High Resource Usage

### Symptoms
- Container restarts with `OOMKilled`.
- Response times degrade over time.
- Node process RSS grows continuously.

### Diagnosis

```bash
# Check container resource usage
docker stats <container> --no-stream

# Check if OOM killed
docker inspect <container> | jq '.[0].State.OOMKilled'

# Check Node.js heap inside container
docker exec <container> node -e "console.log(process.memoryUsage())"

# Monitor over time
watch -n 5 'docker stats <container> --no-stream --format "{{.MemUsage}}"'
```

### Common Leak Sources
- **Unclosed database connections:** `getDatabase()` creates a singleton, but if called incorrectly multiple connections could be created.
- **Temp files from CSV export:** `reports.js` writes temp CSV files; if `fs.unlink` fails, files accumulate.
- **Morgan logging buffers:** High-traffic logging can consume memory.

### Resolution

1. **Immediate:** Restart the container.
2. **Short-term:** Set memory limits: `docker run --memory=512m --memory-swap=512m ...`
3. **Investigate:**
   - Clean temp files: `docker exec <container> rm -f /app/temp/*.csv`
   - Take a heap snapshot: `docker exec <container> node --inspect=0.0.0.0:9229 -e "setTimeout(()=>{},30000)"` and connect Chrome DevTools.
4. **Long-term:** Add memory monitoring to health check; implement graceful shutdown on memory threshold.

---

## 10. FM-9: PDF/CSV Export Failures

### Symptoms
- Export buttons return 500 or download an empty/corrupt file.
- Logs show `Error creating CSV` or PDFKit errors.

### Diagnosis

```bash
# Check temp directory exists and is writable
docker exec <container> ls -la /app/temp/ 2>/dev/null || echo "temp dir missing"
docker exec <container> touch /app/temp/test && rm /app/temp/test

# Check disk space
docker exec <container> df -h /app/

# Test export endpoint directly
curl -s -o /dev/null -w "%{http_code}" \
  http://localhost:3001/api/reports/export/csv/1 \
  -H 'x-user-email: test@example.com'
```

### Resolution

| Cause | Action |
|---|---|
| Temp directory missing | `docker exec <container> mkdir -p /app/temp` |
| Disk full | Free space or expand volume |
| No data for client | Expected — returns empty report; verify client has work entries |
| PDFKit font issue | Ensure PDFKit dependencies are installed in the Docker image |
| Permission denied on temp dir | Fix ownership: `chown nodejs:nodejs /app/temp` |

---

## 11. FM-10: CORS / Proxy Misconfiguration

### Symptoms
- Browser console shows `Access-Control-Allow-Origin` errors.
- API requests fail from the frontend but succeed from `curl`.
- Login works but subsequent API calls fail.

### Diagnosis

```bash
# Check CORS response headers
curl -sI -X OPTIONS http://localhost:3001/api/clients \
  -H 'Origin: http://localhost:5173' \
  -H 'Access-Control-Request-Method: GET'

# Verify FRONTEND_URL env var
docker exec <container> env | grep FRONTEND_URL

# In dev, check Vite proxy config
cat frontend/vite.config.ts
```

### Resolution

| Cause | Action |
|---|---|
| `FRONTEND_URL` mismatch | Set `FRONTEND_URL` to the exact origin the browser uses (incl. port) |
| Production: reverse proxy strips headers | Configure reverse proxy to pass CORS headers through |
| Dev: Vite proxy not forwarding `/api` | Ensure `vite.config.ts` has the `/api` proxy pointing to `http://localhost:3001` |

---

## 12. FM-11: Dependency Vulnerabilities / Failures

### Symptoms
- `npm audit` reports critical vulnerabilities.
- `npm install` fails due to peer dependency conflicts.
- A package breaks after update.

### Diagnosis

```bash
cd backend && npm audit
cd frontend && npm audit

# Check for outdated packages
npm outdated
```

### Resolution

1. **Audit fix:** `npm audit fix` (safe fixes only).
2. **Breaking updates:** Test in a feature branch first.
3. **Lock versions:** Use `npm ci` in CI/CD (respects `package-lock.json`).
4. **Emergency:** If a dependency has a known exploit, patch immediately and deploy.

---

## 13. FM-12: Docker Container Health Check Failures

### Symptoms
- `docker ps` shows container as `unhealthy`.
- Orchestrator (Docker Compose, Kubernetes) keeps restarting the container.

### Diagnosis

```bash
# Check health check logs
docker inspect --format='{{json .State.Health}}' <container> | jq .

# Run health check manually
docker exec <container> node -e \
  "require('http').get('http://localhost:3001/health', (r) => { console.log(r.statusCode); r.on('data',d=>console.log(d.toString())); })"
```

### Resolution

| Cause | Action |
|---|---|
| App hasn't started yet | Increase `--start-period` in Dockerfile `HEALTHCHECK` |
| Port not bound | Check `PORT` env var matches Dockerfile `EXPOSE` and health check URL |
| App crashed | See [FM-1](#2-fm-1-backend-process-crash--unresponsive) |

---

## Appendix A: Key Endpoints

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/health` | GET | No | Application health check |
| `/api/auth/login` | POST | No | User login (email-based) |
| `/api/auth/me` | GET | Yes | Current user info |
| `/api/clients` | GET/POST | Yes | List/create clients |
| `/api/clients/:id` | GET/PUT/DELETE | Yes | Read/update/delete client |
| `/api/work-entries` | GET/POST | Yes | List/create work entries |
| `/api/work-entries/:id` | GET/PUT/DELETE | Yes | Read/update/delete entry |
| `/api/reports/client/:id` | GET | Yes | Client hours report |
| `/api/reports/export/csv/:id` | GET | Yes | Export CSV |
| `/api/reports/export/pdf/:id` | GET | Yes | Export PDF |

---

## Appendix B: Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Backend listening port |
| `NODE_ENV` | `development` | `production` enables static file serving and file-based SQLite |
| `FRONTEND_URL` | `http://localhost:5173` | Allowed CORS origin |
| `JWT_SECRET` | (from `.env`) | Signing key for JWT tokens — **must be strong in production** |
| `DATABASE_PATH` | `/app/data/timesheet.db` | File-based SQLite path (production Docker only) |

---

## Appendix C: Contacts & Escalation

| Severity | Response SLA | Escalation |
|---|---|---|
| **P1 — Critical** | Acknowledge within 15 min | Page on-call immediately; Incident Commander within 30 min |
| **P2 — High** | Acknowledge within 1 hour | Notify team lead; begin investigation |
| **P3 — Medium** | Acknowledge within 4 hours | Assign to next sprint if not resolvable same-day |
| **P4 — Low** | Acknowledge within 1 business day | Track in backlog |

> **Update this section** with your team's actual on-call rotation and contact details.
