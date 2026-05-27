# Timesheet App — Incident Response Runbook

## Table of Contents

- [1. Overview](#1-overview)
- [2. Failure Mode: Database Issues](#2-failure-mode-database-issues)
- [3. Failure Mode: API Errors](#3-failure-mode-api-errors)
- [4. Failure Mode: Authentication Failures](#4-failure-mode-authentication-failures)
- [5. Failure Mode: Memory / Resource Issues](#5-failure-mode-memory--resource-issues)
- [6. Failure Mode: PDF/CSV Export Failures](#6-failure-mode-pdfcsv-export-failures)
- [7. Failure Mode: Dependency / Infrastructure](#7-failure-mode-dependency--infrastructure)
- [8. General Incident Response Checklist](#8-general-incident-response-checklist)
- [9. Key Environment Variables](#9-key-environment-variables)
- [10. Useful Commands](#10-useful-commands)

## 1. Overview
- App architecture (Express backend on port 3001, React frontend on 5173, SQLite DB)
- Key dependencies: sqlite3, pdfkit, csv-writer, express-rate-limit, helmet, joi
- Health check endpoint: GET /health

## 2. Failure Mode: Database Issues

### 2.1 In-Memory Data Loss (Server Restart)
- Symptoms: All user data gone after restart, users report missing clients/entries
- Detection: Check server logs for "Connected to SQLite in-memory database" after restart
- Response steps:
  1. Confirm restart via logs (`docker logs` or `journalctl`)
  2. Notify affected users
  3. If production: switch to file-based SQLite by setting `DATABASE_PATH` env var (see `docker/overrides/database/init.js`)
- Prevention: Use file-based SQLite in production, set up automated backups

### 2.2 SQLite Connection Failure
- Symptoms: All API endpoints return 500, logs show "Error opening database:"
- Detection: GET /health may still return 200 (health check doesn't touch DB), but all /api/* calls fail
- Response steps:
  1. Check server logs for "Error opening database:" messages
  2. If file-based: check disk space (`df -h`), file permissions on DATABASE_PATH
  3. Check if sqlite3 native module is intact (`npm ls sqlite3`)
  4. Restart the server process
  5. If persists: rebuild native modules (`npm rebuild sqlite3`)
- Escalation: If rebuild fails, may need Node.js version alignment

### 2.3 SQLite Disk Full (File-Based Mode)
- Symptoms: Write operations (POST/PUT) fail with 500, reads may still work
- Detection: Logs show SQLITE_FULL errors; `df -h` shows full disk
- Response steps:
  1. Check disk space: `df -h`
  2. Clean temp files: `rm -rf backend/temp/*`
  3. If DB file is too large, consider archiving old work_entries
  4. Increase disk allocation

## 3. Failure Mode: API Errors

### 3.1 Mass 500 Errors
- Symptoms: Multiple endpoints returning 500 Internal Server Error
- Detection: Monitor logs for "Database error:" pattern; health check at /health may pass
- Response steps:
  1. Check /health endpoint first
  2. Tail server logs: look for "Database error:" or stack traces
  3. Check if database is accessible (SQLite connection)
  4. Check Node.js process memory: `process.memoryUsage()`
  5. Restart server if unrecoverable

### 3.2 Validation Errors (400s)
- Symptoms: Users can't create/update resources, getting 400 errors
- Detection: Logs show Joi validation errors
- Response steps:
  1. Check if a deployment changed validation schemas (`backend/src/validation/schemas.js`)
  2. Compare frontend request payloads against expected schema
  3. Roll back if schema change is the cause

### 3.3 Rate Limiting (429 Too Many Requests)
- Symptoms: Users getting 429 responses, "Too many requests"
- Detection: Server logs from express-rate-limit
- Response steps:
  1. Identify if it's legitimate traffic or abuse
  2. If legitimate: temporarily increase `max` in rate limiter config (server.js line 28-29, currently 100 req/15min)
  3. If abuse: block offending IPs at network level
  4. Consider per-user rate limiting instead of per-IP

## 4. Failure Mode: Authentication Failures

### 4.1 Auth Middleware Failures
- Symptoms: All authenticated endpoints return 401 or 500
- Detection: GET /health works but all /api/clients, /api/work-entries fail
- Response steps:
  1. Test auth directly: `curl -H "x-user-email: test@test.com" http://localhost:3001/api/auth/me`
  2. If 500: database issue (auth middleware queries DB on every request — see `backend/src/middleware/auth.js`)
  3. If 401: check frontend is sending x-user-email header
  4. Check if JWT_SECRET env var is set (used in auth routes)

## 5. Failure Mode: Memory / Resource Issues

### 5.1 Memory Growth (Node.js Process)
- Symptoms: Slow responses, eventual OOM kill
- Detection: Monitor RSS via `ps aux | grep node`; look for OOM in system logs
- Response steps:
  1. Check Node.js heap: if accessible, `process.memoryUsage()`
  2. In-memory SQLite grows with data — this is by design; switch to file-based for large datasets
  3. Check for orphan temp files in `backend/temp/` from failed CSV exports
  4. Restart process and investigate with `--max-old-space-size` flag if needed

### 5.2 Temp File Accumulation
- Symptoms: Disk usage growing in backend/temp/ directory
- Detection: `du -sh backend/temp/`
- Response steps:
  1. Clean orphan CSV files: `rm -rf backend/temp/*.csv`
  2. These are from CSV export (reports.js lines 103-136) — cleanup is async and can fail silently
  3. Consider adding a cron job to clean temp files older than 1 hour

## 6. Failure Mode: PDF/CSV Export Failures

### 6.1 CSV Export Failure
- Symptoms: CSV download fails, 500 error
- Detection: Logs show "Error creating CSV:" or "Error sending file:"
- Response steps:
  1. Check temp directory exists and is writable: `ls -la backend/temp/`
  2. Check disk space
  3. Manually create temp dir: `mkdir -p backend/temp`

### 6.2 PDF Export Failure
- Symptoms: PDF download fails or produces empty file
- Detection: Logs show errors from PDFKit
- Response steps:
  1. Check server memory (PDFKit generates in-memory)
  2. Test with a client that has few work entries to isolate
  3. Check pdfkit dependency: `npm ls pdfkit`

## 7. Failure Mode: Dependency / Infrastructure

### 7.1 Native Module Failure (sqlite3)
- Symptoms: Server won't start, crashes on import
- Detection: Error like "Cannot find module sqlite3" or "NODE_MODULE_VERSION mismatch"
- Response steps:
  1. `npm rebuild sqlite3`
  2. If fails: `rm -rf node_modules && npm install`
  3. Ensure Node.js version matches what sqlite3 was compiled against

### 7.2 Docker Container Issues
- Symptoms: Container won't start or keeps restarting
- Detection: `docker ps -a`, `docker logs <container>`
- Response steps:
  1. Check Docker logs for startup errors
  2. Verify Dockerfile at `docker/Dockerfile`
  3. Check volume mounts for DATABASE_PATH
  4. Rebuild image: `docker build -f docker/Dockerfile -t timesheet-app .`

## 8. General Incident Response Checklist
1. Check /health endpoint
2. Check server logs for errors
3. Verify database connectivity
4. Check disk space and memory
5. Check rate limiting status
6. Verify environment variables (PORT, JWT_SECRET, FRONTEND_URL, DATABASE_PATH)
7. Restart server if needed
8. Notify affected users
9. Document incident in GitHub Issue using appropriate template

## 9. Key Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3001 | Backend server port |
| NODE_ENV | development | Environment mode |
| FRONTEND_URL | http://localhost:5173 | CORS origin |
| JWT_SECRET | (required) | JWT signing key |
| DATABASE_PATH | :memory: | SQLite database path (production override) |

## 10. Useful Commands
- Health check: `curl http://localhost:3001/health`
- Test auth: `curl -H "x-user-email: test@test.com" http://localhost:3001/api/auth/me`
- Check logs: `docker logs timesheet-app --tail 100`
- Check disk: `df -h && du -sh backend/temp/`
- Check memory: `ps aux | grep node`
- Rebuild native modules: `cd backend && npm rebuild sqlite3`
