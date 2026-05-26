#!/usr/bin/env bash
#
# Health Check Script for Timesheet App
#
# Tests all critical API endpoints and reports status.
# Exit code 0 = all checks pass, non-zero = one or more failures.
#
# Usage:
#   ./scripts/health-check.sh [BASE_URL]
#
# Examples:
#   ./scripts/health-check.sh                        # defaults to http://localhost:3001
#   ./scripts/health-check.sh http://prod.example.com
#
# Environment Variables:
#   HEALTH_CHECK_TIMEOUT  - curl timeout in seconds (default: 5)
#   HEALTH_CHECK_EMAIL    - test email for authenticated endpoints (default: healthcheck@test.com)
#

set -uo pipefail

# Configuration
BASE_URL="${1:-http://localhost:3001}"
TIMEOUT="${HEALTH_CHECK_TIMEOUT:-5}"
TEST_EMAIL="${HEALTH_CHECK_EMAIL:-healthcheck@test.com}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counters
PASS=0
FAIL=0
WARN=0

# Results array for summary
declare -a RESULTS=()

##############################################################################
# Helper functions
##############################################################################

check_endpoint() {
  local name="$1"
  local method="$2"
  local url="$3"
  local expected_status="$4"
  local headers="${5:-}"
  local body="${6:-}"

  local curl_args=(
    -s
    -o /dev/null
    -w "%{http_code}|%{time_total}"
    --max-time "$TIMEOUT"
    -X "$method"
  )

  if [[ -n "$headers" ]]; then
    while IFS= read -r header; do
      [[ -n "$header" ]] && curl_args+=(-H "$header")
    done <<< "$headers"
  fi

  if [[ -n "$body" ]]; then
    curl_args+=(-H "Content-Type: application/json" -d "$body")
  fi

  curl_args+=("${BASE_URL}${url}")

  local response
  if response=$(curl "${curl_args[@]}" 2>/dev/null); then
    local status_code="${response%%|*}"
    local response_time="${response##*|}"

    if [[ "$status_code" == "$expected_status" ]]; then
      printf "${GREEN}  ✓ PASS${NC} %-45s [%s] %ss\n" "$name" "$status_code" "$response_time"
      RESULTS+=("PASS|$name|$status_code|$response_time")
      PASS=$((PASS + 1))
    else
      printf "${RED}  ✗ FAIL${NC} %-45s [%s expected %s] %ss\n" "$name" "$status_code" "$expected_status" "$response_time"
      RESULTS+=("FAIL|$name|$status_code|$response_time")
      FAIL=$((FAIL + 1))
    fi
  else
    printf "${RED}  ✗ FAIL${NC} %-45s [timeout/connection error]\n" "$name"
    RESULTS+=("FAIL|$name|timeout|0")
    FAIL=$((FAIL + 1))
  fi
}

check_endpoint_body() {
  local name="$1"
  local method="$2"
  local url="$3"
  local expected_status="$4"
  local expected_body_pattern="$5"
  local headers="${6:-}"
  local body="${7:-}"

  local curl_args=(
    -s
    -w "\n%{http_code}|%{time_total}"
    --max-time "$TIMEOUT"
    -X "$method"
  )

  if [[ -n "$headers" ]]; then
    while IFS= read -r header; do
      [[ -n "$header" ]] && curl_args+=(-H "$header")
    done <<< "$headers"
  fi

  if [[ -n "$body" ]]; then
    curl_args+=(-H "Content-Type: application/json" -d "$body")
  fi

  curl_args+=("${BASE_URL}${url}")

  local response
  if response=$(curl "${curl_args[@]}" 2>/dev/null); then
    local last_line="${response##*$'\n'}"
    local response_body="${response%$'\n'*}"
    local status_code="${last_line%%|*}"
    local response_time="${last_line##*|}"

    if [[ "$status_code" == "$expected_status" ]] && echo "$response_body" | grep -q "$expected_body_pattern"; then
      printf "${GREEN}  ✓ PASS${NC} %-45s [%s] %ss\n" "$name" "$status_code" "$response_time"
      RESULTS+=("PASS|$name|$status_code|$response_time")
      PASS=$((PASS + 1))
    elif [[ "$status_code" != "$expected_status" ]]; then
      printf "${RED}  ✗ FAIL${NC} %-45s [%s expected %s] %ss\n" "$name" "$status_code" "$expected_status" "$response_time"
      RESULTS+=("FAIL|$name|$status_code|$response_time")
      FAIL=$((FAIL + 1))
    else
      printf "${RED}  ✗ FAIL${NC} %-45s [body mismatch] %ss\n" "$name" "$response_time"
      RESULTS+=("FAIL|$name|body_mismatch|$response_time")
      FAIL=$((FAIL + 1))
    fi
  else
    printf "${RED}  ✗ FAIL${NC} %-45s [timeout/connection error]\n" "$name"
    RESULTS+=("FAIL|$name|timeout|0")
    FAIL=$((FAIL + 1))
  fi
}

print_separator() {
  echo "────────────────────────────────────────────────────────────────────────"
}

##############################################################################
# Main
##############################################################################

echo ""
echo "╔══════════════════════════════════════════════════════════════════════════╗"
echo "║            Timesheet App — Health Check Report                          ║"
echo "╚══════════════════════════════════════════════════════════════════════════╝"
echo ""
echo "  Target:    $BASE_URL"
echo "  Timeout:   ${TIMEOUT}s"
echo "  Timestamp: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# 1. Core Health
# ─────────────────────────────────────────────────────────────────────────────
print_separator
echo "  CORE HEALTH"
print_separator

check_endpoint_body \
  "GET /health" \
  "GET" \
  "/health" \
  "200" \
  '"status":"OK"'

# ─────────────────────────────────────────────────────────────────────────────
# 2. Authentication Endpoints
# ─────────────────────────────────────────────────────────────────────────────
print_separator
echo "  AUTHENTICATION"
print_separator

# First login may return 201 (new user) or 200 (existing) — both are valid
LOGIN_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\"}" \
  "${BASE_URL}/api/auth/login" 2>/dev/null || echo "000")

if [[ "$LOGIN_STATUS" == "200" || "$LOGIN_STATUS" == "201" ]]; then
  printf "${GREEN}  ✓ PASS${NC} %-45s [%s]\n" "POST /api/auth/login (valid email)" "$LOGIN_STATUS"
  RESULTS+=("PASS|POST /api/auth/login (valid email)|$LOGIN_STATUS|0")
  PASS=$((PASS + 1))
else
  printf "${RED}  ✗ FAIL${NC} %-45s [%s expected 200/201]\n" "POST /api/auth/login (valid email)" "$LOGIN_STATUS"
  RESULTS+=("FAIL|POST /api/auth/login (valid email)|$LOGIN_STATUS|0")
  FAIL=$((FAIL + 1))
fi

check_endpoint \
  "POST /api/auth/login (invalid email)" \
  "POST" \
  "/api/auth/login" \
  "400" \
  "" \
  '{"email":"not-an-email"}'

check_endpoint \
  "GET /api/auth/me (authenticated)" \
  "GET" \
  "/api/auth/me" \
  "200" \
  "x-user-email: $TEST_EMAIL"

check_endpoint \
  "GET /api/auth/me (no auth header)" \
  "GET" \
  "/api/auth/me" \
  "401"

# ─────────────────────────────────────────────────────────────────────────────
# 3. Clients API
# ─────────────────────────────────────────────────────────────────────────────
print_separator
echo "  CLIENTS API"
print_separator

check_endpoint \
  "GET /api/clients (authenticated)" \
  "GET" \
  "/api/clients" \
  "200" \
  "x-user-email: $TEST_EMAIL"

check_endpoint \
  "GET /api/clients (no auth)" \
  "GET" \
  "/api/clients" \
  "401"

check_endpoint \
  "POST /api/clients (create)" \
  "POST" \
  "/api/clients" \
  "201" \
  "x-user-email: $TEST_EMAIL" \
  '{"name":"HealthCheck Test Client","description":"Created by health check script"}'

# ─────────────────────────────────────────────────────────────────────────────
# 4. Work Entries API
# ─────────────────────────────────────────────────────────────────────────────
print_separator
echo "  WORK ENTRIES API"
print_separator

check_endpoint \
  "GET /api/work-entries (authenticated)" \
  "GET" \
  "/api/work-entries" \
  "200" \
  "x-user-email: $TEST_EMAIL"

check_endpoint \
  "GET /api/work-entries (no auth)" \
  "GET" \
  "/api/work-entries" \
  "401"

# ─────────────────────────────────────────────────────────────────────────────
# 5. Reports API
# ─────────────────────────────────────────────────────────────────────────────
print_separator
echo "  REPORTS API"
print_separator

check_endpoint \
  "GET /api/reports/client/1 (authenticated)" \
  "GET" \
  "/api/reports/client/1" \
  "200" \
  "x-user-email: $TEST_EMAIL"

check_endpoint \
  "GET /api/reports/client/999 (not found)" \
  "GET" \
  "/api/reports/client/999" \
  "404" \
  "x-user-email: $TEST_EMAIL"

check_endpoint \
  "GET /api/reports/export/csv/1 (authenticated)" \
  "GET" \
  "/api/reports/export/csv/1" \
  "200" \
  "x-user-email: $TEST_EMAIL"

check_endpoint \
  "GET /api/reports/export/pdf/1 (authenticated)" \
  "GET" \
  "/api/reports/export/pdf/1" \
  "200" \
  "x-user-email: $TEST_EMAIL"

# ─────────────────────────────────────────────────────────────────────────────
# 6. Error Handling
# ─────────────────────────────────────────────────────────────────────────────
print_separator
echo "  ERROR HANDLING"
print_separator

check_endpoint \
  "GET /nonexistent-route (404)" \
  "GET" \
  "/nonexistent-route" \
  "404"

check_endpoint \
  "GET /api/clients/abc (invalid ID)" \
  "GET" \
  "/api/clients/abc" \
  "400" \
  "x-user-email: $TEST_EMAIL"

# ─────────────────────────────────────────────────────────────────────────────
# 7. Response Time Check
# ─────────────────────────────────────────────────────────────────────────────
print_separator
echo "  RESPONSE TIME"
print_separator

HEALTH_TIME=$(curl -s -o /dev/null -w "%{time_total}" --max-time "$TIMEOUT" "${BASE_URL}/health" 2>/dev/null || echo "0")
if (( $(echo "$HEALTH_TIME > 0 && $HEALTH_TIME < 1.0" | bc -l 2>/dev/null || echo "0") )); then
  printf "${GREEN}  ✓ PASS${NC} %-45s [%ss < 1.0s threshold]\n" "Health endpoint response time" "$HEALTH_TIME"
  PASS=$((PASS + 1))
elif (( $(echo "$HEALTH_TIME >= 1.0" | bc -l 2>/dev/null || echo "0") )); then
  printf "${YELLOW}  ⚠ WARN${NC} %-45s [%ss >= 1.0s threshold]\n" "Health endpoint response time" "$HEALTH_TIME"
  WARN=$((WARN + 1))
else
  printf "${RED}  ✗ FAIL${NC} %-45s [unreachable]\n" "Health endpoint response time"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
echo ""
print_separator
echo "  SUMMARY"
print_separator
echo ""
printf "  Total checks: %d\n" $((PASS + FAIL + WARN))
printf "  ${GREEN}Passed:${NC}  %d\n" "$PASS"
printf "  ${RED}Failed:${NC}  %d\n" "$FAIL"
printf "  ${YELLOW}Warnings:${NC} %d\n" "$WARN"
echo ""

if [[ $FAIL -gt 0 ]]; then
  printf "  ${RED}STATUS: UNHEALTHY${NC} — %d check(s) failed\n" "$FAIL"
  echo ""
  echo "  Failed checks:"
  for result in "${RESULTS[@]}"; do
    IFS='|' read -r status name code time <<< "$result"
    if [[ "$status" == "FAIL" ]]; then
      printf "    • %s [%s]\n" "$name" "$code"
    fi
  done
  echo ""
  echo "  Refer to RUNBOOK.md for troubleshooting procedures."
  echo ""
  exit 1
elif [[ $WARN -gt 0 ]]; then
  printf "  ${YELLOW}STATUS: DEGRADED${NC} — %d warning(s)\n" "$WARN"
  echo ""
  exit 0
else
  printf "  ${GREEN}STATUS: HEALTHY${NC} — all checks passed\n"
  echo ""
  exit 0
fi
