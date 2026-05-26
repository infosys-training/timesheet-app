#!/usr/bin/env bash
#
# Health Check Script for Client Timesheet Application
#
# Verifies all critical endpoints are responding correctly.
# See RUNBOOK.md for detailed troubleshooting when a check fails.
#
# Usage:
#   ./scripts/health-check.sh [BASE_URL] [--json]
#
# Examples:
#   ./scripts/health-check.sh                          # defaults to http://localhost:3001
#   ./scripts/health-check.sh http://prod-server:3001  # custom URL
#   ./scripts/health-check.sh --json                   # JSON output
#   ./scripts/health-check.sh http://prod:3001 --json  # both
#

set -euo pipefail

# --- Configuration ---
DEFAULT_BASE_URL="http://localhost:3001"
CONNECT_TIMEOUT=5
MAX_TIMEOUT=10
TEST_EMAIL="healthcheck@test.com"

# --- Argument Parsing ---
BASE_URL="$DEFAULT_BASE_URL"
JSON_OUTPUT=false

for arg in "$@"; do
  case "$arg" in
    --json)
      JSON_OUTPUT=true
      ;;
    http://*|https://*)
      BASE_URL="$arg"
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: $0 [BASE_URL] [--json]"
      exit 1
      ;;
  esac
done

# Remove trailing slash from BASE_URL
BASE_URL="${BASE_URL%/}"

# --- Color Codes ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# --- State ---
TOTAL=0
PASSED=0
FAILED=0
declare -a RESULTS=()

# --- Helper Functions ---

# Run a single health check
# Arguments: $1=name, $2=method, $3=url, $4=expected_http_code, $5=extra_curl_args (optional)
run_check() {
  local name="$1"
  local method="$2"
  local url="$3"
  local expected_code="$4"
  shift 4
  local extra_args=("$@")

  TOTAL=$((TOTAL + 1))

  local http_code
  local body
  local response

  response=$(curl -s -w "\n%{http_code}" \
    --connect-timeout "$CONNECT_TIMEOUT" \
    --max-time "$MAX_TIMEOUT" \
    -X "$method" \
    "${extra_args[@]}" \
    "$url" 2>&1) || true

  # Extract HTTP code (last line) and body (everything else)
  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')

  local status="FAIL"
  local detail=""

  if [[ "$http_code" =~ ^[0-9]+$ ]] && [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
    status="PASS"
    PASSED=$((PASSED + 1))
  else
    status="FAIL"
    FAILED=$((FAILED + 1))
    detail="Expected 2xx, got $http_code"
  fi

  # Special check for /health endpoint: verify JSON body contains "status":"OK"
  if [ "$name" = "Health Endpoint" ] && [ "$status" = "PASS" ]; then
    if ! echo "$body" | grep -q '"status"'; then
      status="FAIL"
      PASSED=$((PASSED - 1))
      FAILED=$((FAILED + 1))
      detail="Response missing 'status' field"
    fi
  fi

  # Store result for JSON output
  RESULTS+=("{\"name\":\"$name\",\"url\":\"$url\",\"method\":\"$method\",\"expected_code\":\"$expected_code\",\"actual_code\":\"$http_code\",\"status\":\"$status\",\"detail\":\"$detail\"}")

  # Print colored output (unless JSON mode)
  if [ "$JSON_OUTPUT" = false ]; then
    if [ "$status" = "PASS" ]; then
      echo -e "  ${GREEN}[PASS]${NC} $name (HTTP $http_code)"
    else
      echo -e "  ${RED}[FAIL]${NC} $name — $detail"
      echo -e "        ${YELLOW}See RUNBOOK.md for troubleshooting${NC}"
    fi
  fi
}

# --- Main ---

if [ "$JSON_OUTPUT" = false ]; then
  echo ""
  echo "============================================"
  echo "  Timesheet App Health Check"
  echo "  Target: $BASE_URL"
  echo "============================================"
  echo ""
fi

# Check 1: Health endpoint
run_check "Health Endpoint" "GET" "$BASE_URL/health" "200"

# Check 2: Auth login
run_check "Auth Login" "POST" "$BASE_URL/api/auth/login" "200" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\"}"

# Check 3: Auth me
run_check "Auth Me" "GET" "$BASE_URL/api/auth/me" "200" \
  -H "x-user-email: $TEST_EMAIL"

# Check 4: Clients list
run_check "Clients List" "GET" "$BASE_URL/api/clients" "200" \
  -H "x-user-email: $TEST_EMAIL"

# Check 5: Work entries list
run_check "Work Entries List" "GET" "$BASE_URL/api/work-entries" "200" \
  -H "x-user-email: $TEST_EMAIL"

# Check 6: Frontend (if FRONTEND_URL is set)
if [ -n "${FRONTEND_URL:-}" ]; then
  run_check "Frontend" "GET" "$FRONTEND_URL" "200"
fi

# --- Output Results ---

if [ "$JSON_OUTPUT" = true ]; then
  # Build JSON array
  echo "{"
  echo "  \"target\": \"$BASE_URL\","
  echo "  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"total\": $TOTAL,"
  echo "  \"passed\": $PASSED,"
  echo "  \"failed\": $FAILED,"
  echo "  \"checks\": ["
  for i in "${!RESULTS[@]}"; do
    if [ $i -lt $((${#RESULTS[@]} - 1)) ]; then
      echo "    ${RESULTS[$i]},"
    else
      echo "    ${RESULTS[$i]}"
    fi
  done
  echo "  ]"
  echo "}"
else
  echo ""
  echo "--------------------------------------------"
  echo "  Results: $PASSED/$TOTAL passed, $FAILED failed"
  echo "--------------------------------------------"
  echo ""
fi

# Exit with appropriate code
if [ "$FAILED" -gt 0 ]; then
  exit 1
else
  exit 0
fi
