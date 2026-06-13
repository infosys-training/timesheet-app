#!/usr/bin/env bash
# healthcheck.sh — Verify all critical endpoints of the Timesheet application.
#
# Usage:
#   ./scripts/healthcheck.sh                      # defaults: backend=3001, frontend=5173
#   ./scripts/healthcheck.sh --backend-port 3001 --frontend-port 5173
#   BACKEND_PORT=8080 FRONTEND_PORT=3000 ./scripts/healthcheck.sh
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BACKEND_PORT="${BACKEND_PORT:-3001}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend-port)  BACKEND_PORT="$2"; shift 2 ;;
    --frontend-port) FRONTEND_PORT="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [--backend-port PORT] [--frontend-port PORT]"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

BACKEND_URL="http://localhost:${BACKEND_PORT}"
FRONTEND_URL="http://localhost:${FRONTEND_PORT}"
TEST_EMAIL="healthcheck-$(date +%s)@test.example.com"

PASS=0
FAIL=0
SKIP=0
RESULTS=()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

check_pass() {
  PASS=$((PASS + 1))
  RESULTS+=("${GREEN}PASS${NC}  $1")
  echo -e "  ${GREEN}PASS${NC}  $1"
}

check_fail() {
  FAIL=$((FAIL + 1))
  RESULTS+=("${RED}FAIL${NC}  $1  —  $2")
  echo -e "  ${RED}FAIL${NC}  $1  —  $2"
}

check_skip() {
  SKIP=$((SKIP + 1))
  RESULTS+=("${YELLOW}SKIP${NC}  $1  —  $2")
  echo -e "  ${YELLOW}SKIP${NC}  $1  —  $2"
}

separator() {
  echo -e "\n${CYAN}── $1 ──${NC}"
}

# ---------------------------------------------------------------------------
# 1. Backend Health Endpoint
# ---------------------------------------------------------------------------
separator "Backend Health"

HTTP_CODE=$(curl -s -o /tmp/hc_health.json -w "%{http_code}" "${BACKEND_URL}/health" 2>/dev/null) || true
if [[ "$HTTP_CODE" == "200" ]]; then
  STATUS=$(cat /tmp/hc_health.json | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [[ "$STATUS" == "OK" ]]; then
    check_pass "GET /health — status OK"
  else
    check_fail "GET /health — unexpected status" "status=$STATUS"
  fi
else
  check_fail "GET /health" "HTTP $HTTP_CODE (backend may be down)"
fi

# ---------------------------------------------------------------------------
# 2. 404 Handler
# ---------------------------------------------------------------------------
separator "404 Handler"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BACKEND_URL}/nonexistent-route" 2>/dev/null) || true
if [[ "$HTTP_CODE" == "404" ]]; then
  check_pass "GET /nonexistent-route — returns 404"
else
  check_fail "GET /nonexistent-route" "expected 404, got HTTP $HTTP_CODE"
fi

# ---------------------------------------------------------------------------
# 3. Authentication Endpoints
# ---------------------------------------------------------------------------
separator "Authentication"

# POST /api/auth/login — valid email
HTTP_CODE=$(curl -s -o /tmp/hc_login.json -w "%{http_code}" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\": \"${TEST_EMAIL}\"}" \
  "${BACKEND_URL}/api/auth/login" 2>/dev/null) || true
if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "201" ]]; then
  check_pass "POST /api/auth/login — user created/logged in (HTTP $HTTP_CODE)"
else
  check_fail "POST /api/auth/login" "HTTP $HTTP_CODE"
fi

# POST /api/auth/login — invalid email
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST -H "Content-Type: application/json" \
  -d '{"email": "not-an-email"}' \
  "${BACKEND_URL}/api/auth/login" 2>/dev/null) || true
if [[ "$HTTP_CODE" == "400" ]]; then
  check_pass "POST /api/auth/login (invalid email) — returns 400"
else
  check_fail "POST /api/auth/login (invalid email)" "expected 400, got HTTP $HTTP_CODE"
fi

# GET /api/auth/me — with valid header
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BACKEND_URL}/api/auth/me" 2>/dev/null) || true
if [[ "$HTTP_CODE" == "200" ]]; then
  check_pass "GET /api/auth/me — returns user info"
else
  check_fail "GET /api/auth/me" "HTTP $HTTP_CODE"
fi

# GET /api/auth/me — without header (should 401)
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  "${BACKEND_URL}/api/auth/me" 2>/dev/null) || true
if [[ "$HTTP_CODE" == "401" ]]; then
  check_pass "GET /api/auth/me (no auth) — returns 401"
else
  check_fail "GET /api/auth/me (no auth)" "expected 401, got HTTP $HTTP_CODE"
fi

# ---------------------------------------------------------------------------
# 4. Client CRUD Endpoints
# ---------------------------------------------------------------------------
separator "Clients API"

# GET /api/clients — list (empty initially)
HTTP_CODE=$(curl -s -o /tmp/hc_clients.json -w "%{http_code}" \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BACKEND_URL}/api/clients" 2>/dev/null) || true
if [[ "$HTTP_CODE" == "200" ]]; then
  check_pass "GET /api/clients — list clients"
else
  check_fail "GET /api/clients" "HTTP $HTTP_CODE"
fi

# POST /api/clients — create
HTTP_CODE=$(curl -s -o /tmp/hc_create_client.json -w "%{http_code}" \
  -X POST -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  -d '{"name": "HealthCheck Test Client", "description": "Created by health check script"}' \
  "${BACKEND_URL}/api/clients" 2>/dev/null) || true
if [[ "$HTTP_CODE" == "201" ]]; then
  CLIENT_ID=$(cat /tmp/hc_create_client.json | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  check_pass "POST /api/clients — created client (id=$CLIENT_ID)"
else
  CLIENT_ID=""
  check_fail "POST /api/clients" "HTTP $HTTP_CODE"
fi

# POST /api/clients — validation failure (missing name)
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  -d '{"description": "no name field"}' \
  "${BACKEND_URL}/api/clients" 2>/dev/null) || true
if [[ "$HTTP_CODE" == "400" ]]; then
  check_pass "POST /api/clients (missing name) — returns 400"
else
  check_fail "POST /api/clients (missing name)" "expected 400, got HTTP $HTTP_CODE"
fi

# GET /api/clients/:id
if [[ -n "${CLIENT_ID:-}" ]]; then
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BACKEND_URL}/api/clients/${CLIENT_ID}" 2>/dev/null) || true
  if [[ "$HTTP_CODE" == "200" ]]; then
    check_pass "GET /api/clients/${CLIENT_ID} — get specific client"
  else
    check_fail "GET /api/clients/${CLIENT_ID}" "HTTP $HTTP_CODE"
  fi

  # PUT /api/clients/:id
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PUT -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    -d '{"name": "HealthCheck Updated Client"}' \
    "${BACKEND_URL}/api/clients/${CLIENT_ID}" 2>/dev/null) || true
  if [[ "$HTTP_CODE" == "200" ]]; then
    check_pass "PUT /api/clients/${CLIENT_ID} — update client"
  else
    check_fail "PUT /api/clients/${CLIENT_ID}" "HTTP $HTTP_CODE"
  fi
else
  check_skip "GET /api/clients/:id" "client creation failed"
  check_skip "PUT /api/clients/:id" "client creation failed"
fi

# ---------------------------------------------------------------------------
# 5. Work Entry CRUD Endpoints
# ---------------------------------------------------------------------------
separator "Work Entries API"

if [[ -n "${CLIENT_ID:-}" ]]; then
  # POST /api/work-entries — create
  HTTP_CODE=$(curl -s -o /tmp/hc_create_entry.json -w "%{http_code}" \
    -X POST -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    -d "{\"clientId\": ${CLIENT_ID}, \"hours\": 2.5, \"description\": \"Health check test entry\", \"date\": \"$(date -u +%Y-%m-%d)\"}" \
    "${BACKEND_URL}/api/work-entries" 2>/dev/null) || true
  if [[ "$HTTP_CODE" == "201" ]]; then
    ENTRY_ID=$(cat /tmp/hc_create_entry.json | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
    check_pass "POST /api/work-entries — created entry (id=$ENTRY_ID)"
  else
    ENTRY_ID=""
    check_fail "POST /api/work-entries" "HTTP $HTTP_CODE"
  fi

  # GET /api/work-entries
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BACKEND_URL}/api/work-entries" 2>/dev/null) || true
  if [[ "$HTTP_CODE" == "200" ]]; then
    check_pass "GET /api/work-entries — list entries"
  else
    check_fail "GET /api/work-entries" "HTTP $HTTP_CODE"
  fi

  # GET /api/work-entries?clientId=
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BACKEND_URL}/api/work-entries?clientId=${CLIENT_ID}" 2>/dev/null) || true
  if [[ "$HTTP_CODE" == "200" ]]; then
    check_pass "GET /api/work-entries?clientId=${CLIENT_ID} — filter by client"
  else
    check_fail "GET /api/work-entries?clientId=${CLIENT_ID}" "HTTP $HTTP_CODE"
  fi

  if [[ -n "${ENTRY_ID:-}" ]]; then
    # GET /api/work-entries/:id
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
      -H "x-user-email: ${TEST_EMAIL}" \
      "${BACKEND_URL}/api/work-entries/${ENTRY_ID}" 2>/dev/null) || true
    if [[ "$HTTP_CODE" == "200" ]]; then
      check_pass "GET /api/work-entries/${ENTRY_ID} — get specific entry"
    else
      check_fail "GET /api/work-entries/${ENTRY_ID}" "HTTP $HTTP_CODE"
    fi

    # PUT /api/work-entries/:id
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
      -X PUT -H "Content-Type: application/json" \
      -H "x-user-email: ${TEST_EMAIL}" \
      -d '{"hours": 3.0}' \
      "${BACKEND_URL}/api/work-entries/${ENTRY_ID}" 2>/dev/null) || true
    if [[ "$HTTP_CODE" == "200" ]]; then
      check_pass "PUT /api/work-entries/${ENTRY_ID} — update entry"
    else
      check_fail "PUT /api/work-entries/${ENTRY_ID}" "HTTP $HTTP_CODE"
    fi
  else
    check_skip "GET /api/work-entries/:id" "entry creation failed"
    check_skip "PUT /api/work-entries/:id" "entry creation failed"
  fi
else
  check_skip "POST /api/work-entries" "client creation failed"
  check_skip "GET /api/work-entries" "client creation failed"
  check_skip "GET /api/work-entries?clientId" "client creation failed"
  check_skip "GET /api/work-entries/:id" "client creation failed"
  check_skip "PUT /api/work-entries/:id" "client creation failed"
fi

# ---------------------------------------------------------------------------
# 6. Reports Endpoints
# ---------------------------------------------------------------------------
separator "Reports API"

if [[ -n "${CLIENT_ID:-}" ]]; then
  # GET /api/reports/client/:clientId
  HTTP_CODE=$(curl -s -o /tmp/hc_report.json -w "%{http_code}" \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BACKEND_URL}/api/reports/client/${CLIENT_ID}" 2>/dev/null) || true
  if [[ "$HTTP_CODE" == "200" ]]; then
    check_pass "GET /api/reports/client/${CLIENT_ID} — client report"
  else
    check_fail "GET /api/reports/client/${CLIENT_ID}" "HTTP $HTTP_CODE"
  fi

  # GET /api/reports/export/csv/:clientId
  HTTP_CODE=$(curl -s -o /tmp/hc_export.csv -w "%{http_code}" \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BACKEND_URL}/api/reports/export/csv/${CLIENT_ID}" 2>/dev/null) || true
  if [[ "$HTTP_CODE" == "200" ]]; then
    check_pass "GET /api/reports/export/csv/${CLIENT_ID} — CSV export"
  else
    check_fail "GET /api/reports/export/csv/${CLIENT_ID}" "HTTP $HTTP_CODE"
  fi

  # GET /api/reports/export/pdf/:clientId
  HTTP_CODE=$(curl -s -o /tmp/hc_export.pdf -w "%{http_code}" \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BACKEND_URL}/api/reports/export/pdf/${CLIENT_ID}" 2>/dev/null) || true
  if [[ "$HTTP_CODE" == "200" ]]; then
    check_pass "GET /api/reports/export/pdf/${CLIENT_ID} — PDF export"
  else
    check_fail "GET /api/reports/export/pdf/${CLIENT_ID}" "HTTP $HTTP_CODE"
  fi
else
  check_skip "GET /api/reports/client/:id" "client creation failed"
  check_skip "GET /api/reports/export/csv/:id" "client creation failed"
  check_skip "GET /api/reports/export/pdf/:id" "client creation failed"
fi

# ---------------------------------------------------------------------------
# 7. Cleanup — Delete test data
# ---------------------------------------------------------------------------
separator "Cleanup"

if [[ -n "${ENTRY_ID:-}" ]]; then
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X DELETE -H "x-user-email: ${TEST_EMAIL}" \
    "${BACKEND_URL}/api/work-entries/${ENTRY_ID}" 2>/dev/null) || true
  if [[ "$HTTP_CODE" == "200" ]]; then
    check_pass "DELETE /api/work-entries/${ENTRY_ID} — cleanup entry"
  else
    check_fail "DELETE /api/work-entries/${ENTRY_ID}" "HTTP $HTTP_CODE"
  fi
fi

if [[ -n "${CLIENT_ID:-}" ]]; then
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X DELETE -H "x-user-email: ${TEST_EMAIL}" \
    "${BACKEND_URL}/api/clients/${CLIENT_ID}" 2>/dev/null) || true
  if [[ "$HTTP_CODE" == "200" ]]; then
    check_pass "DELETE /api/clients/${CLIENT_ID} — cleanup client"
  else
    check_fail "DELETE /api/clients/${CLIENT_ID}" "HTTP $HTTP_CODE"
  fi
fi

# Clean up temp files
rm -f /tmp/hc_health.json /tmp/hc_login.json /tmp/hc_clients.json \
      /tmp/hc_create_client.json /tmp/hc_create_entry.json \
      /tmp/hc_report.json /tmp/hc_export.csv /tmp/hc_export.pdf

# ---------------------------------------------------------------------------
# 8. Frontend Check (optional — only if frontend is running)
# ---------------------------------------------------------------------------
separator "Frontend"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${FRONTEND_URL}/" 2>/dev/null) || true
if [[ "$HTTP_CODE" == "200" ]]; then
  check_pass "GET ${FRONTEND_URL}/ — frontend is reachable"
elif [[ "$HTTP_CODE" == "000" ]]; then
  check_skip "Frontend reachability" "frontend not running on port ${FRONTEND_PORT}"
else
  check_fail "GET ${FRONTEND_URL}/" "HTTP $HTTP_CODE"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${CYAN}═══════════════════════════════════════════${NC}"
echo -e "${CYAN}  Health Check Summary${NC}"
echo -e "${CYAN}═══════════════════════════════════════════${NC}"
echo -e "  ${GREEN}Passed:${NC}  $PASS"
echo -e "  ${RED}Failed:${NC}  $FAIL"
echo -e "  ${YELLOW}Skipped:${NC} $SKIP"
echo -e "  Total:   $((PASS + FAIL + SKIP))"
echo -e "${CYAN}═══════════════════════════════════════════${NC}"

if [[ $FAIL -gt 0 ]]; then
  echo -e "\n${RED}Health check FAILED — $FAIL check(s) did not pass.${NC}"
  exit 1
else
  echo -e "\n${GREEN}All checks passed.${NC}"
  exit 0
fi
