# Timesheet App Incident Response Runbook

This document provides step-by-step procedures for diagnosing and resolving common failure modes in the Timesheet App.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Quick Reference](#quick-reference)
- [1. Database Failures](#1-database-failures)
- [2. API Server Errors](#2-api-server-errors)
- [3. Authentication Failures](#3-authentication-failures)
- [4. Memory and Performance Issues](#4-memory-and-performance-issues)
- [5. Dependency and Build Failures](#5-dependency-and-build-failures)
- [6. Export (CSV/PDF) Failures](#6-export-csvpdf-failures)
- [7. Rate Limiting Issues](#7-rate-limiting-issues)
- [8. CORS and Network Issues](#8-cors-and-network-issues)
- [9. Docker / Container Failures](#9-docker--container-failures)
- [10. Frontend Failures](#10-frontend-failures)
- [Escalation Matrix](#escalation-matrix)
- [Post-Incident Review Template](#post-incident-review-template)

---

## Architecture Overview

```
┌────────────┐      ┌──────────────────┐      ┌──────────────────┐
│  Frontend   │─────▶│  Backend (Express)│─────▶│ SQLite (in-memory│
│  React/Vite │      │  :3001            │      │  or file-based)  │
│  :5173      │      │                  │      └──────────────────┘
└────────────┘      └──────────────────┘
                         │
                    Health: GET /health
```

**Key endpoints:**
| Endpoint | Purpose |
|---|---|
| `GET /health` | Health check |
| `POST /api/auth/login` | Authentication |
| `GET /api/auth/me` | Current user |
| `GET /api/clients` | List clients |
| `GET /api/work-entries` | List work entries |
| `GET /api/reports/client/:id` | Client report |
| `GET /api/reports/export/csv/:id` | CSV export |
| `GET /api/reports/export/pdf/:id` | PDF export |

---

## Quick Reference

| Symptom | Likely Cause | Section |
|---|---|---|
| 500 errors on all routes | Database initialization failure | [1.1](#11-database-initialization-failure) |
| Data missing after restart | In-memory DB data loss | [1.2](#12-data-loss-after-restart) |
| `SQLITE_` errors in logs | Database corruption or lock | [1.3](#13-sqlite-errors) |
| Server won't start | Port conflict or missing env vars | [2.1](#21-server-fails-to-start) |
| Unhandled promise rejections | Uncaught async errors | [2.2](#22-unhandled-exceptions) |
| 401 on all requests | Auth middleware failure | [3.1](#31-authentication-rejected) |
| Login returns 500 | Database error in auth flow | [3.2](#32-login-endpoint-failure) |
| High memory / slow responses | Memory leak or DB growth | [4.1](#41-memory-leak) |
| `npm install` fails | Dependency resolution issue | [5.1](#51-npm-install-failure) |
| CSV/PDF export returns 500 | Temp directory or library error | [6.1](#61-csv-export-failure) |
| 429 Too Many Requests | Rate limiter triggered | [7.1](#71-rate-limit-exceeded) |
| CORS errors in browser | Misconfigured `FRONTEND_URL` | [8.1](#81-cors-errors) |
| Container unhealthy | Health check failing | [9.1](#91-container-health-check-failing) |
| Blank page in browser | Frontend build or proxy issue | [10.1](#101-blank-page-or-build-failure) |

---

## 1. Database Failures

### 1.1 Database Initialization Failure

**Symptoms:**
- Server logs: `Failed to start server: ...`
- Process exits with code 1
- All API routes return 500

**Diagnosis:**
```bash
# Check server logs
pm2 logs time-tracker-api --lines 50
# or
docker logs <container_id> --tail 50

# Look for:
# - "Error opening database"
# - SQLite native module errors
```

**Resolution:**
1. Check that the `sqlite3` native module is installed and compiled for the current platform:
   ```bash
   cd backend && npm rebuild sqlite3
   ```
2. If using file-based SQLite (Docker), verify the data directory exists and is writable:
   ```bash
   ls -la /app/data/
   # Ensure the Node.js process user owns the directory
   ```
3. Restart the server:
   ```bash
   pm2 restart time-tracker-api
   # or
   docker restart <container_id>
   ```
4. Verify recovery via health check:
   ```bash
   curl http://localhost:3001/health
   ```

**Prevention:** Add database initialization to startup health checks; monitor process exit events.

---

### 1.2 Data Loss After Restart

**Symptoms:**
- Users report all data is missing
- API returns empty arrays for clients and work entries
- Occurs after any server restart

**Diagnosis:**
```bash
# Check if using in-memory or file-based SQLite
grep -r ':memory:' backend/src/database/init.js

# Check DATABASE_PATH environment variable
echo $DATABASE_PATH
```

**Resolution:**
1. This is **expected behavior** when using in-memory SQLite (development default).
2. For production, switch to file-based SQLite by setting:
   ```bash
   export DATABASE_PATH=/app/data/timesheet.db
   ```
   And using the Docker override `docker/overrides/database/init.js`.
3. Communicate to affected users that data loss occurred and is expected with in-memory mode.

**Prevention:** Deploy with file-based SQLite or a persistent database for production.

---

### 1.3 SQLite Errors

**Symptoms:**
- Responses contain `"error": "Database error"`
- Server logs show `SQLITE_BUSY`, `SQLITE_LOCKED`, `SQLITE_CORRUPT`, or other `SQLITE_` prefixed errors

**Diagnosis:**
```bash
# Check logs for specific SQLite error codes
grep "SQLITE_" /var/log/app/*.log
# or
pm2 logs time-tracker-api | grep "SQLITE_"
```

**Resolution:**

| Error Code | Cause | Fix |
|---|---|---|
| `SQLITE_BUSY` | Concurrent write contention | Reduce concurrent writes; enable WAL mode |
| `SQLITE_LOCKED` | Table-level lock held | Restart the server to release locks |
| `SQLITE_CORRUPT` | Database file corruption | Restore from backup or restart (in-memory auto-recovers) |
| `SQLITE_FULL` | Disk full (file-based only) | Free disk space, then restart |

1. For `SQLITE_BUSY` / `SQLITE_LOCKED`:
   ```bash
   # Restart the server to release all locks
   pm2 restart time-tracker-api
   ```
2. For `SQLITE_CORRUPT` (file-based):
   ```bash
   # Back up corrupted file
   cp /app/data/timesheet.db /app/data/timesheet.db.corrupt.$(date +%s)
   # Remove and let the app recreate
   rm /app/data/timesheet.db
   pm2 restart time-tracker-api
   ```
3. For `SQLITE_FULL`:
   ```bash
   df -h /app/data/
   # Free space, then restart
   ```

---

## 2. API Server Errors

### 2.1 Server Fails to Start

**Symptoms:**
- Process exits immediately
- Log: `Failed to start server: ...`
- Port already in use: `EADDRINUSE`

**Diagnosis:**
```bash
# Check if port 3001 is already in use
lsof -i :3001
# or
ss -tlnp | grep 3001

# Verify environment variables
cat backend/.env

# Check Node.js version
node --version  # Requires 18+
```

**Resolution:**
1. **Port conflict:**
   ```bash
   # Kill the process using port 3001
   kill $(lsof -t -i:3001)
   # Restart
   pm2 restart time-tracker-api
   ```
2. **Missing environment variables:**
   ```bash
   cp backend/.env.example backend/.env
   # Edit .env with correct values
   ```
3. **Wrong Node.js version:**
   ```bash
   nvm use 18  # or install Node.js 18+
   ```

---

### 2.2 Unhandled Exceptions

**Symptoms:**
- Server crashes intermittently
- Logs show `UnhandledPromiseRejection` or `uncaughtException`

**Diagnosis:**
```bash
# Search logs for unhandled errors
pm2 logs time-tracker-api | grep -i "unhandled"
```

**Resolution:**
1. Identify the failing route from the stack trace.
2. Check if the database connection is available:
   ```bash
   curl http://localhost:3001/health
   ```
3. If health check fails, restart the server.
4. If health check passes but specific routes fail, the issue is in the route handler. File a bug report.

---

### 2.3 High Error Rate (5xx)

**Symptoms:**
- Multiple users reporting errors simultaneously
- Monitoring shows spike in 500 responses

**Diagnosis:**
```bash
# Check recent logs for error patterns
pm2 logs time-tracker-api --lines 200 | grep "Error:"

# Check process memory and CPU
pm2 monit
```

**Resolution:**
1. Check if it's a database issue (see [Section 1](#1-database-failures)).
2. Check server resource usage (see [Section 4](#4-memory-and-performance-issues)).
3. If the error rate started after a deployment, consider rolling back:
   ```bash
   git log --oneline -5
   git revert <commit>
   pm2 restart time-tracker-api
   ```

---

## 3. Authentication Failures

### 3.1 Authentication Rejected

**Symptoms:**
- All authenticated requests return 401
- Error: `"User email required in x-user-email header"`

**Diagnosis:**
```bash
# Test auth manually
curl -H "x-user-email: test@example.com" http://localhost:3001/api/auth/me

# Check if the header is being stripped by a proxy
curl -v -H "x-user-email: test@example.com" http://localhost:3001/api/clients
```

**Resolution:**
1. Verify the frontend is sending the `x-user-email` header (check browser DevTools > Network tab).
2. If behind a reverse proxy (nginx), ensure it forwards the header:
   ```nginx
   proxy_set_header x-user-email $http_x_user_email;
   ```
3. Check that `localStorage.getItem('userEmail')` returns a value in the browser console.

---

### 3.2 Login Endpoint Failure

**Symptoms:**
- `POST /api/auth/login` returns 500
- New users cannot sign in

**Diagnosis:**
```bash
# Test login endpoint
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com"}'

# Check if DB is initialized
curl http://localhost:3001/health
```

**Resolution:**
1. If health check fails, the database is not initialized. Restart the server.
2. If health check passes, check logs for specific database errors in the auth route.
3. Validate the request body format -- the `email` field must be a valid email.

---

## 4. Memory and Performance Issues

### 4.1 Memory Leak

**Symptoms:**
- Increasing memory usage over time
- Server becomes unresponsive
- Node.js OOM (Out of Memory) crash

**Diagnosis:**
```bash
# Check memory usage
pm2 monit
# or
ps aux | grep node

# Check heap usage with Node.js flags
node --max-old-space-size=512 src/server.js
```

**Resolution:**
1. Immediate: Restart the server to free memory.
   ```bash
   pm2 restart time-tracker-api
   ```
2. If the in-memory SQLite database is growing too large (many records):
   - Monitor entry count via the reports API.
   - Consider periodic data archival or switching to file-based SQLite.
3. Set memory limits in PM2:
   ```bash
   pm2 start src/server.js --name "time-tracker-api" --max-memory-restart 300M
   ```

---

### 4.2 Slow Response Times

**Symptoms:**
- API responses taking > 2 seconds
- Frontend shows loading spinners indefinitely

**Diagnosis:**
```bash
# Time the health check
time curl http://localhost:3001/health

# Check system resources
top -bn1 | head -20
free -m
df -h
```

**Resolution:**
1. If CPU is high, identify the expensive route from access logs (`morgan` output).
2. If memory is high, restart (see [4.1](#41-memory-leak)).
3. If disk I/O is high (file-based SQLite), check for large temp files in `backend/temp/`.
   ```bash
   du -sh backend/temp/
   rm -f backend/temp/*.csv
   ```

---

## 5. Dependency and Build Failures

### 5.1 npm Install Failure

**Symptoms:**
- `npm install` fails with resolution errors
- `sqlite3` native module build fails

**Diagnosis:**
```bash
# Check Node.js and npm versions
node --version
npm --version

# Try clean install
rm -rf node_modules package-lock.json
npm install
```

**Resolution:**
1. **sqlite3 build failure:**
   ```bash
   npm rebuild sqlite3
   # If that fails, install build tools:
   sudo apt-get install -y build-essential python3
   npm install
   ```
2. **Version mismatch:**
   ```bash
   # Ensure Node.js 18+
   nvm install 18
   nvm use 18
   npm install
   ```

---

### 5.2 Frontend Build Failure

**Symptoms:**
- `npm run build` fails in the frontend directory
- TypeScript compilation errors
- Vite build errors

**Diagnosis:**
```bash
cd frontend
npm run build 2>&1 | head -50
```

**Resolution:**
1. Check for TypeScript errors:
   ```bash
   npx tsc --noEmit
   ```
2. Check for ESLint errors:
   ```bash
   npm run lint
   ```
3. Clear Vite cache:
   ```bash
   rm -rf node_modules/.vite
   npm run build
   ```

---

## 6. Export (CSV/PDF) Failures

### 6.1 CSV Export Failure

**Symptoms:**
- `GET /api/reports/export/csv/:clientId` returns 500
- Log: `Error creating CSV` or `Error sending file`

**Diagnosis:**
```bash
# Check if temp directory exists and is writable
ls -la backend/temp/

# Check disk space
df -h
```

**Resolution:**
1. Create the temp directory if missing:
   ```bash
   mkdir -p backend/temp
   chmod 755 backend/temp
   ```
2. Clean up stale temp files:
   ```bash
   find backend/temp -name "*.csv" -mmin +60 -delete
   ```
3. If disk is full, free space and retry.

---

### 6.2 PDF Export Failure

**Symptoms:**
- `GET /api/reports/export/pdf/:clientId` returns 500 or incomplete PDF
- Log: `Error generating PDF`

**Diagnosis:**
```bash
# Check PDFKit dependency
cd backend && node -e "require('pdfkit')"

# Check memory (PDFs are generated in-memory)
pm2 monit
```

**Resolution:**
1. Verify the `pdfkit` module is installed:
   ```bash
   cd backend && npm ls pdfkit
   ```
2. If generating large PDFs, increase Node.js memory:
   ```bash
   node --max-old-space-size=512 src/server.js
   ```
3. Restart the server if memory is exhausted.

---

## 7. Rate Limiting Issues

### 7.1 Rate Limit Exceeded

**Symptoms:**
- API returns 429 Too Many Requests
- Legitimate users blocked

**Diagnosis:**
```bash
# Check current rate limit config in server.js
grep -A5 "rateLimit" backend/src/server.js
# Default: 100 requests per 15 minutes per IP
```

**Resolution:**
1. Wait for the rate limit window to expire (15 minutes).
2. If legitimate traffic exceeds limits, adjust in `server.js`:
   ```javascript
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 200  // Increase from 100
   });
   ```
3. If behind a load balancer, ensure `X-Forwarded-For` headers are trusted so per-IP limits work correctly.

---

## 8. CORS and Network Issues

### 8.1 CORS Errors

**Symptoms:**
- Browser console: `Access to XMLHttpRequest ... has been blocked by CORS policy`
- Frontend cannot reach backend

**Diagnosis:**
```bash
# Check FRONTEND_URL in backend .env
grep FRONTEND_URL backend/.env

# Test CORS headers
curl -I -H "Origin: http://localhost:5173" http://localhost:3001/health
```

**Resolution:**
1. Update `FRONTEND_URL` in `backend/.env` to match the frontend's actual origin:
   ```bash
   FRONTEND_URL=http://localhost:5173   # development
   FRONTEND_URL=https://app.example.com  # production
   ```
2. Restart the backend after changing `.env`.
3. In development, the Vite proxy (`vite.config.ts`) forwards `/api` to the backend, bypassing CORS. Ensure the proxy is configured.

---

### 8.2 Frontend Cannot Reach Backend

**Symptoms:**
- Network errors in browser console
- `ERR_CONNECTION_REFUSED` or timeouts

**Diagnosis:**
```bash
# Check if backend is running
curl http://localhost:3001/health

# Check Vite proxy config
cat frontend/vite.config.ts
```

**Resolution:**
1. Start the backend if not running:
   ```bash
   cd backend && npm run dev
   ```
2. Verify the Vite dev server proxy target matches the backend port.
3. In production, ensure the reverse proxy routes `/api` to the backend.

---

## 9. Docker / Container Failures

### 9.1 Container Health Check Failing

**Symptoms:**
- `docker ps` shows container as `unhealthy`
- Container restarts repeatedly

**Diagnosis:**
```bash
# Check container health
docker inspect --format='{{.State.Health}}' <container_id>

# Check logs
docker logs <container_id> --tail 100
```

**Resolution:**
1. Check if the server is starting correctly inside the container:
   ```bash
   docker exec <container_id> node -e "require('http').get('http://localhost:3001/health', r => { let d=''; r.on('data', c => d+=c); r.on('end', () => console.log(d)); })"
   ```
2. Verify the data directory is mounted and writable:
   ```bash
   docker exec <container_id> ls -la /app/data/
   ```
3. Rebuild the container if dependencies changed:
   ```bash
   docker build -f docker/Dockerfile -t timesheet-app .
   docker compose up -d
   ```

---

### 9.2 Container Out of Disk Space

**Symptoms:**
- `SQLITE_FULL` errors (file-based SQLite)
- Container cannot write temp files

**Diagnosis:**
```bash
docker exec <container_id> df -h /app/data/
```

**Resolution:**
1. Increase volume size or clean up old data.
2. Remove stale CSV temp files:
   ```bash
   docker exec <container_id> find /app/temp -name "*.csv" -delete
   ```

---

## 10. Frontend Failures

### 10.1 Blank Page or Build Failure

**Symptoms:**
- White/blank page in browser
- Console errors about missing chunks or modules

**Diagnosis:**
```bash
# Check if frontend build succeeded
ls -la frontend/dist/

# Check browser console for errors (look for 404s on JS/CSS files)
```

**Resolution:**
1. Rebuild the frontend:
   ```bash
   cd frontend && npm run build
   ```
2. Clear browser cache or hard refresh (`Ctrl+Shift+R`).
3. If using Docker, rebuild the container to include the latest frontend build.

---

### 10.2 Stale Frontend Cache

**Symptoms:**
- Users see old UI after deployment
- New features not appearing

**Resolution:**
1. Vite includes content hashes in filenames, so a hard refresh usually resolves this.
2. If serving via nginx or CDN, purge the cache:
   ```bash
   # nginx: restart to clear proxy cache
   sudo systemctl reload nginx
   ```

---

## Escalation Matrix

| Priority | Response Time | Examples | Escalate To |
|---|---|---|---|
| **P1 - Critical** | 15 min | Server down, data loss, all users blocked | On-call engineer + team lead |
| **P2 - High** | 1 hour | Authentication broken, export failures, high error rate | On-call engineer |
| **P3 - Medium** | 4 hours | Slow responses, rate limiting complaints, CORS issues | Engineering team |
| **P4 - Low** | Next business day | UI glitches, minor UX issues, non-critical logs | Backlog |

---

## Post-Incident Review Template

After resolving any P1 or P2 incident, complete the following:

```markdown
## Post-Incident Review

**Incident ID:** INC-YYYY-MM-DD-NNN
**Date:** YYYY-MM-DD
**Duration:** HH:MM
**Priority:** P1/P2/P3/P4
**Responder(s):**

### Summary
Brief description of what happened.

### Timeline
- HH:MM - Issue detected
- HH:MM - Investigation started
- HH:MM - Root cause identified
- HH:MM - Fix deployed
- HH:MM - Service restored

### Root Cause
What caused the incident.

### Resolution
What was done to fix it.

### Action Items
- [ ] Item 1
- [ ] Item 2

### Lessons Learned
What can be improved to prevent recurrence.
```
