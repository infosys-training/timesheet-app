# Timesheet App — Incident Response Runbook

## Overview

The Timesheet App is a full-stack application for tracking labor hours across multiple clients:

- **Backend**: Node.js/Express server on port **3001** (`backend/src/server.js`)
- **Frontend**: React (TypeScript, Vite) on port **5173** (`frontend/`)
- **Database**: SQLite — in-memory for development, file-based for Docker production
- **Authentication**: Email-only via `x-user-email` header (no passwords)

Architecture summary:

```
[Browser] → [Vite Dev Server :5173] → (proxy /api) → [Express :3001] → [SQLite]
```

In production (Docker), the Express server also serves the built frontend static assets.

---

## Service Health Checks

| Check | Command | Expected |
|-------|---------|----------|
| Backend alive | `GET /health` | `{"status":"OK","timestamp":"..."}` (HTTP 200) |
| Auth working | `GET /api/auth/me` with `x-user-email: test@example.com` | HTTP 200 with user object |
| DB connected | Any authenticated endpoint returns data (not 500) | HTTP 200 |

Quick CLI check:

```bash
curl -s http://localhost:3001/health | jq .
```

Use the automated health check script at [`scripts/healthcheck.sh`](scripts/healthcheck.sh) for a comprehensive check of all endpoints.

---

## Failure Mode 1: Database Issues

### Symptoms
- 500 errors on all authenticated endpoints
- `"Error opening database"` in logs
- Data loss after restart (expected in dev/in-memory mode)

### In-Memory Mode (Development)

Data is **ephemeral by design**. Every restart resets all data.

- See `backend/src/database/init.js` line 14: `db = new sqlite3.Database(':memory:', ...)`
- This is the default mode when `DATABASE_PATH` is not set
- "Data loss" after restart is expected behavior, not a bug

### File-Based Mode (Docker Production)

| Item | Detail |
|------|--------|
| DB path | `/app/data/timesheet.db` (set via `DATABASE_PATH` env var) |
| User | `nodejs` (UID 1001) |
| Dockerfile ref | `docker/Dockerfile` line 59 |

**Diagnosis:**
1. Check disk space: `df -h /app/data/`
2. Check file permissions: `ls -la /app/data/timesheet.db` (must be owned by UID 1001)
3. Check for SQLite lock files: `ls /app/data/timesheet.db-wal /app/data/timesheet.db-shm`
4. Check container logs for `"Error opening database"` or `"Database tables created successfully"`

### Resolution Steps
1. Restart the backend process (see [Restart Procedures](#restart-procedures))
2. Verify with `/health` endpoint
3. Check logs for `"Database tables created successfully"` (success) or `"Error opening database"` (failure)
4. If file-based: verify disk space, permissions, remove stale lock files

### Prevention
- Monitor disk space on the data volume
- Set up regular backups for file-based SQLite (`cp /app/data/timesheet.db /backups/`)
- Use Docker volume mounts to persist data across container recreation

---

## Failure Mode 2: API Errors (5xx)

### Symptoms
- Users see "Internal server error" messages
- Elevated 500 responses in monitoring
- Morgan access logs showing 5xx status codes

### Diagnosis
1. Check Morgan logs — `morgan('combined')` format is configured in `backend/src/server.js` line 33
2. Look for `"Database error:"` log entries from route handlers
3. Check error handler middleware output (`backend/src/middleware/errorHandler.js`)

### Common Causes
- Database connection lost (in-memory DB garbage collected — rare)
- Joi validation schema mismatch (returns 400, not 500 — check if it's actually a validation issue)
- Unhandled promise rejections in route handlers
- SQLite errors (code starting with `SQLITE_`)

### Error Handler Behavior

The centralized error handler (`backend/src/middleware/errorHandler.js`) handles:
- **Joi validation errors** → 400 with details array
- **SQLite errors** (code starts with `SQLITE_`) → 500 with generic message
- **All others** → `err.status` or 500 with `err.message` or "Internal server error"

### Resolution
1. Check logs for the specific error type
2. If database-related: see [Failure Mode 1](#failure-mode-1-database-issues)
3. If validation-related: check request payload against Joi schemas
4. If persistent: restart the backend service

### Escalation
If errors persist after restart, file a [P2 Major Incident](.github/ISSUE_TEMPLATE/p2-major-incident.yml).

---

## Failure Mode 3: Memory Issues

### Symptoms
- Increasing memory usage over time
- OOM kills in container orchestration
- Slow response times / request timeouts

### Causes
- In-memory SQLite growing unboundedly with data (no eviction policy)
- PDF generation streams not properly closed (PDFKit in `backend/src/routes/reports.js`)
- Temporary CSV files accumulating in `backend/temp/`

### Diagnosis
1. Check process memory:
   ```bash
   node -e "const m = process.memoryUsage(); console.log(JSON.stringify(m, null, 2))"
   ```
   Or from within the container:
   ```bash
   docker exec <container> node -e "console.log(process.memoryUsage())"
   ```
2. Check temp directory size: `du -sh backend/temp/`
3. Check container memory limits: `docker stats <container>`

### Resolution
1. Restart the service to reclaim memory
2. Clean temp directory: `rm -rf backend/temp/* `
3. Consider switching to file-based SQLite for production (`DATABASE_PATH` env var)

### Prevention
- Set container memory limits in Docker/orchestration
- Docker HEALTHCHECK is already configured (interval=30s, timeout=3s, retries=3) — see `docker/Dockerfile`
- Monitor memory via `docker stats` or orchestration metrics
- Implement periodic temp file cleanup

---

## Failure Mode 4: Authentication Failures

### Symptoms
- Users get `401 "User email required"` (missing header)
- Users get `400 "Invalid email format"` (malformed header)
- Users unexpectedly redirected to login

### Cause

Authentication is handled by the `x-user-email` header (see `backend/src/middleware/auth.js`):
1. Header missing → 401
2. Header present but invalid email format → 400
3. Header valid, user not in DB → user is auto-created

### Resolution
1. **Verify frontend is sending the header**: Check `frontend/src/api/client.ts` interceptor (lines 20-31) — it reads from `localStorage.getItem('userEmail')`
2. **Verify localStorage has `userEmail`**: Open browser DevTools → Application → Local Storage
3. **Clear browser cache and re-login** if localStorage is corrupted
4. **Check Vite proxy**: Ensure `/api` requests are being proxied to backend (not stripped)

### Common Scenarios
| Scenario | Symptom | Fix |
|----------|---------|-----|
| Fresh browser | 401 on all API calls | User must log in (enter email) |
| localStorage cleared | Redirect to /login | Expected behavior |
| Invalid email stored | 400 on all API calls | Clear localStorage, re-login |

---

## Failure Mode 5: Rate Limiting

### Symptoms
- `429 Too Many Requests` responses
- Users report being "locked out"
- Automated scripts/tests failing intermittently

### Configuration

Defined in `backend/src/server.js` lines 26-30:

```javascript
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
```

- **Window**: 15 minutes
- **Max requests per IP**: 100

### Resolution
1. **Wait** for the rate limit window to expire (up to 15 minutes)
2. **Identify the source**: Check if a single user/script is generating excessive traffic
3. **Increase limits** for internal/development use if appropriate (modify `max` value)
4. **Bypass in development**: Remove or increase the limiter for dev environments via `NODE_ENV` check

### Considerations
- Rate limit is per-IP, so all users behind the same NAT/proxy share the limit
- Health check scripts should be run sparingly or from allowlisted IPs
- Load tests will trigger rate limiting — disable or increase for testing

---

## Failure Mode 6: Dependency/Build Failures

### Symptoms
- Application won't start
- `"Cannot find module"` errors
- Native module compilation failures (especially `sqlite3`)

### Cause
- `sqlite3` is a native Node.js module requiring compilation
- Missing or incompatible `node_modules`
- Wrong Node.js version (requires 18+)

### Resolution
1. Clean install dependencies:
   ```bash
   cd backend && npm ci
   cd frontend && npm ci
   ```
2. Verify Node.js version: `node --version` (must be 18+, Docker uses 20)
3. Rebuild native modules:
   ```bash
   npm rebuild sqlite3
   ```
4. If on Alpine Linux (Docker): ensure build tools are available:
   ```bash
   apk add --no-cache python3 make g++
   ```

### Prevention
- Pin Node.js version in `.nvmrc` or `package.json` engines field
- Use `npm ci` for reproducible installs in CI/CD
- Use the multi-stage Docker build which handles native compilation

---

## Failure Mode 7: CORS Errors

### Symptoms
- Browser console shows CORS errors (e.g., "Access-Control-Allow-Origin" missing)
- API calls fail from the frontend but work via curl
- Preflight OPTIONS requests rejected

### Cause

CORS origin is configured in `backend/src/server.js` line 21:

```javascript
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));
```

The `FRONTEND_URL` env var must match the actual frontend origin exactly (protocol + host + port).

### Resolution
1. Set `FRONTEND_URL` environment variable to match the frontend's actual URL
2. In development: ensure it's `http://localhost:5173` (Vite default)
3. In production: set to the deployed frontend URL
4. Restart the backend after changing the env var

### Common Mismatches
| Actual Frontend | FRONTEND_URL Set To | Result |
|-----------------|---------------------|--------|
| `http://localhost:5173` | `http://localhost:3000` | ❌ CORS error |
| `https://app.example.com` | `http://app.example.com` | ❌ Protocol mismatch |
| `http://localhost:5173` | (not set) | ✅ Uses default |

---

## Failure Mode 8: CSV/PDF Export Failures

### Symptoms
- Report downloads fail or return 500
- Errors on `GET /api/reports/export/csv/:id` or `GET /api/reports/export/pdf/:id`
- Incomplete or corrupted file downloads

### Cause
- Temp directory (`backend/temp/`) doesn't exist or lacks write permissions
- Disk space full — can't write temp files
- PDFKit stream errors (see `backend/src/routes/reports.js`)
- Client/report not found (returns 404, not a true export failure)

### Resolution
1. Ensure temp directory exists and is writable:
   ```bash
   mkdir -p backend/temp && chmod 755 backend/temp
   ```
2. Check disk space: `df -h`
3. Restart the service if streams are stuck
4. Verify the client ID exists and belongs to the authenticated user

### Prevention
- Add temp directory creation to startup scripts
- Monitor disk space
- Implement periodic cleanup of old temp files

---

## Restart Procedures

### Development

```bash
# Backend (uses nodemon for auto-reload)
cd backend && npm run dev

# Frontend (Vite dev server with HMR)
cd frontend && npm run dev
```

### Docker (Production)

```bash
# Restart container
docker restart <container-name>

# Full rebuild
docker compose down && docker compose up -d --build

# Check status
docker ps
docker logs <container-name> --tail 50
```

### Process Exit Codes
- **Exit code 0**: Clean shutdown
- **Exit code 1**: Startup failure (see `backend/src/server.js` line 68 — `process.exit(1)` on init failure)

### Post-Restart Verification
1. Wait 5 seconds for initialization
2. Check health: `curl http://localhost:3001/health`
3. Verify logs show `"Database tables created successfully"` and `"Server running on port 3001"`

---

## Log Locations

| Log Type | Location | Format |
|----------|----------|--------|
| Access logs | stdout | Morgan `combined` format |
| Error logs | stderr | `console.error(...)` |
| Docker logs | `docker logs <container>` | Combined stdout/stderr |

### Key Log Messages

| Message | Meaning |
|---------|---------|
| `"Server running on port 3001"` | Successful startup |
| `"Database tables created successfully"` | DB initialized |
| `"Error opening database"` | DB connection failure |
| `"Database error:"` | Query execution failure |
| `"Error creating user:"` | Auth middleware failure |

### Filtering Logs

```bash
# Docker — errors only
docker logs <container> 2>&1 | grep -i error

# Development — watch for 5xx
npm run dev 2>&1 | grep -E ' (5[0-9]{2}) '
```

---

## Escalation Matrix

| Severity | Definition | Response Time | Examples |
|----------|-----------|---------------|----------|
| **P1 — Critical** | Complete outage or data loss affecting all users | Immediate (< 15 min) | Database corruption, service completely down, data loss |
| **P2 — Major** | Significant degradation affecting many users | < 1 hour | 5xx errors on major endpoints, report exports failing, performance severely degraded |
| **P3 — Minor** | Minor issue affecting some users, workarounds available | < 4 hours | CORS errors for specific origins, validation errors, slow responses |
| **P4 — Low** | Cosmetic or minor issues with easy workarounds | Next business day | UI glitches, log noise, documentation gaps |

### Filing Incidents

Use the GitHub issue templates for structured incident reporting:
- [P1 Critical Incident](.github/ISSUE_TEMPLATE/p1-critical-incident.yml)
- [P2 Major Incident](.github/ISSUE_TEMPLATE/p2-major-incident.yml)
- [P3 Minor Incident](.github/ISSUE_TEMPLATE/p3-minor-incident.yml)
- [P4 Low Priority Issue](.github/ISSUE_TEMPLATE/p4-low-incident.yml)

---

## Contact Information

| Role | Contact | Responsibility |
|------|---------|---------------|
| On-call Engineer | TBD | First responder for P1/P2 |
| Backend Lead | TBD | Backend/API/Database issues |
| Frontend Lead | TBD | UI/UX/Client-side issues |
| DevOps Lead | TBD | Infrastructure/Docker/CI-CD |
| Engineering Manager | TBD | Escalation for unresolved P1s |

---

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Backend server port |
| `NODE_ENV` | `undefined` | Environment (`production`, `development`) |
| `FRONTEND_URL` | `http://localhost:5173` | Allowed CORS origin |
| `JWT_SECRET` | (none) | Secret for token signing (if JWT is enabled) |
| `DATABASE_PATH` | (none — uses in-memory) | Path to SQLite file (Docker production only) |

### Docker-Specific
- `DATABASE_PATH=/app/data/timesheet.db` — set automatically in Dockerfile
- `NODE_ENV=production` — set automatically in Dockerfile
- `PORT=3001` — set automatically in Dockerfile

---

## Quick Reference Commands

```bash
# Health check
curl http://localhost:3001/health

# Full endpoint test
./scripts/healthcheck.sh

# Check rate limit headers
curl -I http://localhost:3001/health

# Test auth
curl -H "x-user-email: test@example.com" http://localhost:3001/api/auth/me

# Docker logs
docker logs <container> --tail 100 -f

# Container memory
docker stats <container> --no-stream

# Clean temp files
rm -rf backend/temp/*
```
