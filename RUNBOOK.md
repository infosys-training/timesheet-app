# Timesheet App Incident Response Runbook

This runbook provides step-by-step procedures for diagnosing and resolving incidents affecting the Timesheet application.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Incident Severity Levels](#incident-severity-levels)
- [Failure Mode 1: Database Failures](#failure-mode-1-database-failures)
- [Failure Mode 2: API / Express Server Errors](#failure-mode-2-api--express-server-errors)
- [Failure Mode 3: Memory Leaks and Resource Exhaustion](#failure-mode-3-memory-leaks-and-resource-exhaustion)
- [Failure Mode 4: Dependency and Build Failures](#failure-mode-4-dependency-and-build-failures)
- [Failure Mode 5: Authentication Failures](#failure-mode-5-authentication-failures)
- [Failure Mode 6: Frontend / Vite Proxy Failures](#failure-mode-6-frontend--vite-proxy-failures)
- [Failure Mode 7: Rate Limiting and Denial of Service](#failure-mode-7-rate-limiting-and-denial-of-service)
- [Failure Mode 8: PDF/CSV Export Failures](#failure-mode-8-pdfcsv-export-failures)
- [General Diagnostics](#general-diagnostics)
- [Escalation Contacts](#escalation-contacts)

---

## Architecture Overview

```
Browser  -->  Vite Dev Server (:5173)  --proxy /api-->  Express API (:3001)  -->  SQLite (in-memory)
```

| Component       | Technology                | Port  |
|-----------------|---------------------------|-------|
| Frontend        | React / TypeScript / Vite | 5173  |
| Backend API     | Node.js / Express         | 3001  |
| Database        | SQLite (in-memory)        | N/A   |
| Auth            | Email-based (`x-user-email` header) | N/A |
| Rate Limiter    | express-rate-limit (100 req / 15 min per IP) | N/A |

**Critical note:** The application uses an in-memory SQLite database. All data is lost on backend restart. This is by design for development; production deployments should use file-based SQLite or a persistent database.

---

## Incident Severity Levels

| Level | Description | Response Time | Examples |
|-------|-------------|---------------|----------|
| **P1** | Complete outage; all users affected | Immediately (< 15 min) | Backend crash, database init failure |
| **P2** | Major feature unavailable; most users impacted | < 1 hour | Export broken, auth failures, data loss on restart |
| **P3** | Minor feature degraded; workaround available | < 4 hours | Slow queries, intermittent rate-limit hits |
| **P4** | Cosmetic or low-impact issue | Next business day | UI rendering glitch, log noise |

---

## Failure Mode 1: Database Failures

### Symptoms
- API returns `500` with `{"error": "Database error"}` or `{"error": "Internal server error"}`
- Server logs show `SQLITE_*` error codes
- All data endpoints fail while `/health` may still return `200 OK`

### Diagnosis

1. **Check server logs** for SQLite error codes:
   ```bash
   # Look for database-related errors in stdout/stderr
   journalctl -u timesheet-backend --since "10 minutes ago" | grep -i "sqlite\|database"
   # Or if running via Docker:
   docker logs <container_id> 2>&1 | grep -i "sqlite\|database"
   ```

2. **Verify the health endpoint** responds:
   ```bash
   curl -s http://localhost:3001/health | jq .
   ```
   If `/health` returns `200` but data endpoints fail, the Express server is running but the database connection is broken.

3. **Common SQLite error codes:**
   - `SQLITE_BUSY` - Database locked by concurrent write
   - `SQLITE_CORRUPT` - Database file corruption (rare with in-memory)
   - `SQLITE_FULL` - Disk/memory full
   - `SQLITE_CANTOPEN` - Cannot open database file

### Resolution

1. **Restart the backend** (this re-initializes the in-memory database):
   ```bash
   # Development
   cd backend && npm run dev

   # Docker
   docker restart timesheet-backend
   ```
   **Warning:** Restarting the backend clears ALL data (in-memory DB).

2. **If using file-based SQLite** and database is corrupt:
   ```bash
   # Back up the corrupted file
   cp data/timesheet.db data/timesheet.db.corrupt.$(date +%s)
   # Restart to re-create tables
   cd backend && npm run dev
   ```

3. **If memory is exhausted**, check system resources:
   ```bash
   free -h
   df -h
   ```
   Consider increasing container memory limits or reducing data volume.

### Prevention
- Monitor process memory usage
- Implement database connection health checks in the `/health` endpoint
- For production: migrate to file-based SQLite or PostgreSQL
- Add database backup procedures for persistent storage

---

## Failure Mode 2: API / Express Server Errors

### Symptoms
- Frontend shows network errors or blank pages
- `curl http://localhost:3001/health` times out or returns non-200
- Server process is not running or crashes on startup

### Diagnosis

1. **Check if the process is running:**
   ```bash
   # Check for Node.js processes on port 3001
   lsof -i :3001
   # Or
   ss -tlnp | grep 3001
   ```

2. **Check server startup logs:**
   ```bash
   cd backend && npm run dev 2>&1 | head -50
   ```

3. **Common startup failures:**
   - Missing `.env` file or required environment variables
   - Port 3001 already in use
   - Missing `node_modules` (dependencies not installed)
   - Syntax errors in server code

4. **Validate environment configuration:**
   ```bash
   cat backend/.env
   # Ensure PORT, FRONTEND_URL, JWT_SECRET are set
   ```

### Resolution

1. **Port conflict** - kill the process occupying the port:
   ```bash
   kill $(lsof -t -i:3001)
   cd backend && npm run dev
   ```

2. **Missing dependencies:**
   ```bash
   cd backend && npm install && npm run dev
   ```

3. **Missing .env file:**
   ```bash
   cd backend && cp .env.example .env
   # Edit .env with appropriate values
   ```

4. **Unhandled exception crashing the server** - check the last error in logs and fix the offending code. Common causes:
   - Accessing properties on `undefined` response objects
   - Unhandled Promise rejections in route handlers
   - Middleware ordering issues (e.g., body parser after routes)

### Prevention
- Use `nodemon` (dev) or a process manager like `pm2` (production) for auto-restart
- Add structured error logging
- Implement graceful shutdown handlers

---

## Failure Mode 3: Memory Leaks and Resource Exhaustion

### Symptoms
- Backend response times steadily increase over time
- Node.js process memory usage grows continuously
- Eventually: `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory`
- Server becomes unresponsive

### Diagnosis

1. **Monitor memory usage:**
   ```bash
   # Real-time process stats
   top -p $(pgrep -f "node.*server.js")

   # Memory snapshot
   ps aux | grep "node.*server.js"
   ```

2. **Check Node.js heap usage** (add to `/health` if not present):
   ```bash
   node -e "console.log(process.memoryUsage())"
   ```

3. **Common leak sources in this app:**
   - Temporary CSV files not cleaned up in `reports.js` (lines 103-136)
   - Unclosed PDF streams on error in export endpoints
   - Event listener accumulation on the SQLite database object
   - Large query result sets held in memory

### Resolution

1. **Immediate relief** - restart the backend:
   ```bash
   cd backend && npm run dev
   ```

2. **Clean up temporary files:**
   ```bash
   rm -rf backend/temp/*
   ```

3. **Increase Node.js heap size** (temporary fix):
   ```bash
   NODE_OPTIONS="--max-old-space-size=2048" npm run dev
   ```

4. **For persistent leaks**, generate a heap snapshot:
   ```bash
   # Start with inspector
   node --inspect src/server.js
   # Connect Chrome DevTools to chrome://inspect and take heap snapshot
   ```

### Prevention
- Add a `/health` endpoint that reports `process.memoryUsage()`
- Set up alerts on memory thresholds (e.g., > 512 MB RSS)
- Ensure all temp files are cleaned up in `finally` blocks
- Use streaming for large exports instead of buffering in memory
- Set `--max-old-space-size` appropriately for the container

---

## Failure Mode 4: Dependency and Build Failures

### Symptoms
- `npm install` fails in backend or frontend
- `npm run build` fails for frontend (TypeScript / Vite errors)
- CI pipeline fails on dependency installation
- `MODULE_NOT_FOUND` errors at runtime

### Diagnosis

1. **Check Node.js version** (requires 18+):
   ```bash
   node -v
   npm -v
   ```

2. **Verify dependency integrity:**
   ```bash
   cd backend && npm ls --depth=0
   cd frontend && npm ls --depth=0
   ```

3. **Check for lock file conflicts:**
   ```bash
   git status package-lock.json
   ```

4. **Native module issues** (sqlite3 uses native bindings):
   ```bash
   cd backend && npm ls sqlite3
   # Check for build errors in npm install output
   ```

### Resolution

1. **Clean install:**
   ```bash
   cd backend && rm -rf node_modules && npm install
   cd frontend && rm -rf node_modules && npm install
   ```

2. **sqlite3 native build failure:**
   ```bash
   # Install build tools
   sudo apt-get install -y build-essential python3
   cd backend && npm rebuild sqlite3
   ```

3. **Frontend TypeScript build errors:**
   ```bash
   cd frontend && npx tsc --noEmit
   # Fix reported type errors, then retry build
   npm run build
   ```

4. **Lock file conflict:**
   ```bash
   rm package-lock.json
   npm install
   ```

### Prevention
- Pin Node.js version in `.nvmrc` or `engines` field
- Run `npm audit` regularly
- Keep `package-lock.json` in version control
- Use CI to validate builds on every PR

---

## Failure Mode 5: Authentication Failures

### Symptoms
- Users cannot log in; `POST /api/auth/login` returns errors
- Authenticated endpoints return `401 Unauthorized`
- Frontend redirects to `/login` unexpectedly

### Diagnosis

1. **Test login directly:**
   ```bash
   curl -s -X POST http://localhost:3001/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email": "test@example.com"}' | jq .
   ```

2. **Test authenticated endpoint:**
   ```bash
   curl -s http://localhost:3001/api/auth/me \
     -H "x-user-email: test@example.com" | jq .
   ```

3. **Check for database errors** in auth flow:
   ```bash
   # Auth middleware creates users on first access
   # Database issues cause 500 errors on user lookup/creation
   ```

4. **Frontend auth check** - ensure `x-user-email` header is being sent:
   - Open browser DevTools > Network tab
   - Check that authenticated requests include `x-user-email` header
   - Verify `localStorage.getItem('userEmail')` is set

### Resolution

1. **Database issue blocking user creation** - restart backend to reinitialize DB
2. **Frontend not sending header** - check `localStorage` for `userEmail`:
   ```javascript
   // In browser console
   localStorage.getItem('userEmail')
   // If null, user needs to log in again
   ```
3. **Email validation failing** - ensure email format matches regex `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`

### Prevention
- Add auth health check to monitoring
- Log authentication failures with request context
- Add session expiry handling in the frontend

---

## Failure Mode 6: Frontend / Vite Proxy Failures

### Symptoms
- Frontend loads but API calls fail with network errors
- Browser console shows CORS errors or `ERR_CONNECTION_REFUSED`
- Frontend works but shows stale or no data

### Diagnosis

1. **Check if frontend dev server is running:**
   ```bash
   lsof -i :5173
   ```

2. **Check if backend is reachable from frontend:**
   ```bash
   curl -s http://localhost:3001/health
   ```

3. **Check Vite proxy configuration** in `frontend/vite.config.ts`:
   ```bash
   cat frontend/vite.config.ts | grep -A 10 proxy
   ```

4. **Check CORS configuration** - backend must allow frontend origin:
   ```bash
   grep FRONTEND_URL backend/.env
   # Must match the frontend URL (http://localhost:5173)
   ```

### Resolution

1. **Backend not running** - start it:
   ```bash
   cd backend && npm run dev
   ```

2. **CORS mismatch** - update `FRONTEND_URL` in `backend/.env`:
   ```bash
   echo "FRONTEND_URL=http://localhost:5173" >> backend/.env
   # Restart backend
   ```

3. **Vite proxy not configured** - ensure `vite.config.ts` has:
   ```typescript
   server: {
     proxy: {
       '/api': 'http://localhost:3001',
       '/health': 'http://localhost:3001'
     }
   }
   ```

4. **Restart both servers:**
   ```bash
   cd backend && npm run dev &
   cd frontend && npm run dev &
   ```

### Prevention
- Use environment variables for all URLs
- Add proxy health checks to frontend dev server
- Document the required startup order (backend first, then frontend)

---

## Failure Mode 7: Rate Limiting and Denial of Service

### Symptoms
- API returns `429 Too Many Requests`
- Legitimate users blocked after bulk operations
- Import/export operations fail midway

### Diagnosis

1. **Check rate limit configuration** in `server.js`:
   ```
   windowMs: 15 * 60 * 1000  (15 minutes)
   max: 100                    (100 requests per window per IP)
   ```

2. **Identify if a single IP is hitting limits:**
   ```bash
   # Check access logs for request volume by IP
   grep "429" /var/log/timesheet/access.log | awk '{print $1}' | sort | uniq -c | sort -rn
   ```

### Resolution

1. **Temporary relief** - increase rate limit or temporarily disable:
   ```javascript
   // In server.js, increase max:
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 500  // increased from 100
   });
   ```

2. **For legitimate bulk operations**, exempt specific endpoints or use a higher limit for authenticated users.

### Prevention
- Implement tiered rate limiting (stricter for unauthenticated, lenient for authenticated)
- Add rate limit headers to responses so clients can back off
- Monitor rate limit hits in metrics/logs

---

## Failure Mode 8: PDF/CSV Export Failures

### Symptoms
- Export buttons produce no download or error
- `GET /api/reports/export/csv/:clientId` or `/pdf/:clientId` returns 500
- Temp directory fills up with orphaned files

### Diagnosis

1. **Test export endpoint:**
   ```bash
   curl -s -o report.csv http://localhost:3001/api/reports/export/csv/1 \
     -H "x-user-email: test@example.com"
   ls -la report.csv
   ```

2. **Check temp directory:**
   ```bash
   ls -la backend/temp/
   du -sh backend/temp/
   ```

3. **Check for PDFKit/csv-writer errors** in logs

### Resolution

1. **Clean temp directory:**
   ```bash
   rm -rf backend/temp/*
   ```

2. **Disk space issues:**
   ```bash
   df -h
   # Free space if needed
   ```

3. **PDFKit crash** - usually caused by invalid data in work entries. Check for:
   - `null` or `undefined` values in description fields
   - Very long text strings exceeding PDF page bounds

### Prevention
- Implement scheduled cleanup of `backend/temp/` directory
- Add file size limits to exports
- Use streaming responses instead of temp files where possible
- Add error handling around PDF generation with proper stream cleanup

---

## General Diagnostics

### Quick Health Check

```bash
# Backend health
curl -s http://localhost:3001/health | jq .

# Process status
ps aux | grep node

# Port usage
ss -tlnp | grep -E "3001|5173"

# System resources
free -h && df -h
```

### Log Locations

| Component | Location |
|-----------|----------|
| Backend (dev) | stdout/stderr from `npm run dev` |
| Backend (Docker) | `docker logs <container>` |
| Frontend (dev) | stdout/stderr from Vite dev server |
| Nginx (if used) | `/var/log/nginx/access.log`, `/var/log/nginx/error.log` |

### Useful Commands

```bash
# Test all API endpoints
./scripts/healthcheck.sh

# Check Node.js memory usage
node -e "const m = process.memoryUsage(); console.log(Object.fromEntries(Object.entries(m).map(([k,v])=>[k,(v/1024/1024).toFixed(2)+'MB'])))"

# Check SQLite integrity (if using file-based DB)
sqlite3 data/timesheet.db "PRAGMA integrity_check;"
```

---

## Escalation Contacts

| Role | Responsibility |
|------|---------------|
| On-call Engineer | First responder for P1/P2 incidents |
| Backend Lead | Database and API issues |
| Frontend Lead | UI and proxy issues |
| DevOps Lead | Infrastructure, Docker, CI/CD issues |
| Engineering Manager | P1 incident commander |

**Escalation process:**
1. P4/P3: File a GitHub issue using the appropriate template
2. P2: File a GitHub issue AND notify the on-call engineer
3. P1: File a GitHub issue, notify on-call, and start an incident bridge immediately
