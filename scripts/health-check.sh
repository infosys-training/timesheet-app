#!/usr/bin/env bash
#
# Health Check Script for Timesheet App
#
# Tests all critical endpoints and dependencies.
# Exit codes: 0 = all checks pass, 1 = one or more checks failed
#
# Usage:
#   ./scripts/health-check.sh                    # defaults to http://localhost:3001
#   ./scripts/health-check.sh http://myserver:3001
#   BACKEND_URL=http://prod:3001 ./scripts/health-check.sh
#

set -euo pipefail

# --- Configuration ---
BASE_URL="${1:-${BACKEND_URL:-http://localhost:3001}}"
TEST_EMAIL="healthcheck@timesheet-app.example.com"
TIMEOUT=10  # curl timeout in seconds
VERBOSE="${VERBOSE:-false}"

# --- State ---
PASS=0
FAIL=0
WARNINGS=0
CREATED_CLIENT_ID=""

# --- Helpers ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_pass() {
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}[PASS]${NC} $1"
}

log_fail() {
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}[FAIL]${NC} $1"
  if [ "${2:-}" != "" ]; then
    echo -e "        ${RED}Detail: $2${NC}"
  fi
}

log_warn() {
  WARNINGS=$((WARNINGS + 1))
  echo -e "  ${YELLOW}[WARN]${NC} $1"
}

log_info() {
  echo -e "  [INFO] $1"
}

# Make an HTTP request and capture status code + body
# Usage: http_request METHOD PATH [DATA]
http_request() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  local url="${BASE_URL}${path}"

  local curl_args=(
    -s
    -w "\n%{http_code}"
    --max-time "$TIMEOUT"
    -H "Content-Type: application/json"
    -H "x-user-email: ${TEST_EMAIL}"
    -X "$method"
  )

  if [ -n "$data" ]; then
    curl_args+=(-d "$data")
  fi

  local response
  response=$(curl "${curl_args[@]}" "$url" 2>/dev/null) || {
    echo ""
    echo "000"
    return
  }

  local body
  local status_code
  body=$(echo "$response" | sed '$d')
  status_code=$(echo "$response" | tail -1)

  echo "$body"
  echo "$status_code"
}

# --- Checks ---

echo "============================================"
echo " Timesheet App Health Check"
echo " Target: ${BASE_URL}"
echo " Time:   $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "============================================"
echo ""

# 1. Backend Connectivity
echo "1. Backend Connectivity"
echo "-------------------------------------------"

response=$(http_request GET "/health")
body=$(echo "$response" | sed '$d')
status=$(echo "$response" | tail -1)

if [ "$status" = "200" ]; then
  log_pass "Health endpoint reachable (HTTP 200)"
  # Check response structure
  if echo "$body" | grep -q '"status"'; then
    log_pass "Health response contains status field"
  else
    log_warn "Health response missing expected 'status' field"
  fi
elif [ "$status" = "000" ]; then
  log_fail "Backend unreachable (connection refused or timeout)" "Is the server running at ${BASE_URL}?"
else
  log_fail "Health endpoint returned HTTP ${status}" "$body"
fi

echo ""

# 2. Authentication System
echo "2. Authentication System"
echo "-------------------------------------------"

# Test login
response=$(http_request POST "/api/auth/login" "{\"email\": \"${TEST_EMAIL}\"}")
body=$(echo "$response" | sed '$d')
status=$(echo "$response" | tail -1)

if [ "$status" = "200" ] || [ "$status" = "201" ]; then
  log_pass "Login endpoint functional (HTTP ${status})"
else
  log_fail "Login failed (HTTP ${status})" "$body"
fi

# Test /me endpoint
response=$(http_request GET "/api/auth/me")
body=$(echo "$response" | sed '$d')
status=$(echo "$response" | tail -1)

if [ "$status" = "200" ]; then
  log_pass "Get current user endpoint functional (HTTP 200)"
else
  log_fail "Get current user failed (HTTP ${status})" "$body"
fi

# Test missing auth header
response=$(curl -s -w "\n%{http_code}" --max-time "$TIMEOUT" \
  -H "Content-Type: application/json" \
  "${BASE_URL}/api/auth/me" 2>/dev/null) || response=$'\n000'
status=$(echo "$response" | tail -1)

if [ "$status" = "401" ]; then
  log_pass "Missing auth header correctly returns 401"
else
  log_fail "Missing auth header returned HTTP ${status} (expected 401)"
fi

echo ""

# 3. Client Management (CRUD)
echo "3. Client Management (CRUD)"
echo "-------------------------------------------"

# Create a test client
response=$(http_request POST "/api/clients" "{\"name\": \"HealthCheck Test Client\", \"description\": \"Created by health check script\"}")
body=$(echo "$response" | sed '$d')
status=$(echo "$response" | tail -1)

if [ "$status" = "201" ]; then
  log_pass "Create client endpoint functional (HTTP 201)"
  CREATED_CLIENT_ID=$(echo "$body" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  if [ -n "$CREATED_CLIENT_ID" ]; then
    log_info "Created test client ID: ${CREATED_CLIENT_ID}"
  fi
else
  log_fail "Create client failed (HTTP ${status})" "$body"
fi

# List clients
response=$(http_request GET "/api/clients")
body=$(echo "$response" | sed '$d')
status=$(echo "$response" | tail -1)

if [ "$status" = "200" ]; then
  log_pass "List clients endpoint functional (HTTP 200)"
else
  log_fail "List clients failed (HTTP ${status})" "$body"
fi

# Get specific client (if we created one)
if [ -n "$CREATED_CLIENT_ID" ]; then
  response=$(http_request GET "/api/clients/${CREATED_CLIENT_ID}")
  body=$(echo "$response" | sed '$d')
  status=$(echo "$response" | tail -1)

  if [ "$status" = "200" ]; then
    log_pass "Get specific client endpoint functional (HTTP 200)"
  else
    log_fail "Get specific client failed (HTTP ${status})" "$body"
  fi

  # Update client
  response=$(http_request PUT "/api/clients/${CREATED_CLIENT_ID}" "{\"name\": \"HealthCheck Updated Client\"}")
  body=$(echo "$response" | sed '$d')
  status=$(echo "$response" | tail -1)

  if [ "$status" = "200" ]; then
    log_pass "Update client endpoint functional (HTTP 200)"
  else
    log_fail "Update client failed (HTTP ${status})" "$body"
  fi
fi

echo ""

# 4. Work Entry Management
echo "4. Work Entry Management"
echo "-------------------------------------------"

if [ -n "$CREATED_CLIENT_ID" ]; then
  # Create work entry
  TODAY=$(date '+%Y-%m-%d')
  response=$(http_request POST "/api/work-entries" "{\"clientId\": ${CREATED_CLIENT_ID}, \"hours\": 2.5, \"description\": \"Health check test entry\", \"date\": \"${TODAY}\"}")
  body=$(echo "$response" | sed '$d')
  status=$(echo "$response" | tail -1)

  if [ "$status" = "201" ]; then
    log_pass "Create work entry endpoint functional (HTTP 201)"
    CREATED_ENTRY_ID=$(echo "$body" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  else
    log_fail "Create work entry failed (HTTP ${status})" "$body"
  fi

  # List work entries
  response=$(http_request GET "/api/work-entries")
  body=$(echo "$response" | sed '$d')
  status=$(echo "$response" | tail -1)

  if [ "$status" = "200" ]; then
    log_pass "List work entries endpoint functional (HTTP 200)"
  else
    log_fail "List work entries failed (HTTP ${status})" "$body"
  fi

  # List with client filter
  response=$(http_request GET "/api/work-entries?clientId=${CREATED_CLIENT_ID}")
  body=$(echo "$response" | sed '$d')
  status=$(echo "$response" | tail -1)

  if [ "$status" = "200" ]; then
    log_pass "List work entries with filter functional (HTTP 200)"
  else
    log_fail "List work entries with filter failed (HTTP ${status})" "$body"
  fi
else
  log_warn "Skipping work entry tests (no test client created)"
fi

echo ""

# 5. Report Generation
echo "5. Report Generation"
echo "-------------------------------------------"

if [ -n "$CREATED_CLIENT_ID" ]; then
  # Get client report (JSON)
  response=$(http_request GET "/api/reports/client/${CREATED_CLIENT_ID}")
  body=$(echo "$response" | sed '$d')
  status=$(echo "$response" | tail -1)

  if [ "$status" = "200" ]; then
    log_pass "Client report (JSON) endpoint functional (HTTP 200)"
    if echo "$body" | grep -q '"totalHours"'; then
      log_pass "Report contains totalHours field"
    else
      log_warn "Report response missing 'totalHours' field"
    fi
  else
    log_fail "Client report (JSON) failed (HTTP ${status})" "$body"
  fi

  # CSV export
  csv_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/reports/export/csv/${CREATED_CLIENT_ID}" 2>/dev/null) || csv_status="000"

  if [ "$csv_status" = "200" ]; then
    log_pass "CSV export endpoint functional (HTTP 200)"
  elif [ "$csv_status" = "000" ]; then
    log_fail "CSV export unreachable (timeout or connection error)"
  else
    log_fail "CSV export failed (HTTP ${csv_status})"
  fi

  # PDF export
  pdf_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/reports/export/pdf/${CREATED_CLIENT_ID}" 2>/dev/null) || pdf_status="000"

  if [ "$pdf_status" = "200" ]; then
    log_pass "PDF export endpoint functional (HTTP 200)"
  elif [ "$pdf_status" = "000" ]; then
    log_fail "PDF export unreachable (timeout or connection error)"
  else
    log_fail "PDF export failed (HTTP ${pdf_status})"
  fi
else
  log_warn "Skipping report tests (no test client created)"
fi

echo ""

# 6. Error Handling & Security
echo "6. Error Handling & Security"
echo "-------------------------------------------"

# Test 404 handler
response=$(http_request GET "/nonexistent-route")
body=$(echo "$response" | sed '$d')
status=$(echo "$response" | tail -1)

if [ "$status" = "404" ]; then
  log_pass "404 handler working correctly"
else
  log_fail "404 handler returned HTTP ${status} (expected 404)"
fi

# Test validation (bad email format)
response=$(http_request POST "/api/auth/login" "{\"email\": \"not-an-email\"}")
body=$(echo "$response" | sed '$d')
status=$(echo "$response" | tail -1)

if [ "$status" = "400" ]; then
  log_pass "Input validation rejects invalid email (HTTP 400)"
else
  log_fail "Input validation returned HTTP ${status} for invalid email (expected 400)"
fi

# Test invalid client ID
response=$(http_request GET "/api/clients/abc")
body=$(echo "$response" | sed '$d')
status=$(echo "$response" | tail -1)

if [ "$status" = "400" ]; then
  log_pass "Invalid ID parameter correctly rejected (HTTP 400)"
else
  log_fail "Invalid ID parameter returned HTTP ${status} (expected 400)"
fi

# Check security headers (Helmet)
security_headers=$(curl -s -I --max-time "$TIMEOUT" "${BASE_URL}/health" 2>/dev/null)

if echo "$security_headers" | grep -qi "x-content-type-options"; then
  log_pass "Security headers present (Helmet active)"
else
  log_warn "Security headers may not be configured (Helmet)"
fi

echo ""

# 7. Cleanup
echo "7. Cleanup"
echo "-------------------------------------------"

if [ -n "${CREATED_ENTRY_ID:-}" ]; then
  response=$(http_request DELETE "/api/work-entries/${CREATED_ENTRY_ID}")
  status=$(echo "$response" | tail -1)
  if [ "$status" = "200" ]; then
    log_info "Cleaned up test work entry"
  fi
fi

if [ -n "$CREATED_CLIENT_ID" ]; then
  response=$(http_request DELETE "/api/clients/${CREATED_CLIENT_ID}")
  status=$(echo "$response" | tail -1)
  if [ "$status" = "200" ]; then
    log_info "Cleaned up test client"
  else
    log_warn "Could not clean up test client (HTTP ${status})"
  fi
fi

echo ""

# --- Summary ---
echo "============================================"
echo " Results Summary"
echo "============================================"
TOTAL=$((PASS + FAIL))
echo -e "  ${GREEN}Passed:${NC}   ${PASS}/${TOTAL}"
echo -e "  ${RED}Failed:${NC}   ${FAIL}/${TOTAL}"
echo -e "  ${YELLOW}Warnings:${NC} ${WARNINGS}"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "  ${RED}OVERALL: UNHEALTHY${NC}"
  echo ""
  echo "  Refer to RUNBOOK.md for troubleshooting guidance."
  exit 1
else
  echo -e "  ${GREEN}OVERALL: HEALTHY${NC}"
  exit 0
fi
