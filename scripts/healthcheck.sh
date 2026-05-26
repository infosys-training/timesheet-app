#!/usr/bin/env bash
#
# Health check script for the Timesheet application.
# Tests all critical backend endpoints and reports status.
#
# Usage:
#   ./scripts/healthcheck.sh                  # defaults to http://localhost:3001
#   ./scripts/healthcheck.sh http://prod:3001 # custom base URL
#
# Exit codes:
#   0 - All checks passed
#   1 - One or more checks failed

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="healthcheck@timesheet-app.com"
TIMEOUT=10
PASSED=0
FAILED=0
WARNINGS=0

# Colors (disabled when stdout is not a terminal)
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  NC='\033[0m'
else
  GREEN='' RED='' YELLOW='' BLUE='' NC=''
fi

print_header() {
  echo ""
  echo -e "${BLUE}============================================${NC}"
  echo -e "${BLUE}  Timesheet App Health Check${NC}"
  echo -e "${BLUE}  Target: ${BASE_URL}${NC}"
  echo -e "${BLUE}  Time:   $(date -u '+%Y-%m-%d %H:%M:%S UTC')${NC}"
  echo -e "${BLUE}============================================${NC}"
  echo ""
}

check_pass() {
  echo -e "  ${GREEN}PASS${NC} $1"
  PASSED=$((PASSED + 1))
}

check_fail() {
  echo -e "  ${RED}FAIL${NC} $1"
  FAILED=$((FAILED + 1))
}

check_warn() {
  echo -e "  ${YELLOW}WARN${NC} $1"
  WARNINGS=$((WARNINGS + 1))
}

# Perform an HTTP request and validate the response.
# Arguments:
#   $1 - Test name
#   $2 - HTTP method (GET, POST, PUT, DELETE)
#   $3 - URL path (e.g., /health)
#   $4 - Expected HTTP status code
#   $5 - (optional) Request body for POST/PUT
#   $6 - (optional) Additional curl flags
http_check() {
  local name="$1"
  local method="$2"
  local path="$3"
  local expected_status="$4"
  local body="${5:-}"
  local extra_flags="${6:-}"

  local url="${BASE_URL}${path}"
  local curl_cmd="curl -s -o /dev/null -w %{http_code} --max-time ${TIMEOUT} -X ${method}"

  # Add headers
  curl_cmd="${curl_cmd} -H 'Content-Type: application/json'"
  curl_cmd="${curl_cmd} -H 'x-user-email: ${TEST_EMAIL}'"

  # Add body if provided
  if [ -n "$body" ]; then
    curl_cmd="${curl_cmd} -d '${body}'"
  fi

  # Add extra flags
  if [ -n "$extra_flags" ]; then
    curl_cmd="${curl_cmd} ${extra_flags}"
  fi

  curl_cmd="${curl_cmd} '${url}'"

  local actual_status
  actual_status=$(eval "$curl_cmd" 2>/dev/null) || actual_status="000"

  if [ "$actual_status" = "$expected_status" ]; then
    check_pass "${name} (${method} ${path}) -> ${actual_status}"
  else
    check_fail "${name} (${method} ${path}) -> ${actual_status} (expected ${expected_status})"
  fi
}

# Check response body contains expected string
http_check_body() {
  local name="$1"
  local method="$2"
  local path="$3"
  local expected_string="$4"
  local body="${5:-}"

  local url="${BASE_URL}${path}"
  local curl_cmd="curl -s --max-time ${TIMEOUT} -X ${method}"
  curl_cmd="${curl_cmd} -H 'Content-Type: application/json'"
  curl_cmd="${curl_cmd} -H 'x-user-email: ${TEST_EMAIL}'"

  if [ -n "$body" ]; then
    curl_cmd="${curl_cmd} -d '${body}'"
  fi

  curl_cmd="${curl_cmd} '${url}'"

  local response
  response=$(eval "$curl_cmd" 2>/dev/null) || response=""

  if echo "$response" | grep -q "$expected_string"; then
    check_pass "${name} - response contains '${expected_string}'"
  else
    check_fail "${name} - response missing '${expected_string}'"
  fi
}

# Measure response time
http_check_latency() {
  local name="$1"
  local path="$2"
  local max_ms="$3"

  local url="${BASE_URL}${path}"
  local time_total
  time_total=$(curl -s -o /dev/null -w '%{time_total}' --max-time "${TIMEOUT}" \
    -H "x-user-email: ${TEST_EMAIL}" "${url}" 2>/dev/null) || time_total="99"

  local ms
  ms=$(awk "BEGIN {printf \"%d\", $time_total * 1000}") || ms="99999"
  [ -z "$ms" ] && ms="99999"

  if [ "$ms" -le "$max_ms" ]; then
    check_pass "${name} - ${ms}ms (threshold: ${max_ms}ms)"
  else
    check_warn "${name} - ${ms}ms exceeds threshold of ${max_ms}ms"
  fi
}

# ─── Main ────────────────────────────────────────────────────────────────

print_header

# ─── 1. Server Connectivity ──────────────────────────────────────────────
echo -e "${BLUE}[1/7] Server Connectivity${NC}"

http_check "Health endpoint" GET "/health" "200"
http_check_body "Health response body" GET "/health" '"status":"OK"'

# ─── 2. Authentication Endpoints ─────────────────────────────────────────
echo ""
echo -e "${BLUE}[2/7] Authentication Endpoints${NC}"

# Login returns 201 for new user, 200 for existing - accept either
LOGIN_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time "${TIMEOUT}" -X POST "${BASE_URL}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${TEST_EMAIL}\"}" 2>/dev/null) || LOGIN_STATUS="000"
if [ "$LOGIN_STATUS" = "200" ] || [ "$LOGIN_STATUS" = "201" ]; then
  check_pass "Login (POST /api/auth/login) -> ${LOGIN_STATUS}"
else
  check_fail "Login (POST /api/auth/login) -> ${LOGIN_STATUS} (expected 200 or 201)"
fi
http_check "Login (existing user)" POST "/api/auth/login" "200" "{\"email\":\"${TEST_EMAIL}\"}"
http_check "Get current user" GET "/api/auth/me" "200"
http_check "Login with invalid email" POST "/api/auth/login" "400" '{"email":"not-an-email"}'

# ─── 3. Client CRUD Endpoints ───────────────────────────────────────────
echo ""
echo -e "${BLUE}[3/7] Client CRUD Endpoints${NC}"

# Create a client for testing
CLIENT_RESPONSE=$(curl -s --max-time "${TIMEOUT}" -X POST "${BASE_URL}/api/clients" \
  -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  -d '{"name":"HealthCheck Test Client","description":"Auto-created by healthcheck script"}' 2>/dev/null) || CLIENT_RESPONSE=""

CLIENT_ID=$(echo "$CLIENT_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2) || CLIENT_ID=""

if [ -n "$CLIENT_ID" ]; then
  check_pass "Create client -> id=${CLIENT_ID}"
else
  check_fail "Create client - could not parse client ID from response"
  # Try to continue with client list
  CLIENT_ID=""
fi

http_check "List clients" GET "/api/clients" "200"

if [ -n "$CLIENT_ID" ]; then
  http_check "Get single client" GET "/api/clients/${CLIENT_ID}" "200"
  http_check "Update client" PUT "/api/clients/${CLIENT_ID}" "200" '{"name":"HealthCheck Updated Client"}'
fi

http_check "Get nonexistent client" GET "/api/clients/999999" "404"
http_check "Invalid client ID" GET "/api/clients/abc" "400"

# ─── 4. Work Entry CRUD Endpoints ───────────────────────────────────────
echo ""
echo -e "${BLUE}[4/7] Work Entry CRUD Endpoints${NC}"

ENTRY_ID=""
if [ -n "$CLIENT_ID" ]; then
  ENTRY_RESPONSE=$(curl -s --max-time "${TIMEOUT}" -X POST "${BASE_URL}/api/work-entries" \
    -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    -d "{\"clientId\":${CLIENT_ID},\"hours\":2.5,\"description\":\"Healthcheck test entry\",\"date\":\"$(date -u '+%Y-%m-%d')\"}" 2>/dev/null) || ENTRY_RESPONSE=""

  ENTRY_ID=$(echo "$ENTRY_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2) || ENTRY_ID=""

  if [ -n "$ENTRY_ID" ]; then
    check_pass "Create work entry -> id=${ENTRY_ID}"
  else
    check_fail "Create work entry - could not parse entry ID"
  fi
fi

http_check "List work entries" GET "/api/work-entries" "200"

if [ -n "$CLIENT_ID" ]; then
  http_check "List work entries (filtered by client)" GET "/api/work-entries?clientId=${CLIENT_ID}" "200"
fi

if [ -n "$ENTRY_ID" ]; then
  http_check "Get single work entry" GET "/api/work-entries/${ENTRY_ID}" "200"
  http_check "Update work entry" PUT "/api/work-entries/${ENTRY_ID}" "200" '{"hours":3.0}'
fi

# ─── 5. Report Endpoints ────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[5/7] Report Endpoints${NC}"

if [ -n "$CLIENT_ID" ]; then
  http_check "Client report" GET "/api/reports/client/${CLIENT_ID}" "200"
  http_check_body "Client report body" GET "/api/reports/client/${CLIENT_ID}" '"totalHours"'

  # CSV export
  CSV_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time "${TIMEOUT}" \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/reports/export/csv/${CLIENT_ID}" 2>/dev/null) || CSV_STATUS="000"
  if [ "$CSV_STATUS" = "200" ]; then
    check_pass "CSV export (GET /api/reports/export/csv/${CLIENT_ID}) -> ${CSV_STATUS}"
  else
    check_fail "CSV export (GET /api/reports/export/csv/${CLIENT_ID}) -> ${CSV_STATUS} (expected 200)"
  fi

  # PDF export
  PDF_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time "${TIMEOUT}" \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/reports/export/pdf/${CLIENT_ID}" 2>/dev/null) || PDF_STATUS="000"
  if [ "$PDF_STATUS" = "200" ]; then
    check_pass "PDF export (GET /api/reports/export/pdf/${CLIENT_ID}) -> ${PDF_STATUS}"
  else
    check_fail "PDF export (GET /api/reports/export/pdf/${CLIENT_ID}) -> ${PDF_STATUS} (expected 200)"
  fi
else
  check_warn "Skipping report tests - no client ID available"
fi

# ─── 6. Error Handling ──────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[6/7] Error Handling & Edge Cases${NC}"

http_check "404 for unknown route" GET "/api/nonexistent" "404"
# Test missing auth - use raw curl to avoid adding x-user-email header
NOAUTH_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time "${TIMEOUT}" "${BASE_URL}/api/clients" 2>/dev/null) || NOAUTH_STATUS="000"
if [ "$NOAUTH_STATUS" = "401" ]; then
  check_pass "401 without auth header (GET /api/clients) -> ${NOAUTH_STATUS}"
else
  check_fail "401 without auth header (GET /api/clients) -> ${NOAUTH_STATUS} (expected 401)"
fi

# Validation errors
http_check "Validation: empty client name" POST "/api/clients" "400" '{"name":""}'
http_check "Validation: invalid work entry hours" POST "/api/work-entries" "400" '{"clientId":1,"hours":-5,"date":"2024-01-01"}'

# ─── 7. Performance ─────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[7/7] Performance (Latency)${NC}"

http_check_latency "Health endpoint latency" "/health" 500
http_check_latency "Client list latency" "/api/clients" 1000
http_check_latency "Work entries latency" "/api/work-entries" 1000

# ─── Cleanup ─────────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}Cleanup${NC}"

if [ -n "$ENTRY_ID" ]; then
  DEL_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time "${TIMEOUT}" -X DELETE \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/work-entries/${ENTRY_ID}" 2>/dev/null) || DEL_STATUS="000"
  if [ "$DEL_STATUS" = "200" ]; then
    check_pass "Deleted test work entry ${ENTRY_ID}"
  else
    check_warn "Could not delete test work entry ${ENTRY_ID} (status: ${DEL_STATUS})"
  fi
fi

if [ -n "$CLIENT_ID" ]; then
  DEL_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time "${TIMEOUT}" -X DELETE \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/clients/${CLIENT_ID}" 2>/dev/null) || DEL_STATUS="000"
  if [ "$DEL_STATUS" = "200" ]; then
    check_pass "Deleted test client ${CLIENT_ID}"
  else
    check_warn "Could not delete test client ${CLIENT_ID} (status: ${DEL_STATUS})"
  fi
fi

# ─── Summary ─────────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}  Results${NC}"
echo -e "${BLUE}============================================${NC}"
echo -e "  ${GREEN}Passed:   ${PASSED}${NC}"
echo -e "  ${RED}Failed:   ${FAILED}${NC}"
echo -e "  ${YELLOW}Warnings: ${WARNINGS}${NC}"
echo ""

if [ "$FAILED" -gt 0 ]; then
  echo -e "${RED}HEALTH CHECK FAILED${NC} - ${FAILED} check(s) did not pass."
  echo "Refer to RUNBOOK.md for troubleshooting procedures."
  exit 1
else
  echo -e "${GREEN}HEALTH CHECK PASSED${NC}"
  exit 0
fi
