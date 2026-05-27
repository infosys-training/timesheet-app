#!/usr/bin/env bash
#
# Health Check Script for Timesheet App
#
# Tests all critical backend endpoints and reports status.
# Exit code 0 = all checks passed, 1 = one or more checks failed.
#
# Usage:
#   ./scripts/healthcheck.sh                  # defaults to http://localhost:3001
#   ./scripts/healthcheck.sh http://prod:3001 # custom base URL
#   HEALTHCHECK_EMAIL=me@co.com ./scripts/healthcheck.sh  # custom test email

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="${HEALTHCHECK_EMAIL:-healthcheck@timesheet-app.example.com}"

# Colors (disabled when stdout is not a terminal)
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' BOLD='' NC=''
fi

PASS=0
FAIL=0
WARN=0
RESULTS=()

# ──────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────

check_pass() {
  PASS=$((PASS + 1))
  RESULTS+=("${GREEN}PASS${NC}  $1")
}

check_fail() {
  FAIL=$((FAIL + 1))
  RESULTS+=("${RED}FAIL${NC}  $1  —  $2")
}

check_warn() {
  WARN=$((WARN + 1))
  RESULTS+=("${YELLOW}WARN${NC}  $1  —  $2")
}

# Make an HTTP request and capture status code + body.
# Usage: http_request METHOD URL [EXTRA_CURL_ARGS...]
# Sets: HTTP_STATUS, HTTP_BODY
http_request() {
  local method="$1"
  local url="$2"
  shift 2

  local tmp
  tmp=$(mktemp)
  HTTP_STATUS=$(curl -s -o "$tmp" -w "%{http_code}" \
    -X "$method" \
    --connect-timeout 5 \
    --max-time 10 \
    "$@" \
    "$url") || HTTP_STATUS="000"
  HTTP_BODY=$(cat "$tmp" 2>/dev/null | tr -d '\0' || true)
  rm -f "$tmp"
}

# ──────────────────────────────────────────────
# Checks
# ──────────────────────────────────────────────

echo -e "${BOLD}Timesheet App Health Check${NC}"
echo "Base URL: ${BASE_URL}"
echo "Test email: ${TEST_EMAIL}"
echo "──────────────────────────────────────────"

# 1. Health endpoint
echo -n "Checking health endpoint... "
http_request GET "${BASE_URL}/health"
if [ "$HTTP_STATUS" = "200" ]; then
  check_pass "GET /health (HTTP ${HTTP_STATUS})"
else
  check_fail "GET /health" "expected 200, got ${HTTP_STATUS}"
fi

# 2. Auth - Login
echo -n "Checking auth login... "
http_request POST "${BASE_URL}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"${TEST_EMAIL}\"}"
if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "201" ]; then
  check_pass "POST /api/auth/login (HTTP ${HTTP_STATUS})"
else
  check_fail "POST /api/auth/login" "expected 200/201, got ${HTTP_STATUS} — ${HTTP_BODY}"
fi

# 3. Auth - Get current user
echo -n "Checking auth me... "
http_request GET "${BASE_URL}/api/auth/me" \
  -H "x-user-email: ${TEST_EMAIL}"
if [ "$HTTP_STATUS" = "200" ]; then
  check_pass "GET /api/auth/me (HTTP ${HTTP_STATUS})"
else
  check_fail "GET /api/auth/me" "expected 200, got ${HTTP_STATUS}"
fi

# 4. Auth - Missing header returns 401
echo -n "Checking auth guard... "
http_request GET "${BASE_URL}/api/auth/me"
if [ "$HTTP_STATUS" = "401" ]; then
  check_pass "GET /api/auth/me (no header) returns 401"
else
  check_warn "GET /api/auth/me (no header)" "expected 401, got ${HTTP_STATUS}"
fi

# 5. Clients - List
echo -n "Checking clients list... "
http_request GET "${BASE_URL}/api/clients" \
  -H "x-user-email: ${TEST_EMAIL}"
if [ "$HTTP_STATUS" = "200" ]; then
  check_pass "GET /api/clients (HTTP ${HTTP_STATUS})"
else
  check_fail "GET /api/clients" "expected 200, got ${HTTP_STATUS}"
fi

# 6. Clients - Create
echo -n "Checking client creation... "
http_request POST "${BASE_URL}/api/clients" \
  -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  -d '{"name": "_healthcheck_test_client"}'
if [ "$HTTP_STATUS" = "201" ]; then
  check_pass "POST /api/clients (HTTP ${HTTP_STATUS})"
  # Extract client ID for subsequent tests
  CLIENT_ID=$(echo "$HTTP_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
else
  check_fail "POST /api/clients" "expected 201, got ${HTTP_STATUS}"
  CLIENT_ID=""
fi

# 7. Clients - Get by ID
if [ -n "${CLIENT_ID:-}" ]; then
  echo -n "Checking client get by ID... "
  http_request GET "${BASE_URL}/api/clients/${CLIENT_ID}" \
    -H "x-user-email: ${TEST_EMAIL}"
  if [ "$HTTP_STATUS" = "200" ]; then
    check_pass "GET /api/clients/${CLIENT_ID} (HTTP ${HTTP_STATUS})"
  else
    check_fail "GET /api/clients/${CLIENT_ID}" "expected 200, got ${HTTP_STATUS}"
  fi
fi

# 8. Work Entries - List
echo -n "Checking work entries list... "
http_request GET "${BASE_URL}/api/work-entries" \
  -H "x-user-email: ${TEST_EMAIL}"
if [ "$HTTP_STATUS" = "200" ]; then
  check_pass "GET /api/work-entries (HTTP ${HTTP_STATUS})"
else
  check_fail "GET /api/work-entries" "expected 200, got ${HTTP_STATUS}"
fi

# 9. Work Entries - Create
if [ -n "${CLIENT_ID:-}" ]; then
  echo -n "Checking work entry creation... "
  http_request POST "${BASE_URL}/api/work-entries" \
    -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    -d "{\"clientId\": ${CLIENT_ID}, \"hours\": 1, \"description\": \"healthcheck test\", \"date\": \"$(date -u +%Y-%m-%d)\"}"
  if [ "$HTTP_STATUS" = "201" ]; then
    check_pass "POST /api/work-entries (HTTP ${HTTP_STATUS})"
    ENTRY_ID=$(echo "$HTTP_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  else
    check_fail "POST /api/work-entries" "expected 201, got ${HTTP_STATUS}"
    ENTRY_ID=""
  fi
fi

# 10. Reports - Client report
if [ -n "${CLIENT_ID:-}" ]; then
  echo -n "Checking client report... "
  http_request GET "${BASE_URL}/api/reports/client/${CLIENT_ID}" \
    -H "x-user-email: ${TEST_EMAIL}"
  if [ "$HTTP_STATUS" = "200" ]; then
    check_pass "GET /api/reports/client/${CLIENT_ID} (HTTP ${HTTP_STATUS})"
  else
    check_fail "GET /api/reports/client/${CLIENT_ID}" "expected 200, got ${HTTP_STATUS}"
  fi
fi

# 11. Reports - CSV export
if [ -n "${CLIENT_ID:-}" ]; then
  echo -n "Checking CSV export... "
  http_request GET "${BASE_URL}/api/reports/export/csv/${CLIENT_ID}" \
    -H "x-user-email: ${TEST_EMAIL}"
  if [ "$HTTP_STATUS" = "200" ]; then
    check_pass "GET /api/reports/export/csv/${CLIENT_ID} (HTTP ${HTTP_STATUS})"
  else
    check_fail "GET /api/reports/export/csv/${CLIENT_ID}" "expected 200, got ${HTTP_STATUS}"
  fi
fi

# 12. Reports - PDF export
if [ -n "${CLIENT_ID:-}" ]; then
  echo -n "Checking PDF export... "
  http_request GET "${BASE_URL}/api/reports/export/pdf/${CLIENT_ID}" \
    -H "x-user-email: ${TEST_EMAIL}"
  if [ "$HTTP_STATUS" = "200" ]; then
    check_pass "GET /api/reports/export/pdf/${CLIENT_ID} (HTTP ${HTTP_STATUS})"
  else
    check_fail "GET /api/reports/export/pdf/${CLIENT_ID}" "expected 200, got ${HTTP_STATUS}"
  fi
fi

# 13. Validation - Invalid email rejected
echo -n "Checking input validation... "
http_request POST "${BASE_URL}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email": "not-an-email"}'
if [ "$HTTP_STATUS" = "400" ]; then
  check_pass "POST /api/auth/login (invalid email) returns 400"
else
  check_warn "POST /api/auth/login (invalid email)" "expected 400, got ${HTTP_STATUS}"
fi

# 14. 404 handler
echo -n "Checking 404 handler... "
http_request GET "${BASE_URL}/api/nonexistent-route" \
  -H "x-user-email: ${TEST_EMAIL}"
if [ "$HTTP_STATUS" = "404" ]; then
  check_pass "GET /api/nonexistent-route returns 404"
else
  check_warn "GET /api/nonexistent-route" "expected 404, got ${HTTP_STATUS}"
fi

# ──────────────────────────────────────────────
# Cleanup: delete test data
# ──────────────────────────────────────────────

if [ -n "${ENTRY_ID:-}" ]; then
  curl -s -X DELETE \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/work-entries/${ENTRY_ID}" > /dev/null 2>&1 || true
fi

if [ -n "${CLIENT_ID:-}" ]; then
  curl -s -X DELETE \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/clients/${CLIENT_ID}" > /dev/null 2>&1 || true
fi

# ──────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────

echo ""
echo "──────────────────────────────────────────"
echo -e "${BOLD}Results${NC}"
echo "──────────────────────────────────────────"

for result in "${RESULTS[@]}"; do
  echo -e "  ${result}"
done

echo ""
echo "──────────────────────────────────────────"
TOTAL=$((PASS + FAIL + WARN))
echo -e "  Total: ${TOTAL}  |  ${GREEN}Passed: ${PASS}${NC}  |  ${RED}Failed: ${FAIL}${NC}  |  ${YELLOW}Warnings: ${WARN}${NC}"
echo "──────────────────────────────────────────"

if [ "$FAIL" -gt 0 ]; then
  echo -e "\n${RED}${BOLD}HEALTH CHECK FAILED${NC} — ${FAIL} check(s) failed."
  exit 1
else
  echo -e "\n${GREEN}${BOLD}HEALTH CHECK PASSED${NC}"
  exit 0
fi
