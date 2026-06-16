# Timesheet App — SRE Assessment Report

> **Date:** 2026-06-16
> **Assessor:** Devin (automated SRE analysis)
> **Application:** timesheet-app (Express + React + SQLite)
> **Repository:** infosys-training/timesheet-app

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Application Architecture Overview](#2-application-architecture-overview)
3. [SRE Criteria Assessment](#3-sre-criteria-assessment)
4. [Gap Analysis & Recommendations](#4-gap-analysis--recommendations)
5. [Prioritized Action Plan](#5-prioritized-action-plan)
6. [Maturity Scorecard](#6-maturity-scorecard)

---

## 1. Executive Summary

The timesheet-app is a full-stack Node.js application with a React/TypeScript SPA frontend and an Express backend backed by SQLite. The application has solid foundations in some SRE areas — notably **container security** (non-root user, dumb-init, multi-stage builds), **automated security scanning** (SonarCloud SAST + npm audit with Devin auto-remediation), and **basic health checking**. However, significant gaps exist in **observability**, **data durability**, **authentication security**, **scalability**, and **disaster recovery** that must be addressed before production-grade operation.

**Overall SRE Maturity: Level 2 — Managed** (on a 1–5 scale)

The application is suitable for internal development/demo use. Production readiness requires addressing the critical and high-priority items in Section 5.

---

## 2. Application Architecture Overview

### 2.1 Component Topology

```
┌─────────────────────────────────────────────────┐
│                    Docker Host                    │
│                                                   │
│  ┌─────────────────────────────────────────────┐  │
│  │         Node.js Container (node:20-alpine)   │  │
│  │                                               │  │
│  │  ┌──────────────┐    ┌────────────────────┐  │  │
│  │  │  Express API  │    │  Static Files      │  │  │
│  │  │  (port 3001)  │    │  (React SPA)       │  │  │
│  │  │               │    │  served by Express  │  │  │
│  │  │  /api/*       │    │  /* → index.html    │  │  │
│  │  │  /health      │    │                    │  │  │
│  │  └──────┬───────┘    └────────────────────┘  │  │
│  │         │                                     │  │
│  │  ┌──────▼───────┐                            │  │
│  │  │   SQLite DB   │                            │  │
│  │  │ /app/data/    │  ◄── Docker Volume Mount   │  │
│  │  │ timesheet.db  │                            │  │
│  │  └──────────────┘                            │  │
│  └─────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

### 2.2 Deployment Configuration

| Aspect | Development | Production (Docker) |
|---|---|---|
| **Server** | `nodemon` (auto-reload) | `dumb-init` → `node src/server.js` |
| **Database** | SQLite in-memory (`:memory:`) | SQLite file-based (`/app/data/timesheet.db`) |
| **Frontend** | Vite dev server (port 5173) + proxy | Static files served by Express |
| **Auth** | Email-only via `x-user-email` header | Same (no change in production) |
| **CORS** | `FRONTEND_URL` env var | Same-origin (bypassed) |
| **Process user** | Current user | `nodejs` (UID 1001, non-root) |
| **Health check** | Manual `curl` | Docker `HEALTHCHECK` (30s interval, 3 retries) |

### 2.3 CI/CD Pipeline

```
PR Opened/Updated
  ├── Security Audit (npm audit — high/critical CVEs)
  │     └── On failure → Devin CVE Auto-Fix session
  ├── Quality Gate (test coverage ≥ 80% threshold)
  └── SonarCloud SAST scan
        └── On failure → Devin SAST Auto-Fix session
```

### 2.4 Key Dependencies

| Component | Package | Version | Risk Profile |
|---|---|---|---|
| HTTP framework | `express` | ^4.18.2 | Low — stable, well-maintained |
| Database driver | `sqlite3` | ^5.1.6 | Medium — native addon, Node version-sensitive |
| PDF generation | `pdfkit` | ^0.13.0 | Low |
| CSV export | `csv-writer` | ^1.6.0 | Low |
| Validation | `joi` | ^17.11.0 | Low |
| Security headers | `helmet` | ^7.1.0 | Low |
| Rate limiting | `express-rate-limit` | ^7.1.5 | Low |
| Frontend HTTP | `axios` | ^1.13.2 | Low |
| UI framework | `@mui/material` | ^7.3.6 | Medium — frequent major releases |

---

## 3. SRE Criteria Assessment

### Assessment Key

| Rating | Meaning |
|---|---|
| ✅ **Pass** | Meets SRE best practices for the application's scale |
| ⚠️ **Partial** | Some implementation exists but has significant gaps |
| ❌ **Fail** | Missing or critically insufficient |

---

### 3.1 Reliability & Availability

| # | Criterion | Rating | Evidence |
|---|---|---|---|
| R1 | Health check endpoint exists | ✅ Pass | `GET /health` returns `{"status":"OK","timestamp":"..."}` (`server.js:40-42`) |
| R2 | Container health check configured | ✅ Pass | `HEALTHCHECK` directive in Dockerfile (30s interval, 3 retries, 5s start period) |
| R3 | Graceful shutdown handling | ❌ Fail | No `SIGTERM`/`SIGINT` handlers. `dumb-init` forwards signals but the app doesn't handle them — open DB connections and in-flight requests are not drained. |
| R4 | Process manager / restart policy | ⚠️ Partial | `dumb-init` used in Docker. No Docker Compose `restart: always` or orchestrator config found. PM2 mentioned in docs but not configured. |
| R5 | SLO/SLI/SLA definitions | ❌ Fail | No SLOs, SLIs, or error budgets defined. |
| R6 | Redundancy / failover | ❌ Fail | Single-instance architecture. No load balancer, no replica, no failover path. |
| R7 | Circuit breaker / retry logic | ❌ Fail | No circuit breaker patterns. Frontend Axios client has a 10s timeout but no retry logic. |
| R8 | Request timeout configuration | ⚠️ Partial | Frontend Axios timeout set to 10s. Backend Express has no explicit request timeout — relies on defaults. |

### 3.2 Observability

| # | Criterion | Rating | Evidence |
|---|---|---|---|
| O1 | Structured logging | ❌ Fail | Uses `morgan('combined')` for access logs and `console.error()` for errors. No structured JSON logging, no correlation IDs, no log levels. |
| O2 | Application metrics (Prometheus/StatsD) | ❌ Fail | No metrics endpoint. No request latency, error rate, or DB query duration metrics. |
| O3 | Distributed tracing | ❌ Fail | No tracing headers or OpenTelemetry integration. |
| O4 | Alerting rules defined | ❌ Fail | No alerting configuration. Health check exists but nothing monitors it externally. |
| O5 | Log aggregation pipeline | ❌ Fail | Logs go to stdout/stderr only. No ELK, CloudWatch, Datadog, or similar integration. |
| O6 | Dashboard / visualization | ❌ Fail | No Grafana, Datadog, or similar dashboards. |
| O7 | Error tracking (Sentry/Bugsnag) | ❌ Fail | Errors logged to console only. No external error tracking service. |

### 3.3 Security

| # | Criterion | Rating | Evidence |
|---|---|---|---|
| S1 | Security headers (Helmet) | ✅ Pass | Helmet enabled with CSP, CORS configured. Production Docker override has tailored CSP directives. |
| S2 | Rate limiting | ✅ Pass | `express-rate-limit` configured: 100 req / 15 min per IP. |
| S3 | Input validation | ✅ Pass | Joi schemas validate all request bodies (clients, work entries, auth). Parameterized SQL queries throughout. |
| S4 | Automated security scanning (SAST) | ✅ Pass | SonarCloud integration + Devin auto-remediation workflow (`sast-scan.yml`). |
| S5 | Dependency vulnerability scanning (CVE) | ✅ Pass | `npm audit` in CI with auto-fix via Devin (`pr-checks.yml`). |
| S6 | Non-root container execution | ✅ Pass | Dockerfile creates `nodejs` user (UID 1001) and switches with `USER nodejs`. |
| S7 | Authentication strength | ❌ Fail | Email-only, no password, no MFA. `x-user-email` header is trivially spoofable. README acknowledges this. |
| S8 | Secrets management | ⚠️ Partial | `JWT_SECRET` in `.env` file. `.env.example` has a placeholder secret. No vault integration, no secret rotation. Note: JWT is declared in env but the auth middleware actually uses `x-user-email` header directly, not JWT tokens — the JWT dependency is unused. |
| S9 | TLS/HTTPS | ❌ Fail | No TLS termination. Docker serves HTTP only. `strictTransportSecurity: false` in production Helmet config. |
| S10 | RBAC / authorization | ❌ Fail | All authenticated users have equal access. Data isolation is by `user_email` in queries but no roles or permissions exist. |

### 3.4 CI/CD & Change Management

| # | Criterion | Rating | Evidence |
|---|---|---|---|
| C1 | Automated test suite | ✅ Pass | 161 backend tests, 90%+ coverage. Jest with supertest for integration tests. |
| C2 | CI pipeline on PRs | ✅ Pass | `pr-checks.yml` runs security audit + quality gate on every PR. |
| C3 | Code coverage thresholds | ✅ Pass | 80% threshold enforced in CI. Jest config: 60% minimum (statements, branches, lines), 65% functions. |
| C4 | Automated deployment pipeline | ❌ Fail | No CD pipeline. Dockerfile exists but no automated build/push/deploy workflow (no `docker-compose.yml`, no Kubernetes manifests, no cloud deploy action). |
| C5 | Canary / blue-green deployment | ❌ Fail | No deployment strategy defined. Single instance, no rollback automation. |
| C6 | Database migration management | ❌ Fail | Schema created via `CREATE TABLE IF NOT EXISTS` at startup. No versioned migrations, no rollback capability. |
| C7 | Feature flags | ❌ Fail | No feature flag system. |
| C8 | Rollback procedure documented | ⚠️ Partial | `RUNBOOK.md` (added in this PR) documents manual rollback. No automated rollback. |

### 3.5 Data Management & Backup

| # | Criterion | Rating | Evidence |
|---|---|---|---|
| D1 | Persistent storage | ⚠️ Partial | Docker override uses file-based SQLite with `DATABASE_PATH=/app/data/timesheet.db`. Requires proper volume mount — not enforced by any docker-compose config. Dev uses in-memory (ephemeral). |
| D2 | Backup strategy | ❌ Fail | No automated backups. `DEPLOYMENT.md` states "Not applicable for in-memory database." Docker production has file-based DB but no backup job. |
| D3 | Backup restoration tested | ❌ Fail | No backup restoration procedure or test. |
| D4 | Data retention policy | ❌ Fail | No retention policy. Data accumulates indefinitely. |
| D5 | Temp file cleanup | ⚠️ Partial | CSV export creates temp files in `backend/temp/` and deletes after download. No cron/janitor for orphaned files if download fails mid-transfer. |

### 3.6 Scalability & Performance

| # | Criterion | Rating | Evidence |
|---|---|---|---|
| P1 | Horizontal scaling capability | ❌ Fail | SQLite is single-writer. No support for multiple backend instances. README lists this as a known limitation. |
| P2 | Load testing | ❌ Fail | No load test scripts or results. |
| P3 | Database indexing | ✅ Pass | Indexes on `clients.user_email`, `work_entries.client_id`, `work_entries.user_email`, `work_entries.date`. |
| P4 | Resource limits defined | ⚠️ Partial | JSON body limit set to 10MB. No container CPU/memory limits defined (no docker-compose or k8s resource spec). |
| P5 | Connection pooling | N/A | SQLite is embedded — no connection pool needed. Single DB handle via singleton. |
| P6 | CDN / asset caching | ❌ Fail | No CDN. Static assets served directly from Express with no cache headers. |

### 3.7 Incident Management

| # | Criterion | Rating | Evidence |
|---|---|---|---|
| I1 | Incident response runbook | ✅ Pass | `RUNBOOK.md` covers 10 failure modes with diagnosis and resolution steps (added in this PR). |
| I2 | Incident issue templates | ✅ Pass | P1–P4 templates in `.github/ISSUE_TEMPLATE/` with impact, timeline, resolution fields (added in this PR). |
| I3 | Health check script | ✅ Pass | `scripts/health-check.sh` tests 20 endpoints with cleanup (added in this PR). |
| I4 | On-call rotation | ❌ Fail | No PagerDuty, Opsgenie, or on-call schedule. Placeholder contacts in RUNBOOK.md. |
| I5 | Postmortem process | ❌ Fail | No postmortem template or blameless review process defined. |
| I6 | Chaos engineering / game days | ❌ Fail | No chaos testing or failure injection. |

### 3.8 Disaster Recovery

| # | Criterion | Rating | Evidence |
|---|---|---|---|
| DR1 | RTO/RPO defined | ❌ Fail | No Recovery Time Objective or Recovery Point Objective documented. |
| DR2 | DR plan documented | ❌ Fail | No disaster recovery plan. Rollback in RUNBOOK.md is the closest artifact. |
| DR3 | DR tested | ❌ Fail | No DR drill or test evidence. |
| DR4 | Multi-region / multi-AZ | ❌ Fail | Single-instance architecture. |

---

## 4. Gap Analysis & Recommendations

### 4.1 Critical Gaps (Must Fix)

| # | Gap | Risk | Recommendation | Action |
|---|---|---|---|---|
| G1 | **No graceful shutdown** | In-flight requests dropped on deploy; potential DB corruption on SIGKILL | Add `SIGTERM`/`SIGINT` handlers that stop accepting new connections, drain in-flight requests, and call `closeDatabase()`. | Add shutdown handler in `backend/src/server.js`. Set Docker `stop_grace_period: 30s`. |
| G2 | **Authentication is trivially spoofable** | Any HTTP client can impersonate any user by setting `x-user-email` header | Replace email-header auth with a proper mechanism: OAuth 2.0 / OIDC with company SSO, or at minimum validate JWT tokens (the `jsonwebtoken` dependency is already installed but unused). | Implement JWT token validation in `backend/src/middleware/auth.js`. Issue tokens on login. |
| G3 | **No TLS** | All traffic including auth headers transmitted in cleartext | Terminate TLS at a reverse proxy (nginx, Caddy, ALB) or within the app. | Add nginx/Caddy reverse proxy config. Or deploy behind a cloud load balancer with TLS. |
| G4 | **No automated backups** | Complete data loss if DB file is corrupted/deleted | Implement scheduled SQLite backups using `.backup` command. Store in object storage (S3, GCS). | Create a cron job or sidecar: `sqlite3 $DATABASE_PATH ".backup /backups/timesheet-$(date +%s).db"`. Add retention policy. |
| G5 | **No observability stack** | Blind to performance degradation, error spikes, and anomalies until users report | Integrate structured logging (winston/pino), Prometheus metrics (`prom-client`), and an error tracker (Sentry). | Install `pino` + `prom-client`. Add `/metrics` endpoint. Deploy Prometheus + Grafana or use a managed service. |

### 4.2 High-Priority Gaps (Should Fix)

| # | Gap | Risk | Recommendation | Action |
|---|---|---|---|---|
| G6 | **No CD pipeline** | Manual deployment is error-prone and slow | Add a GitHub Actions workflow that builds the Docker image, pushes to a registry, and deploys on merge to `main`. | Create `.github/workflows/deploy.yml` with build → push → deploy stages. |
| G7 | **No SLOs defined** | Cannot measure reliability or set expectations | Define SLOs for availability (e.g., 99.9%), latency (p99 < 500ms), and error rate (< 0.1%). | Create `SLO.md` with target SLIs measured from `/metrics`. Configure alerting on error budget burn rate. |
| G8 | **No database migrations** | Schema changes require manual intervention; no rollback for schema changes | Adopt a migration tool (e.g., `knex migrate`, `umzug`, or `db-migrate`) with versioned, reversible migrations. | Replace `CREATE TABLE IF NOT EXISTS` with versioned migration files. |
| G9 | **Single-instance, no redundancy** | Single point of failure for the entire application | For immediate resilience: run 2+ instances behind a load balancer. Long-term: migrate from SQLite to PostgreSQL. | Add `docker-compose.yml` with replica count or deploy to Kubernetes with `replicas: 2`. |
| G10 | **No request timeouts on backend** | Slow DB queries or report generation can hang indefinitely, exhausting connections | Set explicit request timeouts on the Express server. | Add `server.setTimeout(30000)` and per-route timeouts for long-running report exports. |

### 4.3 Medium-Priority Gaps (Nice to Have)

| # | Gap | Risk | Recommendation | Action |
|---|---|---|---|---|
| G11 | **No load testing** | Unknown capacity limits; potential to discover issues only under real traffic | Create load test scripts (k6 or Artillery) for key workflows. | Write `scripts/load-test.js` covering login → create client → log entries → export report. |
| G12 | **No on-call rotation** | No defined first responder for incidents | Set up PagerDuty/Opsgenie with escalation policies. | Integrate alerting (G5) with on-call tool. Update RUNBOOK.md contacts. |
| G13 | **No postmortem process** | Repeated incidents without learning | Create a postmortem template and require blameless reviews for P1/P2 incidents. | Add `.github/ISSUE_TEMPLATE/postmortem.yml`. |
| G14 | **No CDN or asset caching** | Higher latency for static assets; unnecessary backend load | Serve frontend assets via CDN (CloudFront, Cloudflare) with cache headers. | Add `Cache-Control` headers for static files in the Docker override `server.js`. Configure a CDN. |
| G15 | **Temp file cleanup gap** | Orphaned CSV files accumulate if downloads fail mid-transfer | Add a periodic cleanup job for stale temp files. | Add `setInterval` or cron: `find /app/temp -mmin +60 -delete`. |
| G16 | **No feature flags** | All-or-nothing deploys; no ability to safely roll out changes | Integrate a feature flag service (LaunchDarkly, Unleash, or simple env-based flags). | Start with environment-variable flags for critical features. |
| G17 | **Unused JWT dependency** | `jsonwebtoken` is installed but not used; confusing for maintainers | Either implement JWT-based auth (recommended, see G2) or remove the dependency. | If implementing G2, use it. Otherwise: `npm uninstall jsonwebtoken`. |
| G18 | **Docker Compose missing** | No declarative multi-service definition; deployment requires manual Docker commands | Create `docker-compose.yml` with service definitions, volume mounts, resource limits, and restart policies. | Add `docker-compose.yml` at repo root. |

---

## 5. Prioritized Action Plan

### Phase 1 — Critical (Week 1–2)

| # | Action | Owner | Effort |
|---|---|---|---|
| 1 | Add graceful shutdown handler (G1) | Backend team | 1 day |
| 2 | Implement JWT auth or SSO integration (G2) | Backend team | 3–5 days |
| 3 | Add TLS termination via reverse proxy (G3) | Platform/SRE | 1 day |
| 4 | Set up automated SQLite backups (G4) | Platform/SRE | 1 day |
| 5 | Add structured logging with pino (G5) | Backend team | 2 days |

### Phase 2 — High Priority (Week 3–4)

| # | Action | Owner | Effort |
|---|---|---|---|
| 6 | Create `docker-compose.yml` with resource limits and restart policy (G18, G9) | Platform/SRE | 1 day |
| 7 | Add Prometheus metrics + `/metrics` endpoint (G5) | Backend team | 2 days |
| 8 | Build CD pipeline for automated Docker deploy (G6) | Platform/SRE | 2 days |
| 9 | Define SLOs and configure alerting (G7) | SRE | 2 days |
| 10 | Add server-side request timeouts (G10) | Backend team | 0.5 day |

### Phase 3 — Medium Priority (Week 5–8)

| # | Action | Owner | Effort |
|---|---|---|---|
| 11 | Adopt versioned database migrations (G8) | Backend team | 3 days |
| 12 | Create load test scripts (G11) | QA/SRE | 2 days |
| 13 | Set up on-call rotation and integrate with alerting (G12) | SRE | 1 day |
| 14 | Create postmortem template (G13) | SRE | 0.5 day |
| 15 | Add CDN and cache headers for static assets (G14) | Platform/SRE | 1 day |
| 16 | Add temp file cleanup cron (G15) | Backend team | 0.5 day |

### Phase 4 — Long-Term (Quarter+)

| # | Action | Owner | Effort |
|---|---|---|---|
| 17 | Evaluate migration from SQLite to PostgreSQL for horizontal scaling (G9) | Architecture | 2–4 weeks |
| 18 | Implement feature flags (G16) | Backend team | 1 week |
| 19 | Add distributed tracing (OpenTelemetry) | Platform/SRE | 1 week |
| 20 | Define and test DR plan with RTO/RPO targets (DR1–DR3) | SRE | 1 week |

---

## 6. Maturity Scorecard

| SRE Domain | Current Score (1–5) | Target Score | Key Blocker |
|---|---|---|---|
| **Reliability & Availability** | 2 | 4 | No graceful shutdown, no redundancy |
| **Observability** | 1 | 4 | No metrics, no structured logging, no alerting |
| **Security** | 3 | 4 | Weak auth, no TLS |
| **CI/CD & Change Management** | 3 | 4 | No CD pipeline, no migrations |
| **Data Management & Backup** | 1 | 4 | No backups, no retention policy |
| **Scalability & Performance** | 1 | 3 | SQLite single-writer, no load tests |
| **Incident Management** | 3 | 4 | No on-call, no postmortem process |
| **Disaster Recovery** | 1 | 3 | No RTO/RPO, no DR plan |
| **Overall** | **2.0** | **3.8** | — |

### Scoring Guide

| Score | Level | Description |
|---|---|---|
| 1 | Initial | Ad-hoc, no processes |
| 2 | Managed | Basic processes, significant gaps |
| 3 | Defined | Documented processes, some automation |
| 4 | Measured | Metrics-driven, automated, proactive |
| 5 | Optimized | Continuous improvement, chaos engineering, full automation |

---

*This assessment was generated by analyzing the full application source code, Dockerfile, CI/CD workflows, environment configurations, and deployment documentation. Re-assess after completing Phase 1–2 of the action plan.*
