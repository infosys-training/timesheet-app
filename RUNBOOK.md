# Timesheet Application — Incident Response Runbook

## Table of Contents

- [Overview](#overview)
- [Architecture Summary](#architecture-summary)
- [Monitoring & Alerting](#monitoring--alerting)
- [Failure Mode 1: Database Failures](#failure-mode-1-database-failures)
- [Failure Mode 2: API / HTTP Errors](#failure-mode-2-api--http-errors)
- [Failure Mode 3: Memory & Resource Leaks](#failure-mode-3-memory--resource-leaks)
- [Failure Mode 4: Dependency & Infrastructure Failures](#failure-mode-4-dependency--infrastructure-failures)
- [Failure Mode 5: Authentication & Authorization Failures](#failure-mode-5-authentication--authorization-failures)
- [Supplementary: .NET Application Failure Modes](#supplementary-net-application-failure-modes)
- [Incident Severity Definitions](#incident-severity-definitions)
- [Escalation Contacts](#escalation-contacts)
- [Post-Incident Review Checklist](#post-incident-review-checklist)

---

## Overview

This runbook provides step-by-step incident response procedures for the **Timesheet Application**, a full-stack time-tracking system. It covers both the Node.js/Express + SQLite stack used by this repo and supplementary guidance for .NET-based applications.

**Quick Reference — Critical Endpoints:**

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness probe |
| `POST /api/auth/login` | User authentication |
| `GET /api/clients` | Client listing |
| `GET /api/work-entries` | Work entry listing |
| `GET /api/reports/client/:id` | Report generation |
| `GET /api/reports/export/csv/:id` | CSV export |
| `GET /api/reports/export/pdf/:id` | PDF export |

---

## Architecture Summary

```
┌─────────────────┐      Vite Proxy (/api)      ┌─────────────────────┐
│  React Frontend │  ──────────────────────────► │  Express Backend    │
│  (port 5173)    │                              │  (port 3001)        │
│  Vite + MUI     │  ◄────────────────────────── │  helmet, cors,      │
└─────────────────┘                              │  rate-limit, morgan │
                                                 └────────┬────────────┘
                                                          │
                                                 ┌────────▼────────────┐
                                                 │  SQLite Database    │
                                                 │  :memory: (dev)     │
                                                 │  /app/data/ (prod)  │
                                                 └─────────────────────┘
```

- **Dev mode**: In-memory SQLite, Vite dev server proxies `/api` to backend.
- **Production (Docker)**: File-based SQLite at `/app/data/timesheet.db`, backend serves static frontend build, `dumb-init` for signal handling.
- **Auth model**: Email-only (passwordless), passed via `x-user-email` header.
- **Rate limiting**: 100 requests per 15-minute window per IP.

---

## Monitoring & Alerting

### Recommended Alerts (Node.js/Express)

| Alert | Condition | Priority |
|---|---|---|
| Health check failure | `GET /health` non-200 or timeout >3s | P1 |
| High 5xx error rate | >5% of requests returning 5xx in 5min | P1 |
| Database errors | Any `SQLITE_*` error codes in logs | P1 |
| Docker restart loop | Container restarts >2 in 10min | P1 |
| Unhandled rejections | `unhandledRejection` or `uncaughtException` in logs | P1 |
| API latency spike | p95 response time >2s | P2 |
| Memory usage | Node.js RSS >512MB or >80% container memory | P2 |
| Event loop lag | Delay >100ms | P2 |
| Rate limiter saturation | >50% of IPs hitting 429 in 15min | P2 |
| CPU sustained high | >80% for >5min | P2 |
| Disk usage (prod) | `/app/data/` >80% capacity | P3 |
| Temp file buildup | `backend/temp/` >100MB | P3 |
| Auth failure spike | >20 consecutive 401s in 5min | P3 |

### Recommended Alerts (.NET Applications)

| Alert | Condition | Priority |
|---|---|---|
| Health check failure | `/healthz` non-200 | P1 |
| Unhandled exceptions | >5/min in Application Insights | P1 |
| SQL connection pool exhaustion | Active connections >80% of `Max Pool Size` | P1 |
| Thread pool starvation | Available threads <10 | P1 |
| SQL query duration | Any query >5s | P2 |
| GC pressure | Gen2 collections >5/min | P2 |
| Kestrel queue length | >100 pending requests | P2 |
| Memory usage | Working set >80% of container limit | P2 |
| Certificate expiry | SSL cert expiring <14 days | P3 |

---

## Failure Mode 1: Database Failures

### 1A. SQLite Connection Failure

**Symptoms:**
- `Error opening database` in logs
- All API endpoints return 500
- Health check passes but data endpoints fail

**Diagnosis:**
```bash
# Check backend logs for SQLite errors
docker logs <container_id> 2>&1 | grep -i "sqlite\|database\|error opening"

# Verify database file exists and is accessible (production)
docker exec <container_id> ls -la /app/data/timesheet.db

# Check disk space
docker exec <container_id> df -h /app/data/

# Test database file integrity
docker exec <container_id> node -e "
  const sqlite3 = require('sqlite3').verbose();
  const db = new sqlite3.Database(process.env.DATABASE_PATH || '/app/data/timesheet.db');
  db.get('PRAGMA integrity_check', (err, row) => {
    console.log(err || row);
    db.close();
  });
"
```

**Resolution:**
1. If disk full: clear old temp files (`rm backend/temp/*.csv`), expand volume.
2. If file permissions: `chown nodejs:nodejs /app/data/timesheet.db`.
3. If file corrupt: restore from backup, then restart container.
4. If in-memory (dev): restart the backend process — data loss is expected.

### 1B. Database Initialization Failure

**Symptoms:**
- `Failed to start server` in logs followed by `process.exit(1)`
- Container enters restart loop

**Diagnosis:**
```bash
# Check startup logs
docker logs <container_id> 2>&1 | head -50

# Verify the init.js file is present
docker exec <container_id> cat src/database/init.js | head -5
```

**Resolution:**
1. Verify the Docker image was built correctly (check that `docker/overrides/database/init.js` was copied).
2. Check if `DATABASE_PATH` env var points to a writable directory.
3. If persistent: redeploy from a known-good image tag.

### 1C. Database Lock Contention

**Symptoms:**
- Intermittent `SQLITE_BUSY` errors under load
- Some requests succeed while others fail with 500

**Diagnosis:**
```bash
# Check for BUSY errors in logs
docker logs <container_id> 2>&1 | grep -i "SQLITE_BUSY\|database is locked"
```

**Resolution:**
1. SQLite supports only one concurrent writer. Under high write load, consider:
   - Enabling WAL mode: `PRAGMA journal_mode=WAL;`
   - Adding retry logic with exponential backoff in the application
   - Queuing write operations
2. If persistent, evaluate migrating to PostgreSQL for concurrent write support.

---

## Failure Mode 2: API / HTTP Errors

### 2A. Rate Limiting (429 Too Many Requests)

**Symptoms:**
- Users receive `429` responses
- Legitimate traffic blocked

**Diagnosis:**
```bash
# Check rate limit configuration in server.js
# Current: 100 requests per 15 minutes per IP
grep -A3 "rateLimit" backend/src/server.js

# Count 429 responses in logs
docker logs <container_id> 2>&1 | grep '" 429 ' | wc -l
```

**Resolution:**
1. If caused by a single abusive IP: block at load balancer / WAF level.
2. If legitimate traffic spike: temporarily increase the `max` value in `server.js`:
   ```js
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 500  // increased from 100
   });
   ```
3. For persistent growth: add per-user rate limiting keyed on `x-user-email`.

### 2B. Validation Errors (400 Bad Request)

**Symptoms:**
- `Validation error` responses with Joi details
- Frontend forms failing to submit

**Diagnosis:**
```bash
# Check recent 400 responses
docker logs <container_id> 2>&1 | grep '" 400 '

# Review validation schemas
cat backend/src/validation/schemas.js
```

**Resolution:**
1. Compare the request payload against the Joi schema.
2. Common issues:
   - `hours` must be positive and ≤24 (precision 2).
   - `date` must be ISO format.
   - `clientId` must be a positive integer.
   - `name` is required for client creation (1-255 chars).
3. If the schema is too restrictive, update `backend/src/validation/schemas.js`.

### 2C. CORS Errors

**Symptoms:**
- Browser console shows `Access-Control-Allow-Origin` errors
- API calls fail from the frontend but work via curl

**Diagnosis:**
```bash
# Check CORS configuration
grep -A4 "cors" backend/src/server.js

# Check FRONTEND_URL environment variable
docker exec <container_id> env | grep FRONTEND_URL

# Test with curl
curl -v -H "Origin: http://your-frontend-url" http://localhost:3001/health
```

**Resolution:**
1. Ensure `FRONTEND_URL` env var matches the actual frontend origin.
2. In production Docker, CORS allows same-origin (`origin: true`), verify the frontend is served from the same host.
3. In dev, ensure Vite proxy is running and frontend requests go through `/api` (not directly to port 3001).

### 2D. Large Payload Rejection (413)

**Symptoms:**
- `PayloadTooLargeError` in logs
- File upload or large data submission fails

**Diagnosis:**
```bash
# Check body parser limit
grep "limit" backend/src/server.js
# Current: 10mb
```

**Resolution:**
1. If legitimate: increase the `limit` in `express.json({ limit: '10mb' })`.
2. If attack: keep the limit, add request size monitoring.

---

## Failure Mode 3: Memory & Resource Leaks

### 3A. High Memory Usage / OOM Kill

**Symptoms:**
- Container killed by OOM killer
- `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed` in logs
- Gradually increasing memory in monitoring

**Diagnosis:**
```bash
# Check container memory usage
docker stats <container_id> --no-stream

# Check Node.js heap
docker exec <container_id> node -e "console.log(process.memoryUsage())"

# Check for OOM kills
dmesg | grep -i "oom\|killed"
```

**Resolution:**
1. Restart the container to recover immediately.
2. Investigate the root cause:
   - Large report generation (`/api/reports/export/pdf/:clientId`) loads all entries into memory.
   - Add pagination to work entry queries.
   - Stream PDF/CSV generation instead of buffering.
3. Set container memory limits: `docker run --memory=512m`.

### 3B. Temp File Accumulation

**Symptoms:**
- Disk usage grows steadily
- CSV export creates files in `backend/temp/` that aren't cleaned up on error

**Diagnosis:**
```bash
# Check temp directory size
docker exec <container_id> du -sh /app/temp/ 2>/dev/null || echo "No temp dir"
docker exec <container_id> ls -la /app/temp/ 2>/dev/null
```

**Resolution:**
1. Manually clean: `docker exec <container_id> rm -f /app/temp/*.csv`
2. Add a cron job or startup cleanup to remove files older than 1 hour.
3. The CSV export in `reports.js` has cleanup logic in the `res.download` callback, but it can fail if the download is interrupted. Consider using `finally` blocks.

### 3C. Event Loop Blocking

**Symptoms:**
- All endpoints become slow simultaneously
- Health check times out
- High CPU with low request throughput

**Diagnosis:**
```bash
# Check if the process is responsive
curl -w "%{time_total}" http://localhost:3001/health

# Profile the event loop
docker exec <container_id> node -e "
  const start = Date.now();
  setImmediate(() => console.log('Event loop lag:', Date.now() - start, 'ms'));
"
```

**Resolution:**
1. Identify the blocking operation (usually large synchronous DB queries or PDF generation).
2. Add `--max-old-space-size=512` to Node.js startup flags.
3. Move heavy operations to worker threads or a background job queue.

---

## Failure Mode 4: Dependency & Infrastructure Failures

### 4A. Docker Container Crash Loop

**Symptoms:**
- Container status: `Restarting`
- `docker ps` shows frequent restarts

**Diagnosis:**
```bash
# Check container status and restart count
docker ps -a | grep timesheet

# Check exit code
docker inspect <container_id> --format='{{.State.ExitCode}}'

# Check logs for startup errors
docker logs --tail 100 <container_id>
```

**Resolution:**
1. Exit code 1: Application error — check logs for `Failed to start server`.
2. Exit code 137: OOM killed — increase memory limits.
3. Exit code 143: SIGTERM — check orchestrator for intentional stops.
4. If image is corrupted: `docker pull` and redeploy.

### 4B. npm Dependency Issues

**Symptoms:**
- `npm install` fails during build
- `sqlite3` native module compilation errors
- `MODULE_NOT_FOUND` errors at runtime

**Diagnosis:**
```bash
# Check Node.js version (Dockerfile uses node:20-alpine)
node --version

# Verify native module compatibility
npm ls sqlite3

# Check for security vulnerabilities
npm audit
```

**Resolution:**
1. Pin Node.js version in Dockerfile to avoid breaking changes.
2. For `sqlite3` build failures: ensure `python3`, `make`, and `gcc` are available in the build stage.
3. Run `npm ci` (not `npm install`) in CI/CD for reproducible builds.
4. Run `npm audit fix` for known vulnerabilities.

### 4C. Docker Health Check Failure

**Symptoms:**
- Container marked `unhealthy` by orchestrator
- Load balancer removes the instance

**Diagnosis:**
```bash
# Check health status
docker inspect <container_id> --format='{{json .State.Health}}'

# Test health endpoint manually
curl -v http://localhost:3001/health
```

**Resolution:**
1. If the endpoint responds but slowly: increase `--timeout` in Dockerfile HEALTHCHECK (currently 3s).
2. If the endpoint doesn't respond: check if the Express server started (port binding).
3. If intermittent: check for event loop blocking or resource exhaustion.

### 4D. Vite Proxy Failure (Dev Mode)

**Symptoms:**
- Frontend shows network errors for API calls
- Browser console: `502 Bad Gateway` or `ECONNREFUSED`

**Diagnosis:**
```bash
# Check if backend is running
curl http://localhost:3001/health

# Check Vite proxy config
cat frontend/vite.config.ts
```

**Resolution:**
1. Ensure backend is running on port 3001 before starting frontend.
2. Check that `vite.config.ts` proxy target matches backend port.
3. Restart both servers: `(cd backend && npm run dev) & (cd frontend && npm run dev)`.

---

## Failure Mode 5: Authentication & Authorization Failures

### 5A. Missing x-user-email Header

**Symptoms:**
- All authenticated endpoints return `401`
- `User email required in x-user-email header`

**Diagnosis:**
```bash
# Test with header
curl -H "x-user-email: test@example.com" http://localhost:3001/api/clients

# Check frontend interceptor
grep -A5 "x-user-email" frontend/src/api/client.ts
```

**Resolution:**
1. Verify `localStorage.getItem('userEmail')` returns a value in the browser.
2. Check that the Axios request interceptor is attaching the header.
3. If behind a reverse proxy: ensure the header isn't being stripped.

### 5B. User Auto-Creation Failure

**Symptoms:**
- Login succeeds but subsequent requests fail
- `Failed to create user` in logs

**Diagnosis:**
```bash
# Check if users table exists
docker exec <container_id> node -e "
  const { getDatabase } = require('./src/database/init');
  const db = getDatabase();
  db.all('SELECT name FROM sqlite_master WHERE type=\"table\"', (err, rows) => {
    console.log(err || rows);
  });
"
```

**Resolution:**
1. Verify database initialization completed (check startup logs).
2. If the `users` table is missing: restart the application to trigger `initializeDatabase()`.
3. Check for unique constraint violations if the email already exists in a corrupted state.

---

## Supplementary: .NET Application Failure Modes

This section covers equivalent failure modes for teams running .NET-based services alongside or instead of the Node.js stack.

### .NET-1: SQL Connection Pool Exhaustion

**Symptoms:**
- `SqlException: Timeout expired. The timeout period elapsed prior to obtaining a connection from the pool.`
- Intermittent 500 errors under load

**Diagnosis:**
```sql
-- Check active connections in SQL Server
SELECT COUNT(*) AS active_connections
FROM sys.dm_exec_connections;

-- Check connection pool stats
SELECT * FROM sys.dm_exec_sessions WHERE program_name LIKE '%your-app%';
```

```bash
# Check connection string pool size
grep -i "max pool size" appsettings.json
```

**Resolution:**
1. Ensure all `DbContext` / `SqlConnection` instances are properly disposed (use `using` statements).
2. Increase `Max Pool Size` in the connection string (default is 100).
3. Check for long-running transactions holding connections.
4. Add connection resiliency: `options.EnableRetryOnFailure()` in EF Core.

### .NET-2: Entity Framework Migration Failures

**Symptoms:**
- `Microsoft.EntityFrameworkCore.DbUpdateException` on deployment
- Schema mismatch errors

**Diagnosis:**
```bash
# Check pending migrations
dotnet ef migrations list

# Check current database schema
dotnet ef database script
```

**Resolution:**
1. Apply pending migrations: `dotnet ef database update`.
2. If migration conflicts: `dotnet ef migrations remove` and recreate.
3. For production: generate SQL scripts (`dotnet ef migrations script`) and apply manually with DBA review.

### .NET-3: Thread Pool Starvation

**Symptoms:**
- All endpoints become slow simultaneously
- `ThreadPool` available threads near zero
- Sync-over-async code patterns (`Task.Result`, `.Wait()`)

**Diagnosis:**
```csharp
// Add diagnostic endpoint
ThreadPool.GetAvailableThreads(out int workerThreads, out int completionPortThreads);
// Log workerThreads — should not be near 0
```

**Resolution:**
1. Replace all `Task.Result` and `.Wait()` calls with `await`.
2. Set minimum thread pool size: `ThreadPool.SetMinThreads(100, 100)`.
3. Use `async`/`await` throughout the call chain — partial async is worse than full sync.

### .NET-4: Kestrel / IIS Request Failures

**Symptoms:**
- `502 Bad Gateway` from reverse proxy
- `HTTP Error 503 - Service Unavailable`
- IIS app pool stopped

**Diagnosis:**
```bash
# Check IIS app pool status
appcmd list apppool /state:*

# Check Windows Event Log
Get-EventLog -LogName Application -Source "IIS*" -Newest 20

# Check Kestrel process
dotnet --info
```

**Resolution:**
1. IIS app pool crash: check `stderr` log in `web.config` `stdoutLogFile` path.
2. Increase Kestrel limits in `Program.cs`:
   ```csharp
   builder.WebHost.ConfigureKestrel(options => {
       options.Limits.MaxConcurrentConnections = 1000;
       options.Limits.MaxRequestBodySize = 10 * 1024 * 1024; // 10MB
   });
   ```
3. For IIS recycling: check `Rapid-Fail Protection` settings, increase failure threshold.

### .NET-5: GC Pressure & Memory Leaks

**Symptoms:**
- `OutOfMemoryException`
- Steadily increasing memory in Application Insights
- Frequent Gen2 garbage collections

**Diagnosis:**
```bash
# Capture a memory dump
dotnet-dump collect -p <PID>

# Analyze
dotnet-dump analyze <dump-file>
> dumpheap -stat
> gcroot <address>
```

**Resolution:**
1. Check for `IDisposable` objects not being disposed (especially `HttpClient`, `DbContext`).
2. Use `IHttpClientFactory` instead of creating `HttpClient` instances directly.
3. Add `IMemoryCache` size limits to prevent unbounded caching.
4. For large report generation: use streaming (`IAsyncEnumerable`, `FileStreamResult`).

### .NET-6: Health Check Configuration

**Diagnosis:**
```csharp
// Program.cs — typical setup
builder.Services.AddHealthChecks()
    .AddSqlServer(connectionString, name: "database")
    .AddCheck<CustomHealthCheck>("custom");

app.MapHealthChecks("/healthz");
```

**Resolution:**
1. Ensure health checks have timeouts: `.AddSqlServer(conn, timeout: TimeSpan.FromSeconds(3))`.
2. Separate liveness (`/healthz/live`) from readiness (`/healthz/ready`) probes.
3. Don't include heavy checks (external APIs) in liveness probes.

---

## Incident Severity Definitions

| Severity | Definition | Response Time | Examples |
|---|---|---|---|
| **P1 — Critical** | Service completely unavailable or data loss occurring | 15 min | Database corruption, container crash loop, all endpoints 500 |
| **P2 — High** | Major feature degraded, significant user impact | 1 hour | Report generation failing, high latency, memory leak |
| **P3 — Medium** | Minor feature impacted, workaround available | 4 hours | CSV export temp file buildup, rate limit too restrictive |
| **P4 — Low** | Cosmetic or minor issue, no user workflow impact | 24 hours | Log noise, non-critical dependency update, documentation gap |

---

## Escalation Contacts

| Role | Responsibility |
|---|---|
| **On-Call Engineer** | First responder; triage, diagnose, and apply immediate fix |
| **Team Lead** | Escalation for P1/P2; authorize risky mitigations |
| **DBA / Infrastructure** | Database recovery, Docker/K8s issues |
| **Security Team** | Rate limiting abuse, auth bypass attempts |

> **Update this section** with actual team contacts, PagerDuty/Opsgenie schedules, and Slack channels.

---

## Post-Incident Review Checklist

- [ ] Timeline documented (detection → response → resolution)
- [ ] Root cause identified
- [ ] Customer impact quantified (users affected, duration)
- [ ] Monitoring gaps identified (would an alert have caught this sooner?)
- [ ] Action items created with owners and due dates
- [ ] Runbook updated if procedure was missing or incorrect
- [ ] Communication sent to stakeholders
