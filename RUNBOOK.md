# Timesheet App — Incident Response Runbook

> **Audience**: On-call engineers, SREs, and development team leads.
> **Scope**: Employee Time Tracking Application (Express backend + React/Vite frontend + SQLite database).

---

## Table of Contents

1. [General Triage Procedure](#1-general-triage-procedure)
2. [FM-1: Database Failure (SQLite)](#2-fm-1-database-failure-sqlite)
3. [FM-2: API Server Crash / Unresponsive](#3-fm-2-api-server-crash--unresponsive)
4. [FM-3: Authentication & Authorization Errors](#4-fm-3-authentication--authorization-errors)
5. [FM-4: Memory Leak / OOM](#5-fm-4-memory-leak--oom)
6. [FM-5: Dependency / npm Failure](#6-fm-5-dependency--npm-failure)
7. [FM-6: Rate Limiting Blocking Legitimate Users](#7-fm-6-rate-limiting-blocking-legitimate-users)
8. [FM-7: CSV/PDF Export Failure](#8-fm-7-csvpdf-export-failure)
9. [FM-8: Frontend Build / Serving Failure](#9-fm-8-frontend-build--serving-failure)
10. [FM-9: Docker Container Health Check Failure](#10-fm-9-docker-container-health-check-failure)
11. [FM-10: Network / CORS Errors](#11-fm-10-network--cors-errors)
12. [Escalation Contacts](#12-escalation-contacts)
13. [Post-Incident Review Template](#13-post-incident-review-template)

---

## 1. General Triage Procedure

**Every incident starts here.**

```
1. Acknowledge the alert / report within SLA (P1: 5 min, P2: 15 min, P3: 1 hr, P4: next business day).
2. Open the incident issue using the matching GitHub Issue template (P1–P4).
3. Verify the health endpoint:
      curl -sf http://<host>:3001/health | jq .
   Expected: {"status":"OK","timestamp":"..."}
4. Check backend logs:
      docker logs <container>            # Docker
      journalctl -u timesheet-backend    # systemd
      cat /var/log/timesheet/app.log     # file-based logging
5. Check frontend availability:
      curl -sf http://<host>:5173/ | head -20   # dev
      curl -sf http://<host>:3001/ | head -20   # production (static served by Express)
6. Classify the failure mode (FM-1 through FM-10 below).
7. Follow the matching runbook section.
8. Update the incident issue with timeline entries as you progress.
```

---

## 2. FM-1: Database Failure (SQLite)

### Symptoms
- API returns `500` with `{"error":"Database error","message":"An error occurred while processing your request"}`.
- Backend logs show `SQLITE_*` error codes (e.g., `SQLITE_BUSY`, `SQLITE_CORRUPT`, `SQLITE_CANTOPEN`).
- Health endpoint returns `200` but all data-mutating requests fail.

### Root Causes
| Cause | Likelihood |
|---|---|
| In-memory DB lost after process restart | **High** (by design — dev mode) |
| File-based DB disk full (production) | Medium |
| SQLite file locked by concurrent writes | Medium |
| Corrupted database file | Low |

### Response Steps

```
1. Confirm DB type:
      grep -r "':memory:'" backend/src/database/init.js
   If in-memory: data loss on restart is expected behavior — skip to step 5.

2. For file-based SQLite (production), check disk:
      df -h /app/data/
      ls -lah /app/data/timesheet.db

3. Check for lock files:
      ls -la /app/data/timesheet.db-wal /app/data/timesheet.db-shm 2>/dev/null

4. If corrupted, attempt recovery:
      sqlite3 /app/data/timesheet.db ".clone /app/data/timesheet_recovered.db"
      # Verify recovered DB, then swap:
      mv /app/data/timesheet.db /app/data/timesheet.db.corrupt.$(date +%s)
      mv /app/data/timesheet_recovered.db /app/data/timesheet.db

5. Restart the backend:
      # Docker
      docker restart timesheet-app

      # systemd
      sudo systemctl restart timesheet-backend

      # dev
      cd backend && npm run dev

6. Verify:
      curl -sf http://localhost:3001/health
      curl -sf http://localhost:3001/api/auth/login -X POST \
        -H "Content-Type: application/json" \
        -d '{"email":"test@example.com"}'
```

### Prevention
- **Production**: Use file-based SQLite (`DATABASE_PATH=/app/data/timesheet.db`) and implement automated backups.
- Set up disk space monitoring alerts at 80% / 90% thresholds.
- Consider migrating to PostgreSQL or MySQL for production workloads with concurrent users.

---

## 3. FM-2: API Server Crash / Unresponsive

### Symptoms
- Health endpoint (`GET /health`) times out or returns non-200.
- Frontend shows network errors / blank pages.
- Docker health check reports `unhealthy`.

### Root Causes
| Cause | Likelihood |
|---|---|
| Unhandled exception in route handler | High |
| Port conflict (another process on 3001) | Medium |
| Missing environment variables | Medium |
| Node.js process OOM killed | Low |

### Response Steps

```
1. Check if process is running:
      # Docker
      docker ps -a | grep timesheet
      docker inspect --format='{{.State.Status}}' <container>

      # Bare metal
      pgrep -f "node src/server.js"
      lsof -i :3001

2. Check for port conflicts:
      ss -tlnp | grep 3001

3. Review recent logs for crash reason:
      docker logs --tail 100 <container>
      # Look for: "Failed to start server", stack traces, EADDRINUSE

4. Verify environment:
      # Ensure .env exists and has required vars
      cat backend/.env
      # Required: PORT, NODE_ENV, FRONTEND_URL, JWT_SECRET (if JWT enabled)

5. Restart:
      docker restart timesheet-app
      # or
      cd backend && npm run dev

6. If crash loops, start in foreground to capture output:
      cd backend && node src/server.js 2>&1 | tee /tmp/timesheet-debug.log

7. Verify recovery:
      curl -sf http://localhost:3001/health | jq .
```

### Prevention
- Use `dumb-init` or similar in Docker for proper signal handling (already configured).
- Set up process monitoring (PM2, systemd restart policies, Docker restart: unless-stopped).
- Add structured error logging with a correlation ID.

---

## 4. FM-3: Authentication & Authorization Errors

### Symptoms
- Users cannot log in — `POST /api/auth/login` returns `400` or `500`.
- Authenticated requests return `401` — "User email required in x-user-email header".
- Frontend redirects to `/login` in a loop.

### Root Causes
| Cause | Likelihood |
|---|---|
| Missing `x-user-email` header (frontend misconfiguration) | High |
| Invalid email format rejected by Joi validation | Medium |
| Database error on user lookup/creation | Medium |
| localStorage cleared or blocked by browser | Low |

### Response Steps

```
1. Test auth directly:
      curl -sf http://localhost:3001/api/auth/login \
        -X POST -H "Content-Type: application/json" \
        -d '{"email":"test@example.com"}' | jq .

2. Test authenticated endpoint:
      curl -sf http://localhost:3001/api/clients \
        -H "x-user-email: test@example.com" | jq .

3. If login succeeds but frontend fails, check browser:
      - Open DevTools > Network > look for x-user-email header on requests
      - Check DevTools > Application > Local Storage for 'userEmail' key
      - Check console for Axios interceptor errors

4. If DB errors, follow FM-1 procedures.

5. For rate-limit blocks on login, follow FM-6.
```

### Prevention
- Add frontend health checks that verify API connectivity on load.
- Implement token refresh / session keep-alive.
- Log auth failures with client IP for audit trail.

---

## 5. FM-4: Memory Leak / OOM

### Symptoms
- Node.js process memory grows continuously (check with `docker stats` or `process.memoryUsage()`).
- Backend becomes slow, then unresponsive.
- OOM killer terminates the container/process — visible in `dmesg` or Docker events.

### Root Causes
| Cause | Likelihood |
|---|---|
| Large PDF/CSV export for clients with many work entries | High |
| Unclosed database connections or leaked callbacks | Medium |
| morgan logging accumulating in memory | Low |

### Response Steps

```
1. Check current memory usage:
      # Docker
      docker stats --no-stream <container>

      # Bare metal
      ps aux | grep "node src/server.js"
      node -e "console.log(process.memoryUsage())"

2. Check system OOM events:
      dmesg | grep -i "out of memory\|oom" | tail -20
      journalctl -k | grep -i oom

3. Identify the leak — check if correlated with export operations:
      # Review access logs for /api/reports/export/* endpoints
      docker logs <container> 2>&1 | grep "export"

4. Immediate mitigation — restart the process:
      docker restart timesheet-app

5. If exports caused it, consider adding request-level memory limits:
      - Cap max rows per CSV/PDF export
      - Stream large exports instead of buffering in memory
```

### Prevention
- Set Docker memory limits: `--memory=512m --memory-swap=512m`.
- Add `--max-old-space-size=384` to Node.js startup flags.
- Implement pagination on exports (limit work entries per export).
- Clean up temp files in `backend/temp/` after CSV generation (already implemented, verify cron for orphans).

---

## 6. FM-5: Dependency / npm Failure

### Symptoms
- `npm install` fails during build or deployment.
- `sqlite3` native module fails to compile or load.
- Runtime errors: `Cannot find module '...'`.

### Root Causes
| Cause | Likelihood |
|---|---|
| npm registry unreachable | Medium |
| `sqlite3` native binding mismatch (Node version change) | Medium |
| Lock file out of sync with package.json | Medium |
| Deprecated or removed package version | Low |

### Response Steps

```
1. Check npm registry connectivity:
      npm ping

2. Rebuild native modules:
      cd backend && npm rebuild sqlite3

3. If Node.js version changed, reinstall from scratch:
      cd backend && rm -rf node_modules && npm ci
      cd frontend && rm -rf node_modules && npm ci

4. Check for known vulnerabilities:
      cd frontend && npm audit
      cd backend && npm audit

5. If a specific package is broken, check for patches:
      npm ls <package-name>
      npm view <package-name> versions
```

### Prevention
- Pin Node.js version in `.nvmrc` or `engines` field in package.json.
- Use `npm ci` (not `npm install`) in CI/CD for reproducible builds.
- Run `npm audit` in CI pipeline (already configured in `pr-checks.yml`).
- Keep `package-lock.json` committed and up to date.

---

## 7. FM-6: Rate Limiting Blocking Legitimate Users

### Symptoms
- Users receive `429 Too Many Requests` responses.
- Login attempts fail despite valid email.
- Multiple users behind the same NAT/VPN IP all get blocked.

### Root Causes
| Cause | Likelihood |
|---|---|
| Shared corporate IP triggering per-IP rate limit (100 req / 15 min) | High |
| Automated scripts or browser extensions making excessive requests | Medium |
| Login rate limit (5 attempts / 15 min) hit by legitimate retries | Medium |

### Response Steps

```
1. Confirm rate limiting is the cause:
      curl -v http://localhost:3001/health 2>&1 | grep "HTTP/"
      # If 429, rate limit is active

2. Check current rate limit config in backend/src/server.js:
      - General: 100 requests per 15 minutes per IP
      - These reset automatically after the window expires

3. Temporary relief — restart the backend to reset in-memory rate counters:
      docker restart timesheet-app

4. For persistent issues, adjust limits in server.js:
      const limiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 500  // increase from 100
      });
```

### Prevention
- Use a dedicated rate limiter per route group (auth vs. data endpoints).
- Allow rate limit bypass for known trusted IPs or internal networks.
- Consider using `X-Forwarded-For` behind a reverse proxy to identify individual users.

---

## 8. FM-7: CSV/PDF Export Failure

### Symptoms
- Export buttons in the frontend trigger download but file is empty or corrupt.
- API returns `500` on `GET /api/reports/export/csv/:clientId` or `.../pdf/:clientId`.
- Backend logs show file system errors or PDFKit errors.

### Root Causes
| Cause | Likelihood |
|---|---|
| Temp directory (`backend/temp/`) missing or not writable | High |
| Client has no work entries — empty export | Medium |
| Disk full — cannot write temp files | Medium |
| PDFKit font or rendering error | Low |

### Response Steps

```
1. Check temp directory:
      ls -la backend/temp/ 2>/dev/null || echo "MISSING"
      # Create if missing:
      mkdir -p backend/temp && chmod 755 backend/temp

2. Check disk space:
      df -h .

3. Test export directly:
      # First create test data
      curl -sf http://localhost:3001/api/auth/login \
        -X POST -H "Content-Type: application/json" \
        -d '{"email":"test@example.com"}'

      curl -sf http://localhost:3001/api/clients \
        -H "x-user-email: test@example.com" | jq '.clients[0].id'

      # Then test CSV export (replace <id>)
      curl -sf http://localhost:3001/api/reports/export/csv/<id> \
        -H "x-user-email: test@example.com" -o test.csv
      file test.csv && wc -l test.csv

4. Check for orphaned temp files:
      find backend/temp/ -mmin +60 -type f -delete
```

### Prevention
- Add temp directory existence check on server startup.
- Implement streaming exports for large datasets instead of temp file approach.
- Add a cron job or startup hook to clean orphaned temp files.

---

## 9. FM-8: Frontend Build / Serving Failure

### Symptoms
- `npm run build` fails in the frontend directory.
- Production container serves blank page or 404 for static assets.
- Vite dev server won't start — port conflict or config error.

### Root Causes
| Cause | Likelihood |
|---|---|
| TypeScript compilation errors | High |
| Missing environment variables (`VITE_API_URL`) | Medium |
| Port 5173 already in use (dev) | Medium |
| Outdated or incompatible npm dependencies | Low |

### Response Steps

```
1. Check build output:
      cd frontend && npm run build 2>&1 | tail -50

2. Check TypeScript errors:
      cd frontend && npx tsc --noEmit

3. Verify environment:
      cat frontend/.env
      # Should contain: VITE_API_URL=http://localhost:3001

4. Check for port conflict (dev mode):
      lsof -i :5173

5. Verify Vite proxy config:
      cat frontend/vite.config.ts
      # /api should proxy to http://localhost:3001

6. For production (static served by Express):
      ls -la public/           # inside Docker container at /app/public
      # Should contain index.html and assets/

7. Clean rebuild:
      cd frontend && rm -rf node_modules dist && npm ci && npm run build
```

### Prevention
- Run `npm run lint` and TypeScript checks in CI before merge.
- Pin Vite and TypeScript versions to avoid unexpected breaking changes.
- Test production build locally before deploying.

---

## 10. FM-9: Docker Container Health Check Failure

### Symptoms
- `docker ps` shows container as `unhealthy`.
- Docker orchestrator (Compose, Swarm, K8s) restarts the container repeatedly.
- Application is functional when accessed directly but health check fails.

### Root Causes
| Cause | Likelihood |
|---|---|
| Backend hasn't finished starting (JVM-equivalent: Node.js + DB init) | High |
| Health check endpoint unreachable inside container network | Medium |
| Container resource limits too low | Low |

### Response Steps

```
1. Check container health:
      docker inspect --format='{{json .State.Health}}' <container> | jq .

2. Run health check manually inside container:
      docker exec <container> node -e \
        "require('http').get('http://localhost:3001/health', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{console.log(r.statusCode,d); process.exit(r.statusCode===200?0:1)}) })"

3. Check container logs:
      docker logs --tail 50 <container>

4. Check resource usage:
      docker stats --no-stream <container>

5. If start_period too short, increase in Dockerfile or compose:
      HEALTHCHECK --start-period=10s  # increase from 5s
```

### Prevention
- Set appropriate `start_period` (5–10s for this app).
- Use multi-stage health checks (liveness vs. readiness) if migrating to Kubernetes.

---

## 11. FM-10: Network / CORS Errors

### Symptoms
- Browser console shows CORS errors: "No 'Access-Control-Allow-Origin' header".
- API requests fail from frontend but succeed from curl.
- Vite proxy errors in dev mode.

### Root Causes
| Cause | Likelihood |
|---|---|
| `FRONTEND_URL` env var doesn't match actual frontend origin | High |
| Reverse proxy stripping or rewriting CORS headers | Medium |
| Vite proxy config mismatch (dev mode) | Medium |

### Response Steps

```
1. Check CORS config:
      grep FRONTEND_URL backend/.env
      # Must match the origin the browser uses (e.g., http://localhost:5173)

2. Test CORS preflight:
      curl -v -X OPTIONS http://localhost:3001/api/clients \
        -H "Origin: http://localhost:5173" \
        -H "Access-Control-Request-Method: GET" 2>&1 | grep -i "access-control"

3. Verify Vite proxy (dev):
      cat frontend/vite.config.ts
      # /api should proxy to http://localhost:3001

4. Fix FRONTEND_URL and restart:
      # Edit backend/.env
      FRONTEND_URL=http://localhost:5173  # or production domain
      # Restart backend
```

### Prevention
- Keep `FRONTEND_URL` in sync across environments.
- In production, consider serving frontend static files from the Express server (eliminates CORS entirely — already done in Docker).
- Document all required environment variables in `.env.example`.

---

## 12. Escalation Contacts

| Role | Responsibility | Contact |
|---|---|---|
| On-call Engineer | First responder, triage, immediate mitigation | Team rotation schedule |
| Tech Lead | Architectural decisions, complex debugging | @tech-lead |
| DevOps / SRE | Infrastructure, Docker, deployments | @devops-team |
| Product Owner | Business impact assessment, customer comms | @product-owner |

**Escalation rules:**
- **P1**: Page on-call + tech lead immediately. War room within 15 minutes.
- **P2**: Notify on-call within 15 minutes. Tech lead informed within 1 hour.
- **P3**: On-call picks up within next business hour.
- **P4**: Triaged in next sprint planning.

---

## 13. Post-Incident Review Template

After any P1 or P2 incident, complete a review within 5 business days:

```markdown
## Post-Incident Review

**Incident**: [Title]
**Date**: YYYY-MM-DD
**Duration**: X hours Y minutes
**Severity**: P1 / P2

### Timeline
| Time (UTC) | Event |
|---|---|
| HH:MM | Alert triggered / Incident reported |
| HH:MM | On-call acknowledged |
| HH:MM | Root cause identified |
| HH:MM | Mitigation applied |
| HH:MM | Service restored |

### Root Cause
[Describe the root cause]

### Impact
- Users affected: X
- Data lost: Y/N
- Revenue impact: $X

### What Went Well
- [Item]

### What Went Poorly
- [Item]

### Action Items
| Action | Owner | Due Date |
|---|---|---|
| [Action] | @person | YYYY-MM-DD |
```
