#!/usr/bin/env bash
#
# Health Check Script for Timesheet App
#
# Tests all critical backend endpoints and reports pass/fail status.
# Exits 0 if all checks pass, 1 if any check fails.
#
# Usage:
#   ./scripts/healthcheck.sh                    # defaults to http://localhost:3001
#   ./scripts/healthcheck.sh http://myserver:3001
#   BASE_URL=http://myserver:3001 ./scripts/healthcheck.sh

set -euo pipefail

BASE_URL="${1:-${BASE_URL:-http://localhost:3001}}"
TEST_EMAIL="healthcheck@timesheet-app.com"
PASS=0
FAIL=0
WARNINGS=""

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  GREEN='' RED='' YELLOW='' BOLD='' NC=''
fi

check() {
  local name="$1"
  local method="$2"
  local url="$3"
  shift 3
  local expected_status="${1:-200}"
  shift || true
  local extra_args=("$@")

  local start_ms
  start_ms=$(date +%s%3N 2>/dev/null || date +%s000)

  local http_code body
  body=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time 10 \
    -X "$method" \
    -H "Content-Type: application/json" \
    "${extra_args[@]}" \
    "$url" 2>/dev/null) || body="000"

  local end_ms
  end_ms=$(date +%s%3N 2>/dev/null || date +%s000)
  local elapsed=$(( end_ms - start_ms ))

  if [ "$body" = "$expected_status" ]; then
    printf "${GREEN}PASS${NC}  %-45s  HTTP %s  (%dms)\n" "$name" "$body" "$elapsed"
    PASS=$((PASS + 1))
  else
    printf "${RED}FAIL${NC}  %-45s  HTTP %s (expected %s)  (%dms)\n" "$name" "$body" "$expected_status" "$elapsed"
    FAIL=$((FAIL + 1))
  fi
}

check_json_field() {
  local name="$1"
  local url="$2"
  local field="$3"
  local expected_value="$4"
  shift 4
  local extra_args=("$@")

  local response
  response=$(curl -s --max-time 10 \
    -H "Content-Type: application/json" \
    "${extra_args[@]}" \
    "$url" 2>/dev/null) || response=""

  local actual_value
  actual_value=$(echo "$response" | grep -o "\"$field\":\"[^\"]*\"" | head -1 | cut -d'"' -f4)

  if [ "$actual_value" = "$expected_value" ]; then
    printf "${GREEN}PASS${NC}  %-45s  %s=%s\n" "$name" "$field" "$actual_value"
    PASS=$((PASS + 1))
  else
    printf "${RED}FAIL${NC}  %-45s  %s=%s (expected %s)\n" "$name" "$field" "${actual_value:-<empty>}" "$expected_value"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
printf "${BOLD}Timesheet App Health Check${NC}\n"
printf "Target: %s\n" "$BASE_URL"
printf "Time:   %s\n" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "─────────────────────────────────────────────────────────────────"
echo ""

# ── 1. Health Endpoint ──────────────────────────────────────────────
printf "${BOLD}[Health]${NC}\n"
check "GET /health" \
  GET "$BASE_URL/health" 200

check_json_field "GET /health — status field" \
  "$BASE_URL/health" "status" "OK"

echo ""

# ── 2. Authentication ───────────────────────────────────────────────
printf "${BOLD}[Authentication]${NC}\n"
# Login returns 200 for existing users, 201 for new users — both are valid
LOGIN_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\"}" \
  "$BASE_URL/api/auth/login" 2>/dev/null)
if [ "$LOGIN_STATUS" = "200" ] || [ "$LOGIN_STATUS" = "201" ]; then
  printf "${GREEN}PASS${NC}  %-45s  HTTP %s\n" "POST /api/auth/login (valid email)" "$LOGIN_STATUS"
  PASS=$((PASS + 1))
else
  printf "${RED}FAIL${NC}  %-45s  HTTP %s (expected 200 or 201)\n" "POST /api/auth/login (valid email)" "$LOGIN_STATUS"
  FAIL=$((FAIL + 1))
fi

check "POST /api/auth/login (invalid email)" \
  POST "$BASE_URL/api/auth/login" 400 \
  -d '{"email":"not-an-email"}'

check "POST /api/auth/login (missing body)" \
  POST "$BASE_URL/api/auth/login" 400

check "GET /api/auth/me (authenticated)" \
  GET "$BASE_URL/api/auth/me" 200 \
  -H "x-user-email: $TEST_EMAIL"

check "GET /api/auth/me (no auth header)" \
  GET "$BASE_URL/api/auth/me" 401

echo ""

# ── 3. Clients API ──────────────────────────────────────────────────
printf "${BOLD}[Clients API]${NC}\n"
check "GET /api/clients (authenticated)" \
  GET "$BASE_URL/api/clients" 200 \
  -H "x-user-email: $TEST_EMAIL"

check "GET /api/clients (no auth)" \
  GET "$BASE_URL/api/clients" 401

check "POST /api/clients (create)" \
  POST "$BASE_URL/api/clients" 201 \
  -H "x-user-email: $TEST_EMAIL" \
  -d '{"name":"HealthCheck Test Client"}'

# Get the created client ID for further tests
CLIENT_ID=$(curl -s -H "x-user-email: $TEST_EMAIL" \
  "$BASE_URL/api/clients" 2>/dev/null | \
  grep -o '"id":[0-9]*' | tail -1 | cut -d: -f2)

if [ -n "$CLIENT_ID" ]; then
  check "GET /api/clients/:id" \
    GET "$BASE_URL/api/clients/$CLIENT_ID" 200 \
    -H "x-user-email: $TEST_EMAIL"

  check "PUT /api/clients/:id (update)" \
    PUT "$BASE_URL/api/clients/$CLIENT_ID" 200 \
    -H "x-user-email: $TEST_EMAIL" \
    -d '{"name":"HealthCheck Updated Client"}'
else
  printf "${YELLOW}SKIP${NC}  GET /api/clients/:id — could not determine client ID\n"
  printf "${YELLOW}SKIP${NC}  PUT /api/clients/:id — could not determine client ID\n"
fi

check "POST /api/clients (invalid — missing name)" \
  POST "$BASE_URL/api/clients" 400 \
  -H "x-user-email: $TEST_EMAIL" \
  -d '{}'

echo ""

# ── 4. Work Entries API ─────────────────────────────────────────────
printf "${BOLD}[Work Entries API]${NC}\n"
check "GET /api/work-entries (authenticated)" \
  GET "$BASE_URL/api/work-entries" 200 \
  -H "x-user-email: $TEST_EMAIL"

check "GET /api/work-entries (no auth)" \
  GET "$BASE_URL/api/work-entries" 401

if [ -n "$CLIENT_ID" ]; then
  check "POST /api/work-entries (create)" \
    POST "$BASE_URL/api/work-entries" 201 \
    -H "x-user-email: $TEST_EMAIL" \
    -d "{\"clientId\":$CLIENT_ID,\"hours\":2.5,\"description\":\"Healthcheck test entry\",\"date\":\"2025-01-15\"}"

  ENTRY_ID=$(curl -s -H "x-user-email: $TEST_EMAIL" \
    "$BASE_URL/api/work-entries?clientId=$CLIENT_ID" 2>/dev/null | \
    grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

  if [ -n "$ENTRY_ID" ]; then
    check "GET /api/work-entries/:id" \
      GET "$BASE_URL/api/work-entries/$ENTRY_ID" 200 \
      -H "x-user-email: $TEST_EMAIL"

    check "PUT /api/work-entries/:id (update)" \
      PUT "$BASE_URL/api/work-entries/$ENTRY_ID" 200 \
      -H "x-user-email: $TEST_EMAIL" \
      -d '{"hours":3.0}'
  fi
else
  printf "${YELLOW}SKIP${NC}  Work entry CRUD — no client ID available\n"
fi

echo ""

# ── 5. Reports API ──────────────────────────────────────────────────
printf "${BOLD}[Reports API]${NC}\n"
if [ -n "$CLIENT_ID" ]; then
  check "GET /api/reports/client/:id" \
    GET "$BASE_URL/api/reports/client/$CLIENT_ID" 200 \
    -H "x-user-email: $TEST_EMAIL"

  check "GET /api/reports/export/csv/:id" \
    GET "$BASE_URL/api/reports/export/csv/$CLIENT_ID" 200 \
    -H "x-user-email: $TEST_EMAIL"

  check "GET /api/reports/export/pdf/:id" \
    GET "$BASE_URL/api/reports/export/pdf/$CLIENT_ID" 200 \
    -H "x-user-email: $TEST_EMAIL"
else
  printf "${YELLOW}SKIP${NC}  Reports — no client ID available\n"
fi

check "GET /api/reports/client/999999 (not found)" \
  GET "$BASE_URL/api/reports/client/999999" 404 \
  -H "x-user-email: $TEST_EMAIL"

echo ""

# ── 6. Error Handling ───────────────────────────────────────────────
printf "${BOLD}[Error Handling]${NC}\n"
check "GET /nonexistent (404 handler)" \
  GET "$BASE_URL/nonexistent" 404

echo ""

# ── 7. Cleanup ──────────────────────────────────────────────────────
printf "${BOLD}[Cleanup]${NC}\n"
if [ -n "${ENTRY_ID:-}" ]; then
  check "DELETE /api/work-entries/:id" \
    DELETE "$BASE_URL/api/work-entries/$ENTRY_ID" 200 \
    -H "x-user-email: $TEST_EMAIL"
fi

if [ -n "${CLIENT_ID:-}" ]; then
  check "DELETE /api/clients/:id" \
    DELETE "$BASE_URL/api/clients/$CLIENT_ID" 200 \
    -H "x-user-email: $TEST_EMAIL"
fi

echo ""

# ── Summary ─────────────────────────────────────────────────────────
echo "─────────────────────────────────────────────────────────────────"
TOTAL=$((PASS + FAIL))
printf "${BOLD}Results:${NC}  ${GREEN}%d passed${NC}  ${RED}%d failed${NC}  (total: %d)\n" "$PASS" "$FAIL" "$TOTAL"
echo ""

if [ "$FAIL" -gt 0 ]; then
  printf "${RED}${BOLD}HEALTH CHECK FAILED${NC}\n"
  exit 1
else
  printf "${GREEN}${BOLD}ALL CHECKS PASSED${NC}\n"
  exit 0
fi
