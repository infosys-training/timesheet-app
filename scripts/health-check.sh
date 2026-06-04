#!/usr/bin/env bash
#
# health-check.sh — Verify all critical timesheet-app endpoints are reachable.
#
# Usage:
#   ./scripts/health-check.sh [BASE_URL]
#
# BASE_URL defaults to http://localhost:3001
#
# Exit codes:
#   0  All checks passed
#   1  One or more checks failed
#
# The script uses a test email to exercise authenticated endpoints.
# It creates minimal test data (a client and work entry), verifies
# CRUD and report endpoints, then cleans up after itself.

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="healthcheck-$(date +%s)@test.local"
PASS=0
FAIL=0
TOTAL=0

# Colors (disabled when stdout is not a terminal)
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[1;33m'
  NC='\033[0m'
else
  GREEN='' RED='' YELLOW='' NC=''
fi

check() {
  local description="$1"
  local expected_status="$2"
  local method="$3"
  local url="$4"
  shift 4
  local extra_args=("$@")

  TOTAL=$((TOTAL + 1))

  local http_code
  local response_body
  local tmpfile
  tmpfile=$(mktemp)

  http_code=$(curl -s -o "$tmpfile" -w "%{http_code}" \
    -X "$method" \
    -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    "${extra_args[@]}" \
    "$url" 2>/dev/null) || true

  response_body=$(cat "$tmpfile")
  rm -f "$tmpfile"

  if [ "$http_code" = "$expected_status" ]; then
    PASS=$((PASS + 1))
    printf "${GREEN}PASS${NC}  [%s] %s (HTTP %s)\n" "$method" "$description" "$http_code"
  else
    FAIL=$((FAIL + 1))
    printf "${RED}FAIL${NC}  [%s] %s — expected %s, got %s\n" "$method" "$description" "$expected_status" "$http_code"
    if [ -n "$response_body" ]; then
      printf "       Response: %.200s\n" "$response_body"
    fi
  fi

  # Return the response body so callers can extract IDs
  echo "$response_body"
}

echo "============================================"
echo " Timesheet App — Health Check"
echo " Target: ${BASE_URL}"
echo " Test user: ${TEST_EMAIL}"
echo " Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "============================================"
echo ""

# ── 1. Health endpoint (unauthenticated) ──────────────────────────

echo "── Core ──"
check "GET /health" 200 GET "${BASE_URL}/health" > /dev/null

# ── 2. Auth endpoints ────────────────────────────────────────────

echo ""
echo "── Auth ──"
check "POST /api/auth/login" 201 POST "${BASE_URL}/api/auth/login" \
  -d "{\"email\":\"${TEST_EMAIL}\"}" > /dev/null

check "GET /api/auth/me" 200 GET "${BASE_URL}/api/auth/me" > /dev/null

# ── 3. Clients CRUD ─────────────────────────────────────────────

echo ""
echo "── Clients ──"
CLIENT_RESPONSE=$(check "POST /api/clients (create)" 201 POST "${BASE_URL}/api/clients" \
  -d '{"name":"HealthCheck Test Client","description":"auto-created by health check"}')
CLIENT_ID=$(echo "$CLIENT_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

if [ -z "$CLIENT_ID" ]; then
  printf "${RED}FAIL${NC}  Could not extract client ID — skipping dependent checks\n"
  FAIL=$((FAIL + 1))
else
  check "GET /api/clients (list)" 200 GET "${BASE_URL}/api/clients" > /dev/null

  check "GET /api/clients/${CLIENT_ID}" 200 GET "${BASE_URL}/api/clients/${CLIENT_ID}" > /dev/null

  check "PUT /api/clients/${CLIENT_ID}" 200 PUT "${BASE_URL}/api/clients/${CLIENT_ID}" \
    -d '{"name":"HealthCheck Updated Client"}' > /dev/null

  # ── 4. Work Entries CRUD ─────────────────────────────────────

  echo ""
  echo "── Work Entries ──"
  ENTRY_RESPONSE=$(check "POST /api/work-entries (create)" 201 POST "${BASE_URL}/api/work-entries" \
    -d "{\"clientId\":${CLIENT_ID},\"hours\":1.5,\"description\":\"health check entry\",\"date\":\"$(date -u +%Y-%m-%d)\"}")
  ENTRY_ID=$(echo "$ENTRY_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

  check "GET /api/work-entries (list)" 200 GET "${BASE_URL}/api/work-entries" > /dev/null

  if [ -n "$ENTRY_ID" ]; then
    check "GET /api/work-entries/${ENTRY_ID}" 200 GET "${BASE_URL}/api/work-entries/${ENTRY_ID}" > /dev/null

    check "PUT /api/work-entries/${ENTRY_ID}" 200 PUT "${BASE_URL}/api/work-entries/${ENTRY_ID}" \
      -d '{"hours":2.0}' > /dev/null
  fi

  # ── 5. Reports ────────────────────────────────────────────────

  echo ""
  echo "── Reports ──"
  check "GET /api/reports/client/${CLIENT_ID}" 200 GET "${BASE_URL}/api/reports/client/${CLIENT_ID}" > /dev/null

  check "GET /api/reports/export/csv/${CLIENT_ID}" 200 GET "${BASE_URL}/api/reports/export/csv/${CLIENT_ID}" > /dev/null

  check "GET /api/reports/export/pdf/${CLIENT_ID}" 200 GET "${BASE_URL}/api/reports/export/pdf/${CLIENT_ID}" > /dev/null

  # ── 6. Cleanup ────────────────────────────────────────────────

  echo ""
  echo "── Cleanup ──"
  if [ -n "$ENTRY_ID" ]; then
    check "DELETE /api/work-entries/${ENTRY_ID}" 200 DELETE "${BASE_URL}/api/work-entries/${ENTRY_ID}" > /dev/null
  fi

  check "DELETE /api/clients/${CLIENT_ID}" 200 DELETE "${BASE_URL}/api/clients/${CLIENT_ID}" > /dev/null
fi

# ── 7. Edge cases ───────────────────────────────────────────────

echo ""
echo "── Edge Cases ──"
check "GET /nonexistent (404)" 404 GET "${BASE_URL}/api/nonexistent" > /dev/null

# Missing auth header
TOTAL=$((TOTAL + 1))
NOAUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X GET "${BASE_URL}/api/clients" 2>/dev/null) || true
if [ "$NOAUTH_CODE" = "401" ]; then
  PASS=$((PASS + 1))
  printf "${GREEN}PASS${NC}  [GET] Missing auth header returns 401 (HTTP %s)\n" "$NOAUTH_CODE"
else
  FAIL=$((FAIL + 1))
  printf "${RED}FAIL${NC}  [GET] Missing auth header — expected 401, got %s\n" "$NOAUTH_CODE"
fi

# ── Summary ─────────────────────────────────────────────────────

echo ""
echo "============================================"
if [ "$FAIL" -eq 0 ]; then
  printf " Result: ${GREEN}ALL %d CHECKS PASSED${NC}\n" "$TOTAL"
else
  printf " Result: ${RED}%d/%d CHECKS FAILED${NC}\n" "$FAIL" "$TOTAL"
fi
echo "============================================"

exit "$FAIL"
