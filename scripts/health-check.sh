#!/usr/bin/env bash
# =============================================================================
# Timesheet App — Health Check Script
# =============================================================================
# Tests all critical endpoints and reports service status.
#
# Usage:
#   ./scripts/health-check.sh [BASE_URL]
#
# Arguments:
#   BASE_URL  — The base URL of the application (default: http://localhost:3001)
#
# Exit Codes:
#   0 — All checks passed
#   1 — One or more checks failed
#
# Examples:
#   ./scripts/health-check.sh
#   ./scripts/health-check.sh http://production-host:3001
#   ./scripts/health-check.sh https://timesheet.example.com
# =============================================================================

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="healthcheck@timesheet-app.example.com"
TIMEOUT=10
PASSED=0
FAILED=0
WARNINGS=0

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  NC='\033[0m'
else
  RED=''
  GREEN=''
  YELLOW=''
  BLUE=''
  NC=''
fi

# Utility functions
print_header() {
  echo ""
  echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}  Timesheet App Health Check${NC}"
  echo -e "${BLUE}  Target: ${BASE_URL}${NC}"
  echo -e "${BLUE}  Time:   $(date -u '+%Y-%m-%d %H:%M:%S UTC')${NC}"
  echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
  echo ""
}

check_pass() {
  echo -e "  ${GREEN}✓ PASS${NC} — $1"
  PASSED=$((PASSED + 1))
}

check_fail() {
  echo -e "  ${RED}✗ FAIL${NC} — $1"
  [ -n "${2:-}" ] && echo -e "         ${RED}→ $2${NC}"
  FAILED=$((FAILED + 1))
}

check_warn() {
  echo -e "  ${YELLOW}⚠ WARN${NC} — $1"
  [ -n "${2:-}" ] && echo -e "         ${YELLOW}→ $2${NC}"
  WARNINGS=$((WARNINGS + 1))
}

print_section() {
  echo ""
  echo -e "${BLUE}── $1 ──${NC}"
}

# Make HTTP request and capture response code + body
# Usage: http_request METHOD PATH [DATA]
http_request() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  local url="${BASE_URL}${path}"

  local curl_args=(-s -w "\n%{http_code}" --max-time "$TIMEOUT")

  if [ "$method" = "POST" ]; then
    curl_args+=(-X POST -H "Content-Type: application/json")
    if [ -n "$data" ]; then
      curl_args+=(-d "$data")
    fi
  else
    curl_args+=(-X "$method")
  fi

  curl_args+=(-H "x-user-email: ${TEST_EMAIL}")
  curl_args+=("$url")

  local response
  response=$(curl "${curl_args[@]}" 2>/dev/null) || {
    echo "000"
    return 1
  }

  echo "$response"
}

# Extract HTTP status code (last line of response)
get_status() {
  echo "$1" | tail -n1
}

# Extract response body (everything except last line)
get_body() {
  echo "$1" | sed '$d'
}

# =============================================================================
# Health Checks
# =============================================================================

print_header

# ---------------------------------------------------------------------------
# 1. Basic Connectivity
# ---------------------------------------------------------------------------
print_section "1. Basic Connectivity"

response=$(http_request GET "/health") || true
status=$(get_status "$response")
body=$(get_body "$response")

if [ "$status" = "200" ]; then
  check_pass "GET /health — HTTP 200"
  # Verify response contains expected fields
  if echo "$body" | grep -q '"status":"OK"'; then
    check_pass "Health response contains status: OK"
  else
    check_warn "Health response missing expected format" "Got: $body"
  fi
  if echo "$body" | grep -q '"timestamp"'; then
    check_pass "Health response contains timestamp"
  else
    check_warn "Health response missing timestamp field"
  fi
elif [ "$status" = "000" ]; then
  check_fail "GET /health — Connection refused" "Server not reachable at ${BASE_URL}"
else
  check_fail "GET /health — HTTP ${status}" "Expected 200, got ${status}"
fi

# ---------------------------------------------------------------------------
# 2. Authentication Endpoints
# ---------------------------------------------------------------------------
print_section "2. Authentication"

# Test login
response=$(http_request POST "/api/auth/login" "{\"email\":\"${TEST_EMAIL}\"}") || true
status=$(get_status "$response")
body=$(get_body "$response")

if [ "$status" = "200" ] || [ "$status" = "201" ]; then
  check_pass "POST /api/auth/login — HTTP ${status}"
else
  check_fail "POST /api/auth/login — HTTP ${status}" "Expected 200 or 201"
fi

# Test login validation (invalid email)
response=$(http_request POST "/api/auth/login" '{"email":"not-an-email"}') || true
status=$(get_status "$response")

if [ "$status" = "400" ]; then
  check_pass "POST /api/auth/login (invalid) — HTTP 400 (validation works)"
else
  check_warn "POST /api/auth/login (invalid) — HTTP ${status}" "Expected 400 for invalid email"
fi

# Test get current user
response=$(http_request GET "/api/auth/me") || true
status=$(get_status "$response")

if [ "$status" = "200" ]; then
  check_pass "GET /api/auth/me — HTTP 200"
elif [ "$status" = "404" ]; then
  check_warn "GET /api/auth/me — HTTP 404" "User not found (may not be registered)"
else
  check_fail "GET /api/auth/me — HTTP ${status}" "Expected 200 or 404"
fi

# Test auth without header
response=$(curl -s -w "\n%{http_code}" --max-time "$TIMEOUT" "${BASE_URL}/api/auth/me" 2>/dev/null) || true
status=$(get_status "$response")

if [ "$status" = "401" ]; then
  check_pass "GET /api/auth/me (no auth) — HTTP 401 (auth enforced)"
else
  check_fail "GET /api/auth/me (no auth) — HTTP ${status}" "Expected 401 without x-user-email header"
fi

# ---------------------------------------------------------------------------
# 3. Client Endpoints
# ---------------------------------------------------------------------------
print_section "3. Client Management"

# List clients
response=$(http_request GET "/api/clients") || true
status=$(get_status "$response")
body=$(get_body "$response")

if [ "$status" = "200" ]; then
  check_pass "GET /api/clients — HTTP 200"
  if echo "$body" | grep -q '"clients"'; then
    check_pass "Response contains 'clients' array"
  else
    check_warn "Response missing 'clients' field" "Got: $(echo "$body" | head -c 100)"
  fi
else
  check_fail "GET /api/clients — HTTP ${status}" "Expected 200"
fi

# Create a test client
response=$(http_request POST "/api/clients" '{"name":"HealthCheck Test Client","description":"Created by health check script"}') || true
status=$(get_status "$response")
body=$(get_body "$response")

if [ "$status" = "201" ]; then
  check_pass "POST /api/clients — HTTP 201 (create works)"
  CLIENT_ID=$(echo "$body" | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*')
else
  check_fail "POST /api/clients — HTTP ${status}" "Expected 201"
  CLIENT_ID=""
fi

# Get specific client
if [ -n "$CLIENT_ID" ]; then
  response=$(http_request GET "/api/clients/${CLIENT_ID}") || true
  status=$(get_status "$response")

  if [ "$status" = "200" ]; then
    check_pass "GET /api/clients/${CLIENT_ID} — HTTP 200"
  else
    check_fail "GET /api/clients/${CLIENT_ID} — HTTP ${status}" "Expected 200"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Work Entry Endpoints
# ---------------------------------------------------------------------------
print_section "4. Work Entries"

# List work entries
response=$(http_request GET "/api/work-entries") || true
status=$(get_status "$response")
body=$(get_body "$response")

if [ "$status" = "200" ]; then
  check_pass "GET /api/work-entries — HTTP 200"
  if echo "$body" | grep -q '"workEntries"'; then
    check_pass "Response contains 'workEntries' array"
  else
    check_warn "Response missing 'workEntries' field"
  fi
else
  check_fail "GET /api/work-entries — HTTP ${status}" "Expected 200"
fi

# Create a work entry (if we have a client)
if [ -n "$CLIENT_ID" ]; then
  TODAY=$(date -u '+%Y-%m-%d')
  response=$(http_request POST "/api/work-entries" "{\"clientId\":${CLIENT_ID},\"hours\":1.5,\"description\":\"Health check test entry\",\"date\":\"${TODAY}\"}") || true
  status=$(get_status "$response")

  if [ "$status" = "201" ]; then
    check_pass "POST /api/work-entries — HTTP 201 (create works)"
  else
    check_fail "POST /api/work-entries — HTTP ${status}" "Expected 201"
  fi
fi

# ---------------------------------------------------------------------------
# 5. Report Endpoints
# ---------------------------------------------------------------------------
print_section "5. Reports"

if [ -n "$CLIENT_ID" ]; then
  # Get client report
  response=$(http_request GET "/api/reports/client/${CLIENT_ID}") || true
  status=$(get_status "$response")
  body=$(get_body "$response")

  if [ "$status" = "200" ]; then
    check_pass "GET /api/reports/client/${CLIENT_ID} — HTTP 200"
    if echo "$body" | grep -q '"totalHours"'; then
      check_pass "Report contains 'totalHours' field"
    else
      check_warn "Report missing 'totalHours' field"
    fi
  else
    check_fail "GET /api/reports/client/${CLIENT_ID} — HTTP ${status}" "Expected 200"
  fi

  # CSV export
  response=$(http_request GET "/api/reports/export/csv/${CLIENT_ID}") || true
  status=$(get_status "$response")

  if [ "$status" = "200" ]; then
    check_pass "GET /api/reports/export/csv/${CLIENT_ID} — HTTP 200"
  else
    check_fail "GET /api/reports/export/csv/${CLIENT_ID} — HTTP ${status}" "Expected 200"
  fi

  # PDF export
  response=$(http_request GET "/api/reports/export/pdf/${CLIENT_ID}") || true
  status=$(get_status "$response")

  if [ "$status" = "200" ]; then
    check_pass "GET /api/reports/export/pdf/${CLIENT_ID} — HTTP 200"
  else
    check_fail "GET /api/reports/export/pdf/${CLIENT_ID} — HTTP ${status}" "Expected 200"
  fi
else
  check_warn "Skipping report tests — no client available"
fi

# ---------------------------------------------------------------------------
# 6. Error Handling
# ---------------------------------------------------------------------------
print_section "6. Error Handling"

# 404 route
response=$(http_request GET "/nonexistent-route") || true
status=$(get_status "$response")

if [ "$status" = "404" ]; then
  check_pass "GET /nonexistent-route — HTTP 404 (proper 404 handling)"
else
  check_warn "GET /nonexistent-route — HTTP ${status}" "Expected 404"
fi

# Invalid client ID
response=$(http_request GET "/api/clients/invalid") || true
status=$(get_status "$response")

if [ "$status" = "400" ]; then
  check_pass "GET /api/clients/invalid — HTTP 400 (input validation)"
else
  check_warn "GET /api/clients/invalid — HTTP ${status}" "Expected 400 for invalid ID"
fi

# Non-existent client
response=$(http_request GET "/api/clients/99999") || true
status=$(get_status "$response")

if [ "$status" = "404" ]; then
  check_pass "GET /api/clients/99999 — HTTP 404 (not found handling)"
else
  check_warn "GET /api/clients/99999 — HTTP ${status}" "Expected 404"
fi

# ---------------------------------------------------------------------------
# 7. Response Time Check
# ---------------------------------------------------------------------------
print_section "7. Performance"

start_time=$(date +%s%N)
curl -s -o /dev/null --max-time "$TIMEOUT" "${BASE_URL}/health" 2>/dev/null || true
end_time=$(date +%s%N)
elapsed_ms=$(( (end_time - start_time) / 1000000 ))

if [ "$elapsed_ms" -lt 500 ]; then
  check_pass "Health check response time: ${elapsed_ms}ms (< 500ms)"
elif [ "$elapsed_ms" -lt 2000 ]; then
  check_warn "Health check response time: ${elapsed_ms}ms (< 2000ms but slow)"
else
  check_fail "Health check response time: ${elapsed_ms}ms" "Exceeds 2000ms threshold"
fi

# ---------------------------------------------------------------------------
# 8. Cleanup
# ---------------------------------------------------------------------------
print_section "8. Cleanup"

if [ -n "$CLIENT_ID" ]; then
  response=$(curl -s -w "\n%{http_code}" --max-time "$TIMEOUT" -X DELETE \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${BASE_URL}/api/clients/${CLIENT_ID}" 2>/dev/null) || true
  status=$(get_status "$response")

  if [ "$status" = "200" ]; then
    check_pass "Cleaned up test client (ID: ${CLIENT_ID})"
  else
    check_warn "Failed to clean up test client (HTTP ${status})"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Summary${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${GREEN}Passed:${NC}   ${PASSED}"
echo -e "  ${RED}Failed:${NC}   ${FAILED}"
echo -e "  ${YELLOW}Warnings:${NC} ${WARNINGS}"
echo ""

if [ "$FAILED" -eq 0 ]; then
  echo -e "  ${GREEN}Overall: ALL CHECKS PASSED${NC}"
  echo ""
  exit 0
else
  echo -e "  ${RED}Overall: ${FAILED} CHECK(S) FAILED${NC}"
  echo ""
  echo "  Refer to RUNBOOK.md for troubleshooting procedures."
  echo ""
  exit 1
fi
