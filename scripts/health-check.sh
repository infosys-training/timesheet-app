#!/usr/bin/env bash
#
# health-check.sh — Tests all critical endpoints of the timesheet-app backend.
#
# Usage:
#   ./scripts/health-check.sh                 # defaults to http://localhost:3001
#   ./scripts/health-check.sh http://prod:3001
#
# Exit codes:
#   0 — All checks passed
#   1 — One or more checks failed
#
set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="healthcheck@timesheet-app.example.com"
PASS=0
FAIL=0
TOTAL=0

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  NC='\033[0m'
else
  GREEN=''
  RED=''
  YELLOW=''
  NC=''
fi

check() {
  local description="$1"
  local method="$2"
  local endpoint="$3"
  local expected_status="$4"
  local data="${5:-}"

  TOTAL=$((TOTAL + 1))

  local curl_args=(-s -o /tmp/hc_body -w "%{http_code}" --max-time 10)
  curl_args+=(-X "$method")
  curl_args+=(-H "Content-Type: application/json")
  curl_args+=(-H "x-user-email: ${TEST_EMAIL}")

  if [ -n "$data" ]; then
    curl_args+=(-d "$data")
  fi

  local actual_status
  actual_status=$(curl "${curl_args[@]}" "${BASE_URL}${endpoint}" 2>/dev/null) || actual_status="000"

  if [ "$actual_status" = "$expected_status" ]; then
    PASS=$((PASS + 1))
    printf "${GREEN}  PASS${NC}  %-50s [%s]\n" "$description" "$actual_status"
  else
    FAIL=$((FAIL + 1))
    printf "${RED}  FAIL${NC}  %-50s [expected %s, got %s]\n" "$description" "$expected_status" "$actual_status"
    if [ -f /tmp/hc_body ]; then
      printf "         Response: %s\n" "$(head -c 200 /tmp/hc_body)"
    fi
  fi
}

echo ""
echo "======================================================"
echo "  Timesheet App Health Check"
echo "  Target: ${BASE_URL}"
echo "  Time:   $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "======================================================"
echo ""

# -----------------------------------------------------------
# 1. Core health endpoint
# -----------------------------------------------------------
echo "--- Core Health ---"
check "GET /health returns 200" \
  GET "/health" "200"

# -----------------------------------------------------------
# 2. Authentication endpoints
# -----------------------------------------------------------
echo ""
echo "--- Authentication ---"
# Login returns 200 for existing user, 201 for new user — accept either
TOTAL=$((TOTAL + 1))
login_status=$(curl -s -o /tmp/hc_body -w "%{http_code}" --max-time 10 \
  -X POST -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  -d "{\"email\":\"${TEST_EMAIL}\"}" \
  "${BASE_URL}/api/auth/login" 2>/dev/null) || login_status="000"
if [ "$login_status" = "200" ] || [ "$login_status" = "201" ]; then
  PASS=$((PASS + 1))
  printf "${GREEN}  PASS${NC}  %-50s [%s]\n" "POST /api/auth/login with valid email" "$login_status"
else
  FAIL=$((FAIL + 1))
  printf "${RED}  FAIL${NC}  %-50s [expected 200|201, got %s]\n" "POST /api/auth/login with valid email" "$login_status"
fi

check "POST /api/auth/login with invalid email returns 400" \
  POST "/api/auth/login" "400" \
  '{"email":"not-an-email"}'

check "GET /api/auth/me with valid header" \
  GET "/api/auth/me" "200"

# -----------------------------------------------------------
# 3. Clients endpoints
# -----------------------------------------------------------
echo ""
echo "--- Clients API ---"
check "GET /api/clients returns 200" \
  GET "/api/clients" "200"

check "POST /api/clients creates a client" \
  POST "/api/clients" "201" \
  '{"name":"HealthCheck Test Client","description":"Auto-created by health check"}'

# Capture the created client ID for subsequent tests
CLIENT_ID=$(cat /tmp/hc_body 2>/dev/null | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
if [ -z "$CLIENT_ID" ]; then
  CLIENT_ID="999999"  # fallback — will produce expected 404s
fi

check "GET /api/clients/:id returns 200" \
  GET "/api/clients/${CLIENT_ID}" "200"

check "PUT /api/clients/:id updates client" \
  PUT "/api/clients/${CLIENT_ID}" "200" \
  '{"name":"HealthCheck Updated Client"}'

# -----------------------------------------------------------
# 4. Work entries endpoints
# -----------------------------------------------------------
echo ""
echo "--- Work Entries API ---"
check "GET /api/work-entries returns 200" \
  GET "/api/work-entries" "200"

check "POST /api/work-entries creates entry" \
  POST "/api/work-entries" "201" \
  "{\"clientId\":${CLIENT_ID},\"hours\":1.5,\"description\":\"Health check test entry\",\"date\":\"$(date -u '+%Y-%m-%d')\"}"

ENTRY_ID=$(cat /tmp/hc_body 2>/dev/null | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
if [ -z "$ENTRY_ID" ]; then
  ENTRY_ID="999999"
fi

check "GET /api/work-entries/:id returns 200" \
  GET "/api/work-entries/${ENTRY_ID}" "200"

check "PUT /api/work-entries/:id updates entry" \
  PUT "/api/work-entries/${ENTRY_ID}" "200" \
  '{"hours":2.0}'

# -----------------------------------------------------------
# 5. Reports endpoints
# -----------------------------------------------------------
echo ""
echo "--- Reports API ---"
check "GET /api/reports/client/:id returns 200" \
  GET "/api/reports/client/${CLIENT_ID}" "200"

check "GET /api/reports/export/csv/:id returns 200" \
  GET "/api/reports/export/csv/${CLIENT_ID}" "200"

check "GET /api/reports/export/pdf/:id returns 200" \
  GET "/api/reports/export/pdf/${CLIENT_ID}" "200"

# -----------------------------------------------------------
# 6. Error handling checks
# -----------------------------------------------------------
echo ""
echo "--- Error Handling ---"

# Custom check: missing auth header (no x-user-email)
TOTAL=$((TOTAL + 1))
actual_status=$(curl -s -o /tmp/hc_body -w "%{http_code}" --max-time 10 \
  -X GET -H "Content-Type: application/json" \
  "${BASE_URL}/api/clients" 2>/dev/null) || actual_status="000"
if [ "$actual_status" = "401" ]; then
  PASS=$((PASS + 1))
  printf "${GREEN}  PASS${NC}  %-50s [%s]\n" "Missing auth header returns 401" "$actual_status"
else
  FAIL=$((FAIL + 1))
  printf "${RED}  FAIL${NC}  %-50s [expected 401, got %s]\n" "Missing auth header returns 401" "$actual_status"
fi

check "Unknown route returns 404" \
  GET "/api/nonexistent-route" "404"

check "Invalid JSON body returns 400" \
  POST "/api/auth/login" "400" \
  '{"invalid":true}'

# -----------------------------------------------------------
# 7. Cleanup — delete test data
# -----------------------------------------------------------
echo ""
echo "--- Cleanup ---"
if [ "$ENTRY_ID" != "999999" ]; then
  check "DELETE /api/work-entries/:id cleans up test entry" \
    DELETE "/api/work-entries/${ENTRY_ID}" "200"
fi

if [ "$CLIENT_ID" != "999999" ]; then
  check "DELETE /api/clients/:id cleans up test client" \
    DELETE "/api/clients/${CLIENT_ID}" "200"
fi

# -----------------------------------------------------------
# Summary
# -----------------------------------------------------------
echo ""
echo "======================================================"
printf "  Results: ${GREEN}%d passed${NC}, ${RED}%d failed${NC}, %d total\n" "$PASS" "$FAIL" "$TOTAL"
echo "======================================================"
echo ""

# Clean up temp file
rm -f /tmp/hc_body

if [ "$FAIL" -gt 0 ]; then
  printf "${RED}  HEALTH CHECK FAILED${NC}\n\n"
  exit 1
else
  printf "${GREEN}  ALL CHECKS PASSED${NC}\n\n"
  exit 0
fi
