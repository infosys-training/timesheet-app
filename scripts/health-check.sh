#!/usr/bin/env bash
# =============================================================================
# Timesheet Application Health Check Script
# See RUNBOOK.md for incident response procedures if checks fail.
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE_URL="${1:-http://localhost:3001}"
VERBOSE=false
FRONTEND_URL=""
PASS_COUNT=0
FAIL_COUNT=0
TOTAL_COUNT=0
AUTH_EMAIL="healthcheck@test.com"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --verbose)
      VERBOSE=true
      ;;
    --frontend=*)
      FRONTEND_URL="${arg#*=}"
      ;;
    --help|-h)
      echo "Usage: $0 [BASE_URL] [OPTIONS]"
      echo ""
      echo "Arguments:"
      echo "  BASE_URL                Backend URL (default: http://localhost:3001)"
      echo ""
      echo "Options:"
      echo "  --verbose               Show detailed output for each check"
      echo "  --frontend=URL          Also check frontend availability"
      echo "  --help, -h              Show this help message"
      echo ""
      echo "Examples:"
      echo "  $0"
      echo "  $0 http://localhost:3001 --verbose"
      echo "  $0 https://app.example.com --frontend=https://app.example.com"
      exit 0
      ;;
  esac
done

# Remove trailing slash from BASE_URL
BASE_URL="${BASE_URL%/}"

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------
timestamp() {
  date -u '+%Y-%m-%d %H:%M:%S UTC'
}

log_pass() {
  local name="$1"
  local detail="${2:-}"
  PASS_COUNT=$((PASS_COUNT + 1))
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  echo -e "[$(timestamp)] ${GREEN}PASS${NC}  ${name}"
  if [ "$VERBOSE" = true ] && [ -n "$detail" ]; then
    echo -e "       ${CYAN}${detail}${NC}"
  fi
}

log_fail() {
  local name="$1"
  local detail="${2:-}"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  echo -e "[$(timestamp)] ${RED}FAIL${NC}  ${name}"
  if [ -n "$detail" ]; then
    echo -e "       ${RED}${detail}${NC}"
  fi
}

log_info() {
  if [ "$VERBOSE" = true ]; then
    echo -e "       ${CYAN}$1${NC}"
  fi
}

# ---------------------------------------------------------------------------
# Health Checks
# ---------------------------------------------------------------------------

echo ""
echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW} Timesheet App Health Check${NC}"
echo -e "${YELLOW} Target: ${BASE_URL}${NC}"
echo -e "${YELLOW} Time:   $(timestamp)${NC}"
echo -e "${YELLOW}========================================${NC}"
echo ""

# 1. Backend Health
echo -e "${CYAN}--- Backend Health ---${NC}"
HEALTH_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${BASE_URL}/health" 2>/dev/null) || HEALTH_RESPONSE="000"
HEALTH_BODY=$(curl -s --max-time 10 "${BASE_URL}/health" 2>/dev/null) || HEALTH_BODY=""

if [ "$HEALTH_RESPONSE" = "200" ] && echo "$HEALTH_BODY" | grep -q '"status":"OK"'; then
  log_pass "Backend Health (GET /health)" "HTTP ${HEALTH_RESPONSE} — ${HEALTH_BODY}"
else
  log_fail "Backend Health (GET /health)" "HTTP ${HEALTH_RESPONSE} — ${HEALTH_BODY}"
fi

# 2. Auth Login
echo -e "${CYAN}--- Authentication ---${NC}"
LOGIN_RESPONSE=$(curl -s -w "\n%{http_code}" --max-time 10 \
  -X POST "${BASE_URL}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${AUTH_EMAIL}\"}" 2>/dev/null) || LOGIN_RESPONSE=$'\n000'

LOGIN_BODY=$(echo "$LOGIN_RESPONSE" | sed '$d')
LOGIN_STATUS=$(echo "$LOGIN_RESPONSE" | tail -1)

if [ "$LOGIN_STATUS" = "200" ] || [ "$LOGIN_STATUS" = "201" ]; then
  log_pass "Auth Login (POST /api/auth/login)" "HTTP ${LOGIN_STATUS}"
  log_info "Response: ${LOGIN_BODY}"
else
  log_fail "Auth Login (POST /api/auth/login)" "HTTP ${LOGIN_STATUS} — ${LOGIN_BODY}"
fi

# 3. Auth Me
ME_RESPONSE=$(curl -s -w "\n%{http_code}" --max-time 10 \
  -H "x-user-email: ${AUTH_EMAIL}" \
  "${BASE_URL}/api/auth/me" 2>/dev/null) || ME_RESPONSE=$'\n000'

ME_BODY=$(echo "$ME_RESPONSE" | sed '$d')
ME_STATUS=$(echo "$ME_RESPONSE" | tail -1)

if [ "$ME_STATUS" = "200" ]; then
  log_pass "Auth Me (GET /api/auth/me)" "HTTP ${ME_STATUS}"
  log_info "Response: ${ME_BODY}"
else
  log_fail "Auth Me (GET /api/auth/me)" "HTTP ${ME_STATUS} — ${ME_BODY}"
fi

# 4. Clients List
echo -e "${CYAN}--- API Endpoints ---${NC}"
CLIENTS_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -H "x-user-email: ${AUTH_EMAIL}" \
  "${BASE_URL}/api/clients" 2>/dev/null) || CLIENTS_RESPONSE="000"

if [ "$CLIENTS_RESPONSE" = "200" ]; then
  log_pass "Clients List (GET /api/clients)" "HTTP ${CLIENTS_RESPONSE}"
else
  log_fail "Clients List (GET /api/clients)" "HTTP ${CLIENTS_RESPONSE}"
fi

# 5. Work Entries List
ENTRIES_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -H "x-user-email: ${AUTH_EMAIL}" \
  "${BASE_URL}/api/work-entries" 2>/dev/null) || ENTRIES_RESPONSE="000"

if [ "$ENTRIES_RESPONSE" = "200" ]; then
  log_pass "Work Entries List (GET /api/work-entries)" "HTTP ${ENTRIES_RESPONSE}"
else
  log_fail "Work Entries List (GET /api/work-entries)" "HTTP ${ENTRIES_RESPONSE}"
fi

# 6. 404 Handler
echo -e "${CYAN}--- Error Handling ---${NC}"
NOT_FOUND_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  "${BASE_URL}/nonexistent" 2>/dev/null) || NOT_FOUND_RESPONSE="000"

if [ "$NOT_FOUND_RESPONSE" = "404" ]; then
  log_pass "404 Handler (GET /nonexistent)" "HTTP ${NOT_FOUND_RESPONSE}"
else
  log_fail "404 Handler (GET /nonexistent)" "Expected 404, got HTTP ${NOT_FOUND_RESPONSE}"
fi

# 7. Response Time
echo -e "${CYAN}--- Performance ---${NC}"
RESPONSE_TIME=$(curl -s -o /dev/null -w "%{time_total}" --max-time 10 \
  "${BASE_URL}/health" 2>/dev/null) || RESPONSE_TIME="99"

# Compare using awk (avoid bash floating point issues)
TIME_OK=$(awk "BEGIN { print ($RESPONSE_TIME < 2.0) ? 1 : 0 }")
if [ "$TIME_OK" = "1" ]; then
  log_pass "Response Time (GET /health < 2s)" "${RESPONSE_TIME}s"
else
  log_fail "Response Time (GET /health < 2s)" "${RESPONSE_TIME}s (exceeds 2s threshold)"
fi

# 8. Frontend (optional)
if [ -n "$FRONTEND_URL" ]; then
  echo -e "${CYAN}--- Frontend ---${NC}"
  FRONTEND_URL="${FRONTEND_URL%/}"
  FRONTEND_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    "${FRONTEND_URL}/" 2>/dev/null) || FRONTEND_RESPONSE="000"

  if [ "$FRONTEND_RESPONSE" = "200" ]; then
    log_pass "Frontend (GET /)" "HTTP ${FRONTEND_RESPONSE}"
  else
    log_fail "Frontend (GET /)" "HTTP ${FRONTEND_RESPONSE}"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW} Summary${NC}"
echo -e "${YELLOW}========================================${NC}"
echo -e " Total:  ${TOTAL_COUNT}"
echo -e " Passed: ${GREEN}${PASS_COUNT}${NC}"
echo -e " Failed: ${RED}${FAIL_COUNT}${NC}"
echo -e " Time:   $(timestamp)"
echo -e "${YELLOW}========================================${NC}"
echo ""

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "${RED}Health check FAILED — ${FAIL_COUNT} check(s) did not pass.${NC}"
  echo -e "Refer to RUNBOOK.md for troubleshooting guidance."
  exit 1
else
  echo -e "${GREEN}All health checks passed.${NC}"
  exit 0
fi
