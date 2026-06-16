#!/usr/bin/env bash
# Health Check Script for Timesheet App
# Usage: ./scripts/healthcheck.sh [BASE_URL]
# Default: http://localhost:3001
#
# Tests critical endpoints and reports pass/fail for each.
# Endpoint definitions: backend/src/server.js lines 39-48
# Auth mechanism: backend/src/middleware/auth.js

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
PASS=0
FAIL=0
TEST_EMAIL="healthcheck@test.com"

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  NC='\033[0m'
else
  GREEN=''
  RED=''
  NC=''
fi

check_endpoint() {
  local name="$1"
  local method="$2"
  local url="$3"
  local expected_status="$4"
  local data="${5:-}"
  local extra_headers="${6:-}"

  local curl_args=(-s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10)

  if [ "$method" = "POST" ]; then
    curl_args+=(-X POST)
  fi

  if [ -n "$data" ]; then
    curl_args+=(-H "Content-Type: application/json" -d "$data")
  fi

  if [ -n "$extra_headers" ]; then
    # Support multiple headers separated by "|"
    IFS='|' read -ra HDRS <<< "$extra_headers"
    for hdr in "${HDRS[@]}"; do
      curl_args+=(-H "$hdr")
    done
  fi

  local actual_status
  actual_status=$(curl "${curl_args[@]}" "$url" 2>/dev/null) || actual_status="000"

  # Allow comma-separated expected statuses (e.g. "200,201")
  local matched=false
  IFS=',' read -ra EXPECTED <<< "$expected_status"
  for es in "${EXPECTED[@]}"; do
    if [ "$actual_status" = "$es" ]; then
      matched=true
      break
    fi
  done

  if $matched; then
    echo -e "  ${GREEN}PASS${NC}  $name (HTTP $actual_status)"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC}  $name (expected $expected_status, got $actual_status)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Timesheet App Health Check ==="
echo "Target: $BASE_URL"
echo ""

# 1. Health endpoint — GET /health -> 200
#    See backend/src/server.js line 40
check_endpoint "GET /health" \
  GET "$BASE_URL/health" "200"

# 2. Auth login — POST /api/auth/login -> 200 or 201
#    See backend/src/routes/auth.js
check_endpoint "POST /api/auth/login" \
  POST "$BASE_URL/api/auth/login" "200,201" \
  "{\"email\":\"$TEST_EMAIL\"}"

# 3. Auth me — GET /api/auth/me with x-user-email header -> 200
#    See backend/src/middleware/auth.js lines 7-8
check_endpoint "GET /api/auth/me (authenticated)" \
  GET "$BASE_URL/api/auth/me" "200" \
  "" "x-user-email: $TEST_EMAIL"

# 4. Clients list — GET /api/clients with x-user-email header -> 200
#    See backend/src/server.js line 46
check_endpoint "GET /api/clients (authenticated)" \
  GET "$BASE_URL/api/clients" "200" \
  "" "x-user-email: $TEST_EMAIL"

# 5. Work entries list — GET /api/work-entries with x-user-email header -> 200
#    See backend/src/server.js line 47
check_endpoint "GET /api/work-entries (authenticated)" \
  GET "$BASE_URL/api/work-entries" "200" \
  "" "x-user-email: $TEST_EMAIL"

# 6. Invalid route — GET /api/nonexistent -> 404
#    See backend/src/server.js lines 54-56 (catch-all 404 handler)
check_endpoint "GET /api/nonexistent (should 404)" \
  GET "$BASE_URL/api/nonexistent" "404"

# 7. Missing auth — GET /api/clients without header -> 401
#    See backend/src/middleware/auth.js lines 7-8
check_endpoint "GET /api/clients (no auth, should 401)" \
  GET "$BASE_URL/api/clients" "401"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
else
  exit 0
fi
