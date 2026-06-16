#!/usr/bin/env bash
# =============================================================================
# Timesheet App — Health Check Script
#
# Tests all critical backend endpoints to verify the application is operational.
# Returns exit code 0 if all checks pass, 1 if any check fails.
#
# Usage:
#   ./scripts/healthcheck.sh                    # defaults to http://localhost:3001
#   ./scripts/healthcheck.sh http://prod:3001   # custom base URL
#   HEALTHCHECK_EMAIL=me@co.com ./scripts/healthcheck.sh
# =============================================================================

set -uo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="${HEALTHCHECK_EMAIL:-healthcheck@timesheet-app.com}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

PASS=0
FAIL=0
WARN=0
RESULTS=()

check() {
  local name="$1"
  local method="$2"
  local url="$3"
  local expected_status="$4"
  shift 4
  local extra_args=("$@")

  local http_code
  local tmpfile
  tmpfile=$(mktemp)

  http_code=$(curl -s -o "$tmpfile" -w "%{http_code}" \
    -X "$method" \
    --connect-timeout 5 \
    --max-time 10 \
    "${extra_args[@]}" \
    "$url" 2>/dev/null) || http_code="000"

  rm -f "$tmpfile"

  if [[ "$http_code" == "$expected_status" ]]; then
    RESULTS+=("${GREEN}PASS${NC}  $name (HTTP $http_code)")
    PASS=$((PASS + 1))
  elif [[ "$http_code" == "000" ]]; then
    RESULTS+=("${RED}FAIL${NC}  $name — Connection refused / timeout")
    FAIL=$((FAIL + 1))
  else
    RESULTS+=("${RED}FAIL${NC}  $name — Expected HTTP $expected_status, got $http_code")
    FAIL=$((FAIL + 1))
  fi
}

check_multi_status() {
  local name="$1"
  local method="$2"
  local url="$3"
  local expected_statuses="$4"
  local json_field="$5"
  shift 5
  local extra_args=("$@")

  local http_code
  local body
  local tmpfile
  tmpfile=$(mktemp)

  http_code=$(curl -s -o "$tmpfile" -w "%{http_code}" \
    -X "$method" \
    --connect-timeout 5 \
    --max-time 10 \
    "${extra_args[@]}" \
    "$url" 2>/dev/null) || http_code="000"

  body=$(cat "$tmpfile" 2>/dev/null || true)
  rm -f "$tmpfile"

  local status_match=false
  for status in $expected_statuses; do
    if [[ "$http_code" == "$status" ]]; then
      status_match=true
      break
    fi
  done

  if [[ "$status_match" == "true" ]]; then
    if [[ -n "$json_field" ]] && echo "$body" | grep -q "$json_field"; then
      RESULTS+=("${GREEN}PASS${NC}  $name (HTTP $http_code, found '$json_field')")
      PASS=$((PASS + 1))
    elif [[ -n "$json_field" ]]; then
      RESULTS+=("${YELLOW}WARN${NC}  $name — HTTP $http_code OK but missing '$json_field' in response")
      WARN=$((WARN + 1))
    else
      RESULTS+=("${GREEN}PASS${NC}  $name (HTTP $http_code)")
      PASS=$((PASS + 1))
    fi
  elif [[ "$http_code" == "000" ]]; then
    RESULTS+=("${RED}FAIL${NC}  $name — Connection refused / timeout")
    FAIL=$((FAIL + 1))
  else
    RESULTS+=("${RED}FAIL${NC}  $name — Expected HTTP $expected_statuses, got $http_code")
    FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------
echo ""
echo -e "${BOLD}============================================${NC}"
echo -e "${BOLD}  Timesheet App — Health Check${NC}"
echo -e "${BOLD}============================================${NC}"
echo -e "  Target:  ${BASE_URL}"
echo -e "  Email:   ${TEST_EMAIL}"
echo -e "  Time:    $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo -e "${BOLD}--------------------------------------------${NC}"
echo ""

# ---------------------------------------------------------------------------
# 1. Basic Health Endpoint
# ---------------------------------------------------------------------------
echo -e "${BOLD}[1/7] Health Endpoint${NC}"
check_multi_status \
  "GET /health" \
  "GET" \
  "${BASE_URL}/health" \
  "200" \
  '"status"'

# ---------------------------------------------------------------------------
# 2. Authentication — Login
# ---------------------------------------------------------------------------
echo -e "${BOLD}[2/7] Authentication${NC}"
check_multi_status \
  "POST /api/auth/login" \
  "POST" \
  "${BASE_URL}/api/auth/login" \
  "200 201" \
  '"email"' \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${TEST_EMAIL}\"}"

check_multi_status \
  "GET /api/auth/me" \
  "GET" \
  "${BASE_URL}/api/auth/me" \
  "200" \
  '"email"' \
  -H "x-user-email: ${TEST_EMAIL}"

# ---------------------------------------------------------------------------
# 3. Clients API
# ---------------------------------------------------------------------------
echo -e "${BOLD}[3/7] Clients API${NC}"
check_multi_status \
  "GET /api/clients" \
  "GET" \
  "${BASE_URL}/api/clients" \
  "200" \
  '"clients"' \
  -H "x-user-email: ${TEST_EMAIL}"

# ---------------------------------------------------------------------------
# 4. Work Entries API
# ---------------------------------------------------------------------------
echo -e "${BOLD}[4/7] Work Entries API${NC}"
check_multi_status \
  "GET /api/work-entries" \
  "GET" \
  "${BASE_URL}/api/work-entries" \
  "200" \
  '"workEntries"' \
  -H "x-user-email: ${TEST_EMAIL}"

# ---------------------------------------------------------------------------
# 5. Authentication Enforcement
# ---------------------------------------------------------------------------
echo -e "${BOLD}[5/7] Auth Enforcement (expect 401 without header)${NC}"
check \
  "GET /api/clients (no auth)" \
  "GET" \
  "${BASE_URL}/api/clients" \
  "401"

# ---------------------------------------------------------------------------
# 6. Input Validation
# ---------------------------------------------------------------------------
echo -e "${BOLD}[6/7] Input Validation (expect 400 on bad input)${NC}"
check \
  "POST /api/auth/login (invalid email)" \
  "POST" \
  "${BASE_URL}/api/auth/login" \
  "400" \
  -H "Content-Type: application/json" \
  -d '{"email":"not-an-email"}'

# ---------------------------------------------------------------------------
# 7. 404 Handler
# ---------------------------------------------------------------------------
echo -e "${BOLD}[7/7] 404 Handler${NC}"
check \
  "GET /nonexistent" \
  "GET" \
  "${BASE_URL}/nonexistent" \
  "404"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${BOLD}============================================${NC}"
echo -e "${BOLD}  Results${NC}"
echo -e "${BOLD}============================================${NC}"
for result in "${RESULTS[@]}"; do
  echo -e "  $result"
done
echo ""
echo -e "${BOLD}--------------------------------------------${NC}"
echo -e "  ${GREEN}Passed:${NC}  ${PASS}"
echo -e "  ${RED}Failed:${NC}  ${FAIL}"
echo -e "  ${YELLOW}Warned:${NC}  ${WARN}"
echo -e "${BOLD}============================================${NC}"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  echo -e "${RED}${BOLD}HEALTH CHECK FAILED${NC} — $FAIL check(s) did not pass."
  echo "Refer to RUNBOOK.md for troubleshooting procedures."
  exit 1
elif [[ "$WARN" -gt 0 ]]; then
  echo -e "${YELLOW}${BOLD}HEALTH CHECK PASSED WITH WARNINGS${NC} — $WARN warning(s)."
  exit 0
else
  echo -e "${GREEN}${BOLD}ALL CHECKS PASSED${NC}"
  exit 0
fi
