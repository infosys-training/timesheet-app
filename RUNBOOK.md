# Timesheet Application - Incident Response Runbook

This document provides step-by-step response procedures for common failure modes in the Timesheet Application. All on-call engineers should be familiar with this runbook before taking on-call shifts.

---

## Table of Contents

- [System Overview](#system-overview)
- [Severity Definitions](#severity-definitions)
- [Incident Response Workflow](#incident-response-workflow)
- [Failure Mode 1: Database Failures](#failure-mode-1-database-failures)
- [Failure Mode 2: API Errors and Express Server Failures](#failure-mode-2-api-errors-and-express-server-failures)
- [Failure Mode 3: Memory Leaks and Resource Exhaustion](#failure-mode-3-memory-leaks-and-resource-exhaustion)
- [Failure Mode 4: Authentication Failures](#failure-mode-4-authentication-failures)
- [Failure Mode 5: Dependency and Third-Party Failures](#failure-mode-5-dependency-and-third-party-failures)
- [Failure Mode 6: Report Generation Failures (PDF/CSV)](#failure-mode-6-report-generation-failures-pdfcsv)
- [Failure Mode 7: Frontend Application Failures](#failure-mode-7-frontend-application-failures)
- [Failure Mode 8: Docker and Deployment Failures](#failure-mode-8-docker-and-deployment-failures)
- [Failure Mode 9: Rate Limiting and CORS Issues](#failure-mode-9-rate-limiting-and-cors-issues)
- [Failure Mode 10: Data Loss (In-Memory Database)](#failure-mode-10-data-loss-in-memory-database)
- [Escalation Matrix](#escalation-matrix)
- [Post-Incident Review Template](#post-incident-review-template)

---

## System Overview

| Component      | Technology         | Port | Notes                                        |
| -------------- | ------------------ | ---- | -------------------------------------------- |
| Backend API    | Node.js + Express  | 3001 | Serves REST API and static frontend in prod  |
| Frontend       | React + Vite       | 5173 | Dev server; served by backend in production  |
| Database       | SQLite             | N/A  | In-memory (dev), file-based (prod at `/app/data/timesheet.db`) |
| Auth           | Email + x-user-email header | N/A  | No passwords; email-only auth         |
| Container      | Docker (node:20-alpine) | 3001 | Uses dumb-init for signal handling       |

### Key Endpoints

| Endpoint                          | Purpose                     |
| --------------------------------- | --------------------------- |
| `GET /health`                     | Health check                |
| `POST /api/auth/login`            | User login                  |
| `GET /api/auth/me`                | Current user info           |
| `GET /api/clients`                | List clients                |
| `GET /api/work-entries`           | List work entries           |
| `GET /api/reports/client/:id`     | Client report               |
| `GET /api/reports/export/csv/:id` | CSV export                  |
| `GET /api/reports/export/pdf/:id` | PDF export                  |

---

## Severity Definitions

| Severity | Definition                                            | Response Time | Resolution Target |
| -------- | ----------------------------------------------------- | ------------- | ----------------- |
| **P1**   | Service completely down; all users affected            | 15 minutes    | 1 hour            |
| **P2**   | Major feature broken; significant user impact          | 30 minutes    | 4 hours           |
| **P3**   | Minor feature degraded; workaround available           | 2 hours       | 24 hours          |
| **P4**   | Cosmetic or low-impact issue                           | 1 business day| 1 week            |

---

## Incident Response Workflow

```
1. DETECT   -> Alert fires or user reports issue
2. TRIAGE   -> Determine severity (P1-P4) and assign responder
3. DIAGNOSE -> Use this runbook to identify failure mode
4. MITIGATE -> Apply immediate fix or workaround
5. RESOLVE  -> Deploy permanent fix
6. REVIEW   -> Conduct post-incident review within 48 hours
```

---

## Failure Mode 1: Database Failures

### Symptoms
- HTTP 500 responses with `"Database error"` message
- Backend logs show `SQLITE_` prefixed errors (e.g., `SQLITE_BUSY`, `SQLITE_CORRUPT`, `SQLITE_CANTOPEN`)
- `/health` returns 200 but API calls return 500
- Data queries return empty results unexpectedly

### Severity
- **P1** if all database operations fail (total service outage)
- **P2** if intermittent or affecting specific operations only

### Diagnosis Steps

1. **Check backend logs for SQLite errors:**
   ```bash
   # Docker
   docker logs <container_id> 2>&1 | grep -i "sqlite\|database error"

   # Non-Docker
   journalctl -u timesheet-backend | grep -i "sqlite\|database error"
   ```

2. **Verify database connectivity:**
   ```bash
   curl -s http://localhost:3001/health | jq .
   # Then test an authenticated endpoint:
   curl -s -H "x-user-email: test@test.com" http://localhost:3001/api/clients | jq .
   ```

3. **Check database file (production file-based SQLite):**
   ```bash
   # Verify database file exists and is not corrupt
   ls -la /app/data/timesheet.db
   sqlite3 /app/data/timesheet.db "PRAGMA integrity_check;"
   ```

4. **Check disk space (production):**
   ```bash
   df -h /app/data
   ```

### Resolution Steps

**In-memory database (development):**
1. Restart the backend server - this re-initializes the in-memory database:
   ```bash
   # The in-memory database is recreated on restart
   npm run dev  # Development
   ```
2. Note: All data will be lost on restart. This is expected behavior for in-memory SQLite.

**File-based database (production/Docker):**
1. **If SQLITE_BUSY:** Wait for concurrent operations to complete. If persistent, restart the container:
   ```bash
   docker restart <container_id>
   ```
2. **If SQLITE_CORRUPT:** Restore from the most recent backup:
   ```bash
   # Stop the container
   docker stop <container_id>
   # Restore backup
   cp /backups/timesheet.db.latest /app/data/timesheet.db
   # Restart
   docker start <container_id>
   ```
3. **If SQLITE_CANTOPEN (disk full):**
   ```bash
   # Clear temp files
   rm -rf /app/backend/temp/*
   # Clear old logs
   find /var/log -name "*.log" -mtime +7 -delete
   # Verify space freed
   df -h /app/data
   ```

### Prevention
- Set up database file backups on a regular schedule
- Monitor disk usage and alert at 80% capacity
- Consider migrating to PostgreSQL for high-availability requirements

---

## Failure Mode 2: API Errors and Express Server Failures

### Symptoms
- Backend process crashes or becomes unresponsive
- Health check (`GET /health`) times out or returns non-200
- Frontend shows network errors or blank pages
- `EADDRINUSE` error on startup (port 3001 already in use)

### Severity
- **P1** if server process is down
- **P2** if specific routes are failing

### Diagnosis Steps

1. **Check if the process is running:**
   ```bash
   # Docker
   docker ps | grep timesheet
   docker logs --tail 50 <container_id>

   # Non-Docker
   ps aux | grep "node src/server.js"
   lsof -i :3001
   ```

2. **Test health endpoint:**
   ```bash
   curl -w "\n%{http_code}" http://localhost:3001/health
   ```

3. **Check for unhandled errors in logs:**
   ```bash
   docker logs <container_id> 2>&1 | grep -i "error\|unhandled\|crash\|EADDRINUSE"
   ```

4. **Test individual routes:**
   ```bash
   # Auth
   curl -s -X POST http://localhost:3001/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"test@test.com"}' | jq .

   # Clients
   curl -s -H "x-user-email: test@test.com" http://localhost:3001/api/clients | jq .
   ```

### Resolution Steps

1. **If process is not running, restart it:**
   ```bash
   # Docker
   docker restart <container_id>

   # Non-Docker (development)
   cd backend && npm run dev

   # Non-Docker (production)
   cd backend && npm start
   ```

2. **If port is in use (EADDRINUSE):**
   ```bash
   # Find and kill the process holding the port
   lsof -ti :3001 | xargs kill -9
   # Restart the service
   docker restart <container_id>
   ```

3. **If specific route is failing, check error handler middleware:**
   - Review `backend/src/middleware/errorHandler.js` for unhandled error types
   - Check route-specific logic in `backend/src/routes/`

### Prevention
- Use process managers (PM2, Docker with restart policies) in production
- Implement structured logging for faster diagnosis
- Add integration tests for all API routes

---

## Failure Mode 3: Memory Leaks and Resource Exhaustion

### Symptoms
- Increasing memory usage over time
- Slow response times that degrade progressively
- Node.js process crashes with `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory`
- Docker container killed by OOM (Out Of Memory) killer

### Severity
- **P1** if causing server crashes
- **P3** if gradual degradation without immediate impact

### Diagnosis Steps

1. **Check container resource usage:**
   ```bash
   docker stats <container_id>
   ```

2. **Check Node.js heap usage:**
   ```bash
   # Get memory stats from inside the container
   docker exec <container_id> node -e "console.log(process.memoryUsage())"
   ```

3. **Check host system resources:**
   ```bash
   free -h
   top -bn1 | head -20
   ```

4. **Review potential leak sources:**
   - Large PDF/CSV report generation (PDFKit streams, csv-writer temp files)
   - Unclosed database connections
   - Accumulating Express middleware state
   - Temp files not cleaned up in `backend/temp/`

### Resolution Steps

1. **Immediate mitigation - restart the service:**
   ```bash
   docker restart <container_id>
   ```

2. **Clean up temp files:**
   ```bash
   # Docker
   docker exec <container_id> rm -rf /app/temp/*

   # Non-Docker
   rm -rf backend/temp/*
   ```

3. **Set Node.js memory limits:**
   ```bash
   # In Docker CMD or environment
   NODE_OPTIONS="--max-old-space-size=512"
   ```

4. **If caused by large report exports:**
   - Check for stuck/long-running report generation requests
   - Consider adding request size limits or pagination

### Prevention
- Set Docker memory limits: `docker run --memory=512m`
- Monitor memory usage with alerts at 80% of limit
- Implement request timeouts for report generation endpoints
- Ensure temp files are cleaned up after CSV/PDF export (verify `fs.unlink` runs)

---

## Failure Mode 4: Authentication Failures

### Symptoms
- Users receive 401 `"User email required in x-user-email header"` errors
- Login endpoint (`POST /api/auth/login`) returns 400 or 500
- Frontend redirects to login page repeatedly
- `localStorage` email value is missing or corrupt

### Severity
- **P2** if affecting all users
- **P3** if affecting specific users

### Diagnosis Steps

1. **Test login flow:**
   ```bash
   # Test login
   curl -s -X POST http://localhost:3001/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com"}' | jq .

   # Test authenticated request
   curl -s -H "x-user-email: test@example.com" \
     http://localhost:3001/api/auth/me | jq .
   ```

2. **Check if user exists in database:**
   ```bash
   # Production (file-based SQLite)
   sqlite3 /app/data/timesheet.db "SELECT * FROM users LIMIT 10;"
   ```

3. **Check frontend localStorage (browser console):**
   ```javascript
   console.log(localStorage.getItem('userEmail'));
   ```

4. **Check validation errors:**
   ```bash
   # Invalid email should return 400
   curl -s -X POST http://localhost:3001/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"not-an-email"}' | jq .
   ```

### Resolution Steps

1. **If email header is missing in requests:**
   - Verify the frontend Axios interceptor is setting `x-user-email` header
   - Check `frontend/src/api/client.ts` request interceptor
   - Clear browser localStorage and re-login

2. **If database insert fails for new users:**
   - Check database write permissions
   - Verify the users table exists: `sqlite3 /app/data/timesheet.db ".tables"`
   - Reinitialize database if schema is missing

3. **If all authentication fails:**
   - Restart backend to reinitialize the database schema
   - Verify the `authenticateUser` middleware is correctly imported in routes

### Prevention
- Add monitoring for authentication error rates
- Implement session persistence mechanism beyond in-memory storage
- Consider adding SSO integration for production environments

---

## Failure Mode 5: Dependency and Third-Party Failures

### Symptoms
- `npm install` fails during deployment
- Module not found errors at runtime (e.g., `Cannot find module 'pdfkit'`)
- Vulnerability alerts from SAST scanning CI pipeline
- Docker build fails at dependency installation stage

### Severity
- **P1** if preventing deployment of critical fixes
- **P3** if only affecting CI/CD pipeline

### Diagnosis Steps

1. **Check for missing modules:**
   ```bash
   # Docker
   docker exec <container_id> ls node_modules/ | grep <module_name>

   # Non-Docker
   ls backend/node_modules/ | grep <module_name>
   ```

2. **Verify package-lock.json integrity:**
   ```bash
   cd backend && npm ci --dry-run
   cd frontend && npm ci --dry-run
   ```

3. **Check npm registry availability:**
   ```bash
   npm ping
   curl -s https://registry.npmjs.org/ | jq .db_name
   ```

4. **Review CI pipeline logs:**
   - Check `.github/workflows/pr-checks.yml` for build failures
   - Check `.github/workflows/sast-scan.yml` for security scan results

### Resolution Steps

1. **If npm install fails:**
   ```bash
   # Clear npm cache
   npm cache clean --force
   # Remove node_modules and reinstall
   rm -rf node_modules package-lock.json
   npm install
   ```

2. **If specific module is missing at runtime:**
   ```bash
   npm install <missing-module>
   ```

3. **If Docker build fails:**
   ```bash
   # Rebuild with no cache
   docker build --no-cache -f docker/Dockerfile -t timesheet-app .
   ```

4. **If npm registry is unavailable:**
   - Wait and retry (transient issue)
   - Configure a fallback registry or use a local npm mirror

### Prevention
- Pin dependency versions in `package.json`
- Use `npm ci` (not `npm install`) in CI/CD for deterministic builds
- Regularly run `npm audit` and update vulnerable packages
- Keep Docker base images updated (`node:20-alpine`)

---

## Failure Mode 6: Report Generation Failures (PDF/CSV)

### Symptoms
- CSV or PDF download endpoints return 500 errors
- Browser receives empty or corrupt file downloads
- Temp directory fills up with orphaned files
- Large reports cause timeouts

### Severity
- **P2** if report generation is a critical business function
- **P3** if limited to specific reports

### Diagnosis Steps

1. **Test report endpoints directly:**
   ```bash
   # First create test data
   curl -s -X POST http://localhost:3001/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"test@test.com"}'

   # Get client list
   curl -s -H "x-user-email: test@test.com" \
     http://localhost:3001/api/clients | jq .

   # Test report (replace :clientId with actual ID)
   curl -s -H "x-user-email: test@test.com" \
     http://localhost:3001/api/reports/client/1 | jq .

   # Test CSV export
   curl -s -H "x-user-email: test@test.com" \
     -o report.csv http://localhost:3001/api/reports/export/csv/1

   # Test PDF export
   curl -s -H "x-user-email: test@test.com" \
     -o report.pdf http://localhost:3001/api/reports/export/pdf/1
   ```

2. **Check temp directory:**
   ```bash
   ls -la backend/temp/
   du -sh backend/temp/
   ```

3. **Check for PDFKit or csv-writer errors in logs:**
   ```bash
   docker logs <container_id> 2>&1 | grep -i "pdf\|csv\|temp\|export"
   ```

### Resolution Steps

1. **Clean up orphaned temp files:**
   ```bash
   rm -rf backend/temp/*
   ```

2. **If disk is full:**
   ```bash
   df -h
   # Free space and retry
   ```

3. **If PDFKit crashes on large reports:**
   - Implement pagination for large datasets
   - Add a report size limit or streaming response

4. **If CSV writer fails:**
   - Verify write permissions to `backend/temp/` directory
   - Check that the directory exists: `mkdir -p backend/temp`

### Prevention
- Implement automatic cleanup of temp files older than 1 hour
- Add request timeouts for export endpoints
- Monitor temp directory size
- Consider streaming reports directly to the response instead of writing temp files

---

## Failure Mode 7: Frontend Application Failures

### Symptoms
- Blank white page on load
- React error boundaries triggering
- API calls failing from the browser (network errors in console)
- Vite dev server not starting (development)
- Build failures during deployment

### Severity
- **P1** if application is completely inaccessible
- **P2** if specific pages/features are broken

### Diagnosis Steps

1. **Check if frontend is accessible:**
   ```bash
   # Development
   curl -s http://localhost:5173 | head -20

   # Production (served by backend)
   curl -s http://localhost:3001 | head -20
   ```

2. **Check Vite dev server (development):**
   ```bash
   # Check if Vite is running
   lsof -i :5173
   ```

3. **Check browser console for errors:**
   - Open browser DevTools (F12) -> Console tab
   - Look for JavaScript errors, failed network requests

4. **Verify API proxy configuration (development):**
   - Check `frontend/vite.config.ts` for proxy settings
   - Ensure backend is running on port 3001

5. **Test the build process:**
   ```bash
   cd frontend && npm run build
   ```

### Resolution Steps

1. **If Vite dev server won't start:**
   ```bash
   cd frontend
   rm -rf node_modules/.vite  # Clear Vite cache
   npm run dev
   ```

2. **If build fails:**
   ```bash
   cd frontend
   npx tsc --noEmit  # Check TypeScript errors
   npm run lint       # Check lint errors
   npm run build      # Retry build
   ```

3. **If API proxy is not working:**
   - Verify backend is running: `curl http://localhost:3001/health`
   - Check Vite proxy config points to correct backend URL

4. **If blank page in production:**
   - Verify static files exist: `ls /app/public/` (Docker)
   - Check that backend is configured to serve static files

### Prevention
- Run `npm run build` in CI before deployment
- Add frontend error boundaries with user-friendly error messages
- Monitor frontend error rates using browser error tracking

---

## Failure Mode 8: Docker and Deployment Failures

### Symptoms
- Container fails to start or exits immediately
- Docker health check reports unhealthy
- Container runs out of memory
- Volume mount issues with database file

### Severity
- **P1** if production deployment fails
- **P2** if only affecting staging/dev

### Diagnosis Steps

1. **Check container status:**
   ```bash
   docker ps -a | grep timesheet
   docker inspect <container_id> | jq '.[0].State'
   ```

2. **Check container logs:**
   ```bash
   docker logs --tail 100 <container_id>
   ```

3. **Check health check status:**
   ```bash
   docker inspect <container_id> | jq '.[0].State.Health'
   ```

4. **Check volume mounts:**
   ```bash
   docker inspect <container_id> | jq '.[0].Mounts'
   ls -la /app/data/  # From inside the container
   ```

### Resolution Steps

1. **If container won't start:**
   ```bash
   # Check logs for startup errors
   docker logs <container_id>
   # Rebuild if image is corrupt
   docker build --no-cache -f docker/Dockerfile -t timesheet-app .
   docker run -d -p 3001:3001 -v timesheet-data:/app/data timesheet-app
   ```

2. **If health check fails:**
   ```bash
   # Test health manually from inside the container
   docker exec <container_id> node -e \
     "require('http').get('http://localhost:3001/health', (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>console.log(r.statusCode,d)); })"
   ```

3. **If volume permissions are wrong:**
   ```bash
   docker exec -u root <container_id> chown -R nodejs:nodejs /app/data
   ```

4. **If container is OOM killed:**
   ```bash
   # Increase memory limit
   docker update --memory=1g <container_id>
   # Or restart with higher limit
   docker run -d --memory=1g -p 3001:3001 timesheet-app
   ```

### Prevention
- Use Docker restart policies: `--restart=unless-stopped`
- Set resource limits in Docker Compose or orchestration config
- Use named volumes for database persistence
- Test Docker builds in CI pipeline

---

## Failure Mode 9: Rate Limiting and CORS Issues

### Symptoms
- HTTP 429 (Too Many Requests) responses
- Browser console shows CORS errors
- API calls blocked with `Access-Control-Allow-Origin` errors
- Legitimate users locked out due to rate limiting

### Severity
- **P2** if affecting production users
- **P3** if only in development

### Diagnosis Steps

1. **Test for rate limiting:**
   ```bash
   # Send multiple rapid requests
   for i in $(seq 1 105); do
     curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/health
   done | sort | uniq -c
   ```

2. **Check CORS configuration:**
   ```bash
   curl -s -I -X OPTIONS http://localhost:3001/api/clients \
     -H "Origin: http://localhost:5173" \
     -H "Access-Control-Request-Method: GET"
   ```

3. **Verify FRONTEND_URL environment variable:**
   ```bash
   # Docker
   docker exec <container_id> env | grep FRONTEND

   # Non-Docker
   grep FRONTEND_URL backend/.env
   ```

### Resolution Steps

1. **If rate limit is too restrictive:**
   - Current config: 100 requests per 15 minutes per IP
   - Temporarily increase in `backend/src/server.js` (line 27-29) or restart to reset counters

2. **If CORS is blocking legitimate requests:**
   - Verify `FRONTEND_URL` env var matches the actual frontend origin
   - For multiple origins, update CORS config in `backend/src/server.js`

3. **Quick CORS fix for development:**
   ```bash
   # Set correct frontend URL
   echo "FRONTEND_URL=http://localhost:5173" >> backend/.env
   # Restart backend
   ```

### Prevention
- Configure rate limits based on expected traffic patterns
- Use environment-specific CORS origins
- Add rate limit headers to responses for client-side handling

---

## Failure Mode 10: Data Loss (In-Memory Database)

### Symptoms
- All user data disappears after server restart
- Users report missing clients, work entries, or account
- Database re-initializes with empty tables

### Severity
- **P1** if in production with in-memory database
- **P3** if in development (expected behavior)

### Diagnosis Steps

1. **Check which database mode is active:**
   ```bash
   # Check if using file-based or in-memory SQLite
   grep -r "memory\|DATABASE_PATH" backend/src/database/init.js
   docker exec <container_id> env | grep DATABASE
   ```

2. **Check if database file exists (production):**
   ```bash
   ls -la /app/data/timesheet.db
   sqlite3 /app/data/timesheet.db "SELECT COUNT(*) FROM users;"
   ```

3. **Check container restart history:**
   ```bash
   docker inspect <container_id> | jq '.[0].RestartCount'
   ```

### Resolution Steps

1. **If running in-memory in production (critical):**
   - This is a configuration error. Switch to file-based SQLite immediately
   - The Docker image uses production overrides with file-based SQLite (`docker/overrides/database/init.js`)
   - Ensure the Docker deployment is using the correct Dockerfile

2. **If file-based database was lost:**
   - Restore from backup if available
   - If no backup, the database will be recreated with empty tables on restart

3. **To switch from in-memory to file-based (emergency):**
   ```bash
   # Set environment variable
   export DATABASE_PATH=/app/data/timesheet.db
   # Ensure the data directory exists
   mkdir -p /app/data
   # Restart the application
   ```

### Prevention
- **Never** use in-memory SQLite in production
- Implement automated database backups (at minimum daily)
- Use Docker volumes for database persistence
- Test backup restoration procedures regularly

---

## Escalation Matrix

| Severity | First Responder    | Escalation (30 min) | Executive Notify    |
| -------- | ------------------ | -------------------- | ------------------- |
| **P1**   | On-call engineer   | Engineering lead     | VP of Engineering   |
| **P2**   | On-call engineer   | Team lead            | Engineering manager |
| **P3**   | Assigned engineer  | Team lead (if stuck) | N/A                 |
| **P4**   | Sprint backlog     | N/A                  | N/A                 |

### Communication Channels

- **P1/P2 Incidents:** Post in `#incident-response` channel immediately
- **Status Updates:** Every 30 minutes for P1, every 2 hours for P2
- **Post-Incident:** Schedule review meeting within 48 hours

---

## Post-Incident Review Template

After resolving any P1 or P2 incident, complete the following:

```markdown
## Post-Incident Review

**Incident Date:** YYYY-MM-DD
**Severity:** P1/P2
**Duration:** X hours Y minutes
**Responders:** [names]

### Timeline
- HH:MM - Issue detected by [alert/user report]
- HH:MM - Responder acknowledged
- HH:MM - Root cause identified
- HH:MM - Mitigation applied
- HH:MM - Full resolution confirmed

### Root Cause
[Description of what caused the incident]

### Impact
- Users affected: [number/percentage]
- Data lost: [yes/no, details]
- Revenue impact: [if applicable]

### What Went Well
- [Item 1]
- [Item 2]

### What Could Be Improved
- [Item 1]
- [Item 2]

### Action Items
- [ ] [Action item 1] - Owner: [name] - Due: [date]
- [ ] [Action item 2] - Owner: [name] - Due: [date]
```
