# Timesheet App — Incident Response Runbook

> **Owner:** Platform / SRE Team
> **Last updated:** 2026-06-16
> **Application:** timesheet-app (Express + React + SQLite)

---

## Table of Contents

1. [General Triage Workflow](#1-general-triage-workflow)
2. [Database Failures (SQLite)](#2-database-failures-sqlite)
3. [API / Express Server Errors](#3-api--express-server-errors)
4. [Memory Leaks & Resource Exhaustion](#4-memory-leaks--resource-exhaustion)
5. [Dependency Failures](#5-dependency-failures)
6. [Rate Limiting & DDoS](#6-rate-limiting--ddos)
7. [Authentication Failures](#7-authentication-failures)
8. [Report Generation Failures (PDF/CSV)](#8-report-generation-failures-pdfcsv)
9. [Frontend / Vite Proxy Failures](#9-frontend--vite-proxy-failures)
10. [Docker / Deployment Failures](#10-docker--deployment-failures)
11. [Rollback Procedure](#11-rollback-procedure)
12. [Contacts & Escalation](#12-contacts--escalation)

---

## 1. General Triage Workflow

```
1. Acknowledge the alert / incident ticket.
2. Check the health endpoint:
     curl -s http://<host>:3001/health | jq .
3. Inspect application logs:
     docker logs <container>          # Docker
     journalctl -u timesheet-backend  # systemd
     pm2 logs timesheet-backend       # PM2
4. Classify severity (P1–P4) using the incident issue templates.
5. Follow the relevant failure-mode section below.
6. Communicate status in the incident channel.
7. After resolution, file a postmortem within 48 hours.
```

---

## 2. Database Failures (SQLite)

### Symptoms

- API responses return `500` with `{"error":"Database error"}`.
- Server logs show `SQLITE_*` error codes (e.g., `SQLITE_BUSY`, `SQLITE_CORRUPT`, `SQLITE_CANTOPEN`).
- Server fails to start with `Error opening database` or `Failed to start server`.

### Diagnosis

```bash
# 1. Check if the backend process is running
ps aux | grep "node.*server.js"

# 2. Tail logs for SQLITE errors
grep -i "sqlite\|database error" /var/log/timesheet/*.log   # or docker logs

# 3. For file-based DB (production Docker), check disk space and permissions
df -h $(dirname $DATABASE_PATH)
ls -la $DATABASE_PATH
stat $DATABASE_PATH

# 4. Verify DB integrity (file-based only)
sqlite3 $DATABASE_PATH "PRAGMA integrity_check;"
```

### Resolution

| Issue | Action |
|---|---|
| `SQLITE_BUSY` — concurrent write contention | Restart the backend process. If recurring, ensure only one backend instance writes to the DB at a time. |
| `SQLITE_CORRUPT` | Stop the server. Restore from the most recent backup: `cp /backups/timesheet-latest.db $DATABASE_PATH`. Restart. |
| `SQLITE_CANTOPEN` — file not found or permission denied | Verify `DATABASE_PATH` env var. Ensure the directory exists and is writable: `mkdir -p $(dirname $DATABASE_PATH) && chmod 755 $(dirname $DATABASE_PATH)`. |
| In-memory DB data loss (dev) | Expected on restart. No action needed; data is ephemeral. |
| Schema migration failure | Check `initializeDatabase()` in `backend/src/database/init.js`. Manually run the missing `CREATE TABLE IF NOT EXISTS` statements via `sqlite3`. |

### Prevention

- Use file-based SQLite in production (`DATABASE_PATH` env var via Docker overrides).
- Schedule automated backups with `sqlite3 $DATABASE_PATH ".backup /backups/timesheet-$(date +%s).db"`.
- Monitor disk usage on the volume hosting the database file.

---

## 3. API / Express Server Errors

### Symptoms

- `/health` returns non-200 or times out.
- Clients receive `500 Internal server error` on any API call.
- Logs show unhandled exceptions or `Error:` prefixed messages.

### Diagnosis

```bash
# 1. Hit health check
curl -sf http://localhost:3001/health || echo "UNHEALTHY"

# 2. Test a protected endpoint
curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients

# 3. Check process status
docker ps --filter name=timesheet   # Docker
pm2 status                          # PM2

# 4. Check for port conflicts
lsof -i :3001

# 5. Review recent logs for stack traces
docker logs --tail 200 <container> 2>&1 | grep -A 5 "Error:"
```

### Resolution

| Issue | Action |
|---|---|
| Process crashed / not running | Restart: `docker restart <container>` or `pm2 restart timesheet-backend`. |
| Port 3001 already in use | Kill the conflicting process: `kill $(lsof -t -i :3001)`, then restart. |
| Validation errors (Joi) returning 400 | Not an incident — expected behavior. Check client-side payloads. |
| Unhandled promise rejections crashing Node | Check logs for the stack trace. Patch the code. As a stopgap, ensure the process manager auto-restarts. |
| 404 on known routes | Verify route registration in `server.js`. Ensure the correct server override is deployed (Docker). |

### Prevention

- Run the backend behind a process manager (PM2, Docker restart policy: `always`).
- Add `process.on('unhandledRejection', ...)` handling if not already present.
- Set up uptime monitoring on `/health`.

---

## 4. Memory Leaks & Resource Exhaustion

### Symptoms

- Node.js process RSS grows monotonically over hours/days.
- Container gets OOM-killed (exit code 137).
- Increasing response latency over time.

### Diagnosis

```bash
# 1. Check current memory usage
docker stats <container> --no-stream

# 2. Node.js heap snapshot (if --inspect is enabled)
# Connect Chrome DevTools to the Node inspector port

# 3. Check for temp file accumulation (reports)
ls -la /app/temp/   # inside the container
du -sh /app/temp/

# 4. Monitor over time
watch -n 10 "docker stats <container> --no-stream --format 'table {{.MemUsage}}'"
```

### Resolution

| Issue | Action |
|---|---|
| OOM kill (exit code 137) | Restart container. Increase memory limit if justified. Investigate root cause. |
| Temp file accumulation in `backend/temp/` | The CSV export creates temp files that should be cleaned up after download. Check `reports.js` cleanup logic. Manually purge: `rm -f /app/temp/*.csv`. |
| SQLite connection not released | Ensure `closeDatabase()` is called on graceful shutdown. Check for leaked DB handles. |
| Large request body abuse | The `10mb` JSON limit in `express.json()` is generous. Lower it if abuse is suspected. |

### Prevention

- Set container memory limits in Docker Compose / orchestrator.
- Add a cron job to clean stale temp files: `find /app/temp -mmin +60 -delete`.
- Monitor container memory via Prometheus / CloudWatch / Datadog.

---

## 5. Dependency Failures

### Symptoms

- `npm install` fails during build or deployment.
- Runtime errors like `Cannot find module 'xyz'`.
- Vulnerability alerts (CVE) from CI pipeline or SonarCloud.

### Diagnosis

```bash
# 1. Check for missing modules
cd backend && npm ls --depth=0 2>&1 | grep "MISSING"

# 2. Audit for vulnerabilities
npm audit --production

# 3. Verify lockfile integrity
npm ci  # strict install from lockfile

# 4. Check Node.js version compatibility
node -v
cat .nvmrc 2>/dev/null || echo "No .nvmrc"
```

### Resolution

| Issue | Action |
|---|---|
| Missing dependency at runtime | `npm ci` in the backend/frontend directory. Redeploy. |
| Lockfile conflicts | Delete `node_modules` and `package-lock.json`, run `npm install`, commit the new lockfile. |
| Critical CVE in a dependency | Check if the CI auto-remediation workflow (`.github/workflows/sast-scan.yml`) already opened a PR. If not, run `npm audit fix` or manually bump the affected package. |
| `sqlite3` native module build failure | Ensure build tools are installed: `apt-get install -y python3 make g++`. Run `npm rebuild sqlite3`. |

### Key Dependencies to Monitor

| Package | Role | Risk |
|---|---|---|
| `express` | HTTP server | Low — stable |
| `sqlite3` | Database driver (native addon) | Medium — native build failures on new Node versions |
| `pdfkit` | PDF generation | Low |
| `csv-writer` | CSV export | Low |
| `joi` | Request validation | Low |
| `helmet` | Security headers | Low |
| `express-rate-limit` | Rate limiting | Low |
| `axios` (frontend) | HTTP client | Low |
| `@mui/material` (frontend) | UI framework | Medium — frequent major releases |

---

## 6. Rate Limiting & DDoS

### Symptoms

- Legitimate users receive `429 Too Many Requests`.
- Monitoring shows traffic spike from a single IP or range.

### Diagnosis

```bash
# 1. Check access logs for high-frequency IPs
docker logs <container> | awk '{print $1}' | sort | uniq -c | sort -rn | head 20

# 2. Current rate limit config (server.js)
# windowMs: 15 min, max: 100 requests per IP
```

### Resolution

| Issue | Action |
|---|---|
| Legitimate users rate-limited | Temporarily increase `max` in `rateLimit()` config. Redeploy. |
| DDoS / abuse | Block offending IPs at the reverse proxy / firewall level. Do NOT just increase limits. |
| Rate limit too aggressive for API-heavy frontends | Increase to 200–500 per 15 min, or exempt the `/health` endpoint. |

---

## 7. Authentication Failures

### Symptoms

- Users get `401 User email required in x-user-email header`.
- Frontend redirects to `/login` repeatedly.
- `400 Invalid email format` on login.

### Diagnosis

```bash
# 1. Test auth flow manually
curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}'

# 2. Verify the x-user-email header is forwarded
curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/auth/me

# 3. Check if the user exists in DB
sqlite3 $DATABASE_PATH "SELECT * FROM users WHERE email = 'user@example.com';"
```

### Resolution

| Issue | Action |
|---|---|
| Header stripped by reverse proxy | Configure proxy to forward `x-user-email`. |
| `localStorage` cleared in browser | User must re-login. Check for cookie/storage clearing policies. |
| CORS error blocking requests | Verify `FRONTEND_URL` env var matches the actual frontend origin. |
| User not auto-created | Check `authenticateUser` middleware in `backend/src/middleware/auth.js` for DB errors. |

---

## 8. Report Generation Failures (PDF/CSV)

### Symptoms

- Export buttons return 500 errors.
- PDF downloads are empty or corrupted.
- Temp directory fills up.

### Diagnosis

```bash
# 1. Test CSV export
curl -s -H "x-user-email: test@example.com" \
  http://localhost:3001/api/reports/export/csv/1 -o /tmp/test.csv
file /tmp/test.csv

# 2. Test PDF export
curl -s -H "x-user-email: test@example.com" \
  http://localhost:3001/api/reports/export/pdf/1 -o /tmp/test.pdf
file /tmp/test.pdf

# 3. Check temp directory
ls -la backend/temp/
df -h .
```

### Resolution

| Issue | Action |
|---|---|
| `ENOENT` on temp directory | The code creates it automatically, but verify write permissions. `mkdir -p backend/temp && chmod 755 backend/temp`. |
| Disk full | Clean old temp files: `find backend/temp -mmin +30 -delete`. Free disk space. |
| PDFKit crash on large reports | Check for entries with extremely long descriptions. Add pagination. |
| CSV download incomplete | Check network timeouts. The Axios client has a 10s timeout which may not be enough for large exports. |

---

## 9. Frontend / Vite Proxy Failures

### Symptoms

- Frontend loads but API calls fail with network errors.
- CORS errors in the browser console.
- Blank page after deployment.

### Diagnosis

```bash
# 1. Check if frontend dev server is running
curl -s http://localhost:5173/ | head -5

# 2. Test the Vite proxy
curl -s http://localhost:5173/api/auth/login -X POST \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}'

# 3. In production (Docker), check if static files are served
curl -s http://localhost:3001/ | head -5
```

### Resolution

| Issue | Action |
|---|---|
| Proxy 502/504 | Backend is down or not on port 3001. Start the backend first. |
| CORS errors in production | Ensure `FRONTEND_URL` is set correctly or `NODE_ENV=production` for same-origin mode. |
| Blank page after deploy | Check that `vite build` succeeded. Verify static files exist in `public/` directory. |
| `ERR_CONNECTION_REFUSED` on proxy | Backend process not running. Restart it. |

---

## 10. Docker / Deployment Failures

### Symptoms

- Container fails to start or keeps restarting.
- Health check fails after deployment.
- Data lost after container restart.

### Diagnosis

```bash
# 1. Check container status and restart count
docker ps -a --filter name=timesheet

# 2. Inspect container logs
docker logs --tail 100 <container>

# 3. Check volume mounts
docker inspect <container> | jq '.[0].Mounts'

# 4. Verify environment variables
docker exec <container> env | grep -E "PORT|DATABASE_PATH|NODE_ENV|FRONTEND_URL"
```

### Resolution

| Issue | Action |
|---|---|
| Container exit code 1 | DB initialization failed. Check `DATABASE_PATH` and volume mounts. |
| Data lost on restart | Ensure the SQLite DB file is on a mounted volume, not in the container filesystem. Check `docker/overrides/database/init.js` for `DATABASE_PATH`. |
| Image build failure | Check if `sqlite3` native module compiles. May need `python3`, `make`, `g++` in the Docker image. |
| Port mapping conflict | Change the host port: `-p 8080:3001`. |

---

## 11. Rollback Procedure

```bash
# 1. Identify the last known-good image/commit
git log --oneline -10

# 2. Roll back the deployment
docker pull <registry>/timesheet-app:<previous-tag>
docker stop timesheet-app
docker run -d --name timesheet-app \
  -v /data/timesheet:/data \
  -e DATABASE_PATH=/data/timesheet.db \
  -p 3001:3001 \
  <registry>/timesheet-app:<previous-tag>

# 3. Verify health
curl -sf http://localhost:3001/health && echo "HEALTHY" || echo "UNHEALTHY"

# 4. Restore database if needed
cp /backups/timesheet-latest.db /data/timesheet.db
docker restart timesheet-app
```

---

## 12. Contacts & Escalation

| Level | Contact | When |
|---|---|---|
| **L1 — On-call engineer** | `#timesheet-oncall` Slack channel | Initial triage for all incidents |
| **L2 — Backend team** | `#timesheet-backend` | Database, API, or auth issues |
| **L3 — Platform / SRE** | `#platform-eng` | Infrastructure, Docker, networking |
| **Management** | Engineering Manager | P1 incidents not resolved within 1 hour |

> Update these contacts with your actual team channels and on-call rotation.
