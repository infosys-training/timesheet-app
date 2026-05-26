# Timesheet App - Incident Response Runbook

## Table of Contents

- [Overview](#overview)
- [Architecture Summary](#architecture-summary)
- [Severity Definitions](#severity-definitions)
- [1. Database Failures](#1-database-failures)
- [2. API Errors](#2-api-errors)
- [3. Memory and Performance Issues](#3-memory-and-performance-issues)
- [4. Dependency and Build Failures](#4-dependency-and-build-failures)
- [5. Infrastructure and Deployment Issues](#5-infrastructure-and-deployment-issues)
- [6. Security Incidents](#6-security-incidents)
- [Escalation Contacts](#escalation-contacts)
- [Post-Incident Review Checklist](#post-incident-review-checklist)

---

## Overview

This runbook provides step-by-step procedures for diagnosing and resolving common failure modes in the Timesheet App. It covers the Express/Node.js backend (port 3001), the React/Vite frontend (port 5173 in dev, served statically in production), and the SQLite database layer.

## Architecture Summary

```
┌──────────────┐      ┌──────────────────┐      ┌────────────┐
│   React SPA  │─────>│  Express API     │─────>│  SQLite DB │
│  (Vite/5173) │ proxy│  (Node.js/3001)  │      │ (in-memory │
│              │ /api │                  │      │  or file)  │
└──────────────┘      └──────────────────┘      └────────────┘
```

**Key endpoints:**
- `GET /health` - Health check (no auth required)
- `POST /api/auth/login` - Email-based login
- `GET /api/auth/me` - Current user info
- `GET/POST/PUT/DELETE /api/clients` - Client management
- `GET/POST/PUT/DELETE /api/work-entries` - Work entry management
- `GET /api/reports/client/:clientId` - Client report
- `GET /api/reports/export/csv/:clientId` - CSV export
- `GET /api/reports/export/pdf/:clientId` - PDF export

**Authentication:** Email-only via `x-user-email` header. No passwords or tokens.

**Rate limiting:** 100 requests per IP per 15-minute window.

## Severity Definitions

| Severity | Definition | Response Time | Example |
|----------|-----------|---------------|---------|
| **P1** | Service is completely down or data loss is occurring | 15 minutes | Database corruption, server crash loop |
| **P2** | Major feature is broken, no workaround available | 1 hour | All API endpoints returning 500, auth broken |
| **P3** | Feature degraded, workaround exists | 4 hours | CSV export failing, slow queries |
| **P4** | Minor issue, cosmetic, or improvement needed | 1 business day | Logging gaps, non-critical warnings |

---

## 1. Database Failures

### 1.1 SQLite Database Initialization Failure

**Symptoms:**
- Server fails to start with `Failed to start server` in logs
- `initializeDatabase()` throws an error
- No API endpoints respond

**Diagnosis:**
```bash
# Check server logs for database errors
docker logs <container_id> 2>&1 | grep -i "database\|sqlite\|error"

# In development, check the terminal running the backend
# Look for: "Error opening database:" messages
```

**Resolution:**
1. **In-memory mode (development):** Restart the backend server. The in-memory database is recreated on each startup.
   ```bash
   cd backend && npm run dev
   ```
2. **File-based mode (production/Docker):** Check disk space and file permissions.
   ```bash
   # Check disk space
   df -h /app/data

   # Check file permissions (inside container)
   ls -la /app/data/timesheet.db

   # Ensure the nodejs user (UID 1001) owns the data directory
   chown -R 1001:1001 /app/data
   ```
3. If the database file is corrupted, restore from backup or remove and restart:
   ```bash
   # CAUTION: This deletes all data
   rm /app/data/timesheet.db
   # Restart the container to recreate the database
   docker restart <container_id>
   ```

### 1.2 Database Lock / Contention Errors

**Symptoms:**
- Intermittent `SQLITE_BUSY` errors in logs
- API requests sporadically return 500
- Occurs under concurrent write load

**Diagnosis:**
```bash
# Check for SQLITE_BUSY errors
docker logs <container_id> 2>&1 | grep "SQLITE_BUSY"

# Check active connections (development)
# The app uses a singleton pattern so there should be only one connection
```

**Resolution:**
1. SQLite allows only one writer at a time. Under high concurrency, this is expected.
2. For immediate relief, reduce concurrent request load or restart the server to clear the connection.
3. For long-term resolution, consider enabling WAL (Write-Ahead Logging) mode:
   ```javascript
   // Add after database creation in init.js
   db.run("PRAGMA journal_mode=WAL");
   ```
4. If the application outgrows SQLite, plan migration to PostgreSQL or MySQL.

### 1.3 In-Memory Database Data Loss

**Symptoms:**
- All data disappears after server restart
- Users report missing clients and work entries

**Diagnosis:**
- This is expected behavior for in-memory SQLite. The database is recreated on each server restart.
- Confirm the application is running in development mode:
  ```bash
  echo $NODE_ENV  # Should show "development" for in-memory
  ```

**Resolution:**
- In development, this is by design. Inform users that data does not persist across restarts.
- In production, ensure Docker is using the file-based SQLite override:
  ```bash
  # Verify DATABASE_PATH is set
  echo $DATABASE_PATH  # Should be /app/data/timesheet.db

  # Verify the override files are in place
  ls -la /app/src/database/init.js
  ls -la /app/src/server.js
  ```

### 1.4 Disk Full (Production File-Based SQLite)

**Symptoms:**
- Write operations fail with `SQLITE_FULL` errors
- CSV/PDF exports fail to write temp files
- Container health check starts failing

**Diagnosis:**
```bash
df -h /app/data
du -sh /app/data/timesheet.db
du -sh /app/temp
```

**Resolution:**
1. Clean up temp files from report exports:
   ```bash
   rm -f /app/temp/*.csv
   ```
2. If the database itself is too large, identify and archive old work entries.
3. Increase the volume size for the `/app/data` mount.

---

## 2. API Errors

### 2.1 Rate Limiting (HTTP 429)

**Symptoms:**
- Clients receive `429 Too Many Requests` responses
- Legitimate users blocked from accessing the application

**Diagnosis:**
```bash
# Check logs for rate limit hits
docker logs <container_id> 2>&1 | grep "429\|rate"

# Current config: 100 requests per IP per 15 minutes
```

**Resolution:**
1. Wait 15 minutes for the rate limit window to reset.
2. If a legitimate user is affected, restart the server to clear rate limit counters (they are stored in memory).
3. To adjust limits, modify `server.js`:
   ```javascript
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 200  // Increase limit
   });
   ```
4. For production, consider using a distributed rate limiter (e.g., Redis-backed) instead of in-memory.

### 2.2 Authentication Failures (HTTP 401)

**Symptoms:**
- Users cannot access protected endpoints
- `User email required in x-user-email header` error

**Diagnosis:**
1. Check that the frontend is sending the `x-user-email` header:
   ```bash
   # Test directly
   curl -H "x-user-email: user@example.com" http://localhost:3001/api/clients
   ```
2. Verify that `localStorage` contains the user email on the frontend:
   ```javascript
   // In browser console
   localStorage.getItem('userEmail')
   ```

**Resolution:**
1. If the header is missing, the user may need to log in again.
2. Clear browser localStorage and re-login:
   ```javascript
   localStorage.clear();
   window.location.href = '/login';
   ```
3. If the auth middleware itself is failing, check for database connectivity (the middleware queries the users table).

### 2.3 CORS Errors

**Symptoms:**
- Browser console shows `Access-Control-Allow-Origin` errors
- Frontend cannot reach the backend API
- Requests blocked in the browser network tab

**Diagnosis:**
```bash
# Check the configured FRONTEND_URL
echo $FRONTEND_URL

# Test CORS headers
curl -I -H "Origin: http://localhost:5173" http://localhost:3001/health
```

**Resolution:**
1. Ensure `FRONTEND_URL` matches the actual frontend origin:
   ```bash
   # In backend .env
   FRONTEND_URL=http://localhost:5173  # Development
   ```
2. In development, the Vite proxy (`/api` -> `localhost:3001`) should bypass CORS entirely. If the proxy is not working, check `vite.config.ts`.
3. Restart the backend after changing environment variables.

### 2.4 Validation Errors (HTTP 400)

**Symptoms:**
- API returns `Validation error` with details array
- Users cannot create or update clients/work entries

**Diagnosis:**
```bash
# Check the response body for specific validation messages
curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "invalid"}' | jq .
```

**Resolution:**
1. These are expected application-level errors, not incidents.
2. Review the validation schemas in `backend/src/validation/schemas.js` if rules seem incorrect.
3. Common constraints: client name max 255 chars, description max 1000 chars, hours 0-24, valid ISO date format.

### 2.5 Unhandled 500 Internal Server Errors

**Symptoms:**
- API returns `Internal server error` without specific details
- Error handler logs generic errors

**Diagnosis:**
```bash
# Check server logs for the full error stack trace
docker logs <container_id> 2>&1 | grep -A 10 "Error:"

# In development, check the terminal output
```

**Resolution:**
1. Identify the specific error from logs. Common causes:
   - Database connection lost
   - Null pointer on unexpected data
   - File system errors during report export
2. If the error is reproducible, capture the request details (method, URL, headers, body) for debugging.
3. Restart the server if the error is persistent and unresolvable immediately.

---

## 3. Memory and Performance Issues

### 3.1 Node.js Memory Leak / High Memory Usage

**Symptoms:**
- Container memory usage grows continuously
- Server becomes unresponsive over time
- OOMKilled events in container orchestration logs

**Diagnosis:**
```bash
# Check container memory usage
docker stats <container_id>

# Check Node.js heap usage (add to a diagnostic endpoint or use --inspect)
node --inspect src/server.js
# Connect Chrome DevTools to take heap snapshots
```

**Resolution:**
1. Restart the container as an immediate fix:
   ```bash
   docker restart <container_id>
   ```
2. Common leak sources in this app:
   - Unclosed database connections (though the app uses a singleton pattern)
   - Large report generation holding data in memory
   - Morgan logging accumulating in memory if stdout is buffered
3. Set memory limits on the container:
   ```bash
   docker run --memory=512m --memory-swap=512m <image>
   ```
4. For persistent issues, take heap snapshots and analyze with Chrome DevTools.

### 3.2 Large Report Generation Failures

**Symptoms:**
- PDF/CSV export times out or crashes
- Server runs out of memory during report generation
- Temp files accumulate in `backend/temp/`

**Diagnosis:**
```bash
# Check temp file accumulation
ls -la backend/temp/ 2>/dev/null || echo "No temp directory"
du -sh backend/temp/ 2>/dev/null

# Check for large clients with many work entries
```

**Resolution:**
1. Clean up orphaned temp files:
   ```bash
   find backend/temp/ -name "*.csv" -mmin +60 -delete
   ```
2. For very large reports, consider implementing pagination or streaming.
3. The PDF generation uses PDFKit which streams to the response. If it fails, the issue is likely the data query, not the PDF generation itself.

### 3.3 Request Body Too Large (HTTP 413)

**Symptoms:**
- API rejects requests with `PayloadTooLargeError`
- Configured limit: 10MB (`express.json({ limit: '10mb' })`)

**Resolution:**
1. This is unlikely for normal timesheet operations. Investigate what is sending large payloads.
2. If legitimate, increase the limit in `server.js`.

---

## 4. Dependency and Build Failures

### 4.1 npm Install Failures

**Symptoms:**
- `npm ci` or `npm install` fails during build or deployment
- Native module compilation errors (especially `sqlite3`)

**Diagnosis:**
```bash
# Check Node.js version (requires Node 20+)
node --version

# Check for native build tools
which node-gyp
python3 --version
gcc --version
```

**Resolution:**
1. Ensure Node.js 20.x is installed (matches Dockerfile `node:20-alpine`).
2. For `sqlite3` native module issues:
   ```bash
   npm rebuild sqlite3
   ```
3. On Alpine Linux (Docker), ensure build dependencies are available:
   ```bash
   apk add --no-cache python3 make g++
   ```
4. Clear npm cache and retry:
   ```bash
   npm cache clean --force
   rm -rf node_modules package-lock.json
   npm install
   ```

### 4.2 Frontend Build Failures

**Symptoms:**
- `tsc -b && vite build` fails
- TypeScript compilation errors
- Vite bundling errors

**Diagnosis:**
```bash
cd frontend
npx tsc --noEmit  # Check for type errors
npm run build     # Full build
```

**Resolution:**
1. Fix any TypeScript errors reported by the compiler.
2. Ensure all dependencies are installed: `npm ci`
3. Clear Vite cache: `rm -rf node_modules/.vite`
4. Check for version mismatches in `package.json` vs installed versions.

### 4.3 Vite Dev Proxy Failures

**Symptoms:**
- Frontend shows network errors when calling `/api/*`
- Browser console: `502 Bad Gateway` or `ECONNREFUSED`
- Backend is not running on port 3001

**Diagnosis:**
```bash
# Check if backend is running
curl http://localhost:3001/health

# Check Vite proxy config
cat frontend/vite.config.ts
```

**Resolution:**
1. Start the backend server first: `cd backend && npm run dev`
2. Then start the frontend: `cd frontend && npm run dev`
3. Verify the proxy target matches the backend port in `vite.config.ts`.

---

## 5. Infrastructure and Deployment Issues

### 5.1 Docker Container Health Check Failures

**Symptoms:**
- Container status shows `unhealthy`
- Docker restarts the container repeatedly

**Diagnosis:**
```bash
# Check container health status
docker inspect --format='{{json .State.Health}}' <container_id> | jq .

# Check health endpoint directly
docker exec <container_id> node -e "require('http').get('http://localhost:3001/health', (r) => { let d=''; r.on('data', c => d+=c); r.on('end', () => console.log(r.statusCode, d)); })"
```

**Resolution:**
1. Check if the server is actually running inside the container:
   ```bash
   docker exec <container_id> ps aux
   ```
2. Check server logs for startup errors:
   ```bash
   docker logs <container_id>
   ```
3. Health check config: interval=30s, timeout=3s, start-period=5s, retries=3. If the server takes longer to start, increase `--start-period`.

### 5.2 Port Conflicts

**Symptoms:**
- `EADDRINUSE` error on startup
- Server or frontend fails to bind to its port

**Diagnosis:**
```bash
# Check what's using the ports
lsof -i :3001
lsof -i :5173
```

**Resolution:**
1. Kill the conflicting process:
   ```bash
   kill $(lsof -t -i :3001)
   ```
2. Or change the port via environment variable:
   ```bash
   PORT=3002 npm run dev  # Backend
   ```

### 5.3 Environment Variable Misconfiguration

**Symptoms:**
- CORS errors (wrong `FRONTEND_URL`)
- Server running on unexpected port
- JWT-related errors (if JWT is enabled)

**Diagnosis:**
```bash
# Check current environment
cat backend/.env

# Required variables:
# PORT (default: 3001)
# FRONTEND_URL (default: http://localhost:5173)
# NODE_ENV (development/production)
# JWT_SECRET (for token signing)
```

**Resolution:**
1. Copy the example env and adjust:
   ```bash
   cp backend/.env.example backend/.env
   # Edit values as needed
   ```
2. Restart the server after changing environment variables.

---

## 6. Security Incidents

### 6.1 Suspicious Rate Limit Patterns

**Symptoms:**
- Single IP hitting rate limits repeatedly
- Unusual request patterns in Morgan logs

**Diagnosis:**
```bash
# Analyze access logs for suspicious patterns
docker logs <container_id> 2>&1 | awk '{print $1}' | sort | uniq -c | sort -rn | head 20
```

**Resolution:**
1. Consider adding IP blocking at the reverse proxy / load balancer level.
2. Review Helmet security headers are properly configured.
3. Escalate to the security team if the pattern suggests a targeted attack.

### 6.2 Unauthorized Data Access Attempts

**Symptoms:**
- Requests with spoofed `x-user-email` headers
- Users reporting seeing other users' data

**Diagnosis:**
- Review access logs for email patterns.
- The auth middleware auto-creates users, so any email format will be accepted.

**Resolution:**
1. This is a known limitation of the email-only auth system.
2. For production, implement proper authentication (OAuth, JWT with password, etc.).
3. Add audit logging for sensitive operations.

---

## Escalation Contacts

| Role | Responsibility |
|------|---------------|
| On-call Engineer | First responder for P1/P2 incidents |
| Backend Lead | Database, API, and server issues |
| Frontend Lead | UI, build, and proxy issues |
| DevOps / SRE | Docker, deployment, and infrastructure |
| Security Team | Auth bypass, data exposure, abuse |

## Post-Incident Review Checklist

- [ ] Incident timeline documented (detection, response, resolution)
- [ ] Root cause identified
- [ ] Impact assessment completed (users affected, data loss, downtime)
- [ ] Fix verified in production
- [ ] Monitoring/alerting gaps identified and addressed
- [ ] Runbook updated with new learnings
- [ ] Follow-up action items created and assigned
- [ ] Post-incident review meeting scheduled (for P1/P2)
