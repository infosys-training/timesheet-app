#!/usr/bin/env bash
#
# Health Check Script for Timesheet Application
#
# Tests all critical backend endpoints and reports their status.
# Exits with code 0 if all checks pass, 1 if any fail.
#
# Usage:
#   ./scripts/health-check.sh                    # default: http://localhost:3001
#   ./scripts/health-check.sh http://myhost:3001  # custom base URL
#
# Environment variables:
#   BASE_URL          Base URL of the backend (default: http://localhost:3001)
#   TEST_EMAIL        Email used for authenticated requests (default: healthcheck@test.com)
#   TIMEOUT           Request timeout in seconds (default: 5)
#   VERBOSE           Set to "true" for detailed output (default: false)

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE_URL="${1:-${BASE_URL:-http://localhost:3001}}"
TEST_EMAIL="${TEST_EMAIL:-healthcheck@test.com}"
TIMEOUT="${TIMEOUT:-5}"
VERBOSE="${VERBOSE:-false}"

# Strip trailing slash
BASE_URL="${BASE_URL%/}"

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------
PASS=0
FAIL=0
WARN=0
RESULTS=()

# ANSI colors (disabled if not a terminal)
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  NC='\033[0m'
else
  GREEN='' RED='' YELLOW='' BLUE='' NC=''
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log() { echo -e "$@"; }

check_pass() {
  PASS=$((PASS + 1))
  RESULTS+=("${GREEN}PASS${NC}  $1")
  [ "$VERBOSE" = "true" ] && log "${GREEN}PASS${NC}  $1"
}

check_fail() {
  FAIL=$((FAIL + 1))
  RESULTS+=("${RED}FAIL${NC}  $1")
  [ "$VERBOSE" = "true" ] && log "${RED}FAIL${NC}  $1"
}

check_warn() {
  WARN=$((WARN + 1))
  RESULTS+=("${YELLOW}WARN${NC}  $1")
  [ "$VERBOSE" = "true" ] && log "${YELLOW}WARN${NC}  $1"
}

# Generic HTTP check
# Args: <method> <path> <expected_status> <label> [<extra_curl_args>...]
# expected_status can be a pipe-separated list, e.g. "200|201"
http_check() {
  local method="$1" path="$2" expected="$3" label="$4"
  shift 4

  local url="${BASE_URL}${path}"
  local status body

  body=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time "$TIMEOUT" \
    -X "$method" \
    "$@" \
    "$url" 2>/dev/null) || body="000"

  if echo "$expected" | grep -qw "$body"; then
    check_pass "$label (HTTP $body)"
  elif [ "$body" = "000" ]; then
    check_fail "$label — connection refused / timeout"
  else
    check_fail "$label — expected $expected, got $body"
  fi
}

# HTTP check that returns the response body
# Args: <method> <path> <expected_status> <label> [<extra_curl_args>...]
# expected_status can be a pipe-separated list, e.g. "200|201"
# Sets RESPONSE_BODY global variable
http_check_with_body() {
  local method="$1" path="$2" expected="$3" label="$4"
  shift 4

  local url="${BASE_URL}${path}"
  local tmpfile
  tmpfile=$(mktemp)

  local status
  status=$(curl -s -w "%{http_code}" \
    --max-time "$TIMEOUT" \
    -X "$method" \
    "$@" \
    -o "$tmpfile" \
    "$url" 2>/dev/null) || status="000"

  RESPONSE_BODY=$(cat "$tmpfile" 2>/dev/null || echo "")
  rm -f "$tmpfile"

  if echo "$expected" | grep -qw "$status"; then
    check_pass "$label (HTTP $status)"
    return 0
  elif [ "$status" = "000" ]; then
    check_fail "$label — connection refused / timeout"
    return 1
  else
    check_fail "$label — expected $expected, got $status"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------
log ""
log "${BLUE}=====================================================${NC}"
log "${BLUE} Timesheet App — Health Check${NC}"
log "${BLUE}=====================================================${NC}"
log " Target:  $BASE_URL"
log " Email:   $TEST_EMAIL"
log " Timeout: ${TIMEOUT}s per request"
log "${BLUE}=====================================================${NC}"
log ""

# ---------------------------------------------------------------------------
# 1. Health Endpoint
# ---------------------------------------------------------------------------
log "${BLUE}[1/7] Health Endpoint${NC}"
if http_check_with_body GET "/health" "200" "/health"; then
  # Verify response contains expected fields
  if echo "$RESPONSE_BODY" | grep -q '"status"' && echo "$RESPONSE_BODY" | grep -q '"timestamp"'; then
    check_pass "/health response contains status and timestamp"
  else
    check_warn "/health returned 200 but response body unexpected: $RESPONSE_BODY"
  fi
fi

# ---------------------------------------------------------------------------
# 2. Authentication — Login
# ---------------------------------------------------------------------------
log "${BLUE}[2/7] Authentication${NC}"
http_check POST "/api/auth/login" "200|201" "POST /api/auth/login (existing or new user)" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\"}"

# Get current user
http_check GET "/api/auth/me" "200" "GET /api/auth/me" \
  -H "x-user-email: $TEST_EMAIL"

# ---------------------------------------------------------------------------
# 3. Clients CRUD
# ---------------------------------------------------------------------------
log "${BLUE}[3/7] Clients API${NC}"

# Create a test client
CLIENT_ID=""
if http_check_with_body POST "/api/clients" "201" "POST /api/clients (create)" \
  -H "Content-Type: application/json" \
  -H "x-user-email: $TEST_EMAIL" \
  -d '{"name":"HealthCheck Test Client","description":"Created by health check script"}'; then
  CLIENT_ID=$(echo "$RESPONSE_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
fi

# List clients
http_check GET "/api/clients" "200" "GET /api/clients (list)" \
  -H "x-user-email: $TEST_EMAIL"

# Get specific client
if [ -n "$CLIENT_ID" ]; then
  http_check GET "/api/clients/$CLIENT_ID" "200" "GET /api/clients/$CLIENT_ID (read)" \
    -H "x-user-email: $TEST_EMAIL"
fi

# ---------------------------------------------------------------------------
# 4. Work Entries CRUD
# ---------------------------------------------------------------------------
log "${BLUE}[4/7] Work Entries API${NC}"

ENTRY_ID=""
if [ -n "$CLIENT_ID" ]; then
  TODAY=$(date +%Y-%m-%d)

  # Create work entry
  if http_check_with_body POST "/api/work-entries" "201" "POST /api/work-entries (create)" \
    -H "Content-Type: application/json" \
    -H "x-user-email: $TEST_EMAIL" \
    -d "{\"clientId\":$CLIENT_ID,\"hours\":1.5,\"description\":\"Health check test entry\",\"date\":\"$TODAY\"}"; then
    ENTRY_ID=$(echo "$RESPONSE_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  fi

  # List work entries
  http_check GET "/api/work-entries" "200" "GET /api/work-entries (list)" \
    -H "x-user-email: $TEST_EMAIL"

  # List with client filter
  http_check GET "/api/work-entries?clientId=$CLIENT_ID" "200" "GET /api/work-entries?clientId=$CLIENT_ID (filtered)" \
    -H "x-user-email: $TEST_EMAIL"
else
  check_warn "Skipping work entries — no client ID available"
fi

# ---------------------------------------------------------------------------
# 5. Reports
# ---------------------------------------------------------------------------
log "${BLUE}[5/7] Reports API${NC}"

if [ -n "$CLIENT_ID" ]; then
  http_check GET "/api/reports/client/$CLIENT_ID" "200" "GET /api/reports/client/$CLIENT_ID (report)" \
    -H "x-user-email: $TEST_EMAIL"

  http_check GET "/api/reports/export/csv/$CLIENT_ID" "200" "GET /api/reports/export/csv/$CLIENT_ID (CSV)" \
    -H "x-user-email: $TEST_EMAIL"

  http_check GET "/api/reports/export/pdf/$CLIENT_ID" "200" "GET /api/reports/export/pdf/$CLIENT_ID (PDF)" \
    -H "x-user-email: $TEST_EMAIL"
else
  check_warn "Skipping reports — no client ID available"
fi

# ---------------------------------------------------------------------------
# 6. Error Handling
# ---------------------------------------------------------------------------
log "${BLUE}[6/7] Error Handling${NC}"

# 404 for unknown route
http_check GET "/api/nonexistent" "404" "GET /api/nonexistent (404 handler)"

# 400 for invalid email
http_check POST "/api/auth/login" "400" "POST /api/auth/login with invalid email (validation)" \
  -H "Content-Type: application/json" \
  -d '{"email":"not-an-email"}'

# 401 for missing auth header
http_check GET "/api/clients" "401" "GET /api/clients without auth (401)" \

# ---------------------------------------------------------------------------
# 7. Cleanup Test Data
# ---------------------------------------------------------------------------
log "${BLUE}[7/7] Cleanup${NC}"

if [ -n "${ENTRY_ID:-}" ]; then
  http_check DELETE "/api/work-entries/$ENTRY_ID" "200" "DELETE /api/work-entries/$ENTRY_ID (cleanup)" \
    -H "x-user-email: $TEST_EMAIL"
fi

if [ -n "${CLIENT_ID:-}" ]; then
  http_check DELETE "/api/clients/$CLIENT_ID" "200" "DELETE /api/clients/$CLIENT_ID (cleanup)" \
    -H "x-user-email: $TEST_EMAIL"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
log ""
log "${BLUE}=====================================================${NC}"
log "${BLUE} Results${NC}"
log "${BLUE}=====================================================${NC}"
for result in "${RESULTS[@]}"; do
  log "  $result"
done
log ""
log "${BLUE}-----------------------------------------------------${NC}"
log "  ${GREEN}Passed: $PASS${NC}   ${RED}Failed: $FAIL${NC}   ${YELLOW}Warnings: $WARN${NC}"
log "${BLUE}-----------------------------------------------------${NC}"
log ""

if [ "$FAIL" -gt 0 ]; then
  log "${RED}Health check FAILED — $FAIL check(s) did not pass.${NC}"
  exit 1
else
  log "${GREEN}Health check PASSED — all critical endpoints responding.${NC}"
  exit 0
fi
