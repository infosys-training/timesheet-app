#!/usr/bin/env bash
#
# Health Check Script for Timesheet App
# Tests all critical API endpoints and reports status.
#
# Usage:
#   ./scripts/healthcheck.sh [BASE_URL]
#
# Examples:
#   ./scripts/healthcheck.sh                        # defaults to http://localhost:3001
#   ./scripts/healthcheck.sh http://localhost:3001
#   ./scripts/healthcheck.sh https://timesheet.example.com

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="healthcheck@test.example.com"

PASS=0
FAIL=0
WARN=0
RESULTS=()

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' NC=''
fi

log_pass() {
  PASS=$((PASS + 1))
  RESULTS+=("${GREEN}PASS${NC} $1")
  printf "${GREEN}PASS${NC} %s\n" "$1"
}

log_fail() {
  FAIL=$((FAIL + 1))
  RESULTS+=("${RED}FAIL${NC} $1")
  printf "${RED}FAIL${NC} %s\n" "$1"
}

log_warn() {
  WARN=$((WARN + 1))
  RESULTS+=("${YELLOW}WARN${NC} $1")
  printf "${YELLOW}WARN${NC} %s\n" "$1"
}

log_info() {
  printf "${BLUE}INFO${NC} %s\n" "$1"
}

# check_endpoint METHOD PATH EXPECTED_STATUS [DESCRIPTION] [DATA] [EXTRA_CURL_ARGS...]
check_endpoint() {
  local method="$1"
  local path="$2"
  local expected_status="$3"
  local description="${4:-$method $path}"
  local data="${5:-}"
  shift 5 2>/dev/null || true

  local url="${BASE_URL}${path}"
  local curl_args=(-s -o /dev/null -w "%{http_code}|%{time_total}" --max-time 10)

  if [ "$method" != "GET" ]; then
    curl_args+=(-X "$method")
  fi

  if [ -n "$data" ]; then
    curl_args+=(-H "Content-Type: application/json" -d "$data")
  fi

  # Add auth header for authenticated endpoints
  curl_args+=(-H "x-user-email: ${TEST_EMAIL}")

  local response
  response=$(curl "${curl_args[@]}" "$url" 2>&1) || true

  local status_code="${response%%|*}"
  local response_time="${response##*|}"

  if [ "$status_code" = "$expected_status" ]; then
    log_pass "${description} (${status_code}) [${response_time}s]"
  elif [ "$status_code" = "000" ]; then
    log_fail "${description} - Connection refused (server unreachable)"
  else
    log_fail "${description} - Expected ${expected_status}, got ${status_code} [${response_time}s]"
  fi
}

# check_endpoint_response METHOD PATH EXPECTED_STATUS BODY_PATTERN DESCRIPTION [DATA]
check_endpoint_response() {
  local method="$1"
  local path="$2"
  local expected_status="$3"
  local body_pattern="$4"
  local description="$5"
  local data="${6:-}"

  local url="${BASE_URL}${path}"
  local curl_args=(-s -w "\n%{http_code}" --max-time 10)

  if [ "$method" != "GET" ]; then
    curl_args+=(-X "$method")
  fi

  if [ -n "$data" ]; then
    curl_args+=(-H "Content-Type: application/json" -d "$data")
  fi

  curl_args+=(-H "x-user-email: ${TEST_EMAIL}")

  local full_response
  full_response=$(curl "${curl_args[@]}" "$url" 2>&1) || true

  local status_code
  status_code=$(echo "$full_response" | tail -1)
  local body
  body=$(echo "$full_response" | sed '$d')

  if [ "$status_code" != "$expected_status" ]; then
    if [ "$status_code" = "000" ]; then
      log_fail "${description} - Connection refused"
    else
      log_fail "${description} - Expected status ${expected_status}, got ${status_code}"
    fi
    return
  fi

  if echo "$body" | grep -q "$body_pattern"; then
    log_pass "${description} (${status_code})"
  else
    log_warn "${description} - Status OK but response body missing expected pattern '${body_pattern}'"
  fi
}

# ─── Main ────────────────────────────────────────────────────────────────────

echo ""
echo "============================================"
echo "  Timesheet App Health Check"
echo "  Target: ${BASE_URL}"
echo "  Time:   $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
echo "============================================"
echo ""

# ─── 1. Server Health ────────────────────────────────────────────────────────

log_info "--- Server Health ---"
check_endpoint_response "GET" "/health" "200" '"status":"OK"' "Health endpoint returns OK"

# ─── 2. Authentication ───────────────────────────────────────────────────────

log_info "--- Authentication ---"
# Login returns 200 (existing user) or 201 (new user created)
login_response=$(curl -s -w "\n%{http_code}" --max-time 10 \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${TEST_EMAIL}\"}" \
  "${BASE_URL}/api/auth/login" 2>&1) || true
login_status=$(echo "$login_response" | tail -1)
login_body=$(echo "$login_response" | sed '$d')
if [ "$login_status" = "200" ] || [ "$login_status" = "201" ]; then
  if echo "$login_body" | grep -q '"email"'; then
    log_pass "Login with valid email (${login_status})"
  else
    log_warn "Login returned ${login_status} but response missing email field"
  fi
elif [ "$login_status" = "000" ]; then
  log_fail "Login - Connection refused"
else
  log_fail "Login - Expected 200 or 201, got ${login_status}"
fi

check_endpoint "GET" "/api/auth/me" "200" "Get current user info"

# Test invalid auth
local_curl_args=(-s -o /dev/null -w "%{http_code}" --max-time 10)
no_auth_status=$(curl "${local_curl_args[@]}" "${BASE_URL}/api/auth/me" 2>&1) || true
if [ "$no_auth_status" = "401" ]; then
  log_pass "Auth middleware rejects unauthenticated requests (401)"
else
  log_warn "Auth middleware returned ${no_auth_status} instead of 401 for unauthenticated request"
fi

# ─── 3. Clients API ─────────────────────────────────────────────────────────

log_info "--- Clients API ---"
check_endpoint "GET" "/api/clients" "200" "List clients"

# Create a test client and capture the response
create_response=$(curl -s --max-time 10 \
  -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  -d '{"name":"HealthCheck Test Client","description":"Created by health check script"}' \
  "${BASE_URL}/api/clients" 2>&1) || true

create_status=$(echo "$create_response" | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*') || true

if [ -n "$create_status" ]; then
  CLIENT_ID="$create_status"
  log_pass "Create client (201) - ID: ${CLIENT_ID}"

  check_endpoint "GET" "/api/clients/${CLIENT_ID}" "200" "Get specific client"
  check_endpoint "PUT" "/api/clients/${CLIENT_ID}" "200" "Update client" \
    '{"name":"HealthCheck Updated Client"}'
else
  CLIENT_ID=""
  log_fail "Create client - Could not extract client ID from response"
fi

# ─── 4. Work Entries API ─────────────────────────────────────────────────────

log_info "--- Work Entries API ---"
check_endpoint "GET" "/api/work-entries" "200" "List work entries"

if [ -n "$CLIENT_ID" ]; then
  today=$(date -u +"%Y-%m-%d")
  entry_response=$(curl -s --max-time 10 \
    -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    -d "{\"clientId\":${CLIENT_ID},\"hours\":1.5,\"description\":\"Health check test entry\",\"date\":\"${today}\"}" \
    "${BASE_URL}/api/work-entries" 2>&1) || true

  entry_id=$(echo "$entry_response" | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*') || true

  if [ -n "$entry_id" ]; then
    log_pass "Create work entry (201) - ID: ${entry_id}"
    check_endpoint "GET" "/api/work-entries/${entry_id}" "200" "Get specific work entry"
  else
    log_fail "Create work entry - Could not extract entry ID from response"
    entry_id=""
  fi
fi

# ─── 5. Reports API ─────────────────────────────────────────────────────────

log_info "--- Reports API ---"
if [ -n "$CLIENT_ID" ]; then
  check_endpoint "GET" "/api/reports/client/${CLIENT_ID}" "200" "Get client report"
  check_endpoint "GET" "/api/reports/export/csv/${CLIENT_ID}" "200" "Export CSV report"
  check_endpoint "GET" "/api/reports/export/pdf/${CLIENT_ID}" "200" "Export PDF report"
fi

# ─── 6. Error Handling ───────────────────────────────────────────────────────

log_info "--- Error Handling ---"
check_endpoint "GET" "/nonexistent-route" "404" "404 handler for unknown routes"
check_endpoint "GET" "/api/clients/invalid" "400" "Invalid ID returns 400"

invalid_body_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  -d '{}' \
  "${BASE_URL}/api/clients" 2>&1) || true

if [ "$invalid_body_status" = "400" ]; then
  log_pass "Validation rejects invalid request body (400)"
else
  log_warn "Validation returned ${invalid_body_status} instead of 400 for empty client body"
fi

# ─── 7. Cleanup ──────────────────────────────────────────────────────────────

log_info "--- Cleanup ---"

if [ -n "${entry_id:-}" ]; then
  cleanup_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    -X DELETE \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/work-entries/${entry_id}" 2>&1) || true
  if [ "$cleanup_status" = "200" ]; then
    log_pass "Delete test work entry (200)"
  else
    log_warn "Cleanup work entry returned ${cleanup_status}"
  fi
fi

if [ -n "${CLIENT_ID:-}" ]; then
  cleanup_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    -X DELETE \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/clients/${CLIENT_ID}" 2>&1) || true
  if [ "$cleanup_status" = "200" ]; then
    log_pass "Delete test client (200)"
  else
    log_warn "Cleanup client returned ${cleanup_status}"
  fi
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "============================================"
echo "  Health Check Summary"
echo "============================================"
printf "  ${GREEN}Passed:${NC}  %d\n" "$PASS"
printf "  ${RED}Failed:${NC}  %d\n" "$FAIL"
printf "  ${YELLOW}Warnings:${NC} %d\n" "$WARN"
echo "  Total:    $((PASS + FAIL + WARN))"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  printf "${RED}Health check FAILED with %d failure(s).${NC}\n" "$FAIL"
  echo "Refer to RUNBOOK.md for troubleshooting procedures."
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo ""
  printf "${YELLOW}Health check passed with %d warning(s).${NC}\n" "$WARN"
  exit 0
else
  echo ""
  printf "${GREEN}All health checks passed.${NC}\n"
  exit 0
fi
