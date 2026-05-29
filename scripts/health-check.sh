#!/usr/bin/env bash
#
# Health Check Script for Timesheet App
#
# Tests all critical backend endpoints to verify the application is functioning.
# Usage:
#   ./scripts/health-check.sh [BASE_URL]
#
# Arguments:
#   BASE_URL  Backend URL (default: http://localhost:3001)
#
# Exit codes:
#   0 - All checks passed
#   1 - One or more checks failed
#
# Examples:
#   ./scripts/health-check.sh
#   ./scripts/health-check.sh http://staging.example.com:3001

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="healthcheck@timesheet-app.example.com"
PASS=0
FAIL=0
WARNINGS=0

# Colors (disabled if not a TTY)
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

log_pass() {
  echo -e "  ${GREEN}PASS${NC}  $1"
  PASS=$((PASS + 1))
}

log_fail() {
  echo -e "  ${RED}FAIL${NC}  $1"
  FAIL=$((FAIL + 1))
}

log_warn() {
  echo -e "  ${YELLOW}WARN${NC}  $1"
  WARNINGS=$((WARNINGS + 1))
}

log_header() {
  echo ""
  echo -e "${BOLD}$1${NC}"
  echo "  ──────────────────────────────────"
}

# Check if curl is available
if ! command -v curl &> /dev/null; then
  echo "Error: curl is required but not installed."
  exit 1
fi

echo ""
echo "========================================"
echo " Timesheet App Health Check"
echo " Target: ${BASE_URL}"
echo " Time:   $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "========================================"

# -------------------------------------------------------------------
# 1. Health endpoint
# -------------------------------------------------------------------
log_header "1. Health Endpoint"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${BASE_URL}/health" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  BODY=$(curl -s --max-time 10 "${BASE_URL}/health" 2>/dev/null)
  STATUS=$(echo "$BODY" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ "$STATUS" = "OK" ]; then
    log_pass "GET /health -> 200, status=OK"
  else
    log_fail "GET /health -> 200 but status=${STATUS:-empty}"
  fi
else
  log_fail "GET /health -> ${HTTP_CODE} (expected 200)"
  echo ""
  echo -e "  ${RED}Server appears to be down. Remaining checks will likely fail.${NC}"
fi

# -------------------------------------------------------------------
# 2. Authentication endpoints
# -------------------------------------------------------------------
log_header "2. Authentication Endpoints"

# POST /api/auth/login
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -X POST "${BASE_URL}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"${TEST_EMAIL}\"}" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  log_pass "POST /api/auth/login -> ${HTTP_CODE}"
else
  log_fail "POST /api/auth/login -> ${HTTP_CODE} (expected 200 or 201)"
fi

# POST /api/auth/login - invalid input
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -X POST "${BASE_URL}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email": "not-an-email"}' 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "400" ]; then
  log_pass "POST /api/auth/login (invalid email) -> 400"
else
  log_fail "POST /api/auth/login (invalid email) -> ${HTTP_CODE} (expected 400)"
fi

# GET /api/auth/me - authenticated
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BASE_URL}/api/auth/me" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  log_pass "GET /api/auth/me (authenticated) -> 200"
else
  log_fail "GET /api/auth/me (authenticated) -> ${HTTP_CODE} (expected 200)"
fi

# GET /api/auth/me - unauthenticated
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  "${BASE_URL}/api/auth/me" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "401" ]; then
  log_pass "GET /api/auth/me (no auth) -> 401"
else
  log_fail "GET /api/auth/me (no auth) -> ${HTTP_CODE} (expected 401)"
fi

# -------------------------------------------------------------------
# 3. Clients endpoints
# -------------------------------------------------------------------
log_header "3. Clients Endpoints"

# GET /api/clients
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BASE_URL}/api/clients" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  log_pass "GET /api/clients -> 200"
else
  log_fail "GET /api/clients -> ${HTTP_CODE} (expected 200)"
fi

# POST /api/clients - create test client
CREATE_RESPONSE=$(curl -s --max-time 10 \
  -X POST "${BASE_URL}/api/clients" \
  -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  -d '{"name": "HealthCheck Test Client"}' 2>/dev/null || echo "")
HTTP_CODE=$(echo "$CREATE_RESPONSE" | head -1)
# Re-fetch with -w to get code
HTTP_CODE=$(curl -s -o /tmp/healthcheck_client.json -w "%{http_code}" --max-time 10 \
  -X POST "${BASE_URL}/api/clients" \
  -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  -d '{"name": "HealthCheck Test Client"}' 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "201" ]; then
  log_pass "POST /api/clients -> 201"
  CLIENT_ID=$(cat /tmp/healthcheck_client.json 2>/dev/null | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
else
  log_fail "POST /api/clients -> ${HTTP_CODE} (expected 201)"
  CLIENT_ID=""
fi

# GET /api/clients/:id
if [ -n "$CLIENT_ID" ]; then
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/clients/${CLIENT_ID}" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    log_pass "GET /api/clients/${CLIENT_ID} -> 200"
  else
    log_fail "GET /api/clients/${CLIENT_ID} -> ${HTTP_CODE} (expected 200)"
  fi
fi

# GET /api/clients - unauthenticated
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  "${BASE_URL}/api/clients" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "401" ]; then
  log_pass "GET /api/clients (no auth) -> 401"
else
  log_fail "GET /api/clients (no auth) -> ${HTTP_CODE} (expected 401)"
fi

# -------------------------------------------------------------------
# 4. Work Entries endpoints
# -------------------------------------------------------------------
log_header "4. Work Entries Endpoints"

# GET /api/work-entries
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -H "x-user-email: ${TEST_EMAIL}" \
  "${BASE_URL}/api/work-entries" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  log_pass "GET /api/work-entries -> 200"
else
  log_fail "GET /api/work-entries -> ${HTTP_CODE} (expected 200)"
fi

# POST /api/work-entries - create test entry (requires a client)
WORK_ENTRY_ID=""
if [ -n "$CLIENT_ID" ]; then
  HTTP_CODE=$(curl -s -o /tmp/healthcheck_entry.json -w "%{http_code}" --max-time 10 \
    -X POST "${BASE_URL}/api/work-entries" \
    -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    -d "{\"clientId\": ${CLIENT_ID}, \"hours\": 1, \"description\": \"Health check test\", \"date\": \"$(date -u '+%Y-%m-%d')\"}" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "201" ]; then
    log_pass "POST /api/work-entries -> 201"
    WORK_ENTRY_ID=$(cat /tmp/healthcheck_entry.json 2>/dev/null | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  else
    log_fail "POST /api/work-entries -> ${HTTP_CODE} (expected 201)"
  fi
else
  log_warn "POST /api/work-entries -> skipped (no test client)"
fi

# GET /api/work-entries - unauthenticated
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  "${BASE_URL}/api/work-entries" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "401" ]; then
  log_pass "GET /api/work-entries (no auth) -> 401"
else
  log_fail "GET /api/work-entries (no auth) -> ${HTTP_CODE} (expected 401)"
fi

# -------------------------------------------------------------------
# 5. Reports endpoints
# -------------------------------------------------------------------
log_header "5. Reports Endpoints"

if [ -n "$CLIENT_ID" ]; then
  # GET /api/reports/client/:clientId
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/reports/client/${CLIENT_ID}" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    log_pass "GET /api/reports/client/${CLIENT_ID} -> 200"
  else
    log_fail "GET /api/reports/client/${CLIENT_ID} -> ${HTTP_CODE} (expected 200)"
  fi

  # GET /api/reports/export/csv/:clientId
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/reports/export/csv/${CLIENT_ID}" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    log_pass "GET /api/reports/export/csv/${CLIENT_ID} -> 200"
  else
    log_fail "GET /api/reports/export/csv/${CLIENT_ID} -> ${HTTP_CODE} (expected 200)"
  fi

  # GET /api/reports/export/pdf/:clientId
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/reports/export/pdf/${CLIENT_ID}" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    log_pass "GET /api/reports/export/pdf/${CLIENT_ID} -> 200"
  else
    log_fail "GET /api/reports/export/pdf/${CLIENT_ID} -> ${HTTP_CODE} (expected 200)"
  fi
else
  log_warn "Reports endpoints -> skipped (no test client)"
fi

# -------------------------------------------------------------------
# 6. Error handling checks
# -------------------------------------------------------------------
log_header "6. Error Handling"

# 404 for unknown route
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  "${BASE_URL}/api/nonexistent" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "404" ]; then
  log_pass "GET /api/nonexistent -> 404"
else
  log_fail "GET /api/nonexistent -> ${HTTP_CODE} (expected 404)"
fi

# Validation error (empty body to login)
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -X POST "${BASE_URL}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{}' 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "400" ]; then
  log_pass "POST /api/auth/login (empty body) -> 400"
else
  log_fail "POST /api/auth/login (empty body) -> ${HTTP_CODE} (expected 400)"
fi

# -------------------------------------------------------------------
# 7. Response time check
# -------------------------------------------------------------------
log_header "7. Response Time"

RESPONSE_TIME=$(curl -s -o /dev/null -w "%{time_total}" --max-time 10 \
  "${BASE_URL}/health" 2>/dev/null || echo "999")
# Compare using awk for floating point
SLOW=$(echo "$RESPONSE_TIME" | awk '{print ($1 > 2.0) ? "1" : "0"}')
if [ "$SLOW" = "0" ]; then
  log_pass "GET /health response time: ${RESPONSE_TIME}s (< 2s threshold)"
else
  log_fail "GET /health response time: ${RESPONSE_TIME}s (> 2s threshold)"
fi

# -------------------------------------------------------------------
# Cleanup test data
# -------------------------------------------------------------------
log_header "Cleanup"

CLEANED=0
if [ -n "${WORK_ENTRY_ID:-}" ]; then
  curl -s -o /dev/null -X DELETE \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/work-entries/${WORK_ENTRY_ID}" 2>/dev/null || true
  CLEANED=$((CLEANED + 1))
fi
if [ -n "${CLIENT_ID:-}" ]; then
  curl -s -o /dev/null -X DELETE \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/clients/${CLIENT_ID}" 2>/dev/null || true
  CLEANED=$((CLEANED + 1))
fi
rm -f /tmp/healthcheck_client.json /tmp/healthcheck_entry.json
echo "  Cleaned up ${CLEANED} test resource(s)"

# -------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------
echo ""
echo "========================================"
echo " Results"
echo "========================================"
echo -e "  ${GREEN}Passed:${NC}   ${PASS}"
echo -e "  ${RED}Failed:${NC}   ${FAIL}"
echo -e "  ${YELLOW}Warnings:${NC} ${WARNINGS}"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "  ${RED}${BOLD}HEALTH CHECK FAILED${NC} - ${FAIL} check(s) did not pass."
  echo "  See RUNBOOK.md for troubleshooting procedures."
  exit 1
else
  echo -e "  ${GREEN}${BOLD}ALL CHECKS PASSED${NC}"
  exit 0
fi
