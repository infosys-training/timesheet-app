#!/usr/bin/env bash
# Health check script for timesheet-app
# Tests all critical backend endpoints
# Usage: ./scripts/healthcheck.sh [BASE_URL]
#   BASE_URL defaults to http://localhost:3001

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="healthcheck@test.com"
PASS=0
FAIL=0
WARN=0

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

check_endpoint() {
  local name="$1"
  local method="$2"
  local url="$3"
  local expected_status="$4"
  local data="${5:-}"
  local extra_headers="${6:-}"

  local curl_args=("-s" "-o" "/dev/null" "-w" "%{http_code}" "--max-time" "10")
  
  if [ -n "$extra_headers" ]; then
    curl_args+=("-H" "$extra_headers")
  fi
  
  if [ "$method" = "POST" ]; then
    curl_args+=("-X" "POST" "-H" "Content-Type: application/json")
    if [ -n "$data" ]; then
      curl_args+=("-d" "$data")
    fi
  fi

  local status
  status=$(curl "${curl_args[@]}" "$url" 2>/dev/null) || status="000"

  if [ "$status" = "$expected_status" ]; then
    echo -e "${GREEN}[PASS]${NC} $name - HTTP $status"
    PASS=$((PASS + 1))
  elif [ "$status" = "000" ]; then
    echo -e "${RED}[FAIL]${NC} $name - Connection refused/timeout"
    FAIL=$((FAIL + 1))
  else
    echo -e "${RED}[FAIL]${NC} $name - Expected HTTP $expected_status, got HTTP $status"
    FAIL=$((FAIL + 1))
  fi
}

echo "============================================"
echo "  Timesheet App Health Check"
echo "  Target: $BASE_URL"
echo "  Time: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "============================================"
echo ""

# 1. Basic health endpoint
echo "--- Core Health ---"
check_endpoint "Health endpoint" "GET" "$BASE_URL/health" "200"
echo ""

# 2. Authentication endpoints
echo "--- Authentication ---"
check_endpoint "Login (POST /api/auth/login)" "POST" "$BASE_URL/api/auth/login" "200" '{"email":"'"$TEST_EMAIL"'"}'
check_endpoint "Get current user (GET /api/auth/me)" "GET" "$BASE_URL/api/auth/me" "200" "" "x-user-email: $TEST_EMAIL"
check_endpoint "Auth rejection (no header)" "GET" "$BASE_URL/api/auth/me" "401"
echo ""

# 3. Client endpoints
echo "--- Clients API ---"
check_endpoint "List clients (GET /api/clients)" "GET" "$BASE_URL/api/clients" "200" "" "x-user-email: $TEST_EMAIL"
check_endpoint "Clients auth required" "GET" "$BASE_URL/api/clients" "401"
echo ""

# 4. Work entries endpoints
echo "--- Work Entries API ---"
check_endpoint "List work entries (GET /api/work-entries)" "GET" "$BASE_URL/api/work-entries" "200" "" "x-user-email: $TEST_EMAIL"
check_endpoint "Work entries auth required" "GET" "$BASE_URL/api/work-entries" "401"
echo ""

# 5. Reports endpoints (will 400 with invalid ID which proves the route is alive)
echo "--- Reports API ---"
check_endpoint "Reports route reachable (invalid ID)" "GET" "$BASE_URL/api/reports/client/0" "404" "" "x-user-email: $TEST_EMAIL"
check_endpoint "Reports auth required" "GET" "$BASE_URL/api/reports/client/1" "401"
echo ""

# 6. Error handling
echo "--- Error Handling ---"
check_endpoint "404 handler (unknown route)" "GET" "$BASE_URL/api/nonexistent" "404"
check_endpoint "Invalid email format" "GET" "$BASE_URL/api/clients" "400" "" "x-user-email: not-an-email"
echo ""

# 7. Response time check
echo "--- Performance ---"
RESPONSE_TIME=$(curl -s -o /dev/null -w "%{time_total}" --max-time 10 "$BASE_URL/health" 2>/dev/null) || RESPONSE_TIME="timeout"
if [ "$RESPONSE_TIME" != "timeout" ]; then
  RT_MS=$(echo "$RESPONSE_TIME * 1000" | bc 2>/dev/null || echo "N/A")
  if [ "$RT_MS" != "N/A" ] && [ "$(echo "$RESPONSE_TIME < 1.0" | bc)" -eq 1 ]; then
    echo -e "${GREEN}[PASS]${NC} Health endpoint response time: ${RT_MS}ms"
    PASS=$((PASS + 1))
  elif [ "$RT_MS" != "N/A" ]; then
    echo -e "${YELLOW}[WARN]${NC} Health endpoint response time: ${RT_MS}ms (>1000ms)"
    WARN=$((WARN + 1))
  fi
else
  echo -e "${RED}[FAIL]${NC} Health endpoint timed out"
  FAIL=$((FAIL + 1))
fi
echo ""

# Summary
echo "============================================"
echo -e "  Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}, ${YELLOW}$WARN warnings${NC}"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}HEALTH CHECK FAILED${NC}"
  exit 1
else
  echo -e "${GREEN}HEALTH CHECK PASSED${NC}"
  exit 0
fi
