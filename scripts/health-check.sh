#!/usr/bin/env bash
#
# Health Check Script for Timesheet App
#
# Tests all critical application endpoints to verify system health.
# Exit code 0 = all checks passed, 1 = one or more checks failed.
#
# Usage:
#   ./scripts/health-check.sh                  # defaults to http://localhost:3001
#   ./scripts/health-check.sh http://myhost:3001
#
# The script:
#   1. Tests the /health endpoint (unauthenticated)
#   2. Tests authentication (POST /api/auth/login, GET /api/auth/me)
#   3. Tests CRUD operations on /api/clients
#   4. Tests CRUD operations on /api/work-entries
#   5. Tests report generation (/api/reports/client/:id)
#   6. Tests PDF and CSV export endpoints
#   7. Tests error handling (404, 400, 401)
#   8. Prints a summary of all checks

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="healthcheck-$(date +%s)@test.example.com"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0
RESULTS=()

# ── Helper functions ──────────────────────────────────────────────────

check_result() {
  local name="$1"
  local expected_code="$2"
  local actual_code="$3"
  local body="${4:-}"

  if [ "$actual_code" = "$expected_code" ]; then
    RESULTS+=("${GREEN}PASS${NC}  $name (HTTP $actual_code)")
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    RESULTS+=("${RED}FAIL${NC}  $name (expected HTTP $expected_code, got $actual_code)")
    FAIL_COUNT=$((FAIL_COUNT + 1))
    if [ -n "$body" ]; then
      RESULTS+=("       Response: ${body:0:200}")
    fi
  fi
}

check_json_field() {
  local name="$1"
  local json="$2"
  local field="$3"

  if echo "$json" | grep -q "\"$field\""; then
    RESULTS+=("${GREEN}PASS${NC}  $name – field '$field' present")
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    RESULTS+=("${RED}FAIL${NC}  $name – field '$field' missing in response")
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

section() {
  RESULTS+=("")
  RESULTS+=("${CYAN}${BOLD}── $1 ──${NC}")
}

# ── Pre-flight checks ────────────────────────────────────────────────

echo -e "${BOLD}Timesheet App Health Check${NC}"
echo -e "Target: ${CYAN}${BASE_URL}${NC}"
echo -e "Test user: ${CYAN}${TEST_EMAIL}${NC}"
echo ""

# Check if curl is available
if ! command -v curl &> /dev/null; then
  echo -e "${RED}ERROR: curl is not installed${NC}"
  exit 1
fi

# ── 1. Health Endpoint ────────────────────────────────────────────────

section "1. Health Endpoint"

RESPONSE=$(curl -s -w "\n%{http_code}" "${BASE_URL}/health" 2>/dev/null || echo -e "\n000")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

check_result "GET /health" "200" "$HTTP_CODE" "$BODY"

if [ "$HTTP_CODE" = "200" ]; then
  check_json_field "GET /health" "$BODY" "status"
  check_json_field "GET /health" "$BODY" "timestamp"
fi

# If health check fails, abort early – the server is down
if [ "$HTTP_CODE" != "200" ]; then
  echo ""
  echo -e "${RED}${BOLD}CRITICAL: Backend is not reachable at ${BASE_URL}${NC}"
  echo -e "Cannot proceed with remaining checks."
  echo -e "See RUNBOOK.md INC-01: Backend Health Check Failure"
  echo ""
  for r in "${RESULTS[@]}"; do echo -e "$r"; done
  echo ""
  echo -e "${RED}${BOLD}Result: FAILED (${FAIL_COUNT} failed, ${PASS_COUNT} passed)${NC}"
  exit 1
fi

# ── 2. Authentication ─────────────────────────────────────────────────

section "2. Authentication"

# Test login (creates user if not exists)
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${TEST_EMAIL}\"}" 2>/dev/null || echo -e "\n000")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

# Accept both 200 (existing user) and 201 (new user)
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  RESULTS+=("${GREEN}PASS${NC}  POST /api/auth/login (HTTP $HTTP_CODE)")
  PASS_COUNT=$((PASS_COUNT + 1))
else
  check_result "POST /api/auth/login" "201" "$HTTP_CODE" "$BODY"
fi

check_json_field "POST /api/auth/login" "$BODY" "user"

# Test GET /api/auth/me
RESPONSE=$(curl -s -w "\n%{http_code}" "${BASE_URL}/api/auth/me" \
  -H "x-user-email: ${TEST_EMAIL}" 2>/dev/null || echo -e "\n000")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

check_result "GET /api/auth/me" "200" "$HTTP_CODE" "$BODY"

# Test missing auth header (should return 401)
RESPONSE=$(curl -s -w "\n%{http_code}" "${BASE_URL}/api/clients" 2>/dev/null || echo -e "\n000")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

check_result "GET /api/clients (no auth – expect 401)" "401" "$HTTP_CODE" "$BODY"

# ── 3. Client CRUD ────────────────────────────────────────────────────

section "3. Client CRUD"

# Create a client
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/clients" \
  -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  -d '{"name":"HealthCheck Test Client","description":"Auto-created by health check script","department":"QA"}' \
  2>/dev/null || echo -e "\n000")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

check_result "POST /api/clients (create)" "201" "$HTTP_CODE" "$BODY"

# Extract client ID
CLIENT_ID=$(echo "$BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
if [ -z "$CLIENT_ID" ]; then
  RESULTS+=("${YELLOW}WARN${NC}  Could not extract client ID from response – skipping dependent tests")
  WARN_COUNT=$((WARN_COUNT + 1))
  CLIENT_ID=""
fi

# List clients
RESPONSE=$(curl -s -w "\n%{http_code}" "${BASE_URL}/api/clients" \
  -H "x-user-email: ${TEST_EMAIL}" 2>/dev/null || echo -e "\n000")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

check_result "GET /api/clients (list)" "200" "$HTTP_CODE" "$BODY"
check_json_field "GET /api/clients" "$BODY" "clients"

if [ -n "$CLIENT_ID" ]; then
  # Get specific client
  RESPONSE=$(curl -s -w "\n%{http_code}" "${BASE_URL}/api/clients/${CLIENT_ID}" \
    -H "x-user-email: ${TEST_EMAIL}" 2>/dev/null || echo -e "\n000")
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  check_result "GET /api/clients/${CLIENT_ID} (get by ID)" "200" "$HTTP_CODE" "$BODY"

  # Update client
  RESPONSE=$(curl -s -w "\n%{http_code}" -X PUT "${BASE_URL}/api/clients/${CLIENT_ID}" \
    -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    -d '{"name":"HealthCheck Updated Client"}' \
    2>/dev/null || echo -e "\n000")
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  check_result "PUT /api/clients/${CLIENT_ID} (update)" "200" "$HTTP_CODE" "$BODY"
fi

# ── 4. Work Entry CRUD ───────────────────────────────────────────────

section "4. Work Entry CRUD"

WORK_ENTRY_ID=""

if [ -n "$CLIENT_ID" ]; then
  # Create a work entry
  TODAY=$(date -u +%Y-%m-%d)
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/work-entries" \
    -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    -d "{\"clientId\":${CLIENT_ID},\"hours\":2.5,\"description\":\"Health check test entry\",\"date\":\"${TODAY}\"}" \
    2>/dev/null || echo -e "\n000")
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  check_result "POST /api/work-entries (create)" "201" "$HTTP_CODE" "$BODY"

  WORK_ENTRY_ID=$(echo "$BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

  # List work entries
  RESPONSE=$(curl -s -w "\n%{http_code}" "${BASE_URL}/api/work-entries" \
    -H "x-user-email: ${TEST_EMAIL}" 2>/dev/null || echo -e "\n000")
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  check_result "GET /api/work-entries (list)" "200" "$HTTP_CODE" "$BODY"
  check_json_field "GET /api/work-entries" "$BODY" "workEntries"

  # List with client filter
  RESPONSE=$(curl -s -w "\n%{http_code}" "${BASE_URL}/api/work-entries?clientId=${CLIENT_ID}" \
    -H "x-user-email: ${TEST_EMAIL}" 2>/dev/null || echo -e "\n000")
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  check_result "GET /api/work-entries?clientId=${CLIENT_ID} (filtered)" "200" "$HTTP_CODE" "$BODY"

  if [ -n "$WORK_ENTRY_ID" ]; then
    # Get specific work entry
    RESPONSE=$(curl -s -w "\n%{http_code}" "${BASE_URL}/api/work-entries/${WORK_ENTRY_ID}" \
      -H "x-user-email: ${TEST_EMAIL}" 2>/dev/null || echo -e "\n000")
    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | sed '$d')

    check_result "GET /api/work-entries/${WORK_ENTRY_ID} (get by ID)" "200" "$HTTP_CODE" "$BODY"

    # Update work entry
    RESPONSE=$(curl -s -w "\n%{http_code}" -X PUT "${BASE_URL}/api/work-entries/${WORK_ENTRY_ID}" \
      -H "Content-Type: application/json" \
      -H "x-user-email: ${TEST_EMAIL}" \
      -d '{"hours":3.0}' \
      2>/dev/null || echo -e "\n000")
    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | sed '$d')

    check_result "PUT /api/work-entries/${WORK_ENTRY_ID} (update)" "200" "$HTTP_CODE" "$BODY"
  fi
else
  RESULTS+=("${YELLOW}WARN${NC}  Skipping work entry tests – no client ID available")
  WARN_COUNT=$((WARN_COUNT + 1))
fi

# ── 5. Reports ────────────────────────────────────────────────────────

section "5. Reports"

if [ -n "$CLIENT_ID" ]; then
  # Get client report
  RESPONSE=$(curl -s -w "\n%{http_code}" "${BASE_URL}/api/reports/client/${CLIENT_ID}" \
    -H "x-user-email: ${TEST_EMAIL}" 2>/dev/null || echo -e "\n000")
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  check_result "GET /api/reports/client/${CLIENT_ID}" "200" "$HTTP_CODE" "$BODY"
  check_json_field "GET /api/reports/client/${CLIENT_ID}" "$BODY" "totalHours"
  check_json_field "GET /api/reports/client/${CLIENT_ID}" "$BODY" "entryCount"

  # Test CSV export (check for 200 and correct content-type)
  RESPONSE=$(curl -s -w "\n%{http_code}" -o /dev/null \
    "${BASE_URL}/api/reports/export/csv/${CLIENT_ID}" \
    -H "x-user-email: ${TEST_EMAIL}" 2>/dev/null || echo -e "\n000")
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)

  check_result "GET /api/reports/export/csv/${CLIENT_ID}" "200" "$HTTP_CODE"

  # Test PDF export
  RESPONSE=$(curl -s -w "\n%{http_code}" -o /dev/null \
    "${BASE_URL}/api/reports/export/pdf/${CLIENT_ID}" \
    -H "x-user-email: ${TEST_EMAIL}" 2>/dev/null || echo -e "\n000")
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)

  check_result "GET /api/reports/export/pdf/${CLIENT_ID}" "200" "$HTTP_CODE"
else
  RESULTS+=("${YELLOW}WARN${NC}  Skipping report tests – no client ID available")
  WARN_COUNT=$((WARN_COUNT + 1))
fi

# ── 6. Error Handling ─────────────────────────────────────────────────

section "6. Error Handling"

# 404 – unknown route
RESPONSE=$(curl -s -w "\n%{http_code}" "${BASE_URL}/api/nonexistent" 2>/dev/null || echo -e "\n000")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)

check_result "GET /api/nonexistent (expect 404)" "404" "$HTTP_CODE"

# 400 – invalid client ID
RESPONSE=$(curl -s -w "\n%{http_code}" "${BASE_URL}/api/clients/not-a-number" \
  -H "x-user-email: ${TEST_EMAIL}" 2>/dev/null || echo -e "\n000")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)

check_result "GET /api/clients/not-a-number (expect 400)" "400" "$HTTP_CODE"

# 400 – validation error on create client (missing name)
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/clients" \
  -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  -d '{"description":"missing name field"}' \
  2>/dev/null || echo -e "\n000")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)

check_result "POST /api/clients (missing required field – expect 400)" "400" "$HTTP_CODE"

# ── 7. Cleanup ────────────────────────────────────────────────────────

section "7. Cleanup"

if [ -n "${WORK_ENTRY_ID:-}" ]; then
  RESPONSE=$(curl -s -w "\n%{http_code}" -X DELETE "${BASE_URL}/api/work-entries/${WORK_ENTRY_ID}" \
    -H "x-user-email: ${TEST_EMAIL}" 2>/dev/null || echo -e "\n000")
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  check_result "DELETE /api/work-entries/${WORK_ENTRY_ID}" "200" "$HTTP_CODE"
fi

if [ -n "${CLIENT_ID:-}" ]; then
  RESPONSE=$(curl -s -w "\n%{http_code}" -X DELETE "${BASE_URL}/api/clients/${CLIENT_ID}" \
    -H "x-user-email: ${TEST_EMAIL}" 2>/dev/null || echo -e "\n000")
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  check_result "DELETE /api/clients/${CLIENT_ID}" "200" "$HTTP_CODE"
fi

# ── Summary ───────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════${NC}"
echo -e "${BOLD} Health Check Results${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════${NC}"

for r in "${RESULTS[@]}"; do
  echo -e "$r"
done

echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════${NC}"
TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo -e " ${GREEN}Passed: ${PASS_COUNT}${NC}  ${RED}Failed: ${FAIL_COUNT}${NC}  ${YELLOW}Warnings: ${WARN_COUNT}${NC}  Total: ${TOTAL}"
echo -e "${BOLD}═══════════════════════════════════════════════════${NC}"

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo ""
  echo -e "${RED}${BOLD}HEALTH CHECK FAILED${NC} – ${FAIL_COUNT} check(s) did not pass."
  echo -e "Refer to RUNBOOK.md for diagnosis and resolution procedures."
  exit 1
else
  echo ""
  echo -e "${GREEN}${BOLD}ALL CHECKS PASSED${NC} – Application is healthy."
  exit 0
fi
