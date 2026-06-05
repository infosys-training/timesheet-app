# Timesheet Application - Incident Response Runbook

## Table of Contents

1. [Overview](#overview)
2. [Architecture Summary](#architecture-summary)
3. [Failure Mode: Database Issues](#failure-mode-database-issues)
4. [Failure Mode: API Errors](#failure-mode-api-errors)
5. [Failure Mode: Memory Leaks](#failure-mode-memory-leaks)
6. [Failure Mode: Dependency Failures](#failure-mode-dependency-failures)
7. [Failure Mode: Authentication Failures](#failure-mode-authentication-failures)
8. [Failure Mode: Rate Limiting](#failure-mode-rate-limiting)
9. [Failure Mode: File Export Failures](#failure-mode-file-export-failures)
10. [General Troubleshooting](#general-troubleshooting)
11. [Escalation Procedures](#escalation-procedures)
12. [Contact Information](#contact-information)

---

## Overview

This runbook provides step-by-step incident response procedures for the Timesheet Application. It covers common failure modes identified through codebase analysis and provides structured remediation guidance for on-call engineers.

**Application Stack:**
- Backend: Node.js + Express (port 3001)
- Frontend: React + TypeScript + Vite (port 5173)
- Database: SQLite (in-memory)
- Authentication: Email-based via `x-user-email` header
- Reports: PDF (pdfkit) and CSV (csv-writer) generation

---

## Architecture Summary

```
[Browser] --> [Vite Dev Server :5173] --proxy /api--> [Express :3001] --> [SQLite :memory:]
                                                          |
                                                    [Rate Limiter]
                                                    [Helmet Security]
                                                    [Morgan Logging]
```

**Critical Endpoints:**
- `GET /health` - Health check (no auth required)
- `POST /api/auth/login` - User authentication
- `GET /api/auth/me` - Current user info
- `GET /api/clients` - List clients
- `GET /api/work-entries` - List work entries
- `GET /api/reports/client/:id` - Client report
- `GET /api/reports/export/csv/:id` - CSV export
- `GET /api/reports/export/pdf/:id` - PDF export

---

## Failure Mode: Database Issues

### Symptoms
- HTTP 500 responses with `"Database error"` message
- Server fails to start with `"Failed to start server"` log
- Data loss after application restart (expected with in-memory DB)
- `SQLITE_` prefixed error codes in logs

### Diagnosis Steps

1. **Check server logs for SQLite errors:**
   ```bash
   # If using Docker
   docker logs <container_id> 2>&1 | grep -i "sqlite\|database"

   # If running locally
   cat backend/logs/*.log | grep -i "sqlite\|database"
   # Or check stdout/stderr from the Node process
   ```

2. **Verify database initialization:**
   ```bash
   curl -s http://localhost:3001/health | jq .
   # Expected: {"status":"OK","timestamp":"..."}
   # If this fails, the DB likely failed to initialize
   ```

3. **Check for lock contention (file-based SQLite in production):**
   ```bash
   # Check if multiple processes are accessing the DB file
   fuser backend/data/*.db 2>/dev/null
   lsof | grep sqlite
   ```

4. **Verify sqlite3 native bindings:**
   ```bash
   cd backend && node -e "const sqlite3 = require('sqlite3'); console.log('OK:', sqlite3.VERSION)"
   ```

### Resolution Steps

1. **Database initialization failure:**
   ```bash
   # Restart the application to re-initialize in-memory DB
   # All data will be reset (expected behavior for in-memory mode)
   cd backend && npm run dev
   ```

2. **Corrupted sqlite3 native bindings:**
   ```bash
   cd backend
   rm -rf node_modules/sqlite3
   npm install sqlite3 --build-from-source
   ```

3. **Data loss after restart (production):**
   - Switch to file-based SQLite by modifying `backend/src/database/init.js`
   - Change `:memory:` to a file path: `./data/timesheet.db`
   - Ensure the data directory exists and has write permissions

4. **Schema migration issues:**
   ```bash
   # The app uses CREATE TABLE IF NOT EXISTS, so schema should auto-create
   # If tables are missing, restart the application
   cd backend && npm restart
   ```

### Prevention
- Implement database health checks in the `/health` endpoint
- Use file-based SQLite or PostgreSQL for production persistence
- Add automated backups for file-based databases
- Monitor for SQLITE_BUSY errors indicating lock contention

---

## Failure Mode: API Errors

### Symptoms
- HTTP 400 responses: Validation errors (Joi)
- HTTP 404 responses: Resource not found
- HTTP 500 responses: Unhandled internal errors
- Timeouts on API calls (frontend has 10s timeout)

### Diagnosis Steps

1. **Check application logs:**
   ```bash
   # Morgan logs all requests in 'combined' format
   # Look for 4xx/5xx status codes
   docker logs <container_id> 2>&1 | grep -E "\" [45][0-9]{2} "
   ```

2. **Test specific endpoints:**
   ```bash
   # Health check
   curl -s http://localhost:3001/health

   # Auth test
   curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/auth/me

   # Clients list
   curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients
   ```

3. **Check for unhandled promise rejections:**
   ```bash
   # Look for UnhandledPromiseRejection in process output
   docker logs <container_id> 2>&1 | grep -i "unhandled\|rejection"
   ```

### Resolution Steps

1. **Validation errors (400):**
   - Check request payload matches Joi schema in `backend/src/validation/schemas.js`
   - Common issues: missing required fields, invalid email format, invalid date format

2. **Internal server errors (500):**
   ```bash
   # Restart the application
   cd backend && npm run dev

   # If persistent, check for resource exhaustion
   free -h
   df -h
   ```

3. **Timeout errors:**
   - Check if the database is responding (see Database Issues section)
   - Check system resources (CPU, memory, disk I/O)
   - Verify network connectivity between frontend proxy and backend

### Prevention
- Add request correlation IDs for tracing
- Implement structured logging (JSON format)
- Set up alerting on 5xx error rate thresholds
- Add circuit breakers for external dependencies

---

## Failure Mode: Memory Leaks

### Symptoms
- Increasing memory usage over time (monitor with `process.memoryUsage()`)
- Application becomes unresponsive
- Node.js OOM (Out of Memory) crashes
- Slow response times that degrade over time

### Diagnosis Steps

1. **Check current memory usage:**
   ```bash
   # Check Node.js process memory
   ps aux | grep node | grep -v grep
   # Look at RSS (Resident Set Size) column

   # Check system memory
   free -h
   ```

2. **Monitor memory growth:**
   ```bash
   # Watch memory usage over time
   watch -n 5 "ps -o pid,rss,vsz,comm -p $(pgrep -f 'node.*server.js')"
   ```

3. **Identify potential leak sources:**
   - In-memory SQLite database growing with data accumulation
   - Temp files from CSV/PDF exports not being cleaned up
   - Large request body accumulation (10MB limit per request)
   - Event listener leaks from database callbacks

4. **Check temp file accumulation:**
   ```bash
   ls -la backend/temp/
   du -sh backend/temp/
   # Files should be cleaned up after download, but failures may leave orphans
   ```

### Resolution Steps

1. **Immediate relief - restart the application:**
   ```bash
   # Graceful restart
   kill -SIGTERM $(pgrep -f 'node.*server.js')
   cd backend && npm run dev
   ```

2. **Clean up orphaned temp files:**
   ```bash
   # Remove temp files older than 1 hour
   find backend/temp/ -type f -mmin +60 -delete
   ```

3. **Reduce memory pressure:**
   ```bash
   # Set Node.js max heap size
   NODE_OPTIONS="--max-old-space-size=512" npm run dev
   ```

4. **For persistent issues, enable heap profiling:**
   ```bash
   # Start with heap profiling
   node --inspect --max-old-space-size=512 src/server.js
   # Connect Chrome DevTools to chrome://inspect for heap snapshots
   ```

### Prevention
- Implement periodic temp file cleanup (cron job or scheduled task)
- Set memory limits in Docker: `docker run --memory=512m`
- Add memory usage to health check endpoint
- Implement data retention policies for in-memory database
- Consider pagination for large result sets

---

## Failure Mode: Dependency Failures

### Symptoms
- `npm install` failures
- Native module compilation errors (sqlite3)
- Version conflicts in node_modules
- Security vulnerabilities (CVE alerts)
- Application crashes on startup due to missing modules

### Diagnosis Steps

1. **Check Node.js and npm versions:**
   ```bash
   node --version
   npm --version
   ```

2. **Verify dependencies are installed:**
   ```bash
   cd backend && npm ls --depth=0
   cd frontend && npm ls --depth=0
   ```

3. **Check for security vulnerabilities:**
   ```bash
   cd backend && npm audit
   cd frontend && npm audit
   ```

4. **Check for native module issues:**
   ```bash
   # sqlite3 requires native compilation
   cd backend && node -e "require('sqlite3')"
   ```

### Resolution Steps

1. **Missing dependencies:**
   ```bash
   cd backend && rm -rf node_modules package-lock.json && npm install
   cd frontend && rm -rf node_modules package-lock.json && npm install
   ```

2. **Native module rebuild (sqlite3):**
   ```bash
   cd backend
   npm rebuild sqlite3
   # If that fails:
   npm install sqlite3 --build-from-source
   ```

3. **Version conflicts:**
   ```bash
   # Check for peer dependency issues
   npm ls 2>&1 | grep "ERESOLVE\|peer dep"
   # Fix with legacy peer deps if needed
   npm install --legacy-peer-deps
   ```

4. **Security vulnerability remediation:**
   ```bash
   # Auto-fix where possible
   npm audit fix
   # For breaking changes
   npm audit fix --force  # Use with caution
   ```

### Prevention
- Pin dependency versions in package.json
- Use `package-lock.json` for reproducible builds
- Set up automated dependency update PRs (Dependabot/Renovate)
- Run `npm audit` in CI pipeline (already configured in sast-scan.yml)
- Keep Node.js version up to date

---

## Failure Mode: Authentication Failures

### Symptoms
- HTTP 401 responses on all authenticated endpoints
- Users unable to log in
- Frontend redirects to `/login` repeatedly
- `"User email required in x-user-email header"` errors

### Diagnosis Steps

1. **Verify auth header is being sent:**
   ```bash
   # Test with explicit header
   curl -v -H "x-user-email: test@example.com" http://localhost:3001/api/auth/me
   ```

2. **Check localStorage in browser:**
   - Open DevTools > Application > Local Storage
   - Verify `userEmail` key exists and has a valid email

3. **Check CORS configuration:**
   ```bash
   # Verify FRONTEND_URL env var
   cat backend/.env | grep FRONTEND_URL
   # Should match the origin making requests
   ```

4. **Test user creation:**
   ```bash
   curl -s -H "x-user-email: newuser@example.com" http://localhost:3001/api/auth/me
   # Should auto-create user and return success
   ```

### Resolution Steps

1. **CORS blocking requests:**
   ```bash
   # Update FRONTEND_URL in backend/.env
   echo "FRONTEND_URL=http://localhost:5173" >> backend/.env
   # Restart backend
   ```

2. **Browser localStorage cleared:**
   - User needs to re-login at `/login`
   - The app will set `userEmail` in localStorage upon successful login

3. **Database unable to create user:**
   - See [Database Issues](#failure-mode-database-issues) section
   - Restart application to reinitialize database

### Prevention
- Add auth-specific health check endpoint
- Implement session expiry notifications
- Add frontend retry logic for transient auth failures
- Monitor auth failure rates for anomaly detection

---

## Failure Mode: Rate Limiting

### Symptoms
- HTTP 429 (Too Many Requests) responses
- Users report being "locked out" temporarily
- Legitimate bulk operations failing

### Diagnosis Steps

1. **Check current rate limit configuration:**
   - Limit: 100 requests per 15-minute window per IP
   - Configured in `backend/src/server.js`

2. **Identify affected IPs:**
   ```bash
   # Check Morgan access logs for 429 responses
   docker logs <container_id> 2>&1 | grep "\" 429 "
   ```

3. **Verify if legitimate traffic or abuse:**
   ```bash
   # Count requests per IP in last 15 minutes
   docker logs <container_id> --since 15m 2>&1 | awk '{print $1}' | sort | uniq -c | sort -rn | head
   ```

### Resolution Steps

1. **Temporary relief for legitimate users:**
   ```bash
   # Restart the application to reset rate limit counters
   # (counters are stored in-memory)
   cd backend && npm run dev
   ```

2. **Adjust rate limits if too aggressive:**
   - Edit `backend/src/server.js`, modify the `rateLimit` configuration
   - Consider per-endpoint rate limits for heavy operations (exports)

3. **Block abusive IPs:**
   ```bash
   # If behind a reverse proxy/load balancer
   # Add IP to blocklist at the proxy level
   ```

### Prevention
- Implement per-user rate limiting (not just per-IP)
- Add rate limit headers to responses (`X-RateLimit-Remaining`)
- Set higher limits for authenticated users
- Implement exponential backoff in the frontend client

---

## Failure Mode: File Export Failures

### Symptoms
- CSV/PDF downloads fail or return empty
- HTTP 500 on `/api/reports/export/csv/:id` or `/api/reports/export/pdf/:id`
- Disk space warnings
- Temp files accumulating in `backend/temp/`

### Diagnosis Steps

1. **Check disk space:**
   ```bash
   df -h
   du -sh backend/temp/
   ```

2. **Verify temp directory exists and is writable:**
   ```bash
   ls -la backend/temp/
   # If missing:
   mkdir -p backend/temp
   ```

3. **Test export manually:**
   ```bash
   curl -s -H "x-user-email: test@example.com" \
     http://localhost:3001/api/reports/export/csv/1 -o test.csv
   file test.csv
   ```

4. **Check for file handle leaks:**
   ```bash
   lsof -p $(pgrep -f 'node.*server.js') | wc -l
   ```

### Resolution Steps

1. **Temp directory missing:**
   ```bash
   mkdir -p backend/temp
   chmod 755 backend/temp
   ```

2. **Disk full:**
   ```bash
   # Clean temp files
   rm -f backend/temp/*.csv backend/temp/*.pdf
   # Check for other large files
   du -sh /* 2>/dev/null | sort -rh | head
   ```

3. **PDF generation crash (pdfkit):**
   ```bash
   # Verify pdfkit installation
   cd backend && node -e "const PDFDocument = require('pdfkit'); console.log('OK')"
   # Reinstall if needed
   npm install pdfkit
   ```

4. **CSV writer failure:**
   ```bash
   # Verify csv-writer installation
   cd backend && node -e "const csv = require('csv-writer'); console.log('OK')"
   ```

### Prevention
- Implement streaming responses instead of temp files
- Add scheduled cleanup of orphaned temp files
- Set disk space alerts
- Implement file size limits for exports
- Monitor temp directory size

---

## General Troubleshooting

### Application Won't Start

```bash
# 1. Check if port is already in use
lsof -i :3001
lsof -i :5173

# 2. Kill existing processes
kill $(lsof -t -i :3001)
kill $(lsof -t -i :5173)

# 3. Verify environment
cat backend/.env
cat frontend/.env

# 4. Reinstall dependencies
cd backend && npm install
cd frontend && npm install

# 5. Start services
cd backend && npm run dev &
cd frontend && npm run dev &
```

### Frontend Cannot Reach Backend

```bash
# 1. Check Vite proxy config
cat frontend/vite.config.ts
# Verify proxy target is http://localhost:3001

# 2. Verify backend is running
curl -s http://localhost:3001/health

# 3. Check for CORS issues in browser console
# Look for "Access-Control-Allow-Origin" errors

# 4. Verify FRONTEND_URL in backend .env matches frontend origin
```

### Docker Deployment Issues

```bash
# 1. Build and start
docker build -f docker/Dockerfile -t timesheet-app .
docker run -p 3001:3001 timesheet-app

# 2. Check container logs
docker logs <container_id>

# 3. Exec into container for debugging
docker exec -it <container_id> /bin/sh
```

---

## Escalation Procedures

| Severity | Response Time | Escalation Path |
|----------|---------------|-----------------|
| P1 - Critical | 15 minutes | On-call engineer -> Engineering Lead -> VP Engineering |
| P2 - High | 1 hour | On-call engineer -> Engineering Lead |
| P3 - Medium | 4 hours | On-call engineer -> Team Lead |
| P4 - Low | 24 hours | On-call engineer (next business day) |

### P1 Criteria
- Complete application outage
- Data loss or corruption
- Security breach

### P2 Criteria
- Major feature unavailable (e.g., all exports failing)
- Performance degradation affecting all users
- Authentication system down

### P3 Criteria
- Single feature degraded
- Intermittent errors affecting some users
- Non-critical dependency failure

### P4 Criteria
- Cosmetic issues
- Minor performance degradation
- Documentation/logging improvements needed

---

## Contact Information

| Role | Contact |
|------|---------|
| On-call Engineer | Check PagerDuty schedule |
| Engineering Lead | See team directory |
| DevOps/Infrastructure | See team directory |
| Security Team | See team directory |

---

## Appendix: Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Backend server port |
| `NODE_ENV` | `development` | Environment mode |
| `FRONTEND_URL` | `http://localhost:5173` | Allowed CORS origin |
| `JWT_SECRET` | (see .env) | JWT signing key |

## Appendix: Health Check Script

See `scripts/health-check.sh` for an automated health check script that tests all critical endpoints and dependencies.
