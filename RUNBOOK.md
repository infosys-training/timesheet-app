# Incident Response Runbook - Timesheet Application

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Incident Severity Levels](#incident-severity-levels)
4. [Failure Mode: Database Issues](#failure-mode-database-issues)
5. [Failure Mode: API Errors](#failure-mode-api-errors)
6. [Failure Mode: Memory Leaks](#failure-mode-memory-leaks)
7. [Failure Mode: Dependency Failures](#failure-mode-dependency-failures)
8. [Failure Mode: Authentication Failures](#failure-mode-authentication-failures)
9. [Failure Mode: Rate Limiting](#failure-mode-rate-limiting)
10. [Failure Mode: Frontend Unavailability](#failure-mode-frontend-unavailability)
11. [Escalation Procedures](#escalation-procedures)
12. [Post-Incident Review](#post-incident-review)

---

## Overview

This runbook provides step-by-step procedures for responding to incidents in the Timesheet Application. The application is a full-stack Node.js/React system for tracking employee work hours across clients.

**Key characteristics:**
- Backend: Express.js on port 3001
- Frontend: React/Vite on port 5173
- Database: SQLite (in-memory by default; data is lost on restart)
- Auth: Email-based via `x-user-email` header (no passwords)
- Export: PDF/CSV report generation

---

## Architecture

```
┌─────────────┐       ┌──────────────────┐       ┌──────────────┐
│   Browser   │──────▶│  Frontend (Vite) │──────▶│ Backend (Express) │
│  Port 5173  │       │  React + MUI     │       │   Port 3001       │
└─────────────┘       └──────────────────┘       └──────┬───────────┘
                                                         │
                                                         ▼
                                                  ┌──────────────┐
                                                  │ SQLite (RAM) │
                                                  └──────────────┘
```

**Critical endpoints:**
| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Backend health check |
| `POST /api/auth/login` | User authentication |
| `GET /api/clients` | Client listing |
| `GET /api/work-entries` | Work entry listing |
| `GET /api/reports/client/:id` | Report generation |
| `GET /api/reports/export/csv/:id` | CSV export |
| `GET /api/reports/export/pdf/:id` | PDF export |

---

## Incident Severity Levels

| Level | Description | Response Time | Examples |
|-------|-------------|---------------|----------|
| P1 | Complete service outage | < 15 min | Backend crash, DB init failure |
| P2 | Major feature degraded | < 30 min | Auth failing, report exports broken |
| P3 | Minor feature impacted | < 2 hours | Single API route returning errors |
| P4 | Cosmetic / low impact | < 24 hours | Slow response times, logging gaps |

---

## Failure Mode: Database Issues

### Symptoms
- HTTP 500 responses with `"Database error"` message
- Backend logs showing `SQLITE_*` error codes
- All data-dependent endpoints returning errors
- Data loss after server restart (expected for in-memory mode)

### Diagnosis

```bash
# 1. Check backend logs for SQLite errors
journalctl -u timesheet-backend --since "10 minutes ago" | grep -i "sqlite\|database"

# 2. Verify the backend process is running
ps aux | grep "node src/server.js"

# 3. Check memory usage (SQLite in-memory DB grows with data)
free -m
ps -o pid,rss,command -p $(pgrep -f "server.js")

# 4. Test health endpoint
curl -s http://localhost:3001/health | jq .

# 5. Test a database-dependent endpoint
curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients | jq .
```

### Resolution Steps

**Scenario A: Database initialization failure on startup**
1. Check backend logs for the specific SQLite error code
2. Verify `sqlite3` native module is compiled for the current Node.js version:
   ```bash
   cd backend && npm rebuild sqlite3
   ```
3. Restart the backend service:
   ```bash
   cd backend && npm run dev
   ```

**Scenario B: Database corruption / connection lost**
1. Since the database is in-memory, a restart will reset it:
   ```bash
   # Stop the backend process
   kill $(pgrep -f "node src/server.js")
   # Restart
   cd backend && npm run dev
   ```
2. Note: All data will be lost. Inform users if applicable.

**Scenario C: Out of memory (large dataset in RAM)**
1. Check memory consumption:
   ```bash
   ps -o pid,rss,vsz,command -p $(pgrep -f "server.js")
   ```
2. If RSS exceeds available memory, restart the process
3. For persistent storage, modify `backend/src/database/init.js`:
   ```javascript
   // Change ':memory:' to a file path
   db = new sqlite3.Database('./data/timesheet.db');
   ```

### Prevention
- Monitor memory usage with process-level metrics
- Consider migrating to file-based SQLite or PostgreSQL for production
- Implement database backup procedures if using file-based storage

---

## Failure Mode: API Errors

### Symptoms
- Specific endpoints returning 4xx/5xx errors
- Frontend showing error toasts or blank pages
- Validation errors in backend logs (`Joi` validation failures)

### Diagnosis

```bash
# 1. Check which endpoints are failing
curl -s http://localhost:3001/health
curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients
curl -s -X POST http://localhost:3001/api/auth/login -H "Content-Type: application/json" -d '{"email":"test@example.com"}'

# 2. Check backend error logs
journalctl -u timesheet-backend --since "10 minutes ago" | grep -i "error"

# 3. Check for request body parsing issues
curl -v -X POST http://localhost:3001/api/clients \
  -H "Content-Type: application/json" \
  -H "x-user-email: test@example.com" \
  -d '{"name": "Test Client"}'

# 4. Verify CORS configuration
curl -v -X OPTIONS http://localhost:3001/api/clients \
  -H "Origin: http://localhost:5173" \
  -H "Access-Control-Request-Method: GET"
```

### Resolution Steps

**Scenario A: Validation errors (400)**
1. Check request payload matches the Joi schema in `backend/src/validation/schemas.js`
2. Common issues: missing required fields, wrong data types, email format
3. Review the `details` array in the error response for specific field issues

**Scenario B: CORS errors**
1. Verify `FRONTEND_URL` in `backend/.env` matches the actual frontend origin
2. Check that the frontend is making requests to the correct backend URL
3. Fix: Update `FRONTEND_URL` to match the frontend's actual origin

**Scenario C: Body parsing failures**
1. Ensure `Content-Type: application/json` header is present on POST/PUT requests
2. Check that request body is valid JSON
3. Verify body size does not exceed the 10MB limit set in `express.json()`

### Prevention
- Add request logging (already using `morgan('combined')`)
- Monitor 4xx/5xx response rates
- Add structured error tracking (e.g., Sentry)

---

## Failure Mode: Memory Leaks

### Symptoms
- Gradually increasing memory usage over time
- Slow response times
- Eventually OOM kills or process crashes
- PDF/CSV generation becoming slow or failing

### Diagnosis

```bash
# 1. Monitor memory over time
watch -n 5 'ps -o pid,rss,vsz -p $(pgrep -f "server.js")'

# 2. Check for orphaned temp files from CSV export
ls -la backend/temp/
du -sh backend/temp/

# 3. Check Node.js heap usage (requires --expose-gc flag)
node -e "console.log(process.memoryUsage())"

# 4. Check number of open file descriptors
ls /proc/$(pgrep -f "server.js")/fd | wc -l
```

### Resolution Steps

**Scenario A: Temp file accumulation (CSV exports)**
1. The CSV export creates temp files in `backend/temp/`
2. If download errors occur, files may not be cleaned up
3. Clean up manually:
   ```bash
   rm -f backend/temp/*.csv
   ```

**Scenario B: Growing in-memory SQLite database**
1. With heavy usage, the in-memory DB grows unbounded
2. Restart the backend to reset:
   ```bash
   kill $(pgrep -f "server.js") && cd backend && npm run dev
   ```

**Scenario C: PDF generation memory spikes**
1. PDFKit creates documents in memory before streaming
2. Large reports with many entries may spike memory
3. If a specific report causes OOM, reduce the date range or number of entries

### Prevention
- Set up a cron job to clean `backend/temp/` directory
- Implement process memory limits: `--max-old-space-size=512`
- Add a scheduled restart for long-running instances
- Monitor heap usage with `process.memoryUsage()`

---

## Failure Mode: Dependency Failures

### Symptoms
- `npm install` or `npm start` failing
- Module not found errors at runtime
- Native module compilation errors (sqlite3)
- Version incompatibilities after Node.js upgrade

### Diagnosis

```bash
# 1. Check Node.js version
node --version

# 2. Verify dependencies are installed
cd backend && npm ls
cd frontend && npm ls

# 3. Check for native module issues
cd backend && npm rebuild sqlite3

# 4. Verify lock file integrity
cd backend && npm ci --dry-run
```

### Resolution Steps

**Scenario A: Missing node_modules**
```bash
cd backend && npm install
cd frontend && npm install
```

**Scenario B: sqlite3 native module failure**
```bash
cd backend
rm -rf node_modules/sqlite3
npm install sqlite3 --build-from-source
```

**Scenario C: Node.js version mismatch**
1. Check required version in README (Node.js 18+)
2. Use nvm to switch: `nvm use 18`
3. Rebuild native modules: `npm rebuild`

**Scenario D: Frontend build failures**
```bash
cd frontend
rm -rf node_modules
npm install
npm run build
```

### Prevention
- Pin Node.js version in `.nvmrc` or `engines` field
- Use `npm ci` in CI environments for deterministic installs
- Regularly update dependencies and test

---

## Failure Mode: Authentication Failures

### Symptoms
- 401 responses on authenticated endpoints
- Users unable to log in
- `"User email required in x-user-email header"` errors

### Diagnosis

```bash
# 1. Test login endpoint
curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}' | jq .

# 2. Test authenticated endpoint with header
curl -s -H "x-user-email: test@example.com" \
  http://localhost:3001/api/clients | jq .

# 3. Check if the frontend is sending the header
# Open browser DevTools > Network tab > inspect request headers
```

### Resolution Steps

**Scenario A: Missing x-user-email header**
1. Verify the frontend API client is attaching the header on every request
2. Check `frontend/src/api/client.ts` for Axios interceptor configuration
3. Ensure the email is being stored in local storage/context after login

**Scenario B: Invalid email format**
1. The auth middleware validates email with regex: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
2. Ensure no whitespace or special characters in the email header value

**Scenario C: Database error during user lookup**
1. This falls back to the Database Issues section
2. Check SQLite connectivity and table existence

### Prevention
- Frontend should handle 401 by redirecting to login
- Add monitoring/alerting on auth failure rates
- Log failed auth attempts for security review

---

## Failure Mode: Rate Limiting

### Symptoms
- HTTP 429 (Too Many Requests) responses
- Users reporting "too many requests" errors
- Automated scripts or bulk operations failing

### Diagnosis

```bash
# 1. Check rate limit headers in response
curl -v http://localhost:3001/health 2>&1 | grep -i "ratelimit\|retry-after"

# 2. The default limit is 100 requests per 15 minutes per IP
# Check if a single client is making excessive requests
grep "429" /var/log/timesheet/access.log | awk '{print $1}' | sort | uniq -c | sort -rn
```

### Resolution Steps

1. If legitimate traffic is being rate-limited, adjust the limit in `backend/src/server.js`:
   ```javascript
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 200  // increase from 100
   });
   ```
2. For automated scripts, add appropriate delays between requests
3. For specific IPs that need higher limits, implement IP-based allowlisting

### Prevention
- Monitor 429 response rates
- Implement graduated rate limits per endpoint
- Add rate limit headers to frontend error handling

---

## Failure Mode: Frontend Unavailability

### Symptoms
- Blank page in browser
- Vite dev server not responding on port 5173
- Build errors preventing asset compilation

### Diagnosis

```bash
# 1. Check if Vite dev server is running
curl -s http://localhost:5173/ | head -20

# 2. Check for port conflicts
lsof -i :5173

# 3. Check frontend build for TypeScript errors
cd frontend && npx tsc --noEmit

# 4. Check Vite proxy configuration for API forwarding
cat frontend/vite.config.ts
```

### Resolution Steps

**Scenario A: Dev server crashed**
```bash
cd frontend && npm run dev
```

**Scenario B: Build / TypeScript errors**
```bash
cd frontend
npx tsc --noEmit  # show errors
npm run lint       # check linting
npm run build      # attempt production build
```

**Scenario C: Proxy not forwarding to backend**
1. Check `frontend/vite.config.ts` proxy settings
2. Ensure backend is running on the expected port (3001)
3. Restart both frontend and backend

### Prevention
- Run `npm run build` in CI to catch errors early
- Keep TypeScript strict mode enabled
- Monitor frontend error rates with error boundary reporting

---

## Escalation Procedures

| Severity | First Responder | Escalation After | Escalate To |
|----------|----------------|------------------|-------------|
| P1 | On-call engineer | 15 min | Engineering lead |
| P2 | On-call engineer | 30 min | Team lead |
| P3 | Assigned engineer | 2 hours | On-call engineer |
| P4 | Assigned engineer | Next sprint | Team lead |

### Communication Template

```
INCIDENT: [P1/P2/P3/P4] - [Brief Description]
TIME DETECTED: [ISO timestamp]
IMPACT: [Number of users/features affected]
STATUS: [Investigating/Identified/Monitoring/Resolved]
NEXT UPDATE: [ETA for next status update]
```

---

## Post-Incident Review

After every P1/P2 incident, conduct a blameless post-mortem:

1. **Timeline**: Document when the incident was detected, diagnosed, and resolved
2. **Root Cause**: Identify the underlying cause (not just symptoms)
3. **Impact**: Quantify affected users, duration, and business impact
4. **Action Items**: Create specific, assigned follow-up tasks with deadlines
5. **Lessons Learned**: What went well, what could be improved

Template for post-incident review is available in the P1/P2 incident issue templates.
