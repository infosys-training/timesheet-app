#!/usr/bin/env bash
#
# Health Check Script for Timesheet App
#
# Tests all critical backend endpoints to verify the application is functioning.
# Usage:
#   ./scripts/healthcheck.sh                    # defaults to http://localhost:3001
#   ./scripts/healthcheck.sh http://myserver:3001
#
# Exit codes:
#   0 - All checks passed
#   1 - One or more checks failed

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="healthcheck@test.example.com"
TIMEOUT=10
PASS=0
FAIL=0
WARN=0

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  CYAN='\033[0;36m'
  NC='\033[0m'
else
  GREEN='' RED='' YELLOW='' CYAN='' NC=''
fi

print_header() {
  echo ""
  echo -e "${CYAN}========================================${NC}"
  echo -e "${CYAN} Timesheet App Health Check${NC}"
  echo -e "${CYAN} Target: ${BASE_URL}${NC}"
  echo -e "${CYAN} Time:   $(date -u '+%Y-%m-%d %H:%M:%S UTC')${NC}"
  echo -e "${CYAN}========================================${NC}"
  echo ""
}

check_pass() {
  echo -e "  ${GREEN}PASS${NC} $1"
  PASS=$((PASS + 1))
}

check_fail() {
  echo -e "  ${RED}FAIL${NC} $1"
  FAIL=$((FAIL + 1))
}

check_warn() {
  echo -e "  ${YELLOW}WARN${NC} $1"
  WARN=$((WARN + 1))
}

# Perform an HTTP request and capture status code + body
# Usage: http_check METHOD URL [DATA] [EXTRA_HEADERS...]
http_check() {
  local method="$1"
  local url="$2"
  local data="${3:-}"
  shift 3 || shift $#

  local curl_args=(
    -s
    -w "\n%{http_code}"
    --max-time "$TIMEOUT"
    -X "$method"
    -H "Content-Type: application/json"
    -H "x-user-email: ${TEST_EMAIL}"
  )

  for header in "$@"; do
    curl_args+=(-H "$header")
  done

  if [ -n "$data" ]; then
    curl_args+=(-d "$data")
  fi

  local response
  response=$(curl "${curl_args[@]}" "$url" 2>&1) || {
    HTTP_BODY="Connection failed"
    HTTP_CODE="000"
    return 1
  }

  HTTP_CODE=$(echo "$response" | tail -n1)
  HTTP_BODY=$(echo "$response" | sed '$d')
}

# -------------------------------------------------------
# 1. Health Endpoint
# -------------------------------------------------------
test_health_endpoint() {
  echo -e "${CYAN}[1/7] Health Endpoint${NC}"

  http_check GET "${BASE_URL}/health"
  if [ "$HTTP_CODE" = "200" ]; then
    check_pass "GET /health -> $HTTP_CODE"

    # Verify response contains expected fields
    if echo "$HTTP_BODY" | grep -q '"status"'; then
      check_pass "Response contains 'status' field"
    else
      check_warn "Response missing 'status' field"
    fi

    if echo "$HTTP_BODY" | grep -q '"timestamp"'; then
      check_pass "Response contains 'timestamp' field"
    else
      check_warn "Response missing 'timestamp' field"
    fi
  else
    check_fail "GET /health -> $HTTP_CODE (expected 200)"
    echo -e "  ${RED}CRITICAL: Health endpoint unreachable. Remaining checks may fail.${NC}"
  fi
}

# -------------------------------------------------------
# 2. Authentication Endpoints
# -------------------------------------------------------
test_auth_endpoints() {
  echo ""
  echo -e "${CYAN}[2/7] Authentication Endpoints${NC}"

  # POST /api/auth/login
  http_check POST "${BASE_URL}/api/auth/login" '{"email":"'"${TEST_EMAIL}"'"}'
  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    check_pass "POST /api/auth/login -> $HTTP_CODE"
  else
    check_fail "POST /api/auth/login -> $HTTP_CODE (expected 200 or 201)"
  fi

  # POST /api/auth/login with invalid email
  http_check POST "${BASE_URL}/api/auth/login" '{"email":"not-an-email"}'
  if [ "$HTTP_CODE" = "400" ]; then
    check_pass "POST /api/auth/login (invalid email) -> $HTTP_CODE (validation works)"
  else
    check_warn "POST /api/auth/login (invalid email) -> $HTTP_CODE (expected 400)"
  fi

  # GET /api/auth/me
  http_check GET "${BASE_URL}/api/auth/me"
  if [ "$HTTP_CODE" = "200" ]; then
    check_pass "GET /api/auth/me -> $HTTP_CODE"
  else
    check_fail "GET /api/auth/me -> $HTTP_CODE (expected 200)"
  fi

  # GET /api/auth/me without email header
  local response
  response=$(curl -s -w "\n%{http_code}" --max-time "$TIMEOUT" \
    -H "Content-Type: application/json" \
    "${BASE_URL}/api/auth/me" 2>&1) || true
  local code
  code=$(echo "$response" | tail -n1)
  if [ "$code" = "401" ]; then
    check_pass "GET /api/auth/me (no auth header) -> $code (auth enforced)"
  else
    check_warn "GET /api/auth/me (no auth header) -> $code (expected 401)"
  fi
}

# -------------------------------------------------------
# 3. Client Endpoints
# -------------------------------------------------------
test_client_endpoints() {
  echo ""
  echo -e "${CYAN}[3/7] Client Endpoints${NC}"

  # Create a test client
  http_check POST "${BASE_URL}/api/clients" '{"name":"HealthCheck Test Client","description":"Created by health check script"}'
  local client_id=""
  if [ "$HTTP_CODE" = "201" ]; then
    check_pass "POST /api/clients -> $HTTP_CODE"
    client_id=$(echo "$HTTP_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  else
    check_fail "POST /api/clients -> $HTTP_CODE (expected 201)"
  fi

  # GET /api/clients
  http_check GET "${BASE_URL}/api/clients"
  if [ "$HTTP_CODE" = "200" ]; then
    check_pass "GET /api/clients -> $HTTP_CODE"
  else
    check_fail "GET /api/clients -> $HTTP_CODE (expected 200)"
  fi

  # GET /api/clients/:id
  if [ -n "$client_id" ]; then
    http_check GET "${BASE_URL}/api/clients/${client_id}"
    if [ "$HTTP_CODE" = "200" ]; then
      check_pass "GET /api/clients/${client_id} -> $HTTP_CODE"
    else
      check_fail "GET /api/clients/${client_id} -> $HTTP_CODE (expected 200)"
    fi

    # PUT /api/clients/:id
    http_check PUT "${BASE_URL}/api/clients/${client_id}" '{"name":"HealthCheck Updated Client"}'
    if [ "$HTTP_CODE" = "200" ]; then
      check_pass "PUT /api/clients/${client_id} -> $HTTP_CODE"
    else
      check_fail "PUT /api/clients/${client_id} -> $HTTP_CODE (expected 200)"
    fi
  fi

  # Export CLIENT_ID for use in subsequent tests
  CREATED_CLIENT_ID="$client_id"
}

# -------------------------------------------------------
# 4. Work Entry Endpoints
# -------------------------------------------------------
test_work_entry_endpoints() {
  echo ""
  echo -e "${CYAN}[4/7] Work Entry Endpoints${NC}"

  local work_entry_id=""

  if [ -n "${CREATED_CLIENT_ID:-}" ]; then
    # Create a test work entry
    local today
    today=$(date -u '+%Y-%m-%d')
    http_check POST "${BASE_URL}/api/work-entries" \
      '{"clientId":'"${CREATED_CLIENT_ID}"',"hours":1.5,"description":"Health check test entry","date":"'"${today}"'"}'
    if [ "$HTTP_CODE" = "201" ]; then
      check_pass "POST /api/work-entries -> $HTTP_CODE"
      work_entry_id=$(echo "$HTTP_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
    else
      check_fail "POST /api/work-entries -> $HTTP_CODE (expected 201)"
    fi
  else
    check_warn "Skipping work entry creation (no test client available)"
  fi

  # GET /api/work-entries
  http_check GET "${BASE_URL}/api/work-entries"
  if [ "$HTTP_CODE" = "200" ]; then
    check_pass "GET /api/work-entries -> $HTTP_CODE"
  else
    check_fail "GET /api/work-entries -> $HTTP_CODE (expected 200)"
  fi

  # GET /api/work-entries with client filter
  if [ -n "${CREATED_CLIENT_ID:-}" ]; then
    http_check GET "${BASE_URL}/api/work-entries?clientId=${CREATED_CLIENT_ID}"
    if [ "$HTTP_CODE" = "200" ]; then
      check_pass "GET /api/work-entries?clientId=${CREATED_CLIENT_ID} -> $HTTP_CODE"
    else
      check_fail "GET /api/work-entries?clientId=${CREATED_CLIENT_ID} -> $HTTP_CODE (expected 200)"
    fi
  fi

  # GET /api/work-entries/:id
  if [ -n "$work_entry_id" ]; then
    http_check GET "${BASE_URL}/api/work-entries/${work_entry_id}"
    if [ "$HTTP_CODE" = "200" ]; then
      check_pass "GET /api/work-entries/${work_entry_id} -> $HTTP_CODE"
    else
      check_fail "GET /api/work-entries/${work_entry_id} -> $HTTP_CODE (expected 200)"
    fi
  fi

  CREATED_WORK_ENTRY_ID="$work_entry_id"
}

# -------------------------------------------------------
# 5. Report Endpoints
# -------------------------------------------------------
test_report_endpoints() {
  echo ""
  echo -e "${CYAN}[5/7] Report Endpoints${NC}"

  if [ -n "${CREATED_CLIENT_ID:-}" ]; then
    # GET /api/reports/client/:clientId
    http_check GET "${BASE_URL}/api/reports/client/${CREATED_CLIENT_ID}"
    if [ "$HTTP_CODE" = "200" ]; then
      check_pass "GET /api/reports/client/${CREATED_CLIENT_ID} -> $HTTP_CODE"
    else
      check_fail "GET /api/reports/client/${CREATED_CLIENT_ID} -> $HTTP_CODE (expected 200)"
    fi

    # CSV export
    http_check GET "${BASE_URL}/api/reports/export/csv/${CREATED_CLIENT_ID}"
    if [ "$HTTP_CODE" = "200" ]; then
      check_pass "GET /api/reports/export/csv/${CREATED_CLIENT_ID} -> $HTTP_CODE"
    else
      check_fail "GET /api/reports/export/csv/${CREATED_CLIENT_ID} -> $HTTP_CODE (expected 200)"
    fi

    # PDF export
    http_check GET "${BASE_URL}/api/reports/export/pdf/${CREATED_CLIENT_ID}"
    if [ "$HTTP_CODE" = "200" ]; then
      check_pass "GET /api/reports/export/pdf/${CREATED_CLIENT_ID} -> $HTTP_CODE"
    else
      check_fail "GET /api/reports/export/pdf/${CREATED_CLIENT_ID} -> $HTTP_CODE (expected 200)"
    fi
  else
    check_warn "Skipping report tests (no test client available)"
  fi
}

# -------------------------------------------------------
# 6. Error Handling
# -------------------------------------------------------
test_error_handling() {
  echo ""
  echo -e "${CYAN}[6/7] Error Handling${NC}"

  # 404 for unknown routes
  http_check GET "${BASE_URL}/api/nonexistent-route"
  if [ "$HTTP_CODE" = "404" ]; then
    check_pass "GET /api/nonexistent-route -> $HTTP_CODE (404 handler works)"
  else
    check_warn "GET /api/nonexistent-route -> $HTTP_CODE (expected 404)"
  fi

  # Invalid client ID
  http_check GET "${BASE_URL}/api/clients/not-a-number"
  if [ "$HTTP_CODE" = "400" ]; then
    check_pass "GET /api/clients/not-a-number -> $HTTP_CODE (validation works)"
  else
    check_warn "GET /api/clients/not-a-number -> $HTTP_CODE (expected 400)"
  fi

  # Client that doesn't exist
  http_check GET "${BASE_URL}/api/clients/999999"
  if [ "$HTTP_CODE" = "404" ]; then
    check_pass "GET /api/clients/999999 -> $HTTP_CODE (not found works)"
  else
    check_warn "GET /api/clients/999999 -> $HTTP_CODE (expected 404)"
  fi

  # Invalid work entry payload
  http_check POST "${BASE_URL}/api/work-entries" '{"invalid":"data"}'
  if [ "$HTTP_CODE" = "400" ]; then
    check_pass "POST /api/work-entries (invalid payload) -> $HTTP_CODE (validation works)"
  else
    check_warn "POST /api/work-entries (invalid payload) -> $HTTP_CODE (expected 400)"
  fi
}

# -------------------------------------------------------
# 7. Cleanup Test Data
# -------------------------------------------------------
cleanup_test_data() {
  echo ""
  echo -e "${CYAN}[7/7] Cleanup${NC}"

  # Delete test work entry
  if [ -n "${CREATED_WORK_ENTRY_ID:-}" ]; then
    http_check DELETE "${BASE_URL}/api/work-entries/${CREATED_WORK_ENTRY_ID}"
    if [ "$HTTP_CODE" = "200" ]; then
      check_pass "DELETE /api/work-entries/${CREATED_WORK_ENTRY_ID} -> $HTTP_CODE (cleanup)"
    else
      check_warn "DELETE /api/work-entries/${CREATED_WORK_ENTRY_ID} -> $HTTP_CODE (cleanup may have failed)"
    fi
  fi

  # Delete test client
  if [ -n "${CREATED_CLIENT_ID:-}" ]; then
    http_check DELETE "${BASE_URL}/api/clients/${CREATED_CLIENT_ID}"
    if [ "$HTTP_CODE" = "200" ]; then
      check_pass "DELETE /api/clients/${CREATED_CLIENT_ID} -> $HTTP_CODE (cleanup)"
    else
      check_warn "DELETE /api/clients/${CREATED_CLIENT_ID} -> $HTTP_CODE (cleanup may have failed)"
    fi
  fi
}

# -------------------------------------------------------
# Main
# -------------------------------------------------------
print_header

test_health_endpoint
test_auth_endpoints
test_client_endpoints
test_work_entry_endpoints
test_report_endpoints
test_error_handling
cleanup_test_data

# Summary
echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN} Results${NC}"
echo -e "${CYAN}========================================${NC}"
echo -e "  ${GREEN}Passed:   ${PASS}${NC}"
echo -e "  ${RED}Failed:   ${FAIL}${NC}"
echo -e "  ${YELLOW}Warnings: ${WARN}${NC}"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}HEALTH CHECK FAILED - ${FAIL} check(s) failed.${NC}"
  echo -e "${RED}Refer to RUNBOOK.md for troubleshooting procedures.${NC}"
  exit 1
else
  echo -e "${GREEN}HEALTH CHECK PASSED - All critical checks OK.${NC}"
  exit 0
fi
