# Improved Prompt for Incident Response Materials

Below is the **original prompt** alongside a **refined version** with specific improvements annotated.

---

## Original Prompt

> Create incident response materials for timesheet-app:
> (1) Analyze the application to identify common failure modes (database issues, API errors, memory leaks, dependency failures),
> (2) Create a RUNBOOK.md with step-by-step response procedures for each failure mode,
> (3) Add GitHub Issue templates for P1/P2/P3/P4 incidents with fields for impact, timeline, and resolution,
> (4) Create a health check script that tests all critical endpoints.

---

## Improved Prompt

> ### Context
> **Repository:** `infosys-training/timesheet-app`
> **Stack:** Node.js/Express backend, React/TypeScript/Vite frontend, SQLite in-memory database, Docker deployment.
> **Current state:** No incident response procedures, no issue templates, no automated health checks exist today.
>
> ### Task: Create Incident Response Materials
>
> #### 1. Failure Mode Analysis
> Audit the codebase (`backend/src/routes/`, `backend/src/database/`, `backend/src/middleware/`, `frontend/src/api/`) and identify failure modes across these categories:
> - **Database:** In-memory data loss on restart, `SQLITE_BUSY` write contention, schema init failures
> - **API:** Rate limiting (100 req/15 min), CORS misconfiguration, validation storms, auth header (`x-user-email`) failures
> - **Memory/Process:** OOM from large PDF/CSV generation, temp file accumulation in `backend/temp/`, unhandled promise rejections
> - **Dependencies:** `sqlite3` native module compilation, missing `.env` config, Docker build failures
> - **Frontend:** Vite proxy failures, Axios 10s timeout, blank page from build errors
>
> #### 2. RUNBOOK.md
> For **each** failure mode above, write a section containing:
> - Symptoms (what the user/operator sees)
> - Root cause explanation
> - Step-by-step diagnosis commands (runnable `bash` snippets using `curl`, `docker logs`, `ps`, etc.)
> - Immediate mitigation steps
> - Long-term prevention recommendations
>
> Include a general triage checklist at the top and an escalation matrix (P1 → ≤15 min, P2 → ≤1 hr, P3 → ≤4 hr, P4 → next business day).
>
> #### 3. GitHub Issue Templates (`.github/ISSUE_TEMPLATE/`)
> Create **YAML-based** form templates (not Markdown) for P1 through P4 incidents:
> - **P1 — Critical:** Full outage, data loss, security breach
> - **P2 — Major:** Partial outage, auth broken, reports failing
> - **P3 — Minor:** Slow responses, intermittent errors
> - **P4 — Low:** Cosmetic issues, log noise, docs gaps
>
> Each template must include: severity-specific labels, failure category dropdown (values matching RUNBOOK sections), impact assessment, timeline, symptoms/evidence textarea, resolution section, and follow-up action items.
>
> Also add a `config.yml` that disables blank issues and links to the RUNBOOK.
>
> #### 4. Health Check Script (`scripts/healthcheck.sh`)
> Write a Bash script that:
> - Accepts `BACKEND_URL` and `FRONTEND_URL` as env vars or CLI args (default: `localhost:3001` / `localhost:5173`)
> - Tests: `/health` endpoint, all auth flows (valid/invalid email, missing header), client CRUD, work entry CRUD, report generation (JSON/CSV/PDF), 404 handling, and frontend reachability
> - Creates test data, validates responses, then **cleans up** test data afterward
> - Outputs a color-coded pass/fail summary with response times
> - Exits `0` on all-pass, `1` on any failure (for CI/monitoring integration)
>
> #### Constraints
> - Do not modify existing application code.
> - Ensure the health check script is idempotent (clean up its own test data).
> - All issue template dropdowns should reference RUNBOOK section names for traceability.

---

## What Changed and Why

| Improvement | Why It Matters |
|---|---|
| **Added explicit context block** (repo, stack, current state) | Eliminates assumptions; the AI knows exactly what it's working with |
| **Listed specific failure modes** instead of generic categories | Prevents shallow analysis; ensures coverage of app-specific issues like `SQLITE_BUSY` and `x-user-email` spoofing |
| **Defined RUNBOOK section structure** (symptoms → root cause → commands → mitigation → prevention) | Produces consistent, actionable documentation instead of free-form prose |
| **Specified YAML form templates** (not Markdown) | GitHub YAML issue forms have structured fields, dropdowns, and validation — much better for incident triage than freeform Markdown |
| **Defined exact health check behavior** (test data lifecycle, exit codes, parameterization) | Script is CI/monitoring-ready out of the box, not just a demo |
| **Added constraints section** | Prevents code modifications and ensures idempotency |
| **Cross-referenced RUNBOOK ↔ templates** | Creates traceability between incident reports and response procedures |
