# Timesheet App Incident Response Runbook

This runbook provides step-by-step procedures for diagnosing and resolving common failure modes in the Timesheet application.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Failure Mode 1: Database Connection Failure](#failure-mode-1-database-connection-failure)
- [Failure Mode 2: Database Corruption (Production)](#failure-mode-2-database-corruption-production)
- [Failure Mode 3: Disk Space Exhaustion](#failure-mode-3-disk-space-exhaustion)
- [Failure Mode 4: API Server Crash / Fails to Start](#failure-mode-4-api-server-crash--fails-to-start)
- [Failure Mode 5: Rate Limiting Triggered](#failure-mode-5-rate-limiting-triggered)
- [Failure Mode 6: Authentication Failures](#failure-mode-6-authentication-failures)
- [Failure Mode 7: Memory Exhaustion / Leaks](#failure-mode-7-memory-exhaustion--leaks)
- [Failure Mode 8: In-Memory Data Loss on Restart](#failure-mode-8-in-memory-data-loss-on-restart)
- [Failure Mode 9: Report Generation Failures (PDF/CSV)](#failure-mode-9-report-generation-failures-pdfcsv)
- [Failure Mode 10: Frontend/Proxy Connectivity Issues](#failure-mode-10-frontendproxy-connectivity-issues)
- [Failure Mode 11: Docker Container Health Check Failures](#failure-mode-11-docker-container-health-check-failures)
- [Failure Mode 12: Dependency Vulnerabilities](#failure-mode-12-dependency-vulnerabilities)
- [Escalation Matrix](#escalation-matrix)

---

## Architecture Overview

| Component      | Technology         | Port  | Notes                                          |
|----------------|--------------------|-------|-------------------------------------------------|
| Backend API    | Express.js (Node)  | 3001  | REST API, rate-limited (100 req/15 min per IP)  |
| Frontend       | React + Vite       | 5173  | Dev proxy forwards `/api` to backend            |
| Database       | SQLite             | N/A   | In-memory (dev), file-based (prod via Docker)   |
| Auth           | Email-only          | N/A   | `x-user-email` header, no password              |
| Containerization | Docker            | 3001  | Single container serves API + static frontend   |

### Critical Endpoints

| Endpoint                          | Method | Purpose              |
|-----------------------------------|--------|----------------------|
| `/health`                         | GET    | Health check         |
| `/api/auth/login`                 | POST   | User login           |
| `/api/auth/me`                    | GET    | Current user info    |
| `/api/clients`                    | GET    | List clients         |
| `/api/clients`                    | POST   | Create client        |
| `/api/work-entries`               | GET    | List work entries    |
| `/api/work-entries`               | POST   | Create work entry    |
| `/api/reports/client/:clientId`   | GET    | Client report        |
| `/api/reports/export/csv/:clientId` | GET  | CSV export           |
| `/api/reports/export/pdf/:clientId` | GET  | PDF export           |

---

## Failure Mode 1: Database Connection Failure

**Severity:** P1 (Critical)
**Symptoms:** All API requests return `500 Internal server error`; server logs show `Error opening database`.

### Diagnosis

1. Check server logs for SQLite errors:
   ```bash
   # Docker
   docker logs <container_id> 2>&1 | grep -i "database\|sqlite\|error"

   # Local dev
   cat backend/logs/*.log 2>/dev/null || echo "Check terminal output"
   ```

2. Verify the database file exists (production):
   ```bash
   docker exec <container_id> ls -la /app/data/timesheet.db
   ```

3. Test the health endpoint:
   ```bash
   curl -s http://localhost:3001/health | jq .
   ```

### Resolution

1. **Dev environment (in-memory DB):** Restart the backend server. The in-memory database is re-initialized on startup.
   ```bash
   cd backend && npm run dev
   ```

2. **Production (file-based DB):** Check file permissions and disk space:
   ```bash
   docker exec <container_id> ls -la /app/data/
   docker exec <container_id> df -h /app/data/
   ```

3. If the database file is missing, the server will create it on restart. Restart the container:
   ```bash
   docker restart <container_id>
   ```

4. If permissions are wrong:
   ```bash
   docker exec -u root <container_id> chown nodejs:nodejs /app/data/timesheet.db
   ```

### Prevention

- Monitor disk space on the Docker host volume
- Set up alerts for database error log patterns
- Use Docker volume health checks

---

## Failure Mode 2: Database Corruption (Production)

**Severity:** P1 (Critical)
**Symptoms:** Queries return unexpected errors; `SQLITE_CORRUPT` in logs; partial or garbled data returned.

### Diagnosis

1. Check logs for corruption indicators:
   ```bash
   docker logs <container_id> 2>&1 | grep -i "SQLITE_CORRUPT\|malformed\|disk I/O"
   ```

2. Run an integrity check:
   ```bash
   docker exec <container_id> node -e "
     const sqlite3 = require('sqlite3').verbose();
     const db = new sqlite3.Database(process.env.DATABASE_PATH || '/app/data/timesheet.db');
     db.get('PRAGMA integrity_check', (err, row) => {
       console.log(err || row);
       db.close();
     });
   "
   ```

### Resolution

1. **Stop the application** to prevent further writes:
   ```bash
   docker stop <container_id>
   ```

2. **Backup the corrupt database** before attempting recovery:
   ```bash
   cp /path/to/host/data/timesheet.db /path/to/host/data/timesheet.db.corrupt.$(date +%s)
   ```

3. **Attempt recovery** using the `.dump` command:
   ```bash
   sqlite3 /path/to/host/data/timesheet.db ".dump" | sqlite3 /path/to/host/data/timesheet_recovered.db
   mv /path/to/host/data/timesheet_recovered.db /path/to/host/data/timesheet.db
   ```

4. **Restart the container:**
   ```bash
   docker start <container_id>
   ```

5. **Verify recovery** by testing API endpoints:
   ```bash
   curl -s http://localhost:3001/health
   curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients
   ```

### Prevention

- Schedule regular backups of the SQLite database file
- Use a Docker volume (not bind mount) for the database path
- Avoid abrupt container termination (always use `docker stop`, not `docker kill`)

---

## Failure Mode 3: Disk Space Exhaustion

**Severity:** P2 (High)
**Symptoms:** New records fail to save; CSV/PDF export fails; logs show `SQLITE_FULL` or `ENOSPC`.

### Diagnosis

1. Check disk usage on the host:
   ```bash
   df -h
   du -sh /var/lib/docker/volumes/
   ```

2. Check inside the container:
   ```bash
   docker exec <container_id> df -h /app/data/
   docker exec <container_id> du -sh /app/data/timesheet.db
   ```

3. Check for temp file accumulation from report exports:
   ```bash
   docker exec <container_id> ls -la /app/temp/ 2>/dev/null
   ```

### Resolution

1. **Clean up temp files** from report generation:
   ```bash
   docker exec <container_id> rm -f /app/temp/*.csv
   ```

2. **Clean up Docker resources:**
   ```bash
   docker system prune -f
   docker volume prune -f
   ```

3. **Expand storage** if needed on the host system.

4. **Restart the application** after freeing space:
   ```bash
   docker restart <container_id>
   ```

### Prevention

- Set up disk usage monitoring with alerts at 80% and 90% thresholds
- The CSV export code already cleans up temp files, but verify the cleanup runs even on error
- Consider adding log rotation for the application logs
- Add a scheduled job to clean orphaned temp files

---

## Failure Mode 4: API Server Crash / Fails to Start

**Severity:** P1 (Critical)
**Symptoms:** Health endpoint unreachable; container exits with non-zero code; `Failed to start server` in logs.

### Diagnosis

1. Check container status:
   ```bash
   docker ps -a --filter "name=timesheet"
   docker logs --tail 50 <container_id>
   ```

2. Check if the port is in use:
   ```bash
   lsof -i :3001
   netstat -tlnp | grep 3001
   ```

3. Check Node.js process status (local dev):
   ```bash
   ps aux | grep "node.*server.js"
   ```

### Resolution

1. **Port conflict:** Kill the conflicting process:
   ```bash
   kill $(lsof -t -i :3001)
   ```

2. **Missing dependencies:** Reinstall:
   ```bash
   cd backend && rm -rf node_modules && npm install
   ```

3. **Environment misconfiguration:** Verify `.env` file:
   ```bash
   cat backend/.env
   # Ensure PORT, FRONTEND_URL are set correctly
   ```

4. **Restart the server:**
   ```bash
   # Dev
   cd backend && npm run dev

   # Docker
   docker restart <container_id>
   ```

### Prevention

- Use `dumb-init` in Docker (already configured) for proper signal handling
- Set up process monitoring (e.g., PM2 in production outside Docker)
- Configure Docker restart policies: `docker run --restart=unless-stopped ...`

---

## Failure Mode 5: Rate Limiting Triggered

**Severity:** P3 (Medium)
**Symptoms:** API returns `429 Too Many Requests`; legitimate users locked out.

### Diagnosis

1. Check if the user is being rate-limited:
   ```bash
   curl -v http://localhost:3001/health 2>&1 | grep "< HTTP"
   # Look for 429 status code
   ```

2. Check the rate limit configuration in `backend/src/server.js`:
   - Window: 15 minutes
   - Max requests: 100 per IP

### Resolution

1. **Wait for the rate limit window to expire** (15 minutes).

2. **Temporary increase** (requires code change and restart):
   ```javascript
   // In backend/src/server.js, increase the max value
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 500  // increased from 100
   });
   ```

3. **If behind a reverse proxy**, ensure `trust proxy` is set so rate limiting applies per-client IP, not per-proxy IP:
   ```javascript
   app.set('trust proxy', 1);
   ```

### Prevention

- Monitor 429 response rates
- Tune rate limits based on expected traffic patterns
- Consider separate rate limits for authenticated vs unauthenticated routes

---

## Failure Mode 6: Authentication Failures

**Severity:** P2 (High)
**Symptoms:** Users cannot log in; API returns `401 User email required in x-user-email header` or `400 Invalid email format`.

### Diagnosis

1. Verify the `x-user-email` header is being sent:
   ```bash
   curl -v -H "x-user-email: user@example.com" http://localhost:3001/api/auth/me
   ```

2. Check browser localStorage for the stored email:
   ```
   Open DevTools > Application > Local Storage > look for 'userEmail'
   ```

3. Check the frontend Axios interceptor is attaching the header (see `frontend/src/api/client.ts`).

### Resolution

1. **Clear localStorage and re-login:**
   ```javascript
   localStorage.removeItem('userEmail');
   // Navigate to /login
   ```

2. **If the user record is missing** from the in-memory database (dev), the auth middleware auto-creates users. Restart the backend if the database is in an inconsistent state.

3. **CORS issues blocking the header:** Verify the CORS origin setting matches the frontend URL:
   ```bash
   grep FRONTEND_URL backend/.env
   # Should be http://localhost:5173 for dev
   ```

### Prevention

- The auth middleware already auto-creates missing users
- Ensure FRONTEND_URL is correctly configured in all environments
- Monitor 401/400 response rates for anomalies

---

## Failure Mode 7: Memory Exhaustion / Leaks

**Severity:** P2 (High)
**Symptoms:** Server becomes slow and unresponsive; Node.js OOM errors in logs; container killed by Docker OOM killer.

### Diagnosis

1. Check container memory usage:
   ```bash
   docker stats <container_id> --no-stream
   ```

2. Check Node.js heap usage:
   ```bash
   docker exec <container_id> node -e "console.log(process.memoryUsage())"
   ```

3. Check if OOM killed:
   ```bash
   docker inspect <container_id> --format='{{.State.OOMKilled}}'
   dmesg | grep -i "oom\|killed"
   ```

### Resolution

1. **Restart the container** to release memory immediately:
   ```bash
   docker restart <container_id>
   ```

2. **Set memory limits** on the container:
   ```bash
   docker update --memory="512m" --memory-swap="512m" <container_id>
   ```

3. **Increase Node.js heap if needed:**
   ```bash
   NODE_OPTIONS="--max-old-space-size=512" node src/server.js
   ```

### Prevention

- Set Docker memory limits to prevent unbounded growth
- Monitor memory usage with alerting
- Review report generation code for large dataset handling
- Consider streaming large PDF/CSV exports instead of buffering in memory

---

## Failure Mode 8: In-Memory Data Loss on Restart

**Severity:** P2 (High)
**Symptoms:** All data disappears after server restart in development. This is expected behavior but may be unexpected.

### Diagnosis

1. Verify the database mode:
   ```bash
   grep DATABASE_PATH backend/.env
   # If unset or ':memory:', in-memory mode is active
   ```

### Resolution

1. **For development:** This is expected behavior. Re-seed data after restart.

2. **To persist data in development**, set a file-based database path:
   ```bash
   echo "DATABASE_PATH=./data/timesheet.db" >> backend/.env
   mkdir -p backend/data
   ```
   Note: This requires using the Docker override version of `database/init.js` which supports `DATABASE_PATH`.

3. **For production:** Always use the Docker deployment which uses file-based SQLite at `/app/data/timesheet.db`.

### Prevention

- Document the in-memory behavior for the development team
- Use the Docker deployment for any environment where data persistence is needed
- Implement a data backup/export mechanism for production

---

## Failure Mode 9: Report Generation Failures (PDF/CSV)

**Severity:** P3 (Medium)
**Symptoms:** CSV or PDF download fails; `500 Failed to generate CSV report` or similar; temp file errors.

### Diagnosis

1. Check for temp directory issues:
   ```bash
   # Docker
   docker exec <container_id> ls -la /app/temp/

   # Local
   ls -la backend/temp/
   ```

2. Check disk space (see [Failure Mode 3](#failure-mode-3-disk-space-exhaustion)).

3. Check logs for specific PDF/CSV errors:
   ```bash
   docker logs <container_id> 2>&1 | grep -i "csv\|pdf\|report\|temp"
   ```

### Resolution

1. **Create the temp directory** if missing:
   ```bash
   docker exec <container_id> mkdir -p /app/temp
   # or locally
   mkdir -p backend/temp
   ```

2. **Fix permissions:**
   ```bash
   docker exec -u root <container_id> chown nodejs:nodejs /app/temp
   ```

3. **Clean up orphaned temp files:**
   ```bash
   docker exec <container_id> rm -f /app/temp/*.csv
   ```

4. **For PDF generation failures**, check the `pdfkit` dependency:
   ```bash
   cd backend && npm ls pdfkit
   ```

### Prevention

- Add automated cleanup of temp files older than 1 hour
- Monitor temp directory size
- Consider streaming exports directly to the response instead of writing to disk

---

## Failure Mode 10: Frontend/Proxy Connectivity Issues

**Severity:** P2 (High)
**Symptoms:** Frontend shows network errors; API calls fail from the browser; CORS errors in browser console.

### Diagnosis

1. Check if the backend is running:
   ```bash
   curl -s http://localhost:3001/health
   ```

2. Check Vite proxy config (`frontend/vite.config.ts`):
   - `/api` should proxy to `http://localhost:3001`

3. Check browser console for CORS errors.

4. Verify the FRONTEND_URL environment variable:
   ```bash
   grep FRONTEND_URL backend/.env
   ```

### Resolution

1. **Backend not running:** Start the backend:
   ```bash
   cd backend && npm run dev
   ```

2. **CORS mismatch:** Update `FRONTEND_URL` in `backend/.env` to match the frontend origin:
   ```bash
   # For Vite dev server
   FRONTEND_URL=http://localhost:5173
   ```

3. **Proxy not working:** Restart the Vite dev server:
   ```bash
   cd frontend && npm run dev
   ```

4. **Production (Docker):** The frontend is served by Express, so CORS is not an issue. Check that the static files are built:
   ```bash
   docker exec <container_id> ls -la /app/public/
   ```

### Prevention

- Keep FRONTEND_URL in sync with the actual frontend URL
- In production, use the Docker build which serves frontend from the same origin
- Test the proxy configuration after any Vite config changes

---

## Failure Mode 11: Docker Container Health Check Failures

**Severity:** P2 (High)
**Symptoms:** Container marked `unhealthy` by Docker; orchestrator restarts the container repeatedly.

### Diagnosis

1. Check container health status:
   ```bash
   docker inspect <container_id> --format='{{json .State.Health}}' | jq .
   ```

2. Check the health check configuration in `docker/Dockerfile`:
   - Interval: 30s
   - Timeout: 3s
   - Start period: 5s
   - Retries: 3

3. Manually test the health endpoint:
   ```bash
   docker exec <container_id> node -e "
     require('http').get('http://localhost:3001/health', (r) => {
       let d = '';
       r.on('data', c => d += c);
       r.on('end', () => console.log(r.statusCode, d));
     });
   "
   ```

### Resolution

1. **If the server is slow to start**, increase the `--start-period`:
   ```dockerfile
   HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
     CMD node -e "require('http').get('http://localhost:3001/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"
   ```

2. **If the server is overloaded**, check memory and CPU:
   ```bash
   docker stats <container_id> --no-stream
   ```

3. **Restart the container:**
   ```bash
   docker restart <container_id>
   ```

### Prevention

- Tune health check parameters based on observed startup times
- Set appropriate resource limits on the container
- Monitor health check failures in your orchestration system

---

## Failure Mode 12: Dependency Vulnerabilities

**Severity:** P3 (Medium)
**Symptoms:** CI pipeline fails on `npm audit`; SonarCloud or SAST scan flags vulnerabilities.

### Diagnosis

1. Run audit locally:
   ```bash
   cd frontend && npm audit
   cd backend && npm audit
   ```

2. Check the CI workflow results for details (`.github/workflows/pr-checks.yml` runs security audits on PRs).

### Resolution

1. **Automated fix:**
   ```bash
   cd frontend && npm audit fix
   cd backend && npm audit fix
   ```

2. **Breaking changes require manual upgrade:**
   ```bash
   npm audit fix --force  # Use with caution
   ```

3. **Verify the fix doesn't break anything:**
   ```bash
   cd backend && npm test
   cd frontend && npm run build
   ```

### Prevention

- Enable Dependabot or Renovate for automated dependency updates
- Review the CI pipeline regularly for new vulnerability patterns
- The existing CI pipeline (`.github/workflows/pr-checks.yml`) already blocks PRs with high/critical vulnerabilities

---

## Escalation Matrix

| Severity | Response Time | Notify               | Examples                                     |
|----------|---------------|----------------------|----------------------------------------------|
| P1       | 15 minutes    | On-call + team lead  | DB down, server crash, data loss             |
| P2       | 1 hour        | On-call engineer     | Auth failures, memory issues, proxy down     |
| P3       | 4 hours       | Team channel         | Rate limiting, report failures, CVEs         |
| P4       | Next business day | Backlog          | UI glitches, non-critical warnings           |

### Communication Template

When reporting an incident, include:
1. **Impact:** How many users are affected and what functionality is broken
2. **Timeline:** When the issue started and any relevant recent changes
3. **Current status:** What has been tried and what the current state is
4. **Next steps:** What is being done to resolve the issue
