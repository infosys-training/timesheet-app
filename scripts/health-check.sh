#!/usr/bin/env bash
# =============================================================================
# Timesheet Application — Health Check Script
#
# Tests all critical endpoints of the Timesheet API.
# Exit code 0 = all checks passed, non-zero = one or more checks failed.
#
# Usage:
#   ./scripts/health-check.sh                    # defaults to http://localhost:3001
#   ./scripts/health-check.sh http://prod:3001   # custom base URL
#   HEALTH_CHECK_EMAIL=me@co.com ./scripts/health-check.sh  # custom test email
# =============================================================================
set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="${HEALTH_CHECK_EMAIL:-healthcheck@test.example.com}"
TIMEOUT=10
PASSED=0
FAILED=0
WARNINGS=0
RESULTS=()

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

log_pass() {
  PASSED=$((PASSED + 1))
  RESULTS+=("${GREEN}PASS${NC}  $1")
  echo -e "${GREEN}PASS${NC}  $1"
}

log_fail() {
  FAILED=$((FAILED + 1))
  RESULTS+=("${RED}FAIL${NC}  $1")
  echo -e "${RED}FAIL${NC}  $1"
}

log_warn() {
  WARNINGS=$((WARNINGS + 1))
  RESULTS+=("${YELLOW}WARN${NC}  $1")
  echo -e "${YELLOW}WARN${NC}  $1"
}

# ---------------------------------------------------------------------------
# Helper: make an HTTP request and capture status code + body + timing
# Args: METHOD URL [DATA] [EXTRA_HEADERS...]
# Sets: HTTP_STATUS, HTTP_BODY, HTTP_TIME
# ---------------------------------------------------------------------------
http_request() {
  local method="$1"
  local url="$2"
  local data="${3:-}"
  shift 3 || shift $#

  local curl_args=(
    -s -S
    --max-time "$TIMEOUT"
    -w '\n%{http_code}\n%{time_total}'
    -X "$method"
    -H "Content-Type: application/json"
    -H "x-user-email: ${TEST_EMAIL}"
  )

  # Add any extra headers
  for header in "$@"; do
    curl_args+=(-H "$header")
  done

  if [ -n "$data" ]; then
    curl_args+=(-d "$data")
  fi

  local output
  output=$(curl "${curl_args[@]}" "$url" 2>&1) || true

  # Parse: body is everything up to the last two lines, then status, then time
  HTTP_TIME=$(echo "$output" | tail -1)
  HTTP_STATUS=$(echo "$output" | tail -2 | head -1)
  HTTP_BODY=$(echo "$output" | sed '$d' | sed '$d')
}

echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  Timesheet App Health Check${NC}"
echo -e "${CYAN}  Target: ${BASE_URL}${NC}"
echo -e "${CYAN}  Time:   $(date -u +"%Y-%m-%d %H:%M:%S UTC")${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# ---------------------------------------------------------------------------
# 1. Health Endpoint
# ---------------------------------------------------------------------------
echo -e "${CYAN}--- Core Health ---${NC}"

http_request GET "${BASE_URL}/health"
if [ "$HTTP_STATUS" = "200" ]; then
  log_pass "GET /health — status 200 (${HTTP_TIME}s)"
  # Verify JSON body contains expected fields
  if echo "$HTTP_BODY" | grep -q '"status":"OK"'; then
    log_pass "GET /health — response contains {\"status\":\"OK\"}"
  else
    log_warn "GET /health — unexpected response body: ${HTTP_BODY}"
  fi
else
  log_fail "GET /health — expected 200, got ${HTTP_STATUS}"
fi

# Check response time
if command -v bc &>/dev/null && [ -n "$HTTP_TIME" ]; then
  slow=$(echo "$HTTP_TIME > 2.0" | bc -l 2>/dev/null || echo 0)
  if [ "$slow" = "1" ]; then
    log_warn "GET /health — slow response: ${HTTP_TIME}s (threshold: 2s)"
  fi
fi

# ---------------------------------------------------------------------------
# 2. Authentication — Login
# ---------------------------------------------------------------------------
echo ""
echo -e "${CYAN}--- Authentication ---${NC}"

http_request POST "${BASE_URL}/api/auth/login" "{\"email\":\"${TEST_EMAIL}\"}"
if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "201" ]; then
  log_pass "POST /api/auth/login — status ${HTTP_STATUS} (${HTTP_TIME}s)"
else
  log_fail "POST /api/auth/login — expected 200/201, got ${HTTP_STATUS}"
fi

# Auth — Get current user
http_request GET "${BASE_URL}/api/auth/me"
if [ "$HTTP_STATUS" = "200" ]; then
  log_pass "GET /api/auth/me — status 200 (${HTTP_TIME}s)"
else
  log_fail "GET /api/auth/me — expected 200, got ${HTTP_STATUS}"
fi

# Auth — Missing header should return 401
local_output=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
  -X GET "${BASE_URL}/api/auth/me" 2>&1) || true
if [ "$local_output" = "401" ]; then
  log_pass "GET /api/auth/me (no header) — correctly returns 401"
else
  log_warn "GET /api/auth/me (no header) — expected 401, got ${local_output}"
fi

# ---------------------------------------------------------------------------
# 3. Clients API
# ---------------------------------------------------------------------------
echo ""
echo -e "${CYAN}--- Clients API ---${NC}"

# List clients
http_request GET "${BASE_URL}/api/clients"
if [ "$HTTP_STATUS" = "200" ]; then
  log_pass "GET /api/clients — status 200 (${HTTP_TIME}s)"
else
  log_fail "GET /api/clients — expected 200, got ${HTTP_STATUS}"
fi

# Create a test client
http_request POST "${BASE_URL}/api/clients" '{"name":"HealthCheck Test Client","description":"Auto-created by health check script"}'
if [ "$HTTP_STATUS" = "201" ]; then
  log_pass "POST /api/clients — status 201 (${HTTP_TIME}s)"
  # Extract client ID from response
  CLIENT_ID=$(echo "$HTTP_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
else
  log_fail "POST /api/clients — expected 201, got ${HTTP_STATUS}"
  CLIENT_ID=""
fi

# Get specific client
if [ -n "$CLIENT_ID" ]; then
  http_request GET "${BASE_URL}/api/clients/${CLIENT_ID}"
  if [ "$HTTP_STATUS" = "200" ]; then
    log_pass "GET /api/clients/${CLIENT_ID} — status 200 (${HTTP_TIME}s)"
  else
    log_fail "GET /api/clients/${CLIENT_ID} — expected 200, got ${HTTP_STATUS}"
  fi
fi

# Validate client creation with bad data returns 400
http_request POST "${BASE_URL}/api/clients" '{"description":"missing required name field"}'
if [ "$HTTP_STATUS" = "400" ]; then
  log_pass "POST /api/clients (invalid) — correctly returns 400"
else
  log_warn "POST /api/clients (invalid) — expected 400, got ${HTTP_STATUS}"
fi

# ---------------------------------------------------------------------------
# 4. Work Entries API
# ---------------------------------------------------------------------------
echo ""
echo -e "${CYAN}--- Work Entries API ---${NC}"

# List work entries
http_request GET "${BASE_URL}/api/work-entries"
if [ "$HTTP_STATUS" = "200" ]; then
  log_pass "GET /api/work-entries — status 200 (${HTTP_TIME}s)"
else
  log_fail "GET /api/work-entries — expected 200, got ${HTTP_STATUS}"
fi

# Create a work entry (only if we have a client)
if [ -n "$CLIENT_ID" ]; then
  TODAY=$(date -u +"%Y-%m-%d")
  http_request POST "${BASE_URL}/api/work-entries" "{\"clientId\":${CLIENT_ID},\"hours\":1.5,\"description\":\"Health check test entry\",\"date\":\"${TODAY}\"}"
  if [ "$HTTP_STATUS" = "201" ]; then
    log_pass "POST /api/work-entries — status 201 (${HTTP_TIME}s)"
    ENTRY_ID=$(echo "$HTTP_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  else
    log_fail "POST /api/work-entries — expected 201, got ${HTTP_STATUS}"
    ENTRY_ID=""
  fi

  # Get specific work entry
  if [ -n "$ENTRY_ID" ]; then
    http_request GET "${BASE_URL}/api/work-entries/${ENTRY_ID}"
    if [ "$HTTP_STATUS" = "200" ]; then
      log_pass "GET /api/work-entries/${ENTRY_ID} — status 200 (${HTTP_TIME}s)"
    else
      log_fail "GET /api/work-entries/${ENTRY_ID} — expected 200, got ${HTTP_STATUS}"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 5. Reports API
# ---------------------------------------------------------------------------
echo ""
echo -e "${CYAN}--- Reports API ---${NC}"

if [ -n "$CLIENT_ID" ]; then
  # Client report
  http_request GET "${BASE_URL}/api/reports/client/${CLIENT_ID}"
  if [ "$HTTP_STATUS" = "200" ]; then
    log_pass "GET /api/reports/client/${CLIENT_ID} — status 200 (${HTTP_TIME}s)"
  else
    log_fail "GET /api/reports/client/${CLIENT_ID} — expected 200, got ${HTTP_STATUS}"
  fi

  # CSV export
  http_request GET "${BASE_URL}/api/reports/export/csv/${CLIENT_ID}"
  if [ "$HTTP_STATUS" = "200" ]; then
    log_pass "GET /api/reports/export/csv/${CLIENT_ID} — status 200 (${HTTP_TIME}s)"
  else
    log_fail "GET /api/reports/export/csv/${CLIENT_ID} — expected 200, got ${HTTP_STATUS}"
  fi

  # PDF export
  http_request GET "${BASE_URL}/api/reports/export/pdf/${CLIENT_ID}"
  if [ "$HTTP_STATUS" = "200" ]; then
    log_pass "GET /api/reports/export/pdf/${CLIENT_ID} — status 200 (${HTTP_TIME}s)"
  else
    log_fail "GET /api/reports/export/pdf/${CLIENT_ID} — expected 200, got ${HTTP_STATUS}"
  fi
else
  log_warn "Skipping reports tests — no test client available"
fi

# ---------------------------------------------------------------------------
# 6. Error Handling
# ---------------------------------------------------------------------------
echo ""
echo -e "${CYAN}--- Error Handling ---${NC}"

# 404 for unknown routes
http_request GET "${BASE_URL}/api/nonexistent-route"
if [ "$HTTP_STATUS" = "404" ]; then
  log_pass "GET /api/nonexistent-route — correctly returns 404"
else
  log_warn "GET /api/nonexistent-route — expected 404, got ${HTTP_STATUS}"
fi

# Invalid client ID format
http_request GET "${BASE_URL}/api/clients/not-a-number"
if [ "$HTTP_STATUS" = "400" ]; then
  log_pass "GET /api/clients/not-a-number — correctly returns 400"
else
  log_warn "GET /api/clients/not-a-number — expected 400, got ${HTTP_STATUS}"
fi

# ---------------------------------------------------------------------------
# 7. Cleanup — Delete test data
# ---------------------------------------------------------------------------
echo ""
echo -e "${CYAN}--- Cleanup ---${NC}"

if [ -n "${ENTRY_ID:-}" ]; then
  http_request DELETE "${BASE_URL}/api/work-entries/${ENTRY_ID}"
  if [ "$HTTP_STATUS" = "200" ]; then
    log_pass "DELETE /api/work-entries/${ENTRY_ID} — cleanup OK"
  else
    log_warn "DELETE /api/work-entries/${ENTRY_ID} — cleanup returned ${HTTP_STATUS}"
  fi
fi

if [ -n "${CLIENT_ID:-}" ]; then
  http_request DELETE "${BASE_URL}/api/clients/${CLIENT_ID}"
  if [ "$HTTP_STATUS" = "200" ]; then
    log_pass "DELETE /api/clients/${CLIENT_ID} — cleanup OK"
  else
    log_warn "DELETE /api/clients/${CLIENT_ID} — cleanup returned ${HTTP_STATUS}"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  Summary${NC}"
echo -e "${CYAN}========================================${NC}"
echo -e "  ${GREEN}Passed:${NC}   ${PASSED}"
echo -e "  ${RED}Failed:${NC}   ${FAILED}"
echo -e "  ${YELLOW}Warnings:${NC} ${WARNINGS}"
echo ""

if [ "$FAILED" -gt 0 ]; then
  echo -e "${RED}HEALTH CHECK FAILED — ${FAILED} check(s) did not pass.${NC}"
  exit 1
elif [ "$WARNINGS" -gt 0 ]; then
  echo -e "${YELLOW}HEALTH CHECK PASSED WITH WARNINGS — ${WARNINGS} warning(s).${NC}"
  exit 0
else
  echo -e "${GREEN}ALL HEALTH CHECKS PASSED.${NC}"
  exit 0
fi
