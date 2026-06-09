#!/usr/bin/env bash
#
# healthcheck.sh — Verify all critical endpoints of the Timesheet App.
#
# Usage:
#   ./scripts/healthcheck.sh                    # defaults to http://localhost:3001
#   ./scripts/healthcheck.sh https://app.example.com
#   TIMEOUT=10 ./scripts/healthcheck.sh         # custom timeout (seconds)
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed
#
# Requirements: curl, jq (optional, for JSON pretty-printing)

set -euo pipefail

###############################################################################
# Configuration
###############################################################################

BASE_URL="${1:-http://localhost:3001}"
TIMEOUT="${TIMEOUT:-5}"
VERBOSE="${VERBOSE:-false}"
TEST_EMAIL="healthcheck-probe@timesheet-healthcheck.example.com"

# Colors (disabled when stdout is not a terminal)
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  CYAN='\033[0;36m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' CYAN='' NC=''
fi

###############################################################################
# State
###############################################################################

PASS=0
FAIL=0
WARN=0
RESULTS=()

###############################################################################
# Helpers
###############################################################################

log_pass() {
  PASS=$((PASS + 1))
  RESULTS+=("${GREEN}PASS${NC}  $1")
  echo -e "  ${GREEN}PASS${NC}  $1"
}

log_fail() {
  FAIL=$((FAIL + 1))
  RESULTS+=("${RED}FAIL${NC}  $1")
  echo -e "  ${RED}FAIL${NC}  $1"
}

log_warn() {
  WARN=$((WARN + 1))
  RESULTS+=("${YELLOW}WARN${NC}  $1")
  echo -e "  ${YELLOW}WARN${NC}  $1"
}

log_info() {
  echo -e "  ${CYAN}INFO${NC}  $1"
}

# http_check <method> <path> <expected_status> <description> [data] [extra_headers...]
http_check() {
  local method="$1"
  local path="$2"
  local expected_status="$3"
  local description="$4"
  local data="${5:-}"
  shift 5 || true
  local extra_headers=("$@")

  local url="${BASE_URL}${path}"
  local curl_args=(-s -o /tmp/hc_body -w "%{http_code}" --max-time "$TIMEOUT" -X "$method")

  # Add content-type for POST/PUT
  if [[ "$method" == "POST" || "$method" == "PUT" ]]; then
    curl_args+=(-H "Content-Type: application/json")
  fi

  # Add extra headers
  for hdr in "${extra_headers[@]+"${extra_headers[@]}"}"; do
    curl_args+=(-H "$hdr")
  done

  # Add data
  if [[ -n "$data" ]]; then
    curl_args+=(-d "$data")
  fi

  local status
  status=$(curl "${curl_args[@]}" "$url" 2>/dev/null) || status="000"

  if [[ "$status" == "$expected_status" ]]; then
    log_pass "$description (HTTP $status)"
  elif [[ "$status" == "000" ]]; then
    log_fail "$description — connection refused or timeout"
  else
    log_fail "$description — expected HTTP $expected_status, got $status"
    if [[ "$VERBOSE" == "true" ]] && [ -f /tmp/hc_body ]; then
      log_info "Response body: $(head -c 500 /tmp/hc_body)"
    fi
  fi

  return 0
}

# response_time_check <path> <warn_ms> <description>
response_time_check() {
  local path="$1"
  local warn_ms="$2"
  local description="$3"

  local url="${BASE_URL}${path}"
  local time_total
  time_total=$(curl -s -o /dev/null -w "%{time_total}" --max-time "$TIMEOUT" "$url" 2>/dev/null) || time_total="999"

  local ms
  ms=$(awk "BEGIN {printf \"%d\", $time_total * 1000}" 2>/dev/null)
  ms="${ms:-9999}"

  if [[ "$ms" -le "$warn_ms" ]]; then
    log_pass "$description (${ms}ms)"
  else
    log_warn "$description — response time ${ms}ms exceeds ${warn_ms}ms threshold"
  fi
}

###############################################################################
# Checks
###############################################################################

echo ""
echo "======================================================================"
echo "  Timesheet App Health Check"
echo "  Target: $BASE_URL"
echo "  Time:   $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "======================================================================"
echo ""

# --------------------------------------------------------------------------
# 1. Basic connectivity & health endpoint
# --------------------------------------------------------------------------
echo "${CYAN}[1/7] Core Health${NC}"

http_check GET "/health" "200" "Health endpoint"
response_time_check "/health" 500 "Health endpoint latency"

echo ""

# --------------------------------------------------------------------------
# 2. Authentication endpoints
# --------------------------------------------------------------------------
echo "${CYAN}[2/7] Authentication${NC}"

# Login returns 201 for new user, 200 for existing user — accept both.
LOGIN_URL="${BASE_URL}/api/auth/login"
LOGIN_STATUS=$(curl -s -o /tmp/hc_body -w "%{http_code}" --max-time "$TIMEOUT" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\"}" "$LOGIN_URL" 2>/dev/null) || LOGIN_STATUS="000"

if [[ "$LOGIN_STATUS" == "200" || "$LOGIN_STATUS" == "201" ]]; then
  log_pass "Login endpoint (HTTP $LOGIN_STATUS)"
elif [[ "$LOGIN_STATUS" == "000" ]]; then
  log_fail "Login endpoint — connection refused or timeout"
else
  log_fail "Login endpoint — expected HTTP 200 or 201, got $LOGIN_STATUS"
fi

http_check GET "/api/auth/me" "200" \
  "Get current user" \
  "" \
  "x-user-email: $TEST_EMAIL"

http_check POST "/api/auth/login" "400" \
  "Login validation rejects invalid email" \
  '{"email":"not-an-email"}'

echo ""

# --------------------------------------------------------------------------
# 3. Client CRUD endpoints
# --------------------------------------------------------------------------
echo "${CYAN}[3/7] Clients API${NC}"

http_check POST "/api/clients" "201" \
  "Create client" \
  '{"name":"HealthCheck Test Client","description":"Auto-created by healthcheck"}' \
  "x-user-email: $TEST_EMAIL"

# Extract client ID from response
CLIENT_ID=""
if [ -f /tmp/hc_body ]; then
  CLIENT_ID=$(cat /tmp/hc_body | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*' || echo "")
fi

http_check GET "/api/clients" "200" \
  "List clients" \
  "" \
  "x-user-email: $TEST_EMAIL"

if [[ -n "$CLIENT_ID" ]]; then
  http_check GET "/api/clients/$CLIENT_ID" "200" \
    "Get client by ID" \
    "" \
    "x-user-email: $TEST_EMAIL"

  http_check PUT "/api/clients/$CLIENT_ID" "200" \
    "Update client" \
    '{"name":"HealthCheck Updated Client"}' \
    "x-user-email: $TEST_EMAIL"
else
  log_warn "Skipping client GET/PUT — could not extract client ID"
fi

echo ""

# --------------------------------------------------------------------------
# 4. Work entry endpoints
# --------------------------------------------------------------------------
echo "${CYAN}[4/7] Work Entries API${NC}"

if [[ -n "$CLIENT_ID" ]]; then
  TODAY=$(date -u '+%Y-%m-%d')

  http_check POST "/api/work-entries" "201" \
    "Create work entry" \
    "{\"clientId\":$CLIENT_ID,\"hours\":2.5,\"description\":\"Healthcheck entry\",\"date\":\"$TODAY\"}" \
    "x-user-email: $TEST_EMAIL"

  ENTRY_ID=""
  if [ -f /tmp/hc_body ]; then
    ENTRY_ID=$(cat /tmp/hc_body | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*' || echo "")
  fi

  http_check GET "/api/work-entries" "200" \
    "List work entries" \
    "" \
    "x-user-email: $TEST_EMAIL"

  http_check GET "/api/work-entries?clientId=$CLIENT_ID" "200" \
    "List work entries (filtered by client)" \
    "" \
    "x-user-email: $TEST_EMAIL"

  if [[ -n "$ENTRY_ID" ]]; then
    http_check GET "/api/work-entries/$ENTRY_ID" "200" \
      "Get work entry by ID" \
      "" \
      "x-user-email: $TEST_EMAIL"
  fi
else
  log_warn "Skipping work entry checks — no client ID available"
fi

echo ""

# --------------------------------------------------------------------------
# 5. Reports & export endpoints
# --------------------------------------------------------------------------
echo "${CYAN}[5/7] Reports & Exports${NC}"

if [[ -n "$CLIENT_ID" ]]; then
  http_check GET "/api/reports/client/$CLIENT_ID" "200" \
    "Client report (JSON)" \
    "" \
    "x-user-email: $TEST_EMAIL"

  http_check GET "/api/reports/export/csv/$CLIENT_ID" "200" \
    "Export CSV report" \
    "" \
    "x-user-email: $TEST_EMAIL"

  http_check GET "/api/reports/export/pdf/$CLIENT_ID" "200" \
    "Export PDF report" \
    "" \
    "x-user-email: $TEST_EMAIL"
else
  log_warn "Skipping report checks — no client ID available"
fi

echo ""

# --------------------------------------------------------------------------
# 6. Error handling & edge cases
# --------------------------------------------------------------------------
echo "${CYAN}[6/7] Error Handling${NC}"

http_check GET "/api/clients" "401" \
  "Unauthenticated request rejected"

http_check GET "/api/nonexistent-route" "404" \
  "Unknown route returns 404"

http_check GET "/api/clients/999999" "404" \
  "Non-existent resource returns 404" \
  "" \
  "x-user-email: $TEST_EMAIL"

http_check POST "/api/clients" "400" \
  "Invalid payload rejected (missing required field)" \
  '{"description":"no name field"}' \
  "x-user-email: $TEST_EMAIL"

echo ""

# --------------------------------------------------------------------------
# 7. Cleanup & response time
# --------------------------------------------------------------------------
echo "${CYAN}[7/7] Cleanup & Performance${NC}"

if [[ -n "${ENTRY_ID:-}" ]]; then
  http_check DELETE "/api/work-entries/$ENTRY_ID" "200" \
    "Delete test work entry" \
    "" \
    "x-user-email: $TEST_EMAIL"
fi

if [[ -n "${CLIENT_ID:-}" ]]; then
  http_check DELETE "/api/clients/$CLIENT_ID" "200" \
    "Delete test client" \
    "" \
    "x-user-email: $TEST_EMAIL"
fi

response_time_check "/api/clients" 1000 "Clients API latency"

echo ""

###############################################################################
# Summary
###############################################################################

echo "======================================================================"
echo "  Summary"
echo "======================================================================"
echo -e "  ${GREEN}Passed${NC}: $PASS"
echo -e "  ${RED}Failed${NC}: $FAIL"
echo -e "  ${YELLOW}Warnings${NC}: $WARN"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo -e "  ${RED}RESULT: UNHEALTHY — $FAIL check(s) failed${NC}"
  echo ""
  echo "  Refer to RUNBOOK.md for response procedures."
  echo "======================================================================"
  exit 1
else
  echo -e "  ${GREEN}RESULT: HEALTHY — all checks passed${NC}"
  echo "======================================================================"
  exit 0
fi
