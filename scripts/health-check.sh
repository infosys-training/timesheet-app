#!/usr/bin/env bash
#
# Health Check Script for Timesheet Application
#
# Tests all critical endpoints and reports their status.
# Exit codes:
#   0 - All checks passed
#   1 - One or more checks failed
#
# Usage:
#   ./scripts/health-check.sh                    # Uses default localhost:3001
#   ./scripts/health-check.sh http://prod:3001   # Custom base URL
#   HEALTH_CHECK_EMAIL=admin@co.com ./scripts/health-check.sh  # Custom test email
#

set -uo pipefail

# Configuration
BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="${HEALTH_CHECK_EMAIL:-healthcheck@timesheet-app.com}"
TIMEOUT="${HEALTH_CHECK_TIMEOUT:-5}"
VERBOSE="${HEALTH_CHECK_VERBOSE:-false}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
PASSED=0
FAILED=0
WARNINGS=0
TOTAL=0

# Track created resources for cleanup
CREATED_CLIENT_ID=""

# ─── Helper Functions ───────────────────────────────────────────────────────────

log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_pass() {
  echo -e "${GREEN}[PASS]${NC} $1"
  PASSED=$((PASSED + 1))
  TOTAL=$((TOTAL + 1))
}

log_fail() {
  echo -e "${RED}[FAIL]${NC} $1"
  FAILED=$((FAILED + 1))
  TOTAL=$((TOTAL + 1))
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
  WARNINGS=$((WARNINGS + 1))
}

# Make an HTTP request and check the response
# Args: method, path, expected_status, description, [body]
check_endpoint() {
  local method="$1"
  local path="$2"
  local expected_status="$3"
  local description="$4"
  local body="${5:-}"

  local url="${BASE_URL}${path}"
  local curl_args=("-s" "-o" "/tmp/health_check_response.json" "-w" "%{http_code}" "--max-time" "$TIMEOUT")

  curl_args+=("-X" "$method")
  curl_args+=("-H" "x-user-email: ${TEST_EMAIL}")
  curl_args+=("-H" "Content-Type: application/json")

  if [[ -n "$body" ]]; then
    curl_args+=("-d" "$body")
  fi

  local http_code
  http_code=$(curl "${curl_args[@]}" "$url" 2>/dev/null) || {
    log_fail "$description — Connection refused or timed out ($url)"
    return 1
  }

  if [[ "$http_code" == "$expected_status" ]]; then
    log_pass "$description — HTTP $http_code"
    if [[ "$VERBOSE" == "true" ]]; then
      echo "       Response: $(cat /tmp/health_check_response.json | head -c 200)"
    fi
    return 0
  else
    log_fail "$description — Expected HTTP $expected_status, got HTTP $http_code"
    if [[ "$VERBOSE" == "true" ]]; then
      echo "       Response: $(cat /tmp/health_check_response.json | head -c 200)"
    fi
    return 1
  fi
}

# ─── Cleanup Function ───────────────────────────────────────────────────────────

cleanup() {
  if [[ -n "$CREATED_CLIENT_ID" ]]; then
    log_info "Cleaning up test data (client ID: $CREATED_CLIENT_ID)..."
    curl -s -X DELETE \
      -H "x-user-email: ${TEST_EMAIL}" \
      "${BASE_URL}/api/clients/${CREATED_CLIENT_ID}" > /dev/null 2>&1 || true
  fi
  rm -f /tmp/health_check_response.json
}

trap cleanup EXIT

# ─── Print Header ───────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Timesheet Application Health Check"
echo "  Base URL: $BASE_URL"
echo "  Timestamp: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ─── 1. Basic Connectivity ──────────────────────────────────────────────────────

log_info "Section 1: Basic Connectivity"
echo "────────────────────────────────────────"

check_endpoint "GET" "/health" "200" "Health endpoint"

# Verify health response contains expected fields
if [[ -f /tmp/health_check_response.json ]]; then
  if grep -q '"status":"OK"' /tmp/health_check_response.json 2>/dev/null; then
    log_pass "Health response contains status: OK"
  else
    log_fail "Health response missing status: OK"
  fi

  if grep -q '"timestamp"' /tmp/health_check_response.json 2>/dev/null; then
    log_pass "Health response contains timestamp"
  else
    log_fail "Health response missing timestamp"
  fi
fi

echo ""

# ─── 2. Authentication Endpoints ────────────────────────────────────────────────

log_info "Section 2: Authentication"
echo "────────────────────────────────────────"

check_endpoint "POST" "/api/auth/login" "200" "Auth login (existing or new user)" \
  "{\"email\": \"${TEST_EMAIL}\"}"

check_endpoint "GET" "/api/auth/me" "200" "Auth me (get current user)"

# Test invalid email format
check_endpoint "POST" "/api/auth/login" "400" "Auth login (invalid email rejected)" \
  '{"email": "not-an-email"}'

echo ""

# ─── 3. Client CRUD Endpoints ───────────────────────────────────────────────────

log_info "Section 3: Client Endpoints"
echo "────────────────────────────────────────"

check_endpoint "GET" "/api/clients" "200" "List clients"

# Create a test client
check_endpoint "POST" "/api/clients" "201" "Create client" \
  '{"name": "_health_check_test_client", "description": "Auto-created by health check script"}'

# Extract client ID from response
if [[ -f /tmp/health_check_response.json ]]; then
  CREATED_CLIENT_ID=$(grep -o '"id":[0-9]*' /tmp/health_check_response.json | head -1 | cut -d: -f2)
fi

if [[ -n "$CREATED_CLIENT_ID" ]]; then
  check_endpoint "GET" "/api/clients/${CREATED_CLIENT_ID}" "200" "Get specific client"

  check_endpoint "PUT" "/api/clients/${CREATED_CLIENT_ID}" "200" "Update client" \
    '{"name": "_health_check_test_client_updated"}'
else
  log_warn "Could not extract client ID — skipping GET/PUT/DELETE tests"
fi

# Test validation
check_endpoint "POST" "/api/clients" "400" "Create client (validation: missing name)" \
  '{"description": "no name provided"}'

echo ""

# ─── 4. Work Entry Endpoints ────────────────────────────────────────────────────

log_info "Section 4: Work Entry Endpoints"
echo "────────────────────────────────────────"

check_endpoint "GET" "/api/work-entries" "200" "List work entries"

if [[ -n "$CREATED_CLIENT_ID" ]]; then
  check_endpoint "POST" "/api/work-entries" "201" "Create work entry" \
    "{\"clientId\": ${CREATED_CLIENT_ID}, \"hours\": 1.5, \"description\": \"Health check test entry\", \"date\": \"$(date -u '+%Y-%m-%d')\"}"

  # Extract work entry ID
  WORK_ENTRY_ID=$(grep -o '"id":[0-9]*' /tmp/health_check_response.json | head -1 | cut -d: -f2)

  if [[ -n "$WORK_ENTRY_ID" ]]; then
    check_endpoint "GET" "/api/work-entries/${WORK_ENTRY_ID}" "200" "Get specific work entry"

    check_endpoint "PUT" "/api/work-entries/${WORK_ENTRY_ID}" "200" "Update work entry" \
      '{"hours": 2.0}'

    check_endpoint "DELETE" "/api/work-entries/${WORK_ENTRY_ID}" "200" "Delete work entry"
  fi
else
  log_warn "No test client available — skipping work entry write tests"
fi

# Test validation
check_endpoint "POST" "/api/work-entries" "400" "Create work entry (validation: missing fields)" \
  '{"description": "incomplete entry"}'

echo ""

# ─── 5. Report Endpoints ────────────────────────────────────────────────────────

log_info "Section 5: Report Endpoints"
echo "────────────────────────────────────────"

if [[ -n "$CREATED_CLIENT_ID" ]]; then
  check_endpoint "GET" "/api/reports/client/${CREATED_CLIENT_ID}" "200" "Get client report"

  # CSV export — returns file download (200)
  check_endpoint "GET" "/api/reports/export/csv/${CREATED_CLIENT_ID}" "200" "Export CSV report"

  # PDF export — returns file download (200)
  check_endpoint "GET" "/api/reports/export/pdf/${CREATED_CLIENT_ID}" "200" "Export PDF report"
else
  log_warn "No test client available — skipping report endpoint tests"
fi

# Test invalid client ID
check_endpoint "GET" "/api/reports/client/999999" "404" "Report for non-existent client"

echo ""

# ─── 6. Error Handling ──────────────────────────────────────────────────────────

log_info "Section 6: Error Handling & Edge Cases"
echo "────────────────────────────────────────"

check_endpoint "GET" "/api/nonexistent-route" "404" "404 handler for unknown routes"

check_endpoint "GET" "/api/clients/not-a-number" "400" "Invalid ID parameter handling"

# Test missing auth header
local_curl_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
  "${BASE_URL}/api/clients" 2>/dev/null) || local_curl_code="000"
if [[ "$local_curl_code" == "401" ]]; then
  log_pass "Missing auth header returns 401"
else
  log_fail "Missing auth header — Expected 401, got $local_curl_code"
fi

echo ""

# ─── 7. Cleanup Test Data ───────────────────────────────────────────────────────

log_info "Section 7: Cleanup"
echo "────────────────────────────────────────"

if [[ -n "$CREATED_CLIENT_ID" ]]; then
  check_endpoint "DELETE" "/api/clients/${CREATED_CLIENT_ID}" "200" "Delete test client (cleanup)"
  CREATED_CLIENT_ID=""  # Prevent double-cleanup in trap
fi

echo ""

# ─── Summary ────────────────────────────────────────────────────────────────────

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  RESULTS"
echo "────────────────────────────────────────"
echo -e "  ${GREEN}Passed:${NC}   $PASSED"
echo -e "  ${RED}Failed:${NC}   $FAILED"
echo -e "  ${YELLOW}Warnings:${NC} $WARNINGS"
echo "  Total:    $TOTAL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [[ $FAILED -gt 0 ]]; then
  echo -e "${RED}HEALTH CHECK FAILED${NC} — $FAILED check(s) did not pass."
  echo "Refer to RUNBOOK.md for troubleshooting procedures."
  exit 1
else
  echo -e "${GREEN}ALL HEALTH CHECKS PASSED${NC}"
  exit 0
fi
