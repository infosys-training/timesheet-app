#!/usr/bin/env bash
#
# Health check script for the Timesheet application.
# Tests all critical API endpoints and reports pass/fail status.
#
# Usage:
#   ./scripts/health-check.sh [BASE_URL]
#
# Arguments:
#   BASE_URL  The base URL of the backend server (default: http://localhost:3001)
#
# Exit codes:
#   0  All checks passed
#   1  One or more checks failed
#
# Examples:
#   ./scripts/health-check.sh
#   ./scripts/health-check.sh http://production-host:3001

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="healthcheck@timesheet-app.local"
TIMEOUT=10
PASSED=0
FAILED=0
TOTAL=0

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  CYAN='\033[0;36m'
  NC='\033[0m'
else
  GREEN=''
  RED=''
  YELLOW=''
  CYAN=''
  NC=''
fi

log_pass() {
  PASSED=$((PASSED + 1))
  TOTAL=$((TOTAL + 1))
  echo -e "  ${GREEN}PASS${NC}  $1"
}

log_fail() {
  FAILED=$((FAILED + 1))
  TOTAL=$((TOTAL + 1))
  echo -e "  ${RED}FAIL${NC}  $1 - $2"
}

log_section() {
  echo ""
  echo -e "${CYAN}=== $1 ===${NC}"
}

# Helper: make a request and capture HTTP status code and body
do_request() {
  local method="$1"
  local url="$2"
  local data="${3:-}"
  local extra_headers="${4:-}"

  local args=(-s -w '\n%{http_code}' --max-time "$TIMEOUT" -X "$method")
  args+=(-H "Content-Type: application/json")
  args+=(-H "x-user-email: $TEST_EMAIL")

  if [ -n "$extra_headers" ]; then
    args+=(-H "$extra_headers")
  fi

  if [ -n "$data" ]; then
    args+=(-d "$data")
  fi

  local response
  response=$(curl "${args[@]}" "$url" 2>/dev/null) || {
    echo "000"
    return
  }

  local status
  status=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | sed '$d')

  echo "$status"
  echo "$body"
}

check_status() {
  local description="$1"
  local expected="$2"
  local actual="$3"

  if [ "$actual" = "$expected" ]; then
    log_pass "$description (HTTP $actual)"
  else
    log_fail "$description" "expected HTTP $expected, got HTTP $actual"
  fi
}

# ============================================================
echo -e "${CYAN}Timesheet App Health Check${NC}"
echo -e "Target: ${YELLOW}${BASE_URL}${NC}"
echo -e "Time:   $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

# ------------------------------------------------------------
log_section "1. Health Endpoint"

result=$(do_request GET "$BASE_URL/health")
status=$(echo "$result" | head -1)
check_status "GET /health" "200" "$status"

if [ "$status" = "200" ]; then
  body=$(echo "$result" | tail -n +2)
  if echo "$body" | grep -q '"status"'; then
    log_pass "Health response contains status field"
  else
    log_fail "Health response format" "missing 'status' field"
  fi
fi

# ------------------------------------------------------------
log_section "2. Authentication"

result=$(do_request POST "$BASE_URL/api/auth/login" '{"email":"'"$TEST_EMAIL"'"}')
status=$(echo "$result" | head -1)
check_status "POST /api/auth/login" "200" "$status"
# Accept 201 (new user) or 200 (existing user)
if [ "$status" != "200" ] && [ "$status" != "201" ]; then
  # Re-check accepting 201
  if [ "$status" = "201" ]; then
    FAILED=$((FAILED - 1))
    PASSED=$((PASSED + 1))
  fi
fi

result=$(do_request GET "$BASE_URL/api/auth/me")
status=$(echo "$result" | head -1)
check_status "GET /api/auth/me" "200" "$status"

# Test missing auth header
result=$(curl -s -w '\n%{http_code}' --max-time "$TIMEOUT" -X GET "$BASE_URL/api/auth/me" 2>/dev/null) || result="000"
status=$(echo "$result" | tail -1)
check_status "GET /api/auth/me (no auth header -> 401)" "401" "$status"

# ------------------------------------------------------------
log_section "3. Clients API"

# Create a test client
result=$(do_request POST "$BASE_URL/api/clients" '{"name":"HealthCheck Test Client","description":"Created by health check script"}')
status=$(echo "$result" | head -1)

if [ "$status" = "201" ]; then
  log_pass "POST /api/clients - create client (HTTP $status)"
  body=$(echo "$result" | tail -n +2)
  CLIENT_ID=$(echo "$body" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
else
  log_fail "POST /api/clients - create client" "expected HTTP 201, got HTTP $status"
  CLIENT_ID=""
fi

# List clients
result=$(do_request GET "$BASE_URL/api/clients")
status=$(echo "$result" | head -1)
check_status "GET /api/clients - list clients" "200" "$status"

# Get specific client
if [ -n "$CLIENT_ID" ]; then
  result=$(do_request GET "$BASE_URL/api/clients/$CLIENT_ID")
  status=$(echo "$result" | head -1)
  check_status "GET /api/clients/$CLIENT_ID - get client" "200" "$status"

  # Update client
  result=$(do_request PUT "$BASE_URL/api/clients/$CLIENT_ID" '{"name":"HealthCheck Updated Client"}')
  status=$(echo "$result" | head -1)
  check_status "PUT /api/clients/$CLIENT_ID - update client" "200" "$status"
fi

# Test invalid client ID
result=$(do_request GET "$BASE_URL/api/clients/invalid")
status=$(echo "$result" | head -1)
check_status "GET /api/clients/invalid (-> 400)" "400" "$status"

# ------------------------------------------------------------
log_section "4. Work Entries API"

if [ -n "$CLIENT_ID" ]; then
  # Create a work entry
  TODAY=$(date -u '+%Y-%m-%d')
  result=$(do_request POST "$BASE_URL/api/work-entries" '{"clientId":'"$CLIENT_ID"',"hours":2.5,"description":"Health check test entry","date":"'"$TODAY"'"}')
  status=$(echo "$result" | head -1)

  if [ "$status" = "201" ]; then
    log_pass "POST /api/work-entries - create entry (HTTP $status)"
    body=$(echo "$result" | tail -n +2)
    ENTRY_ID=$(echo "$body" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  else
    log_fail "POST /api/work-entries - create entry" "expected HTTP 201, got HTTP $status"
    ENTRY_ID=""
  fi

  # List work entries
  result=$(do_request GET "$BASE_URL/api/work-entries")
  status=$(echo "$result" | head -1)
  check_status "GET /api/work-entries - list entries" "200" "$status"

  # List with client filter
  result=$(do_request GET "$BASE_URL/api/work-entries?clientId=$CLIENT_ID")
  status=$(echo "$result" | head -1)
  check_status "GET /api/work-entries?clientId=$CLIENT_ID - filtered list" "200" "$status"

  if [ -n "$ENTRY_ID" ]; then
    # Get specific entry
    result=$(do_request GET "$BASE_URL/api/work-entries/$ENTRY_ID")
    status=$(echo "$result" | head -1)
    check_status "GET /api/work-entries/$ENTRY_ID - get entry" "200" "$status"

    # Update entry
    result=$(do_request PUT "$BASE_URL/api/work-entries/$ENTRY_ID" '{"hours":3.0}')
    status=$(echo "$result" | head -1)
    check_status "PUT /api/work-entries/$ENTRY_ID - update entry" "200" "$status"
  fi
else
  log_fail "Work entries tests" "skipped (no test client created)"
fi

# ------------------------------------------------------------
log_section "5. Reports API"

if [ -n "$CLIENT_ID" ]; then
  # Client report
  result=$(do_request GET "$BASE_URL/api/reports/client/$CLIENT_ID")
  status=$(echo "$result" | head -1)
  check_status "GET /api/reports/client/$CLIENT_ID - client report" "200" "$status"

  # CSV export
  csv_status=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" \
    -H "x-user-email: $TEST_EMAIL" \
    "$BASE_URL/api/reports/export/csv/$CLIENT_ID" 2>/dev/null) || csv_status="000"
  check_status "GET /api/reports/export/csv/$CLIENT_ID - CSV export" "200" "$csv_status"

  # PDF export
  pdf_status=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" \
    -H "x-user-email: $TEST_EMAIL" \
    "$BASE_URL/api/reports/export/pdf/$CLIENT_ID" 2>/dev/null) || pdf_status="000"
  check_status "GET /api/reports/export/pdf/$CLIENT_ID - PDF export" "200" "$pdf_status"
else
  log_fail "Reports tests" "skipped (no test client created)"
fi

# ------------------------------------------------------------
log_section "6. Error Handling"

# 404 route
result=$(do_request GET "$BASE_URL/api/nonexistent-route")
status=$(echo "$result" | head -1)
check_status "GET /api/nonexistent-route (-> 404)" "404" "$status"

# Invalid JSON body
invalid_status=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" \
  -X POST -H "Content-Type: application/json" -H "x-user-email: $TEST_EMAIL" \
  -d 'invalid json' \
  "$BASE_URL/api/clients" 2>/dev/null) || invalid_status="000"
check_status "POST /api/clients with invalid JSON (-> 400)" "400" "$invalid_status"

# Validation error - missing required field
result=$(do_request POST "$BASE_URL/api/clients" '{"description":"missing name"}')
status=$(echo "$result" | head -1)
check_status "POST /api/clients missing 'name' (-> 400)" "400" "$status"

# ------------------------------------------------------------
log_section "7. Cleanup"

# Delete test work entry
if [ -n "${ENTRY_ID:-}" ]; then
  result=$(do_request DELETE "$BASE_URL/api/work-entries/$ENTRY_ID")
  status=$(echo "$result" | head -1)
  check_status "DELETE /api/work-entries/$ENTRY_ID - cleanup entry" "200" "$status"
fi

# Delete test client
if [ -n "${CLIENT_ID:-}" ]; then
  result=$(do_request DELETE "$BASE_URL/api/clients/$CLIENT_ID")
  status=$(echo "$result" | head -1)
  check_status "DELETE /api/clients/$CLIENT_ID - cleanup client" "200" "$status"
fi

# ============================================================
log_section "Results"

echo ""
echo -e "  Total:  $TOTAL"
echo -e "  ${GREEN}Passed: $PASSED${NC}"
if [ "$FAILED" -gt 0 ]; then
  echo -e "  ${RED}Failed: $FAILED${NC}"
fi
echo ""

if [ "$FAILED" -gt 0 ]; then
  echo -e "${RED}HEALTH CHECK FAILED${NC} - $FAILED check(s) did not pass"
  echo "Refer to RUNBOOK.md for troubleshooting guidance."
  exit 1
else
  echo -e "${GREEN}ALL CHECKS PASSED${NC}"
  exit 0
fi
