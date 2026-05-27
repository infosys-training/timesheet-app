# Timesheet App Runbook

Incident response procedures for the Employee Time Tracking Application.

---

## Table of Contents

1. [Service Overview](#service-overview)
2. [Contacts and Escalation](#contacts-and-escalation)
3. [Failure Mode: Backend Server Unresponsive](#failure-mode-backend-server-unresponsive)
4. [Failure Mode: Database Failures](#failure-mode-database-failures)
5. [Failure Mode: API Errors (5xx)](#failure-mode-api-errors-5xx)
6. [Failure Mode: Authentication Failures](#failure-mode-authentication-failures)
7. [Failure Mode: Memory Leaks / High Resource Usage](#failure-mode-memory-leaks--high-resource-usage)
8. [Failure Mode: Rate Limiting Blocking Legitimate Traffic](#failure-mode-rate-limiting-blocking-legitimate-traffic)
9. [Failure Mode: Report Generation Failures (PDF/CSV)](#failure-mode-report-generation-failures-pdfcsv)
10. [Failure Mode: Frontend Build or Proxy Failures](#failure-mode-frontend-build-or-proxy-failures)
11. [Failure Mode: Dependency / npm Failures](#failure-mode-dependency--npm-failures)
12. [Failure Mode: Docker Container Health Check Failures](#failure-mode-docker-container-health-check-failures)
13. [Failure Mode: CORS Misconfiguration](#failure-mode-cors-misconfiguration)
14. [Post-Incident Checklist](#post-incident-checklist)

---

## Service Overview

| Component | Technology | Default Port | Notes |
|-----------|-----------|-------------|-------|
| Backend API | Node.js / Express | 3001 | Serves REST API, generates PDF/CSV reports |
| Frontend SPA | React / Vite | 5173 (dev) | Proxies `/api` to backend in dev mode |
| Database | SQLite | N/A | In-memory (dev), file-based (production) |
| Auth | x-user-email header | N/A | Email-only, no password |
| Containerization | Docker | 3001 | Multi-stage build, dumb-init for signal handling |

**Health check endpoint:** `GET /health` returns `{ "status": "OK", "timestamp": "..." }`

---

## Contacts and Escalation

| Role | Contact | Escalation Time |
|------|---------|----------------|
| On-call Engineer | (team distribution list / PagerDuty) | Immediate for P1 |
| Engineering Manager | (update with contact) | 15 min for P1, 1 hour for P2 |
| Product Owner | (update with contact) | 30 min for P1 |

---

## Failure Mode: Backend Server Unresponsive

### Symptoms
- `/health` endpoint returns non-200 or times out.
- Frontend displays network errors or loading spinners indefinitely.
- Docker health check reports `unhealthy`.

### Diagnosis

```bash
# 1. Check if the process is running
ps aux | grep "node src/server.js"

# 2. Check health endpoint
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health

# 3. Check application logs
docker logs <container_id> --tail 100    # Docker
journalctl -u timesheet-backend --since "10 minutes ago"  # systemd

# 4. Check port binding
ss -tlnp | grep 3001
```

### Resolution

1. **If the process is not running:**
   ```bash
   # Docker
   docker restart <container_id>

   # Non-Docker
   cd backend && npm start
   ```

2. **If the process is running but unresponsive (event loop blocked):**
   ```bash
   # Capture a heap snapshot before restarting
   kill -USR2 <pid>    # if --inspect flag is enabled
   # Restart the process
   docker restart <container_id>
   ```

3. **If the port is already in use:**
   ```bash
   lsof -i :3001
   kill <conflicting_pid>
   # Then restart the service
   ```

4. **If startup fails with "Failed to start server":**
   - Check logs for database initialization errors.
   - Verify environment variables are set (see `.env.example`).
   - Ensure `PORT`, `NODE_ENV`, and `FRONTEND_URL` are configured.

### Prevention
- Configure process manager (PM2 / systemd) with automatic restarts.
- Set up uptime monitoring on the `/health` endpoint.

---

## Failure Mode: Database Failures

### Symptoms
- API returns `500` with `"Database error"` or `"Internal server error"` messages.
- Login, client creation, or work entry operations fail.
- Application logs show `SQLITE_` error codes.

### Diagnosis

```bash
# 1. Check application logs for SQLITE_ error codes
docker logs <container_id> --tail 100 | grep -i "sqlite\|database"

# 2. For file-based SQLite (production), check the database file
ls -la /app/data/timesheet.db          # inside container
stat /app/data/timesheet.db

# 3. Check disk space (file-based SQLite)
df -h /app/data

# 4. Check file permissions
ls -la /app/data/

# 5. Verify database integrity (file-based)
sqlite3 /app/data/timesheet.db "PRAGMA integrity_check;"
```

### Resolution

1. **In-memory database data loss (dev):**
   - This is expected behavior. Restarting the server resets all data.
   - No recovery is possible for in-memory databases.

2. **File-based SQLite corruption (production):**
   ```bash
   # Stop the application
   docker stop <container_id>

   # Attempt recovery
   sqlite3 /app/data/timesheet.db ".recover" | sqlite3 /app/data/timesheet_recovered.db

   # If recovery succeeds, swap files
   mv /app/data/timesheet.db /app/data/timesheet.db.corrupt
   mv /app/data/timesheet_recovered.db /app/data/timesheet.db

   # Restart
   docker start <container_id>
   ```

3. **Disk space exhaustion:**
   ```bash
   # Check and clean up temp files (CSV exports create temp files)
   rm -rf /app/backend/temp/*

   # Vacuum the database to reclaim space
   sqlite3 /app/data/timesheet.db "VACUUM;"
   ```

4. **Permission errors:**
   ```bash
   # Ensure the nodejs user (uid 1001) owns the data directory
   chown -R 1001:1001 /app/data
   ```

### Prevention
- Schedule regular database backups for file-based SQLite.
- Monitor disk space on the data volume.
- Add a cron job to clean up `backend/temp/` directory.

---

## Failure Mode: API Errors (5xx)

### Symptoms
- Multiple endpoints returning HTTP 500.
- Frontend shows error toasts or blank pages.
- Elevated error rate in logs.

### Diagnosis

```bash
# 1. Check recent error logs (morgan combined format)
docker logs <container_id> --tail 200 | grep '" 500 '

# 2. Check for specific error patterns
docker logs <container_id> --tail 200 | grep -i "error\|failed\|exception"

# 3. Test individual endpoints
curl -s http://localhost:3001/health
curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}' http://localhost:3001/api/auth/login
```

### Resolution

1. **If errors are database-related:** See [Database Failures](#failure-mode-database-failures).
2. **If errors are validation-related (Joi):**
   - Check request payloads match expected schemas in `backend/src/validation/schemas.js`.
   - Joi validation errors return 400, not 500 -- if you see 500 from validation, the error handler may be misconfigured.
3. **If errors are from report generation:** See [Report Generation Failures](#failure-mode-report-generation-failures-pdfcsv).
4. **For unhandled exceptions:**
   ```bash
   # Check for uncaught exceptions in logs
   docker logs <container_id> 2>&1 | grep -i "uncaught\|unhandled"
   ```

### Prevention
- Ensure all route handlers have try/catch blocks.
- Add structured logging (consider winston or pino for production).

---

## Failure Mode: Authentication Failures

### Symptoms
- Users cannot log in. `POST /api/auth/login` returns errors.
- Authenticated endpoints return `401 Unauthorized`.
- Frontend redirects to `/login` repeatedly.

### Diagnosis

```bash
# 1. Test login endpoint
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}' http://localhost:3001/api/auth/login

# 2. Test authenticated endpoint with x-user-email header
curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/auth/me

# 3. Check if the users table exists and is accessible
# (only works with file-based SQLite)
sqlite3 /app/data/timesheet.db "SELECT count(*) FROM users;"
```

### Resolution

1. **If login returns 500:**
   - Database may be inaccessible. See [Database Failures](#failure-mode-database-failures).

2. **If authenticated requests return 401:**
   - Verify the `x-user-email` header is being sent.
   - Check email format passes regex validation: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`.

3. **If users get stuck in login loop (frontend):**
   - Clear `localStorage` in the browser (`localStorage.removeItem('userEmail')`).
   - Check browser devtools Network tab for the exact error response.

### Prevention
- Monitor auth endpoint error rates.
- Consider adding SSO integration for production.

---

## Failure Mode: Memory Leaks / High Resource Usage

### Symptoms
- Gradually increasing memory usage over time.
- Node.js process OOM-killed by the OS or Docker.
- Slow response times that worsen over time.

### Diagnosis

```bash
# 1. Check container resource usage
docker stats <container_id>

# 2. Check Node.js process memory
ps -o pid,rss,vsz,comm -p <node_pid>

# 3. Check heap usage from inside the app (if --inspect is enabled)
node -e "console.log(process.memoryUsage())"

# 4. Check for temp file accumulation (CSV exports)
du -sh /app/backend/temp/ 2>/dev/null || echo "No temp directory"
find /app/backend/temp/ -type f -mmin +60 2>/dev/null | wc -l
```

### Resolution

1. **Immediate relief -- restart the process:**
   ```bash
   docker restart <container_id>
   ```

2. **Investigate root causes:**
   - **Temp file accumulation:** CSV export creates temp files in `backend/temp/`. If download errors prevent cleanup, files accumulate.
     ```bash
     rm -rf /app/backend/temp/*
     ```
   - **Large PDF generation:** PDFKit buffers entire documents in memory. Reports with thousands of entries can consume excessive memory.
   - **SQLite connection leaks:** The singleton pattern in `database/init.js` should prevent this, but verify only one connection exists.

3. **Set memory limits:**
   ```bash
   # Docker
   docker run --memory=512m --memory-swap=512m <image>

   # Node.js
   node --max-old-space-size=256 src/server.js
   ```

### Prevention
- Set Docker memory limits in production.
- Add a scheduled cleanup job for `backend/temp/`.
- Monitor container memory via Prometheus/Grafana.

---

## Failure Mode: Rate Limiting Blocking Legitimate Traffic

### Symptoms
- Users receive `429 Too Many Requests` responses.
- Frontend shows errors when performing rapid operations (bulk data entry).
- Rate limit is configured at 100 requests per 15-minute window per IP.

### Diagnosis

```bash
# 1. Check for 429 responses in logs
docker logs <container_id> --tail 500 | grep '" 429 '

# 2. Test current rate limit status
for i in $(seq 1 5); do
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/health
done
```

### Resolution

1. **Temporary -- increase rate limit:**
   Edit `backend/src/server.js` and adjust the `max` value:
   ```javascript
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 500  // increased from 100
   });
   ```

2. **If behind a reverse proxy:**
   - Ensure `trust proxy` is set so rate limiting uses the real client IP:
     ```javascript
     app.set('trust proxy', 1);
     ```
   - Without this, all users behind the proxy share one rate limit counter.

### Prevention
- Tune rate limits based on actual usage patterns.
- Exempt health check endpoints from rate limiting.
- Consider per-user rate limiting instead of per-IP.

---

## Failure Mode: Report Generation Failures (PDF/CSV)

### Symptoms
- CSV or PDF export endpoints return 500 errors.
- Downloads hang or produce empty/corrupted files.
- Disk space warnings on the server.

### Diagnosis

```bash
# 1. Test CSV export
curl -s -o /dev/null -w "%{http_code}" \
  -H "x-user-email: test@example.com" \
  http://localhost:3001/api/reports/export/csv/1

# 2. Test PDF export
curl -s -o /dev/null -w "%{http_code}" \
  -H "x-user-email: test@example.com" \
  http://localhost:3001/api/reports/export/pdf/1

# 3. Check temp directory
ls -la /app/backend/temp/ 2>/dev/null
df -h /app

# 4. Check for file permission issues
touch /app/backend/temp/test_write && rm /app/backend/temp/test_write
```

### Resolution

1. **Temp directory does not exist:**
   ```bash
   mkdir -p /app/backend/temp
   chown 1001:1001 /app/backend/temp  # if running as nodejs user
   ```

2. **Disk space full:**
   ```bash
   # Clean up old temp files
   find /app/backend/temp -type f -mmin +30 -delete

   # Check what's using disk space
   du -sh /app/* | sort -rh | head -10
   ```

3. **PDF generation OOM for large reports:**
   - Limit the number of entries per report or paginate.
   - Increase Node.js memory: `node --max-old-space-size=512 src/server.js`.

### Prevention
- Add a cleanup cron for `backend/temp/` (every 30 minutes).
- Implement pagination for large reports.
- Monitor disk usage on the application volume.

---

## Failure Mode: Frontend Build or Proxy Failures

### Symptoms
- `npm run build` fails with TypeScript errors.
- Vite dev server won't start or crashes.
- Frontend can't reach backend APIs (proxy errors).
- Blank page or loading errors in the browser.

### Diagnosis

```bash
# 1. Check if Vite dev server is running
curl -s http://localhost:5173

# 2. Test if proxy is forwarding correctly
curl -s http://localhost:5173/api/health     # should be proxied to backend

# 3. Try building the frontend
cd frontend && npm run build

# 4. Check TypeScript errors
cd frontend && npx tsc --noEmit

# 5. Check for lint errors
cd frontend && npm run lint
```

### Resolution

1. **TypeScript build errors:**
   - Run `npx tsc --noEmit` to see specific errors.
   - Fix type errors before deploying.

2. **Vite proxy not working:**
   - Verify backend is running on port 3001.
   - Check `frontend/vite.config.ts` -- proxy target should match backend port.

3. **Blank page in browser:**
   - Open browser DevTools console for JavaScript errors.
   - Check Network tab for failed API requests.
   - Verify `localStorage` has valid `userEmail` if past the login page.

### Prevention
- Run `npm run build` in CI before deploying.
- Add TypeScript strict checks to CI pipeline.

---

## Failure Mode: Dependency / npm Failures

### Symptoms
- `npm install` fails (native module compilation, network errors).
- `npm audit` reports critical vulnerabilities.
- `sqlite3` native addon build failure on new platforms.

### Diagnosis

```bash
# 1. Check for vulnerabilities
cd backend && npm audit
cd frontend && npm audit

# 2. Check Node.js version compatibility
node --version   # requires 18+

# 3. Check for native module issues (sqlite3)
cd backend && npm ls sqlite3
npm rebuild sqlite3

# 4. Check for outdated packages
npm outdated
```

### Resolution

1. **sqlite3 native module build failure:**
   ```bash
   # Install build tools
   apt-get install -y python3 make g++  # Debian/Ubuntu
   apk add --no-cache python3 make g++  # Alpine

   # Rebuild
   cd backend && npm rebuild sqlite3
   ```

2. **Critical npm audit findings:**
   ```bash
   npm audit fix
   # If breaking changes are needed:
   npm audit fix --force   # use with caution
   ```

3. **Lockfile conflicts:**
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```

### Prevention
- Pin Node.js version in `.nvmrc` or Dockerfile.
- Run `npm audit` in CI (already configured in `pr-checks.yml`).
- Use Dependabot or Renovate for automated dependency updates.

---

## Failure Mode: Docker Container Health Check Failures

### Symptoms
- `docker ps` shows container as `unhealthy`.
- Orchestrator (Docker Compose, Kubernetes) restarts the container repeatedly.
- Application appears to be running but health check fails.

### Diagnosis

```bash
# 1. Check container health status
docker inspect --format='{{json .State.Health}}' <container_id> | jq .

# 2. Check health check log (last 5 results)
docker inspect --format='{{json .State.Health.Log}}' <container_id> | jq .

# 3. Run health check manually inside the container
docker exec <container_id> node -e \
  "require('http').get('http://localhost:3001/health', (r) => { \
    let d=''; r.on('data',c=>d+=c); r.on('end',()=>{console.log(r.statusCode,d); process.exit(r.statusCode===200?0:1)})})"

# 4. Check container logs
docker logs <container_id> --tail 50
```

### Resolution

1. **If app is starting slowly:**
   - Increase `--start-period` in the HEALTHCHECK directive (currently 5s).
   - Database initialization may take longer with a large existing database.

2. **If health check passes manually but fails in Docker:**
   - Network configuration issue inside the container.
   - Check that the app is listening on `0.0.0.0`, not `127.0.0.1`.

3. **If the app crashes on startup:**
   - Check logs for `"Failed to start server"`.
   - Verify all required environment variables are set.
   - Ensure `DATABASE_PATH` directory exists and is writable.

### Prevention
- Set appropriate health check intervals and thresholds.
- Monitor container restart counts in your orchestrator.

---

## Failure Mode: CORS Misconfiguration

### Symptoms
- Browser console shows `CORS policy` errors.
- API requests from the frontend are blocked.
- `OPTIONS` preflight requests fail.

### Diagnosis

```bash
# 1. Check CORS headers
curl -s -I -X OPTIONS \
  -H "Origin: http://localhost:5173" \
  -H "Access-Control-Request-Method: GET" \
  http://localhost:3001/api/clients

# 2. Check FRONTEND_URL environment variable
echo $FRONTEND_URL

# 3. Check backend CORS configuration
grep -n "cors\|FRONTEND_URL" backend/src/server.js
```

### Resolution

1. **FRONTEND_URL mismatch:**
   - Ensure `FRONTEND_URL` env var matches the actual frontend origin.
   - Common mistake: using `http://localhost:3000` instead of `http://localhost:5173`.
   ```bash
   # Fix in .env
   FRONTEND_URL=http://localhost:5173
   ```

2. **Production deployment with different domain:**
   - Update `FRONTEND_URL` to match the production frontend URL.
   - For multiple origins, modify the CORS configuration in `server.js`.

### Prevention
- Document the required `FRONTEND_URL` value for each environment.
- Add CORS validation to the health check script.

---

## Post-Incident Checklist

After resolving any incident:

- [ ] Verify the `/health` endpoint returns 200.
- [ ] Verify all API endpoints are functional (run health check script: `scripts/healthcheck.sh`).
- [ ] Check for any data loss (especially with in-memory SQLite restarts).
- [ ] Review logs for any additional errors.
- [ ] Update monitoring/alerting if the failure was not detected promptly.
- [ ] File a post-incident report using the appropriate GitHub Issue template (P1-P4).
- [ ] Schedule a blameless post-mortem for P1/P2 incidents.
- [ ] Document any new runbook entries or updates needed.
- [ ] Communicate resolution to affected users/stakeholders.
