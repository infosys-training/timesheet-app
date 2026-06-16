#!/usr/bin/env bash
#
# healthcheck.sh — Verify all critical timesheet-app endpoints are responding.
#
# Usage:
#   ./scripts/healthcheck.sh                   # defaults to http://localhost:3001
#   ./scripts/healthcheck.sh https://myapp.com # custom base URL
#
# Exit codes:
#   0  All checks passed
#   1  One or more checks failed
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE_URL="${1:-http://localhost:3001}"
BASE_URL="${BASE_URL%/}"  # strip trailing slash
TEST_EMAIL="healthcheck@timesheet-app.example.com"
TIMEOUT=10  # curl timeout in seconds

PASS=0
FAIL=0
WARN=0
RESULTS=()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'  # No Color

check() {
  local name="$1"
  local method="$2"
  local path="$3"
  local expected_status="$4"
  shift 4
  local extra_args=("$@")

  local url="${BASE_URL}${path}"
  local start end elapsed http_code body

  start=$(date +%s%N)

  # Build curl command
  local curl_cmd=(curl -s -o /tmp/healthcheck_body.txt -w "%{http_code}"
    --max-time "$TIMEOUT"
    -X "$method"
    "${extra_args[@]}"
    "$url")

  http_code=$("${curl_cmd[@]}" 2>/dev/null) || http_code="000"
  body=$(cat /tmp/healthcheck_body.txt 2>/dev/null || echo "")

  end=$(date +%s%N)
  elapsed=$(( (end - start) / 1000000 ))  # milliseconds

  if [[ "$http_code" == "$expected_status" ]] || [[ "$expected_status" == "2xx" && "$http_code" =~ ^2[0-9]{2}$ ]]; then
    PASS=$((PASS + 1))
    RESULTS+=("${GREEN}PASS${NC}  ${name}  (${http_code}) [${elapsed}ms]")
  elif [[ "$http_code" == "000" ]]; then
    FAIL=$((FAIL + 1))
    RESULTS+=("${RED}FAIL${NC}  ${name}  (connection refused / timeout) [${elapsed}ms]")
  else
    FAIL=$((FAIL + 1))
    RESULTS+=("${RED}FAIL${NC}  ${name}  (expected ${expected_status}, got ${http_code}) [${elapsed}ms]  ${body:0:120}")
  fi
}

warn_check() {
  local name="$1"
  local condition="$2"

  if eval "$condition"; then
    RESULTS+=("${GREEN}PASS${NC}  ${name}")
  else
    WARN=$((WARN + 1))
    RESULTS+=("${YELLOW}WARN${NC}  ${name}")
  fi
}

# ---------------------------------------------------------------------------
# 1. Core health endpoint
# ---------------------------------------------------------------------------
echo -e "${CYAN}=== Timesheet App Health Check ===${NC}"
echo -e "Target: ${BASE_URL}"
echo -e "Time:   $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
echo ""

check "GET  /health" \
  GET "/health" "200"

# ---------------------------------------------------------------------------
# 2. Authentication endpoints
# ---------------------------------------------------------------------------
check "POST /api/auth/login (valid email)" \
  POST "/api/auth/login" "2xx" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${TEST_EMAIL}\"}"

check "GET  /api/auth/me (authenticated)" \
  GET "/api/auth/me" "200" \
  -H "x-user-email: ${TEST_EMAIL}"

check "GET  /api/auth/me (no auth header → 401)" \
  GET "/api/auth/me" "401"

# ---------------------------------------------------------------------------
# 3. Clients CRUD endpoints
# ---------------------------------------------------------------------------
check "GET  /api/clients (list)" \
  GET "/api/clients" "200" \
  -H "x-user-email: ${TEST_EMAIL}"

# Create a test client
check "POST /api/clients (create)" \
  POST "/api/clients" "201" \
  -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  -d '{"name":"HealthCheck Test Client"}'

# Extract the created client ID for subsequent tests
CLIENT_ID=$(cat /tmp/healthcheck_body.txt 2>/dev/null | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

if [[ -n "${CLIENT_ID:-}" ]]; then
  check "GET  /api/clients/:id (read)" \
    GET "/api/clients/${CLIENT_ID}" "200" \
    -H "x-user-email: ${TEST_EMAIL}"

  check "PUT  /api/clients/:id (update)" \
    PUT "/api/clients/${CLIENT_ID}" "200" \
    -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    -d '{"name":"HealthCheck Updated Client"}'
else
  WARN=$((WARN + 1))
  RESULTS+=("${YELLOW}WARN${NC}  Skipped client read/update — could not parse client ID from create response")
fi

# ---------------------------------------------------------------------------
# 4. Work entries endpoints
# ---------------------------------------------------------------------------
check "GET  /api/work-entries (list)" \
  GET "/api/work-entries" "200" \
  -H "x-user-email: ${TEST_EMAIL}"

if [[ -n "${CLIENT_ID:-}" ]]; then
  TODAY=$(date -u +"%Y-%m-%d")

  check "POST /api/work-entries (create)" \
    POST "/api/work-entries" "201" \
    -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    -d "{\"clientId\":${CLIENT_ID},\"hours\":1.5,\"description\":\"Health check entry\",\"date\":\"${TODAY}\"}"

  ENTRY_ID=$(cat /tmp/healthcheck_body.txt 2>/dev/null | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

  if [[ -n "${ENTRY_ID:-}" ]]; then
    check "GET  /api/work-entries/:id (read)" \
      GET "/api/work-entries/${ENTRY_ID}" "200" \
      -H "x-user-email: ${TEST_EMAIL}"

    check "PUT  /api/work-entries/:id (update)" \
      PUT "/api/work-entries/${ENTRY_ID}" "200" \
      -H "Content-Type: application/json" \
      -H "x-user-email: ${TEST_EMAIL}" \
      -d '{"hours":2.0}'
  fi
fi

# ---------------------------------------------------------------------------
# 5. Reports endpoints
# ---------------------------------------------------------------------------
if [[ -n "${CLIENT_ID:-}" ]]; then
  check "GET  /api/reports/client/:id (report)" \
    GET "/api/reports/client/${CLIENT_ID}" "200" \
    -H "x-user-email: ${TEST_EMAIL}"

  check "GET  /api/reports/export/csv/:id (CSV export)" \
    GET "/api/reports/export/csv/${CLIENT_ID}" "200" \
    -H "x-user-email: ${TEST_EMAIL}"

  check "GET  /api/reports/export/pdf/:id (PDF export)" \
    GET "/api/reports/export/pdf/${CLIENT_ID}" "200" \
    -H "x-user-email: ${TEST_EMAIL}"
fi

# ---------------------------------------------------------------------------
# 6. Validation / error handling
# ---------------------------------------------------------------------------
check "POST /api/auth/login (invalid email → 400)" \
  POST "/api/auth/login" "400" \
  -H "Content-Type: application/json" \
  -d '{"email":"not-an-email"}'

check "POST /api/clients (missing name → 400)" \
  POST "/api/clients" "400" \
  -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  -d '{}'

check "GET  /nonexistent (404)" \
  GET "/nonexistent" "404"

# ---------------------------------------------------------------------------
# 7. Cleanup — delete test data
# ---------------------------------------------------------------------------
if [[ -n "${ENTRY_ID:-}" ]]; then
  check "DELETE /api/work-entries/:id (cleanup)" \
    DELETE "/api/work-entries/${ENTRY_ID}" "200" \
    -H "x-user-email: ${TEST_EMAIL}"
fi

if [[ -n "${CLIENT_ID:-}" ]]; then
  check "DELETE /api/clients/:id (cleanup)" \
    DELETE "/api/clients/${CLIENT_ID}" "200" \
    -H "x-user-email: ${TEST_EMAIL}"
fi

# ---------------------------------------------------------------------------
# 8. Infrastructure checks (non-blocking warnings)
# ---------------------------------------------------------------------------
warn_check "Disk space > 10% free" \
  "[[ \$(df --output=pcent / 2>/dev/null | tail -1 | tr -d ' %') -lt 90 ]]"

warn_check "Node.js process is running" \
  "pgrep -f 'node.*server.js' > /dev/null 2>&1 || docker ps --format '{{.Names}}' 2>/dev/null | grep -q timesheet"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
rm -f /tmp/healthcheck_body.txt

echo ""
echo -e "${CYAN}--- Results ---${NC}"
for r in "${RESULTS[@]}"; do
  echo -e "  $r"
done

TOTAL=$((PASS + FAIL + WARN))
echo ""
echo -e "${CYAN}--- Summary ---${NC}"
echo -e "  Total checks: ${TOTAL}"
echo -e "  ${GREEN}Passed: ${PASS}${NC}"
[[ $FAIL -gt 0 ]] && echo -e "  ${RED}Failed: ${FAIL}${NC}" || echo -e "  Failed: 0"
[[ $WARN -gt 0 ]] && echo -e "  ${YELLOW}Warnings: ${WARN}${NC}" || echo -e "  Warnings: 0"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo -e "${RED}HEALTH CHECK FAILED — see failures above.${NC}"
  exit 1
else
  echo -e "${GREEN}ALL CHECKS PASSED.${NC}"
  exit 0
fi
