#!/usr/bin/env bash
#
# Health Check Script for Timesheet Application
#
# Tests all critical application endpoints to verify system health.
# Exit code 0 = all checks passed, non-zero = one or more checks failed.
#
# Usage:
#   ./scripts/health-check.sh [BASE_URL]
#
# Arguments:
#   BASE_URL  - Backend base URL (default: http://localhost:3001)
#
# Examples:
#   ./scripts/health-check.sh
#   ./scripts/health-check.sh http://production-host:3001
#

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="healthcheck@test.example.com"
TIMEOUT=10
PASS=0
FAIL=0
WARNINGS=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color
BOLD='\033[1m'

print_header() {
    echo ""
    echo -e "${BOLD}========================================${NC}"
    echo -e "${BOLD} Timesheet App Health Check${NC}"
    echo -e "${BOLD}========================================${NC}"
    echo -e " Target: ${BASE_URL}"
    echo -e " Time:   $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
    echo -e "${BOLD}========================================${NC}"
    echo ""
}

check_pass() {
    echo -e "  ${GREEN}[PASS]${NC} $1"
    PASS=$((PASS + 1))
}

check_fail() {
    echo -e "  ${RED}[FAIL]${NC} $1"
    FAIL=$((FAIL + 1))
}

check_warn() {
    echo -e "  ${YELLOW}[WARN]${NC} $1"
    WARNINGS=$((WARNINGS + 1))
}

# Test a single endpoint
# Arguments: method, path, expected_status, description, [body], [extra_headers]
# expected_status can be a pipe-separated list, e.g. "200|201"
test_endpoint() {
    local method="$1"
    local path="$2"
    local expected_status="$3"
    local description="$4"
    local body="${5:-}"
    local extra_headers="${6:-}"

    local url="${BASE_URL}${path}"
    local curl_args=(-s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" -X "$method")

    if [ -n "$extra_headers" ]; then
        curl_args+=(-H "$extra_headers")
    fi

    curl_args+=(-H "Content-Type: application/json")

    if [ -n "$body" ]; then
        curl_args+=(-d "$body")
    fi

    local actual_status
    actual_status=$(curl "${curl_args[@]}" "$url" 2>/dev/null) || actual_status="000"

    # Support pipe-separated expected statuses (e.g., "200|201")
    if echo "$expected_status" | grep -qw "$actual_status"; then
        check_pass "$description (HTTP $actual_status)"
        return 0
    elif [ "$actual_status" = "000" ]; then
        check_fail "$description (Connection refused/timeout)"
        return 1
    else
        check_fail "$description (Expected HTTP $expected_status, got $actual_status)"
        return 1
    fi
}

# Test endpoint response time
test_response_time() {
    local path="$1"
    local max_ms="$2"
    local description="$3"

    local url="${BASE_URL}${path}"
    local time_total
    time_total=$(curl -s -o /dev/null -w "%{time_total}" --max-time "$TIMEOUT" -H "x-user-email: $TEST_EMAIL" "$url" 2>/dev/null) || time_total="99.0"

    # Convert seconds to milliseconds using awk (avoids bc dependency)
    local time_ms
    time_ms=$(echo "$time_total" | awk '{printf "%d", $1 * 1000}') || time_ms="9999"

    if [ "$time_ms" -le "$max_ms" ]; then
        check_pass "$description (${time_ms}ms <= ${max_ms}ms)"
    else
        check_warn "$description (${time_ms}ms > ${max_ms}ms threshold)"
    fi
}

# Test JSON response structure
test_json_field() {
    local path="$1"
    local field="$2"
    local description="$3"
    local headers="${4:-}"

    local url="${BASE_URL}${path}"
    local curl_args=(-s --max-time "$TIMEOUT")

    if [ -n "$headers" ]; then
        curl_args+=(-H "$headers")
    fi

    local response
    response=$(curl "${curl_args[@]}" "$url" 2>/dev/null) || response=""

    if echo "$response" | grep -q "\"$field\""; then
        check_pass "$description"
        return 0
    else
        check_fail "$description (field '$field' not found in response)"
        return 1
    fi
}

print_header

# ──────────────────────────────────────────────
# 1. Core Health Check
# ──────────────────────────────────────────────
echo -e "${BOLD}1. Core Health Check${NC}"

test_endpoint "GET" "/health" "200" "Health endpoint available"
test_json_field "/health" "status" "Health response contains status field"
test_response_time "/health" "1000" "Health endpoint response time"

# ──────────────────────────────────────────────
# 2. Authentication Endpoints
# ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}2. Authentication Endpoints${NC}"

test_endpoint "POST" "/api/auth/login" "200|201" "Login endpoint accessible" \
    "{\"email\":\"$TEST_EMAIL\"}"

test_endpoint "GET" "/api/auth/me" "200" "Get current user" \
    "" "x-user-email: $TEST_EMAIL"

test_endpoint "POST" "/api/auth/login" "400" "Login rejects invalid email" \
    "{\"email\":\"not-an-email\"}"

test_endpoint "GET" "/api/auth/me" "401" "Auth rejects missing header"

# ──────────────────────────────────────────────
# 3. Client Endpoints
# ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}3. Client Endpoints${NC}"

test_endpoint "GET" "/api/clients" "200" "List clients endpoint" \
    "" "x-user-email: $TEST_EMAIL"

test_endpoint "GET" "/api/clients" "401" "Clients rejects unauthenticated request"

test_endpoint "POST" "/api/clients" "400" "Clients rejects empty body" \
    "{}" "x-user-email: $TEST_EMAIL"

# Create a test client for further tests
CLIENT_RESPONSE=$(curl -s --max-time "$TIMEOUT" -X POST \
    -H "Content-Type: application/json" \
    -H "x-user-email: $TEST_EMAIL" \
    -d "{\"name\":\"HealthCheck Test Client\",\"description\":\"Auto-created by health check\"}" \
    "${BASE_URL}/api/clients" 2>/dev/null) || CLIENT_RESPONSE=""

CLIENT_ID=$(echo "$CLIENT_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*') || CLIENT_ID=""

if [ -n "$CLIENT_ID" ]; then
    check_pass "Create client (ID: $CLIENT_ID)"

    test_endpoint "GET" "/api/clients/$CLIENT_ID" "200" "Get single client" \
        "" "x-user-email: $TEST_EMAIL"
else
    check_fail "Create test client (no ID returned)"
fi

# ──────────────────────────────────────────────
# 4. Work Entry Endpoints
# ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}4. Work Entry Endpoints${NC}"

test_endpoint "GET" "/api/work-entries" "200" "List work entries endpoint" \
    "" "x-user-email: $TEST_EMAIL"

test_endpoint "GET" "/api/work-entries" "401" "Work entries rejects unauthenticated request"

if [ -n "$CLIENT_ID" ]; then
    # Create a test work entry
    TODAY=$(date -u '+%Y-%m-%d')
    ENTRY_RESPONSE=$(curl -s --max-time "$TIMEOUT" -X POST \
        -H "Content-Type: application/json" \
        -H "x-user-email: $TEST_EMAIL" \
        -d "{\"clientId\":$CLIENT_ID,\"hours\":2.5,\"description\":\"Health check test entry\",\"date\":\"$TODAY\"}" \
        "${BASE_URL}/api/work-entries" 2>/dev/null) || ENTRY_RESPONSE=""

    ENTRY_ID=$(echo "$ENTRY_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*') || ENTRY_ID=""

    if [ -n "$ENTRY_ID" ]; then
        check_pass "Create work entry (ID: $ENTRY_ID)"

        test_endpoint "GET" "/api/work-entries/$ENTRY_ID" "200" "Get single work entry" \
            "" "x-user-email: $TEST_EMAIL"
    else
        check_fail "Create test work entry"
    fi
fi

# ──────────────────────────────────────────────
# 5. Report Endpoints
# ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}5. Report Endpoints${NC}"

if [ -n "$CLIENT_ID" ]; then
    test_endpoint "GET" "/api/reports/client/$CLIENT_ID" "200" "Client report endpoint" \
        "" "x-user-email: $TEST_EMAIL"

    test_endpoint "GET" "/api/reports/export/csv/$CLIENT_ID" "200" "CSV export endpoint" \
        "" "x-user-email: $TEST_EMAIL"

    test_endpoint "GET" "/api/reports/export/pdf/$CLIENT_ID" "200" "PDF export endpoint" \
        "" "x-user-email: $TEST_EMAIL"
else
    check_warn "Skipping report tests (no test client created)"
fi

test_endpoint "GET" "/api/reports/client/999999" "404" "Report returns 404 for missing client" \
    "" "x-user-email: $TEST_EMAIL"

# ──────────────────────────────────────────────
# 6. Error Handling
# ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}6. Error Handling${NC}"

test_endpoint "GET" "/api/nonexistent-route" "404" "404 for unknown API routes"
test_endpoint "GET" "/nonexistent" "404" "404 for unknown routes"
test_endpoint "GET" "/api/work-entries/notanumber" "400" "Invalid ID returns 400" \
    "" "x-user-email: $TEST_EMAIL"

# ──────────────────────────────────────────────
# 7. Response Time Checks
# ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}7. Response Time Checks${NC}"

test_response_time "/api/clients" "2000" "Client list response time"
test_response_time "/api/work-entries" "2000" "Work entries list response time"

# ──────────────────────────────────────────────
# Cleanup test data
# ──────────────────────────────────────────────
if [ -n "$ENTRY_ID" ]; then
    curl -s --max-time "$TIMEOUT" -X DELETE \
        -H "x-user-email: $TEST_EMAIL" \
        "${BASE_URL}/api/work-entries/$ENTRY_ID" >/dev/null 2>&1 || true
fi

if [ -n "$CLIENT_ID" ]; then
    curl -s --max-time "$TIMEOUT" -X DELETE \
        -H "x-user-email: $TEST_EMAIL" \
        "${BASE_URL}/api/clients/$CLIENT_ID" >/dev/null 2>&1 || true
fi

# ──────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD} Summary${NC}"
echo -e "${BOLD}========================================${NC}"
echo -e "  ${GREEN}Passed:${NC}   $PASS"
echo -e "  ${RED}Failed:${NC}   $FAIL"
echo -e "  ${YELLOW}Warnings:${NC} $WARNINGS"
echo -e "${BOLD}========================================${NC}"

if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo -e "  ${RED}HEALTH CHECK FAILED${NC} — $FAIL check(s) did not pass."
    echo ""
    exit 1
else
    echo ""
    echo -e "  ${GREEN}ALL CHECKS PASSED${NC}"
    echo ""
    exit 0
fi
