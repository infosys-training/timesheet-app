#!/usr/bin/env bash
#
# Health Check Script for Employee Time Tracking Application
#
# Tests all critical endpoints and reports status.
# Exit codes: 0 = all checks pass, 1 = one or more checks failed
#
# Usage:
#   ./scripts/health-check.sh                  # Uses default localhost:3001
#   ./scripts/health-check.sh http://prod:3001 # Custom base URL
#

set -euo pipefail

# Configuration
BASE_URL="${1:-http://localhost:3001}"
TIMEOUT=10
TEST_EMAIL="healthcheck@test.internal"
PASSED=0
FAILED=0
WARNINGS=0

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  NC='\033[0m'
else
  RED=''
  GREEN=''
  YELLOW=''
  BLUE=''
  NC=''
fi

# Helper functions
log_pass() {
  echo -e "${GREEN}[PASS]${NC} $1"
  PASSED=$((PASSED + 1))
}

log_fail() {
  echo -e "${RED}[FAIL]${NC} $1"
  FAILED=$((FAILED + 1))
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
  WARNINGS=$((WARNINGS + 1))
}

log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

check_endpoint() {
  local description="$1"
  local method="$2"
  local url="$3"
  local expected_status="$4"
  local headers="${5:-}"
  local data="${6:-}"

  local curl_args=(-s -o /dev/null -w "%{http_code}|%{time_total}" --max-time "$TIMEOUT")

  if [ -n "$headers" ]; then
    while IFS= read -r header; do
      curl_args+=(-H "$header")
    done <<< "$headers"
  fi

  if [ "$method" = "POST" ]; then
    curl_args+=(-X POST)
    if [ -n "$data" ]; then
      curl_args+=(-H "Content-Type: application/json" -d "$data")
    fi
  fi

  local result
  result=$(curl "${curl_args[@]}" "$url" 2>/dev/null) || {
    log_fail "$description - Connection refused or timeout"
    return 1
  }

  local status_code
  local response_time
  status_code=$(echo "$result" | cut -d'|' -f1)
  response_time=$(echo "$result" | cut -d'|' -f2)

  if [ "$status_code" = "$expected_status" ]; then
    if (( $(echo "$response_time > 5.0" | bc -l 2>/dev/null || echo 0) )); then
      log_warn "$description - Status $status_code OK but slow (${response_time}s)"
    else
      log_pass "$description - Status $status_code (${response_time}s)"
    fi
    return 0
  else
    log_fail "$description - Expected $expected_status, got $status_code"
    return 1
  fi
}

# ============================================================
echo ""
echo "=============================================="
echo " Timesheet App Health Check"
echo " Target: $BASE_URL"
echo " Time:   $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "=============================================="
echo ""

# ------------------------------------------------------------
# 1. Basic Connectivity
# ------------------------------------------------------------
log_info "--- Basic Connectivity ---"

check_endpoint \
  "Health endpoint (GET /health)" \
  "GET" \
  "$BASE_URL/health" \
  "200" || true

# Verify health response body
HEALTH_BODY=$(curl -s --max-time "$TIMEOUT" "$BASE_URL/health" 2>/dev/null) || HEALTH_BODY=""
if echo "$HEALTH_BODY" | grep -q '"status":"OK"'; then
  log_pass "Health response body contains status OK"
else
  log_fail "Health response body missing or invalid: $HEALTH_BODY"
fi

echo ""

# ------------------------------------------------------------
# 2. Authentication Endpoints
# ------------------------------------------------------------
log_info "--- Authentication ---"

check_endpoint \
  "Login endpoint (POST /api/auth/login)" \
  "POST" \
  "$BASE_URL/api/auth/login" \
  "200" \
  "" \
  "{\"email\":\"$TEST_EMAIL\"}" || true

check_endpoint \
  "Get current user (GET /api/auth/me)" \
  "GET" \
  "$BASE_URL/api/auth/me" \
  "200" \
  "x-user-email: $TEST_EMAIL" || true

check_endpoint \
  "Auth rejection without header (GET /api/auth/me)" \
  "GET" \
  "$BASE_URL/api/auth/me" \
  "401" || true

echo ""

# ------------------------------------------------------------
# 3. Client Endpoints
# ------------------------------------------------------------
log_info "--- Client Management ---"

check_endpoint \
  "List clients (GET /api/clients)" \
  "GET" \
  "$BASE_URL/api/clients" \
  "200" \
  "x-user-email: $TEST_EMAIL" || true

# Create a test client
CREATE_RESPONSE=$(curl -s --max-time "$TIMEOUT" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-user-email: $TEST_EMAIL" \
  -d '{"name":"HealthCheck Test Client","description":"Created by health check script"}' \
  "$BASE_URL/api/clients" 2>/dev/null) || CREATE_RESPONSE=""

CLIENT_ID=$(echo "$CREATE_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)

if [ -n "$CLIENT_ID" ]; then
  log_pass "Create client (POST /api/clients) - Created ID $CLIENT_ID"

  check_endpoint \
    "Get specific client (GET /api/clients/$CLIENT_ID)" \
    "GET" \
    "$BASE_URL/api/clients/$CLIENT_ID" \
    "200" \
    "x-user-email: $TEST_EMAIL" || true

  check_endpoint \
    "Update client (PUT /api/clients/$CLIENT_ID)" \
    "POST" \
    "$BASE_URL/api/clients/$CLIENT_ID" \
    "200" \
    "x-user-email: $TEST_EMAIL
Content-Type: application/json" \
    '{"name":"HealthCheck Updated Client"}' || true
else
  log_fail "Create client (POST /api/clients) - No client ID in response"
fi

echo ""

# ------------------------------------------------------------
# 4. Work Entry Endpoints
# ------------------------------------------------------------
log_info "--- Work Entries ---"

check_endpoint \
  "List work entries (GET /api/work-entries)" \
  "GET" \
  "$BASE_URL/api/work-entries" \
  "200" \
  "x-user-email: $TEST_EMAIL" || true

if [ -n "$CLIENT_ID" ]; then
  ENTRY_RESPONSE=$(curl -s --max-time "$TIMEOUT" \
    -X POST \
    -H "Content-Type: application/json" \
    -H "x-user-email: $TEST_EMAIL" \
    -d "{\"clientId\":$CLIENT_ID,\"hours\":1.5,\"description\":\"Health check test entry\",\"date\":\"$(date -u '+%Y-%m-%d')\"}" \
    "$BASE_URL/api/work-entries" 2>/dev/null) || ENTRY_RESPONSE=""

  ENTRY_ID=$(echo "$ENTRY_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)

  if [ -n "$ENTRY_ID" ]; then
    log_pass "Create work entry (POST /api/work-entries) - Created ID $ENTRY_ID"

    check_endpoint \
      "Get specific work entry (GET /api/work-entries/$ENTRY_ID)" \
      "GET" \
      "$BASE_URL/api/work-entries/$ENTRY_ID" \
      "200" \
      "x-user-email: $TEST_EMAIL" || true
  else
    log_fail "Create work entry (POST /api/work-entries) - No entry ID in response"
  fi
fi

echo ""

# ------------------------------------------------------------
# 5. Report Endpoints
# ------------------------------------------------------------
log_info "--- Reports ---"

if [ -n "$CLIENT_ID" ]; then
  check_endpoint \
    "Client report (GET /api/reports/client/$CLIENT_ID)" \
    "GET" \
    "$BASE_URL/api/reports/client/$CLIENT_ID" \
    "200" \
    "x-user-email: $TEST_EMAIL" || true

  check_endpoint \
    "CSV export (GET /api/reports/export/csv/$CLIENT_ID)" \
    "GET" \
    "$BASE_URL/api/reports/export/csv/$CLIENT_ID" \
    "200" \
    "x-user-email: $TEST_EMAIL" || true

  check_endpoint \
    "PDF export (GET /api/reports/export/pdf/$CLIENT_ID)" \
    "GET" \
    "$BASE_URL/api/reports/export/pdf/$CLIENT_ID" \
    "200" \
    "x-user-email: $TEST_EMAIL" || true
else
  log_warn "Skipping report tests - no test client available"
fi

echo ""

# ------------------------------------------------------------
# 6. Error Handling
# ------------------------------------------------------------
log_info "--- Error Handling ---"

check_endpoint \
  "404 for unknown route (GET /api/nonexistent)" \
  "GET" \
  "$BASE_URL/api/nonexistent" \
  "404" \
  "x-user-email: $TEST_EMAIL" || true

check_endpoint \
  "400 for invalid input (POST /api/clients with empty body)" \
  "POST" \
  "$BASE_URL/api/clients" \
  "400" \
  "x-user-email: $TEST_EMAIL
Content-Type: application/json" \
  '{}' || true

check_endpoint \
  "400 for invalid email (POST /api/auth/login)" \
  "POST" \
  "$BASE_URL/api/auth/login" \
  "400" \
  "" \
  '{"email":"not-an-email"}' || true

echo ""

# ------------------------------------------------------------
# 7. Cleanup Test Data
# ------------------------------------------------------------
log_info "--- Cleanup ---"

if [ -n "${ENTRY_ID:-}" ]; then
  DEL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    -X DELETE \
    -H "x-user-email: $TEST_EMAIL" \
    "$BASE_URL/api/work-entries/$ENTRY_ID" 2>/dev/null) || DEL_STATUS="000"
  if [ "$DEL_STATUS" = "200" ]; then
    log_pass "Cleaned up test work entry $ENTRY_ID"
  else
    log_warn "Failed to clean up test work entry $ENTRY_ID (status: $DEL_STATUS)"
  fi
fi

if [ -n "${CLIENT_ID:-}" ]; then
  DEL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    -X DELETE \
    -H "x-user-email: $TEST_EMAIL" \
    "$BASE_URL/api/clients/$CLIENT_ID" 2>/dev/null) || DEL_STATUS="000"
  if [ "$DEL_STATUS" = "200" ]; then
    log_pass "Cleaned up test client $CLIENT_ID"
  else
    log_warn "Failed to clean up test client $CLIENT_ID (status: $DEL_STATUS)"
  fi
fi

echo ""

# ------------------------------------------------------------
# Summary
# ------------------------------------------------------------
echo "=============================================="
echo " RESULTS"
echo "=============================================="
echo -e " ${GREEN}Passed:${NC}   $PASSED"
echo -e " ${RED}Failed:${NC}   $FAILED"
echo -e " ${YELLOW}Warnings:${NC} $WARNINGS"
echo "=============================================="
echo ""

if [ "$FAILED" -gt 0 ]; then
  echo -e "${RED}HEALTH CHECK FAILED${NC} - $FAILED check(s) did not pass"
  exit 1
else
  echo -e "${GREEN}HEALTH CHECK PASSED${NC} - All critical endpoints operational"
  exit 0
fi
