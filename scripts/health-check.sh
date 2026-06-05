#!/usr/bin/env bash
#
# Health check script for the Timesheet application.
# Tests all critical API endpoints and reports pass/fail status.
#
# Usage:
#   ./scripts/health-check.sh [BASE_URL]
#
# Arguments:
#   BASE_URL  Backend URL (default: http://localhost:3001)
#
# Exit codes:
#   0  All checks passed
#   1  One or more checks failed
#
# Examples:
#   ./scripts/health-check.sh
#   ./scripts/health-check.sh http://prod-server:3001

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="healthcheck@timesheet-app.com"
TIMEOUT=10
PASS=0
FAIL=0
TOTAL=0

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  GREEN='' RED='' YELLOW='' BOLD='' NC=''
fi

log_pass() {
  PASS=$((PASS + 1))
  TOTAL=$((TOTAL + 1))
  printf "${GREEN}[PASS]${NC} %s\n" "$1"
}

log_fail() {
  FAIL=$((FAIL + 1))
  TOTAL=$((TOTAL + 1))
  printf "${RED}[FAIL]${NC} %s — %s\n" "$1" "$2"
}

log_header() {
  printf "\n${BOLD}=== %s ===${NC}\n" "$1"
}

check_http() {
  local description="$1"
  local method="$2"
  local url="$3"
  local expected_code="$4"
  shift 4
  local extra_args=("$@")

  local response
  local http_code

  response=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time "$TIMEOUT" \
    -X "$method" \
    "${extra_args[@]}" \
    "$url" 2>&1) || {
    log_fail "$description" "Connection failed (timeout=${TIMEOUT}s)"
    return
  }

  http_code="$response"

  if [ "$http_code" = "$expected_code" ]; then
    log_pass "$description (HTTP $http_code)"
  else
    log_fail "$description" "Expected HTTP $expected_code, got $http_code"
  fi
}

check_json_field() {
  local description="$1"
  local url="$2"
  local field="$3"
  local expected="$4"
  shift 4
  local extra_args=("$@")

  local body
  body=$(curl -s --max-time "$TIMEOUT" "${extra_args[@]}" "$url" 2>&1) || {
    log_fail "$description" "Connection failed"
    return
  }

  local actual
  actual=$(echo "$body" | grep -o "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*: *"//;s/"//')

  if [ "$actual" = "$expected" ]; then
    log_pass "$description ($field=$actual)"
  else
    log_fail "$description" "Expected $field=\"$expected\", got \"$actual\""
  fi
}

# ─── Connectivity ───────────────────────────────────────────────────

log_header "Connectivity"

check_http "Server reachable" "GET" "$BASE_URL/health" "200"

check_json_field "Health status is OK" "$BASE_URL/health" "status" "OK"

# ─── Authentication ─────────────────────────────────────────────────

log_header "Authentication (POST /api/auth/login)"

# Login returns 200 (existing user) or 201 (new user) — both are valid
LOGIN_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  --max-time "$TIMEOUT" \
  -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\"}" 2>&1) || LOGIN_CODE="000"

if [ "$LOGIN_CODE" = "200" ] || [ "$LOGIN_CODE" = "201" ]; then
  log_pass "Login with valid email (HTTP $LOGIN_CODE)"
else
  log_fail "Login with valid email" "Expected HTTP 200 or 201, got $LOGIN_CODE"
fi

check_http "Login rejects missing email" \
  "POST" "$BASE_URL/api/auth/login" "400" \
  -H "Content-Type: application/json" \
  -d "{}"

check_http "GET /api/auth/me with valid header" \
  "GET" "$BASE_URL/api/auth/me" "200" \
  -H "x-user-email: $TEST_EMAIL"

check_http "GET /api/auth/me without header (401)" \
  "GET" "$BASE_URL/api/auth/me" "401"

# ─── Clients API ────────────────────────────────────────────────────

log_header "Clients API (/api/clients)"

check_http "List clients" \
  "GET" "$BASE_URL/api/clients" "200" \
  -H "x-user-email: $TEST_EMAIL"

# Create a test client and capture its ID
CLIENT_RESPONSE=$(curl -s --max-time "$TIMEOUT" \
  -X POST "$BASE_URL/api/clients" \
  -H "Content-Type: application/json" \
  -H "x-user-email: $TEST_EMAIL" \
  -d '{"name":"HealthCheck Test Client"}' 2>&1) || CLIENT_RESPONSE=""

CLIENT_ID=$(echo "$CLIENT_RESPONSE" | grep -o '"id"[[:space:]]*:[[:space:]]*[0-9]*' | head -1 | grep -o '[0-9]*$')

if [ -n "$CLIENT_ID" ]; then
  log_pass "Create client (id=$CLIENT_ID)"

  check_http "Get client by ID" \
    "GET" "$BASE_URL/api/clients/$CLIENT_ID" "200" \
    -H "x-user-email: $TEST_EMAIL"

  check_http "Update client" \
    "PUT" "$BASE_URL/api/clients/$CLIENT_ID" "200" \
    -H "Content-Type: application/json" \
    -H "x-user-email: $TEST_EMAIL" \
    -d '{"name":"HealthCheck Updated Client"}'
else
  log_fail "Create client" "Could not parse client ID from response"
fi

check_http "Clients rejects unauthenticated request" \
  "GET" "$BASE_URL/api/clients" "401"

# ─── Work Entries API ───────────────────────────────────────────────

log_header "Work Entries API (/api/work-entries)"

check_http "List work entries" \
  "GET" "$BASE_URL/api/work-entries" "200" \
  -H "x-user-email: $TEST_EMAIL"

ENTRY_ID=""
if [ -n "$CLIENT_ID" ]; then
  ENTRY_RESPONSE=$(curl -s --max-time "$TIMEOUT" \
    -X POST "$BASE_URL/api/work-entries" \
    -H "Content-Type: application/json" \
    -H "x-user-email: $TEST_EMAIL" \
    -d "{\"clientId\":$CLIENT_ID,\"hours\":1.5,\"description\":\"Health check test\",\"date\":\"2024-01-01\"}" 2>&1) || ENTRY_RESPONSE=""

  ENTRY_ID=$(echo "$ENTRY_RESPONSE" | grep -o '"id"[[:space:]]*:[[:space:]]*[0-9]*' | head -1 | grep -o '[0-9]*$')

  if [ -n "$ENTRY_ID" ]; then
    log_pass "Create work entry (id=$ENTRY_ID)"

    check_http "Get work entry by ID" \
      "GET" "$BASE_URL/api/work-entries/$ENTRY_ID" "200" \
      -H "x-user-email: $TEST_EMAIL"

    check_http "Update work entry" \
      "PUT" "$BASE_URL/api/work-entries/$ENTRY_ID" "200" \
      -H "Content-Type: application/json" \
      -H "x-user-email: $TEST_EMAIL" \
      -d '{"hours":2.0}'
  else
    log_fail "Create work entry" "Could not parse entry ID from response"
  fi
fi

# ─── Reports API ────────────────────────────────────────────────────

log_header "Reports API (/api/reports)"

if [ -n "$CLIENT_ID" ]; then
  check_http "Client report (JSON)" \
    "GET" "$BASE_URL/api/reports/client/$CLIENT_ID" "200" \
    -H "x-user-email: $TEST_EMAIL"

  check_http "Export CSV report" \
    "GET" "$BASE_URL/api/reports/export/csv/$CLIENT_ID" "200" \
    -H "x-user-email: $TEST_EMAIL"

  check_http "Export PDF report" \
    "GET" "$BASE_URL/api/reports/export/pdf/$CLIENT_ID" "200" \
    -H "x-user-email: $TEST_EMAIL"
else
  log_fail "Reports — skipped" "No client ID available from earlier step"
fi

# ─── Error Handling ─────────────────────────────────────────────────

log_header "Error Handling"

check_http "404 for unknown route" \
  "GET" "$BASE_URL/api/nonexistent" "404"

check_http "400 for invalid client ID" \
  "GET" "$BASE_URL/api/clients/notanumber" "400" \
  -H "x-user-email: $TEST_EMAIL"

# ─── Cleanup ────────────────────────────────────────────────────────

log_header "Cleanup"

if [ -n "$ENTRY_ID" ]; then
  check_http "Delete work entry" \
    "DELETE" "$BASE_URL/api/work-entries/$ENTRY_ID" "200" \
    -H "x-user-email: $TEST_EMAIL"
fi

if [ -n "$CLIENT_ID" ]; then
  check_http "Delete client" \
    "DELETE" "$BASE_URL/api/clients/$CLIENT_ID" "200" \
    -H "x-user-email: $TEST_EMAIL"
fi

# ─── Summary ────────────────────────────────────────────────────────

printf "\n${BOLD}=== Summary ===${NC}\n"
printf "Total: %d | ${GREEN}Passed: %d${NC} | ${RED}Failed: %d${NC}\n" "$TOTAL" "$PASS" "$FAIL"
printf "Target: %s\n\n" "$BASE_URL"

if [ "$FAIL" -gt 0 ]; then
  printf "${RED}${BOLD}HEALTH CHECK FAILED${NC} — %d check(s) did not pass.\n" "$FAIL"
  printf "See RUNBOOK.md for diagnosis and resolution procedures.\n"
  exit 1
else
  printf "${GREEN}${BOLD}ALL CHECKS PASSED${NC}\n"
  exit 0
fi
