#!/usr/bin/env bash
# ------------------------------------------------------------------
# Timesheet App — Health Check Script
#
# Tests all critical backend endpoints and reports pass/fail status.
# Designed to be run manually, from cron, or by a monitoring system.
#
# Usage:
#   ./scripts/healthcheck.sh                    # defaults: localhost:3001
#   ./scripts/healthcheck.sh https://api.example.com
#   BACKEND_URL=http://host:3001 ./scripts/healthcheck.sh
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed
# ------------------------------------------------------------------

set -euo pipefail

BACKEND_URL="${1:-${BACKEND_URL:-http://localhost:3001}}"
FRONTEND_URL="${FRONTEND_URL:-http://localhost:5173}"
TEST_EMAIL="healthcheck@timesheet-app.local"
TIMEOUT=10    # seconds per request
PASSED=0
FAILED=0
WARNINGS=0

# Colors (disabled when stdout is not a terminal)
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  GREEN='' RED='' YELLOW='' BOLD='' NC=''
fi

# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

log_pass() {
  PASSED=$((PASSED + 1))
  echo -e "  ${GREEN}PASS${NC}  $1"
}

log_fail() {
  FAILED=$((FAILED + 1))
  echo -e "  ${RED}FAIL${NC}  $1"
  [ -n "${2:-}" ] && echo -e "        → $2"
}

log_warn() {
  WARNINGS=$((WARNINGS + 1))
  echo -e "  ${YELLOW}WARN${NC}  $1"
  [ -n "${2:-}" ] && echo -e "        → $2"
}

# check_endpoint URL EXPECTED_STATUS DESCRIPTION [EXTRA_CURL_ARGS...]
check_endpoint() {
  local url="$1" expected="$2" desc="$3"
  shift 3
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$@" "$url" 2>/dev/null) || status="000"

  if [ "$status" = "$expected" ]; then
    log_pass "$desc (HTTP $status)"
  else
    log_fail "$desc" "expected HTTP $expected, got HTTP $status"
  fi
}

# check_json_field URL FIELD DESCRIPTION [EXTRA_CURL_ARGS...]
check_json_field() {
  local url="$1" field="$2" desc="$3"
  shift 3
  local body
  body=$(curl -s --max-time "$TIMEOUT" "$@" "$url" 2>/dev/null) || body=""

  if echo "$body" | grep -q "\"$field\""; then
    log_pass "$desc"
  else
    log_fail "$desc" "response missing field '$field'"
  fi
}

# ------------------------------------------------------------------
# Header
# ------------------------------------------------------------------

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║      Timesheet App — Health Check Report        ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo "  Backend URL:  $BACKEND_URL"
echo "  Frontend URL: $FRONTEND_URL"
echo "  Timestamp:    $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo ""

# ------------------------------------------------------------------
# 1. Backend Health Endpoint
# ------------------------------------------------------------------

echo -e "${BOLD}── Backend Health ──${NC}"

check_endpoint "$BACKEND_URL/health" "200" "GET /health returns 200"
check_json_field "$BACKEND_URL/health" "status" "GET /health has 'status' field"

# Measure response time
HEALTH_TIME=$(curl -s -o /dev/null -w "%{time_total}" --max-time "$TIMEOUT" "$BACKEND_URL/health" 2>/dev/null) || HEALTH_TIME="N/A"
if [ "$HEALTH_TIME" != "N/A" ]; then
  HEALTH_MS=$(echo "$HEALTH_TIME * 1000" | bc 2>/dev/null | cut -d. -f1)
  if [ "${HEALTH_MS:-0}" -lt 2000 ]; then
    log_pass "Health endpoint response time: ${HEALTH_MS}ms"
  else
    log_warn "Health endpoint slow: ${HEALTH_MS}ms (threshold: 2000ms)"
  fi
fi

echo ""

# ------------------------------------------------------------------
# 2. Authentication Endpoints
# ------------------------------------------------------------------

echo -e "${BOLD}── Authentication ──${NC}"

check_endpoint "$BACKEND_URL/api/auth/login" "200" \
  "POST /api/auth/login accepts valid email" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\"}"

check_endpoint "$BACKEND_URL/api/auth/login" "400" \
  "POST /api/auth/login rejects invalid email" \
  -X POST -H "Content-Type: application/json" \
  -d '{"email":"not-an-email"}'

check_endpoint "$BACKEND_URL/api/auth/me" "401" \
  "GET /api/auth/me returns 401 without header"

check_endpoint "$BACKEND_URL/api/auth/me" "200" \
  "GET /api/auth/me returns 200 with valid header" \
  -H "x-user-email: $TEST_EMAIL"

echo ""

# ------------------------------------------------------------------
# 3. Client CRUD Endpoints
# ------------------------------------------------------------------

echo -e "${BOLD}── Client Endpoints ──${NC}"

check_endpoint "$BACKEND_URL/api/clients" "200" \
  "GET /api/clients returns 200" \
  -H "x-user-email: $TEST_EMAIL"

# Create a test client
CLIENT_RESPONSE=$(curl -s --max-time "$TIMEOUT" \
  -X POST "$BACKEND_URL/api/clients" \
  -H "Content-Type: application/json" \
  -H "x-user-email: $TEST_EMAIL" \
  -d '{"name":"HealthCheck Test Client","description":"Created by healthcheck script"}' 2>/dev/null) || CLIENT_RESPONSE=""

CLIENT_ID=$(echo "$CLIENT_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

if [ -n "$CLIENT_ID" ]; then
  log_pass "POST /api/clients creates client (id=$CLIENT_ID)"

  check_endpoint "$BACKEND_URL/api/clients/$CLIENT_ID" "200" \
    "GET /api/clients/:id returns 200" \
    -H "x-user-email: $TEST_EMAIL"

  check_endpoint "$BACKEND_URL/api/clients/$CLIENT_ID" "200" \
    "PUT /api/clients/:id updates client" \
    -X PUT -H "Content-Type: application/json" \
    -H "x-user-email: $TEST_EMAIL" \
    -d '{"name":"HealthCheck Updated Client"}'
else
  log_fail "POST /api/clients" "failed to create test client"
fi

echo ""

# ------------------------------------------------------------------
# 4. Work Entry Endpoints
# ------------------------------------------------------------------

echo -e "${BOLD}── Work Entry Endpoints ──${NC}"

check_endpoint "$BACKEND_URL/api/work-entries" "200" \
  "GET /api/work-entries returns 200" \
  -H "x-user-email: $TEST_EMAIL"

if [ -n "$CLIENT_ID" ]; then
  ENTRY_RESPONSE=$(curl -s --max-time "$TIMEOUT" \
    -X POST "$BACKEND_URL/api/work-entries" \
    -H "Content-Type: application/json" \
    -H "x-user-email: $TEST_EMAIL" \
    -d "{\"clientId\":$CLIENT_ID,\"hours\":1.5,\"description\":\"Health check test entry\",\"date\":\"$(date -u '+%Y-%m-%d')\"}" 2>/dev/null) || ENTRY_RESPONSE=""

  ENTRY_ID=$(echo "$ENTRY_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

  if [ -n "$ENTRY_ID" ]; then
    log_pass "POST /api/work-entries creates entry (id=$ENTRY_ID)"

    check_endpoint "$BACKEND_URL/api/work-entries/$ENTRY_ID" "200" \
      "GET /api/work-entries/:id returns 200" \
      -H "x-user-email: $TEST_EMAIL"
  else
    log_fail "POST /api/work-entries" "failed to create test entry"
  fi
fi

echo ""

# ------------------------------------------------------------------
# 5. Report Endpoints
# ------------------------------------------------------------------

echo -e "${BOLD}── Report Endpoints ──${NC}"

if [ -n "$CLIENT_ID" ]; then
  check_endpoint "$BACKEND_URL/api/reports/client/$CLIENT_ID" "200" \
    "GET /api/reports/client/:id returns 200" \
    -H "x-user-email: $TEST_EMAIL"

  check_json_field "$BACKEND_URL/api/reports/client/$CLIENT_ID" "totalHours" \
    "Report response includes totalHours field" \
    -H "x-user-email: $TEST_EMAIL"

  # CSV export
  CSV_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    -H "x-user-email: $TEST_EMAIL" \
    "$BACKEND_URL/api/reports/export/csv/$CLIENT_ID" 2>/dev/null) || CSV_STATUS="000"
  if [ "$CSV_STATUS" = "200" ]; then
    log_pass "GET /api/reports/export/csv/:id returns 200"
  else
    log_warn "CSV export returned HTTP $CSV_STATUS (may require entries)" "non-critical"
  fi

  # PDF export
  PDF_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    -H "x-user-email: $TEST_EMAIL" \
    "$BACKEND_URL/api/reports/export/pdf/$CLIENT_ID" 2>/dev/null) || PDF_STATUS="000"
  if [ "$PDF_STATUS" = "200" ]; then
    log_pass "GET /api/reports/export/pdf/:id returns 200"
  else
    log_warn "PDF export returned HTTP $PDF_STATUS (may require entries)" "non-critical"
  fi
else
  log_warn "Skipping report tests (no test client created)"
fi

echo ""

# ------------------------------------------------------------------
# 6. Error Handling
# ------------------------------------------------------------------

echo -e "${BOLD}── Error Handling ──${NC}"

check_endpoint "$BACKEND_URL/api/nonexistent" "404" \
  "Unknown route returns 404"

check_endpoint "$BACKEND_URL/api/clients" "401" \
  "Protected route without auth returns 401"

check_endpoint "$BACKEND_URL/api/clients/not-a-number" "400" \
  "Invalid ID format returns 400" \
  -H "x-user-email: $TEST_EMAIL"

echo ""

# ------------------------------------------------------------------
# 7. Cleanup — delete test data
# ------------------------------------------------------------------

echo -e "${BOLD}── Cleanup ──${NC}"

if [ -n "${ENTRY_ID:-}" ]; then
  curl -s -o /dev/null -X DELETE \
    -H "x-user-email: $TEST_EMAIL" \
    "$BACKEND_URL/api/work-entries/$ENTRY_ID" 2>/dev/null
  echo -e "  ${GREEN}OK${NC}    Deleted test work entry ($ENTRY_ID)"
fi

if [ -n "${CLIENT_ID:-}" ]; then
  curl -s -o /dev/null -X DELETE \
    -H "x-user-email: $TEST_EMAIL" \
    "$BACKEND_URL/api/clients/$CLIENT_ID" 2>/dev/null
  echo -e "  ${GREEN}OK${NC}    Deleted test client ($CLIENT_ID)"
fi

echo ""

# ------------------------------------------------------------------
# 8. Frontend Check (optional)
# ------------------------------------------------------------------

echo -e "${BOLD}── Frontend ──${NC}"

FRONTEND_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$FRONTEND_URL" 2>/dev/null) || FRONTEND_STATUS="000"
if [ "$FRONTEND_STATUS" = "200" ]; then
  log_pass "Frontend reachable at $FRONTEND_URL (HTTP $FRONTEND_STATUS)"
else
  log_warn "Frontend not reachable (HTTP $FRONTEND_STATUS)" "may not be running"
fi

echo ""

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------

TOTAL=$((PASSED + FAILED))
echo -e "${BOLD}══════════════════════════════════════════════════${NC}"
echo -e "  ${GREEN}Passed:${NC}   $PASSED"
echo -e "  ${RED}Failed:${NC}   $FAILED"
echo -e "  ${YELLOW}Warnings:${NC} $WARNINGS"
echo -e "  Total:    $TOTAL checks"
echo -e "${BOLD}══════════════════════════════════════════════════${NC}"
echo ""

if [ "$FAILED" -gt 0 ]; then
  echo -e "  ${RED}${BOLD}RESULT: UNHEALTHY${NC} — $FAILED check(s) failed"
  echo "  Refer to RUNBOOK.md for troubleshooting procedures."
  echo ""
  exit 1
else
  echo -e "  ${GREEN}${BOLD}RESULT: HEALTHY${NC} — all checks passed"
  echo ""
  exit 0
fi
