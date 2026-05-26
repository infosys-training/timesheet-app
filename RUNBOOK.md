# Timesheet App — Incident Response Runbook

## Table of Contents

1. [Overview](#overview)
2. [Incident Severity Levels](#incident-severity-levels)
3. [General Response Procedure](#general-response-procedure)
4. [Failure Modes and Response Procedures](#failure-modes-and-response-procedures)
   - [FM-1: Database Connection Failure](#fm-1-database-connection-failure)
   - [FM-2: Database Corruption / Data Loss](#fm-2-database-corruption--data-loss)
   - [FM-3: API Unresponsive (Express Server Crash)](#fm-3-api-unresponsive-express-server-crash)
   - [FM-4: Rate Limiting Triggered](#fm-4-rate-limiting-triggered)
   - [FM-5: Memory Leak / OOM Kill](#fm-5-memory-leak--oom-kill)
   - [FM-6: Dependency Failure (npm packages)](#fm-6-dependency-failure-npm-packages)
   - [FM-7: Frontend Build/Serve Failure](#fm-7-frontend-buildserve-failure)
   - [FM-8: Authentication Middleware Failure](#fm-8-authentication-middleware-failure)
   - [FM-9: Report Generation Failure (PDF/CSV)](#fm-9-report-generation-failure-pdfcsv)
   - [FM-10: Docker Container Failure](#fm-10-docker-container-failure)
   - [FM-11: Disk Space Exhaustion](#fm-11-disk-space-exhaustion)
   - [FM-12: CORS / Proxy Misconfiguration](#fm-12-cors--proxy-misconfiguration)
5. [Escalation Matrix](#escalation-matrix)
6. [Post-Incident Review](#post-incident-review)

---

## Overview

This runbook covers operational response procedures for the Timesheet App — a full-stack Node.js/Express + React/TypeScript application with SQLite storage.

**Architecture Summary:**
- **Backend:** Express.js (port 3001), SQLite (in-memory for dev, file-based for production), email-only auth via `x-user-email` header
- **Frontend:** React + Vite (port 5173 in dev), proxies `/api` to backend
- **Production:** Docker container (Node 20 Alpine), file-based SQLite at `/app/data/timesheet.db`
- **CI/CD:** GitHub Actions (security audit, test coverage, SonarCloud SAST)

**Critical Endpoints:**
| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Health check |
| `POST /api/auth/login` | User login |
| `GET /api/auth/me` | Current user info |
| `GET /api/clients` | List clients |
| `GET /api/work-entries` | List work entries |
| `GET /api/reports/client/:id` | Client report |
| `GET /api/reports/export/csv/:id` | CSV export |
| `GET /api/reports/export/pdf/:id` | PDF export |

---

## Incident Severity Levels

| Level | Description | Response Time | Examples |
|-------|-------------|---------------|----------|
| **P1** | Complete service outage | 15 minutes | Server crash, database unavailable, Docker container won't start |
| **P2** | Major feature degraded | 1 hour | Report generation broken, authentication failing for all users |
| **P3** | Minor feature degraded | 4 hours | Single export format failing, slow response times |
| **P4** | Low impact | 24 hours | UI cosmetic issues, non-critical log warnings |

---

## General Response Procedure

1. **Acknowledge** — Confirm the incident within the response time SLA
2. **Assess** — Determine severity, scope, and blast radius
3. **Communicate** — Notify stakeholders per escalation matrix
4. **Mitigate** — Apply immediate fix or workaround
5. **Resolve** — Implement permanent fix
6. **Document** — File post-incident review

---

## Failure Modes and Response Procedures

### FM-1: Database Connection Failure

**Symptoms:**
- All API endpoints return `500 Internal server error`
- Logs show: `Error opening database: ...`
- Health check passes but authenticated requests fail

**Severity:** P1

**Diagnosis:**
```bash
# Check if the application can reach the database
docker exec <container> node -e "const sqlite3 = require('sqlite3'); const db = new sqlite3.Database('/app/data/timesheet.db', (err) => { console.log(err || 'OK'); db.close(); })"

# Check database file permissions
docker exec <container> ls -la /app/data/timesheet.db

# Check disk space
docker exec <container> df -h /app/data
```

**Resolution:**
1. Verify the SQLite database file exists at the configured `DATABASE_PATH`
2. Check file permissions — the `nodejs` user (UID 1001) must own the file
3. If in-memory mode (dev): restart the server to reinitialize
4. If file-based (production):
   ```bash
   # Fix permissions
   docker exec <container> chown nodejs:nodejs /app/data/timesheet.db

   # If file is corrupted, restore from backup
   cp /backups/timesheet-latest.db /app/data/timesheet.db
   docker restart <container>
   ```
5. Verify recovery:
   ```bash
   curl http://localhost:3001/health
   curl -H "x-user-email: test@test.com" http://localhost:3001/api/auth/me
   ```

**Prevention:**
- Set up automated database backups
- Monitor disk space alerts at 80% capacity
- Use WAL mode for concurrent read access

---

### FM-2: Database Corruption / Data Loss

**Symptoms:**
- Queries return `SQLITE_CORRUPT` errors
- Missing data for previously existing records
- Application starts but returns empty results

**Severity:** P1

**Diagnosis:**
```bash
# Check database integrity
docker exec <container> node -e "
const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('/app/data/timesheet.db');
db.get('PRAGMA integrity_check', (err, row) => {
  console.log(err || row);
  db.close();
});
"

# Check table existence
docker exec <container> node -e "
const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('/app/data/timesheet.db');
db.all(\"SELECT name FROM sqlite_master WHERE type='table'\", (err, rows) => {
  console.log(err || rows);
  db.close();
});
"
```

**Resolution:**
1. If integrity check fails:
   ```bash
   # Export what data is recoverable
   sqlite3 /app/data/timesheet.db ".dump" > recovery.sql

   # Restore from last known good backup
   cp /backups/timesheet-<timestamp>.db /app/data/timesheet.db
   docker restart <container>
   ```
2. If tables are missing (schema not initialized):
   ```bash
   # Restart container — schema auto-creates on init
   docker restart <container>
   ```
3. Verify all tables exist: `users`, `clients`, `work_entries`

**Prevention:**
- Implement scheduled database backups (e.g., daily cron)
- Never force-kill the container while write operations are in progress
- Enable WAL journal mode for crash resilience

---

### FM-3: API Unresponsive (Express Server Crash)

**Symptoms:**
- `GET /health` returns connection refused or times out
- Docker health check reports unhealthy
- Process exited with non-zero code

**Severity:** P1

**Diagnosis:**
```bash
# Check container status
docker ps -a | grep timesheet

# View recent logs
docker logs --tail 100 <container>

# Check if port is bound
docker exec <container> netstat -tlnp | grep 3001
```

**Resolution:**
1. Check logs for the root cause (unhandled exception, SIGKILL, etc.)
2. Restart the container:
   ```bash
   docker restart <container>
   ```
3. If crash loops:
   - Check environment variables (`PORT`, `DATABASE_PATH`, `NODE_ENV`)
   - Verify all required dependencies are installed
   - Check for port conflicts
4. If OOM-killed, see [FM-5: Memory Leak](#fm-5-memory-leak--oom-kill)
5. Verify recovery:
   ```bash
   curl http://localhost:3001/health
   ```

**Prevention:**
- Use `dumb-init` for proper signal handling (already configured)
- Set Docker restart policy: `--restart=unless-stopped`
- Monitor container health with alerting

---

### FM-4: Rate Limiting Triggered

**Symptoms:**
- Clients receive `429 Too Many Requests`
- Legitimate users blocked
- Logs show many requests from same IP

**Severity:** P3 (legitimate traffic) or P4 (abuse)

**Diagnosis:**
```bash
# Check current rate limit configuration
# Default: 100 requests per 15 minutes per IP

# Check application logs for request patterns
docker logs <container> | grep "429" | tail -20

# Identify IPs hitting limits
docker logs <container> | awk '{print $1}' | sort | uniq -c | sort -rn | head -10
```

**Resolution:**
1. If legitimate traffic is being blocked:
   ```bash
   # Temporarily increase rate limit by setting environment variable
   # Edit the limiter config in server.js:
   # max: process.env.RATE_LIMIT_MAX || 100
   docker restart <container>
   ```
2. If abusive traffic:
   - Block IP at reverse proxy / firewall level
   - Consider implementing API keys for programmatic access
3. Wait 15 minutes for the window to reset

**Prevention:**
- Configure rate limits appropriate to expected usage
- Implement per-user rate limiting (not just IP-based)
- Add a reverse proxy (nginx) with additional DDoS protection

---

### FM-5: Memory Leak / OOM Kill

**Symptoms:**
- Gradually increasing memory usage over time
- Container killed by Docker OOM killer
- `docker inspect` shows `OOMKilled: true`
- Node.js `heap out of memory` errors

**Severity:** P2

**Diagnosis:**
```bash
# Check container memory stats
docker stats <container> --no-stream

# Check if OOM killed
docker inspect <container> | jq '.[0].State.OOMKilled'

# Check Node.js heap usage (if container is running)
docker exec <container> node -e "console.log(JSON.stringify(process.memoryUsage(), null, 2))"

# Profile memory (attach to running process)
docker exec <container> node --inspect=0.0.0.0:9229 src/server.js
```

**Resolution:**
1. Immediate mitigation — restart:
   ```bash
   docker restart <container>
   ```
2. Set memory limits to prevent host impact:
   ```bash
   docker update --memory=512m --memory-swap=1g <container>
   ```
3. Investigate common leak sources:
   - Unclosed database connections in error paths
   - Large report generation (PDF/CSV) without streaming
   - Event listener accumulation
   - Unreleased temporary file handles in `/app/temp/`
4. If PDFKit is the cause, check for leaked document streams in `reports.js`

**Prevention:**
- Set Docker memory limits in production
- Implement periodic garbage collection monitoring
- Clean up temp files after report generation (already implemented but verify)
- Use `--max-old-space-size` flag for Node.js

---

### FM-6: Dependency Failure (npm packages)

**Symptoms:**
- Application fails to start with `MODULE_NOT_FOUND`
- Build fails during Docker image creation
- `npm audit` shows critical vulnerabilities
- Package registry unreachable during deployment

**Severity:** P2 (startup failure) or P3 (vulnerability)

**Diagnosis:**
```bash
# Check for missing modules
docker exec <container> node -e "require('express'); require('sqlite3'); require('pdfkit'); console.log('OK')"

# Verify installed packages
docker exec <container> npm ls --production

# Check for security issues
cd backend && npm audit
cd frontend && npm audit
```

**Resolution:**
1. For missing modules:
   ```bash
   # Rebuild the Docker image
   docker build -f docker/Dockerfile -t timesheet-app .
   ```
2. For vulnerability fixes:
   ```bash
   cd frontend && npm audit fix
   cd backend && npm audit fix
   # Test after fixing
   cd backend && npm test
   ```
3. For registry unavailability:
   - Check npm registry status: https://status.npmjs.org/
   - Use cached `node_modules` from previous builds
   - Configure fallback registry if available

**Prevention:**
- Pin dependency versions in `package-lock.json`
- Run `npm audit` in CI (already configured in `pr-checks.yml`)
- Keep dependencies updated regularly
- Cache Docker layers for faster rebuilds

---

### FM-7: Frontend Build/Serve Failure

**Symptoms:**
- Vite dev server won't start
- TypeScript compilation errors
- White screen or module load errors in browser
- Proxy errors when accessing `/api` routes

**Severity:** P2 (production) or P3 (dev only)

**Diagnosis:**
```bash
# Check TypeScript compilation
cd frontend && npx tsc --noEmit

# Check Vite build
cd frontend && npm run build

# Check if backend is running (proxy target)
curl http://localhost:3001/health

# Check browser console for errors
# Look for CORS errors, 502 proxy errors, or module resolution failures
```

**Resolution:**
1. TypeScript errors:
   ```bash
   cd frontend && npx tsc --noEmit 2>&1 | head -50
   # Fix type errors in reported files
   ```
2. Vite proxy errors:
   - Ensure backend is running on port 3001
   - Check `vite.config.ts` proxy configuration
3. Build failures:
   ```bash
   cd frontend
   rm -rf node_modules dist
   npm install
   npm run build
   ```
4. Module resolution errors:
   - Clear Vite cache: `rm -rf node_modules/.vite`
   - Verify all imports resolve correctly

**Prevention:**
- Run `npm run lint` and `tsc --noEmit` before deployments
- Include frontend build in CI pipeline
- Test proxy configuration in staging environment

---

### FM-8: Authentication Middleware Failure

**Symptoms:**
- All authenticated endpoints return `401` or `500`
- Login endpoint works but subsequent requests fail
- Error: `User email required in x-user-email header`

**Severity:** P2

**Diagnosis:**
```bash
# Test auth flow manually
curl -X POST http://localhost:3001/api/auth/login -H "Content-Type: application/json" -d '{"email":"test@test.com"}'

# Test authenticated endpoint
curl -H "x-user-email: test@test.com" http://localhost:3001/api/clients

# Check if the database user table is accessible
docker exec <container> node -e "
const {getDatabase} = require('./src/database/init');
const db = getDatabase();
db.all('SELECT * FROM users', (err, rows) => console.log(err || rows));
"
```

**Resolution:**
1. If `x-user-email` header is missing:
   - Check frontend Axios interceptor in `src/api/client.ts`
   - Verify `localStorage.getItem('userEmail')` returns a value
2. If user auto-creation fails:
   - Check database write permissions
   - Verify the `users` table exists
3. If email validation rejects valid emails:
   - Review regex in `auth.js` middleware
4. Restart server if database connection is stale

**Prevention:**
- Add monitoring for auth failure rates
- Implement fallback auth behavior for database errors
- Log auth failures with request context

---

### FM-9: Report Generation Failure (PDF/CSV)

**Symptoms:**
- Export endpoints return `500 Failed to generate CSV/PDF report`
- Temp directory write failures
- Large reports cause timeouts or OOM

**Severity:** P3

**Diagnosis:**
```bash
# Check temp directory
docker exec <container> ls -la /app/temp/

# Check disk space
docker exec <container> df -h

# Test with a small report
curl -H "x-user-email: user@test.com" http://localhost:3001/api/reports/export/csv/1

# Check for orphaned temp files
docker exec <container> find /app/temp -mmin +60 -type f
```

**Resolution:**
1. Temp directory issues:
   ```bash
   docker exec <container> mkdir -p /app/temp
   docker exec <container> chown nodejs:nodejs /app/temp
   ```
2. Disk space issues:
   ```bash
   # Clean orphaned temp files
   docker exec <container> find /app/temp -mmin +60 -delete
   ```
3. Large report OOM:
   - Implement pagination for large datasets
   - Stream PDF/CSV generation instead of buffering
4. Missing client data:
   - Verify the client exists and belongs to the user
   - Check for 404 vs 500 errors

**Prevention:**
- Implement temp file cleanup cron job
- Set max report size limits
- Monitor temp directory disk usage
- Add request timeout for export endpoints

---

### FM-10: Docker Container Failure

**Symptoms:**
- Container exits immediately after start
- Health check consistently failing
- Container restart loop

**Severity:** P1

**Diagnosis:**
```bash
# Check container status and exit code
docker ps -a | grep timesheet
docker inspect <container> | jq '.[0].State'

# View startup logs
docker logs <container> 2>&1 | head -50

# Check if port is available
ss -tlnp | grep 3001

# Verify environment variables
docker exec <container> env | grep -E "PORT|DATABASE|NODE_ENV"
```

**Resolution:**
1. Port conflict:
   ```bash
   # Find conflicting process
   lsof -i :3001
   # Kill or reconfigure
   ```
2. Missing environment variables:
   ```bash
   docker run -e PORT=3001 -e DATABASE_PATH=/app/data/timesheet.db -e NODE_ENV=production ...
   ```
3. Volume mount issues:
   ```bash
   # Ensure data directory exists on host
   mkdir -p ./data
   docker run -v $(pwd)/data:/app/data ...
   ```
4. Image corruption:
   ```bash
   docker rmi timesheet-app
   docker build -f docker/Dockerfile -t timesheet-app .
   ```

**Prevention:**
- Use Docker Compose for consistent configuration
- Pin base image versions (already using `node:20-alpine`)
- Test container startup in CI before deployment

---

### FM-11: Disk Space Exhaustion

**Symptoms:**
- Database writes fail with `SQLITE_FULL`
- Temp file creation fails
- Docker logs fill disk
- Container becomes read-only

**Severity:** P2

**Diagnosis:**
```bash
# Check host disk usage
df -h

# Check container filesystem
docker exec <container> df -h

# Find large files
docker exec <container> find / -type f -size +10M 2>/dev/null

# Check Docker logs size
docker inspect <container> | jq '.[0].LogPath' | xargs ls -lh
```

**Resolution:**
1. Clean up temp files:
   ```bash
   docker exec <container> find /app/temp -mmin +60 -delete
   ```
2. Rotate Docker logs:
   ```bash
   truncate -s 0 $(docker inspect <container> | jq -r '.[0].LogPath')
   ```
3. Remove unused Docker images/volumes:
   ```bash
   docker system prune -a --volumes
   ```
4. If database is too large:
   - Archive old work entries
   - Run `VACUUM` to reclaim space

**Prevention:**
- Configure Docker log rotation (`--log-opt max-size=10m`)
- Monitor disk usage with alerts at 80%
- Implement data retention policies
- Schedule temp file cleanup

---

### FM-12: CORS / Proxy Misconfiguration

**Symptoms:**
- Browser console shows CORS errors
- API requests blocked by browser
- `403 Forbidden` or `OPTIONS` preflight failures
- Works in Postman but not in browser

**Severity:** P3

**Diagnosis:**
```bash
# Check CORS headers
curl -v -X OPTIONS http://localhost:3001/api/clients \
  -H "Origin: http://localhost:5173" \
  -H "Access-Control-Request-Method: GET"

# Verify FRONTEND_URL env var
echo $FRONTEND_URL

# Check Vite proxy config
cat frontend/vite.config.ts
```

**Resolution:**
1. Development:
   - Ensure backend `FRONTEND_URL` matches Vite dev server (`http://localhost:5173`)
   - Verify Vite proxy is configured for `/api` routes
2. Production:
   - Update `FRONTEND_URL` environment variable to match production domain
   - If behind reverse proxy, ensure headers are forwarded correctly
3. Quick fix:
   ```bash
   # Set correct origin
   docker run -e FRONTEND_URL=https://your-domain.com ...
   ```

**Prevention:**
- Document required environment variables
- Validate CORS configuration in CI
- Use environment-specific `.env` files

---

## Escalation Matrix

| Severity | First Responder | Escalation (30 min) | Escalation (2 hr) |
|----------|----------------|---------------------|-------------------|
| P1 | On-call engineer | Team lead | Engineering manager |
| P2 | On-call engineer | Team lead | — |
| P3 | Assigned engineer | — | — |
| P4 | Backlog triage | — | — |

**Communication Channels:**
- P1/P2: Immediate team notification (Slack/Teams #incidents)
- P3/P4: Tracked via GitHub Issues

---

## Post-Incident Review

After every P1/P2 incident, complete the following within 48 hours:

1. **Timeline** — Document exact sequence of events
2. **Root Cause** — Identify the underlying technical cause
3. **Impact** — Quantify affected users/time
4. **Action Items** — Define preventive measures with owners and deadlines
5. **Lessons Learned** — What went well, what didn't

Use the P1/P2 incident issue templates (`.github/ISSUE_TEMPLATE/`) to file the post-incident report.
