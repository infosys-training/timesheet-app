#!/usr/bin/env bash
#
# Health Check Script for Timesheet App
#
# Tests all critical API endpoints and reports pass/fail status.
# Exit code 0 = all checks passed, 1 = one or more checks failed.
#
# Usage:
#   ./scripts/health-check.sh                  # defaults to http://localhost:3001
#   ./scripts/health-check.sh https://app.example.com
#   HEALTH_CHECK_EMAIL=test@example.com ./scripts/health-check.sh

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="${HEALTH_CHECK_EMAIL:-healthcheck@timesheet-app.example.com}"

# Strip trailing slash
BASE_URL="${BASE_URL%/}"

PASSED=0
FAILED=0
TOTAL=0

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  GREEN=''
  RED=''
  YELLOW=''
  BOLD=''
  NC=''
fi

check() {
  local name="$1"
  local method="$2"
  local url="$3"
  local expected_status="$4"
  local data="${5:-}"

  TOTAL=$((TOTAL + 1))

  local curl_args=(
    -s
    -o /dev/null
    -w "%{http_code}"
    --max-time 10
    -X "$method"
    -H "Content-Type: application/json"
    -H "x-user-email: ${TEST_EMAIL}"
  )

  if [ -n "$data" ]; then
    curl_args+=(-d "$data")
  fi

  local actual_status
  actual_status=$(curl "${curl_args[@]}" "$url" 2>/dev/null) || actual_status="000"

  if [ "$actual_status" = "$expected_status" ]; then
    PASSED=$((PASSED + 1))
    printf "  ${GREEN}PASS${NC}  %-45s %s (expected %s)\n" "$name" "$actual_status" "$expected_status"
  else
    FAILED=$((FAILED + 1))
    printf "  ${RED}FAIL${NC}  %-45s %s (expected %s)\n" "$name" "$actual_status" "$expected_status"
  fi
}

check_response_contains() {
  local name="$1"
  local url="$2"
  local expected_field="$3"

  TOTAL=$((TOTAL + 1))

  local response
  response=$(curl -s --max-time 10 \
    -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    "$url" 2>/dev/null) || response=""

  if echo "$response" | grep -q "$expected_field"; then
    PASSED=$((PASSED + 1))
    printf "  ${GREEN}PASS${NC}  %-45s response contains '%s'\n" "$name" "$expected_field"
  else
    FAILED=$((FAILED + 1))
    printf "  ${RED}FAIL${NC}  %-45s response missing '%s'\n" "$name" "$expected_field"
  fi
}

echo ""
printf "${BOLD}Timesheet App Health Check${NC}\n"
printf "Target: ${BOLD}%s${NC}\n" "$BASE_URL"
printf "Time:   %s\n" "$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "─────────────────────────────────────────────────────────────────"

# ── 1. Core health endpoint ──────────────────────────────────────────
echo ""
printf "${BOLD}Core Health${NC}\n"
check "GET /health" \
  GET "${BASE_URL}/health" "200"

check_response_contains "GET /health body" \
  "${BASE_URL}/health" '"status":"OK"'

# ── 2. Authentication endpoints ──────────────────────────────────────
echo ""
printf "${BOLD}Authentication${NC}\n"
# Login returns 200 for existing users, 201 for new users — both are valid
LOGIN_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  -d "{\"email\":\"${TEST_EMAIL}\"}" \
  "${BASE_URL}/api/auth/login" 2>/dev/null) || LOGIN_STATUS="000"
TOTAL=$((TOTAL + 1))
if [ "$LOGIN_STATUS" = "200" ] || [ "$LOGIN_STATUS" = "201" ]; then
  PASSED=$((PASSED + 1))
  printf "  ${GREEN}PASS${NC}  %-45s %s (expected 200 or 201)\n" "POST /api/auth/login" "$LOGIN_STATUS"
else
  FAILED=$((FAILED + 1))
  printf "  ${RED}FAIL${NC}  %-45s %s (expected 200 or 201)\n" "POST /api/auth/login" "$LOGIN_STATUS"
fi

check "GET /api/auth/me (authenticated)" \
  GET "${BASE_URL}/api/auth/me" "200"

# No-auth check: send without x-user-email header
NO_AUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -H "Content-Type: application/json" \
  "${BASE_URL}/api/auth/me" 2>/dev/null) || NO_AUTH_STATUS="000"
TOTAL=$((TOTAL + 1))
if [ "$NO_AUTH_STATUS" = "401" ]; then
  PASSED=$((PASSED + 1))
  printf "  ${GREEN}PASS${NC}  %-45s %s (expected 401)\n" "GET /api/auth/me (no auth header)" "$NO_AUTH_STATUS"
else
  FAILED=$((FAILED + 1))
  printf "  ${RED}FAIL${NC}  %-45s %s (expected 401)\n" "GET /api/auth/me (no auth header)" "$NO_AUTH_STATUS"
fi

# ── 3. Client endpoints ─────────────────────────────────────────────
echo ""
printf "${BOLD}Clients API${NC}\n"
check "GET /api/clients" \
  GET "${BASE_URL}/api/clients" "200"

check "POST /api/clients (create)" \
  POST "${BASE_URL}/api/clients" "201" \
  '{"name":"HealthCheck Test Client","description":"Automated health check"}'

# Get the created client ID for further tests
CLIENT_RESPONSE=$(curl -s --max-time 10 \
  -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BASE_URL}/api/clients" 2>/dev/null) || CLIENT_RESPONSE=""
CLIENT_ID=$(echo "$CLIENT_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*') || CLIENT_ID=""

if [ -n "$CLIENT_ID" ]; then
  check "GET /api/clients/:id" \
    GET "${BASE_URL}/api/clients/${CLIENT_ID}" "200"

  check "PUT /api/clients/:id (update)" \
    PUT "${BASE_URL}/api/clients/${CLIENT_ID}" "200" \
    '{"name":"HealthCheck Updated Client"}'
fi

check "POST /api/clients (validation error)" \
  POST "${BASE_URL}/api/clients" "400" \
  '{}'

# ── 4. Work entries endpoints ────────────────────────────────────────
echo ""
printf "${BOLD}Work Entries API${NC}\n"
check "GET /api/work-entries" \
  GET "${BASE_URL}/api/work-entries" "200"

if [ -n "$CLIENT_ID" ]; then
  check "POST /api/work-entries (create)" \
    POST "${BASE_URL}/api/work-entries" "201" \
    "{\"clientId\":${CLIENT_ID},\"hours\":2.5,\"description\":\"Health check test\",\"date\":\"2025-01-15\"}"

  # Get the created work entry ID
  ENTRIES_RESPONSE=$(curl -s --max-time 10 \
    -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/work-entries" 2>/dev/null) || ENTRIES_RESPONSE=""
  ENTRY_ID=$(echo "$ENTRIES_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*') || ENTRY_ID=""

  if [ -n "$ENTRY_ID" ]; then
    check "GET /api/work-entries/:id" \
      GET "${BASE_URL}/api/work-entries/${ENTRY_ID}" "200"
  fi
fi

check "POST /api/work-entries (validation error)" \
  POST "${BASE_URL}/api/work-entries" "400" \
  '{}'

# ── 5. Reports endpoints ────────────────────────────────────────────
echo ""
printf "${BOLD}Reports API${NC}\n"
if [ -n "$CLIENT_ID" ]; then
  check "GET /api/reports/client/:id" \
    GET "${BASE_URL}/api/reports/client/${CLIENT_ID}" "200"

  check_response_contains "Report contains totalHours" \
    "${BASE_URL}/api/reports/client/${CLIENT_ID}" '"totalHours"'

  # CSV export
  CSV_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/reports/export/csv/${CLIENT_ID}" 2>/dev/null) || CSV_STATUS="000"
  TOTAL=$((TOTAL + 1))
  if [ "$CSV_STATUS" = "200" ]; then
    PASSED=$((PASSED + 1))
    printf "  ${GREEN}PASS${NC}  %-45s %s (expected 200)\n" "GET /api/reports/export/csv/:id" "$CSV_STATUS"
  else
    FAILED=$((FAILED + 1))
    printf "  ${RED}FAIL${NC}  %-45s %s (expected 200)\n" "GET /api/reports/export/csv/:id" "$CSV_STATUS"
  fi

  # PDF export
  PDF_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/reports/export/pdf/${CLIENT_ID}" 2>/dev/null) || PDF_STATUS="000"
  TOTAL=$((TOTAL + 1))
  if [ "$PDF_STATUS" = "200" ]; then
    PASSED=$((PASSED + 1))
    printf "  ${GREEN}PASS${NC}  %-45s %s (expected 200)\n" "GET /api/reports/export/pdf/:id" "$PDF_STATUS"
  else
    FAILED=$((FAILED + 1))
    printf "  ${RED}FAIL${NC}  %-45s %s (expected 200)\n" "GET /api/reports/export/pdf/:id" "$PDF_STATUS"
  fi
fi

# ── 6. Error handling ────────────────────────────────────────────────
echo ""
printf "${BOLD}Error Handling${NC}\n"
check "GET /nonexistent (404)" \
  GET "${BASE_URL}/nonexistent" "404"

check "GET /api/clients/invalid (400)" \
  GET "${BASE_URL}/api/clients/abc" "400"

# ── 7. Cleanup test data ────────────────────────────────────────────
if [ -n "${CLIENT_ID:-}" ]; then
  # Delete work entries first (cascade may handle this, but be explicit)
  if [ -n "${ENTRY_ID:-}" ]; then
    curl -s -o /dev/null -X DELETE \
      -H "x-user-email: ${TEST_EMAIL}" \
      "${BASE_URL}/api/work-entries/${ENTRY_ID}" 2>/dev/null || true
  fi
  # Delete test client
  curl -s -o /dev/null -X DELETE \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/clients/${CLIENT_ID}" 2>/dev/null || true
fi

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────────────────────────"
printf "${BOLD}Results: %d/%d passed${NC}" "$PASSED" "$TOTAL"

if [ "$FAILED" -gt 0 ]; then
  printf " (${RED}%d failed${NC})" "$FAILED"
fi

echo ""
echo ""

if [ "$FAILED" -gt 0 ]; then
  printf "${RED}${BOLD}HEALTH CHECK FAILED${NC}\n"
  echo "Refer to RUNBOOK.md for diagnosis and resolution steps."
  exit 1
else
  printf "${GREEN}${BOLD}ALL CHECKS PASSED${NC}\n"
  exit 0
fi
