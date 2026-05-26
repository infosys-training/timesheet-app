#!/usr/bin/env bash
#
# Health Check Script for Timesheet App
#
# Tests all critical backend endpoints to verify the application is functioning.
# Requires: curl, bash 4+
#
# Usage:
#   ./scripts/healthcheck.sh                    # Uses default http://localhost:3001
#   ./scripts/healthcheck.sh http://myhost:3001 # Uses custom base URL
#
# Exit codes:
#   0 - All checks passed
#   1 - One or more checks failed

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="healthcheck@timesheet-app.com"
PASS=0
FAIL=0
WARN=0

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  NC='\033[0m'
else
  RED=''
  GREEN=''
  YELLOW=''
  BLUE=''
  NC=''
fi

print_header() {
  echo ""
  echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}  Timesheet App Health Check${NC}"
  echo -e "${BLUE}  Target: ${BASE_URL}${NC}"
  echo -e "${BLUE}  Time:   $(date -u '+%Y-%m-%d %H:%M:%S UTC')${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
  echo ""
}

check_pass() {
  echo -e "  ${GREEN}PASS${NC} $1"
  PASS=$((PASS + 1))
}

check_fail() {
  echo -e "  ${RED}FAIL${NC} $1"
  [ -n "${2:-}" ] && echo -e "       ${RED}$2${NC}"
  FAIL=$((FAIL + 1))
}

check_warn() {
  echo -e "  ${YELLOW}WARN${NC} $1"
  [ -n "${2:-}" ] && echo -e "       ${YELLOW}$2${NC}"
  WARN=$((WARN + 1))
}

# Perform an HTTP request and validate the response.
# Arguments: method url expected_status description [data] [extra_curl_args...]
http_check() {
  local method="$1"
  local url="$2"
  local expected_status="$3"
  local description="$4"
  local data="${5:-}"

  local curl_args=(-s -o /dev/null -w "%{http_code}" -X "$method" --max-time 10)

  curl_args+=(-H "x-user-email: ${TEST_EMAIL}")
  curl_args+=(-H "Content-Type: application/json")

  if [ -n "$data" ]; then
    curl_args+=(-d "$data")
  fi

  local status
  status=$(curl "${curl_args[@]}" "${BASE_URL}${url}" 2>/dev/null) || true

  if [ "$status" = "$expected_status" ]; then
    check_pass "$description (HTTP $status)"
  elif [ -z "$status" ]; then
    check_fail "$description" "Connection refused or timed out"
  else
    check_fail "$description" "Expected HTTP $expected_status, got HTTP $status"
  fi
}

# Perform an HTTP request and capture the response body.
# Arguments: method url [data]
# Sets global: RESPONSE_BODY, RESPONSE_STATUS
http_request() {
  local method="$1"
  local url="$2"
  local data="${3:-}"

  local curl_args=(-s -w "\n%{http_code}" -X "$method" --max-time 10)

  curl_args+=(-H "x-user-email: ${TEST_EMAIL}")
  curl_args+=(-H "Content-Type: application/json")

  if [ -n "$data" ]; then
    curl_args+=(-d "$data")
  fi

  local response
  response=$(curl "${curl_args[@]}" "${BASE_URL}${url}" 2>/dev/null) || true

  RESPONSE_STATUS=$(echo "$response" | tail -n1)
  RESPONSE_BODY=$(echo "$response" | sed '$d')
}

# ─── 1. Basic Connectivity ──────────────────────────────────────────────

print_header

echo -e "${BLUE}[1/6] Basic Connectivity${NC}"

http_check "GET" "/health" "200" "Health endpoint"

# Verify response body contains expected JSON
HEALTH_BODY=$(curl -s --max-time 10 "${BASE_URL}/health" 2>/dev/null) || true
if echo "$HEALTH_BODY" | grep -q '"status":"OK"'; then
  check_pass "Health response body is valid JSON with status OK"
else
  check_fail "Health response body" "Expected {\"status\":\"OK\",...} but got: $HEALTH_BODY"
fi

# ─── 2. Authentication ──────────────────────────────────────────────────

echo ""
echo -e "${BLUE}[2/6] Authentication${NC}"

http_check "POST" "/api/auth/login" "201" "Auth login (new user)" '{"email":"'"${TEST_EMAIL}"'"}'

# Login again should return 200 (existing user)
http_check "POST" "/api/auth/login" "200" "Auth login (existing user)" '{"email":"'"${TEST_EMAIL}"'"}'

http_check "GET" "/api/auth/me" "200" "Auth me (current user)"

# Test missing auth header
NO_AUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X GET --max-time 10 "${BASE_URL}/api/clients" 2>/dev/null) || true
if [ "$NO_AUTH_STATUS" = "401" ]; then
  check_pass "Missing auth header returns 401"
else
  check_fail "Missing auth header" "Expected HTTP 401, got HTTP $NO_AUTH_STATUS"
fi

# ─── 3. Client CRUD ─────────────────────────────────────────────────────

echo ""
echo -e "${BLUE}[3/6] Client CRUD Operations${NC}"

# Create a client
http_request "POST" "/api/clients" '{"name":"HealthCheck Test Client","description":"Created by health check script","department":"QA"}'
if [ "$RESPONSE_STATUS" = "201" ]; then
  check_pass "Create client (HTTP 201)"
  CLIENT_ID=$(echo "$RESPONSE_BODY" | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*')
else
  check_fail "Create client" "Expected HTTP 201, got HTTP $RESPONSE_STATUS"
  CLIENT_ID=""
fi

# List clients
http_check "GET" "/api/clients" "200" "List clients"

if [ -n "${CLIENT_ID:-}" ]; then
  # Get specific client
  http_check "GET" "/api/clients/${CLIENT_ID}" "200" "Get client by ID"

  # Update client
  http_check "PUT" "/api/clients/${CLIENT_ID}" "200" "Update client" '{"name":"HealthCheck Updated Client"}'
fi

# Test validation: create client with empty name
http_check "POST" "/api/clients" "400" "Create client validation (empty body)" '{}'

# ─── 4. Work Entry CRUD ─────────────────────────────────────────────────

echo ""
echo -e "${BLUE}[4/6] Work Entry CRUD Operations${NC}"

WORK_ENTRY_ID=""
if [ -n "${CLIENT_ID:-}" ]; then
  # Create a work entry
  TODAY=$(date -u '+%Y-%m-%d')
  http_request "POST" "/api/work-entries" '{"clientId":'"${CLIENT_ID}"',"hours":2.5,"description":"Health check test entry","date":"'"${TODAY}"'"}'
  if [ "$RESPONSE_STATUS" = "201" ]; then
    check_pass "Create work entry (HTTP 201)"
    WORK_ENTRY_ID=$(echo "$RESPONSE_BODY" | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*')
  else
    check_fail "Create work entry" "Expected HTTP 201, got HTTP $RESPONSE_STATUS"
  fi

  # List work entries
  http_check "GET" "/api/work-entries" "200" "List work entries"

  # List work entries filtered by client
  http_check "GET" "/api/work-entries?clientId=${CLIENT_ID}" "200" "List work entries by client"

  if [ -n "$WORK_ENTRY_ID" ]; then
    # Get specific work entry
    http_check "GET" "/api/work-entries/${WORK_ENTRY_ID}" "200" "Get work entry by ID"

    # Update work entry
    http_check "PUT" "/api/work-entries/${WORK_ENTRY_ID}" "200" "Update work entry" '{"hours":3.0}'
  fi
else
  check_warn "Skipping work entry tests (no client ID available)"
fi

# Test validation: invalid work entry
http_check "POST" "/api/work-entries" "400" "Work entry validation (missing fields)" '{}'

# ─── 5. Reports ──────────────────────────────────────────────────────────

echo ""
echo -e "${BLUE}[5/6] Report Endpoints${NC}"

if [ -n "${CLIENT_ID:-}" ]; then
  http_check "GET" "/api/reports/client/${CLIENT_ID}" "200" "Client report (JSON)"
  http_check "GET" "/api/reports/export/csv/${CLIENT_ID}" "200" "Client report (CSV export)"
  http_check "GET" "/api/reports/export/pdf/${CLIENT_ID}" "200" "Client report (PDF export)"
else
  check_warn "Skipping report tests (no client ID available)"
fi

# ─── 6. Error Handling & Edge Cases ─────────────────────────────────────

echo ""
echo -e "${BLUE}[6/6] Error Handling & Edge Cases${NC}"

# 404 for unknown routes
http_check "GET" "/api/nonexistent" "404" "Unknown route returns 404"

# Invalid client ID format
http_check "GET" "/api/clients/notanumber" "400" "Invalid client ID returns 400"

# Invalid work entry ID format
http_check "GET" "/api/work-entries/notanumber" "400" "Invalid work entry ID returns 400"

# Non-existent client ID
http_check "GET" "/api/clients/999999" "404" "Non-existent client returns 404"

# Non-existent work entry ID
http_check "GET" "/api/work-entries/999999" "404" "Non-existent work entry returns 404"

# Invalid email format for login
http_check "POST" "/api/auth/login" "400" "Invalid email format returns 400" '{"email":"not-an-email"}'

# ─── Cleanup ─────────────────────────────────────────────────────────────

# Clean up test data (delete work entry first due to foreign key)
if [ -n "${WORK_ENTRY_ID:-}" ]; then
  curl -s -o /dev/null -X DELETE -H "x-user-email: ${TEST_EMAIL}" --max-time 10 "${BASE_URL}/api/work-entries/${WORK_ENTRY_ID}" 2>/dev/null || true
fi
if [ -n "${CLIENT_ID:-}" ]; then
  curl -s -o /dev/null -X DELETE -H "x-user-email: ${TEST_EMAIL}" --max-time 10 "${BASE_URL}/api/clients/${CLIENT_ID}" 2>/dev/null || true
fi

# ─── Summary ─────────────────────────────────────────────────────────────

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo -e "  Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${YELLOW}${WARN} warnings${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}Health check FAILED - $FAIL check(s) did not pass.${NC}"
  exit 1
else
  echo -e "${GREEN}Health check PASSED - all checks successful.${NC}"
  exit 0
fi
