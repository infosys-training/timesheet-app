#!/usr/bin/env bash
# =============================================================================
# Timesheet App — Health Check Script
#
# Tests all critical backend endpoints to verify the application is operational.
# Intended for use in incident response, deployment verification, and monitoring.
#
# Usage:
#   bash scripts/health-check.sh                    # defaults to localhost:3001
#   bash scripts/health-check.sh http://prod:3001   # custom base URL
#
# Exit codes:
#   0 — All checks passed
#   1 — One or more checks failed
# =============================================================================

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="healthcheck@timesheet-app.example.com"
PASS=0
FAIL=0
WARN=0
TOTAL=0

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  NC='\033[0m'
else
  GREEN='' RED='' YELLOW='' BLUE='' NC=''
fi

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

check() {
  local name="$1"
  local method="$2"
  local path="$3"
  local expected_status="$4"
  shift 4
  local extra_args=("$@")

  TOTAL=$((TOTAL + 1))
  local url="${BASE_URL}${path}"

  local response
  local http_code
  local body

  response=$(curl -s -w "\n%{http_code}" -X "$method" "${extra_args[@]}" "$url" 2>&1) || true
  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')

  local match=false
  for code in $(echo "$expected_status" | tr ',' ' '); do
    if [ "$http_code" = "$code" ]; then
      match=true
      break
    fi
  done

  if [ "$match" = true ]; then
    PASS=$((PASS + 1))
    printf "${GREEN}PASS${NC}  %-45s %s %s → %s\n" "$name" "$method" "$path" "$http_code"
  else
    FAIL=$((FAIL + 1))
    printf "${RED}FAIL${NC}  %-45s %s %s → %s (expected %s)\n" "$name" "$method" "$path" "$http_code" "$expected_status"
    if [ -n "$body" ]; then
      printf "       Response: %.200s\n" "$body"
    fi
  fi
}

warn_check() {
  local name="$1"
  local method="$2"
  local path="$3"
  local expected_status="$4"
  shift 4
  local extra_args=("$@")

  TOTAL=$((TOTAL + 1))
  local url="${BASE_URL}${path}"

  local response
  local http_code

  response=$(curl -s -w "\n%{http_code}" -X "$method" "${extra_args[@]}" "$url" 2>&1) || true
  http_code=$(echo "$response" | tail -n1)

  if [ "$http_code" = "$expected_status" ]; then
    PASS=$((PASS + 1))
    printf "${GREEN}PASS${NC}  %-45s %s %s → %s\n" "$name" "$method" "$path" "$http_code"
  else
    WARN=$((WARN + 1))
    printf "${YELLOW}WARN${NC}  %-45s %s %s → %s (expected %s)\n" "$name" "$method" "$path" "$http_code" "$expected_status"
  fi
}

separator() {
  printf "\n${BLUE}--- %s ---${NC}\n\n" "$1"
}

# -----------------------------------------------------------------------------
# Connectivity check
# -----------------------------------------------------------------------------

printf "\n${BLUE}=== Timesheet App Health Check ===${NC}\n"
printf "Target: %s\n" "$BASE_URL"
printf "Time:   %s\n\n" "$(date -u '+%Y-%m-%d %H:%M:%S UTC')"

# Quick connectivity test before running all checks
if ! curl -sf --max-time 5 "${BASE_URL}/health" > /dev/null 2>&1; then
  printf "${RED}FATAL: Cannot reach %s/health — is the backend running?${NC}\n" "$BASE_URL"
  exit 1
fi

# -----------------------------------------------------------------------------
# 1. Health Endpoint
# -----------------------------------------------------------------------------

separator "Health Endpoint"

check "Health check returns 200" \
  GET "/health" "200"

# Validate health response JSON structure
HEALTH_BODY=$(curl -sf "${BASE_URL}/health" 2>/dev/null || echo "{}")
if echo "$HEALTH_BODY" | grep -q '"status":"OK"'; then
  TOTAL=$((TOTAL + 1)); PASS=$((PASS + 1))
  printf "${GREEN}PASS${NC}  %-45s %s\n" "Health response has status=OK" "(JSON body check)"
else
  TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1))
  printf "${RED}FAIL${NC}  %-45s %s\n" "Health response missing status=OK" "Body: ${HEALTH_BODY:0:200}"
fi

# -----------------------------------------------------------------------------
# 2. Authentication Endpoints
# -----------------------------------------------------------------------------

separator "Authentication"

check "POST /api/auth/login with valid email" \
  POST "/api/auth/login" "200,201" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${TEST_EMAIL}\"}"

check "POST /api/auth/login with invalid email" \
  POST "/api/auth/login" "400" \
  -H "Content-Type: application/json" \
  -d '{"email":"not-an-email"}'

check "POST /api/auth/login with missing body" \
  POST "/api/auth/login" "400" \
  -H "Content-Type: application/json" \
  -d '{}'

check "GET /api/auth/me with valid header" \
  GET "/api/auth/me" "200" \
  -H "x-user-email: ${TEST_EMAIL}"

check "GET /api/auth/me without header" \
  GET "/api/auth/me" "401"

check "GET /api/auth/me with invalid email" \
  GET "/api/auth/me" "400" \
  -H "x-user-email: not-an-email"

# -----------------------------------------------------------------------------
# 3. Client Endpoints
# -----------------------------------------------------------------------------

separator "Client Endpoints"

check "GET /api/clients (authenticated)" \
  GET "/api/clients" "200" \
  -H "x-user-email: ${TEST_EMAIL}"

check "GET /api/clients (unauthenticated)" \
  GET "/api/clients" "401"

check "POST /api/clients — create test client" \
  POST "/api/clients" "201" \
  -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  -d '{"name":"HealthCheck Test Client","description":"Created by health check script"}'

# Capture the created client ID for subsequent tests
CLIENT_ID=$(curl -sf -H "x-user-email: ${TEST_EMAIL}" "${BASE_URL}/api/clients" \
  | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*' || echo "")

if [ -n "$CLIENT_ID" ]; then
  check "GET /api/clients/:id (specific client)" \
    GET "/api/clients/${CLIENT_ID}" "200" \
    -H "x-user-email: ${TEST_EMAIL}"

  check "PUT /api/clients/:id (update client)" \
    PUT "/api/clients/${CLIENT_ID}" "200" \
    -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    -d '{"name":"HealthCheck Updated Client"}'
else
  TOTAL=$((TOTAL + 2)); WARN=$((WARN + 2))
  printf "${YELLOW}WARN${NC}  %-45s %s\n" "Skipped GET/PUT client by ID" "(no client ID captured)"
fi

check "POST /api/clients — validation error" \
  POST "/api/clients" "400" \
  -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  -d '{}'

# -----------------------------------------------------------------------------
# 4. Work Entry Endpoints
# -----------------------------------------------------------------------------

separator "Work Entry Endpoints"

check "GET /api/work-entries (authenticated)" \
  GET "/api/work-entries" "200" \
  -H "x-user-email: ${TEST_EMAIL}"

check "GET /api/work-entries (unauthenticated)" \
  GET "/api/work-entries" "401"

if [ -n "$CLIENT_ID" ]; then
  check "POST /api/work-entries — create entry" \
    POST "/api/work-entries" "201" \
    -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    -d "{\"clientId\":${CLIENT_ID},\"hours\":2.5,\"description\":\"Health check test entry\",\"date\":\"$(date -u '+%Y-%m-%d')\"}"
else
  TOTAL=$((TOTAL + 1)); WARN=$((WARN + 1))
  printf "${YELLOW}WARN${NC}  %-45s %s\n" "Skipped POST work entry" "(no client ID)"
fi

check "POST /api/work-entries — validation error" \
  POST "/api/work-entries" "400" \
  -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  -d '{}'

# -----------------------------------------------------------------------------
# 5. Report Endpoints
# -----------------------------------------------------------------------------

separator "Report Endpoints"

if [ -n "$CLIENT_ID" ]; then
  check "GET /api/reports/client/:id (JSON report)" \
    GET "/api/reports/client/${CLIENT_ID}" "200" \
    -H "x-user-email: ${TEST_EMAIL}"

  warn_check "GET /api/reports/export/csv/:id" \
    GET "/api/reports/export/csv/${CLIENT_ID}" "200" \
    -H "x-user-email: ${TEST_EMAIL}"

  warn_check "GET /api/reports/export/pdf/:id" \
    GET "/api/reports/export/pdf/${CLIENT_ID}" "200" \
    -H "x-user-email: ${TEST_EMAIL}"
else
  TOTAL=$((TOTAL + 3)); WARN=$((WARN + 3))
  printf "${YELLOW}WARN${NC}  %-45s %s\n" "Skipped report endpoints" "(no client ID)"
fi

# -----------------------------------------------------------------------------
# 6. Error Handling
# -----------------------------------------------------------------------------

separator "Error Handling"

check "404 for unknown route" \
  GET "/api/nonexistent" "404"

check "GET /api/clients/999999 (not found)" \
  GET "/api/clients/999999" "404" \
  -H "x-user-email: ${TEST_EMAIL}"

check "GET /api/clients/abc (invalid ID)" \
  GET "/api/clients/abc" "400" \
  -H "x-user-email: ${TEST_EMAIL}"

# -----------------------------------------------------------------------------
# 7. Cleanup — remove test data
# -----------------------------------------------------------------------------

separator "Cleanup"

if [ -n "$CLIENT_ID" ]; then
  # Delete work entries for the test client first (cascade may handle this)
  ENTRY_IDS=$(curl -sf -H "x-user-email: ${TEST_EMAIL}" "${BASE_URL}/api/work-entries?clientId=${CLIENT_ID}" \
    | grep -o '"id":[0-9]*' | grep -o '[0-9]*' || echo "")

  for eid in $ENTRY_IDS; do
    curl -sf -X DELETE -H "x-user-email: ${TEST_EMAIL}" "${BASE_URL}/api/work-entries/${eid}" > /dev/null 2>&1 || true
  done

  curl -sf -X DELETE -H "x-user-email: ${TEST_EMAIL}" "${BASE_URL}/api/clients/${CLIENT_ID}" > /dev/null 2>&1 || true
  printf "${GREEN}DONE${NC}  Cleaned up test client (ID: %s) and entries\n" "$CLIENT_ID"
else
  printf "${YELLOW}SKIP${NC}  No test data to clean up\n"
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------

printf "\n${BLUE}=== Summary ===${NC}\n\n"
printf "Total checks: %d\n" "$TOTAL"
printf "${GREEN}Passed:       %d${NC}\n" "$PASS"
if [ "$WARN" -gt 0 ]; then
  printf "${YELLOW}Warnings:     %d${NC}\n" "$WARN"
fi
if [ "$FAIL" -gt 0 ]; then
  printf "${RED}Failed:       %d${NC}\n" "$FAIL"
fi
printf "\n"

if [ "$FAIL" -gt 0 ]; then
  printf "${RED}RESULT: UNHEALTHY — %d check(s) failed. See RUNBOOK.md for response procedures.${NC}\n\n" "$FAIL"
  exit 1
else
  printf "${GREEN}RESULT: HEALTHY — All critical checks passed.${NC}\n\n"
  exit 0
fi
