# Incident Response Runbook — Timesheet App

## Table of Contents

- [Overview](#overview)
- [Architecture Summary](#architecture-summary)
- [Failure Mode 1: Database Failures](#failure-mode-1-database-failures)
- [Failure Mode 2: API Errors & Unhandled Exceptions](#failure-mode-2-api-errors--unhandled-exceptions)
- [Failure Mode 3: Memory Leaks & Resource Exhaustion](#failure-mode-3-memory-leaks--resource-exhaustion)
- [Failure Mode 4: Dependency & Connectivity Failures](#failure-mode-4-dependency--connectivity-failures)
- [Failure Mode 5: Rate Limiting & Denial of Service](#failure-mode-5-rate-limiting--denial-of-service)
- [Failure Mode 6: Authentication Failures](#failure-mode-6-authentication-failures)
- [Failure Mode 7: File System & Export Failures](#failure-mode-7-file-system--export-failures)
- [Escalation Matrix](#escalation-matrix)
- [Post-Incident Checklist](#post-incident-checklist)

---

## Overview

This runbook provides step-by-step response procedures for common failure modes in the Timesheet App. The app is a full-stack Node.js/React application with:

- **Backend**: Express.js API (port 3001) with SQLite database
- **Frontend**: React SPA via Vite (port 5173)
- **Database**: SQLite (in-memory in dev, file-based in production via Docker overrides)
- **Deployment**: Docker on AWS EC2 with EBS-mounted storage

---

## Architecture Summary

```
┌─────────────┐       ┌─────────────────┐       ┌────────────┐
│  React SPA  │──────▶│  Express API    │──────▶│  SQLite DB │
│  (Vite)     │       │  (port 3001)    │       │  (EBS vol) │
│  port 5173  │       │                 │       └────────────┘
└─────────────┘       │  Middleware:    │
                      │  - helmet       │
                      │  - cors         │
                      │  - rate-limit   │
                      │  - morgan       │
                      └─────────────────┘
```

**Critical Endpoints:**
| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Health check |
| `POST /api/auth/login` | User authentication |
| `GET /api/clients` | List clients |
| `GET /api/work-entries` | List work entries |
| `GET /api/reports/client/:id` | Client report |
| `GET /api/reports/export/csv/:id` | CSV export |
| `GET /api/reports/export/pdf/:id` | PDF export |

---

## Failure Mode 1: Database Failures

### Symptoms
- HTTP 500 responses with `"Database error"` message
- `SQLITE_BUSY`, `SQLITE_LOCKED`, or `SQLITE_CORRUPT` in logs
- All authenticated endpoints returning 500
- Data loss after container restart (in-memory mode)

### Diagnosis

```bash
# 1. Check application logs for SQLite errors
docker logs <container_id> 2>&1 | grep -i "sqlite\|database\|SQLITE_"

# 2. Verify database file exists (production)
docker exec <container_id> ls -la /app/data/

# 3. Check disk space on EBS volume
df -h /mnt/data

# 4. Test database connectivity via health check
curl -s http://localhost:3001/health | jq .
```

### Response Procedure

1. **SQLITE_BUSY / SQLITE_LOCKED**
   - Identify long-running queries or concurrent write contention
   - Restart the application container: `docker restart <container_id>`
   - If persists, check for zombie processes: `docker exec <container_id> ps aux`

2. **SQLITE_CORRUPT**
   - **Do NOT restart** — this may worsen corruption
   - Take an immediate backup: `docker exec <container_id> cp /app/data/timesheet.db /app/data/timesheet.db.bak`
   - Run integrity check: `docker exec <container_id> sqlite3 /app/data/timesheet.db "PRAGMA integrity_check;"`
   - If corrupt, restore from most recent EBS snapshot
   - Escalate to P1 if data loss confirmed

3. **Data Loss (in-memory mode)**
   - Verify `NODE_ENV` — in-memory is expected in development only
   - In production, confirm Docker overrides are applied (check `/app/data/` mount)
   - If production data lost, restore from EBS snapshot via AWS Console

4. **Disk Full**
   - Check EBS volume usage: `df -h`
   - Remove old temp files: `find /app/temp -mtime +1 -delete`
   - Extend EBS volume if needed via AWS Console → modify volume → extend filesystem

---

## Failure Mode 2: API Errors & Unhandled Exceptions

### Symptoms
- Consistent 500 errors on specific endpoints
- Node.js process crashes and restarts
- `uncaughtException` or `unhandledRejection` in logs
- Joi validation errors (400) on previously working requests

### Diagnosis

```bash
# 1. Check recent error logs
docker logs --tail 100 <container_id> 2>&1 | grep -i "error\|Error:"

# 2. Check if process is still running
docker exec <container_id> pgrep -f "node src/server.js"

# 3. Verify all routes respond
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health
curl -s -o /dev/null -w "%{http_code}" -H "x-user-email: test@test.com" http://localhost:3001/api/clients

# 4. Check container restart count
docker inspect <container_id> | jq '.[0].RestartCount'
```

### Response Procedure

1. **Consistent 500 on a single endpoint**
   - Check logs for the specific route handler error
   - Verify request payload matches Joi schema expectations
   - Test with minimal valid payload to isolate the issue
   - If database-related, see [Failure Mode 1](#failure-mode-1-database-failures)

2. **Process crashes (exit code 1)**
   - Check for unhandled promise rejections in route handlers
   - Review recent deployments for breaking changes
   - Restart with increased memory if OOM: `docker run --memory=512m ...`
   - Enable verbose logging: set `NODE_ENV=development` temporarily

3. **Validation errors on previously working requests**
   - Check if Joi schemas were updated in recent deployment
   - Verify client is sending correct `Content-Type: application/json` header
   - Check `x-user-email` header is present and valid email format

---

## Failure Mode 3: Memory Leaks & Resource Exhaustion

### Symptoms
- Gradually increasing memory usage
- Slower response times over hours/days
- OOMKilled by Docker/OS
- PDF/CSV export timeouts

### Diagnosis

```bash
# 1. Check container memory usage
docker stats <container_id> --no-stream

# 2. Check host memory
free -h

# 3. Check for temp file accumulation
docker exec <container_id> find /app/temp -type f | wc -l
docker exec <container_id> du -sh /app/temp

# 4. Check Node.js heap usage (if debug endpoint available)
docker exec <container_id> node -e "console.log(process.memoryUsage())"
```

### Response Procedure

1. **Gradual memory growth**
   - In-memory SQLite grows as data accumulates — this is expected
   - For production, ensure file-based SQLite is configured (Docker overrides)
   - Set container memory limits: `--memory=512m --memory-swap=512m`
   - Schedule periodic container restarts during off-peak if no persistence concern

2. **Temp file accumulation (CSV/PDF exports)**
   - Clean orphaned temp files: `docker exec <container_id> find /app/temp -mmin +30 -delete`
   - Monitor temp directory size
   - If recurring, investigate failed `fs.unlink` calls in export routes

3. **OOMKilled**
   - Check `docker inspect` for OOMKilled flag
   - Increase container memory limit
   - Investigate large report exports (many work entries) as triggers
   - Consider pagination for large data sets

---

## Failure Mode 4: Dependency & Connectivity Failures

### Symptoms
- Frontend shows network errors / blank page
- CORS errors in browser console
- `ECONNREFUSED` when frontend calls backend
- Native module (`sqlite3`) load failures after deployment

### Diagnosis

```bash
# 1. Check backend is reachable from frontend container/host
curl -s http://localhost:3001/health

# 2. Check CORS configuration
curl -s -I -X OPTIONS -H "Origin: http://localhost:5173" http://localhost:3001/api/clients

# 3. Check native modules loaded correctly
docker exec <container_id> node -e "require('sqlite3')"

# 4. Check npm dependencies are installed
docker exec <container_id> ls node_modules/.package-lock.json
```

### Response Procedure

1. **Frontend cannot reach backend**
   - Verify `FRONTEND_URL` env var matches actual frontend origin
   - Check Docker network connectivity between containers
   - Verify Vite proxy config points to correct backend URL
   - Check if rate limiter is blocking (see [Failure Mode 5](#failure-mode-5-rate-limiting--denial-of-service))

2. **CORS errors**
   - Verify `FRONTEND_URL` in backend `.env` matches requesting origin exactly
   - For production: ensure `FRONTEND_URL` includes protocol (e.g., `https://app.example.com`)
   - Restart backend after env var change

3. **sqlite3 native module failure**
   - Rebuild native modules: `docker exec <container_id> npm rebuild sqlite3`
   - If fails, rebuild container image with matching Node.js architecture
   - Verify Dockerfile uses same Node.js version as `package.json` engines

4. **npm dependency issues**
   - Run `npm ci` (clean install) inside container
   - Check for conflicting lockfile: compare `package-lock.json` in image vs repo
   - Verify no private registry auth issues in CI/CD

---

## Failure Mode 5: Rate Limiting & Denial of Service

### Symptoms
- HTTP 429 (Too Many Requests) responses
- Legitimate users blocked from API access
- All requests from an IP being rejected
- Sudden spike in request volume in logs

### Diagnosis

```bash
# 1. Check for 429 responses in logs
docker logs <container_id> 2>&1 | grep " 429 "

# 2. Check request volume by IP
docker logs <container_id> 2>&1 | awk '{print $1}' | sort | uniq -c | sort -rn | head

# 3. Current rate limit configuration
# Default: 100 requests per 15-minute window per IP
```

### Response Procedure

1. **Legitimate users rate-limited**
   - Identify the IP being limited from logs
   - Temporarily increase limit by updating `max` in rate limiter config
   - Consider per-user (email) rate limiting instead of per-IP for shared networks
   - Restart application after config change

2. **Suspected abuse/DDoS**
   - Identify offending IPs from access logs
   - Block at infrastructure level (AWS Security Group / WAF)
   - Do NOT increase rate limits
   - Monitor for distributed patterns across multiple IPs
   - Escalate to P2 if service degradation persists

---

## Failure Mode 6: Authentication Failures

### Symptoms
- HTTP 401 on all authenticated endpoints
- `"User email required in x-user-email header"` errors
- Users unable to log in
- Authentication middleware creating duplicate users

### Diagnosis

```bash
# 1. Test auth flow manually
curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com"}'

# 2. Test authenticated endpoint
curl -s -H "x-user-email: test@example.com" http://localhost:3001/api/clients

# 3. Check users table
docker exec <container_id> sqlite3 /app/data/timesheet.db "SELECT COUNT(*) FROM users;"
```

### Response Procedure

1. **Missing x-user-email header**
   - Verify frontend is including header in all API requests
   - Check Axios interceptor in `frontend/src/api/client.ts`
   - Verify user email is stored in frontend state after login

2. **Invalid email format rejection**
   - Check email regex in auth middleware
   - Verify no whitespace/encoding issues in header value
   - Test with known-good email format

3. **Database errors during auth**
   - See [Failure Mode 1](#failure-mode-1-database-failures)
   - Auth middleware auto-creates users — if DB is down, all auth fails

---

## Failure Mode 7: File System & Export Failures

### Symptoms
- CSV/PDF export returns 500
- `ENOENT` or `EACCES` errors in logs
- Temp directory missing or not writable
- Downloads hang or return empty files

### Diagnosis

```bash
# 1. Check temp directory exists and is writable
docker exec <container_id> ls -la /app/temp/
docker exec <container_id> touch /app/temp/test && rm /app/temp/test

# 2. Check disk space
docker exec <container_id> df -h /app/temp

# 3. Check for stuck file handles
docker exec <container_id> lsof +D /app/temp 2>/dev/null
```

### Response Procedure

1. **Temp directory missing**
   - Create it: `docker exec <container_id> mkdir -p /app/temp`
   - Verify container filesystem is writable
   - Add directory creation to Dockerfile or entrypoint

2. **Permission denied**
   - Check container user: `docker exec <container_id> whoami`
   - Fix permissions: `docker exec <container_id> chmod 755 /app/temp`
   - Verify volume mount permissions in Docker Compose

3. **Export hangs on large data**
   - Check for clients with excessive work entries
   - Consider implementing streaming exports for large datasets
   - Set response timeout on reverse proxy (if applicable)

---

## Escalation Matrix

| Severity | Response Time | Escalation Path | Example |
|----------|--------------|-----------------|---------|
| **P1** | 15 minutes | On-call → Team Lead → Engineering Manager | Complete data loss, all users blocked |
| **P2** | 1 hour | On-call → Team Lead | Major feature broken (exports, auth) |
| **P3** | 4 hours | Team queue | Single endpoint 500, rate limit tuning |
| **P4** | Next sprint | Backlog | Minor UX issue, log noise |

### On-Call Responsibilities
- Acknowledge alert within response time SLA
- Begin diagnosis using this runbook
- Communicate status in incident channel
- Document actions taken and outcome

---

## Post-Incident Checklist

- [ ] Root cause identified and documented
- [ ] Immediate fix applied and verified
- [ ] Monitoring/alerting gap addressed
- [ ] Incident timeline written
- [ ] Preventive measures identified
- [ ] Runbook updated if procedures were missing/incorrect
- [ ] Post-mortem scheduled (P1/P2 only)
- [ ] Customer communication sent if user-facing impact
