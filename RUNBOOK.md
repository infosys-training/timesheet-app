# Incident Response Runbook -- Timesheet App

## Table of Contents

- [Overview](#overview)
- [Architecture Quick Reference](#architecture-quick-reference)
- [Severity Classification](#severity-classification)
- [FM-1: Database Failures (SQLite)](#fm-1-database-failures-sqlite)
- [FM-2: API / Express Server Errors](#fm-2-api--express-server-errors)
- [FM-3: Authentication Failures](#fm-3-authentication-failures)
- [FM-4: Memory Leaks / Resource Exhaustion](#fm-4-memory-leaks--resource-exhaustion)
- [FM-5: Dependency / npm Failures](#fm-5-dependency--npm-failures)
- [FM-6: Frontend Build / Vite Failures](#fm-6-frontend-build--vite-failures)
- [FM-7: Rate Limiting / DDoS](#fm-7-rate-limiting--ddos)
- [FM-8: PDF / CSV Export Failures](#fm-8-pdf--csv-export-failures)
- [Escalation Matrix](#escalation-matrix)
- [Post-Incident Review Template](#post-incident-review-template)

---

## Overview

This runbook covers step-by-step response procedures for common failure modes of the **Employee Time Tracking Application** (timesheet-app). The application consists of:

- **Backend**: Node.js + Express API server on port `3001`
- **Frontend**: React + TypeScript + Vite dev server on port `5173`
- **Database**: SQLite in-memory (all data lost on restart)
- **Auth**: Email-only with `x-user-email` header (no passwords)

---

## Architecture Quick Reference

```
Browser (5173) ──Vite proxy──▶ Express API (3001) ──▶ SQLite (:memory:)
                                  │
                      ┌───────────┼───────────────┐
                      │           │               │
                  /api/auth   /api/clients   /api/work-entries
                                                  │
                                           /api/reports (CSV/PDF)
```

| Component         | Entry Point                          | Health Endpoint         |
|-------------------|--------------------------------------|-------------------------|
| Backend API       | `backend/src/server.js`              | `GET /health`           |
| Frontend          | `frontend/src/main.tsx`              | `http://localhost:5173`  |
| Database          | `backend/src/database/init.js`       | N/A (check via `/health`) |
| Auth middleware    | `backend/src/middleware/auth.js`     | `GET /api/auth/me`      |

---

## Severity Classification

| Severity | Definition                                              | Response Time | Examples                                  |
|----------|---------------------------------------------------------|---------------|-------------------------------------------|
| **P1**   | Service completely unavailable; all users impacted      | 15 min        | Server won't start, DB init failure       |
| **P2**   | Major feature broken; significant user impact           | 1 hour        | Auth broken, CRUD ops failing             |
| **P3**   | Minor feature degraded; workaround available            | 4 hours       | CSV/PDF export broken, slow responses     |
| **P4**   | Cosmetic / low-impact issue                             | 24 hours      | Logging noisy, minor UI glitch            |

---

## FM-1: Database Failures (SQLite)

### Symptoms

- `500 Internal Server Error` on any API call touching data
- Server logs: `SQLITE_ERROR`, `SQLITE_BUSY`, `SQLITE_CORRUPT`, or `Error opening database`
- Server fails to start with `Failed to start server` message
- All data returns empty after an unexpected restart (in-memory DB was wiped)

### Diagnosis

```bash
# 1. Check if backend is running
curl -s http://localhost:3001/health | jq .

# 2. Check backend logs for SQLite errors
journalctl -u timesheet-backend --since "10 min ago" | grep -i sqlite
# or if running with nodemon/pm2:
pm2 logs timesheet-backend --lines 50 | grep -i "database\|sqlite\|SQLITE"

# 3. Verify the database module can load
node -e "const s = require('sqlite3'); console.log('sqlite3 OK', s.VERSION)"

# 4. Check disk space (relevant if migrated to file-based SQLite)
df -h
```

### Response Procedures

**Step 1 -- Confirm the failure**

```bash
curl -s http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"healthcheck@test.com"}' | jq .
```

If the response is `{"error":"Internal server error"}` or connection refused, proceed.

**Step 2 -- Restart the backend**

```bash
# If using pm2
pm2 restart timesheet-backend

# If running directly
cd backend && npm run dev
```

> **WARNING**: Restarting the server will erase all in-memory data. This is expected behavior for the current SQLite `:memory:` configuration.

**Step 3 -- Verify recovery**

```bash
curl -s http://localhost:3001/health
# Expected: {"status":"OK","timestamp":"..."}
```

**Step 4 -- If restarting doesn't fix it**

```bash
# Check if sqlite3 native bindings are corrupted
cd backend && npm rebuild sqlite3

# If that fails, reinstall
rm -rf node_modules && npm install
```

### Prevention

- For production: migrate from `:memory:` to file-based SQLite in `backend/src/database/init.js` (change `':memory:'` to a file path)
- Add regular data backups if using file-based SQLite
- Monitor disk space if using file-based storage

---

## FM-2: API / Express Server Errors

### Symptoms

- `Connection refused` when hitting any endpoint
- `502 Bad Gateway` if behind a reverse proxy
- Nodemon crash loop (rapid restart messages in logs)
- Specific routes returning `500` while `/health` works

### Diagnosis

```bash
# 1. Is the process running?
pgrep -a node | grep server.js

# 2. Is port 3001 in use?
lsof -i :3001
# or
ss -tlnp | grep 3001

# 3. Check for unhandled exceptions in logs
pm2 logs timesheet-backend --err --lines 100

# 4. Test individual route groups
curl -s http://localhost:3001/health
curl -s http://localhost:3001/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}'
curl -s http://localhost:3001/api/clients \
  -H "x-user-email: test@example.com"
```

### Response Procedures

**Step 1 -- Quick restart**

```bash
# Kill stale processes
kill $(lsof -t -i :3001) 2>/dev/null
cd backend && npm run dev
```

**Step 2 -- Check environment variables**

```bash
cd backend && cat .env
# Verify PORT, NODE_ENV, FRONTEND_URL, JWT_SECRET are set
```

**Step 3 -- Validate Express middleware loading**

```bash
# Start server in verbose mode
cd backend && NODE_ENV=development node src/server.js
```

Look for errors during startup (missing module, syntax error, etc.).

**Step 4 -- Check for port conflicts**

```bash
lsof -i :3001
# If another process holds the port, either kill it or change PORT in .env
```

### Prevention

- Use a process manager (pm2) with auto-restart and max restart limits
- Add structured logging to identify crash patterns
- Set up `/health` endpoint monitoring with alerts

---

## FM-3: Authentication Failures

### Symptoms

- `401 User email required in x-user-email header`
- `400 Invalid email format`
- Users logged out unexpectedly (frontend clears `localStorage`)
- Login returns `500 Failed to create user`

### Diagnosis

```bash
# 1. Test login flow
curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}' | jq .

# 2. Test auth middleware
curl -s http://localhost:3001/api/auth/me \
  -H "x-user-email: test@example.com" | jq .

# 3. Check if the issue is DB-related (user table missing)
curl -s http://localhost:3001/health
# If health is OK but auth fails, the users table may not have been created
```

### Response Procedures

**Step 1 -- Verify the `x-user-email` header is being sent**

Check the frontend API client (`frontend/src/api/client.ts`) -- it reads from `localStorage.getItem('userEmail')`.

```bash
# In browser console:
localStorage.getItem('userEmail')
```

**Step 2 -- If DB table is missing, restart server**

The `initializeDatabase()` function in `backend/src/database/init.js` creates the `users` table on startup.

```bash
cd backend && npm run dev
```

**Step 3 -- If the login endpoint itself errors**

Check Joi validation schema in `backend/src/validation/schemas.js` -- the `emailSchema` requires a valid email string.

### Prevention

- Frontend should handle 401 gracefully (already redirects to `/login`)
- Add monitoring for auth error rates
- Consider adding a `/api/auth/validate` endpoint for pre-flight checks

---

## FM-4: Memory Leaks / Resource Exhaustion

### Symptoms

- Increasing response times over hours of operation
- Node.js process memory growing continuously (`RSS` in `ps aux`)
- `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory`
- Server becomes unresponsive, health check timeouts

### Diagnosis

```bash
# 1. Check process memory usage
ps aux | grep node | grep -v grep

# 2. Detailed memory stats (if process is running)
node -e "console.log(process.memoryUsage())"

# 3. Monitor memory over time
watch -n 5 'ps -o pid,rss,%mem,command -p $(pgrep -f "server.js")'

# 4. Check for file descriptor leaks (temp files from CSV/PDF export)
ls -la backend/temp/
lsof -p $(pgrep -f "server.js") | wc -l
```

### Known Leak Vectors

1. **Temp file accumulation**: CSV export creates files in `backend/temp/` -- cleanup can fail if `res.download()` errors
2. **SQLite connection**: The singleton `db` object in `database/init.js` should not leak, but rapid open/close cycles could
3. **Event listener accumulation**: Express middleware or rate limiter state growth

### Response Procedures

**Step 1 -- Immediate mitigation**

```bash
# Restart the backend (will clear in-memory DB)
pm2 restart timesheet-backend
# or
kill $(lsof -t -i :3001) && cd backend && npm run dev
```

**Step 2 -- Clean up temp files**

```bash
rm -rf backend/temp/*
```

**Step 3 -- If OOM crashes are recurring**

```bash
# Increase Node.js heap limit
NODE_OPTIONS="--max-old-space-size=512" node src/server.js
```

### Prevention

- Set `NODE_OPTIONS="--max-old-space-size=512"` in production
- Add a cron job or startup hook to clean `backend/temp/`
- Monitor process RSS with alerting at 80% of available memory
- Consider adding `--expose-gc` and periodic `global.gc()` for debugging

---

## FM-5: Dependency / npm Failures

### Symptoms

- `npm install` fails with `ERESOLVE`, `EACCES`, or network errors
- `Error: Cannot find module 'express'` (or any dependency) at runtime
- `npm audit` reports critical vulnerabilities
- Native module build failures (`sqlite3` prebuild download fails)

### Diagnosis

```bash
# 1. Check Node.js and npm versions
node -v && npm -v

# 2. Verify lock file integrity
cd backend && npm ci --dry-run
cd frontend && npm ci --dry-run

# 3. Check for vulnerabilities
cd backend && npm audit
cd frontend && npm audit

# 4. Verify sqlite3 native bindings
node -e "require('sqlite3')"
```

### Response Procedures

**Step 1 -- Clean reinstall**

```bash
cd backend && rm -rf node_modules && npm install
cd frontend && rm -rf node_modules && npm install
```

**Step 2 -- If sqlite3 native binding fails**

```bash
cd backend && npm rebuild sqlite3
# or force rebuild from source:
npm install sqlite3 --build-from-source
```

**Step 3 -- If npm registry is unreachable**

```bash
# Check connectivity
curl -s https://registry.npmjs.org/ | head -1

# Use a mirror if needed
npm config set registry https://registry.npmmirror.com
npm install
npm config delete registry  # reset after
```

**Step 4 -- Fix audit vulnerabilities**

```bash
npm audit fix
# For breaking changes:
npm audit fix --force  # use with caution
```

### Prevention

- Pin Node.js version in `.nvmrc` or `engines` in `package.json`
- Run `npm audit` in CI (already configured in `pr-checks.yml`)
- Keep `package-lock.json` committed and up to date

---

## FM-6: Frontend Build / Vite Failures

### Symptoms

- `npm run build` fails with TypeScript errors
- Vite dev server won't start or shows a blank page
- Proxy errors: requests to `/api/*` fail with `504 Gateway Timeout`
- White screen with console errors in the browser

### Diagnosis

```bash
# 1. Check TypeScript compilation
cd frontend && npx tsc --noEmit

# 2. Try building
cd frontend && npm run build

# 3. Check Vite proxy target is reachable
curl -s http://localhost:3001/health

# 4. Check for ESLint issues
cd frontend && npm run lint
```

### Response Procedures

**Step 1 -- If Vite proxy fails (API calls returning 504)**

Ensure the backend is running on port 3001. The proxy config is in `frontend/vite.config.ts`:

```ts
proxy: {
  '/api': {
    target: 'http://localhost:3001',
    changeOrigin: true,
  }
}
```

Start the backend first, then the frontend.

**Step 2 -- If TypeScript errors block the build**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -50
# Fix the reported errors, then retry
```

**Step 3 -- If `node_modules` are corrupted**

```bash
cd frontend && rm -rf node_modules && npm install
```

### Prevention

- Run `npm run lint` and `tsc --noEmit` in CI before merging
- Keep TypeScript strict mode enabled
- Document the startup order (backend first, then frontend)

---

## FM-7: Rate Limiting / DDoS

### Symptoms

- Users receive `429 Too Many Requests`
- Legitimate users locked out after normal usage
- Server response times spike across all endpoints

### Diagnosis

```bash
# 1. Check current rate limit configuration in server.js
# Default: 100 requests per 15-minute window per IP
grep -A 4 "rateLimit" backend/src/server.js

# 2. Test if rate limiting is the cause
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health
# If 429, rate limit is triggered
```

### Response Procedures

**Step 1 -- Immediate relief (restart clears rate limit state)**

```bash
pm2 restart timesheet-backend
```

**Step 2 -- Adjust limits if too restrictive**

Edit `backend/src/server.js`:

```js
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200  // increase from 100
});
```

**Step 3 -- If under actual attack**

- Block offending IPs at the firewall/load balancer level
- Reduce the rate limit window and max
- Enable request logging to identify patterns

### Prevention

- Use separate rate limiters for auth vs. data endpoints
- Add IP allowlisting for internal/trusted networks
- Monitor 429 response rates

---

## FM-8: PDF / CSV Export Failures

### Symptoms

- Export buttons return `500 Failed to generate CSV report` or `Failed to generate PDF report`
- Temp files accumulate in `backend/temp/`
- `ENOSPC` errors (disk full from temp files)

### Diagnosis

```bash
# 1. Check temp directory
ls -la backend/temp/
du -sh backend/temp/

# 2. Check disk space
df -h

# 3. Test export endpoint directly
curl -s -o /dev/null -w "%{http_code}" \
  http://localhost:3001/api/reports/export/csv/1 \
  -H "x-user-email: test@example.com"
```

### Response Procedures

**Step 1 -- Clean temp files**

```bash
rm -rf backend/temp/*
```

**Step 2 -- If PDFKit/csv-writer module is broken**

```bash
cd backend && npm rebuild
# or reinstall specific package
npm install pdfkit csv-writer
```

**Step 3 -- If disk is full**

```bash
# Find large files
du -sh /tmp/* | sort -rh | head -10
# Clean up and add temp file rotation
```

### Prevention

- Add a TTL-based cleanup for `backend/temp/` (delete files older than 1 hour)
- Set temp directory on a volume with sufficient space
- Consider streaming exports directly to the response instead of writing to disk

---

## Escalation Matrix

| Severity | First Responder    | Escalate To         | Escalation Trigger                          |
|----------|--------------------|----------------------|---------------------------------------------|
| P1       | On-call engineer   | Team lead + manager  | Not mitigated within 15 minutes             |
| P2       | On-call engineer   | Team lead            | Not resolved within 1 hour                  |
| P3       | Assigned developer | On-call engineer     | Not resolved within 4 hours                 |
| P4       | Assigned developer | N/A                  | Add to next sprint backlog                  |

---

## Post-Incident Review Template

After any P1 or P2 incident, complete this template within 48 hours:

```markdown
## Incident Report: [TITLE]

**Date**: YYYY-MM-DD
**Duration**: HH:MM (start to resolution)
**Severity**: P1 / P2
**Responders**: @names

### Timeline
- HH:MM -- [Event: what happened]
- HH:MM -- [Detection: how it was noticed]
- HH:MM -- [Response: first action taken]
- HH:MM -- [Resolution: what fixed it]

### Root Cause
[Description of the underlying cause]

### Impact
- Users affected: [number / percentage]
- Data loss: [yes / no -- describe if yes]
- Revenue impact: [if applicable]

### Action Items
- [ ] [Preventive measure 1] -- owner: @name, due: YYYY-MM-DD
- [ ] [Preventive measure 2] -- owner: @name, due: YYYY-MM-DD
```
