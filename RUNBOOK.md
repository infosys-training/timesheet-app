# Incident Response Runbook

## Application Overview

The Timesheet App is a full-stack application for tracking labor hours across clients.

| Component | Technology | Port | Purpose |
|-----------|-----------|------|---------|
| Backend | Node.js / Express | 3001 | REST API, report generation |
| Frontend | React / Vite | 5173 (dev) | SPA served via proxy or static build |
| Database | SQLite | N/A | In-memory (dev) / file-based (prod) |
| Proxy | Vite dev / Nginx (prod) | — | Routes `/api` to backend |

---

## Table of Contents

1. [FM-1: Database Connectivity / Corruption](#fm-1-database-connectivity--corruption)
2. [FM-2: Backend Process Crash / OOM](#fm-2-backend-process-crash--oom)
3. [FM-3: API Rate Limiting Exceeded](#fm-3-api-rate-limiting-exceeded)
4. [FM-4: Report Generation Failure (PDF/CSV)](#fm-4-report-generation-failure-pdfcsv)
5. [FM-5: Authentication Middleware Failure](#fm-5-authentication-middleware-failure)
6. [FM-6: Frontend/Backend Connectivity Loss (CORS / Proxy)](#fm-6-frontendbackend-connectivity-loss-cors--proxy)
7. [FM-7: Disk Space Exhaustion](#fm-7-disk-space-exhaustion)
8. [FM-8: Docker Container Health Check Failure](#fm-8-docker-container-health-check-failure)

---

## FM-1: Database Connectivity / Corruption

### Symptoms
- HTTP 500 responses with `"Database error"` or `"Internal server error"` messages
- Backend logs show `SQLITE_CANTOPEN`, `SQLITE_CORRUPT`, or `SQLITE_BUSY`
- Health check (`/health`) passes but all data endpoints return 500

### Impact
- **Severity**: P1 (all users unable to read/write data)
- All CRUD operations fail; reports cannot be generated

### Diagnosis

```bash
# 1. Check backend logs for SQLite errors
docker logs <container_id> 2>&1 | grep -i "sqlite\|database error"

# 2. Verify database file (production only - file-based SQLite)
ls -la /app/data/timesheet.db
sqlite3 /app/data/timesheet.db "PRAGMA integrity_check;"

# 3. Check disk space on database volume
df -h /app/data

# 4. Check file permissions
stat /app/data/timesheet.db
```

### Resolution Steps

1. **If `SQLITE_BUSY`** — Another process holds a lock.
   ```bash
   # Find locking processes
   fuser /app/data/timesheet.db
   # Restart the backend (only one writer at a time for SQLite)
   docker restart <container_id>
   ```

2. **If `SQLITE_CORRUPT`** — Database file is corrupted.
   ```bash
   # Attempt recovery
   sqlite3 /app/data/timesheet.db ".dump" > backup.sql
   mv /app/data/timesheet.db /app/data/timesheet.db.corrupt
   sqlite3 /app/data/timesheet.db < backup.sql
   docker restart <container_id>
   ```

3. **If `SQLITE_CANTOPEN`** — Permission or path issue.
   ```bash
   # Fix ownership (container runs as nodejs:1001)
   chown 1001:1001 /app/data/timesheet.db
   chmod 664 /app/data/timesheet.db
   docker restart <container_id>
   ```

4. **In-memory database (dev)** — Data is ephemeral; simply restart the process.
   ```bash
   # Kill and restart the dev server
   pkill -f "nodemon src/server.js"
   cd backend && npm run dev
   ```

### Prevention
- Schedule regular backups of the SQLite file in production
- Monitor disk usage on the data volume
- Use WAL mode for better concurrency: `PRAGMA journal_mode=WAL;`

---

## FM-2: Backend Process Crash / OOM

### Symptoms
- Container exits with code 137 (OOM killed) or 1 (unhandled error)
- Health check endpoint unreachable
- Frontend displays network errors on all API calls

### Impact
- **Severity**: P1 (complete service outage)

### Diagnosis

```bash
# 1. Check container status and exit code
docker ps -a --filter "name=timesheet"
docker inspect <container_id> --format='{{.State.ExitCode}} {{.State.OOMKilled}}'

# 2. Check memory usage
docker stats <container_id> --no-stream

# 3. Review crash logs
docker logs --tail 100 <container_id>

# 4. Check Node.js heap usage (if process is still running)
curl -s http://localhost:3001/health | jq .
```

### Resolution Steps

1. **If OOM killed (exit 137)**:
   ```bash
   # Increase container memory limit
   docker update --memory=512m --memory-swap=1g <container_id>
   docker restart <container_id>
   ```

2. **If unhandled exception (exit 1)**:
   ```bash
   # Check logs for the error
   docker logs --tail 50 <container_id>
   # Restart the container
   docker restart <container_id>
   ```

3. **For persistent memory growth** (memory leak):
   ```bash
   # Take a heap snapshot for analysis
   kill -USR2 <node_pid>
   # Restart as immediate mitigation
   docker restart <container_id>
   ```

### Prevention
- Set `--max-old-space-size=256` for Node.js in production
- Add memory monitoring/alerting via Docker or orchestrator
- Implement graceful shutdown handling (SIGTERM)

---

## FM-3: API Rate Limiting Exceeded

### Symptoms
- HTTP 429 "Too Many Requests" responses
- Users report intermittent failures during bulk operations
- Frontend shows errors when rapidly switching between views

### Impact
- **Severity**: P3 (degraded experience for heavy users)

### Diagnosis

```bash
# 1. Check for 429 responses in logs
docker logs <container_id> 2>&1 | grep "429\|rate"

# 2. Current rate limit config (server.js):
#    windowMs: 15 * 60 * 1000 (15 minutes)
#    max: 100 requests per IP

# 3. Test current rate limit status
for i in $(seq 1 105); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health)
  echo "Request $i: $STATUS"
done
```

### Resolution Steps

1. **Immediate relief** — If legitimate traffic is being blocked:
   ```bash
   # Restart the backend to reset rate limit counters
   docker restart <container_id>
   ```

2. **If a single IP is causing excessive load** (abuse):
   ```bash
   # Identify the IP from access logs (morgan combined format)
   docker logs <container_id> | awk '{print $1}' | sort | uniq -c | sort -rn | head
   # Block at network/firewall level if needed
   ```

3. **Adjust limits** (if legitimate usage exceeds threshold):
   - Edit `backend/src/server.js` and increase `max` in the rate limiter config
   - Consider per-route rate limits for report exports vs. normal CRUD

### Prevention
- Monitor 429 response rates
- Implement per-user rate limits (not just per-IP) for authenticated endpoints
- Add exponential backoff in the frontend Axios client

---

## FM-4: Report Generation Failure (PDF/CSV)

### Symptoms
- HTTP 500 on `/api/reports/export/pdf/:clientId` or `/api/reports/export/csv/:clientId`
- Backend logs show `Error creating CSV` or PDF-related exceptions
- Temp files accumulating in `backend/temp/`

### Impact
- **Severity**: P3 (report export unavailable; core CRUD still works)

### Diagnosis

```bash
# 1. Check for report generation errors
docker logs <container_id> 2>&1 | grep -i "csv\|pdf\|report\|temp"

# 2. Check temp directory
ls -la /app/temp/ 2>/dev/null || echo "No temp dir"
du -sh /app/temp/ 2>/dev/null

# 3. Check available disk space
df -h /app

# 4. Test report generation directly
curl -s -H "x-user-email: test@example.com" \
  http://localhost:3001/api/reports/client/1 | jq .
```

### Resolution Steps

1. **If disk full** — Clean up orphaned temp files:
   ```bash
   # Remove old temp files (CSV exports)
   find /app/temp -name "*.csv" -mmin +30 -delete
   ```

2. **If PDF generation fails** (pdfkit errors):
   ```bash
   # Check available memory (PDF generation is memory-intensive)
   docker stats <container_id> --no-stream
   # Restart if memory is near limit
   docker restart <container_id>
   ```

3. **If temp directory missing or not writable**:
   ```bash
   mkdir -p /app/temp
   chown 1001:1001 /app/temp
   ```

### Prevention
- Implement a cron job to clean up temp files older than 1 hour
- Set a max report size limit
- Stream PDFs directly to response instead of writing to disk

---

## FM-5: Authentication Middleware Failure

### Symptoms
- All authenticated endpoints return 401 `"User email required in x-user-email header"`
- Or 500 errors during user lookup/creation
- Frontend keeps redirecting to `/login`

### Impact
- **Severity**: P2 (all authenticated operations fail)

### Diagnosis

```bash
# 1. Verify auth header is being sent
curl -v -H "x-user-email: test@example.com" http://localhost:3001/api/clients

# 2. Check if it's a database issue blocking user lookup
curl -s http://localhost:3001/health | jq .

# 3. Check frontend localStorage (in browser console)
# localStorage.getItem('userEmail')

# 4. Check CORS headers (might be stripping custom headers)
curl -v -X OPTIONS -H "Origin: http://localhost:5173" \
  -H "Access-Control-Request-Headers: x-user-email" \
  http://localhost:3001/api/clients
```

### Resolution Steps

1. **If CORS is blocking the header**:
   - Verify `FRONTEND_URL` env var matches the actual frontend origin
   - Check that `x-user-email` is in the allowed headers list

2. **If database cannot create/find users** — see [FM-1](#fm-1-database-connectivity--corruption)

3. **If frontend is not sending the header**:
   - Check browser dev tools → Network tab → Request headers
   - Verify `localStorage.getItem('userEmail')` is set
   - Clear localStorage and re-login

### Prevention
- Add structured logging for auth failures (email, origin, timestamp)
- Monitor 401 response rate

---

## FM-6: Frontend/Backend Connectivity Loss (CORS / Proxy)

### Symptoms
- Frontend shows "Network Error" on all API requests
- Browser console shows CORS errors or connection refused
- Backend health check passes when hit directly

### Impact
- **Severity**: P2 (frontend completely non-functional)

### Diagnosis

```bash
# 1. Check if backend is responding
curl -s http://localhost:3001/health

# 2. Check Vite proxy config (dev mode)
cat frontend/vite.config.ts | grep -A5 proxy

# 3. Check CORS origin configuration
echo $FRONTEND_URL

# 4. Check if the frontend can reach the backend (from browser)
# Open browser console: fetch('/health').then(r => r.json()).then(console.log)
```

### Resolution Steps

1. **Dev mode — Vite proxy issue**:
   ```bash
   # Restart the frontend dev server
   pkill -f "vite"
   cd frontend && npm run dev
   ```

2. **Production — CORS misconfiguration**:
   ```bash
   # Set correct FRONTEND_URL
   export FRONTEND_URL=https://your-actual-domain.com
   docker restart <container_id>
   ```

3. **Production — Nginx/reverse proxy down**:
   ```bash
   # Check nginx status
   nginx -t
   systemctl restart nginx
   ```

### Prevention
- Include CORS validation in deployment checklist
- Add connectivity smoke test to CI/CD pipeline

---

## FM-7: Disk Space Exhaustion

### Symptoms
- Write operations fail (new entries, report exports)
- Container health check may still pass (read-only)
- Logs show `ENOSPC` or `SQLITE_FULL` errors

### Impact
- **Severity**: P2 (writes fail; reads may still work)

### Diagnosis

```bash
# 1. Check disk usage
df -h
du -sh /app/data /app/temp /var/log 2>/dev/null

# 2. Find large files
find / -type f -size +100M 2>/dev/null

# 3. Check Docker volumes
docker system df
```

### Resolution Steps

1. **Clean temp files**:
   ```bash
   find /app/temp -type f -mmin +60 -delete
   ```

2. **Clean Docker resources**:
   ```bash
   docker system prune -f
   docker volume prune -f
   ```

3. **Rotate/truncate logs**:
   ```bash
   truncate -s 0 /var/log/*.log
   ```

4. **Expand disk** (if on cloud):
   - Resize the underlying EBS/disk volume
   - Extend the filesystem

### Prevention
- Set up disk usage alerts at 80% threshold
- Implement log rotation
- Schedule temp file cleanup via cron

---

## FM-8: Docker Container Health Check Failure

### Symptoms
- `docker ps` shows container as `unhealthy`
- Orchestrator (Docker Compose, Kubernetes) may restart the container repeatedly
- Intermittent availability during restart loops

### Impact
- **Severity**: P2 (service instability due to restart loops)

### Diagnosis

```bash
# 1. Check health check status
docker inspect <container_id> --format='{{json .State.Health}}' | jq .

# 2. Check health check logs (last 5 results)
docker inspect <container_id> --format='{{json .State.Health.Log}}' | jq .

# 3. Manually run the health check
docker exec <container_id> node -e \
  "require('http').get('http://localhost:3001/health', (r) => { console.log(r.statusCode); process.exit(r.statusCode === 200 ? 0 : 1); })"

# 4. Check if port 3001 is listening inside the container
docker exec <container_id> netstat -tlnp | grep 3001
```

### Resolution Steps

1. **If the app hasn't started yet** (slow startup):
   - Increase `start-period` in the HEALTHCHECK directive
   - Check if database initialization is hanging

2. **If the app crashed inside the container**:
   ```bash
   docker logs --tail 50 <container_id>
   docker restart <container_id>
   ```

3. **If the health endpoint is unreachable from inside** (port binding issue):
   ```bash
   # Verify PORT env var
   docker exec <container_id> printenv PORT
   # Should be 3001
   ```

### Prevention
- Set appropriate `start-period` for JVM-free Node.js (5–10s is sufficient)
- Ensure graceful shutdown so restarts are clean
- Add readiness vs. liveness separation if using Kubernetes

---

## Escalation Matrix

| Severity | Response Time | Escalation Path |
|----------|--------------|-----------------|
| P1 — Service Down | 15 min | On-call engineer → Team lead → Engineering manager |
| P2 — Major Degradation | 30 min | On-call engineer → Team lead |
| P3 — Minor Degradation | 4 hours | Assigned engineer |
| P4 — Cosmetic / Low Impact | Next business day | Backlog triage |

---

## General Recovery Checklist

1. Confirm the issue by checking the `/health` endpoint
2. Review recent deployments or config changes
3. Check container logs for errors
4. Verify database connectivity and integrity
5. Check disk space and memory usage
6. Attempt restart if root cause is transient
7. Document timeline and resolution in an incident report
