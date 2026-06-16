#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# healthcheck.sh — Smoke-test all critical timesheet-app endpoints
#
# Usage:
#   ./scripts/healthcheck.sh                  # defaults to http://localhost:3001
#   ./scripts/healthcheck.sh https://app.example.com
#   BASE_URL=http://10.0.0.5:3001 ./scripts/healthcheck.sh
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed
# ---------------------------------------------------------------------------

set -euo pipefail

BASE_URL="${1:-${BASE_URL:-http://localhost:3001}}"
TEST_EMAIL="healthcheck-bot@timesheet-app.example.com"

PASS=0
FAIL=0
TOTAL=0

# Colors (disabled when stdout is not a terminal)
if [ -t 1 ]; then
  GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; NC='\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; NC=''
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
check() {
  local description="$1"
  local method="$2"
  local url="$3"
  shift 3
  local expected_status="${1:-200}"
  shift || true
  # Check if next arg is also a numeric status code (alt acceptable status)
  local alt_status=""
  if [[ "${1:-}" =~ ^[0-9]{3}$ ]]; then
    alt_status="$1"
    shift || true
  fi

  TOTAL=$((TOTAL + 1))

  local http_code body
  body=$(mktemp)

  http_code=$(curl -s -o "$body" -w "%{http_code}" \
    -X "$method" \
    -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    --max-time 10 \
    "$@" \
    "$url" 2>/dev/null) || http_code="000"

  if [ "$http_code" = "$expected_status" ] || [ "$http_code" = "$alt_status" ]; then
    printf "${GREEN}  PASS${NC}  [%s] %s (HTTP %s)\n" "$method" "$description" "$http_code"
    PASS=$((PASS + 1))
  else
    printf "${RED}  FAIL${NC}  [%s] %s — expected %s, got %s\n" "$method" "$description" "$expected_status" "$http_code"
    # Print response body on failure for debugging (truncated)
    if [ -s "$body" ]; then
      printf "${YELLOW}        Response: %.200s${NC}\n" "$(cat "$body")"
    fi
    FAIL=$((FAIL + 1))
  fi

  rm -f "$body"
}

# Like check() but does NOT send x-user-email header
check_no_auth() {
  local description="$1"
  local method="$2"
  local url="$3"
  local expected_status="${4:-200}"

  TOTAL=$((TOTAL + 1))

  local http_code body
  body=$(mktemp)

  http_code=$(curl -s -o "$body" -w "%{http_code}" \
    -X "$method" \
    -H "Content-Type: application/json" \
    --max-time 10 \
    "$url" 2>/dev/null) || http_code="000"

  if [ "$http_code" = "$expected_status" ]; then
    printf "${GREEN}  PASS${NC}  [%s] %s (HTTP %s)\n" "$method" "$description" "$http_code"
    PASS=$((PASS + 1))
  else
    printf "${RED}  FAIL${NC}  [%s] %s — expected %s, got %s\n" "$method" "$description" "$expected_status" "$http_code"
    if [ -s "$body" ]; then
      printf "${YELLOW}        Response: %.200s${NC}\n" "$(cat "$body")"
    fi
    FAIL=$((FAIL + 1))
  fi

  rm -f "$body"
}

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------
echo ""
echo "=== Timesheet App Health Check ==="
echo "    Target: ${BASE_URL}"
echo "    Time:   $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
echo ""

# --- 1. Basic health endpoint ---
echo "--- Core Health ---"
check "Health endpoint" GET "${BASE_URL}/health" 200

# --- 2. Authentication ---
echo ""
echo "--- Authentication ---"
check "Login (create/retrieve user)" POST "${BASE_URL}/api/auth/login" 200 201 \
  -d "{\"email\":\"${TEST_EMAIL}\"}"
# Accept both 200 (existing) and 201 (new user)

check "Get current user" GET "${BASE_URL}/api/auth/me" 200

# --- 3. Client CRUD ---
echo ""
echo "--- Client CRUD ---"

# Create a test client
CLIENT_RESPONSE=$(curl -sf \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-user-email: ${TEST_EMAIL}" \
  --max-time 10 \
  -d '{"name":"HealthCheck Test Client","description":"Auto-created by healthcheck script"}' \
  "${BASE_URL}/api/clients" 2>/dev/null) || CLIENT_RESPONSE=""

CLIENT_ID=""
if [ -n "$CLIENT_RESPONSE" ]; then
  CLIENT_ID=$(echo "$CLIENT_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
fi

if [ -n "$CLIENT_ID" ]; then
  printf "${GREEN}  PASS${NC}  [POST] Create test client (id=%s)\n" "$CLIENT_ID"
  PASS=$((PASS + 1))
else
  printf "${RED}  FAIL${NC}  [POST] Create test client — no ID returned\n"
  FAIL=$((FAIL + 1))
fi
TOTAL=$((TOTAL + 1))

check "List clients" GET "${BASE_URL}/api/clients" 200

if [ -n "$CLIENT_ID" ]; then
  check "Get client by ID" GET "${BASE_URL}/api/clients/${CLIENT_ID}" 200

  check "Update client" PUT "${BASE_URL}/api/clients/${CLIENT_ID}" 200 \
    -d '{"name":"HealthCheck Test Client (updated)"}'
fi

# --- 4. Work Entry CRUD ---
echo ""
echo "--- Work Entry CRUD ---"

ENTRY_RESPONSE=""
ENTRY_ID=""

if [ -n "$CLIENT_ID" ]; then
  ENTRY_RESPONSE=$(curl -sf \
    -X POST \
    -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    --max-time 10 \
    -d "{\"clientId\":${CLIENT_ID},\"hours\":1.5,\"description\":\"Healthcheck test entry\",\"date\":\"$(date -u +%Y-%m-%d)\"}" \
    "${BASE_URL}/api/work-entries" 2>/dev/null) || ENTRY_RESPONSE=""

  ENTRY_ID=$(echo "$ENTRY_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

  if [ -n "$ENTRY_ID" ]; then
    printf "${GREEN}  PASS${NC}  [POST] Create work entry (id=%s)\n" "$ENTRY_ID"
    PASS=$((PASS + 1))
  else
    printf "${RED}  FAIL${NC}  [POST] Create work entry — no ID returned\n"
    FAIL=$((FAIL + 1))
  fi
  TOTAL=$((TOTAL + 1))
fi

check "List work entries" GET "${BASE_URL}/api/work-entries" 200

if [ -n "$ENTRY_ID" ]; then
  check "Get work entry by ID" GET "${BASE_URL}/api/work-entries/${ENTRY_ID}" 200

  check "Update work entry" PUT "${BASE_URL}/api/work-entries/${ENTRY_ID}" 200 \
    -d '{"hours":2.0}'
fi

# --- 5. Reports ---
echo ""
echo "--- Reports ---"

if [ -n "$CLIENT_ID" ]; then
  check "Client report" GET "${BASE_URL}/api/reports/client/${CLIENT_ID}" 200
  check "Export CSV" GET "${BASE_URL}/api/reports/export/csv/${CLIENT_ID}" 200
  check "Export PDF" GET "${BASE_URL}/api/reports/export/pdf/${CLIENT_ID}" 200
fi

# --- 6. Error handling ---
echo ""
echo "--- Error Handling ---"
check "404 on unknown route" GET "${BASE_URL}/api/nonexistent" 404
check_no_auth "401 without auth header" GET "${BASE_URL}/api/clients" 401

# --- 7. Cleanup test data ---
echo ""
echo "--- Cleanup ---"

if [ -n "$ENTRY_ID" ]; then
  check "Delete work entry" DELETE "${BASE_URL}/api/work-entries/${ENTRY_ID}" 200
fi

if [ -n "$CLIENT_ID" ]; then
  check "Delete test client" DELETE "${BASE_URL}/api/clients/${CLIENT_ID}" 200
fi

# --- Summary ---
echo ""
echo "==========================================="
printf "  Results: ${GREEN}%d passed${NC}, ${RED}%d failed${NC}, %d total\n" "$PASS" "$FAIL" "$TOTAL"
echo "==========================================="
echo ""

if [ "$FAIL" -gt 0 ]; then
  printf "${RED}HEALTH CHECK FAILED${NC} — see failures above.\n"
  echo "Refer to RUNBOOK.md for diagnosis and resolution steps."
  exit 1
else
  printf "${GREEN}ALL CHECKS PASSED${NC}\n"
  exit 0
fi
