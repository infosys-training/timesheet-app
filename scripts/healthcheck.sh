#!/usr/bin/env bash
#
# Health Check Script for Timesheet App
#
# Tests all critical backend endpoints and reports status.
# Exits with code 0 if all checks pass, 1 if any fail.
#
# Usage:
#   ./scripts/healthcheck.sh                    # Default: http://localhost:3001
#   ./scripts/healthcheck.sh http://myserver:3001
#   BASE_URL=http://myserver:3001 ./scripts/healthcheck.sh
#
# Environment variables:
#   BASE_URL          Base URL of the backend API (default: http://localhost:3001)
#   TEST_USER_EMAIL   Email used for authenticated requests (default: healthcheck@timesheet-app.local)
#   TIMEOUT           Request timeout in seconds (default: 5)
#   VERBOSE           Set to "true" for detailed output

set -euo pipefail

BASE_URL="${1:-${BASE_URL:-http://localhost:3001}}"
TEST_USER_EMAIL="${TEST_USER_EMAIL:-healthcheck@timesheet-app.com}"
TIMEOUT="${TIMEOUT:-5}"
VERBOSE="${VERBOSE:-false}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0
RESULTS=()

log_verbose() {
  if [ "$VERBOSE" = "true" ]; then
    echo -e "  ${YELLOW}[DEBUG]${NC} $1"
  fi
}

check_endpoint() {
  local name="$1"
  local method="$2"
  local url="$3"
  local expected_status="$4"
  local data="${5:-}"
  local extra_headers="${6:-}"

  local curl_args=(
    -s
    -o /tmp/healthcheck_response.json
    -w "%{http_code}"
    --max-time "$TIMEOUT"
    -X "$method"
  )

  # Add content type for POST/PUT
  if [ "$method" = "POST" ] || [ "$method" = "PUT" ]; then
    curl_args+=(-H "Content-Type: application/json")
  fi

  # Add auth header if provided
  if [ -n "$extra_headers" ]; then
    curl_args+=(-H "$extra_headers")
  fi

  # Add request body if provided
  if [ -n "$data" ]; then
    curl_args+=(-d "$data")
  fi

  curl_args+=("$url")

  local http_code
  http_code=$(curl "${curl_args[@]}" 2>/dev/null) || http_code="000"

  local response_body
  response_body=$(cat /tmp/healthcheck_response.json 2>/dev/null || echo "")

  # Support comma-separated expected status codes (e.g., "200,201")
  local status_match=false
  IFS=',' read -ra expected_codes <<< "$expected_status"
  for code in "${expected_codes[@]}"; do
    if [ "$http_code" = "$code" ]; then
      status_match=true
      break
    fi
  done

  if [ "$status_match" = true ]; then
    echo -e "  ${GREEN}PASS${NC}  $name (HTTP $http_code)"
    log_verbose "Response: $response_body"
    PASS_COUNT=$((PASS_COUNT + 1))
    RESULTS+=("PASS|$name|$http_code")
    return 0
  elif [ "$http_code" = "000" ]; then
    echo -e "  ${RED}FAIL${NC}  $name (connection refused or timeout)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    RESULTS+=("FAIL|$name|connection_error")
    return 1
  else
    echo -e "  ${RED}FAIL${NC}  $name (expected HTTP $expected_status, got $http_code)"
    log_verbose "Response: $response_body"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    RESULTS+=("FAIL|$name|$http_code")
    return 1
  fi
}

echo ""
echo "============================================"
echo "  Timesheet App Health Check"
echo "============================================"
echo "  Target:     $BASE_URL"
echo "  Test user:  $TEST_USER_EMAIL"
echo "  Timeout:    ${TIMEOUT}s"
echo "  Time:       $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "============================================"
echo ""

# --------------------------------------------------
# 1. Basic connectivity and health endpoint
# --------------------------------------------------
echo "--- Core Health ---"

check_endpoint \
  "GET /health" \
  "GET" \
  "$BASE_URL/health" \
  "200" || true

# --------------------------------------------------
# 2. Authentication endpoints
# --------------------------------------------------
echo ""
echo "--- Authentication ---"

check_endpoint \
  "POST /api/auth/login (create or login)" \
  "POST" \
  "$BASE_URL/api/auth/login" \
  "200,201" \
  "{\"email\":\"$TEST_USER_EMAIL\"}" || true

# Second login should return 200 (user already exists)
check_endpoint \
  "POST /api/auth/login (existing user)" \
  "POST" \
  "$BASE_URL/api/auth/login" \
  "200" \
  "{\"email\":\"$TEST_USER_EMAIL\"}" || true

check_endpoint \
  "POST /api/auth/login (invalid email - should reject)" \
  "POST" \
  "$BASE_URL/api/auth/login" \
  "400" \
  "{\"email\":\"not-an-email\"}" || true

check_endpoint \
  "GET /api/auth/me (authenticated)" \
  "GET" \
  "$BASE_URL/api/auth/me" \
  "200" \
  "" \
  "x-user-email: $TEST_USER_EMAIL" || true

check_endpoint \
  "GET /api/auth/me (no auth header - should reject)" \
  "GET" \
  "$BASE_URL/api/auth/me" \
  "401" || true

# --------------------------------------------------
# 3. Client endpoints
# --------------------------------------------------
echo ""
echo "--- Clients API ---"

check_endpoint \
  "GET /api/clients (list)" \
  "GET" \
  "$BASE_URL/api/clients" \
  "200" \
  "" \
  "x-user-email: $TEST_USER_EMAIL" || true

check_endpoint \
  "POST /api/clients (create)" \
  "POST" \
  "$BASE_URL/api/clients" \
  "201" \
  "{\"name\":\"HealthCheck Test Client\",\"description\":\"Created by health check script\"}" \
  "x-user-email: $TEST_USER_EMAIL" || true

# Extract the created client ID for subsequent tests
CLIENT_ID=$(cat /tmp/healthcheck_response.json 2>/dev/null | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2 || echo "")
log_verbose "Created client ID: $CLIENT_ID"

if [ -n "$CLIENT_ID" ]; then
  check_endpoint \
    "GET /api/clients/:id (read)" \
    "GET" \
    "$BASE_URL/api/clients/$CLIENT_ID" \
    "200" \
    "" \
    "x-user-email: $TEST_USER_EMAIL" || true

  check_endpoint \
    "PUT /api/clients/:id (update)" \
    "PUT" \
    "$BASE_URL/api/clients/$CLIENT_ID" \
    "200" \
    "{\"name\":\"HealthCheck Updated Client\"}" \
    "x-user-email: $TEST_USER_EMAIL" || true
fi

check_endpoint \
  "GET /api/clients (unauthenticated - should reject)" \
  "GET" \
  "$BASE_URL/api/clients" \
  "401" || true

# --------------------------------------------------
# 4. Work entries endpoints
# --------------------------------------------------
echo ""
echo "--- Work Entries API ---"

check_endpoint \
  "GET /api/work-entries (list)" \
  "GET" \
  "$BASE_URL/api/work-entries" \
  "200" \
  "" \
  "x-user-email: $TEST_USER_EMAIL" || true

if [ -n "$CLIENT_ID" ]; then
  check_endpoint \
    "POST /api/work-entries (create)" \
    "POST" \
    "$BASE_URL/api/work-entries" \
    "201" \
    "{\"clientId\":$CLIENT_ID,\"hours\":1.5,\"description\":\"Health check test entry\",\"date\":\"$(date -u '+%Y-%m-%d')\"}" \
    "x-user-email: $TEST_USER_EMAIL" || true

  ENTRY_ID=$(cat /tmp/healthcheck_response.json 2>/dev/null | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2 || echo "")
  log_verbose "Created work entry ID: $ENTRY_ID"
fi

check_endpoint \
  "GET /api/work-entries (unauthenticated - should reject)" \
  "GET" \
  "$BASE_URL/api/work-entries" \
  "401" || true

# --------------------------------------------------
# 5. Reports endpoints
# --------------------------------------------------
echo ""
echo "--- Reports API ---"

if [ -n "$CLIENT_ID" ]; then
  check_endpoint \
    "GET /api/reports/client/:id (JSON report)" \
    "GET" \
    "$BASE_URL/api/reports/client/$CLIENT_ID" \
    "200" \
    "" \
    "x-user-email: $TEST_USER_EMAIL" || true

  check_endpoint \
    "GET /api/reports/export/csv/:id (CSV export)" \
    "GET" \
    "$BASE_URL/api/reports/export/csv/$CLIENT_ID" \
    "200" \
    "" \
    "x-user-email: $TEST_USER_EMAIL" || true

  check_endpoint \
    "GET /api/reports/export/pdf/:id (PDF export)" \
    "GET" \
    "$BASE_URL/api/reports/export/pdf/$CLIENT_ID" \
    "200" \
    "" \
    "x-user-email: $TEST_USER_EMAIL" || true
fi

# --------------------------------------------------
# 6. Error handling
# --------------------------------------------------
echo ""
echo "--- Error Handling ---"

check_endpoint \
  "GET /nonexistent (404 handler)" \
  "GET" \
  "$BASE_URL/nonexistent" \
  "404" || true

check_endpoint \
  "POST /api/work-entries (validation - missing fields)" \
  "POST" \
  "$BASE_URL/api/work-entries" \
  "400" \
  "{}" \
  "x-user-email: $TEST_USER_EMAIL" || true

# --------------------------------------------------
# 7. Cleanup test data
# --------------------------------------------------
echo ""
echo "--- Cleanup ---"

if [ -n "${ENTRY_ID:-}" ]; then
  check_endpoint \
    "DELETE /api/work-entries/:id (cleanup)" \
    "DELETE" \
    "$BASE_URL/api/work-entries/$ENTRY_ID" \
    "200" \
    "" \
    "x-user-email: $TEST_USER_EMAIL" || true
fi

if [ -n "${CLIENT_ID:-}" ]; then
  check_endpoint \
    "DELETE /api/clients/:id (cleanup)" \
    "DELETE" \
    "$BASE_URL/api/clients/$CLIENT_ID" \
    "200" \
    "" \
    "x-user-email: $TEST_USER_EMAIL" || true
fi

# Clean up temp file
rm -f /tmp/healthcheck_response.json

# --------------------------------------------------
# Summary
# --------------------------------------------------
echo ""
echo "============================================"
echo "  Results"
echo "============================================"
TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo "  Total:   $TOTAL"
echo -e "  Passed:  ${GREEN}$PASS_COUNT${NC}"
echo -e "  Failed:  ${RED}$FAIL_COUNT${NC}"
echo "============================================"

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo ""
  echo "Failed checks:"
  for result in "${RESULTS[@]}"; do
    status=$(echo "$result" | cut -d'|' -f1)
    if [ "$status" = "FAIL" ]; then
      name=$(echo "$result" | cut -d'|' -f2)
      code=$(echo "$result" | cut -d'|' -f3)
      echo -e "  ${RED}FAIL${NC}  $name ($code)"
    fi
  done
  echo ""
  echo "Refer to RUNBOOK.md for troubleshooting procedures."
  exit 1
else
  echo ""
  echo -e "${GREEN}All health checks passed.${NC}"
  exit 0
fi
