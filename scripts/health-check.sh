#!/usr/bin/env bash
#
# Health Check Script — Timesheet App
#
# Tests all critical endpoints and reports pass/fail status.
# Exit code 0 = all checks passed, non-zero = at least one check failed.
#
# Usage:
#   ./scripts/health-check.sh                    # defaults to http://localhost:3001
#   ./scripts/health-check.sh https://app.example.com
#   BASE_URL=http://localhost:3001 ./scripts/health-check.sh
#

set -uo pipefail

BASE_URL="${1:-${BASE_URL:-http://localhost:3001}}"
TEST_EMAIL="healthcheck@timesheet-app.com"
TIMEOUT=10
FAILURES=0
TOTAL=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_header() {
  echo ""
  echo "============================================"
  echo " Timesheet App Health Check"
  echo " Target: ${BASE_URL}"
  echo " Time:   $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  echo "============================================"
  echo ""
}

# check_endpoint METHOD PATH DESCRIPTION EXPECTED_STATUS [DATA]
# DATA is the JSON body for POST requests
check_endpoint() {
  local method="$1"
  local path="$2"
  local description="$3"
  local expected_status="$4"
  local data="${5:-}"

  TOTAL=$((TOTAL + 1))

  local url="${BASE_URL}${path}"
  local response
  local http_code
  local response_time

  if [ "$method" = "GET" ]; then
    response=$(curl -s -o /dev/null -w "%{http_code}|%{time_total}" \
      --max-time "$TIMEOUT" \
      -H "x-user-email: ${TEST_EMAIL}" \
      "$url" 2>/dev/null) || response="000|0"
  elif [ "$method" = "POST" ]; then
    response=$(curl -s -o /dev/null -w "%{http_code}|%{time_total}" \
      --max-time "$TIMEOUT" \
      -X POST \
      -H "Content-Type: application/json" \
      -H "x-user-email: ${TEST_EMAIL}" \
      -d "$data" \
      "$url" 2>/dev/null) || response="000|0"
  fi

  http_code=$(echo "$response" | cut -d'|' -f1)
  response_time=$(echo "$response" | cut -d'|' -f2)

  # Support pipe-separated expected statuses (e.g., "200|201")
  local match=false
  IFS='|' read -ra EXPECTED_CODES <<< "$expected_status"
  for code in "${EXPECTED_CODES[@]}"; do
    if [ "$http_code" = "$code" ]; then
      match=true
      break
    fi
  done

  if [ "$match" = true ]; then
    printf "${GREEN}[PASS]${NC} %-45s (HTTP %s, %.3fs)\n" "$description" "$http_code" "$response_time"
  else
    printf "${RED}[FAIL]${NC} %-45s (HTTP %s, expected %s, %.3fs)\n" "$description" "$http_code" "$expected_status" "$response_time"
    FAILURES=$((FAILURES + 1))
  fi
}

check_response_body() {
  local path="$1"
  local description="$2"
  local expected_field="$3"

  TOTAL=$((TOTAL + 1))

  local url="${BASE_URL}${path}"
  local body
  local http_code

  body=$(curl -s -w "\n%{http_code}" \
    --max-time "$TIMEOUT" \
    -H "x-user-email: ${TEST_EMAIL}" \
    "$url" 2>/dev/null) || body=$'\n000'

  http_code=$(echo "$body" | tail -1)
  body=$(echo "$body" | sed '$d')

  if echo "$body" | grep -q "$expected_field"; then
    printf "${GREEN}[PASS]${NC} %-45s (body contains '%s')\n" "$description" "$expected_field"
  else
    printf "${RED}[FAIL]${NC} %-45s (missing '%s' in response)\n" "$description" "$expected_field"
    FAILURES=$((FAILURES + 1))
  fi
}

check_connectivity() {
  TOTAL=$((TOTAL + 1))

  local host
  host=$(echo "$BASE_URL" | sed 's|https\?://||' | cut -d':' -f1 | cut -d'/' -f1)
  local port
  port=$(echo "$BASE_URL" | grep -oP ':\K[0-9]+' || echo "80")

  if timeout "$TIMEOUT" bash -c "echo >/dev/tcp/${host}/${port}" 2>/dev/null; then
    printf "${GREEN}[PASS]${NC} %-45s (port %s open)\n" "TCP connectivity" "$port"
  else
    printf "${RED}[FAIL]${NC} %-45s (port %s unreachable)\n" "TCP connectivity" "$port"
    FAILURES=$((FAILURES + 1))
  fi
}

check_response_time() {
  local path="$1"
  local description="$2"
  local max_ms="$3"

  TOTAL=$((TOTAL + 1))

  local url="${BASE_URL}${path}"
  local response_time

  response_time=$(curl -s -o /dev/null -w "%{time_total}" \
    --max-time "$TIMEOUT" \
    -H "x-user-email: ${TEST_EMAIL}" \
    "$url" 2>/dev/null) || response_time="999"

  # Convert seconds to milliseconds using awk (avoids bc dependency)
  local ms
  ms=$(awk "BEGIN {printf \"%d\", $response_time * 1000}")

  if [ "$ms" -le "$max_ms" ]; then
    printf "${GREEN}[PASS]${NC} %-45s (%sms < %sms threshold)\n" "$description" "$ms" "$max_ms"
  else
    printf "${YELLOW}[WARN]${NC} %-45s (%sms > %sms threshold)\n" "$description" "$ms" "$max_ms"
    FAILURES=$((FAILURES + 1))
  fi
}

# ─── Run Checks ─────────────────────────────────────────────────────────────

print_header

echo "── Connectivity ──"
check_connectivity

echo ""
echo "── Core Health ──"
check_endpoint "GET" "/health" "Health endpoint" "200"
check_response_body "/health" "Health response body" '"status":"OK"'

echo ""
echo "── Authentication ──"
check_endpoint "POST" "/api/auth/login" "Auth login (valid email)" "200|201" "{\"email\":\"${TEST_EMAIL}\"}"
check_endpoint "POST" "/api/auth/login" "Auth login (invalid payload)" "400" "{\"email\":\"not-an-email\"}"
check_endpoint "GET" "/api/auth/me" "Auth me (with header)" "200"

echo ""
echo "── Client Endpoints ──"
check_endpoint "GET" "/api/clients" "List clients" "200"
check_endpoint "POST" "/api/clients" "Create client (valid)" "201" "{\"name\":\"HealthCheck Test Client\"}"
check_endpoint "POST" "/api/clients" "Create client (invalid - empty name)" "400" "{\"name\":\"\"}"

echo ""
echo "── Work Entry Endpoints ──"
check_endpoint "GET" "/api/work-entries" "List work entries" "200"

echo ""
echo "── Report Endpoints ──"
check_endpoint "GET" "/api/reports/client/999999" "Report for non-existent client" "404"

echo ""
echo "── Error Handling ──"
check_endpoint "GET" "/nonexistent-route" "404 handler" "404"
check_endpoint "GET" "/api/clients/invalid" "Invalid ID parameter" "400"

echo ""
echo "── Performance ──"
check_response_time "/health" "Health endpoint response time" "500"
check_response_time "/api/clients" "Clients endpoint response time" "1000"

echo ""
echo "── Security Headers ──"
TOTAL=$((TOTAL + 1))
HEADERS=$(curl -s -I --max-time "$TIMEOUT" "${BASE_URL}/health" 2>/dev/null)
if echo "$HEADERS" | grep -qi "x-content-type-options"; then
  printf "${GREEN}[PASS]${NC} %-45s\n" "Helmet security headers present"
else
  printf "${RED}[FAIL]${NC} %-45s\n" "Helmet security headers missing"
  FAILURES=$((FAILURES + 1))
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "============================================"
if [ "$FAILURES" -eq 0 ]; then
  printf " Result: ${GREEN}ALL %d CHECKS PASSED${NC}\n" "$TOTAL"
else
  printf " Result: ${RED}%d/%d CHECKS FAILED${NC}\n" "$FAILURES" "$TOTAL"
fi
echo "============================================"
echo ""

exit "$FAILURES"
