#!/usr/bin/env bash
#
# Health Check Script for Timesheet App
#
# Tests all critical endpoints and reports their status.
# Exit code 0 = all checks passed, non-zero = failures detected.
#
# Usage:
#   ./scripts/healthcheck.sh [BASE_URL]
#
# Examples:
#   ./scripts/healthcheck.sh                          # defaults to http://localhost:3001
#   ./scripts/healthcheck.sh http://prod.example.com  # custom base URL
#

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="healthcheck@timesheet-app.com"
TIMEOUT=10
PASSED=0
FAILED=0
WARNINGS=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color
BOLD='\033[1m'

echo -e "${BOLD}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     Timesheet App - Health Check Report          ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo "Target: ${BASE_URL}"
echo "Time:   $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

check_endpoint() {
  local method="$1"
  local path="$2"
  local description="$3"
  local expected_status="$4"
  local headers="${5:-}"
  local body="${6:-}"

  local url="${BASE_URL}${path}"
  local curl_args=(-s -o /tmp/healthcheck_response -w "%{http_code}|%{time_total}" --max-time "$TIMEOUT")

  if [[ -n "$headers" ]]; then
    while IFS= read -r header; do
      [[ -n "$header" ]] && curl_args+=(-H "$header")
    done <<< "$headers"
  fi

  if [[ "$method" == "POST" ]]; then
    curl_args+=(-X POST)
    if [[ -n "$body" ]]; then
      curl_args+=(-H "Content-Type: application/json" -d "$body")
    fi
  fi

  local result
  result=$(curl "${curl_args[@]}" "$url" 2>/dev/null) || true

  local status_code="${result%%|*}"
  local response_time="${result##*|}"

  # Check if we got a response at all
  if [[ -z "$status_code" || "$status_code" == "000" ]]; then
    echo -e "  ${RED}✗ FAIL${NC} ${description}"
    echo -e "         → Connection refused or timeout (${TIMEOUT}s)"
    ((FAILED++))
    return 1
  fi

  # Check response time warning (>2s)
  local time_warning=""
  if command -v bc &>/dev/null; then
    if (( $(echo "$response_time > 2.0" | bc -l 2>/dev/null || echo 0) )); then
      time_warning=" ${YELLOW}[SLOW: ${response_time}s]${NC}"
      ((WARNINGS++))
    fi
  fi

  # Check status code (expected_status can be comma-separated, e.g. "200,201")
  local match=false
  IFS=',' read -ra expected_codes <<< "$expected_status"
  for code in "${expected_codes[@]}"; do
    if [[ "$status_code" == "$code" ]]; then
      match=true
      break
    fi
  done

  if [[ "$match" == "true" ]]; then
    echo -e "  ${GREEN}✓ PASS${NC} ${description} (${status_code}, ${response_time}s)${time_warning}"
    ((PASSED++))
    return 0
  else
    echo -e "  ${RED}✗ FAIL${NC} ${description}"
    echo -e "         → Expected ${expected_status}, got ${status_code} (${response_time}s)"
    # Show response body for debugging (truncated)
    local resp_body
    resp_body=$(cat /tmp/healthcheck_response 2>/dev/null | head -c 200)
    if [[ -n "$resp_body" ]]; then
      echo -e "         → Response: ${resp_body}"
    fi
    ((FAILED++))
    return 1
  fi
}

# ─────────────────────────────────────────────────────────
# Section 1: Core Health
# ─────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[1/5] Core Health${NC}"

check_endpoint "GET" "/health" \
  "Health endpoint" "200" || true

# ─────────────────────────────────────────────────────────
# Section 2: Authentication
# ─────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[2/5] Authentication${NC}"

check_endpoint "POST" "/api/auth/login" \
  "Login endpoint" "200,201" "" \
  "{\"email\": \"${TEST_EMAIL}\"}" || true

check_endpoint "GET" "/api/auth/me" \
  "Current user (authenticated)" "200" \
  "x-user-email: ${TEST_EMAIL}" || true

check_endpoint "GET" "/api/auth/me" \
  "Reject missing auth header" "401" || true

check_endpoint "GET" "/api/auth/me" \
  "Reject invalid email format" "400" \
  "x-user-email: not-an-email" || true

# ─────────────────────────────────────────────────────────
# Section 3: Client Management API
# ─────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[3/5] Client Management API${NC}"

check_endpoint "GET" "/api/clients" \
  "List clients" "200" \
  "x-user-email: ${TEST_EMAIL}" || true

check_endpoint "POST" "/api/clients" \
  "Create client (valid)" "201" \
  "x-user-email: ${TEST_EMAIL}" \
  "{\"name\": \"Health Check Test Client\"}" || true

check_endpoint "POST" "/api/clients" \
  "Create client (invalid - missing name)" "400" \
  "x-user-email: ${TEST_EMAIL}" \
  "{}" || true

check_endpoint "GET" "/api/clients" \
  "List clients (no auth)" "401" || true

# ─────────────────────────────────────────────────────────
# Section 4: Work Entries API
# ─────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[4/5] Work Entries API${NC}"

check_endpoint "GET" "/api/work-entries" \
  "List work entries" "200" \
  "x-user-email: ${TEST_EMAIL}" || true

check_endpoint "GET" "/api/work-entries" \
  "List work entries (no auth)" "401" || true

# ─────────────────────────────────────────────────────────
# Section 5: Reports API
# ─────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[5/5] Reports API${NC}"

check_endpoint "GET" "/api/reports/client/999999" \
  "Report for non-existent client" "404" \
  "x-user-email: ${TEST_EMAIL}" || true

check_endpoint "GET" "/api/reports/client/abc" \
  "Report with invalid client ID" "400" \
  "x-user-email: ${TEST_EMAIL}" || true

# ─────────────────────────────────────────────────────────
# Section 6: Error Handling
# ─────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[Bonus] Error Handling & Edge Cases${NC}"

check_endpoint "GET" "/api/nonexistent-route" \
  "404 for unknown API route" "404" \
  "x-user-email: ${TEST_EMAIL}" || true

# ─────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
TOTAL=$((PASSED + FAILED))
echo -e "${BOLD}Results:${NC} ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}, ${YELLOW}${WARNINGS} warnings${NC} (${TOTAL} total)"
echo ""

if [[ $FAILED -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}All health checks passed!${NC}"
  exit 0
else
  echo -e "${RED}${BOLD}${FAILED} health check(s) failed. See RUNBOOK.md for troubleshooting.${NC}"
  exit 1
fi
