#!/usr/bin/env bash
#
# Health Check Script for Timesheet App
#
# Tests all critical endpoints on the backend API and reports status.
# Exit code 0 = all checks passed, non-zero = one or more checks failed.
#
# Usage:
#   ./scripts/healthcheck.sh                    # defaults to http://localhost:3001
#   ./scripts/healthcheck.sh http://my-server:3001
#   HEALTHCHECK_EMAIL=ops@co.com ./scripts/healthcheck.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="${HEALTHCHECK_EMAIL:-healthcheck@timesheet-app.local}"
TIMEOUT=10          # curl timeout in seconds
PASSED=0
FAILED=0
WARNINGS=0
RESULTS=()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color
BOLD='\033[1m'

pass() {
  PASSED=$((PASSED + 1))
  RESULTS+=("${GREEN}PASS${NC}  $1")
  printf "${GREEN}PASS${NC}  %s\n" "$1"
}

fail() {
  FAILED=$((FAILED + 1))
  RESULTS+=("${RED}FAIL${NC}  $1 -- $2")
  printf "${RED}FAIL${NC}  %s -- %s\n" "$1" "$2"
}

warn() {
  WARNINGS=$((WARNINGS + 1))
  RESULTS+=("${YELLOW}WARN${NC}  $1 -- $2")
  printf "${YELLOW}WARN${NC}  %s -- %s\n" "$1" "$2"
}

separator() {
  echo "------------------------------------------------------------"
}

# Check if a command exists
require_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "Error: '$1' is required but not installed." >&2
    exit 2
  fi
}

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
require_cmd curl
require_cmd jq

echo ""
printf "${BOLD}Timesheet App Health Check${NC}\n"
printf "Target: %s\n" "$BASE_URL"
printf "Time:   %s\n" "$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
separator

# ---------------------------------------------------------------------------
# 1. Server Reachability
# ---------------------------------------------------------------------------
printf "\n${BOLD}[1/7] Server Reachability${NC}\n"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$BASE_URL/health" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "000" ]; then
  fail "Server reachability" "Connection refused or timed out at $BASE_URL"
  echo ""
  separator
  printf "\n${RED}CRITICAL: Backend server is not reachable. Remaining checks skipped.${NC}\n"
  printf "Total: %d passed, %d failed, %d warnings\n" "$PASSED" "$FAILED" "$WARNINGS"
  exit 1
else
  pass "Server reachable (HTTP $HTTP_CODE)"
fi

# ---------------------------------------------------------------------------
# 2. Health Endpoint
# ---------------------------------------------------------------------------
printf "\n${BOLD}[2/7] Health Endpoint${NC}\n"

HEALTH_RESPONSE=$(curl -s --max-time "$TIMEOUT" "$BASE_URL/health" 2>/dev/null)
HEALTH_STATUS=$(echo "$HEALTH_RESPONSE" | jq -r '.status // empty' 2>/dev/null)
HEALTH_TIMESTAMP=$(echo "$HEALTH_RESPONSE" | jq -r '.timestamp // empty' 2>/dev/null)

if [ "$HEALTH_STATUS" = "OK" ] && [ -n "$HEALTH_TIMESTAMP" ]; then
  pass "GET /health -- status=$HEALTH_STATUS, timestamp=$HEALTH_TIMESTAMP"
else
  fail "GET /health" "Unexpected response: $HEALTH_RESPONSE"
fi

# ---------------------------------------------------------------------------
# 3. Authentication Flow
# ---------------------------------------------------------------------------
printf "\n${BOLD}[3/7] Authentication${NC}\n"

# 3a. Login
LOGIN_RESPONSE=$(curl -s --max-time "$TIMEOUT" \
  -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\"}" 2>/dev/null)

LOGIN_MSG=$(echo "$LOGIN_RESPONSE" | jq -r '.message // empty' 2>/dev/null)
LOGIN_EMAIL=$(echo "$LOGIN_RESPONSE" | jq -r '.user.email // empty' 2>/dev/null)

if [ -n "$LOGIN_MSG" ] && [ "$LOGIN_EMAIL" = "$TEST_EMAIL" ]; then
  pass "POST /api/auth/login -- $LOGIN_MSG"
else
  LOGIN_ERR=$(echo "$LOGIN_RESPONSE" | jq -r '.error // empty' 2>/dev/null)
  fail "POST /api/auth/login" "${LOGIN_ERR:-Unexpected response: $LOGIN_RESPONSE}"
fi

# 3b. Get current user
ME_RESPONSE=$(curl -s --max-time "$TIMEOUT" \
  "$BASE_URL/api/auth/me" \
  -H "x-user-email: $TEST_EMAIL" 2>/dev/null)

ME_EMAIL=$(echo "$ME_RESPONSE" | jq -r '.user.email // empty' 2>/dev/null)

if [ "$ME_EMAIL" = "$TEST_EMAIL" ]; then
  pass "GET /api/auth/me -- user=$ME_EMAIL"
else
  ME_ERR=$(echo "$ME_RESPONSE" | jq -r '.error // empty' 2>/dev/null)
  fail "GET /api/auth/me" "${ME_ERR:-Unexpected response}"
fi

# 3c. Auth rejection (missing header)
NOAUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
  "$BASE_URL/api/clients" 2>/dev/null)

if [ "$NOAUTH_CODE" = "401" ]; then
  pass "Auth guard -- correctly returns 401 without credentials"
else
  warn "Auth guard" "Expected 401, got $NOAUTH_CODE"
fi

# ---------------------------------------------------------------------------
# 4. Client CRUD Endpoints
# ---------------------------------------------------------------------------
printf "\n${BOLD}[4/7] Client CRUD${NC}\n"

# Create a test client
CREATE_CLIENT_RESPONSE=$(curl -s --max-time "$TIMEOUT" \
  -X POST "$BASE_URL/api/clients" \
  -H "Content-Type: application/json" \
  -H "x-user-email: $TEST_EMAIL" \
  -d '{"name":"HealthCheck Test Client","description":"Created by healthcheck script"}' 2>/dev/null)

CLIENT_ID=$(echo "$CREATE_CLIENT_RESPONSE" | jq -r '.client.id // empty' 2>/dev/null)

if [ -n "$CLIENT_ID" ]; then
  pass "POST /api/clients -- created client id=$CLIENT_ID"
else
  CREATE_ERR=$(echo "$CREATE_CLIENT_RESPONSE" | jq -r '.error // empty' 2>/dev/null)
  fail "POST /api/clients" "${CREATE_ERR:-Unexpected response}"
  CLIENT_ID=""
fi

# List clients
LIST_CLIENTS_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
  "$BASE_URL/api/clients" \
  -H "x-user-email: $TEST_EMAIL" 2>/dev/null)

if [ "$LIST_CLIENTS_CODE" = "200" ]; then
  pass "GET /api/clients -- HTTP $LIST_CLIENTS_CODE"
else
  fail "GET /api/clients" "HTTP $LIST_CLIENTS_CODE"
fi

# Get specific client (if created)
if [ -n "$CLIENT_ID" ]; then
  GET_CLIENT_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    "$BASE_URL/api/clients/$CLIENT_ID" \
    -H "x-user-email: $TEST_EMAIL" 2>/dev/null)

  if [ "$GET_CLIENT_CODE" = "200" ]; then
    pass "GET /api/clients/$CLIENT_ID -- HTTP $GET_CLIENT_CODE"
  else
    fail "GET /api/clients/$CLIENT_ID" "HTTP $GET_CLIENT_CODE"
  fi
fi

# ---------------------------------------------------------------------------
# 5. Work Entry Endpoints
# ---------------------------------------------------------------------------
printf "\n${BOLD}[5/7] Work Entry CRUD${NC}\n"

if [ -n "$CLIENT_ID" ]; then
  # Create a work entry
  CREATE_ENTRY_RESPONSE=$(curl -s --max-time "$TIMEOUT" \
    -X POST "$BASE_URL/api/work-entries" \
    -H "Content-Type: application/json" \
    -H "x-user-email: $TEST_EMAIL" \
    -d "{\"clientId\":$CLIENT_ID,\"hours\":1.5,\"description\":\"Healthcheck test entry\",\"date\":\"$(date -u '+%Y-%m-%d')\"}" 2>/dev/null)

  ENTRY_ID=$(echo "$CREATE_ENTRY_RESPONSE" | jq -r '.workEntry.id // empty' 2>/dev/null)

  if [ -n "$ENTRY_ID" ]; then
    pass "POST /api/work-entries -- created entry id=$ENTRY_ID"
  else
    CREATE_ENTRY_ERR=$(echo "$CREATE_ENTRY_RESPONSE" | jq -r '.error // empty' 2>/dev/null)
    fail "POST /api/work-entries" "${CREATE_ENTRY_ERR:-Unexpected response}"
    ENTRY_ID=""
  fi

  # List work entries
  LIST_ENTRIES_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    "$BASE_URL/api/work-entries" \
    -H "x-user-email: $TEST_EMAIL" 2>/dev/null)

  if [ "$LIST_ENTRIES_CODE" = "200" ]; then
    pass "GET /api/work-entries -- HTTP $LIST_ENTRIES_CODE"
  else
    fail "GET /api/work-entries" "HTTP $LIST_ENTRIES_CODE"
  fi

  # List with client filter
  LIST_FILTERED_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    "$BASE_URL/api/work-entries?clientId=$CLIENT_ID" \
    -H "x-user-email: $TEST_EMAIL" 2>/dev/null)

  if [ "$LIST_FILTERED_CODE" = "200" ]; then
    pass "GET /api/work-entries?clientId=$CLIENT_ID -- HTTP $LIST_FILTERED_CODE"
  else
    fail "GET /api/work-entries?clientId=$CLIENT_ID" "HTTP $LIST_FILTERED_CODE"
  fi
else
  warn "Work entry tests" "Skipped -- no test client was created"
fi

# ---------------------------------------------------------------------------
# 6. Report & Export Endpoints
# ---------------------------------------------------------------------------
printf "\n${BOLD}[6/7] Reports & Export${NC}\n"

if [ -n "$CLIENT_ID" ]; then
  # Get client report
  REPORT_RESPONSE=$(curl -s --max-time "$TIMEOUT" \
    "$BASE_URL/api/reports/client/$CLIENT_ID" \
    -H "x-user-email: $TEST_EMAIL" 2>/dev/null)

  REPORT_TOTAL=$(echo "$REPORT_RESPONSE" | jq -r '.totalHours // empty' 2>/dev/null)

  if [ -n "$REPORT_TOTAL" ]; then
    pass "GET /api/reports/client/$CLIENT_ID -- totalHours=$REPORT_TOTAL"
  else
    REPORT_ERR=$(echo "$REPORT_RESPONSE" | jq -r '.error // empty' 2>/dev/null)
    fail "GET /api/reports/client/$CLIENT_ID" "${REPORT_ERR:-Unexpected response}"
  fi

  # CSV export
  CSV_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    "$BASE_URL/api/reports/export/csv/$CLIENT_ID" \
    -H "x-user-email: $TEST_EMAIL" 2>/dev/null)

  if [ "$CSV_CODE" = "200" ]; then
    pass "GET /api/reports/export/csv/$CLIENT_ID -- HTTP $CSV_CODE"
  else
    fail "GET /api/reports/export/csv/$CLIENT_ID" "HTTP $CSV_CODE"
  fi

  # PDF export
  PDF_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    "$BASE_URL/api/reports/export/pdf/$CLIENT_ID" \
    -H "x-user-email: $TEST_EMAIL" 2>/dev/null)

  if [ "$PDF_CODE" = "200" ]; then
    pass "GET /api/reports/export/pdf/$CLIENT_ID -- HTTP $PDF_CODE"
  else
    fail "GET /api/reports/export/pdf/$CLIENT_ID" "HTTP $PDF_CODE"
  fi
else
  warn "Report tests" "Skipped -- no test client was created"
fi

# ---------------------------------------------------------------------------
# 7. Cleanup & Edge Cases
# ---------------------------------------------------------------------------
printf "\n${BOLD}[7/7] Edge Cases & Cleanup${NC}\n"

# 404 handler
NOT_FOUND_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
  "$BASE_URL/api/nonexistent" \
  -H "x-user-email: $TEST_EMAIL" 2>/dev/null)

if [ "$NOT_FOUND_CODE" = "404" ]; then
  pass "404 handler -- correctly returns 404 for unknown routes"
else
  warn "404 handler" "Expected 404, got $NOT_FOUND_CODE"
fi

# Validation: invalid email format
INVALID_LOGIN_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
  -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"not-an-email"}' 2>/dev/null)

if [ "$INVALID_LOGIN_CODE" = "400" ]; then
  pass "Input validation -- rejects invalid email (HTTP $INVALID_LOGIN_CODE)"
else
  warn "Input validation" "Expected 400 for invalid email, got $INVALID_LOGIN_CODE"
fi

# Validation: missing required fields
INVALID_CLIENT_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
  -X POST "$BASE_URL/api/clients" \
  -H "Content-Type: application/json" \
  -H "x-user-email: $TEST_EMAIL" \
  -d '{}' 2>/dev/null)

if [ "$INVALID_CLIENT_CODE" = "400" ]; then
  pass "Input validation -- rejects empty client body (HTTP $INVALID_CLIENT_CODE)"
else
  warn "Input validation" "Expected 400 for empty client body, got $INVALID_CLIENT_CODE"
fi

# Cleanup: delete the test work entry
if [ -n "${ENTRY_ID:-}" ]; then
  DEL_ENTRY_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    -X DELETE "$BASE_URL/api/work-entries/$ENTRY_ID" \
    -H "x-user-email: $TEST_EMAIL" 2>/dev/null)

  if [ "$DEL_ENTRY_CODE" = "200" ]; then
    pass "DELETE /api/work-entries/$ENTRY_ID -- cleanup OK"
  else
    warn "Cleanup" "Failed to delete test work entry (HTTP $DEL_ENTRY_CODE)"
  fi
fi

# Cleanup: delete the test client
if [ -n "${CLIENT_ID:-}" ]; then
  DEL_CLIENT_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    -X DELETE "$BASE_URL/api/clients/$CLIENT_ID" \
    -H "x-user-email: $TEST_EMAIL" 2>/dev/null)

  if [ "$DEL_CLIENT_CODE" = "200" ]; then
    pass "DELETE /api/clients/$CLIENT_ID -- cleanup OK"
  else
    warn "Cleanup" "Failed to delete test client (HTTP $DEL_CLIENT_CODE)"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
separator
printf "${BOLD}Summary${NC}\n"
TOTAL=$((PASSED + FAILED + WARNINGS))
printf "  Total checks: %d\n" "$TOTAL"
printf "  ${GREEN}Passed: %d${NC}\n" "$PASSED"
printf "  ${RED}Failed: %d${NC}\n" "$FAILED"
printf "  ${YELLOW}Warnings: %d${NC}\n" "$WARNINGS"
separator

if [ "$FAILED" -gt 0 ]; then
  printf "\n${RED}${BOLD}HEALTH CHECK FAILED${NC} -- %d check(s) failed\n\n" "$FAILED"
  exit 1
elif [ "$WARNINGS" -gt 0 ]; then
  printf "\n${YELLOW}${BOLD}HEALTH CHECK PASSED WITH WARNINGS${NC}\n\n"
  exit 0
else
  printf "\n${GREEN}${BOLD}ALL HEALTH CHECKS PASSED${NC}\n\n"
  exit 0
fi
