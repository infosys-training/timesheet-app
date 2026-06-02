# Incident Response Runbook

## Overview

This runbook provides step-by-step response procedures for common failure modes in the Employee Time Tracking Application.

**Architecture**: Express backend (port 3001) + React/Vite frontend (port 5173) + SQLite in-memory database.

---

## Table of Contents

1. [Database Failures](#1-database-failures)
2. [API/Backend Errors](#2-apibackend-errors)
3. [Memory Leaks & Resource Exhaustion](#3-memory-leaks--resource-exhaustion)
4. [Dependency & Build Failures](#4-dependency--build-failures)
5. [Authentication Failures](#5-authentication-failures)
6. [Frontend Failures](#6-frontend-failures)
7. [Infrastructure & Deployment Failures](#7-infrastructure--deployment-failures)

---

## 1. Database Failures

### 1.1 In-Memory Database Data Loss (Severity: P1)

**Symptoms:**
- All user data missing after server restart
- Empty client lists / work entries reported by users
- Health check passes but API returns empty results

**Root Cause:** The application uses SQLite `:memory:` — all data is lost when the Node.js process restarts.

**Response:**
1. Confirm the issue: `curl http://localhost:3001/health` should return `200 OK`
2. Check if process restarted: `journalctl -u timesheet-backend --since "1 hour ago"` or review container logs
3. Notify affected users that data has been reset
4. If in production with file-based SQLite, check `DATABASE_PATH` env var and verify the `.db` file exists:
   ```bash
   ls -la $DATABASE_PATH
   sqlite3 $DATABASE_PATH "SELECT count(*) FROM users;"
   ```
5. Restore from backup if available

**Prevention:**
- Migrate to file-based SQLite for production (modify `backend/src/database/init.js`)
- Implement periodic data export/backup cron
- Use container volume mounts for persistent storage

---

### 1.2 SQLite Database Lock / Corruption (Severity: P2)

**Symptoms:**
- HTTP 500 errors on write operations (create client, add work entry)
- Error logs show `SQLITE_BUSY` or `SQLITE_CORRUPT`
- Read operations may still succeed

**Response:**
1. Check backend logs for SQLite error codes:
   ```bash
   grep -i "SQLITE_" /var/log/timesheet/backend.log | tail -20
   ```
2. If `SQLITE_BUSY`: Reduce concurrent writes; ensure only one server instance is running
3. If `SQLITE_CORRUPT` (file-based mode):
   ```bash
   # Stop the application
   systemctl stop timesheet-backend
   # Attempt integrity check
   sqlite3 $DATABASE_PATH "PRAGMA integrity_check;"
   # If corrupt, restore from backup
   cp /backups/timesheet-latest.db $DATABASE_PATH
   systemctl start timesheet-backend
   ```
4. For in-memory mode: Restart the server (data loss is expected)

**Prevention:**
- Set `PRAGMA journal_mode=WAL;` for file-based SQLite
- Ensure single-writer architecture
- Add database health to the `/health` endpoint

---

### 1.3 Database Initialization Failure (Severity: P1)

**Symptoms:**
- Server fails to start
- Logs show "Failed to start server" with database errors
- Health check endpoint unreachable

**Response:**
1. Check startup logs:
   ```bash
   docker logs timesheet-app --tail 50
   # or
   journalctl -u timesheet-backend --since "5 min ago"
   ```
2. Verify sqlite3 native module is compiled for the correct architecture:
   ```bash
   node -e "require('sqlite3')"
   ```
3. If native module error: `cd backend && npm rebuild sqlite3`
4. Check disk space (for file-based SQLite): `df -h`
5. Verify file permissions on `DATABASE_PATH` directory

**Prevention:**
- Include sqlite3 rebuild in Docker build step
- Add startup health check with retry logic
- Monitor disk space alerts

---

## 2. API/Backend Errors

### 2.1 Express Server Crash / Unhandled Exception (Severity: P1)

**Symptoms:**
- All API requests fail with connection refused
- Health check unreachable
- Frontend shows network errors

**Response:**
1. Check if process is running:
   ```bash
   # Docker
   docker ps | grep timesheet
   # systemd
   systemctl status timesheet-backend
   ```
2. Review crash logs:
   ```bash
   docker logs timesheet-app --tail 100
   # or check for core dumps
   ls /tmp/core.*
   ```
3. Restart the service:
   ```bash
   docker restart timesheet-app
   # or
   systemctl restart timesheet-backend
   ```
4. Monitor for repeated crashes (crash loop)
5. If crash-looping, check for:
   - Missing environment variables (`PORT`, `FRONTEND_URL`, `JWT_SECRET`)
   - Port conflicts: `lsof -i :3001`
   - Corrupted `node_modules`: `cd backend && rm -rf node_modules && npm install`

**Prevention:**
- Use process manager (PM2 or Docker restart policy `unless-stopped`)
- Add `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers
- Implement graceful shutdown

---

### 2.2 Rate Limiting Triggered (Severity: P3)

**Symptoms:**
- Users receive HTTP 429 Too Many Requests
- Automated scripts/tests blocked
- Error: "Too many requests from this IP"

**Response:**
1. Identify affected IP(s) from access logs:
   ```bash
   grep "429" /var/log/timesheet/access.log | awk '{print $1}' | sort | uniq -c | sort -rn
   ```
2. Determine if legitimate traffic or abuse
3. If legitimate: Temporarily increase rate limit in `server.js` (current: 100 req/15 min)
4. If abuse: Block the IP at load balancer / firewall level
5. Rate limit resets automatically after the 15-minute window

**Prevention:**
- Tune rate limits based on expected traffic patterns
- Implement per-user rate limiting instead of per-IP
- Add rate-limit bypass for internal monitoring

---

### 2.3 Validation Errors Spike (Severity: P4)

**Symptoms:**
- Increased 400 errors in logs
- Users report form submission failures
- Frontend/backend version mismatch suspected

**Response:**
1. Check error patterns:
   ```bash
   grep "Validation error" /var/log/timesheet/backend.log | tail -20
   ```
2. Verify frontend and backend versions are compatible
3. Check if a recent deployment changed validation schemas (`backend/src/validation/schemas.js`)
4. If version mismatch: Roll back to previous version or deploy matching frontend

**Prevention:**
- Version-lock frontend and backend deployments together
- Add API versioning
- Include schema version in health check response

---

## 3. Memory Leaks & Resource Exhaustion

### 3.1 Node.js Heap Out of Memory (Severity: P1)

**Symptoms:**
- Process killed with `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed`
- Gradual increase in memory usage over time
- OOMKilled in container orchestrator

**Response:**
1. Check current memory usage:
   ```bash
   # Container
   docker stats timesheet-app --no-stream
   # Process
   ps aux | grep "node src/server.js" | awk '{print $6}'
   ```
2. If OOMKilled, restart with increased memory limit:
   ```bash
   docker update --memory 1g timesheet-app
   docker restart timesheet-app
   ```
3. Capture heap snapshot for analysis (before restart if possible):
   ```bash
   kill -USR2 $(pgrep -f "node src/server.js")
   ```
4. Review recent changes for potential leaks:
   - Unclosed database connections
   - Event listener accumulation
   - Large PDF/CSV generation without streaming

**Prevention:**
- Set `--max-old-space-size` appropriately
- Implement streaming for CSV/PDF export (large datasets)
- Add memory usage to monitoring/alerts
- Periodic restarts via rolling deployment

---

### 3.2 PDF/CSV Export Resource Exhaustion (Severity: P2)

**Symptoms:**
- Export endpoints hang or timeout
- Memory spikes during report generation
- Temp file accumulation in `backend/temp/`

**Response:**
1. Check temp directory:
   ```bash
   ls -la backend/temp/ | wc -l
   du -sh backend/temp/
   ```
2. Clean orphaned temp files:
   ```bash
   find backend/temp/ -mmin +60 -delete
   ```
3. Check for large datasets causing export issues:
   ```bash
   sqlite3 $DATABASE_PATH "SELECT client_id, count(*) FROM work_entries GROUP BY client_id ORDER BY count(*) DESC LIMIT 5;"
   ```
4. If disk full: Free space and restart

**Prevention:**
- Add pagination/limits to export endpoints
- Implement streaming PDF generation
- Add temp file cleanup cron job
- Set max export size limits

---

### 3.3 Event Loop Blocking (Severity: P2)

**Symptoms:**
- All requests become slow simultaneously
- Health check responds slowly (>5s)
- High CPU usage on single core

**Response:**
1. Check event loop lag:
   ```bash
   curl -w "time_total: %{time_total}\n" http://localhost:3001/health
   ```
2. Profile if possible:
   ```bash
   node --prof src/server.js  # restart with profiling
   ```
3. Check for synchronous operations in logs (file I/O, crypto)
4. Restart as immediate mitigation

**Prevention:**
- Use async I/O consistently
- Offload CPU-intensive work (PDF generation) to worker threads
- Add event loop lag monitoring

---

## 4. Dependency & Build Failures

### 4.1 npm Install Failure (Severity: P2)

**Symptoms:**
- Deployment fails at dependency installation
- `npm install` errors (network, compilation)
- `sqlite3` native addon build failure

**Response:**
1. Check the specific error:
   ```bash
   cd backend && npm install 2>&1 | tail -30
   ```
2. For sqlite3 native module failures:
   ```bash
   npm rebuild sqlite3
   # If still failing, check node version compatibility
   node --version
   # Try clean install
   rm -rf node_modules package-lock.json && npm install
   ```
3. For network errors: Check npm registry access and proxy settings
4. For permission errors: Ensure correct user owns `node_modules`

**Prevention:**
- Pin exact dependency versions in `package-lock.json`
- Use multi-stage Docker builds with cached layers
- Keep a known-good `node_modules` archive for rollback

---

### 4.2 Frontend Build Failure (Severity: P2)

**Symptoms:**
- `npm run build` fails in CI/CD or deployment
- TypeScript compilation errors
- Vite build errors

**Response:**
1. Check build output:
   ```bash
   cd frontend && npm run build 2>&1
   ```
2. For TypeScript errors: Review recent changes to `src/` files
3. For missing dependencies: `npm install`
4. For Vite config issues: Verify `vite.config.ts` and environment variables
5. If urgent: Deploy from last known good build artifact

**Prevention:**
- Run `npm run build` in CI before merge
- Use TypeScript strict mode consistently
- Pin Vite and TypeScript versions

---

### 4.3 Node.js Version Incompatibility (Severity: P3)

**Symptoms:**
- Syntax errors on startup (optional chaining, nullish coalescing)
- Native module loading failures
- "Unsupported engine" warnings

**Response:**
1. Check current version: `node --version`
2. Verify minimum required: Node.js 18+ (see `package.json` or Dockerfile)
3. Install correct version:
   ```bash
   nvm install 20
   nvm use 20
   ```
4. Rebuild native modules: `npm rebuild`

**Prevention:**
- Add `engines` field to `package.json`
- Use `.nvmrc` or `.node-version` file
- Pin Node version in Dockerfile and CI

---

## 5. Authentication Failures

### 5.1 Auth Middleware Rejecting Valid Requests (Severity: P1)

**Symptoms:**
- All authenticated endpoints return 401
- Users cannot access clients, work entries, or reports
- Login succeeds but subsequent requests fail

**Response:**
1. Verify auth header is being sent:
   ```bash
   curl -H "x-user-email: test@example.com" http://localhost:3001/api/auth/me
   ```
2. Check if the database contains the user:
   ```bash
   sqlite3 $DATABASE_PATH "SELECT * FROM users WHERE email='test@example.com';"
   ```
3. If in-memory DB: User may have been lost on restart — re-login to recreate
4. Check for proxy stripping headers (especially `x-user-email`)

**Prevention:**
- Add auth diagnostic endpoint
- Log authentication failures with request details
- Monitor 401 error rate

---

### 5.2 Login Rate Limit Lockout (Severity: P3)

**Symptoms:**
- Login returns 429 after multiple attempts
- Legitimate users locked out

**Response:**
1. Wait for 15-minute window to expire
2. If urgent, restart the backend (rate limit state is in-memory)
3. Check if an automated process is hammering the login endpoint

**Prevention:**
- Implement per-user rate limiting (not just per-IP)
- Add login rate limit bypass for known internal IPs
- Provide admin endpoint to reset rate limits

---

## 6. Frontend Failures

### 6.1 Frontend Cannot Reach Backend (Severity: P1)

**Symptoms:**
- UI shows "Network Error" or loading spinners indefinitely
- Browser console shows CORS errors or connection refused
- Health check from browser fails

**Response:**
1. Verify backend is running: `curl http://localhost:3001/health`
2. Check CORS configuration:
   - `FRONTEND_URL` in `.env` must match the frontend origin
   - In dev: should be `http://localhost:5173`
3. Check Vite proxy config (`frontend/vite.config.ts`) in development
4. In production: Verify reverse proxy / load balancer routing

**Prevention:**
- Add CORS origin to health check response for debugging
- Configure fallback CORS origins
- Monitor backend connectivity from frontend (heartbeat)

---

### 6.2 Frontend Build Serves Stale Assets (Severity: P3)

**Symptoms:**
- Users see old UI after deployment
- New features not appearing
- JavaScript errors from version mismatch

**Response:**
1. Instruct users to hard-refresh: `Ctrl+Shift+R`
2. Verify CDN/cache headers are correct
3. Confirm latest build was deployed:
   ```bash
   ls -la frontend/dist/assets/
   ```
4. Purge CDN cache if applicable

**Prevention:**
- Vite includes content hashes in filenames by default
- Set appropriate `Cache-Control` headers
- Implement service worker update notification

---

## 7. Infrastructure & Deployment Failures

### 7.1 Docker Container Health Check Failing (Severity: P2)

**Symptoms:**
- Container marked unhealthy by orchestrator
- Automatic restarts triggered
- Intermittent availability

**Response:**
1. Check container health:
   ```bash
   docker inspect --format='{{json .State.Health}}' timesheet-app
   ```
2. Check health check endpoint manually:
   ```bash
   docker exec timesheet-app node -e "require('http').get('http://localhost:3001/health', (r) => { console.log(r.statusCode); r.resume(); })"
   ```
3. Review resource constraints (CPU/memory limits)
4. Check for port binding issues inside container

**Prevention:**
- Tune health check intervals and thresholds
- Ensure health check is lightweight
- Add readiness vs liveness check distinction

---

### 7.2 Port Conflict on Startup (Severity: P2)

**Symptoms:**
- Server fails to start with `EADDRINUSE`
- Another process occupying port 3001

**Response:**
1. Find the conflicting process:
   ```bash
   lsof -i :3001
   # or
   ss -tlnp | grep 3001
   ```
2. Kill the conflicting process or change the port:
   ```bash
   kill -9 $(lsof -t -i :3001)
   # or set PORT=3002 in .env
   ```
3. Restart the application

**Prevention:**
- Use unique ports per environment
- Implement graceful shutdown to release ports
- Add port conflict detection to startup script

---

### 7.3 Disk Space Exhaustion (Severity: P2)

**Symptoms:**
- CSV/PDF exports fail
- Database writes fail (file-based SQLite)
- Log files consuming all space

**Response:**
1. Check disk usage:
   ```bash
   df -h
   du -sh /var/log/timesheet/ backend/temp/
   ```
2. Clean temp files: `find backend/temp/ -mmin +60 -delete`
3. Rotate logs: `logrotate -f /etc/logrotate.d/timesheet`
4. Remove old Docker images: `docker system prune`

**Prevention:**
- Set up log rotation
- Monitor disk usage with alerts at 80% threshold
- Implement temp file TTL cleanup
- Set max log file size

---

## Escalation Matrix

| Severity | Response Time | Escalation Path |
|----------|--------------|-----------------|
| P1 - Critical | 15 min | On-call engineer -> Team lead -> Engineering manager |
| P2 - High | 1 hour | On-call engineer -> Team lead |
| P3 - Medium | 4 hours | Assigned engineer |
| P4 - Low | Next business day | Backlog triage |

---

## Monitoring Checklist

- [ ] Health endpoint (`/health`) returning 200
- [ ] Backend process running and responsive
- [ ] Memory usage below 80% of limit
- [ ] Disk usage below 80%
- [ ] Error rate below 1% of total requests
- [ ] Response time p95 below 2 seconds
- [ ] No rate limit triggers on internal monitoring
- [ ] Database responsive (if file-based)

---

## Contact Information

| Role | Contact |
|------|---------|
| On-call Engineer | Check PagerDuty schedule |
| Team Lead | [Update with team lead contact] |
| DevOps | [Update with DevOps contact] |
| Product Owner | [Update with PO contact] |
