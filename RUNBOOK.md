# Incident Response Runbook - Timesheet Application

## Table of Contents

- [Overview](#overview)
- [Architecture Summary](#architecture-summary)
- [Failure Modes](#failure-modes)
  - [FM-1: Database Failure (SQLite)](#fm-1-database-failure-sqlite)
  - [FM-2: API Server Crash / Unresponsive](#fm-2-api-server-crash--unresponsive)
  - [FM-3: Authentication Failure (JWT)](#fm-3-authentication-failure-jwt)
  - [FM-4: Memory Leak / High Memory Usage](#fm-4-memory-leak--high-memory-usage)
  - [FM-5: Dependency Failure (npm packages)](#fm-5-dependency-failure-npm-packages)
  - [FM-6: Frontend Build / Serve Failure](#fm-6-frontend-build--serve-failure)
  - [FM-7: Rate Limiting Triggered](#fm-7-rate-limiting-triggered)
  - [FM-8: File System Errors (CSV/PDF Export)](#fm-8-file-system-errors-csvpdf-export)
  - [FM-9: CORS / Network Connectivity Issues](#fm-9-cors--network-connectivity-issues)
  - [FM-10: Docker Container Health Check Failure](#fm-10-docker-container-health-check-failure)
- [Escalation Matrix](#escalation-matrix)
- [Post-Incident Review Template](#post-incident-review-template)

---

## Overview

This runbook provides step-by-step procedures for diagnosing and resolving incidents in the Employee Time Tracking Application (timesheet-app). The application consists of:

- **Backend**: Node.js/Express API server (port 3001)
- **Frontend**: React/TypeScript SPA built with Vite (port 5173 dev, served statically in production)
- **Database**: SQLite (in-memory for dev, file-based for production at `/app/data/timesheet.db`)
- **Auth**: Email-based with x-user-email header validation

## Architecture Summary

```
┌─────────────┐     ┌─────────────────┐     ┌──────────────┐
│   Frontend  │────▶│  Express API    │────▶│   SQLite DB  │
│  (React/TS) │     │  (port 3001)    │     │  (in-memory/ │
│  port 5173  │     │                 │     │   file-based)│
└─────────────┘     └─────────────────┘     └──────────────┘
                           │
                    ┌──────┴──────┐
                    │  Middleware  │
                    ├─────────────┤
                    │ - Helmet    │
                    │ - CORS      │
                    │ - Rate Limit│
                    │ - Morgan    │
                    │ - Auth      │
                    └─────────────┘
```

**Critical endpoints:**
- `GET /health` — Application health check
- `POST /api/auth/login` — User authentication
- `GET /api/clients` — Client listing
- `GET /api/work-entries` — Work entry listing
- `GET /api/reports/client/:id` — Report generation
- `GET /api/reports/export/csv/:id` — CSV export
- `GET /api/reports/export/pdf/:id` — PDF export

---

## Failure Modes

### FM-1: Database Failure (SQLite)

**Symptoms:**
- HTTP 500 responses with `"Database error"` message
- Application starts but all CRUD operations fail
- In production: `SQLITE_CANTOPEN`, `SQLITE_BUSY`, `SQLITE_CORRUPT` errors in logs

**Impact:** P1 — Complete data loss (in-memory) or total service unavailability

**Diagnosis:**

```bash
# 1. Check application logs for SQLite errors
docker logs <container_id> 2>&1 | grep -i "sqlite\|database"

# 2. In production (file-based), check database file permissions
ls -la /app/data/timesheet.db

# 3. Check disk space (file-based SQLite)
df -h /app/data/

# 4. Test health endpoint
curl -s http://localhost:3001/health | jq .

# 5. Test a database-dependent endpoint
curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients
```

**Resolution:**

1. **In-memory database (development):**
   - Restart the application: `npm run dev` (all data will be lost — this is expected)
   - If the issue persists, check for corrupted `node_modules`: `rm -rf node_modules && npm install`

2. **File-based database (production):**
   ```bash
   # Check if database file is locked
   fuser /app/data/timesheet.db
   
   # If locked by a dead process, kill it
   fuser -k /app/data/timesheet.db
   
   # If database is corrupt, restore from backup
   cp /app/data/backups/timesheet_latest.db /app/data/timesheet.db
   
   # Restart the container
   docker restart timesheet-app
   ```

3. **Disk space issues:**
   ```bash
   # Clear temp files
   rm -rf /app/backend/temp/*
   
   # Check and clean old CSV/PDF exports
   find /app/backend/temp -mtime +1 -delete
   ```

**Prevention:**
- Set up automated database backups (for file-based SQLite)
- Monitor disk space with alerts at 80% threshold
- Implement connection pooling or WAL mode for concurrent access

---

### FM-2: API Server Crash / Unresponsive

**Symptoms:**
- Health check (`GET /health`) returns non-200 or times out
- Docker health check reports `unhealthy`
- Frontend shows network errors / "Cannot connect to server"

**Impact:** P1 — Full service outage

**Diagnosis:**

```bash
# 1. Check if process is running
docker ps | grep timesheet
# or without Docker:
pgrep -f "node src/server.js"

# 2. Check application logs
docker logs --tail 100 <container_id>

# 3. Check for port conflicts
lsof -i :3001

# 4. Check system resources
docker stats <container_id>

# 5. Check for unhandled promise rejections in logs
docker logs <container_id> 2>&1 | grep -i "unhandled\|uncaught\|FATAL"
```

**Resolution:**

1. **Simple restart:**
   ```bash
   # Docker
   docker restart timesheet-app
   
   # Systemd
   sudo systemctl restart timesheet-app
   
   # Manual
   kill $(pgrep -f "node src/server.js") && node src/server.js
   ```

2. **Port conflict:**
   ```bash
   # Find and kill process on port 3001
   lsof -ti:3001 | xargs kill -9
   # Restart application
   docker restart timesheet-app
   ```

3. **Out of memory:**
   ```bash
   # Increase memory limit
   docker update --memory="512m" timesheet-app
   # Or update docker-compose.yml deploy.resources.limits.memory
   docker compose up -d
   ```

**Prevention:**
- Use process manager (dumb-init in Docker, PM2 for bare metal)
- Set up health check monitoring with automatic restart
- Configure memory limits and OOM kill policies

---

### FM-3: Authentication Failure (JWT)

**Symptoms:**
- Users receive 401 "User email required in x-user-email header"
- Users receive 400 "Invalid email format"
- Authenticated endpoints return 500 after user creation step fails

**Impact:** P2 — Users cannot access the application but system is running

**Diagnosis:**

```bash
# 1. Test authentication manually
curl -v -H "x-user-email: test@example.com" http://localhost:3001/api/auth/me

# 2. Check if the issue is client-side (missing header)
# Look at frontend network tab for x-user-email header

# 3. Check database can accept new users
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "debug@example.com"}'

# 4. Verify JWT_SECRET is set (don't log the actual value)
echo "JWT_SECRET is ${JWT_SECRET:+set}" # Should print "set"
```

**Resolution:**

1. **Missing JWT_SECRET environment variable:**
   ```bash
   # Check environment
   docker exec <container_id> env | grep JWT_SECRET
   
   # Set it if missing
   docker exec <container_id> sh -c 'export JWT_SECRET=<secure-random-string>'
   # Or restart with proper env file
   docker compose up -d
   ```

2. **Database unable to create users (SQLite issue):**
   - Follow FM-1 resolution steps

3. **Frontend not sending auth header:**
   - Check frontend `src/api/client.ts` for proper header injection
   - Verify browser localStorage has valid user session

**Prevention:**
- Ensure JWT_SECRET is always set via environment config
- Add startup validation for required environment variables
- Monitor 401/400 error rates for anomaly detection

---

### FM-4: Memory Leak / High Memory Usage

**Symptoms:**
- Gradual increase in container memory usage
- Application becomes slow over time
- Eventually crashes with OOM (Out of Memory)
- Large PDF/CSV exports cause sudden spikes

**Impact:** P2 — Degraded performance leading to eventual P1

**Diagnosis:**

```bash
# 1. Check current memory usage
docker stats --no-stream <container_id>

# 2. Check Node.js heap usage
docker exec <container_id> node -e "console.log(process.memoryUsage())"

# 3. Monitor over time
watch -n 5 'docker stats --no-stream <container_id>'

# 4. Check for large temp files from exports
du -sh /app/backend/temp/

# 5. Look for memory leak patterns in logs
docker logs <container_id> 2>&1 | grep -i "heap\|memory\|allocation"
```

**Resolution:**

1. **Immediate relief — restart:**
   ```bash
   docker restart timesheet-app
   ```

2. **Clean up temp files:**
   ```bash
   docker exec <container_id> rm -rf /app/backend/temp/*
   ```

3. **If caused by large exports:**
   - Implement pagination for report queries
   - Stream PDF/CSV generation instead of buffering in memory
   - Add file size limits to export endpoints

4. **Long-term fix:**
   ```bash
   # Add memory limit to prevent host impact
   docker update --memory="256m" --memory-swap="512m" timesheet-app
   ```

**Prevention:**
- Set container memory limits in docker-compose.yml
- Implement periodic temp file cleanup (cron job)
- Add memory usage to health check response
- Profile application under load regularly

---

### FM-5: Dependency Failure (npm packages)

**Symptoms:**
- Application fails to start with `MODULE_NOT_FOUND` errors
- Build failures during deployment
- Specific features fail (e.g., PDF generation, CSV export)
- `npm audit` shows critical vulnerabilities

**Impact:** P2/P3 — Partial or full service disruption depending on affected package

**Diagnosis:**

```bash
# 1. Check for missing modules
docker exec <container_id> node -e "require('express'); console.log('OK')"

# 2. Verify node_modules integrity
docker exec <container_id> npm ls --depth=0

# 3. Check for outdated packages
npm outdated

# 4. Audit for security issues
npm audit

# 5. Check specific package availability
npm info pdfkit version
npm info sqlite3 version
```

**Resolution:**

1. **Missing dependencies:**
   ```bash
   # In development
   cd backend && rm -rf node_modules && npm install
   
   # In Docker — rebuild image
   docker compose build --no-cache timesheet-app
   docker compose up -d
   ```

2. **Native module issues (sqlite3):**
   ```bash
   # Rebuild native modules
   npm rebuild sqlite3
   
   # Or reinstall from scratch
   rm -rf node_modules/sqlite3
   npm install sqlite3
   ```

3. **Security vulnerability:**
   ```bash
   # Apply automatic fixes
   npm audit fix
   
   # For breaking changes
   npm audit fix --force  # Review changes carefully
   ```

**Prevention:**
- Pin dependency versions in package-lock.json
- Run `npm audit` in CI pipeline
- Set up Dependabot or Renovate for automated updates
- Test dependency updates in staging before production

---

### FM-6: Frontend Build / Serve Failure

**Symptoms:**
- Frontend returns blank page or "Failed to fetch" errors
- Vite build fails with TypeScript errors
- Static assets return 404 in production

**Impact:** P2 — Users cannot access UI but API remains functional

**Diagnosis:**

```bash
# 1. Check if frontend build artifacts exist (production)
ls -la /app/public/

# 2. Try building frontend manually
cd frontend && npm run build

# 3. Check TypeScript errors
cd frontend && npx tsc --noEmit

# 4. Check if Vite dev server is running (development)
curl -s http://localhost:5173/ | head -20

# 5. Check for environment variable issues
echo $VITE_API_URL
```

**Resolution:**

1. **Development — Vite not running:**
   ```bash
   cd frontend && npm run dev
   ```

2. **Production — Missing build artifacts:**
   ```bash
   # Rebuild frontend
   cd frontend && npm run build
   
   # Verify output
   ls -la dist/
   
   # In Docker — rebuild the image
   docker compose build timesheet-app
   docker compose up -d
   ```

3. **TypeScript compilation errors:**
   ```bash
   # Check for type errors
   cd frontend && npx tsc --noEmit 2>&1 | head -50
   
   # Fix or skip (not recommended for production)
   ```

4. **Missing VITE_API_URL:**
   ```bash
   # Create/fix .env file
   echo "VITE_API_URL=http://localhost:3001" > frontend/.env
   npm run build
   ```

**Prevention:**
- Run `npm run build` in CI before deployment
- Add TypeScript strict checks to pre-commit hooks
- Validate environment variables at build time

---

### FM-7: Rate Limiting Triggered

**Symptoms:**
- Users receive HTTP 429 "Too Many Requests"
- Legitimate users locked out after automated testing or bulk operations
- Frontend shows "rate limit exceeded" errors

**Impact:** P3 — Partial service degradation for affected users

**Diagnosis:**

```bash
# 1. Check rate limit configuration
grep -A5 "rateLimit" backend/src/server.js

# 2. Current settings: 100 requests per 15 minutes per IP

# 3. Check if specific IPs are affected
docker logs <container_id> 2>&1 | grep "429\|rate"

# 4. Verify from the client
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health
```

**Resolution:**

1. **Immediate — Restart clears rate limit store (in-memory):**
   ```bash
   docker restart timesheet-app
   ```

2. **Adjust rate limits temporarily:**
   ```javascript
   // In server.js, increase limits
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 500  // Increased from 100
   });
   ```

3. **Whitelist internal IPs:**
   ```javascript
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 100,
     skip: (req) => req.ip === '127.0.0.1'  // Skip for trusted IPs
   });
   ```

**Prevention:**
- Configure different rate limits for different endpoint groups
- Use Redis-backed rate limiting for persistence across restarts
- Monitor 429 response rates
- Document rate limits for API consumers

---

### FM-8: File System Errors (CSV/PDF Export)

**Symptoms:**
- CSV/PDF export returns HTTP 500 "Failed to generate report"
- `ENOENT`, `EACCES`, or `ENOSPC` errors in logs
- Temp directory fills up with orphaned files

**Impact:** P3 — Export functionality unavailable, core CRUD still works

**Diagnosis:**

```bash
# 1. Check temp directory
ls -la backend/temp/ 2>/dev/null || echo "temp dir missing"
du -sh backend/temp/

# 2. Check disk space
df -h .

# 3. Check file permissions
stat backend/temp/

# 4. Test export endpoint
curl -s -H "x-user-email: test@example.com" \
  http://localhost:3001/api/reports/export/csv/1 -o /dev/null -w "%{http_code}"

# 5. Check for orphaned temp files
find backend/temp/ -mmin +60 -type f
```

**Resolution:**

1. **Missing temp directory:**
   ```bash
   mkdir -p backend/temp
   chmod 755 backend/temp
   # In Docker
   docker exec <container_id> mkdir -p /app/temp
   ```

2. **Disk space full:**
   ```bash
   # Clean old temp files
   find backend/temp/ -mmin +30 -delete
   
   # Check for large log files
   find /var/log -name "*.log" -size +100M -exec truncate -s 0 {} \;
   ```

3. **Permission issues:**
   ```bash
   # Fix ownership in Docker
   docker exec <container_id> chown -R nodejs:nodejs /app/temp
   ```

**Prevention:**
- Implement automatic temp file cleanup after download
- Set up disk space monitoring
- Use streaming responses instead of temp files for exports
- Add temp directory creation to startup routine

---

### FM-9: CORS / Network Connectivity Issues

**Symptoms:**
- Browser console shows `CORS policy` errors
- Frontend cannot reach backend API
- Preflight (OPTIONS) requests fail

**Impact:** P2 — Frontend completely non-functional

**Diagnosis:**

```bash
# 1. Check CORS configuration
grep -A3 "cors" backend/src/server.js

# 2. Check FRONTEND_URL environment variable
echo $FRONTEND_URL

# 3. Test CORS headers
curl -v -X OPTIONS http://localhost:3001/api/clients \
  -H "Origin: http://localhost:5173" \
  -H "Access-Control-Request-Method: GET" 2>&1 | grep -i "access-control"

# 4. Check if backend is reachable from frontend's perspective
curl -s http://localhost:3001/health
```

**Resolution:**

1. **Incorrect FRONTEND_URL:**
   ```bash
   # Set correct origin
   export FRONTEND_URL=http://localhost:5173  # or production URL
   # Restart server
   ```

2. **Multiple origins needed (e.g., staging + production):**
   ```javascript
   // Update cors configuration
   app.use(cors({
     origin: [process.env.FRONTEND_URL, 'https://staging.example.com'],
     credentials: true
   }));
   ```

3. **Proxy misconfiguration (development):**
   ```bash
   # Check Vite proxy config in frontend/vite.config.ts
   # Ensure /api routes proxy to http://localhost:3001
   ```

**Prevention:**
- Validate FRONTEND_URL on startup
- Use environment-specific configuration files
- Test CORS in CI/CD pipeline
- Document allowed origins

---

### FM-10: Docker Container Health Check Failure

**Symptoms:**
- `docker ps` shows container as `unhealthy`
- Container restarts repeatedly
- Health check endpoint works manually but Docker reports failure

**Impact:** P2 — Service may be running but orchestrator marks it down

**Diagnosis:**

```bash
# 1. Check container health status
docker inspect --format='{{json .State.Health}}' <container_id> | jq .

# 2. Check health check logs
docker inspect --format='{{range .State.Health.Log}}{{.Output}}{{end}}' <container_id>

# 3. Test health check command manually inside container
docker exec <container_id> node -e "require('http').get('http://localhost:3001/health', (r) => { console.log(r.statusCode); process.exit(r.statusCode === 200 ? 0 : 1) })"

# 4. Check container resource usage
docker stats --no-stream <container_id>

# 5. Check startup timing
docker logs <container_id> 2>&1 | head -20
```

**Resolution:**

1. **Slow startup (health check fires before app is ready):**
   ```yaml
   # Increase start_period in Dockerfile/docker-compose
   healthcheck:
     test: ["CMD", "node", "-e", "require('http').get('http://localhost:3001/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"]
     interval: 30s
     timeout: 5s
     start_period: 10s   # Increase this
     retries: 5           # Increase this
   ```

2. **Application hanging during health check:**
   ```bash
   # Check if event loop is blocked
   docker exec <container_id> node -e "setTimeout(() => console.log('responsive'), 100)"
   
   # Restart with resource limits
   docker restart timesheet-app
   ```

3. **Network issues inside container:**
   ```bash
   # Verify localhost is resolvable
   docker exec <container_id> getent hosts localhost
   ```

**Prevention:**
- Set appropriate start_period for JVM/Node.js startup time
- Use lightweight health check (no DB queries)
- Monitor health check failure patterns

---

## Escalation Matrix

| Priority | Response Time | Resolution Target | Escalation Path |
|----------|--------------|-------------------|-----------------|
| **P1** — Total outage | 15 minutes | 1 hour | On-call → Team Lead → Engineering Manager |
| **P2** — Major degradation | 30 minutes | 4 hours | On-call → Team Lead |
| **P3** — Partial impact | 2 hours | 24 hours | On-call → Ticket |
| **P4** — Minor issue | Next business day | 1 week | Ticket |

---

## Post-Incident Review Template

After resolving any P1 or P2 incident, complete the following within 48 hours:

### Incident Summary
- **Date/Time:** [When did it start and end?]
- **Duration:** [Total impact time]
- **Severity:** [P1/P2/P3/P4]
- **Affected Users:** [Number/percentage of users impacted]

### Timeline
1. [Timestamp] — Issue detected
2. [Timestamp] — First responder engaged
3. [Timestamp] — Root cause identified
4. [Timestamp] — Fix deployed
5. [Timestamp] — Service restored
6. [Timestamp] — All-clear communicated

### Root Cause
[What was the underlying cause?]

### Resolution
[What was done to fix it?]

### Action Items
| Action | Owner | Due Date | Status |
|--------|-------|----------|--------|
| [Preventive measure] | [Name] | [Date] | Open |

### Lessons Learned
- What went well?
- What could be improved?
- What monitoring gaps were identified?
