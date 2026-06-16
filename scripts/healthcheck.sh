#!/usr/bin/env bash
#
# healthcheck.sh — Verify all critical endpoints of the Timesheet App.
#
# Usage:
#   ./scripts/healthcheck.sh                   # defaults to http://localhost:3001
#   ./scripts/healthcheck.sh http://prod:3001  # custom base URL
#
# Exit codes:
#   0  All checks passed
#   1  One or more checks failed

set -uo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="healthcheck-$(date +%s)@test.example.com"
PASS=0
FAIL=0
WARN=0

# Colors (disabled when not a terminal)
if [ -t 1 ]; then
  GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; NC='\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; NC=''
fi

pass() { PASS=$((PASS + 1)); printf "${GREEN}  PASS${NC}  %s\n" "$1"; }
fail() { FAIL=$((FAIL + 1)); printf "${RED}  FAIL${NC}  %s — %s\n" "$1" "$2"; }
warn() { WARN=$((WARN + 1)); printf "${YELLOW}  WARN${NC}  %s — %s\n" "$1" "$2"; }

header() { printf "\n=== %s ===\n" "$1"; }

# --------------------------------------------------------------------------- #
#  Helpers
# --------------------------------------------------------------------------- #

http_status() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$@" 2>/dev/null) || true
  echo "${code:-000}"
}

http_get() {
  curl -s --max-time 10 "$@" 2>/dev/null || true
}

http_post() {
  curl -s --max-time 10 -X POST -H "Content-Type: application/json" "$@" 2>/dev/null || true
}

# --------------------------------------------------------------------------- #
#  1. Health endpoint
# --------------------------------------------------------------------------- #
header "Health Endpoint"

HEALTH_RESP=$(http_get "$BASE_URL/health")
if echo "$HEALTH_RESP" | grep -q '"status":"OK"'; then
  pass "GET /health — status OK"
else
  fail "GET /health" "endpoint unreachable or bad response"
fi

# --------------------------------------------------------------------------- #
#  2. Authentication
# --------------------------------------------------------------------------- #
header "Authentication"

LOGIN_RESP=$(http_post "$BASE_URL/api/auth/login" -d "{\"email\":\"$TEST_EMAIL\"}")
if echo "$LOGIN_RESP" | grep -q '"email"'; then
  pass "POST /api/auth/login — user created/logged in"
else
  fail "POST /api/auth/login" "login failed: $LOGIN_RESP"
fi

ME_RESP=$(http_get "$BASE_URL/api/auth/me" -H "x-user-email: $TEST_EMAIL")
if echo "$ME_RESP" | grep -q "$TEST_EMAIL"; then
  pass "GET  /api/auth/me — returns authenticated user"
else
  fail "GET  /api/auth/me" "could not retrieve user info"
fi

# Test auth rejection (missing header)
STATUS=$(http_status "$BASE_URL/api/clients")
if [ "$STATUS" = "401" ]; then
  pass "GET  /api/clients (no auth) — returns 401"
else
  fail "GET  /api/clients (no auth)" "expected 401, got $STATUS"
fi

# --------------------------------------------------------------------------- #
#  3. Clients CRUD
# --------------------------------------------------------------------------- #
header "Clients API"

AUTH_HEADER="x-user-email: $TEST_EMAIL"

# Create
CREATE_RESP=$(http_post "$BASE_URL/api/clients" \
  -H "$AUTH_HEADER" \
  -d '{"name":"HealthCheck Test Client","description":"Auto-created by healthcheck script"}')
CLIENT_ID=""
if echo "$CREATE_RESP" | grep -q '"id"'; then
  CLIENT_ID=$(echo "$CREATE_RESP" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  pass "POST /api/clients — created client id=$CLIENT_ID"
else
  fail "POST /api/clients" "could not create client: $CREATE_RESP"
fi

# List
LIST_RESP=$(http_get "$BASE_URL/api/clients" -H "$AUTH_HEADER")
if echo "$LIST_RESP" | grep -q '"clients"'; then
  pass "GET  /api/clients — listed clients"
else
  fail "GET  /api/clients" "could not list clients"
fi

if [ -n "$CLIENT_ID" ]; then
  # Read
  GET_RESP=$(http_get "$BASE_URL/api/clients/$CLIENT_ID" -H "$AUTH_HEADER")
  if echo "$GET_RESP" | grep -q "HealthCheck Test Client"; then
    pass "GET  /api/clients/$CLIENT_ID — retrieved client"
  else
    fail "GET  /api/clients/$CLIENT_ID" "could not retrieve client"
  fi

  # Update
  UPDATE_STATUS=$(http_status -X PUT "$BASE_URL/api/clients/$CLIENT_ID" \
    -H "$AUTH_HEADER" \
    -H "Content-Type: application/json" \
    -d '{"name":"HealthCheck Updated Client"}')
  if [ "$UPDATE_STATUS" = "200" ]; then
    pass "PUT  /api/clients/$CLIENT_ID — updated client"
  else
    fail "PUT  /api/clients/$CLIENT_ID" "expected 200, got $UPDATE_STATUS"
  fi
fi

# --------------------------------------------------------------------------- #
#  4. Work Entries CRUD
# --------------------------------------------------------------------------- #
header "Work Entries API"

WE_ID=""
if [ -n "$CLIENT_ID" ]; then
  TODAY=$(date +%Y-%m-%d)

  # Create work entry
  WE_RESP=$(http_post "$BASE_URL/api/work-entries" \
    -H "$AUTH_HEADER" \
    -d "{\"clientId\":$CLIENT_ID,\"hours\":2.5,\"description\":\"Healthcheck test entry\",\"date\":\"$TODAY\"}")
  if echo "$WE_RESP" | grep -q '"id"'; then
    WE_ID=$(echo "$WE_RESP" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
    pass "POST /api/work-entries — created entry id=$WE_ID"
  else
    fail "POST /api/work-entries" "could not create work entry: $WE_RESP"
  fi

  # List work entries
  WE_LIST=$(http_get "$BASE_URL/api/work-entries" -H "$AUTH_HEADER")
  if echo "$WE_LIST" | grep -q '"workEntries"'; then
    pass "GET  /api/work-entries — listed entries"
  else
    fail "GET  /api/work-entries" "could not list work entries"
  fi

  # List with client filter
  WE_FILTERED=$(http_get "$BASE_URL/api/work-entries?clientId=$CLIENT_ID" -H "$AUTH_HEADER")
  if echo "$WE_FILTERED" | grep -q '"workEntries"'; then
    pass "GET  /api/work-entries?clientId=$CLIENT_ID — filtered by client"
  else
    fail "GET  /api/work-entries?clientId=$CLIENT_ID" "filtered query failed"
  fi

  if [ -n "$WE_ID" ]; then
    # Read single entry
    WE_GET=$(http_get "$BASE_URL/api/work-entries/$WE_ID" -H "$AUTH_HEADER")
    if echo "$WE_GET" | grep -q '"workEntry"'; then
      pass "GET  /api/work-entries/$WE_ID — retrieved entry"
    else
      fail "GET  /api/work-entries/$WE_ID" "could not retrieve work entry"
    fi

    # Update
    WE_UPD_STATUS=$(http_status -X PUT "$BASE_URL/api/work-entries/$WE_ID" \
      -H "$AUTH_HEADER" \
      -H "Content-Type: application/json" \
      -d '{"hours":3.0}')
    if [ "$WE_UPD_STATUS" = "200" ]; then
      pass "PUT  /api/work-entries/$WE_ID — updated entry"
    else
      fail "PUT  /api/work-entries/$WE_ID" "expected 200, got $WE_UPD_STATUS"
    fi
  fi
else
  warn "Work Entries API" "skipped — no client ID available (client creation failed)"
fi

# --------------------------------------------------------------------------- #
#  5. Reports & Exports
# --------------------------------------------------------------------------- #
header "Reports & Exports"

if [ -n "$CLIENT_ID" ]; then
  # Client report
  RPT_RESP=$(http_get "$BASE_URL/api/reports/client/$CLIENT_ID" -H "$AUTH_HEADER")
  if echo "$RPT_RESP" | grep -q '"totalHours"'; then
    pass "GET  /api/reports/client/$CLIENT_ID — report generated"
  else
    fail "GET  /api/reports/client/$CLIENT_ID" "could not generate report"
  fi

  # CSV export
  CSV_STATUS=$(http_status "$BASE_URL/api/reports/export/csv/$CLIENT_ID" -H "$AUTH_HEADER")
  if [ "$CSV_STATUS" = "200" ]; then
    pass "GET  /api/reports/export/csv/$CLIENT_ID — CSV export"
  else
    fail "GET  /api/reports/export/csv/$CLIENT_ID" "expected 200, got $CSV_STATUS"
  fi

  # PDF export
  PDF_STATUS=$(http_status "$BASE_URL/api/reports/export/pdf/$CLIENT_ID" -H "$AUTH_HEADER")
  if [ "$PDF_STATUS" = "200" ]; then
    pass "GET  /api/reports/export/pdf/$CLIENT_ID — PDF export"
  else
    fail "GET  /api/reports/export/pdf/$CLIENT_ID" "expected 200, got $PDF_STATUS"
  fi
else
  warn "Reports & Exports" "skipped — no client ID available"
fi

# --------------------------------------------------------------------------- #
#  6. Input Validation
# --------------------------------------------------------------------------- #
header "Input Validation"

# Bad email on login
BAD_LOGIN_STATUS=$(http_status -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"not-an-email"}')
if [ "$BAD_LOGIN_STATUS" = "400" ]; then
  pass "POST /api/auth/login (bad email) — returns 400"
else
  fail "POST /api/auth/login (bad email)" "expected 400, got $BAD_LOGIN_STATUS"
fi

# Missing required field on client create
BAD_CLIENT_STATUS=$(http_status -X POST "$BASE_URL/api/clients" \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{}')
if [ "$BAD_CLIENT_STATUS" = "400" ]; then
  pass "POST /api/clients (missing name) — returns 400"
else
  fail "POST /api/clients (missing name)" "expected 400, got $BAD_CLIENT_STATUS"
fi

# Invalid work entry (hours > 24)
BAD_WE_STATUS=$(http_status -X POST "$BASE_URL/api/work-entries" \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"clientId":1,"hours":25,"date":"2024-01-01"}')
if [ "$BAD_WE_STATUS" = "400" ]; then
  pass "POST /api/work-entries (hours>24) — returns 400"
else
  fail "POST /api/work-entries (hours>24)" "expected 400, got $BAD_WE_STATUS"
fi

# --------------------------------------------------------------------------- #
#  7. 404 handling
# --------------------------------------------------------------------------- #
header "Error Handling"

NOT_FOUND_STATUS=$(http_status "$BASE_URL/api/nonexistent")
if [ "$NOT_FOUND_STATUS" = "404" ]; then
  pass "GET  /api/nonexistent — returns 404"
else
  fail "GET  /api/nonexistent" "expected 404, got $NOT_FOUND_STATUS"
fi

# --------------------------------------------------------------------------- #
#  8. Cleanup — delete test data
# --------------------------------------------------------------------------- #
header "Cleanup"

if [ -n "$WE_ID" ]; then
  DEL_WE_STATUS=$(http_status -X DELETE "$BASE_URL/api/work-entries/$WE_ID" -H "$AUTH_HEADER")
  if [ "$DEL_WE_STATUS" = "200" ]; then
    pass "DELETE /api/work-entries/$WE_ID — cleaned up"
  else
    warn "DELETE /api/work-entries/$WE_ID" "cleanup returned $DEL_WE_STATUS"
  fi
fi

if [ -n "$CLIENT_ID" ]; then
  DEL_CL_STATUS=$(http_status -X DELETE "$BASE_URL/api/clients/$CLIENT_ID" -H "$AUTH_HEADER")
  if [ "$DEL_CL_STATUS" = "200" ]; then
    pass "DELETE /api/clients/$CLIENT_ID — cleaned up"
  else
    warn "DELETE /api/clients/$CLIENT_ID" "cleanup returned $DEL_CL_STATUS"
  fi
fi

# --------------------------------------------------------------------------- #
#  Summary
# --------------------------------------------------------------------------- #
header "Summary"

TOTAL=$((PASS + FAIL + WARN))
printf "Total: %d  |  Passed: %d  |  Failed: %d  |  Warnings: %d\n" "$TOTAL" "$PASS" "$FAIL" "$WARN"
printf "Target: %s\n" "$BASE_URL"

if [ "$FAIL" -gt 0 ]; then
  printf "\n${RED}RESULT: FAILED — %d check(s) did not pass.${NC}\n" "$FAIL"
  exit 1
else
  printf "\n${GREEN}RESULT: ALL CHECKS PASSED${NC}\n"
  exit 0
fi
