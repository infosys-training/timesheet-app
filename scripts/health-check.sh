#!/usr/bin/env bash
#
# Health Check Script for Timesheet App
#
# Tests all critical backend endpoints and reports status.
# Exits with code 0 if all checks pass, 1 if any fail.
#
# Usage:
#   ./scripts/health-check.sh                  # defaults to http://localhost:3001
#   ./scripts/health-check.sh http://prod:3001 # custom base URL
#   HEALTH_CHECK_EMAIL=me@co.com ./scripts/health-check.sh  # custom test email
#

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="${HEALTH_CHECK_EMAIL:-healthcheck@timesheet-app.com}"

PASS=0
FAIL=0
TOTAL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

check() {
  local name="$1"
  local method="$2"
  local url="$3"
  local expected_status="$4"  # comma-separated list, e.g. "200,201"
  local data="${5:-}"
  local extra_headers="${6:-}"

  TOTAL=$((TOTAL + 1))

  local curl_args=(-s -o /tmp/healthcheck_body -w "%{http_code}" -X "$method" --max-time 10)
  curl_args+=(-H "Content-Type: application/json")
  curl_args+=(-H "x-user-email: ${TEST_EMAIL}")

  if [ -n "$extra_headers" ]; then
    curl_args+=(-H "$extra_headers")
  fi

  if [ -n "$data" ]; then
    curl_args+=(-d "$data")
  fi

  local status
  status=$(curl "${curl_args[@]}" "$url" 2>/dev/null) || status="000"

  # Check if status matches any of the expected codes
  local matched=false
  IFS=',' read -ra EXPECTED <<< "$expected_status"
  for code in "${EXPECTED[@]}"; do
    if [ "$status" = "$code" ]; then
      matched=true
      break
    fi
  done

  if [ "$matched" = true ]; then
    echo -e "  ${GREEN}PASS${NC}  ${name} (HTTP ${status})"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC}  ${name} — expected ${expected_status}, got ${status}"
    if [ -f /tmp/healthcheck_body ]; then
      echo "        Response: $(head -c 200 /tmp/healthcheck_body)"
    fi
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "============================================"
echo " Timesheet App Health Check"
echo " Target: ${BASE_URL}"
echo " Time:   $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "============================================"
echo ""

# ── 1. Core Health ──────────────────────────────
echo "── Core Health ──"
check "GET /health" \
  GET "${BASE_URL}/health" "200"

# ── 2. Authentication ───────────────────────────
echo ""
echo "── Authentication ──"
check "POST /api/auth/login (valid email)" \
  POST "${BASE_URL}/api/auth/login" "200,201" \
  "{\"email\": \"${TEST_EMAIL}\"}"

check "POST /api/auth/login (invalid email)" \
  POST "${BASE_URL}/api/auth/login" "400" \
  '{"email": "not-an-email"}'

check "GET /api/auth/me (authenticated)" \
  GET "${BASE_URL}/api/auth/me" "200"

# ── 3. Clients CRUD ────────────────────────────
echo ""
echo "── Clients ──"

# Create a test client
check "POST /api/clients (create)" \
  POST "${BASE_URL}/api/clients" "201" \
  '{"name": "__healthcheck_test_client__", "description": "Created by health check script"}'

# Extract client ID from response
CLIENT_ID=""
if [ -f /tmp/healthcheck_body ]; then
  CLIENT_ID=$(grep -o '"id":[0-9]*' /tmp/healthcheck_body 2>/dev/null | head -1 | cut -d: -f2) || true
fi

check "GET /api/clients (list)" \
  GET "${BASE_URL}/api/clients" "200"

if [ -n "$CLIENT_ID" ]; then
  check "GET /api/clients/:id (get by ID)" \
    GET "${BASE_URL}/api/clients/${CLIENT_ID}" "200"

  check "PUT /api/clients/:id (update)" \
    PUT "${BASE_URL}/api/clients/${CLIENT_ID}" "200" \
    '{"name": "__healthcheck_test_client_updated__"}'
fi

# ── 4. Work Entries CRUD ────────────────────────
echo ""
echo "── Work Entries ──"

WORK_ENTRY_ID=""
if [ -n "$CLIENT_ID" ]; then
  TODAY=$(date -u '+%Y-%m-%d')
  check "POST /api/work-entries (create)" \
    POST "${BASE_URL}/api/work-entries" "201" \
    "{\"clientId\": ${CLIENT_ID}, \"hours\": 1, \"description\": \"Health check test entry\", \"date\": \"${TODAY}\"}"

  if [ -f /tmp/healthcheck_body ]; then
    WORK_ENTRY_ID=$(grep -o '"id":[0-9]*' /tmp/healthcheck_body 2>/dev/null | head -1 | cut -d: -f2) || true
  fi
fi

check "GET /api/work-entries (list)" \
  GET "${BASE_URL}/api/work-entries" "200"

if [ -n "$WORK_ENTRY_ID" ]; then
  check "GET /api/work-entries/:id (get by ID)" \
    GET "${BASE_URL}/api/work-entries/${WORK_ENTRY_ID}" "200"

  check "PUT /api/work-entries/:id (update)" \
    PUT "${BASE_URL}/api/work-entries/${WORK_ENTRY_ID}" "200" \
    '{"hours": 2}'
fi

# ── 5. Reports ──────────────────────────────────
echo ""
echo "── Reports ──"

if [ -n "$CLIENT_ID" ]; then
  check "GET /api/reports/client/:id (JSON report)" \
    GET "${BASE_URL}/api/reports/client/${CLIENT_ID}" "200"

  check "GET /api/reports/export/csv/:id (CSV export)" \
    GET "${BASE_URL}/api/reports/export/csv/${CLIENT_ID}" "200"

  check "GET /api/reports/export/pdf/:id (PDF export)" \
    GET "${BASE_URL}/api/reports/export/pdf/${CLIENT_ID}" "200"
fi

# ── 6. Error Handling ───────────────────────────
echo ""
echo "── Error Handling ──"

check "GET /nonexistent (404 handler)" \
  GET "${BASE_URL}/nonexistent" "404"

check "GET /api/clients/invalid (bad ID)" \
  GET "${BASE_URL}/api/clients/abc" "400"

check "POST /api/clients (missing name — validation)" \
  POST "${BASE_URL}/api/clients" "400" \
  '{"description": "no name field"}'

# ── 7. Cleanup ──────────────────────────────────
echo ""
echo "── Cleanup ──"

if [ -n "$WORK_ENTRY_ID" ]; then
  check "DELETE /api/work-entries/:id (cleanup)" \
    DELETE "${BASE_URL}/api/work-entries/${WORK_ENTRY_ID}" "200"
fi

if [ -n "$CLIENT_ID" ]; then
  check "DELETE /api/clients/:id (cleanup)" \
    DELETE "${BASE_URL}/api/clients/${CLIENT_ID}" "200"
fi

# ── Summary ─────────────────────────────────────
echo ""
echo "============================================"
if [ "$FAIL" -eq 0 ]; then
  echo -e " Result: ${GREEN}ALL ${TOTAL} CHECKS PASSED${NC}"
else
  echo -e " Result: ${RED}${FAIL}/${TOTAL} CHECKS FAILED${NC}, ${GREEN}${PASS} passed${NC}"
fi
echo "============================================"
echo ""

rm -f /tmp/healthcheck_body

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
