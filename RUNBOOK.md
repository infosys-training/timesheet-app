# RUNBOOK — Client Timesheet Application

## 1. Overview

The Client Timesheet Application is a full-stack web application for tracking labor hours across multiple clients. Users can log work entries, manage client records, and generate PDF/CSV reports.

### Architecture

```
┌─────────────────┐       ┌─────────────────────┐       ┌──────────────┐
│   React/Vite    │──────▶│   Express (Node.js)  │──────▶│    SQLite    │
│  Frontend:5173  │ HTTP  │   Backend:3001       │       │  (file/mem)  │
└─────────────────┘       └─────────────────────┘       └──────────────┘
```

- **Frontend**: React + TypeScript + Material UI, served by Vite dev server on port `5173` (dev) or statically by Express (production Docker)
- **Backend**: Express.js on port `3001`
- **Database**: SQLite — in-memory (dev) or file-based (production via `DATABASE_PATH`)

### Key Ports

| Service  | Port  | Notes                          |
|----------|-------|--------------------------------|
| Backend  | 3001  | Express API + static frontend  |
| Frontend | 5173  | Vite dev server (dev only)     |

### Environment Variables

| Variable        | Description                                      | Default                    |
|-----------------|--------------------------------------------------|----------------------------|
| `PORT`          | Backend listen port                              | `3001`                     |
| `NODE_ENV`      | Runtime environment                              | `development`              |
| `FRONTEND_URL`  | Allowed CORS origin for the frontend             | `http://localhost:5173`    |
| `JWT_SECRET`    | Secret for token signing (if applicable)         | —                          |
| `DATABASE_PATH` | Path to SQLite file (omit for in-memory)         | `:memory:`                 |

---

## 2. Health Check & Monitoring

### Health Endpoint

```bash
curl http://localhost:3001/health
```

**Expected response** (HTTP 200):
```json
{ "status": "OK", "timestamp": "2024-01-01T00:00:00.000Z" }
```

### Docker Health Check

Defined in `docker/Dockerfile`:
```
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"
```

### Health Check Script

A comprehensive health check script is available at `scripts/health-check.sh`. Run it to verify all endpoints:

```bash
./scripts/health-check.sh                     # defaults to localhost:3001
./scripts/health-check.sh http://prod:3001    # custom base URL
./scripts/health-check.sh --json              # JSON output for monitoring
```

---

## 3. Failure Mode: Database Issues

### Symptoms
- 500 errors on all API endpoints
- Logs show `"Error opening database"` or `"Database error"`

### In-Memory Data Loss
By design, the in-memory SQLite database loses all data on server restart. For production, always set `DATABASE_PATH` to a persistent volume path.

### SQLite File Corruption
1. Check disk space: `df -h`
2. Check file permissions on `DATABASE_PATH`
3. Verify the directory exists — the Docker override (`docker/overrides/database/init.js`) creates the directory if missing
4. Verify file integrity:
   ```bash
   sqlite3 /app/data/timesheet.db "PRAGMA integrity_check"
   ```

### Connection Failure
The singleton in `backend/src/database/init.js` throws if SQLite can't connect. Check Node.js process logs for the exact error.

### Recovery Steps
1. Restart the backend process
2. Verify `DATABASE_PATH` is writable
3. Check disk space (`df -h`)
4. Check SQLite file integrity with `sqlite3 <db_path> "PRAGMA integrity_check"`
5. If corrupt, restore from backup or reinitialize

---

## 4. Failure Mode: API Errors (5xx)

### Symptoms
- Users see "Internal server error" responses

### Diagnosis
- Check Morgan access logs (combined format, configured in `server.js`)
- Look for `console.error('Database error:', err)` patterns in route files (`routes/clients.js`, `routes/workEntries.js`, `routes/reports.js`)

### Rate Limiting
- Global limit: **100 requests per 15 minutes per IP** (`server.js` rate limiter config)
- Symptom: HTTP `429 Too Many Requests`
- Mitigation: Adjust the `max` value in the rate limiter configuration or add IP whitelist for trusted sources

### Validation Errors
- Joi returns HTTP 400 with validation details — this is not a system failure
- Check client-side input for correctness

### Recovery
1. Check logs and identify the failing route
2. Verify database connectivity
3. Restart if needed

---

## 5. Failure Mode: Memory Issues

### PDF Generation
`PDFKit` in `routes/reports.js` creates streams piped to the HTTP response. If a client disconnects mid-stream, the stream may not close properly. Monitor Node.js heap usage.

### Temp File Accumulation
CSV export in `routes/reports.js` writes to `backend/temp/` directory. Cleanup only happens on successful `res.download()`. If downloads fail, temp files accumulate.

**Mitigation**: Add a cron job or periodic cleanup script:
```bash
find backend/temp/ -type f -mmin +60 -delete
```

### In-Memory SQLite Growth
There is no eviction policy for in-memory SQLite. Monitor process RSS memory. In production, use file-based SQLite with `DATABASE_PATH`.

### Diagnosis
- Run with `node --inspect` to attach debugger
- Check `process.memoryUsage()` from within the app
- Monitor with `top` / `htop` / `docker stats`

### Recovery
1. Restart the process to reclaim memory
2. Clean up `backend/temp/` directory: `rm -rf backend/temp/*`
3. Consider adding a periodic cleanup script or cron job

---

## 6. Failure Mode: Authentication Failures

### Symptoms
- 401 errors
- Users redirected to `/login` repeatedly

### Cause
- Missing `x-user-email` header (see `backend/src/middleware/auth.js`)
- Malformed email (regex validation at line 12 of auth middleware)

### Frontend Side
`frontend/src/api/client.ts` injects the `x-user-email` header from `localStorage.getItem('userEmail')`. If localStorage is cleared, authentication breaks.

### Recovery
1. Verify the `x-user-email` header is being sent (browser DevTools → Network tab)
2. Check browser localStorage for `userEmail` key
3. Re-login through the UI

---

## 7. Failure Mode: CORS / Connectivity

### Symptoms
- Browser console shows CORS errors
- API calls fail from the frontend

### Cause
`FRONTEND_URL` environment variable in `server.js` doesn't match the actual frontend origin. The CORS middleware uses this value as the allowed origin.

### Recovery
1. Set `FRONTEND_URL` to match exactly (protocol + host + port), e.g. `http://localhost:5173`
2. Restart the backend
3. Verify with: `curl -H "Origin: http://localhost:5173" -I http://localhost:3001/health`

---

## 8. Failure Mode: Process Crash / Startup Failure

### Symptoms
- Container keeps restarting
- Health check fails repeatedly

### Cause
`initializeDatabase()` failure causes `process.exit(1)` in `server.js`. This terminates the process immediately on any DB initialization error.

### Docker Specifics
- Check logs: `docker logs <container>`
- Verify `DATABASE_PATH` volume mount is correct
- Verify `dumb-init` is handling signals properly (PID 1 reaping)

### Recovery
1. Fix the underlying database issue (see Section 3)
2. Redeploy the container
3. Verify health endpoint returns 200 after restart

---

## 9. Escalation Matrix

| Priority | Severity       | Description                                                       | Response Time | Examples                                                  |
|----------|----------------|-------------------------------------------------------------------|---------------|-----------------------------------------------------------|
| **P1**   | Critical       | Complete service outage — all APIs returning 500, DB corruption   | Immediate     | Database corruption, process won't start, all routes 500  |
| **P2**   | High           | Partial outage — one route group failing, auth broken for all     | < 30 min      | Auth middleware broken, reports endpoint down              |
| **P3**   | Medium         | Degraded — rate limiting legitimate users, slow responses         | < 2 hours     | Memory pressure, rate limit too aggressive, slow queries  |
| **P4**   | Low            | Minor — temp file cleanup, individual user issues, cosmetic       | < 24 hours    | Single user auth issue, temp files accumulating           |

---

## 10. Useful Commands

```bash
# Check health
curl http://localhost:3001/health

# Check logs (Docker)
docker logs <container>

# Check DB integrity
sqlite3 /app/data/timesheet.db "PRAGMA integrity_check"

# Check disk space
df -h /app/data

# Check memory usage (Docker)
docker stats <container>

# Restart (Docker)
docker restart <container>

# Restart (PM2)
pm2 restart timesheet-app

# Clean temp files
rm -rf backend/temp/*

# Run health check script
./scripts/health-check.sh

# Run health check with JSON output
./scripts/health-check.sh --json
```
