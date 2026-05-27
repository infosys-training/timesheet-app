#!/usr/bin/env bash
#
# Health Check Script for Timesheet Application
#
# Tests all critical endpoints and reports their status.
# Exit code 0 = all checks pass, non-zero = one or more failures.
#
# Usage:
#   ./scripts/healthcheck.sh                    # Default: http://localhost:3001
#   ./scripts/healthcheck.sh http://myhost:3001 # Custom base URL
#   HEALTHCHECK_EMAIL=user@test.com ./scripts/healthcheck.sh  # Custom test email
#

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="${HEALTHCHECK_EMAIL:-healthcheck@timesheet-app.com}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0
TOTAL_COUNT=0

# Print a section header
section() {
  echo ""
  echo -e "${BOLD}${CYAN}=== $1 ===${NC}"
}

# Check an endpoint and report result
# Arguments: test_name, expected_http_code, curl_args...
check_endpoint() {
  local test_name="$1"
  local expected_code="$2"
  shift 2

  TOTAL_COUNT=$((TOTAL_COUNT + 1))

  local response_code
  local response_body
  local response_time

  # Use a temp file for the response body to capture both code and body
  local tmpfile
  tmpfile=$(mktemp)

  response_code=$(curl -s -o "$tmpfile" -w "%{http_code}" \
    --connect-timeout 5 --max-time 10 "$@" 2>/dev/null) || {
    echo -e "  ${RED}FAIL${NC} $test_name - Connection failed (is the server running at ${BASE_URL}?)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    rm -f "$tmpfile"
    return 1
  }

  response_body=$(cat "$tmpfile")
  rm -f "$tmpfile"

  if [ "$response_code" = "$expected_code" ]; then
    echo -e "  ${GREEN}PASS${NC} $test_name (HTTP $response_code)"
    PASS_COUNT=$((PASS_COUNT + 1))
    return 0
  else
    echo -e "  ${RED}FAIL${NC} $test_name - Expected HTTP $expected_code, got HTTP $response_code"
    if [ -n "$response_body" ]; then
      echo -e "        Response: $(echo "$response_body" | head -c 200)"
    fi
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return 1
  fi
}

# Check response time of an endpoint
check_response_time() {
  local test_name="$1"
  local url="$2"
  local max_ms="$3"

  TOTAL_COUNT=$((TOTAL_COUNT + 1))

  local time_total
  time_total=$(curl -s -o /dev/null -w "%{time_total}" \
    --connect-timeout 5 --max-time 10 "$url" 2>/dev/null) || {
    echo -e "  ${RED}FAIL${NC} $test_name - Connection failed"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return 1
  }

  local time_ms
  time_ms=$(echo "$time_total * 1000" | bc 2>/dev/null | cut -d. -f1)

  if [ -z "$time_ms" ] || [ "$time_ms" -le "$max_ms" ]; then
    echo -e "  ${GREEN}PASS${NC} $test_name (${time_ms:-0}ms < ${max_ms}ms)"
    PASS_COUNT=$((PASS_COUNT + 1))
    return 0
  else
    echo -e "  ${YELLOW}WARN${NC} $test_name - Response time ${time_ms}ms exceeds ${max_ms}ms threshold"
    WARN_COUNT=$((WARN_COUNT + 1))
    return 0
  fi
}

# Check that a JSON response contains an expected key
check_json_key() {
  local test_name="$1"
  local expected_key="$2"
  shift 2

  TOTAL_COUNT=$((TOTAL_COUNT + 1))

  local response_body
  response_body=$(curl -s --connect-timeout 5 --max-time 10 "$@" 2>/dev/null) || {
    echo -e "  ${RED}FAIL${NC} $test_name - Connection failed"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return 1
  }

  if echo "$response_body" | grep -q "\"$expected_key\""; then
    echo -e "  ${GREEN}PASS${NC} $test_name (response contains \"$expected_key\")"
    PASS_COUNT=$((PASS_COUNT + 1))
    return 0
  else
    echo -e "  ${RED}FAIL${NC} $test_name - Response missing expected key \"$expected_key\""
    echo -e "        Response: $(echo "$response_body" | head -c 200)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return 1
  fi
}

echo -e "${BOLD}Timesheet Application Health Check${NC}"
echo -e "Target: ${BASE_URL}"
echo -e "Test Email: ${TEST_EMAIL}"
echo -e "Timestamp: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

# ============================================================
section "1. Basic Connectivity"
# ============================================================

check_endpoint \
  "Health endpoint returns 200" \
  "200" \
  "${BASE_URL}/health"

check_json_key \
  "Health response contains status field" \
  "status" \
  "${BASE_URL}/health"

check_response_time \
  "Health endpoint response time (<500ms)" \
  "${BASE_URL}/health" \
  500

# ============================================================
section "2. Authentication Endpoints"
# ============================================================

check_endpoint \
  "POST /api/auth/login with valid email" \
  "200" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${TEST_EMAIL}\"}" \
  "${BASE_URL}/api/auth/login"

check_endpoint \
  "POST /api/auth/login with invalid email returns 400" \
  "400" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"email":"not-an-email"}' \
  "${BASE_URL}/api/auth/login"

check_endpoint \
  "POST /api/auth/login with missing body returns 400" \
  "400" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{}' \
  "${BASE_URL}/api/auth/login"

check_endpoint \
  "GET /api/auth/me with valid email" \
  "200" \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BASE_URL}/api/auth/me"

check_endpoint \
  "GET /api/auth/me without email returns 401" \
  "401" \
  "${BASE_URL}/api/auth/me"

# ============================================================
section "3. Client Endpoints"
# ============================================================

check_endpoint \
  "GET /api/clients with auth" \
  "200" \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BASE_URL}/api/clients"

check_json_key \
  "GET /api/clients returns clients array" \
  "clients" \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BASE_URL}/api/clients"

check_endpoint \
  "GET /api/clients without auth returns 401" \
  "401" \
  "${BASE_URL}/api/clients"

check_endpoint \
  "POST /api/clients creates a client" \
  "201" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  -d '{"name":"Healthcheck Test Client","description":"Created by health check script"}' \
  "${BASE_URL}/api/clients"

check_endpoint \
  "POST /api/clients with empty name returns 400" \
  "400" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  -d '{"name":""}' \
  "${BASE_URL}/api/clients"

check_endpoint \
  "GET /api/clients/:id with invalid ID returns 400" \
  "400" \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BASE_URL}/api/clients/abc"

# ============================================================
section "4. Work Entry Endpoints"
# ============================================================

check_endpoint \
  "GET /api/work-entries with auth" \
  "200" \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BASE_URL}/api/work-entries"

check_json_key \
  "GET /api/work-entries returns workEntries array" \
  "workEntries" \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BASE_URL}/api/work-entries"

check_endpoint \
  "GET /api/work-entries without auth returns 401" \
  "401" \
  "${BASE_URL}/api/work-entries"

# ============================================================
section "5. Report Endpoints"
# ============================================================

# Reports require a valid client ID; test with invalid ID for error handling
check_endpoint \
  "GET /api/reports/client/invalid returns 400" \
  "400" \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BASE_URL}/api/reports/client/abc"

check_endpoint \
  "GET /api/reports/client/99999 returns 404 (non-existent)" \
  "404" \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BASE_URL}/api/reports/client/99999"

check_endpoint \
  "GET /api/reports/export/csv/invalid returns 400" \
  "400" \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BASE_URL}/api/reports/export/csv/abc"

check_endpoint \
  "GET /api/reports/export/pdf/invalid returns 400" \
  "400" \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BASE_URL}/api/reports/export/pdf/abc"

check_endpoint \
  "Report endpoints without auth return 401" \
  "401" \
  "${BASE_URL}/api/reports/client/1"

# ============================================================
section "6. Error Handling"
# ============================================================

check_endpoint \
  "Unknown route returns 404" \
  "404" \
  "${BASE_URL}/api/nonexistent"

check_endpoint \
  "Request with malformed JSON returns 400" \
  "400" \
  -X POST \
  -H "Content-Type: application/json" \
  -d 'not-json' \
  "${BASE_URL}/api/auth/login"

# ============================================================
section "7. Response Time Checks"
# ============================================================

check_response_time \
  "Auth login response time (<1000ms)" \
  "${BASE_URL}/api/auth/login" \
  1000

check_response_time \
  "Client list response time (<1000ms)" \
  "${BASE_URL}/api/clients" \
  1000

# ============================================================
# Summary
# ============================================================
echo ""
echo -e "${BOLD}${CYAN}=== Health Check Summary ===${NC}"
echo -e "  Total checks:  ${TOTAL_COUNT}"
echo -e "  ${GREEN}Passed:${NC}        ${PASS_COUNT}"
echo -e "  ${RED}Failed:${NC}        ${FAIL_COUNT}"
echo -e "  ${YELLOW}Warnings:${NC}      ${WARN_COUNT}"
echo ""

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "${RED}${BOLD}HEALTH CHECK FAILED${NC} - $FAIL_COUNT check(s) failed"
  echo -e "Refer to RUNBOOK.md for troubleshooting steps."
  exit 1
elif [ "$WARN_COUNT" -gt 0 ]; then
  echo -e "${YELLOW}${BOLD}HEALTH CHECK PASSED WITH WARNINGS${NC} - $WARN_COUNT warning(s)"
  exit 0
else
  echo -e "${GREEN}${BOLD}ALL HEALTH CHECKS PASSED${NC}"
  exit 0
fi
