#!/usr/bin/env bash
#
# healthcheck.sh — Verify all critical endpoints of the timesheet-app.
#
# Usage:
#   ./scripts/healthcheck.sh [BASE_URL]
#
# BASE_URL defaults to http://localhost:3001.
# Exit codes:
#   0  All checks passed
#   1  One or more checks failed
#
# The script creates a temporary test user, exercises every API route
# (auth, clients, work-entries, reports, exports), and cleans up after itself.

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="healthcheck-$(date +%s)@test.internal"
PASS=0
FAIL=0
TOTAL=0
FAILURES=""

# ─── Helpers ──────────────────────────────────────────────────────────────────

green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }

check() {
  local name="$1"
  local method="$2"
  local endpoint="$3"
  local expected_status="$4"
  shift 4
  local extra_args=("$@")

  TOTAL=$((TOTAL + 1))

  local response_file
  response_file=$(mktemp)

  local http_code
  http_code=$(curl -s -o "$response_file" -w '%{http_code}' \
    -X "$method" \
    -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    --max-time 10 \
    "${extra_args[@]}" \
    "${BASE_URL}${endpoint}" 2>/dev/null) || http_code="000"

  if [ "$http_code" = "$expected_status" ]; then
    green "  PASS  $name (${method} ${endpoint}) → ${http_code}"
    PASS=$((PASS + 1))
    cat "$response_file"  # capture body for later use
  else
    red "  FAIL  $name (${method} ${endpoint}) → ${http_code} (expected ${expected_status})"
    FAIL=$((FAIL + 1))
    FAILURES="${FAILURES}\n  - ${name}: got ${http_code}, expected ${expected_status}"
    cat "$response_file" >&2
  fi

  rm -f "$response_file"
  return 0
}

# ─── Checks ───────────────────────────────────────────────────────────────────

echo ""
echo "============================================"
echo "  Timesheet App Health Check"
echo "  Target: ${BASE_URL}"
echo "  Test user: ${TEST_EMAIL}"
echo "============================================"
echo ""

# --- 1. Basic health endpoint ---
echo "--- Core ---"
check "Health endpoint" GET "/health" "200"
echo ""

# --- 2. Authentication ---
echo "--- Authentication ---"
LOGIN_BODY=$(check "Login (create user)" POST "/api/auth/login" "201" \
  -d "{\"email\":\"${TEST_EMAIL}\"}")

# Second login should return 200 (existing user)
check "Login (existing user)" POST "/api/auth/login" "200" \
  -d "{\"email\":\"${TEST_EMAIL}\"}" >/dev/null

check "Get current user" GET "/api/auth/me" "200" >/dev/null
echo ""

# --- 3. Clients CRUD ---
echo "--- Clients ---"
CREATE_CLIENT_BODY=$(check "Create client" POST "/api/clients" "201" \
  -d '{"name":"HealthCheck Test Client","description":"Automated health check","department":"QA"}')

CLIENT_ID=$(echo "$CREATE_CLIENT_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
if [ -z "$CLIENT_ID" ]; then
  red "  WARN  Could not parse client ID from create response — using 1"
  CLIENT_ID=1
fi

check "List clients" GET "/api/clients" "200" >/dev/null

check "Get single client" GET "/api/clients/${CLIENT_ID}" "200" >/dev/null

check "Update client" PUT "/api/clients/${CLIENT_ID}" "200" \
  -d '{"name":"HealthCheck Test Client (updated)"}' >/dev/null
echo ""

# --- 4. Work Entries CRUD ---
echo "--- Work Entries ---"
CREATE_ENTRY_BODY=$(check "Create work entry" POST "/api/work-entries" "201" \
  -d "{\"clientId\":${CLIENT_ID},\"hours\":2.5,\"description\":\"Health check test entry\",\"date\":\"$(date -u +%Y-%m-%d)\"}")

ENTRY_ID=$(echo "$CREATE_ENTRY_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
if [ -z "$ENTRY_ID" ]; then
  red "  WARN  Could not parse entry ID from create response — using 1"
  ENTRY_ID=1
fi

check "List work entries" GET "/api/work-entries" "200" >/dev/null

check "List work entries (filtered)" GET "/api/work-entries?clientId=${CLIENT_ID}" "200" >/dev/null

check "Get single work entry" GET "/api/work-entries/${ENTRY_ID}" "200" >/dev/null

check "Update work entry" PUT "/api/work-entries/${ENTRY_ID}" "200" \
  -d '{"hours":3.0}' >/dev/null
echo ""

# --- 5. Reports ---
echo "--- Reports ---"
check "Client report" GET "/api/reports/client/${CLIENT_ID}" "200" >/dev/null

check "Export CSV" GET "/api/reports/export/csv/${CLIENT_ID}" "200" >/dev/null

check "Export PDF" GET "/api/reports/export/pdf/${CLIENT_ID}" "200" >/dev/null
echo ""

# --- 6. Validation / Error handling ---
echo "--- Validation & Error Handling ---"
check "Invalid login (missing email)" POST "/api/auth/login" "400" \
  -d '{}' >/dev/null

check "Invalid client ID" GET "/api/clients/notanumber" "400" >/dev/null

check "Missing auth header" GET "/api/clients" "401" \
  -H "x-user-email: " >/dev/null 2>/dev/null || true

check "Nonexistent route" GET "/api/nonexistent" "404" >/dev/null
echo ""

# --- 7. Cleanup ---
echo "--- Cleanup ---"
check "Delete work entry" DELETE "/api/work-entries/${ENTRY_ID}" "200" >/dev/null

check "Delete client" DELETE "/api/clients/${CLIENT_ID}" "200" >/dev/null
echo ""

# ─── Summary ──────────────────────────────────────────────────────────────────

echo "============================================"
echo "  Results: ${PASS} passed, ${FAIL} failed (${TOTAL} total)"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  red "Failed checks:${FAILURES}"
  echo ""
  exit 1
else
  echo ""
  green "All health checks passed."
  echo ""
  exit 0
fi
