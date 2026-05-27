#!/usr/bin/env bash
# Health Check Script for Timesheet App
# Tests all critical backend endpoints
# Usage: ./scripts/health-check.sh [BASE_URL] [TEST_EMAIL]
#
# Exit codes:
#   0 - All checks passed
#   1 - One or more checks failed

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="${2:-healthcheck@test.com}"
PASS=0
FAIL=0
WARN=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

check_pass() {
  echo -e "  ${GREEN}✓ PASS${NC}: $1"
  ((PASS++))
}

check_fail() {
  echo -e "  ${RED}✗ FAIL${NC}: $1"
  ((FAIL++))
}

check_warn() {
  echo -e "  ${YELLOW}! WARN${NC}: $1"
  ((WARN++))
}

echo "============================================"
echo "Timesheet App Health Check"
echo "Target: ${BASE_URL}"
echo "Time:   $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "============================================"
echo ""

# --- 1. Basic Health Check ---
echo "[1/7] Health Check Endpoint (GET /health)"
HTTP_CODE=$(curl -s -o /tmp/health_response.json -w "%{http_code}" "${BASE_URL}/health" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  STATUS=$(cat /tmp/health_response.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
  if [ "$STATUS" = "OK" ]; then
    check_pass "Health endpoint returned 200 with status OK"
  else
    check_warn "Health endpoint returned 200 but status is '${STATUS}'"
  fi
else
  check_fail "Health endpoint returned HTTP ${HTTP_CODE} (expected 200)"
fi
echo ""

# --- 2. Authentication ---
echo "[2/7] Authentication (POST /api/auth/login)"
HTTP_CODE=$(curl -s -o /tmp/auth_response.json -w "%{http_code}" \
  -X POST "${BASE_URL}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"${TEST_EMAIL}\"}" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  check_pass "Login endpoint returned HTTP ${HTTP_CODE}"
else
  check_fail "Login endpoint returned HTTP ${HTTP_CODE} (expected 200 or 201)"
fi
echo ""

# --- 3. Auth - Get Current User ---
echo "[3/7] Get Current User (GET /api/auth/me)"
HTTP_CODE=$(curl -s -o /tmp/me_response.json -w "%{http_code}" \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BASE_URL}/api/auth/me" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  check_pass "Get current user returned 200"
else
  check_fail "Get current user returned HTTP ${HTTP_CODE} (expected 200)"
fi
echo ""

# --- 4. Clients API ---
echo "[4/7] Clients API (GET /api/clients)"
HTTP_CODE=$(curl -s -o /tmp/clients_response.json -w "%{http_code}" \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BASE_URL}/api/clients" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  check_pass "Clients endpoint returned 200"
else
  check_fail "Clients endpoint returned HTTP ${HTTP_CODE} (expected 200)"
fi
echo ""

# --- 5. Work Entries API ---
echo "[5/7] Work Entries API (GET /api/work-entries)"
HTTP_CODE=$(curl -s -o /tmp/entries_response.json -w "%{http_code}" \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BASE_URL}/api/work-entries" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  check_pass "Work entries endpoint returned 200"
else
  check_fail "Work entries endpoint returned HTTP ${HTTP_CODE} (expected 200)"
fi
echo ""

# --- 6. Auth Rejection (missing header) ---
echo "[6/7] Auth Rejection (GET /api/clients without auth)"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  "${BASE_URL}/api/clients" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "401" ]; then
  check_pass "Unauthenticated request correctly rejected with 401"
else
  check_warn "Unauthenticated request returned HTTP ${HTTP_CODE} (expected 401)"
fi
echo ""

# --- 7. 404 Handler ---
echo "[7/7] 404 Handler (GET /nonexistent)"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  "${BASE_URL}/nonexistent" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "404" ]; then
  check_pass "404 handler working correctly"
else
  check_warn "Nonexistent route returned HTTP ${HTTP_CODE} (expected 404)"
fi
echo ""

# --- Summary ---
echo "============================================"
echo "Results: ${PASS} passed, ${FAIL} failed, ${WARN} warnings"
echo "============================================"

# Clean up temp files
rm -f /tmp/health_response.json /tmp/auth_response.json /tmp/me_response.json \
      /tmp/clients_response.json /tmp/entries_response.json

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}HEALTH CHECK FAILED${NC} — See RUNBOOK.md for troubleshooting"
  exit 1
else
  echo -e "${GREEN}HEALTH CHECK PASSED${NC}"
  exit 0
fi
