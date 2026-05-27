#!/usr/bin/env bash
#
# Health Check Script for Timesheet App
#
# Tests all critical backend endpoints and reports pass/fail status.
# Exits with code 0 if all checks pass, 1 if any check fails.
#
# Usage:
#   ./scripts/health-check.sh                       # defaults to http://localhost:3001
#   ./scripts/health-check.sh http://my-server:3001  # custom base URL
#   HEALTH_CHECK_EMAIL=me@co.com ./scripts/health-check.sh  # custom test email
#

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="${HEALTH_CHECK_EMAIL:-healthcheck@timesheet-app.example.com}"

PASSED=0
FAILED=0
TOTAL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ---------- helpers ----------

check() {
  local name="$1"
  local method="$2"
  local url="$3"
  shift 3
  local extra_args=("$@")

  TOTAL=$((TOTAL + 1))

  local http_code
  local body
  local tmpfile
  tmpfile=$(mktemp)

  http_code=$(curl -s -o "$tmpfile" -w "%{http_code}" \
    -X "$method" \
    --max-time 10 \
    "${extra_args[@]}" \
    "$url" 2>/dev/null) || http_code="000"

  body=$(cat "$tmpfile" 2>/dev/null || echo "")
  rm -f "$tmpfile"

  if [[ "$http_code" =~ ^2[0-9]{2}$ ]]; then
    echo -e "  ${GREEN}PASS${NC}  [$http_code] $name"
    PASSED=$((PASSED + 1))
    # Export body for downstream checks
    LAST_BODY="$body"
    return 0
  else
    echo -e "  ${RED}FAIL${NC}  [$http_code] $name"
    if [[ -n "$body" ]]; then
      echo "        Response: $(echo "$body" | head -c 200)"
    fi
    FAILED=$((FAILED + 1))
    LAST_BODY=""
    return 1
  fi
}

section() {
  echo ""
  echo -e "${YELLOW}--- $1 ---${NC}"
}

# ---------- main ----------

echo "============================================"
echo " Timesheet App Health Check"
echo " Target: $BASE_URL"
echo " Time:   $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "============================================"

# --------------------------------------------------
section "1. Basic Health"
# --------------------------------------------------

check "GET /health" GET "$BASE_URL/health"

# --------------------------------------------------
section "2. Authentication"
# --------------------------------------------------

check "POST /api/auth/login" POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\"}"

check "GET /api/auth/me (authenticated)" GET "$BASE_URL/api/auth/me" \
  -H "x-user-email: $TEST_EMAIL"

# Negative test: missing header should return 401
TOTAL=$((TOTAL + 1))
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  "$BASE_URL/api/auth/me" 2>/dev/null) || code="000"
if [[ "$code" == "401" ]]; then
  echo -e "  ${GREEN}PASS${NC}  [401] GET /api/auth/me (no auth -> 401)"
  PASSED=$((PASSED + 1))
else
  echo -e "  ${RED}FAIL${NC}  [$code] GET /api/auth/me (expected 401, got $code)"
  FAILED=$((FAILED + 1))
fi

# --------------------------------------------------
section "3. Clients API"
# --------------------------------------------------

check "GET /api/clients" GET "$BASE_URL/api/clients" \
  -H "x-user-email: $TEST_EMAIL"

# Create a test client for further checks
CLIENT_ID=""
TOTAL=$((TOTAL + 1))
tmpfile=$(mktemp)
code=$(curl -s -o "$tmpfile" -w "%{http_code}" --max-time 10 \
  -X POST "$BASE_URL/api/clients" \
  -H "Content-Type: application/json" \
  -H "x-user-email: $TEST_EMAIL" \
  -d '{"name":"HealthCheck Test Client","description":"Created by health check script"}' 2>/dev/null) || code="000"
body=$(cat "$tmpfile" 2>/dev/null || echo "")
rm -f "$tmpfile"

if [[ "$code" =~ ^2[0-9]{2}$ ]]; then
  echo -e "  ${GREEN}PASS${NC}  [$code] POST /api/clients (create)"
  PASSED=$((PASSED + 1))
  # Extract client ID (works with basic JSON; jq used if available)
  if command -v jq &>/dev/null; then
    CLIENT_ID=$(echo "$body" | jq -r '.client.id // empty' 2>/dev/null)
  else
    CLIENT_ID=$(echo "$body" | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*')
  fi
else
  echo -e "  ${RED}FAIL${NC}  [$code] POST /api/clients (create)"
  FAILED=$((FAILED + 1))
fi

if [[ -n "$CLIENT_ID" ]]; then
  check "GET /api/clients/$CLIENT_ID" GET "$BASE_URL/api/clients/$CLIENT_ID" \
    -H "x-user-email: $TEST_EMAIL"

  check "PUT /api/clients/$CLIENT_ID" PUT "$BASE_URL/api/clients/$CLIENT_ID" \
    -H "Content-Type: application/json" \
    -H "x-user-email: $TEST_EMAIL" \
    -d '{"name":"HealthCheck Updated Client"}'
else
  echo -e "  ${YELLOW}SKIP${NC}  GET /api/clients/:id  (no client created)"
  echo -e "  ${YELLOW}SKIP${NC}  PUT /api/clients/:id  (no client created)"
fi

# --------------------------------------------------
section "4. Work Entries API"
# --------------------------------------------------

check "GET /api/work-entries" GET "$BASE_URL/api/work-entries" \
  -H "x-user-email: $TEST_EMAIL"

WORK_ENTRY_ID=""
if [[ -n "$CLIENT_ID" ]]; then
  TODAY=$(date -u '+%Y-%m-%d')
  TOTAL=$((TOTAL + 1))
  tmpfile=$(mktemp)
  code=$(curl -s -o "$tmpfile" -w "%{http_code}" --max-time 10 \
    -X POST "$BASE_URL/api/work-entries" \
    -H "Content-Type: application/json" \
    -H "x-user-email: $TEST_EMAIL" \
    -d "{\"clientId\":$CLIENT_ID,\"hours\":1,\"description\":\"Health check entry\",\"date\":\"$TODAY\"}" 2>/dev/null) || code="000"
  body=$(cat "$tmpfile" 2>/dev/null || echo "")
  rm -f "$tmpfile"

  if [[ "$code" =~ ^2[0-9]{2}$ ]]; then
    echo -e "  ${GREEN}PASS${NC}  [$code] POST /api/work-entries (create)"
    PASSED=$((PASSED + 1))
    if command -v jq &>/dev/null; then
      WORK_ENTRY_ID=$(echo "$body" | jq -r '.workEntry.id // empty' 2>/dev/null)
    else
      WORK_ENTRY_ID=$(echo "$body" | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*')
    fi
  else
    echo -e "  ${RED}FAIL${NC}  [$code] POST /api/work-entries (create)"
    FAILED=$((FAILED + 1))
  fi
else
  echo -e "  ${YELLOW}SKIP${NC}  POST /api/work-entries (no client available)"
fi

# --------------------------------------------------
section "5. Reports API"
# --------------------------------------------------

if [[ -n "$CLIENT_ID" ]]; then
  check "GET /api/reports/client/$CLIENT_ID" GET "$BASE_URL/api/reports/client/$CLIENT_ID" \
    -H "x-user-email: $TEST_EMAIL"

  check "GET /api/reports/export/csv/$CLIENT_ID" GET "$BASE_URL/api/reports/export/csv/$CLIENT_ID" \
    -H "x-user-email: $TEST_EMAIL"

  check "GET /api/reports/export/pdf/$CLIENT_ID" GET "$BASE_URL/api/reports/export/pdf/$CLIENT_ID" \
    -H "x-user-email: $TEST_EMAIL"
else
  echo -e "  ${YELLOW}SKIP${NC}  Reports endpoints (no client available)"
fi

# --------------------------------------------------
section "6. Error Handling"
# --------------------------------------------------

# 404 on unknown route
TOTAL=$((TOTAL + 1))
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  "$BASE_URL/api/nonexistent" 2>/dev/null) || code="000"
if [[ "$code" == "404" ]]; then
  echo -e "  ${GREEN}PASS${NC}  [404] GET /api/nonexistent (expected 404)"
  PASSED=$((PASSED + 1))
else
  echo -e "  ${RED}FAIL${NC}  [$code] GET /api/nonexistent (expected 404, got $code)"
  FAILED=$((FAILED + 1))
fi

# Validation error on bad login payload
TOTAL=$((TOTAL + 1))
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"not-an-email"}' 2>/dev/null) || code="000"
if [[ "$code" == "400" ]]; then
  echo -e "  ${GREEN}PASS${NC}  [400] POST /api/auth/login invalid email (expected 400)"
  PASSED=$((PASSED + 1))
else
  echo -e "  ${RED}FAIL${NC}  [$code] POST /api/auth/login invalid email (expected 400, got $code)"
  FAILED=$((FAILED + 1))
fi

# --------------------------------------------------
section "7. Cleanup"
# --------------------------------------------------

# Delete the work entry if created
if [[ -n "${WORK_ENTRY_ID:-}" ]]; then
  check "DELETE /api/work-entries/$WORK_ENTRY_ID" DELETE "$BASE_URL/api/work-entries/$WORK_ENTRY_ID" \
    -H "x-user-email: $TEST_EMAIL"
fi

# Delete the test client if created
if [[ -n "${CLIENT_ID:-}" ]]; then
  check "DELETE /api/clients/$CLIENT_ID" DELETE "$BASE_URL/api/clients/$CLIENT_ID" \
    -H "x-user-email: $TEST_EMAIL"
fi

# --------------------------------------------------
# Summary
# --------------------------------------------------

echo ""
echo "============================================"
echo -e " Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}, ${TOTAL} total"
echo "============================================"

if [[ $FAILED -gt 0 ]]; then
  echo -e "${RED}Health check FAILED${NC}"
  exit 1
else
  echo -e "${GREEN}All checks PASSED${NC}"
  exit 0
fi
