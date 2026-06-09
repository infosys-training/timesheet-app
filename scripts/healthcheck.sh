#!/usr/bin/env bash
#
# Health check script for the Timesheet Application
# Tests all critical backend endpoints and reports status.
#
# Usage:
#   ./scripts/healthcheck.sh                    # defaults to http://localhost:3001
#   ./scripts/healthcheck.sh http://prod:3001   # custom base URL
#   HEALTHCHECK_EMAIL=test@example.com ./scripts/healthcheck.sh  # custom test email

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="${HEALTHCHECK_EMAIL:-healthcheck@test.example.com}"
TIMEOUT=10
PASSED=0
FAILED=0
WARNINGS=0

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[1;33m'
  NC='\033[0m'
else
  GREEN=''
  RED=''
  YELLOW=''
  NC=''
fi

pass() {
  echo -e "  ${GREEN}PASS${NC}  $1"
  PASSED=$((PASSED + 1))
}

fail() {
  echo -e "  ${RED}FAIL${NC}  $1"
  [ -n "${2:-}" ] && echo "        $2"
  FAILED=$((FAILED + 1))
}

warn() {
  echo -e "  ${YELLOW}WARN${NC}  $1"
  [ -n "${2:-}" ] && echo "        $2"
  WARNINGS=$((WARNINGS + 1))
}

check_endpoint() {
  local description="$1"
  local method="$2"
  local url="$3"
  local expected_status="$4"
  local data="${5:-}"
  local extra_headers="${6:-}"

  local curl_args=(-s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT")

  if [ -n "$extra_headers" ]; then
    curl_args+=(-H "$extra_headers")
  fi

  if [ "$method" = "POST" ]; then
    curl_args+=(-X POST -H "Content-Type: application/json")
    if [ -n "$data" ]; then
      curl_args+=(-d "$data")
    fi
  elif [ "$method" = "GET" ]; then
    curl_args+=(-X GET)
  fi

  local actual_status
  actual_status=$(curl "${curl_args[@]}" "$url" 2>/dev/null) || actual_status="000"

  if [ "$actual_status" = "000" ]; then
    fail "$description" "Connection refused or timed out"
  elif echo "$expected_status" | grep -qw "$actual_status"; then
    pass "$description (HTTP $actual_status)"
  else
    fail "$description" "Expected HTTP $expected_status, got HTTP $actual_status"
  fi
}

check_endpoint_body() {
  local description="$1"
  local url="$2"
  local expected_body_substring="$3"

  local response
  response=$(curl -s --max-time "$TIMEOUT" "$url" 2>/dev/null) || response=""

  if [ -z "$response" ]; then
    fail "$description" "No response or connection refused"
    return
  fi

  if echo "$response" | grep -q "$expected_body_substring"; then
    pass "$description"
  else
    fail "$description" "Response body missing '$expected_body_substring'"
  fi
}

# ──────────────────────────────────────────────────────────────────────────────
echo ""
echo "=============================================="
echo " Timesheet App Health Check"
echo " Target: $BASE_URL"
echo " Time:   $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "=============================================="
echo ""

# ── 1. Health Endpoint ────────────────────────────────────────────────────────
echo "1. Core Health"
echo "──────────────────────────────────────"
check_endpoint_body "GET /health returns status OK" "$BASE_URL/health" '"status":"OK"'

# ── 2. Authentication Endpoints ───────────────────────────────────────────────
echo ""
echo "2. Authentication"
echo "──────────────────────────────────────"
check_endpoint "POST /api/auth/login (valid email)" \
  POST "$BASE_URL/api/auth/login" "200|201" \
  "{\"email\":\"$TEST_EMAIL\"}"

check_endpoint "POST /api/auth/login (invalid email)" \
  POST "$BASE_URL/api/auth/login" "400" \
  '{"email":"not-an-email"}'

check_endpoint "GET /api/auth/me (authenticated)" \
  GET "$BASE_URL/api/auth/me" "200" \
  "" "x-user-email: $TEST_EMAIL"

check_endpoint "GET /api/auth/me (unauthenticated)" \
  GET "$BASE_URL/api/auth/me" "401"

# ── 3. Client Endpoints ──────────────────────────────────────────────────────
echo ""
echo "3. Client Management"
echo "──────────────────────────────────────"
check_endpoint "GET /api/clients (authenticated)" \
  GET "$BASE_URL/api/clients" "200" \
  "" "x-user-email: $TEST_EMAIL"

check_endpoint "GET /api/clients (unauthenticated)" \
  GET "$BASE_URL/api/clients" "401"

# Create a test client for further checks
CLIENT_RESPONSE=$(curl -s --max-time "$TIMEOUT" -X POST \
  -H "Content-Type: application/json" \
  -H "x-user-email: $TEST_EMAIL" \
  -d '{"name":"HealthCheck Test Client"}' \
  "$BASE_URL/api/clients" 2>/dev/null) || CLIENT_RESPONSE=""

CLIENT_ID=""
if echo "$CLIENT_RESPONSE" | grep -q '"id"'; then
  CLIENT_ID=$(echo "$CLIENT_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  pass "POST /api/clients (create test client, id=$CLIENT_ID)"
else
  warn "POST /api/clients (could not create test client)" "Response: $CLIENT_RESPONSE"
fi

if [ -n "$CLIENT_ID" ]; then
  check_endpoint "GET /api/clients/$CLIENT_ID" \
    GET "$BASE_URL/api/clients/$CLIENT_ID" "200" \
    "" "x-user-email: $TEST_EMAIL"
fi

# ── 4. Work Entry Endpoints ──────────────────────────────────────────────────
echo ""
echo "4. Work Entries"
echo "──────────────────────────────────────"
check_endpoint "GET /api/work-entries (authenticated)" \
  GET "$BASE_URL/api/work-entries" "200" \
  "" "x-user-email: $TEST_EMAIL"

if [ -n "$CLIENT_ID" ]; then
  ENTRY_RESPONSE=$(curl -s --max-time "$TIMEOUT" -X POST \
    -H "Content-Type: application/json" \
    -H "x-user-email: $TEST_EMAIL" \
    -d "{\"clientId\":$CLIENT_ID,\"hours\":1.5,\"description\":\"Health check test\",\"date\":\"$(date -u '+%Y-%m-%d')\"}" \
    "$BASE_URL/api/work-entries" 2>/dev/null) || ENTRY_RESPONSE=""

  ENTRY_ID=""
  if echo "$ENTRY_RESPONSE" | grep -q '"id"'; then
    ENTRY_ID=$(echo "$ENTRY_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
    pass "POST /api/work-entries (create test entry, id=$ENTRY_ID)"
  else
    warn "POST /api/work-entries (could not create test entry)" "Response: $ENTRY_RESPONSE"
  fi
fi

# ── 5. Report Endpoints ──────────────────────────────────────────────────────
echo ""
echo "5. Reports & Exports"
echo "──────────────────────────────────────"
if [ -n "$CLIENT_ID" ]; then
  check_endpoint "GET /api/reports/client/$CLIENT_ID (JSON report)" \
    GET "$BASE_URL/api/reports/client/$CLIENT_ID" "200" \
    "" "x-user-email: $TEST_EMAIL"

  check_endpoint "GET /api/reports/export/csv/$CLIENT_ID (CSV export)" \
    GET "$BASE_URL/api/reports/export/csv/$CLIENT_ID" "200" \
    "" "x-user-email: $TEST_EMAIL"

  check_endpoint "GET /api/reports/export/pdf/$CLIENT_ID (PDF export)" \
    GET "$BASE_URL/api/reports/export/pdf/$CLIENT_ID" "200" \
    "" "x-user-email: $TEST_EMAIL"
else
  warn "Skipping report endpoint checks (no test client created)"
fi

# ── 6. Error Handling ────────────────────────────────────────────────────────
echo ""
echo "6. Error Handling"
echo "──────────────────────────────────────"
check_endpoint "GET /nonexistent (404 handler)" \
  GET "$BASE_URL/nonexistent" "404"

check_endpoint "POST /api/clients (validation - missing name)" \
  POST "$BASE_URL/api/clients" "400" \
  '{}' "x-user-email: $TEST_EMAIL"

check_endpoint "GET /api/clients/999999 (not found)" \
  GET "$BASE_URL/api/clients/999999" "404" \
  "" "x-user-email: $TEST_EMAIL"

# ── 7. Cleanup ───────────────────────────────────────────────────────────────
echo ""
echo "7. Cleanup"
echo "──────────────────────────────────────"
if [ -n "${ENTRY_ID:-}" ]; then
  CLEANUP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    -X DELETE -H "x-user-email: $TEST_EMAIL" \
    "$BASE_URL/api/work-entries/$ENTRY_ID" 2>/dev/null) || CLEANUP_STATUS="000"
  if [ "$CLEANUP_STATUS" = "200" ]; then
    pass "Deleted test work entry $ENTRY_ID"
  else
    warn "Could not delete test work entry $ENTRY_ID (HTTP $CLEANUP_STATUS)"
  fi
fi

if [ -n "${CLIENT_ID:-}" ]; then
  CLEANUP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    -X DELETE -H "x-user-email: $TEST_EMAIL" \
    "$BASE_URL/api/clients/$CLIENT_ID" 2>/dev/null) || CLEANUP_STATUS="000"
  if [ "$CLEANUP_STATUS" = "200" ]; then
    pass "Deleted test client $CLIENT_ID"
  else
    warn "Could not delete test client $CLIENT_ID (HTTP $CLEANUP_STATUS)"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "=============================================="
echo " Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}, ${YELLOW}${WARNINGS} warnings${NC}"
echo "=============================================="
echo ""

if [ "$FAILED" -gt 0 ]; then
  echo -e "${RED}Health check FAILED — $FAILED check(s) did not pass.${NC}"
  exit 1
elif [ "$WARNINGS" -gt 0 ]; then
  echo -e "${YELLOW}Health check PASSED with warnings.${NC}"
  exit 0
else
  echo -e "${GREEN}All health checks PASSED.${NC}"
  exit 0
fi
