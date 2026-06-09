# Timesheet App — Incident Response Runbook

> **Audience**: On-call engineers, SREs, and application support staff.
> **App stack**: Node.js 18+ / Express 4, SQLite (in-memory by default), React + Vite frontend, JWT auth.

---

## Table of Contents

1. [General Triage Workflow](#1-general-triage-workflow)
2. [FM-1: Database Failures](#2-fm-1-database-failures)
3. [FM-2: API / HTTP Errors](#3-fm-2-api--http-errors)
4. [FM-3: Authentication & JWT Failures](#4-fm-3-authentication--jwt-failures)
5. [FM-4: Memory Leaks & Resource Exhaustion](#5-fm-4-memory-leaks--resource-exhaustion)
6. [FM-5: Dependency & Build Failures](#6-fm-5-dependency--build-failures)
7. [FM-6: Rate Limiting & DoS](#7-fm-6-rate-limiting--dos)
8. [FM-7: PDF/CSV Export Failures](#8-fm-7-pdfcsv-export-failures)
9. [FM-8: Frontend / Vite Build Failures](#9-fm-8-frontend--vite-build-failures)
10. [FM-9: Process Crash & Restart Loop](#10-fm-9-process-crash--restart-loop)
11. [Monitoring & Alerting Reference](#11-monitoring--alerting-reference)
12. [Contacts & Escalation](#12-contacts--escalation)

---

## 1. General Triage Workflow

```
1. Acknowledge the alert/report within SLA (P1: 15 min, P2: 30 min, P3: 4 hr, P4: 1 biz day).
2. Check the health endpoint:
     curl -s http://<host>:3001/health | jq .
   Expected: {"status":"OK","timestamp":"..."}
3. Check process status:
     pm2 status          # if using pm2
     systemctl status timesheet-backend
4. Tail logs:
     pm2 logs --lines 200
     journalctl -u timesheet-backend -f
5. Identify the failure mode from the sections below.
6. Follow the response procedure for that failure mode.
7. Update the incident ticket with timeline, root cause, and resolution.
```

---

## 2. FM-1: Database Failures

### Symptoms

- HTTP 500 responses with `"Database error"` in body.
- Log lines: `Error opening database`, `SQLITE_BUSY`, `SQLITE_CORRUPT`, `SQLITE_FULL`.
- `/health` returns 200 but all data endpoints return 500.

### Root Causes

| Cause | In-Memory Mode | File-Based Mode |
|-------|---------------|-----------------|
| Process restart → total data loss | Yes | No |
| Disk full | N/A | Yes |
| WAL file corruption | N/A | Yes |
| Write-lock contention (concurrent writes) | Rare | Yes |
| Foreign key constraint violation | Yes | Yes |

### Response Procedure

1. **Verify database connectivity**:
   ```bash
   curl -s http://localhost:3001/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"probe@test.com"}' | jq .
   ```
   - A 201 or 200 confirms writes/reads are working.
   - A 500 confirms a database issue.

2. **In-memory mode (default)**: If the process restarted, all data is expected to be lost. Inform stakeholders — this is by-design behavior. Restart the process to get a clean database:
   ```bash
   pm2 restart timesheet-backend
   ```

3. **File-based SQLite — disk full**:
   ```bash
   df -h /path/to/database/
   # Free space or expand volume
   du -sh /path/to/timesheet.db*
   ```

4. **File-based SQLite — WAL corruption**:
   ```bash
   # Stop the application first
   pm2 stop timesheet-backend
   # Check integrity
   sqlite3 /path/to/timesheet.db "PRAGMA integrity_check;"
   # If corrupt, restore from backup
   cp /backups/timesheet-latest.db /path/to/timesheet.db
   pm2 start timesheet-backend
   ```

5. **Write-lock contention (SQLITE_BUSY)**:
   ```bash
   # Check for long-running transactions
   sqlite3 /path/to/timesheet.db ".timeout 5000"
   # Consider adding busy_timeout in init.js:
   # db.configure("busyTimeout", 5000);
   ```

### Prevention

- Switch from `:memory:` to file-based SQLite in `backend/src/database/init.js` for production.
- Set up automated database backups.
- Monitor for `SQLITE_` prefixed errors in application logs.
- Add `busyTimeout` configuration to handle write contention.

---

## 3. FM-2: API / HTTP Errors

### Symptoms

- Spike in 4xx/5xx responses.
- Users report "Something went wrong" or blank pages.
- Frontend console shows `AxiosError` with non-200 status codes.

### Response Procedure

1. **Identify the failing route** from access logs (`morgan` combined format):
   ```bash
   # Recent 5xx errors
   grep '" 5[0-9][0-9] ' /var/log/timesheet/access.log | tail -20
   # Recent 4xx errors
   grep '" 4[0-9][0-9] ' /var/log/timesheet/access.log | tail -20
   ```

2. **Check for validation errors** (400s):
   - These are expected behavior from Joi validation.
   - Verify the client is sending correctly shaped payloads.
   - Check `validation/schemas.js` for current field requirements.

3. **Check for auth errors** (401s):
   - Verify the `x-user-email` header is being sent.
   - Check if the email format is valid.
   - After process restart (in-memory mode), all users are gone — clients must re-login.

4. **Check for 404s**:
   - Verify the requested resource exists.
   - After process restart, all clients/work-entries/users are deleted.
   - Check if the route itself exists — unknown routes return `"Route not found"`.

5. **Check for 500s**:
   - Tail error logs for stack traces:
     ```bash
     pm2 logs --err --lines 50
     ```
   - Common causes: database errors, unhandled promise rejections, PDFKit/CSV generation failures.

### Prevention

- Monitor 5xx rate: alert if > 1% of total traffic over a 5-minute window.
- Set up structured logging (replace `console.error` with a logger like `winston` or `pino`).
- Add request ID middleware for correlating logs to specific requests.

---

## 4. FM-3: Authentication & JWT Failures

### Symptoms

- Users unable to log in.
- 401 responses on all authenticated endpoints.
- Frontend redirects to `/login` repeatedly.
- Log lines: `JsonWebTokenError`, `TokenExpiredError`.

### Response Procedure

1. **Verify the JWT_SECRET is set**:
   ```bash
   # Check env var (do NOT log the actual value)
   echo ${JWT_SECRET:+"JWT_SECRET is set"}
   ```

2. **Test login endpoint directly**:
   ```bash
   curl -s http://localhost:3001/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com"}' | jq .
   ```

3. **JWT secret rotation** — if the secret was changed, all existing tokens are invalidated:
   - This is expected behavior.
   - Users must re-login to obtain new tokens.
   - Communicate the expected disruption window.

4. **Auth middleware bypass** — the app uses `x-user-email` header (not JWT) for route-level auth. If the header-based auth middleware is returning 401:
   ```bash
   # Test with explicit header
   curl -s http://localhost:3001/api/clients \
     -H "x-user-email: test@example.com" | jq .
   ```

### Prevention

- Store `JWT_SECRET` in a secrets manager, not `.env` files.
- Monitor for spikes in 401 responses.
- Set up alerts for authentication rate-limit triggers (5 attempts / 15 min).

---

## 5. FM-4: Memory Leaks & Resource Exhaustion

### Symptoms

- Increasing response latency over time.
- Process RSS memory climbing without plateau.
- OOM kills in system logs: `dmesg | grep -i oom`.
- Node.js `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory`.

### Known Risk Areas

| Area | Risk | Mechanism |
|------|------|-----------|
| PDF generation (`pdfkit`) | High | Large reports hold entire PDF in memory before streaming |
| CSV export (`csv-writer`) | Medium | Writes to temp file, but large result sets buffer in memory first |
| SQLite `db.all()` | Medium | Returns all matching rows into memory at once (no cursor/streaming) |
| Event listeners | Low | Unclosed DB connections or request handlers accumulating listeners |
| Temp file cleanup | Medium | Failed `fs.unlink` in CSV export leaves orphan files in `backend/temp/` |

### Response Procedure

1. **Check current memory usage**:
   ```bash
   pm2 monit
   # or
   ps aux | grep "node.*server.js" | awk '{print "RSS:", $6/1024, "MB"}'
   ```

2. **Check for orphaned temp files**:
   ```bash
   ls -la backend/temp/
   # Clean up if excessive
   find backend/temp/ -name "*.csv" -mmin +60 -delete
   ```

3. **Take a heap snapshot** (if process is still running):
   ```bash
   # Send SIGUSR2 to Node.js process to trigger heapdump (if heapdump module installed)
   kill -USR2 $(pgrep -f "node.*server.js")
   ```

4. **Immediate mitigation** — restart the process:
   ```bash
   pm2 restart timesheet-backend
   ```

5. **If OOM is recurring**, increase the Node.js heap limit:
   ```bash
   node --max-old-space-size=1024 src/server.js
   ```

### Prevention

- Set `pm2` to auto-restart at a memory threshold: `pm2 start server.js --max-memory-restart 512M`.
- Add periodic temp directory cleanup as a cron job.
- Monitor process RSS and alert at 80% of available memory.
- Consider streaming large report queries with `db.each()` instead of `db.all()`.

---

## 6. FM-5: Dependency & Build Failures

### Symptoms

- `npm install` fails with resolution errors or permission issues.
- `npm audit` reports critical vulnerabilities.
- Application fails to start after dependency update.
- Frontend build (`tsc -b && vite build`) fails with TypeScript errors.

### Response Procedure

1. **Check for lockfile conflicts**:
   ```bash
   cd backend && npm ci
   cd ../frontend && npm ci
   ```

2. **Audit vulnerabilities**:
   ```bash
   cd backend && npm audit
   cd ../frontend && npm audit
   ```

3. **Fix vulnerabilities (non-breaking)**:
   ```bash
   npm audit fix
   ```

4. **For breaking changes** — pin to the last known working versions:
   ```bash
   git checkout main -- package-lock.json
   npm ci
   ```

5. **Native module issues** (`sqlite3` uses node-gyp):
   ```bash
   # Rebuild native modules
   cd backend && npm rebuild sqlite3
   # If that fails, check build tools
   apt-get install -y build-essential python3
   npm install sqlite3 --build-from-source
   ```

### Prevention

- Pin exact dependency versions in `package.json` for production.
- Run `npm audit` in CI pipeline (already configured in `pr-checks.yml`).
- Keep a known-good `package-lock.json` in version control.
- Test dependency updates in a staging environment before production.

---

## 7. FM-6: Rate Limiting & DoS

### Symptoms

- Users receive 429 (Too Many Requests) responses.
- Legitimate users locked out after other users on the same IP exhaust the limit.
- Application slows under high traffic.

### Current Configuration

- **Global rate limit**: 100 requests per IP per 15-minute window.
- **Auth rate limit**: 5 login attempts per IP per 15-minute window.

### Response Procedure

1. **Check if rate limiting is the cause**:
   ```bash
   grep '" 429 ' /var/log/timesheet/access.log | awk '{print $1}' | sort | uniq -c | sort -rn | head
   ```

2. **Temporarily increase limits** (if under legitimate load):
   ```bash
   # Edit backend/src/server.js — increase max from 100
   # Restart the application
   pm2 restart timesheet-backend
   ```

3. **If under attack**:
   ```bash
   # Block offending IPs at the network/firewall level
   iptables -A INPUT -s <offending-ip> -j DROP
   # Or use a reverse proxy (nginx) for more granular control
   ```

### Prevention

- Deploy behind a reverse proxy (nginx/Cloudflare) with more sophisticated rate limiting.
- Use separate rate limiters per route category.
- Consider IP allowlisting for internal applications.

---

## 8. FM-7: PDF/CSV Export Failures

### Symptoms

- Export buttons in the UI show errors or produce empty downloads.
- HTTP 500 on `/api/reports/export/csv/:clientId` or `/api/reports/export/pdf/:clientId`.
- Temp directory fills up with orphaned `.csv` files.

### Response Procedure

1. **Check temp directory**:
   ```bash
   ls -la backend/temp/
   df -h $(dirname backend/temp/)
   ```

2. **Test export directly**:
   ```bash
   # CSV export
   curl -s -o /dev/null -w "%{http_code}" \
     -H "x-user-email: test@example.com" \
     http://localhost:3001/api/reports/export/csv/1

   # PDF export
   curl -s -o /dev/null -w "%{http_code}" \
     -H "x-user-email: test@example.com" \
     http://localhost:3001/api/reports/export/pdf/1
   ```

3. **Clean orphaned temp files**:
   ```bash
   find backend/temp/ -name "*.csv" -mmin +30 -delete
   ```

4. **If PDFKit fails with font errors**:
   ```bash
   # Ensure system fonts are available
   fc-list | head
   # Reinstall pdfkit if needed
   cd backend && npm install pdfkit
   ```

### Prevention

- Implement a scheduled cleanup job for `backend/temp/`.
- Add file size limits to prevent very large exports.
- Monitor temp directory size.

---

## 9. FM-8: Frontend / Vite Build Failures

### Symptoms

- Blank white page after deployment.
- Browser console shows chunk loading errors or module resolution failures.
- `npm run build` fails with TypeScript errors.

### Response Procedure

1. **Check for TypeScript errors**:
   ```bash
   cd frontend && npx tsc --noEmit
   ```

2. **Check for lint errors**:
   ```bash
   cd frontend && npm run lint
   ```

3. **Rebuild from clean state**:
   ```bash
   cd frontend
   rm -rf node_modules dist
   npm install
   npm run build
   ```

4. **Verify the Vite proxy config** — ensure `/api` is proxied to the backend:
   ```bash
   cat frontend/vite.config.ts
   ```

5. **Check CORS configuration** — if frontend and backend are on different origins:
   - Verify `FRONTEND_URL` in the backend `.env` matches the actual frontend URL.

### Prevention

- Run `npm run build` in CI before deployment.
- Verify `tsc -b` succeeds as part of the build step.
- Test the production build locally with `npm run preview` before deploying.

---

## 10. FM-9: Process Crash & Restart Loop

### Symptoms

- Application intermittently unreachable.
- pm2/systemd shows frequent restarts.
- Health check flapping between 200 and connection refused.

### Response Procedure

1. **Check process manager status**:
   ```bash
   pm2 status
   pm2 logs --err --lines 100
   ```

2. **Look for unhandled errors**:
   ```bash
   # Common crash causes
   grep -E "UnhandledPromiseRejection|uncaughtException|FATAL ERROR" /var/log/timesheet/*.log
   ```

3. **Check port conflicts**:
   ```bash
   lsof -i :3001
   # Kill conflicting process if needed
   ```

4. **Check environment variables**:
   ```bash
   # Ensure .env is present and valid
   cat backend/.env
   ```

5. **If crash is in database initialization** — the process exits with code 1:
   ```bash
   # Run manually to see the error
   cd backend && node src/server.js
   ```

### Prevention

- Use a process manager (`pm2`, `systemd`) with automatic restarts and max restart limits.
- Add `process.on('unhandledRejection', ...)` and `process.on('uncaughtException', ...)` handlers.
- Implement graceful shutdown handling.
- Set up uptime monitoring to detect rapid restart cycles.

---

## 11. Monitoring & Alerting Reference

### Recommended Alerts

| Alert | Condition | Priority |
|-------|-----------|----------|
| Health check down | `/health` returns non-200 or timeout for > 30s | P1 |
| High error rate | 5xx responses > 1% of traffic over 5 min | P1 |
| Process OOM killed | `dmesg` contains OOM for timesheet process | P1 |
| Memory usage high | Process RSS > 80% of available memory | P2 |
| Auth failure spike | 401 responses > 10x baseline over 5 min | P2 |
| Rate limit saturation | 429 responses > 5% of traffic | P2 |
| Database errors | `SQLITE_` error in logs > 0 in 5 min | P2 |
| Disk usage high | Temp dir or DB volume > 90% | P3 |
| Dependency vulnerabilities | `npm audit` finds critical CVEs | P3 |
| Export errors | 500s on `/api/reports/export/*` > 0 in 15 min | P3 |

### Health Check Endpoint

```
GET /health → 200 {"status":"OK","timestamp":"<ISO 8601>"}
```

### Key Log Patterns to Monitor

```
SQLITE_BUSY         → database contention
SQLITE_CORRUPT      → database corruption
SQLITE_FULL         → disk full
Error opening database → database init failure
UnhandledPromiseRejection → unhandled async error
FATAL ERROR          → V8 engine crash (usually OOM)
EADDRINUSE           → port conflict
EACCES               → permission denied
```

---

## 12. Contacts & Escalation

| Role | Responsibility | Escalation Time |
|------|---------------|-----------------|
| On-Call Engineer | First responder, initial triage | P1: immediate |
| Team Lead | Escalation for P1/P2 incidents | P1: 15 min, P2: 1 hr |
| SRE / DevOps | Infrastructure issues, scaling | P1: 30 min |
| Product Owner | User communication, impact assessment | P1: 1 hr |

### Escalation Matrix

| Priority | Response SLA | Resolution Target | Escalation Path |
|----------|-------------|-------------------|-----------------|
| P1 — Critical | 15 min | 1 hr | On-Call → Team Lead → SRE |
| P2 — High | 30 min | 4 hr | On-Call → Team Lead |
| P3 — Medium | 4 hr | 24 hr | On-Call |
| P4 — Low | 1 biz day | 1 week | Backlog |
