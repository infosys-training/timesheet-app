#!/usr/bin/env bash
#
# Health Check Script for Employee Time Tracking Application
#
# Tests all critical backend API endpoints and the frontend.
# Exit code 0 = all checks passed, 1 = one or more failed.
#
# Usage:
#   ./scripts/healthcheck.sh
#   BACKEND_URL=http://localhost:3001 FRONTEND_URL=http://localhost:5173 ./scripts/healthcheck.sh
#   TIMEOUT=5 ./scripts/healthcheck.sh          # custom per-request timeout (seconds)
#   SKIP_FRONTEND=1 ./scripts/healthcheck.sh    # skip frontend check
#

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BACKEND_URL="${BACKEND_URL:-http://localhost:3001}"
FRONTEND_URL="${FRONTEND_URL:-http://localhost:5173}"
TIMEOUT="${TIMEOUT:-10}"
SKIP_FRONTEND="${SKIP_FRONTEND:-0}"
TEST_EMAIL="healthcheck-$(date +%s)@test.example.com"

PASS=0
FAIL=0
WARNINGS=0
CLEANUP_CLIENT_ID=""
CLEANUP_ENTRY_ID=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_pass() {
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${NC}  $1"
}

log_fail() {
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${NC}  $1"
  if [[ -n "${2:-}" ]]; then
    echo -e "        ${RED}-> $2${NC}"
  fi
}

log_warn() {
  WARNINGS=$((WARNINGS + 1))
  echo -e "  ${YELLOW}WARN${NC}  $1"
}

log_info() {
  echo -e "  ${BLUE}INFO${NC}  $1"
}

section() {
  echo ""
  echo -e "${BLUE}=== $1 ===${NC}"
}

# Make an HTTP request and capture status code + body.
# Usage: http_request METHOD URL [DATA]
# Sets: HTTP_STATUS, HTTP_BODY, HTTP_TIME
http_request() {
  local method="$1"
  local url="$2"
  local data="${3:-}"

  local tmp
  tmp=$(mktemp)

  local curl_args=(
    -s -w "\n%{http_code}\n%{time_total}"
    --max-time "$TIMEOUT"
    -X "$method"
    -H "Content-Type: application/json"
    -H "x-user-email: $TEST_EMAIL"
  )

  if [[ -n "$data" ]]; then
    curl_args+=(-d "$data")
  fi

  if curl "${curl_args[@]}" "$url" > "$tmp" 2>/dev/null; then
    HTTP_BODY=$(sed -n '1,/^[0-9]\{3\}$/{ /^[0-9]\{3\}$/!p; }' "$tmp")
    HTTP_STATUS=$(tail -2 "$tmp" | head -1)
    HTTP_TIME=$(tail -1 "$tmp")
  else
    HTTP_BODY=""
    HTTP_STATUS="000"
    HTTP_TIME="0"
  fi

  rm -f "$tmp"
}

# Check response time against a threshold (seconds).
check_response_time() {
  local label="$1"
  local threshold="${2:-2.0}"

  if command -v bc &>/dev/null; then
    if (( $(echo "$HTTP_TIME > $threshold" | bc -l) )); then
      log_warn "$label responded in ${HTTP_TIME}s (threshold: ${threshold}s)"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
cleanup() {
  if [[ -n "$CLEANUP_ENTRY_ID" ]]; then
    curl -s --max-time 5 -X DELETE \
      -H "x-user-email: $TEST_EMAIL" \
      "${BACKEND_URL}/api/work-entries/${CLEANUP_ENTRY_ID}" > /dev/null 2>&1 || true
  fi
  if [[ -n "$CLEANUP_CLIENT_ID" ]]; then
    curl -s --max-time 5 -X DELETE \
      -H "x-user-email: $TEST_EMAIL" \
      "${BACKEND_URL}/api/clients/${CLEANUP_CLIENT_ID}" > /dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

echo ""
echo "========================================"
echo " Timesheet App Health Check"
echo " $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "========================================"
echo " Backend:  $BACKEND_URL"
echo " Frontend: $FRONTEND_URL"
echo "========================================"

# ---- 1. Health Endpoint ----
section "1. Health Endpoint"

http_request GET "${BACKEND_URL}/health"
if [[ "$HTTP_STATUS" == "200" ]]; then
  log_pass "GET /health -> 200"
  check_response_time "/health" 1.0
else
  log_fail "GET /health -> $HTTP_STATUS (expected 200)" "$HTTP_BODY"
fi

# ---- 2. Authentication ----
section "2. Authentication"

http_request POST "${BACKEND_URL}/api/auth/login" "{\"email\": \"$TEST_EMAIL\"}"
if [[ "$HTTP_STATUS" == "200" || "$HTTP_STATUS" == "201" ]]; then
  log_pass "POST /api/auth/login -> $HTTP_STATUS"
  check_response_time "/api/auth/login" 2.0
else
  log_fail "POST /api/auth/login -> $HTTP_STATUS (expected 200 or 201)" "$HTTP_BODY"
fi

http_request GET "${BACKEND_URL}/api/auth/me"
if [[ "$HTTP_STATUS" == "200" ]]; then
  log_pass "GET /api/auth/me -> 200"
else
  log_fail "GET /api/auth/me -> $HTTP_STATUS (expected 200)" "$HTTP_BODY"
fi

# Auth with missing email header
local_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
  -X GET "${BACKEND_URL}/api/auth/me" 2>/dev/null || echo "000")
if [[ "$local_status" == "401" ]]; then
  log_pass "GET /api/auth/me (no email header) -> 401"
else
  log_fail "GET /api/auth/me (no email header) -> $local_status (expected 401)"
fi

# ---- 3. Client CRUD ----
section "3. Client CRUD"

# Create
http_request POST "${BACKEND_URL}/api/clients" '{"name": "HealthCheck Test Client", "description": "Auto-created by healthcheck script"}'
if [[ "$HTTP_STATUS" == "201" ]]; then
  log_pass "POST /api/clients -> 201 (create)"
  CLEANUP_CLIENT_ID=$(echo "$HTTP_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2 || true)
  if [[ -z "$CLEANUP_CLIENT_ID" ]]; then
    log_warn "Could not parse client ID from response"
  fi
else
  log_fail "POST /api/clients -> $HTTP_STATUS (expected 201)" "$HTTP_BODY"
fi

# List
http_request GET "${BACKEND_URL}/api/clients"
if [[ "$HTTP_STATUS" == "200" ]]; then
  log_pass "GET /api/clients -> 200 (list)"
else
  log_fail "GET /api/clients -> $HTTP_STATUS (expected 200)" "$HTTP_BODY"
fi

# Get by ID
if [[ -n "$CLEANUP_CLIENT_ID" ]]; then
  http_request GET "${BACKEND_URL}/api/clients/${CLEANUP_CLIENT_ID}"
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "GET /api/clients/$CLEANUP_CLIENT_ID -> 200 (get by ID)"
  else
    log_fail "GET /api/clients/$CLEANUP_CLIENT_ID -> $HTTP_STATUS (expected 200)" "$HTTP_BODY"
  fi

  # Update
  http_request PUT "${BACKEND_URL}/api/clients/${CLEANUP_CLIENT_ID}" '{"name": "HealthCheck Updated Client"}'
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "PUT /api/clients/$CLEANUP_CLIENT_ID -> 200 (update)"
  else
    log_fail "PUT /api/clients/$CLEANUP_CLIENT_ID -> $HTTP_STATUS (expected 200)" "$HTTP_BODY"
  fi
fi

# Validation check (missing required fields)
http_request POST "${BACKEND_URL}/api/clients" '{}'
if [[ "$HTTP_STATUS" == "400" ]]; then
  log_pass "POST /api/clients (invalid) -> 400 (validation)"
else
  log_fail "POST /api/clients (invalid) -> $HTTP_STATUS (expected 400)" "$HTTP_BODY"
fi

# ---- 4. Work Entry CRUD ----
section "4. Work Entry CRUD"

if [[ -n "$CLEANUP_CLIENT_ID" ]]; then
  TODAY=$(date -u '+%Y-%m-%d')

  # Create
  http_request POST "${BACKEND_URL}/api/work-entries" \
    "{\"clientId\": $CLEANUP_CLIENT_ID, \"hours\": 2.5, \"description\": \"Healthcheck test entry\", \"date\": \"$TODAY\"}"
  if [[ "$HTTP_STATUS" == "201" ]]; then
    log_pass "POST /api/work-entries -> 201 (create)"
    CLEANUP_ENTRY_ID=$(echo "$HTTP_BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2 || true)
  else
    log_fail "POST /api/work-entries -> $HTTP_STATUS (expected 201)" "$HTTP_BODY"
  fi

  # List
  http_request GET "${BACKEND_URL}/api/work-entries"
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "GET /api/work-entries -> 200 (list)"
  else
    log_fail "GET /api/work-entries -> $HTTP_STATUS (expected 200)" "$HTTP_BODY"
  fi

  # List with clientId filter
  http_request GET "${BACKEND_URL}/api/work-entries?clientId=${CLEANUP_CLIENT_ID}"
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "GET /api/work-entries?clientId=$CLEANUP_CLIENT_ID -> 200 (filtered list)"
  else
    log_fail "GET /api/work-entries?clientId=$CLEANUP_CLIENT_ID -> $HTTP_STATUS (expected 200)" "$HTTP_BODY"
  fi

  # Get by ID
  if [[ -n "$CLEANUP_ENTRY_ID" ]]; then
    http_request GET "${BACKEND_URL}/api/work-entries/${CLEANUP_ENTRY_ID}"
    if [[ "$HTTP_STATUS" == "200" ]]; then
      log_pass "GET /api/work-entries/$CLEANUP_ENTRY_ID -> 200 (get by ID)"
    else
      log_fail "GET /api/work-entries/$CLEANUP_ENTRY_ID -> $HTTP_STATUS (expected 200)" "$HTTP_BODY"
    fi

    # Update
    http_request PUT "${BACKEND_URL}/api/work-entries/${CLEANUP_ENTRY_ID}" '{"hours": 3.0}'
    if [[ "$HTTP_STATUS" == "200" ]]; then
      log_pass "PUT /api/work-entries/$CLEANUP_ENTRY_ID -> 200 (update)"
    else
      log_fail "PUT /api/work-entries/$CLEANUP_ENTRY_ID -> $HTTP_STATUS (expected 200)" "$HTTP_BODY"
    fi
  fi

  # Validation check
  http_request POST "${BACKEND_URL}/api/work-entries" '{}'
  if [[ "$HTTP_STATUS" == "400" ]]; then
    log_pass "POST /api/work-entries (invalid) -> 400 (validation)"
  else
    log_fail "POST /api/work-entries (invalid) -> $HTTP_STATUS (expected 400)" "$HTTP_BODY"
  fi
else
  log_warn "Skipping work entry tests (client creation failed)"
fi

# ---- 5. Reports & Exports ----
section "5. Reports & Exports"

if [[ -n "$CLEANUP_CLIENT_ID" ]]; then
  # Client report
  http_request GET "${BACKEND_URL}/api/reports/client/${CLEANUP_CLIENT_ID}"
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "GET /api/reports/client/$CLEANUP_CLIENT_ID -> 200"
    check_response_time "reports/client" 3.0
  else
    log_fail "GET /api/reports/client/$CLEANUP_CLIENT_ID -> $HTTP_STATUS (expected 200)" "$HTTP_BODY"
  fi

  # CSV export
  CSV_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    -H "x-user-email: $TEST_EMAIL" \
    "${BACKEND_URL}/api/reports/export/csv/${CLEANUP_CLIENT_ID}" 2>/dev/null || echo "000")
  if [[ "$CSV_STATUS" == "200" ]]; then
    log_pass "GET /api/reports/export/csv/$CLEANUP_CLIENT_ID -> 200"
  else
    log_fail "GET /api/reports/export/csv/$CLEANUP_CLIENT_ID -> $CSV_STATUS (expected 200)"
  fi

  # PDF export
  PDF_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    -H "x-user-email: $TEST_EMAIL" \
    "${BACKEND_URL}/api/reports/export/pdf/${CLEANUP_CLIENT_ID}" 2>/dev/null || echo "000")
  if [[ "$PDF_STATUS" == "200" ]]; then
    log_pass "GET /api/reports/export/pdf/$CLEANUP_CLIENT_ID -> 200"
  else
    log_fail "GET /api/reports/export/pdf/$CLEANUP_CLIENT_ID -> $PDF_STATUS (expected 200)"
  fi
else
  log_warn "Skipping report tests (client creation failed)"
fi

# ---- 6. Error Handling ----
section "6. Error Handling"

# 404 for unknown route
http_request GET "${BACKEND_URL}/api/nonexistent"
if [[ "$HTTP_STATUS" == "404" ]]; then
  log_pass "GET /api/nonexistent -> 404"
else
  log_fail "GET /api/nonexistent -> $HTTP_STATUS (expected 404)" "$HTTP_BODY"
fi

# Invalid client ID
http_request GET "${BACKEND_URL}/api/clients/not-a-number"
if [[ "$HTTP_STATUS" == "400" ]]; then
  log_pass "GET /api/clients/not-a-number -> 400"
else
  log_fail "GET /api/clients/not-a-number -> $HTTP_STATUS (expected 400)" "$HTTP_BODY"
fi

# Nonexistent client
http_request GET "${BACKEND_URL}/api/clients/999999"
if [[ "$HTTP_STATUS" == "404" ]]; then
  log_pass "GET /api/clients/999999 -> 404"
else
  log_fail "GET /api/clients/999999 -> $HTTP_STATUS (expected 404)" "$HTTP_BODY"
fi

# ---- 7. Frontend ----
section "7. Frontend"

if [[ "$SKIP_FRONTEND" == "1" ]]; then
  log_info "Skipping frontend checks (SKIP_FRONTEND=1)"
else
  FRONTEND_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    "${FRONTEND_URL}" 2>/dev/null || echo "000")
  if [[ "$FRONTEND_STATUS" == "200" ]]; then
    log_pass "GET $FRONTEND_URL -> 200"
  elif [[ "$FRONTEND_STATUS" == "000" ]]; then
    log_fail "GET $FRONTEND_URL -> connection failed (is the frontend running?)"
  else
    log_fail "GET $FRONTEND_URL -> $FRONTEND_STATUS (expected 200)"
  fi
fi

# ---- 8. Cleanup ----
section "8. Cleanup"

# Delete work entry
if [[ -n "$CLEANUP_ENTRY_ID" ]]; then
  http_request DELETE "${BACKEND_URL}/api/work-entries/${CLEANUP_ENTRY_ID}"
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "DELETE /api/work-entries/$CLEANUP_ENTRY_ID -> 200"
    CLEANUP_ENTRY_ID=""
  else
    log_fail "DELETE /api/work-entries/$CLEANUP_ENTRY_ID -> $HTTP_STATUS (expected 200)" "$HTTP_BODY"
  fi
fi

# Delete client
if [[ -n "$CLEANUP_CLIENT_ID" ]]; then
  http_request DELETE "${BACKEND_URL}/api/clients/${CLEANUP_CLIENT_ID}"
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "DELETE /api/clients/$CLEANUP_CLIENT_ID -> 200"
    CLEANUP_CLIENT_ID=""
  else
    log_fail "DELETE /api/clients/$CLEANUP_CLIENT_ID -> $HTTP_STATUS (expected 200)" "$HTTP_BODY"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "========================================"
echo " Results"
echo "========================================"
echo -e "  ${GREEN}Passed:${NC}   $PASS"
echo -e "  ${RED}Failed:${NC}   $FAIL"
echo -e "  ${YELLOW}Warnings:${NC} $WARNINGS"
echo "========================================"

if [[ "$FAIL" -gt 0 ]]; then
  echo -e "  ${RED}OVERALL: FAIL${NC}"
  echo ""
  exit 1
else
  echo -e "  ${GREEN}OVERALL: PASS${NC}"
  echo ""
  exit 0
fi
