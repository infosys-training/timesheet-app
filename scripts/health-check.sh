#!/usr/bin/env bash
#
# health-check.sh — Verify all critical timesheet-app endpoints are operational.
#
# Usage:
#   ./scripts/health-check.sh                  # defaults: backend=localhost:3001, frontend=localhost:5173
#   ./scripts/health-check.sh -b http://api.example.com -f http://app.example.com
#   ./scripts/health-check.sh --backend-only   # skip frontend checks
#   ./scripts/health-check.sh --no-color       # disable colored output
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
BACKEND_URL="${BACKEND_URL:-http://localhost:3001}"
FRONTEND_URL="${FRONTEND_URL:-http://localhost:5173}"
TIMEOUT=5
TEST_EMAIL="healthcheck@timesheet-app.example.com"
SKIP_FRONTEND=false
NO_COLOR=false

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -b|--backend)  BACKEND_URL="$2"; shift 2 ;;
    -f|--frontend) FRONTEND_URL="$2"; shift 2 ;;
    -t|--timeout)  TIMEOUT="$2"; shift 2 ;;
    --backend-only) SKIP_FRONTEND=true; shift ;;
    --no-color)    NO_COLOR=true; shift ;;
    -h|--help)
      echo "Usage: $0 [-b BACKEND_URL] [-f FRONTEND_URL] [-t TIMEOUT] [--backend-only] [--no-color]"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
if [[ "$NO_COLOR" == "true" ]] || [[ ! -t 1 ]]; then
  GREEN="" RED="" YELLOW="" RESET="" BOLD=""
else
  GREEN="\033[0;32m" RED="\033[0;31m" YELLOW="\033[0;33m" RESET="\033[0m" BOLD="\033[1m"
fi

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------
PASS=0
FAIL=0
WARN=0
CREATED_CLIENT_ID=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
check_pass() {
  PASS=$((PASS + 1))
  printf "  ${GREEN}PASS${RESET}  %s\n" "$1"
}

check_fail() {
  FAIL=$((FAIL + 1))
  printf "  ${RED}FAIL${RESET}  %s\n" "$1"
  if [[ -n "${2:-}" ]]; then
    printf "        %s\n" "$2"
  fi
}

check_warn() {
  WARN=$((WARN + 1))
  printf "  ${YELLOW}WARN${RESET}  %s\n" "$1"
}

section() {
  printf "\n${BOLD}=== %s ===${RESET}\n" "$1"
}

# ---------------------------------------------------------------------------
# 1. Health endpoint
# ---------------------------------------------------------------------------
section "Health Check Endpoint"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "${BACKEND_URL}/health" 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" == "200" ]]; then
  check_pass "GET /health — HTTP $HTTP_CODE"
else
  check_fail "GET /health — HTTP $HTTP_CODE" "Backend may be down at ${BACKEND_URL}"
fi

# ---------------------------------------------------------------------------
# 2. Authentication endpoints
# ---------------------------------------------------------------------------
section "Authentication"

# POST /api/auth/login
LOGIN_RESP=$(curl -s -w "\n%{http_code}" --max-time "$TIMEOUT" \
  -X POST "${BACKEND_URL}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${TEST_EMAIL}\"}" 2>/dev/null || echo -e "\n000")
LOGIN_BODY=$(echo "$LOGIN_RESP" | head -n -1)
LOGIN_CODE=$(echo "$LOGIN_RESP" | tail -n 1)

if [[ "$LOGIN_CODE" == "200" || "$LOGIN_CODE" == "201" ]]; then
  check_pass "POST /api/auth/login — HTTP $LOGIN_CODE"
else
  check_fail "POST /api/auth/login — HTTP $LOGIN_CODE" "$LOGIN_BODY"
fi

# GET /api/auth/me
ME_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BACKEND_URL}/api/auth/me" 2>/dev/null || echo "000")
if [[ "$ME_CODE" == "200" ]]; then
  check_pass "GET /api/auth/me — HTTP $ME_CODE"
else
  check_fail "GET /api/auth/me — HTTP $ME_CODE"
fi

# Test missing auth header
NOAUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
  "${BACKEND_URL}/api/auth/me" 2>/dev/null || echo "000")
if [[ "$NOAUTH_CODE" == "401" ]]; then
  check_pass "GET /api/auth/me (no header) — HTTP $NOAUTH_CODE (expected 401)"
else
  check_fail "GET /api/auth/me (no header) — HTTP $NOAUTH_CODE (expected 401)"
fi

# ---------------------------------------------------------------------------
# 3. Client CRUD
# ---------------------------------------------------------------------------
section "Client Endpoints"

# POST /api/clients — create test client
CREATE_RESP=$(curl -s -w "\n%{http_code}" --max-time "$TIMEOUT" \
  -X POST "${BACKEND_URL}/api/clients" \
  -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  -d '{"name":"HealthCheck Test Client","description":"Created by health-check script"}' 2>/dev/null || echo -e "\n000")
CREATE_BODY=$(echo "$CREATE_RESP" | head -n -1)
CREATE_CODE=$(echo "$CREATE_RESP" | tail -n 1)

if [[ "$CREATE_CODE" == "201" ]]; then
  check_pass "POST /api/clients — HTTP $CREATE_CODE"
  CREATED_CLIENT_ID=$(echo "$CREATE_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
else
  check_fail "POST /api/clients — HTTP $CREATE_CODE" "$CREATE_BODY"
fi

# GET /api/clients
CLIENTS_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BACKEND_URL}/api/clients" 2>/dev/null || echo "000")
if [[ "$CLIENTS_CODE" == "200" ]]; then
  check_pass "GET /api/clients — HTTP $CLIENTS_CODE"
else
  check_fail "GET /api/clients — HTTP $CLIENTS_CODE"
fi

# GET /api/clients/:id
if [[ -n "$CREATED_CLIENT_ID" ]]; then
  CLIENT_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BACKEND_URL}/api/clients/${CREATED_CLIENT_ID}" 2>/dev/null || echo "000")
  if [[ "$CLIENT_CODE" == "200" ]]; then
    check_pass "GET /api/clients/${CREATED_CLIENT_ID} — HTTP $CLIENT_CODE"
  else
    check_fail "GET /api/clients/${CREATED_CLIENT_ID} — HTTP $CLIENT_CODE"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Work Entry CRUD
# ---------------------------------------------------------------------------
section "Work Entry Endpoints"

CREATED_ENTRY_ID=""
if [[ -n "$CREATED_CLIENT_ID" ]]; then
  # POST /api/work-entries
  TODAY=$(date +%Y-%m-%d)
  ENTRY_RESP=$(curl -s -w "\n%{http_code}" --max-time "$TIMEOUT" \
    -X POST "${BACKEND_URL}/api/work-entries" \
    -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    -d "{\"clientId\":${CREATED_CLIENT_ID},\"hours\":1.5,\"description\":\"Health check test entry\",\"date\":\"${TODAY}\"}" 2>/dev/null || echo -e "\n000")
  ENTRY_BODY=$(echo "$ENTRY_RESP" | head -n -1)
  ENTRY_CODE=$(echo "$ENTRY_RESP" | tail -n 1)

  if [[ "$ENTRY_CODE" == "201" ]]; then
    check_pass "POST /api/work-entries — HTTP $ENTRY_CODE"
    CREATED_ENTRY_ID=$(echo "$ENTRY_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  else
    check_fail "POST /api/work-entries — HTTP $ENTRY_CODE" "$ENTRY_BODY"
  fi
else
  check_warn "POST /api/work-entries — skipped (no test client)"
fi

# GET /api/work-entries
ENTRIES_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BACKEND_URL}/api/work-entries" 2>/dev/null || echo "000")
if [[ "$ENTRIES_CODE" == "200" ]]; then
  check_pass "GET /api/work-entries — HTTP $ENTRIES_CODE"
else
  check_fail "GET /api/work-entries — HTTP $ENTRIES_CODE"
fi

# ---------------------------------------------------------------------------
# 5. Reports & Exports
# ---------------------------------------------------------------------------
section "Report & Export Endpoints"

if [[ -n "$CREATED_CLIENT_ID" ]]; then
  # GET /api/reports/client/:clientId
  REPORT_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BACKEND_URL}/api/reports/client/${CREATED_CLIENT_ID}" 2>/dev/null || echo "000")
  if [[ "$REPORT_CODE" == "200" ]]; then
    check_pass "GET /api/reports/client/${CREATED_CLIENT_ID} — HTTP $REPORT_CODE"
  else
    check_fail "GET /api/reports/client/${CREATED_CLIENT_ID} — HTTP $REPORT_CODE"
  fi

  # GET /api/reports/export/csv/:clientId
  CSV_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BACKEND_URL}/api/reports/export/csv/${CREATED_CLIENT_ID}" 2>/dev/null || echo "000")
  if [[ "$CSV_CODE" == "200" ]]; then
    check_pass "GET /api/reports/export/csv/${CREATED_CLIENT_ID} — HTTP $CSV_CODE"
  else
    check_fail "GET /api/reports/export/csv/${CREATED_CLIENT_ID} — HTTP $CSV_CODE"
  fi

  # GET /api/reports/export/pdf/:clientId
  PDF_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BACKEND_URL}/api/reports/export/pdf/${CREATED_CLIENT_ID}" 2>/dev/null || echo "000")
  if [[ "$PDF_CODE" == "200" ]]; then
    check_pass "GET /api/reports/export/pdf/${CREATED_CLIENT_ID} — HTTP $PDF_CODE"
  else
    check_fail "GET /api/reports/export/pdf/${CREATED_CLIENT_ID} — HTTP $PDF_CODE"
  fi
else
  check_warn "Report endpoints — skipped (no test client)"
fi

# ---------------------------------------------------------------------------
# 6. Error handling verification
# ---------------------------------------------------------------------------
section "Error Handling"

# 404 for unknown route
NOT_FOUND_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
  "${BACKEND_URL}/api/nonexistent" 2>/dev/null || echo "000")
if [[ "$NOT_FOUND_CODE" == "404" ]]; then
  check_pass "GET /api/nonexistent — HTTP $NOT_FOUND_CODE (expected 404)"
else
  check_fail "GET /api/nonexistent — HTTP $NOT_FOUND_CODE (expected 404)"
fi

# Validation error
VALIDATION_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
  -X POST "${BACKEND_URL}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"not-an-email"}' 2>/dev/null || echo "000")
if [[ "$VALIDATION_CODE" == "400" ]]; then
  check_pass "POST /api/auth/login (invalid email) — HTTP $VALIDATION_CODE (expected 400)"
else
  check_fail "POST /api/auth/login (invalid email) — HTTP $VALIDATION_CODE (expected 400)"
fi

# ---------------------------------------------------------------------------
# 7. Cleanup test data
# ---------------------------------------------------------------------------
section "Cleanup"

if [[ -n "${CREATED_ENTRY_ID:-}" ]]; then
  DEL_ENTRY_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    -X DELETE \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BACKEND_URL}/api/work-entries/${CREATED_ENTRY_ID}" 2>/dev/null || echo "000")
  if [[ "$DEL_ENTRY_CODE" == "200" ]]; then
    check_pass "DELETE /api/work-entries/${CREATED_ENTRY_ID} — HTTP $DEL_ENTRY_CODE"
  else
    check_warn "DELETE /api/work-entries/${CREATED_ENTRY_ID} — HTTP $DEL_ENTRY_CODE (cleanup)"
  fi
fi

if [[ -n "${CREATED_CLIENT_ID:-}" ]]; then
  DEL_CLIENT_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    -X DELETE \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BACKEND_URL}/api/clients/${CREATED_CLIENT_ID}" 2>/dev/null || echo "000")
  if [[ "$DEL_CLIENT_CODE" == "200" ]]; then
    check_pass "DELETE /api/clients/${CREATED_CLIENT_ID} — HTTP $DEL_CLIENT_CODE"
  else
    check_warn "DELETE /api/clients/${CREATED_CLIENT_ID} — HTTP $DEL_CLIENT_CODE (cleanup)"
  fi
fi

# ---------------------------------------------------------------------------
# 8. Frontend (optional)
# ---------------------------------------------------------------------------
if [[ "$SKIP_FRONTEND" == "false" ]]; then
  section "Frontend"

  FE_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    "${FRONTEND_URL}" 2>/dev/null || echo "000")
  if [[ "$FE_CODE" == "200" ]]; then
    check_pass "GET ${FRONTEND_URL} — HTTP $FE_CODE"
  else
    check_warn "GET ${FRONTEND_URL} — HTTP $FE_CODE (frontend may not be running)"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
section "Summary"
TOTAL=$((PASS + FAIL + WARN))
printf "  Total: %d  |  ${GREEN}Passed: %d${RESET}  |  ${RED}Failed: %d${RESET}  |  ${YELLOW}Warnings: %d${RESET}\n" \
  "$TOTAL" "$PASS" "$FAIL" "$WARN"

if [[ "$FAIL" -gt 0 ]]; then
  printf "\n${RED}${BOLD}RESULT: UNHEALTHY — %d check(s) failed${RESET}\n" "$FAIL"
  exit 1
else
  printf "\n${GREEN}${BOLD}RESULT: HEALTHY — all checks passed${RESET}\n"
  exit 0
fi
