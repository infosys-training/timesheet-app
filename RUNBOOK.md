# Timesheet App - Incident Response Runbook

This document provides step-by-step procedures for diagnosing and resolving common failure modes in the Timesheet application.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Severity Definitions](#severity-definitions)
- [FM-1: Database Failures](#fm-1-database-failures)
- [FM-2: API Errors (5xx)](#fm-2-api-errors-5xx)
- [FM-3: Authentication Failures](#fm-3-authentication-failures)
- [FM-4: Memory Leaks / High Resource Usage](#fm-4-memory-leaks--high-resource-usage)
- [FM-5: Dependency / npm Failures](#fm-5-dependency--npm-failures)
- [FM-6: Rate Limiting Issues](#fm-6-rate-limiting-issues)
- [FM-7: PDF/CSV Export Failures](#fm-7-pdfcsv-export-failures)
- [FM-8: Frontend Unreachable / Build Failures](#fm-8-frontend-unreachable--build-failures)
- [FM-9: Docker Container Failures](#fm-9-docker-container-failures)
- [FM-10: Data Loss (In-Memory DB Restart)](#fm-10-data-loss-in-memory-db-restart)
- [Escalation Contacts](#escalation-contacts)
- [Post-Incident Review Template](#post-incident-review-template)

---

## Architecture Overview

```
┌────────────┐       ┌─────────────────┐       ┌──────────────┐
│  React SPA │──────>│  Express API    │──────>│   SQLite DB  │
│  (Vite)    │ Proxy │  Port 3001      │       │  (in-memory  │
│  Port 5173 │<──────│  + Rate Limit   │<──────│   or file)   │
└────────────┘       └─────────────────┘       └──────────────┘
                      Middleware chain:
                      helmet → cors → rateLimit → morgan → routes → errorHandler
```

- **Frontend**: React + TypeScript + Vite (port 5173 dev, served by Express in production)
- **Backend**: Node.js + Express (port 3001)
- **Database**: SQLite in-memory (dev) or file-based via `DATABASE_PATH` (production/Docker)
- **Auth**: Email-only via `x-user-email` header (no passwords)
- **Exports**: PDFKit for PDF, csv-writer for CSV (writes temp files)

---

## Severity Definitions

| Severity | Description | Response Time | Example |
|----------|-------------|---------------|---------|
| **P1** | Complete service outage, all users affected | 15 min | Database unrecoverable, server crash loop |
| **P2** | Major feature broken, many users affected | 1 hour | Authentication failing, API returning 500s |
| **P3** | Minor feature degraded, workaround exists | 4 hours | CSV export broken (PDF still works) |
| **P4** | Cosmetic / minor issue, no user impact | 1 business day | Slow response on low-traffic endpoint |

---

## FM-1: Database Failures

### Symptoms
- API returns `500` with `"Database error"` messages
- Server logs show `SQLITE_` prefixed error codes
- Server fails to start with `"Failed to start server"` log

### Diagnosis

```bash
# 1. Check server logs for SQLite errors
docker logs <container> 2>&1 | grep -i "sqlite\|database"

# 2. Verify the database file exists and is writable (production)
ls -la /app/data/timesheet.db
stat /app/data/timesheet.db

# 3. Check disk space (file-based SQLite)
df -h /app/data

# 4. Test database connectivity from the health endpoint
curl -s http://localhost:3001/health | jq .
```

### Resolution

**Scenario A: Database file is locked or corrupted (Production)**
```bash
# 1. Stop the application gracefully
docker stop <container>

# 2. Back up the existing database file
cp /app/data/timesheet.db /app/data/timesheet.db.backup.$(date +%s)

# 3. If corruption is suspected, attempt recovery
sqlite3 /app/data/timesheet.db ".recover" | sqlite3 /app/data/timesheet_recovered.db

# 4. Replace the corrupted file (if recovery succeeded)
mv /app/data/timesheet_recovered.db /app/data/timesheet.db

# 5. Restart the container
docker start <container>

# 6. Verify health
curl -s http://localhost:3001/health
```

**Scenario B: In-memory database lost (Development)**
```bash
# The in-memory database is recreated on every restart — data loss is expected.
# Simply restart the backend:
cd backend && npm run dev
```

**Scenario C: Disk full (Production)**
```bash
# 1. Check disk usage
du -sh /app/data/*

# 2. Remove old temp files from CSV/PDF exports
rm -f /app/backend/temp/*.csv

# 3. If disk is genuinely full, expand the volume or move to larger storage
```

### Severity: P1 (if production database is unrecoverable) / P3 (dev in-memory)

---

## FM-2: API Errors (5xx)

### Symptoms
- Clients receive HTTP 500 responses
- Frontend shows generic error messages
- Server logs show unhandled exceptions

### Diagnosis

```bash
# 1. Check server logs for stack traces
docker logs <container> --tail 200 2>&1 | grep -A5 "Error:"

# 2. Verify the health endpoint
curl -s http://localhost:3001/health

# 3. Test specific failing endpoint
curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients | jq .

# 4. Check if the process is still running
docker exec <container> ps aux | grep node
```

### Resolution

```bash
# 1. If a specific route is failing, check recent code changes:
git log --oneline -10 -- backend/src/routes/

# 2. Check for unhandled promise rejections in routes
# The errorHandler middleware catches Joi and SQLITE_ errors.
# Other errors fall to the default 500 handler.

# 3. Restart the server if it is in a bad state
docker restart <container>

# 4. If the issue persists, enable verbose logging
NODE_ENV=development npm run dev   # Shows full stack traces
```

### Severity: P2

---

## FM-3: Authentication Failures

### Symptoms
- Users cannot log in; `POST /api/auth/login` returns errors
- Authenticated endpoints return `401 User email required`
- Frontend redirects to `/login` unexpectedly

### Diagnosis

```bash
# 1. Test login directly
curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}' | jq .

# 2. Test authenticated endpoint
curl -s -H "x-user-email: test@example.com" \
  http://localhost:3001/api/auth/me | jq .

# 3. Check if the users table exists
# (In-memory DB: only valid if server hasn't restarted)
docker exec <container> node -e "
  const {getDatabase} = require('./src/database/init');
  const db = getDatabase();
  db.all('SELECT name FROM sqlite_master WHERE type=\"table\"', (e,r) => console.log(r));
"
```

### Resolution

```bash
# 1. If 401 errors: Ensure the frontend sends the x-user-email header.
#    Check localStorage for 'userEmail' in browser devtools.

# 2. If email validation fails (400 Invalid email format):
#    Ensure the email matches: /^[^\s@]+@[^\s@]+\.[^\s@]+$/

# 3. If database errors on user creation:
#    The users table may not have been initialized. Restart the server
#    to trigger initializeDatabase().
docker restart <container>
```

### Severity: P2

---

## FM-4: Memory Leaks / High Resource Usage

### Symptoms
- Container OOM-killed or Node.js process crashes with `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed`
- Steadily increasing memory usage over time
- Slow response times that degrade over hours

### Diagnosis

```bash
# 1. Check container resource usage
docker stats <container>

# 2. Check Node.js heap usage
docker exec <container> node -e "console.log(process.memoryUsage())"

# 3. Check for temp file accumulation (CSV/PDF exports write to disk)
docker exec <container> ls -la /app/backend/temp/ 2>/dev/null
docker exec <container> du -sh /app/backend/temp/ 2>/dev/null

# 4. Look for event listener leaks in logs
docker logs <container> 2>&1 | grep "MaxListenersExceededWarning"
```

### Resolution

```bash
# 1. Immediate mitigation: restart the container
docker restart <container>

# 2. Clean up orphaned temp files from failed CSV exports
docker exec <container> find /app/backend/temp -name "*.csv" -mmin +60 -delete

# 3. If OOM is recurring, increase container memory limit
# In docker run:
docker run --memory=512m ...
# Or in docker-compose:
# deploy:
#   resources:
#     limits:
#       memory: 512M

# 4. For persistent leaks, profile the Node.js process:
node --inspect src/server.js
# Then connect Chrome DevTools to chrome://inspect and take heap snapshots
```

### Severity: P2 (if causing outages) / P4 (if gradual, no user impact yet)

---

## FM-5: Dependency / npm Failures

### Symptoms
- `npm install` fails during build or deployment
- Server fails to start with `MODULE_NOT_FOUND` errors
- Security audit reports critical vulnerabilities

### Diagnosis

```bash
# 1. Check for missing modules
cd backend && npm ls 2>&1 | grep "MISSING"

# 2. Run security audit
cd backend && npm audit
cd frontend && npm audit

# 3. Check Node.js version compatibility
node --version   # Requires 18+

# 4. Verify package-lock.json is in sync
npm ci   # Will fail if lock file is out of sync
```

### Resolution

**Missing dependencies:**
```bash
# 1. Clean install
rm -rf node_modules package-lock.json
npm install

# 2. If specific native module fails (e.g., sqlite3):
npm rebuild sqlite3
```

**Critical CVEs:**
```bash
# 1. Attempt automatic fix
npm audit fix

# 2. If breaking changes are needed:
npm audit fix --force
# Then run tests: cd backend && npm test

# 3. The CI pipeline (sast-scan.yml) auto-triggers Devin for CVE remediation.
#    Check open PRs for automated fix attempts.
```

### Severity: P3 (build failures) / P2 (critical CVE in production)

---

## FM-6: Rate Limiting Issues

### Symptoms
- Users receive `429 Too Many Requests` responses
- Legitimate users are blocked after normal usage
- The rate limit is 100 requests per 15-minute window per IP

### Diagnosis

```bash
# 1. Check for 429 responses in logs
docker logs <container> 2>&1 | grep "429\|rate"

# 2. Test rate limit status
for i in $(seq 1 5); do
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/health
done
```

### Resolution

```bash
# 1. If a legitimate user is blocked, they must wait for the 15-minute window to expire.

# 2. To temporarily increase the limit, update backend/src/server.js:
#    Change `max: 100` to a higher value and restart.

# 3. For production, consider per-user rate limiting instead of per-IP:
#    This requires modifying the rate limiter keyGenerator to use x-user-email.
```

### Severity: P3

---

## FM-7: PDF/CSV Export Failures

### Symptoms
- Export buttons return 500 errors
- Downloaded files are empty or corrupted
- Server logs show `Error creating CSV` or PDF pipe errors

### Diagnosis

```bash
# 1. Test CSV export endpoint directly
curl -s -H "x-user-email: test@example.com" \
  -o /dev/null -w "%{http_code}" \
  http://localhost:3001/api/reports/export/csv/1

# 2. Check temp directory permissions
docker exec <container> ls -la /app/backend/temp/ 2>/dev/null

# 3. Check disk space
docker exec <container> df -h /app

# 4. Check for PDFKit or csv-writer errors in logs
docker logs <container> 2>&1 | grep -i "pdf\|csv\|export"
```

### Resolution

```bash
# 1. Ensure temp directory exists and is writable
docker exec <container> mkdir -p /app/backend/temp
docker exec <container> chmod 777 /app/backend/temp

# 2. Clean stale temp files
docker exec <container> find /app/backend/temp -mmin +30 -delete

# 3. If PDFKit crashes on large reports, the report may have too many entries.
#    Consider pagination or streaming for reports with 1000+ entries.

# 4. Verify the client has work entries:
curl -s -H "x-user-email: test@example.com" \
  http://localhost:3001/api/reports/client/1 | jq '.entryCount'
```

### Severity: P3

---

## FM-8: Frontend Unreachable / Build Failures

### Symptoms
- Blank page at `http://localhost:5173` (dev) or root URL (production)
- TypeScript compilation errors during `npm run build`
- Vite dev server crashes

### Diagnosis

```bash
# 1. Check if Vite dev server is running (development)
curl -s http://localhost:5173 | head -20

# 2. Check for TypeScript errors
cd frontend && npx tsc --noEmit

# 3. Check Vite proxy configuration (frontend/vite.config.ts)
# The proxy forwards /api to http://localhost:3001

# 4. Check if backend is reachable from frontend
curl -s http://localhost:3001/health
```

### Resolution

**Dev server won't start:**
```bash
cd frontend
rm -rf node_modules/.vite   # Clear Vite cache
npm run dev
```

**Build failures:**
```bash
cd frontend
npm run lint       # Check for lint errors
npx tsc --noEmit   # Check for type errors
npm run build       # Retry build
```

**Production (Docker) - blank page:**
```bash
# Check that the frontend was built and copied to /app/public
docker exec <container> ls -la /app/public/
# Should contain index.html and assets/
```

### Severity: P2 (complete frontend outage) / P3 (build failure in CI)

---

## FM-9: Docker Container Failures

### Symptoms
- Container exits immediately after starting
- Health check fails (`unhealthy` status)
- Cannot connect to port 3001

### Diagnosis

```bash
# 1. Check container status
docker ps -a | grep timesheet

# 2. Check container logs
docker logs <container> --tail 100

# 3. Check health check status
docker inspect --format='{{.State.Health.Status}}' <container>

# 4. Inspect the last health check result
docker inspect --format='{{json .State.Health}}' <container> | jq '.Log[-1]'
```

### Resolution

```bash
# 1. If exit code 1 — database initialization failed:
#    Check DATABASE_PATH env var and ensure /app/data is writable
docker run -e DATABASE_PATH=/app/data/timesheet.db -v timesheet_data:/app/data ...

# 2. If port conflict:
docker run -p 3002:3001 ...   # Use a different host port

# 3. Rebuild the image if source changed:
docker build -f docker/Dockerfile -t timesheet-app .

# 4. Verify environment variables:
docker exec <container> env | grep -E "PORT|NODE_ENV|DATABASE_PATH"
```

### Severity: P1 (production container won't start) / P3 (dev environment)

---

## FM-10: Data Loss (In-Memory DB Restart)

### Symptoms
- All clients and work entries disappear after a server restart
- Users report missing data with no error messages

### Diagnosis

```bash
# 1. Confirm the database mode
docker exec <container> env | grep DATABASE_PATH
# If empty or :memory:, data loss on restart is expected behavior.

# 2. Check server uptime / recent restarts
docker inspect --format='{{.State.StartedAt}}' <container>
```

### Resolution

```bash
# 1. For production: ensure DATABASE_PATH is set to a file path
#    and the volume is mounted:
docker run -e DATABASE_PATH=/app/data/timesheet.db \
  -v timesheet_data:/app/data \
  timesheet-app

# 2. Verify data persistence across restarts:
docker restart <container>
curl -s -H "x-user-email: test@example.com" \
  http://localhost:3001/api/clients | jq '.clients | length'
# Should return the same count as before restart.

# 3. If data is already lost, it cannot be recovered from an in-memory database.
#    Inform affected users. Consider implementing regular SQLite backups
#    for the file-based production database.
```

### Severity: P1 (production data loss) / P4 (dev — expected behavior)

---

## Escalation Contacts

| Role | Responsibility | When to Escalate |
|------|---------------|------------------|
| On-call Engineer | First responder for P1/P2 | Any production outage |
| Backend Lead | Database & API issues | FM-1, FM-2, FM-10 |
| Frontend Lead | UI & build issues | FM-8 |
| DevOps / SRE | Infrastructure & Docker | FM-4, FM-9 |
| Security Lead | CVE / dependency issues | FM-5 (critical CVEs) |

---

## Post-Incident Review Template

After resolving any P1 or P2 incident, complete the following:

1. **Incident Summary**: One-paragraph description
2. **Timeline**: When detected, when responded, when resolved
3. **Root Cause**: What actually went wrong
4. **Impact**: Number of users affected, duration of impact
5. **Resolution**: What was done to fix it
6. **Action Items**: Preventive measures with owners and due dates
7. **Lessons Learned**: What can we do better next time
