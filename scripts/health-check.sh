#!/usr/bin/env bash
#
# Health Check Script for Timesheet Application
#
# Tests all critical backend endpoints to verify system health.
# Exits with code 0 if all checks pass, 1 if any check fails.
#
# Usage:
#   ./scripts/health-check.sh                    # Uses default localhost:3001
#   ./scripts/health-check.sh http://myhost:3001 # Custom base URL
#
# Dependencies: curl, jq (optional, for JSON formatting)

set -euo pipefail

# Configuration
BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="healthcheck@test.example.com"
TIMEOUT=10
PASSED=0
FAILED=0
WARNINGS=0
TOTAL=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# --- Helper Functions ---

print_header() {
    echo ""
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  Timesheet Application Health Check${NC}"
    echo -e "${BLUE}  Target: ${BASE_URL}${NC}"
    echo -e "${BLUE}  Time:   $(date -u '+%Y-%m-%d %H:%M:%S UTC')${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
}

print_section() {
    echo ""
    echo -e "${BLUE}--- $1 ---${NC}"
}

check_pass() {
    PASSED=$((PASSED + 1))
    TOTAL=$((TOTAL + 1))
    echo -e "  ${GREEN}[PASS]${NC} $1"
}

check_fail() {
    FAILED=$((FAILED + 1))
    TOTAL=$((TOTAL + 1))
    echo -e "  ${RED}[FAIL]${NC} $1"
    if [ -n "${2:-}" ]; then
        echo -e "        ${RED}Details: $2${NC}"
    fi
}

check_warn() {
    WARNINGS=$((WARNINGS + 1))
    TOTAL=$((TOTAL + 1))
    echo -e "  ${YELLOW}[WARN]${NC} $1"
}

# Perform an HTTP request and validate the response
# Args: method, path, expected_status, description, [headers...], [body]
http_check() {
    local method="$1"
    local path="$2"
    local expected_status="$3"
    local description="$4"
    shift 4

    local curl_args=("-s" "-o" "/tmp/health_check_response.json" "-w" "%{http_code}" "--max-time" "$TIMEOUT")
    curl_args+=("-X" "$method")

    # Add headers and body from remaining arguments
    while [ $# -gt 0 ]; do
        case "$1" in
            -H) curl_args+=("-H" "$2"); shift 2 ;;
            -d) curl_args+=("-d" "$2"); shift 2 ;;
            *) shift ;;
        esac
    done

    local actual_status
    actual_status=$(curl "${curl_args[@]}" "${BASE_URL}${path}" 2>/dev/null) || {
        check_fail "$description" "Connection refused or timeout"
        return 1
    }

    if [ "$actual_status" = "$expected_status" ]; then
        check_pass "$description (HTTP $actual_status)"
        return 0
    else
        local response_body=""
        if [ -f /tmp/health_check_response.json ]; then
            response_body=$(cat /tmp/health_check_response.json 2>/dev/null | head -c 200)
        fi
        check_fail "$description" "Expected HTTP $expected_status, got $actual_status. Response: $response_body"
        return 1
    fi
}

# --- Health Checks ---

print_header

# Section 1: Basic Connectivity
print_section "Basic Connectivity"

# Check if the server is reachable at all
if curl -s --max-time "$TIMEOUT" "${BASE_URL}/health" > /dev/null 2>&1; then
    check_pass "Backend server is reachable"
else
    check_fail "Backend server is reachable" "Cannot connect to ${BASE_URL}"
    echo ""
    echo -e "${RED}CRITICAL: Backend server is not running or unreachable.${NC}"
    echo -e "${RED}Cannot proceed with further health checks.${NC}"
    echo ""
    echo -e "Results: 0 passed, 1 failed out of 1 checks"
    exit 1
fi

# Section 2: Health Endpoint
print_section "Health Endpoint"

http_check GET "/health" "200" "GET /health returns 200"

# Validate health response body contains expected fields
HEALTH_BODY=$(curl -s --max-time "$TIMEOUT" "${BASE_URL}/health" 2>/dev/null)
if echo "$HEALTH_BODY" | grep -q '"status":"OK"'; then
    check_pass "Health response contains status: OK"
else
    check_fail "Health response contains status: OK" "Body: $HEALTH_BODY"
fi

if echo "$HEALTH_BODY" | grep -q '"timestamp"'; then
    check_pass "Health response contains timestamp"
else
    check_fail "Health response contains timestamp" "Body: $HEALTH_BODY"
fi

# Section 3: Authentication
print_section "Authentication Endpoints"

# Login returns 200 for existing user or 201 for newly created user
LOGIN_STATUS=$(curl -s -o /tmp/health_check_response.json -w "%{http_code}" --max-time "$TIMEOUT" \
    -X POST "${BASE_URL}/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${TEST_EMAIL}\"}" 2>/dev/null) || LOGIN_STATUS="000"

if [ "$LOGIN_STATUS" = "200" ] || [ "$LOGIN_STATUS" = "201" ]; then
    check_pass "POST /api/auth/login with valid email (HTTP $LOGIN_STATUS)"
else
    check_fail "POST /api/auth/login with valid email" "Expected HTTP 200 or 201, got $LOGIN_STATUS"
fi

# Test login with invalid email
http_check POST "/api/auth/login" "400" "POST /api/auth/login rejects invalid email" \
    -H "Content-Type: application/json" \
    -d '{"email":"not-an-email"}'

# Test login with missing body
http_check POST "/api/auth/login" "400" "POST /api/auth/login rejects empty body" \
    -H "Content-Type: application/json" \
    -d '{}'

# Section 4: Client Endpoints (Authenticated)
print_section "Client Management Endpoints"

http_check GET "/api/clients" "200" "GET /api/clients (authenticated)" \
    -H "x-user-email: ${TEST_EMAIL}"

# Test without auth header
http_check GET "/api/clients" "401" "GET /api/clients rejects unauthenticated request"

# Create a test client
http_check POST "/api/clients" "201" "POST /api/clients creates client" \
    -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    -d '{"name":"Health Check Test Client","description":"Created by health check script"}'

# Extract the client ID from the response
CLIENT_ID=""
if [ -f /tmp/health_check_response.json ]; then
    CLIENT_ID=$(grep -o '"id":[0-9]*' /tmp/health_check_response.json 2>/dev/null | head -1 | cut -d: -f2)
fi

if [ -n "$CLIENT_ID" ]; then
    # Get specific client
    http_check GET "/api/clients/${CLIENT_ID}" "200" "GET /api/clients/:id returns client" \
        -H "x-user-email: ${TEST_EMAIL}"

    # Update client
    http_check PUT "/api/clients/${CLIENT_ID}" "200" "PUT /api/clients/:id updates client" \
        -H "Content-Type: application/json" \
        -H "x-user-email: ${TEST_EMAIL}" \
        -d '{"name":"Health Check Updated Client"}'
else
    check_warn "Could not extract client ID - skipping client detail tests"
fi

# Test validation
http_check POST "/api/clients" "400" "POST /api/clients rejects invalid data" \
    -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    -d '{}'

# Section 5: Work Entry Endpoints
print_section "Work Entry Endpoints"

http_check GET "/api/work-entries" "200" "GET /api/work-entries (authenticated)" \
    -H "x-user-email: ${TEST_EMAIL}"

http_check GET "/api/work-entries" "401" "GET /api/work-entries rejects unauthenticated"

if [ -n "$CLIENT_ID" ]; then
    # Create a work entry
    http_check POST "/api/work-entries" "201" "POST /api/work-entries creates entry" \
        -H "Content-Type: application/json" \
        -H "x-user-email: ${TEST_EMAIL}" \
        -d "{\"clientId\":${CLIENT_ID},\"hours\":2.5,\"description\":\"Health check test entry\",\"date\":\"2024-01-15\"}"
else
    check_warn "Skipping work entry creation - no client ID available"
fi

# Test validation
http_check POST "/api/work-entries" "400" "POST /api/work-entries rejects invalid data" \
    -H "Content-Type: application/json" \
    -H "x-user-email: ${TEST_EMAIL}" \
    -d '{}'

# Section 6: Report Endpoints
print_section "Report Endpoints"

if [ -n "$CLIENT_ID" ]; then
    http_check GET "/api/reports/client/${CLIENT_ID}" "200" "GET /api/reports/client/:id returns report" \
        -H "x-user-email: ${TEST_EMAIL}"

    http_check GET "/api/reports/export/csv/${CLIENT_ID}" "200" "GET /api/reports/export/csv/:id returns CSV" \
        -H "x-user-email: ${TEST_EMAIL}"

    http_check GET "/api/reports/export/pdf/${CLIENT_ID}" "200" "GET /api/reports/export/pdf/:id returns PDF" \
        -H "x-user-email: ${TEST_EMAIL}"
else
    check_warn "Skipping report tests - no client ID available"
fi

# Test report with invalid client ID
http_check GET "/api/reports/client/999999" "404" "GET /api/reports/client/:id returns 404 for missing client" \
    -H "x-user-email: ${TEST_EMAIL}"

# Section 7: Error Handling
print_section "Error Handling & Edge Cases"

# 404 for unknown routes
http_check GET "/api/nonexistent" "404" "Unknown route returns 404"

# Invalid client ID format
http_check GET "/api/clients/notanumber" "400" "Invalid ID format returns 400" \
    -H "x-user-email: ${TEST_EMAIL}"

# Section 8: Cleanup - delete test client
print_section "Cleanup"

if [ -n "$CLIENT_ID" ]; then
    http_check DELETE "/api/clients/${CLIENT_ID}" "200" "DELETE /api/clients/:id removes test client" \
        -H "x-user-email: ${TEST_EMAIL}"
fi

# --- Summary ---
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Health Check Summary${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Total Checks: ${TOTAL}"
echo -e "  ${GREEN}Passed: ${PASSED}${NC}"
echo -e "  ${RED}Failed: ${FAILED}${NC}"
echo -e "  ${YELLOW}Warnings: ${WARNINGS}${NC}"
echo ""

# Clean up temp file
rm -f /tmp/health_check_response.json

if [ "$FAILED" -gt 0 ]; then
    echo -e "${RED}HEALTH CHECK FAILED - $FAILED check(s) did not pass${NC}"
    echo ""
    echo "Refer to RUNBOOK.md for troubleshooting procedures."
    exit 1
else
    echo -e "${GREEN}ALL HEALTH CHECKS PASSED${NC}"
    exit 0
fi
