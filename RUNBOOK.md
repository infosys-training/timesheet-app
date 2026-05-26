# Timesheet App — Incident Response Runbook

## Table of Contents

1. [Overview](#overview)
2. [Service Architecture](#service-architecture)
3. [Incident Severity Levels](#incident-severity-levels)
4. [Failure Modes & Response Procedures](#failure-modes--response-procedures)
   - [FM-1: Database Initialization Failure](#fm-1-database-initialization-failure)
   - [FM-2: Database Connection Loss (In-Memory)](#fm-2-database-connection-loss-in-memory)
   - [FM-3: SQLite Lock / SQLITE_BUSY Errors](#fm-3-sqlite-lock--sqlite_busy-errors)
   - [FM-4: API Rate Limiting Triggered](#fm-4-api-rate-limiting-triggered)
   - [FM-5: Authentication Middleware Failure](#fm-5-authentication-middleware-failure)
   - [FM-6: PDF/CSV Report Generation Failure](#fm-6-pdfcsv-report-generation-failure)
   - [FM-7: Memory Leak / OOM](#fm-7-memory-leak--oom)
   - [FM-8: Frontend Build / Dependency Failure](#fm-8-frontend-build--dependency-failure)
   - [FM-9: Backend Dependency Failure (native modules)](#fm-9-backend-dependency-failure-native-modules)
   - [FM-10: Docker Container Health Check Failure](#fm-10-docker-container-health-check-failure)
5. [Escalation Contacts](#escalation-contacts)
6. [Post-Incident Review](#post-incident-review)

---

## Overview

This runbook covers operational response procedures for the **Timesheet App**, a full-stack Node.js/React application for tracking labor hours. The backend runs Express with SQLite; the frontend uses React + Vite.

**Key URLs:**
- Health check: `GET /health`
- API base: `/api/`
- Frontend (dev): `http://localhost:5173`
- Backend (dev): `http://localhost:3001`

---

## Service Architecture

```
┌─────────────────┐        ┌───────────────────┐        ┌────────────┐
│  React Frontend │──Vite──▶│  Express Backend  │───────▶│   SQLite   │
│  (port 5173)    │  proxy  │  (port 3001)      │        │ (in-memory │
│                 │  /api/* │                   │        │  or file)  │
└─────────────────┘        └───────────────────┘        └────────────┘
                                    │
                            ┌───────┴────────┐
                            │  Middleware     │
                            │  - helmet       │
                            │  - cors         │
                            │  - rate-limit   │
                            │  - morgan       │
                            │  - auth (email) │
                            └────────────────┘
```

**Production (Docker):** Single container serves both frontend static files and the backend API with file-based SQLite at `/app/data/timesheet.db`.

---

## Incident Severity Levels

| Level | Description | Response Time | Examples |
|-------|-------------|---------------|----------|
| **P1** | Complete service outage | 15 minutes | Server won't start, DB init fails, container crash loop |
| **P2** | Major feature degraded | 30 minutes | Reports not generating, auth broken, data loss |
| **P3** | Minor feature impacted | 4 hours | Rate limiting too aggressive, slow queries, UI errors |
| **P4** | Low-impact issue | 24 hours | Logging gaps, minor UI glitches, non-critical warnings |

---

## Failure Modes & Response Procedures

### FM-1: Database Initialization Failure

**Severity:** P1  
**Symptoms:**
- Server fails to start with error: `Failed to start server`
- `process.exit(1)` triggered in `startServer()`
- Container enters crash loop

**Root Causes:**
- SQLite native module not compiled for platform
- In Docker: `/app/data` directory missing or not writable
- Corrupted database file (production file-based mode)

**Response Steps:**

1. **Verify the error** — Check application logs:
   ```bash
   # Docker
   docker logs <container_id> --tail 50
   
   # Local
   cd backend && npm run dev 2>&1 | head -50
   ```

2. **Check SQLite module** — Ensure native bindings exist:
   ```bash
   ls node_modules/sqlite3/lib/binding/
   npm rebuild sqlite3
   ```

3. **Check file permissions** (production/Docker):
   ```bash
   docker exec <container_id> ls -la /app/data/
   docker exec <container_id> id
   # Should run as nodejs:1001
   ```

4. **If database file is corrupted:**
   ```bash
   # Backup corrupted file
   cp /app/data/timesheet.db /app/data/timesheet.db.corrupted.$(date +%s)
   
   # Remove and let the app recreate
   rm /app/data/timesheet.db
   
   # Restart the container
   docker restart <container_id>
   ```

5. **If native module issue:**
   ```bash
   npm rebuild sqlite3
   # Or in Docker, rebuild the image
   docker build -f docker/Dockerfile -t timesheet-app .
   ```

6. **Verify recovery:**
   ```bash
   curl http://localhost:3001/health
   # Expected: {"status":"OK","timestamp":"..."}
   ```

---

### FM-2: Database Connection Loss (In-Memory)

**Severity:** P1  
**Symptoms:**
- All API calls return `500 Internal server error`
- Logs show: `Error opening database` or null reference on `db`
- Data disappears after restart (expected for in-memory mode)

**Root Causes:**
- Process restart (in-memory DB is ephemeral)
- `getDatabase()` singleton lost due to module reload
- Memory pressure forcing garbage collection

**Response Steps:**

1. **Check if server is running:**
   ```bash
   curl http://localhost:3001/health
   ```

2. **Check process status:**
   ```bash
   # Local
   ps aux | grep "node src/server"
   
   # Docker
   docker ps | grep timesheet
   ```

3. **Restart the server:**
   ```bash
   # Local (nodemon should auto-restart)
   cd backend && npm run dev
   
   # Docker
   docker restart <container_id>
   ```

4. **Note:** In development mode (in-memory SQLite), **all data is lost on restart**. This is by design. For production, ensure Docker mode with file-based SQLite is used.

5. **Verify recovery:**
   ```bash
   curl http://localhost:3001/health
   curl -H "x-user-email: test@example.com" http://localhost:3001/api/auth/me
   ```

---

### FM-3: SQLite Lock / SQLITE_BUSY Errors

**Severity:** P2  
**Symptoms:**
- Intermittent `500` errors on write operations
- Error logs show: `SQLITE_BUSY: database is locked`
- Concurrent requests failing

**Root Causes:**
- Multiple concurrent write operations on file-based SQLite
- Long-running transactions blocking writes
- Report generation holding read locks

**Response Steps:**

1. **Check current connections:**
   ```bash
   # Check if multiple processes are accessing the DB file
   fuser /app/data/timesheet.db
   lsof /app/data/timesheet.db
   ```

2. **Identify blocking queries** — Check application logs for slow operations.

3. **Immediate mitigation — restart the process:**
   ```bash
   docker restart <container_id>
   ```

4. **Long-term fix:**
   - Enable WAL mode in SQLite: `PRAGMA journal_mode=WAL;`
   - Add busy timeout: `PRAGMA busy_timeout=5000;`
   - Implement connection pooling or serialize write access

5. **Verify:**
   ```bash
   curl -X POST -H "Content-Type: application/json" \
     -H "x-user-email: test@example.com" \
     -d '{"name":"Test Client"}' \
     http://localhost:3001/api/clients
   ```

---

### FM-4: API Rate Limiting Triggered

**Severity:** P3  
**Symptoms:**
- Users receive `429 Too Many Requests`
- Legitimate users locked out
- Rate limit: 100 requests per 15-minute window per IP

**Root Causes:**
- High-traffic period
- Frontend making excessive API calls (polling, retry storms)
- All users behind single IP (NAT/proxy)

**Response Steps:**

1. **Confirm rate limiting is the issue:**
   ```bash
   curl -v http://localhost:3001/health
   # Check for 429 status or X-RateLimit-* headers
   ```

2. **Check current rate limit headers:**
   ```bash
   curl -I -H "x-user-email: user@example.com" http://localhost:3001/api/clients
   # Look for: X-RateLimit-Remaining, X-RateLimit-Reset
   ```

3. **Temporary mitigation — restart server** (resets rate limit counters since they're in-memory):
   ```bash
   docker restart <container_id>
   ```

4. **Adjust rate limit** (requires code change and redeployment):
   - File: `backend/src/server.js` line 26-29
   - Increase `max` value or `windowMs` duration

5. **Verify recovery:**
   ```bash
   curl http://localhost:3001/health
   # Should return 200 OK
   ```

---

### FM-5: Authentication Middleware Failure

**Severity:** P2  
**Symptoms:**
- All authenticated API calls return `401` or `500`
- Login endpoint (`POST /api/auth/login`) fails
- Users cannot access any data

**Root Causes:**
- Database unreachable (auth middleware queries DB)
- Missing `x-user-email` header (client-side issue)
- Invalid email format rejection

**Response Steps:**

1. **Test authentication flow:**
   ```bash
   # Test login
   curl -X POST -H "Content-Type: application/json" \
     -d '{"email":"test@example.com"}' \
     http://localhost:3001/api/auth/login
   
   # Test authenticated endpoint
   curl -H "x-user-email: test@example.com" \
     http://localhost:3001/api/auth/me
   ```

2. **Check if it's a DB issue** — If login returns 500, see [FM-1](#fm-1-database-initialization-failure).

3. **Check client-side** — Verify the frontend is sending the `x-user-email` header:
   - Open browser DevTools → Network tab
   - Check request headers for `x-user-email`

4. **Check CORS configuration** — If cross-origin requests are failing:
   ```bash
   # Verify FRONTEND_URL env var
   echo $FRONTEND_URL
   # Should be http://localhost:5173 (dev) or production URL
   ```

5. **Verify recovery:**
   ```bash
   curl -H "x-user-email: test@example.com" http://localhost:3001/api/clients
   # Should return {"clients":[...]}
   ```

---

### FM-6: PDF/CSV Report Generation Failure

**Severity:** P2  
**Symptoms:**
- Report export returns `500` error
- Error: `Failed to generate CSV report` or PDF stream errors
- Temp files accumulating in `backend/temp/`

**Root Causes:**
- Disk full (temp directory can't be written)
- PDFKit stream errors on large datasets
- Missing temp directory
- File handle exhaustion

**Response Steps:**

1. **Check disk space:**
   ```bash
   df -h /app/    # Docker
   df -h .        # Local
   ```

2. **Check/create temp directory:**
   ```bash
   ls -la backend/temp/
   mkdir -p backend/temp/
   ```

3. **Clean stale temp files:**
   ```bash
   find backend/temp/ -name "*.csv" -mmin +60 -delete
   find backend/temp/ -name "*.pdf" -mmin +60 -delete
   ```

4. **Test report generation:**
   ```bash
   # First create a client and work entry, then:
   curl -H "x-user-email: test@example.com" \
     http://localhost:3001/api/reports/client/1
   
   curl -H "x-user-email: test@example.com" \
     -o test_report.csv \
     http://localhost:3001/api/reports/export/csv/1
   ```

5. **Check file descriptor limits:**
   ```bash
   ulimit -n          # Current limit
   ls /proc/$(pgrep -f "node src/server")/fd | wc -l  # Open FDs
   ```

6. **If disk is full — emergency cleanup:**
   ```bash
   rm -rf backend/temp/*
   docker system prune -f  # If using Docker
   ```

---

### FM-7: Memory Leak / OOM

**Severity:** P1  
**Symptoms:**
- Server becomes unresponsive
- Container killed by OOM killer
- Gradually increasing response times
- `JavaScript heap out of memory` in logs

**Root Causes:**
- PDF generation for very large datasets (streaming not properly closed)
- In-memory SQLite growing unbounded
- Event listener leaks in Express middleware
- Unclosed database connections during error handling

**Response Steps:**

1. **Check memory usage:**
   ```bash
   # Docker
   docker stats <container_id>
   
   # Local
   ps aux | grep "node src/server" | awk '{print $6/1024 " MB"}'
   ```

2. **Immediate mitigation — restart:**
   ```bash
   docker restart <container_id>
   # Or local:
   pkill -f "node src/server" && cd backend && npm run dev
   ```

3. **Identify leak source** — Run with heap profiling:
   ```bash
   node --max-old-space-size=512 --expose-gc src/server.js
   ```

4. **Check for orphaned temp files** (indicator of stream leaks):
   ```bash
   ls -la backend/temp/
   find backend/temp/ -mmin +30 | wc -l
   ```

5. **Long-term mitigations:**
   - Set container memory limits in Docker
   - Add `--max-old-space-size=512` to Node start command
   - Implement streaming for large PDF/CSV exports
   - Add periodic temp file cleanup

---

### FM-8: Frontend Build / Dependency Failure

**Severity:** P3 (dev) / P1 (production deploy)  
**Symptoms:**
- `npm run build` fails with TypeScript errors
- Vite build crashes
- Frontend shows blank page
- `npm install` fails

**Root Causes:**
- TypeScript type errors introduced
- Incompatible dependency versions
- Node.js version mismatch
- Disk space for `node_modules`

**Response Steps:**

1. **Check Node.js version:**
   ```bash
   node --version  # Should be 20.x
   ```

2. **Clean install:**
   ```bash
   cd frontend
   rm -rf node_modules package-lock.json
   npm install
   ```

3. **Check TypeScript errors:**
   ```bash
   cd frontend && npx tsc --noEmit
   ```

4. **Check ESLint:**
   ```bash
   cd frontend && npm run lint
   ```

5. **Verify build:**
   ```bash
   cd frontend && npm run build
   ls dist/  # Should contain index.html and assets/
   ```

---

### FM-9: Backend Dependency Failure (native modules)

**Severity:** P2  
**Symptoms:**
- `npm install` fails with `node-gyp` errors
- `sqlite3` module can't compile
- Error: `Cannot find module 'sqlite3'`

**Root Causes:**
- Missing build tools (python3, make, g++)
- Wrong Node.js version for pre-built binaries
- Corrupted `node_modules`

**Response Steps:**

1. **Check prerequisites:**
   ```bash
   python3 --version
   make --version
   g++ --version
   ```

2. **Install build tools if missing:**
   ```bash
   # Ubuntu/Debian
   sudo apt-get install -y build-essential python3
   
   # Alpine (Docker)
   apk add --no-cache python3 make g++
   ```

3. **Rebuild native modules:**
   ```bash
   cd backend
   npm rebuild sqlite3
   ```

4. **Full clean reinstall:**
   ```bash
   cd backend
   rm -rf node_modules package-lock.json
   npm install
   ```

5. **Verify:**
   ```bash
   cd backend && node -e "require('sqlite3')"
   # No error = success
   ```

---

### FM-10: Docker Container Health Check Failure

**Severity:** P1  
**Symptoms:**
- Container marked `unhealthy` by Docker
- Orchestrator restarts container repeatedly
- Health check endpoint unreachable

**Root Causes:**
- Server didn't start within `--start-period` (5s)
- Database initialization taking too long
- Port 3001 not listening
- Network configuration issue

**Response Steps:**

1. **Check container status:**
   ```bash
   docker ps -a | grep timesheet
   docker inspect <container_id> | jq '.[0].State.Health'
   ```

2. **Check health endpoint manually:**
   ```bash
   docker exec <container_id> node -e \
     "require('http').get('http://localhost:3001/health', (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>console.log(r.statusCode,d)); })"
   ```

3. **Check logs for startup errors:**
   ```bash
   docker logs <container_id> --tail 100
   ```

4. **If startup is slow — increase start period:**
   - Modify `HEALTHCHECK --start-period=30s` in Dockerfile

5. **Force restart:**
   ```bash
   docker stop <container_id>
   docker rm <container_id>
   docker run -d -p 3001:3001 -v timesheet-data:/app/data timesheet-app
   ```

6. **Verify:**
   ```bash
   # Wait for startup
   sleep 5
   curl http://localhost:3001/health
   ```

---

## Escalation Contacts

| Role | Responsibility |
|------|----------------|
| On-call Engineer | First responder for P1/P2 |
| Backend Lead | Database and API issues |
| Frontend Lead | Build and UI issues |
| DevOps Lead | Docker, infrastructure, deployment |
| Engineering Manager | P1 escalation after 30 minutes |

---

## Post-Incident Review

After every P1 or P2 incident, complete the following within 48 hours:

1. **Timeline** — Document the incident from detection to resolution
2. **Root Cause** — Identify the underlying cause (not just symptoms)
3. **Impact** — Quantify affected users, duration, data loss
4. **Action Items** — Create tickets for preventive measures
5. **Lessons Learned** — Update this runbook if new failure modes discovered

Use the P1/P2 incident GitHub Issue template to document the incident.
