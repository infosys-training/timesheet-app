#!/usr/bin/env bash
# =============================================================================
# Timesheet App - Health Check Script
# =============================================================================
# Tests all critical endpoints of the Timesheet App backend.
# Intended for use in incident response, monitoring, and smoke testing.
#
# Usage:
#   ./scripts/healthcheck.sh                    # defaults to http://localhost:3001
#   ./scripts/healthcheck.sh http://prod:3001   # custom base URL
#   HEALTHCHECK_EMAIL=ops@co.com ./scripts/healthcheck.sh  # custom test email
#
# Exit codes:
#   0 - All checks passed
#   1 - One or more checks failed
# =============================================================================

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="${HEALTHCHECK_EMAIL:-healthcheck@test.example.com}"
TIMEOUT=10
PASSED=0
FAILED=0
WARNINGS=0
TOTAL=0

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' CYAN='' BOLD='' NC=''
fi

# ---- Helpers ----------------------------------------------------------------

print_header() {
  echo ""
  echo -e "${BOLD}${CYAN}=============================================${NC}"
  echo -e "${BOLD}${CYAN}  Timesheet App Health Check${NC}"
  echo -e "${BOLD}${CYAN}=============================================${NC}"
  echo -e "  Target:  ${BASE_URL}"
  echo -e "  Email:   ${TEST_EMAIL}"
  echo -e "  Time:    $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  echo -e "${BOLD}${CYAN}=============================================${NC}"
  echo ""
}

check_pass() {
  local name="$1"
  local detail="${2:-}"
  PASSED=$((PASSED + 1))
  TOTAL=$((TOTAL + 1))
  echo -e "  ${GREEN}PASS${NC}  ${name}${detail:+ - ${detail}}"
}

check_fail() {
  local name="$1"
  local detail="${2:-}"
  FAILED=$((FAILED + 1))
  TOTAL=$((TOTAL + 1))
  echo -e "  ${RED}FAIL${NC}  ${name}${detail:+ - ${detail}}"
}

check_warn() {
  local name="$1"
  local detail="${2:-}"
  WARNINGS=$((WARNINGS + 1))
  TOTAL=$((TOTAL + 1))
  echo -e "  ${YELLOW}WARN${NC}  ${name}${detail:+ - ${detail}}"
}

# Perform an HTTP request and capture status code + body + timing.
# Usage: http_check METHOD URL [DATA]
# Sets: HTTP_STATUS, HTTP_BODY, HTTP_TIME
http_check() {
  local method="$1"
  local url="$2"
  local data="${3:-}"

  local curl_args=(
    -s -o /tmp/healthcheck_body.txt -w '%{http_code} %{time_total}'
    --max-time "$TIMEOUT"
    -X "$method"
    -H "Content-Type: application/json"
    -H "x-user-email: ${TEST_EMAIL}"
  )

  if [ -n "$data" ]; then
    curl_args+=(-d "$data")
  fi

  local result
  if result=$(curl "${curl_args[@]}" "${url}" 2>/dev/null); then
    HTTP_STATUS=$(echo "$result" | awk '{print $1}')
    HTTP_TIME=$(echo "$result" | awk '{print $2}')
    HTTP_BODY=$(cat /tmp/healthcheck_body.txt 2>/dev/null || echo "")
  else
    HTTP_STATUS="000"
    HTTP_TIME="0"
    HTTP_BODY="Connection failed"
  fi
}

# ---- Checks -----------------------------------------------------------------

check_health_endpoint() {
  echo -e "${BOLD}[1/7] Health Endpoint${NC}"
  http_check GET "${BASE_URL}/health"

  if [ "$HTTP_STATUS" = "200" ]; then
    local status
    status=$(echo "$HTTP_BODY" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
    check_pass "/health" "status=${status}, response_time=${HTTP_TIME}s"
  else
    check_fail "/health" "HTTP ${HTTP_STATUS}, response_time=${HTTP_TIME}s"
  fi
}

check_auth_login() {
  echo -e "${BOLD}[2/7] Auth - Login${NC}"
  http_check POST "${BASE_URL}/api/auth/login" "{\"email\":\"${TEST_EMAIL}\"}"

  if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "201" ]; then
    check_pass "POST /api/auth/login" "HTTP ${HTTP_STATUS}, response_time=${HTTP_TIME}s"
  else
    check_fail "POST /api/auth/login" "HTTP ${HTTP_STATUS}, body=${HTTP_BODY}"
  fi
}

check_auth_me() {
  echo -e "${BOLD}[3/7] Auth - Current User${NC}"
  http_check GET "${BASE_URL}/api/auth/me"

  if [ "$HTTP_STATUS" = "200" ]; then
    check_pass "GET /api/auth/me" "HTTP ${HTTP_STATUS}, response_time=${HTTP_TIME}s"
  else
    check_fail "GET /api/auth/me" "HTTP ${HTTP_STATUS}, body=${HTTP_BODY}"
  fi
}

check_clients_endpoint() {
  echo -e "${BOLD}[4/7] Clients API${NC}"

  # GET all clients
  http_check GET "${BASE_URL}/api/clients"
  if [ "$HTTP_STATUS" = "200" ]; then
    local count
    count=$(echo "$HTTP_BODY" | grep -o '"clients":\[' | wc -l)
    check_pass "GET /api/clients" "HTTP ${HTTP_STATUS}, response_time=${HTTP_TIME}s"
  else
    check_fail "GET /api/clients" "HTTP ${HTTP_STATUS}, body=${HTTP_BODY}"
  fi

  # POST create a test client
  http_check POST "${BASE_URL}/api/clients" '{"name":"_healthcheck_test_client"}'
  if [ "$HTTP_STATUS" = "201" ]; then
    local client_id
    client_id=$(echo "$HTTP_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
    check_pass "POST /api/clients" "HTTP ${HTTP_STATUS}, created id=${client_id}"

    # GET specific client
    if [ -n "$client_id" ]; then
      http_check GET "${BASE_URL}/api/clients/${client_id}"
      if [ "$HTTP_STATUS" = "200" ]; then
        check_pass "GET /api/clients/${client_id}" "HTTP ${HTTP_STATUS}"
      else
        check_fail "GET /api/clients/${client_id}" "HTTP ${HTTP_STATUS}"
      fi

      # DELETE test client (cleanup)
      http_check DELETE "${BASE_URL}/api/clients/${client_id}"
      if [ "$HTTP_STATUS" = "200" ]; then
        check_pass "DELETE /api/clients/${client_id}" "HTTP ${HTTP_STATUS} (cleanup)"
      else
        check_warn "DELETE /api/clients/${client_id}" "HTTP ${HTTP_STATUS} (cleanup failed)"
      fi
    fi
  else
    check_fail "POST /api/clients" "HTTP ${HTTP_STATUS}, body=${HTTP_BODY}"
  fi
}

check_work_entries_endpoint() {
  echo -e "${BOLD}[5/7] Work Entries API${NC}"

  # GET all work entries
  http_check GET "${BASE_URL}/api/work-entries"
  if [ "$HTTP_STATUS" = "200" ]; then
    check_pass "GET /api/work-entries" "HTTP ${HTTP_STATUS}, response_time=${HTTP_TIME}s"
  else
    check_fail "GET /api/work-entries" "HTTP ${HTTP_STATUS}, body=${HTTP_BODY}"
  fi
}

check_reports_endpoint() {
  echo -e "${BOLD}[6/7] Reports API${NC}"

  # Create a temp client + work entry to test reports
  http_check POST "${BASE_URL}/api/clients" '{"name":"_healthcheck_report_client"}'
  if [ "$HTTP_STATUS" = "201" ]; then
    local client_id
    client_id=$(echo "$HTTP_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

    if [ -n "$client_id" ]; then
      # Create a work entry for the report
      local today
      today=$(date -u '+%Y-%m-%d')
      http_check POST "${BASE_URL}/api/work-entries" "{\"clientId\":${client_id},\"hours\":1,\"description\":\"healthcheck\",\"date\":\"${today}\"}"

      local entry_id=""
      if [ "$HTTP_STATUS" = "201" ]; then
        entry_id=$(echo "$HTTP_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
      fi

      # Test JSON report
      http_check GET "${BASE_URL}/api/reports/client/${client_id}"
      if [ "$HTTP_STATUS" = "200" ]; then
        check_pass "GET /api/reports/client/:id" "HTTP ${HTTP_STATUS}, response_time=${HTTP_TIME}s"
      else
        check_fail "GET /api/reports/client/:id" "HTTP ${HTTP_STATUS}"
      fi

      # Test CSV export
      http_check GET "${BASE_URL}/api/reports/export/csv/${client_id}"
      if [ "$HTTP_STATUS" = "200" ]; then
        check_pass "GET /api/reports/export/csv/:id" "HTTP ${HTTP_STATUS}, response_time=${HTTP_TIME}s"
      else
        check_fail "GET /api/reports/export/csv/:id" "HTTP ${HTTP_STATUS}"
      fi

      # Test PDF export
      http_check GET "${BASE_URL}/api/reports/export/pdf/${client_id}"
      if [ "$HTTP_STATUS" = "200" ]; then
        check_pass "GET /api/reports/export/pdf/:id" "HTTP ${HTTP_STATUS}, response_time=${HTTP_TIME}s"
      else
        check_fail "GET /api/reports/export/pdf/:id" "HTTP ${HTTP_STATUS}"
      fi

      # Cleanup: delete work entry, then client
      if [ -n "$entry_id" ]; then
        http_check DELETE "${BASE_URL}/api/work-entries/${entry_id}"
      fi
      http_check DELETE "${BASE_URL}/api/clients/${client_id}"
    fi
  else
    check_warn "Reports test skipped" "Could not create temp client (HTTP ${HTTP_STATUS})"
  fi
}

check_error_handling() {
  echo -e "${BOLD}[7/7] Error Handling & Edge Cases${NC}"

  # 404 route
  http_check GET "${BASE_URL}/nonexistent-route"
  if [ "$HTTP_STATUS" = "404" ]; then
    check_pass "404 handler" "HTTP ${HTTP_STATUS} for unknown route"
  else
    check_fail "404 handler" "Expected 404, got HTTP ${HTTP_STATUS}"
  fi

  # Auth required without header
  local result
  result=$(curl -s -o /tmp/healthcheck_body.txt -w '%{http_code}' \
    --max-time "$TIMEOUT" \
    -X GET "${BASE_URL}/api/clients" 2>/dev/null) || result="000"
  if [ "$result" = "401" ]; then
    check_pass "Auth enforcement" "HTTP 401 without x-user-email header"
  else
    check_fail "Auth enforcement" "Expected 401, got HTTP ${result}"
  fi

  # Validation error
  http_check POST "${BASE_URL}/api/auth/login" '{"email":"not-an-email"}'
  if [ "$HTTP_STATUS" = "400" ]; then
    check_pass "Input validation" "HTTP 400 for invalid email"
  else
    check_fail "Input validation" "Expected 400, got HTTP ${HTTP_STATUS}"
  fi

  # Response time warning
  http_check GET "${BASE_URL}/health"
  local time_ms
  time_ms=$(echo "$HTTP_TIME" | awk '{printf "%.0f", $1 * 1000}')
  if [ "$time_ms" -gt 2000 ]; then
    check_warn "Response time" "Health check took ${HTTP_TIME}s (>2s threshold)"
  else
    check_pass "Response time" "Health check responded in ${HTTP_TIME}s"
  fi
}

# ---- Main -------------------------------------------------------------------

print_header

check_health_endpoint
echo ""
check_auth_login
echo ""
check_auth_me
echo ""
check_clients_endpoint
echo ""
check_work_entries_endpoint
echo ""
check_reports_endpoint
echo ""
check_error_handling

# ---- Summary ----------------------------------------------------------------

echo ""
echo -e "${BOLD}${CYAN}=============================================${NC}"
echo -e "${BOLD}  Summary${NC}"
echo -e "${BOLD}${CYAN}=============================================${NC}"
echo -e "  Total checks:  ${TOTAL}"
echo -e "  ${GREEN}Passed:        ${PASSED}${NC}"
if [ "$FAILED" -gt 0 ]; then
  echo -e "  ${RED}Failed:        ${FAILED}${NC}"
else
  echo -e "  Failed:        ${FAILED}"
fi
if [ "$WARNINGS" -gt 0 ]; then
  echo -e "  ${YELLOW}Warnings:      ${WARNINGS}${NC}"
else
  echo -e "  Warnings:      ${WARNINGS}"
fi
echo -e "${BOLD}${CYAN}=============================================${NC}"

# Cleanup temp file
rm -f /tmp/healthcheck_body.txt

if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo -e "${RED}${BOLD}HEALTH CHECK FAILED${NC} - ${FAILED} check(s) did not pass."
  echo "Refer to RUNBOOK.md for troubleshooting procedures."
  exit 1
else
  echo ""
  echo -e "${GREEN}${BOLD}ALL CHECKS PASSED${NC}"
  exit 0
fi
