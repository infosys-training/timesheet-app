#!/usr/bin/env bash
#
# Health Check Script for Timesheet Application
#
# Tests all critical API endpoints and service dependencies.
# Exit codes:
#   0 - All checks passed
#   1 - One or more checks failed
#
# Usage:
#   ./scripts/health-check.sh [BASE_URL]
#
# Arguments:
#   BASE_URL  - Backend URL (default: http://localhost:3001)
#
# Environment Variables:
#   HEALTH_CHECK_EMAIL  - Email for authenticated requests (default: healthcheck@test.com)
#   HEALTH_CHECK_TIMEOUT - Curl timeout in seconds (default: 10)
#   VERBOSE             - Set to "true" for detailed output

set -uo pipefail

# Configuration
BASE_URL="${1:-http://localhost:3001}"
TEST_EMAIL="${HEALTH_CHECK_EMAIL:-healthcheck@test.com}"
TIMEOUT="${HEALTH_CHECK_TIMEOUT:-10}"
VERBOSE="${VERBOSE:-false}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
TOTAL=0
PASSED=0
FAILED=0
WARNINGS=0

# Results array for summary
declare -a RESULTS=()

# ============================================================================
# Helper Functions
# ============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    RESULTS+=("PASS: $1")
    PASSED=$((PASSED + 1))
    TOTAL=$((TOTAL + 1))
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    RESULTS+=("FAIL: $1")
    FAILED=$((FAILED + 1))
    TOTAL=$((TOTAL + 1))
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
    RESULTS+=("WARN: $1")
    WARNINGS=$((WARNINGS + 1))
}

log_verbose() {
    if [[ "$VERBOSE" == "true" ]]; then
        echo -e "       $1"
    fi
}

# Perform an HTTP request and check the response
# Arguments: description, method, url, expected_status, [headers...], [body]
check_endpoint() {
    local description="$1"
    local method="$2"
    local url="$3"
    local expected_status="$4"
    shift 4

    local headers=()
    local body=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --header)
                headers+=("-H" "$2")
                shift 2
                ;;
            --body)
                body="$2"
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done

    local curl_args=(
        -s -o /dev/null -w "%{http_code}|%{time_total}"
        --max-time "$TIMEOUT"
        -X "$method"
        "${headers[@]}"
    )

    if [[ -n "$body" ]]; then
        curl_args+=(-d "$body" -H "Content-Type: application/json")
    fi

    curl_args+=("${url}")

    local response
    response=$(curl "${curl_args[@]}" 2>/dev/null) || {
        log_fail "$description - Connection failed (timeout or unreachable)"
        return 1
    }

    local status_code
    local response_time
    status_code=$(echo "$response" | cut -d'|' -f1)
    response_time=$(echo "$response" | cut -d'|' -f2)

    if [[ "$status_code" == "$expected_status" ]]; then
        log_pass "$description (HTTP $status_code, ${response_time}s)"
        log_verbose "URL: $method $url"

        # Warn if response is slow (>2 seconds)
        if (( $(echo "$response_time > 2.0" | bc -l 2>/dev/null || echo 0) )); then
            log_warn "$description - Slow response: ${response_time}s"
        fi
        return 0
    else
        log_fail "$description - Expected HTTP $expected_status, got HTTP $status_code"
        log_verbose "URL: $method $url"
        return 1
    fi
}

# ============================================================================
# Connectivity Checks
# ============================================================================

run_connectivity_checks() {
    echo ""
    echo "============================================"
    echo " Service Connectivity Checks"
    echo "============================================"
    echo ""

    # Basic TCP connectivity
    local host port
    host=$(echo "$BASE_URL" | sed -E 's|https?://||' | cut -d: -f1)
    port=$(echo "$BASE_URL" | sed -E 's|https?://||' | cut -d: -f2 | cut -d/ -f1)
    port="${port:-3001}"

    if timeout 5 bash -c "echo >/dev/tcp/$host/$port" 2>/dev/null; then
        log_pass "TCP connectivity to $host:$port"
    else
        log_fail "TCP connectivity to $host:$port - Cannot connect"
        echo ""
        echo -e "${RED}Cannot reach the backend server. Aborting further checks.${NC}"
        print_summary
        exit 1
    fi
}

# ============================================================================
# Health Endpoint Checks
# ============================================================================

run_health_checks() {
    echo ""
    echo "============================================"
    echo " Health Endpoint Checks"
    echo "============================================"
    echo ""

    # Basic health check (no auth required)
    check_endpoint \
        "GET /health - Basic health check" \
        "GET" \
        "${BASE_URL}/health" \
        "200"

    # Verify health response body contains expected fields
    local health_response
    health_response=$(curl -s --max-time "$TIMEOUT" "${BASE_URL}/health" 2>/dev/null) || true

    if echo "$health_response" | grep -q '"status":"OK"'; then
        log_pass "Health response contains status=OK"
    else
        log_fail "Health response missing status=OK (got: $health_response)"
    fi

    if echo "$health_response" | grep -q '"timestamp"'; then
        log_pass "Health response contains timestamp"
    else
        log_fail "Health response missing timestamp field"
    fi
}

# ============================================================================
# Authentication Checks
# ============================================================================

run_auth_checks() {
    echo ""
    echo "============================================"
    echo " Authentication Checks"
    echo "============================================"
    echo ""

    # Login endpoint (returns 200 for existing users, 201 for new users)
    local login_status
    login_status=$(curl -s -o /dev/null -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST \
        -H "Content-Type: application/json" \
        -d "{\"email\":\"${TEST_EMAIL}\"}" \
        "${BASE_URL}/api/auth/login" 2>/dev/null) || login_status="000"

    if [[ "$login_status" == "200" || "$login_status" == "201" ]]; then
        log_pass "POST /api/auth/login - User login (HTTP $login_status)"
    else
        log_fail "POST /api/auth/login - Expected HTTP 200 or 201, got HTTP $login_status"
    fi

    # Auth me endpoint (with valid header)
    check_endpoint \
        "GET /api/auth/me - Get current user (authenticated)" \
        "GET" \
        "${BASE_URL}/api/auth/me" \
        "200" \
        --header "x-user-email: ${TEST_EMAIL}"

    # Auth me endpoint (without header - should return 401)
    check_endpoint \
        "GET /api/auth/me - Reject unauthenticated request" \
        "GET" \
        "${BASE_URL}/api/auth/me" \
        "401"

    # Invalid email format (should return 400)
    check_endpoint \
        "GET /api/auth/me - Reject invalid email format" \
        "GET" \
        "${BASE_URL}/api/auth/me" \
        "400" \
        --header "x-user-email: not-an-email"
}

# ============================================================================
# Client API Checks
# ============================================================================

run_client_checks() {
    echo ""
    echo "============================================"
    echo " Client API Checks"
    echo "============================================"
    echo ""

    # List clients
    check_endpoint \
        "GET /api/clients - List clients" \
        "GET" \
        "${BASE_URL}/api/clients" \
        "200" \
        --header "x-user-email: ${TEST_EMAIL}"

    # Create a test client
    local create_response
    create_response=$(curl -s --max-time "$TIMEOUT" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "x-user-email: ${TEST_EMAIL}" \
        -d '{"name":"HealthCheck Test Client","description":"Auto-created by health check"}' \
        "${BASE_URL}/api/clients" 2>/dev/null) || true

    local client_id
    client_id=$(echo "$create_response" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

    if [[ -n "$client_id" ]]; then
        log_pass "POST /api/clients - Create client (id=$client_id)"

        # Get specific client
        check_endpoint \
            "GET /api/clients/$client_id - Get specific client" \
            "GET" \
            "${BASE_URL}/api/clients/${client_id}" \
            "200" \
            --header "x-user-email: ${TEST_EMAIL}"

        # Update client
        check_endpoint \
            "PUT /api/clients/$client_id - Update client" \
            "PUT" \
            "${BASE_URL}/api/clients/${client_id}" \
            "200" \
            --header "x-user-email: ${TEST_EMAIL}" \
            --body '{"name":"HealthCheck Updated Client"}'

        # Delete client (cleanup)
        check_endpoint \
            "DELETE /api/clients/$client_id - Delete client" \
            "DELETE" \
            "${BASE_URL}/api/clients/${client_id}" \
            "200" \
            --header "x-user-email: ${TEST_EMAIL}"
    else
        log_fail "POST /api/clients - Create client (no ID returned)"
        log_verbose "Response: $create_response"
    fi

    # Validation check - missing required field
    check_endpoint \
        "POST /api/clients - Reject invalid payload (missing name)" \
        "POST" \
        "${BASE_URL}/api/clients" \
        "400" \
        --header "x-user-email: ${TEST_EMAIL}" \
        --body '{"description":"missing name field"}'
}

# ============================================================================
# Work Entry API Checks
# ============================================================================

run_work_entry_checks() {
    echo ""
    echo "============================================"
    echo " Work Entry API Checks"
    echo "============================================"
    echo ""

    # List work entries
    check_endpoint \
        "GET /api/work-entries - List work entries" \
        "GET" \
        "${BASE_URL}/api/work-entries" \
        "200" \
        --header "x-user-email: ${TEST_EMAIL}"

    # Create a client for work entry tests
    local client_response
    client_response=$(curl -s --max-time "$TIMEOUT" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "x-user-email: ${TEST_EMAIL}" \
        -d '{"name":"HealthCheck WorkEntry Client"}' \
        "${BASE_URL}/api/clients" 2>/dev/null) || true

    local client_id
    client_id=$(echo "$client_response" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

    if [[ -n "$client_id" ]]; then
        # Create work entry
        local entry_response
        entry_response=$(curl -s --max-time "$TIMEOUT" \
            -X POST \
            -H "Content-Type: application/json" \
            -H "x-user-email: ${TEST_EMAIL}" \
            -d "{\"clientId\":${client_id},\"hours\":2.5,\"description\":\"Health check test entry\",\"date\":\"2024-01-15\"}" \
            "${BASE_URL}/api/work-entries" 2>/dev/null) || true

        local entry_id
        entry_id=$(echo "$entry_response" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

        if [[ -n "$entry_id" ]]; then
            log_pass "POST /api/work-entries - Create work entry (id=$entry_id)"

            # Get specific work entry
            check_endpoint \
                "GET /api/work-entries/$entry_id - Get specific work entry" \
                "GET" \
                "${BASE_URL}/api/work-entries/${entry_id}" \
                "200" \
                --header "x-user-email: ${TEST_EMAIL}"

            # Delete work entry (cleanup)
            check_endpoint \
                "DELETE /api/work-entries/$entry_id - Delete work entry" \
                "DELETE" \
                "${BASE_URL}/api/work-entries/${entry_id}" \
                "200" \
                --header "x-user-email: ${TEST_EMAIL}"
        else
            log_fail "POST /api/work-entries - Create work entry (no ID returned)"
            log_verbose "Response: $entry_response"
        fi

        # Cleanup test client
        curl -s --max-time "$TIMEOUT" \
            -X DELETE \
            -H "x-user-email: ${TEST_EMAIL}" \
            "${BASE_URL}/api/clients/${client_id}" >/dev/null 2>&1 || true
    else
        log_fail "Could not create test client for work entry checks"
        log_verbose "Response: $client_response"
    fi
}

# ============================================================================
# Report API Checks
# ============================================================================

run_report_checks() {
    echo ""
    echo "============================================"
    echo " Report API Checks"
    echo "============================================"
    echo ""

    # Create a client with work entries for report testing
    local client_response
    client_response=$(curl -s --max-time "$TIMEOUT" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "x-user-email: ${TEST_EMAIL}" \
        -d '{"name":"HealthCheck Report Client"}' \
        "${BASE_URL}/api/clients" 2>/dev/null) || true

    local client_id
    client_id=$(echo "$client_response" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

    if [[ -n "$client_id" ]]; then
        # Add a work entry for the report
        curl -s --max-time "$TIMEOUT" \
            -X POST \
            -H "Content-Type: application/json" \
            -H "x-user-email: ${TEST_EMAIL}" \
            -d "{\"clientId\":${client_id},\"hours\":4,\"description\":\"Report test\",\"date\":\"2024-01-15\"}" \
            "${BASE_URL}/api/work-entries" >/dev/null 2>&1 || true

        # Get client report
        check_endpoint \
            "GET /api/reports/client/$client_id - Get client report" \
            "GET" \
            "${BASE_URL}/api/reports/client/${client_id}" \
            "200" \
            --header "x-user-email: ${TEST_EMAIL}"

        # CSV export
        check_endpoint \
            "GET /api/reports/export/csv/$client_id - Export CSV report" \
            "GET" \
            "${BASE_URL}/api/reports/export/csv/${client_id}" \
            "200" \
            --header "x-user-email: ${TEST_EMAIL}"

        # PDF export
        check_endpoint \
            "GET /api/reports/export/pdf/$client_id - Export PDF report" \
            "GET" \
            "${BASE_URL}/api/reports/export/pdf/${client_id}" \
            "200" \
            --header "x-user-email: ${TEST_EMAIL}"

        # Cleanup
        curl -s --max-time "$TIMEOUT" \
            -X DELETE \
            -H "x-user-email: ${TEST_EMAIL}" \
            "${BASE_URL}/api/clients/${client_id}" >/dev/null 2>&1 || true
    else
        log_fail "Could not create test client for report checks"
    fi

    # Report for non-existent client (should be 404)
    check_endpoint \
        "GET /api/reports/client/99999 - Non-existent client report returns 404" \
        "GET" \
        "${BASE_URL}/api/reports/client/99999" \
        "404" \
        --header "x-user-email: ${TEST_EMAIL}"
}

# ============================================================================
# Error Handling Checks
# ============================================================================

run_error_handling_checks() {
    echo ""
    echo "============================================"
    echo " Error Handling Checks"
    echo "============================================"
    echo ""

    # 404 for unknown routes
    check_endpoint \
        "GET /nonexistent - Returns 404 for unknown routes" \
        "GET" \
        "${BASE_URL}/nonexistent" \
        "404"

    # Invalid JSON body
    local invalid_json_status
    invalid_json_status=$(curl -s -o /dev/null -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "x-user-email: ${TEST_EMAIL}" \
        -d '{invalid json}' \
        "${BASE_URL}/api/clients" 2>/dev/null) || invalid_json_status="000"

    if [[ "$invalid_json_status" == "400" ]]; then
        log_pass "POST /api/clients - Rejects malformed JSON (HTTP 400)"
    elif [[ "$invalid_json_status" != "000" ]]; then
        log_pass "POST /api/clients - Handles malformed JSON (HTTP $invalid_json_status)"
    else
        log_fail "POST /api/clients - No response for malformed JSON"
    fi
}

# ============================================================================
# Dependency Checks
# ============================================================================

run_dependency_checks() {
    echo ""
    echo "============================================"
    echo " Dependency Checks"
    echo "============================================"
    echo ""

    # Check Node.js availability
    if command -v node &>/dev/null; then
        local node_version
        node_version=$(node --version)
        log_pass "Node.js available ($node_version)"
    else
        log_fail "Node.js not found in PATH"
    fi

    # Check npm availability
    if command -v npm &>/dev/null; then
        local npm_version
        npm_version=$(npm --version)
        log_pass "npm available (v$npm_version)"
    else
        log_fail "npm not found in PATH"
    fi

    # Check if backend dependencies are installed
    if [[ -d "backend/node_modules" ]] || [[ -d "./node_modules" ]]; then
        log_pass "Backend node_modules directory exists"
    else
        log_warn "Backend node_modules not found (run 'cd backend && npm install')"
    fi

    # Check sqlite3 native module
    local sqlite_check
    sqlite_check=$(cd backend 2>/dev/null && node -e "try{require('sqlite3');console.log('OK')}catch(e){console.log('FAIL:'+e.message)}" 2>/dev/null) || sqlite_check="FAIL:not found"

    if [[ "$sqlite_check" == "OK" ]]; then
        log_pass "sqlite3 native module loads successfully"
    else
        log_fail "sqlite3 native module failed: $sqlite_check"
    fi

    # Check disk space
    local disk_usage
    disk_usage=$(df -h . 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%')
    if [[ -n "$disk_usage" ]] && [[ "$disk_usage" -lt 90 ]]; then
        log_pass "Disk usage is at ${disk_usage}% (threshold: 90%)"
    elif [[ -n "$disk_usage" ]]; then
        log_warn "Disk usage is at ${disk_usage}% - approaching capacity"
    fi

    # Check available memory
    if command -v free &>/dev/null; then
        local mem_available
        mem_available=$(free -m | awk '/^Mem:/{print $7}')
        if [[ -n "$mem_available" ]] && [[ "$mem_available" -gt 100 ]]; then
            log_pass "Available memory: ${mem_available}MB (threshold: 100MB)"
        elif [[ -n "$mem_available" ]]; then
            log_warn "Low available memory: ${mem_available}MB"
        fi
    fi
}

# ============================================================================
# Summary
# ============================================================================

print_summary() {
    echo ""
    echo "============================================"
    echo " Health Check Summary"
    echo "============================================"
    echo ""
    echo -e "  Total checks:  ${TOTAL}"
    echo -e "  ${GREEN}Passed:${NC}        ${PASSED}"
    echo -e "  ${RED}Failed:${NC}        ${FAILED}"
    echo -e "  ${YELLOW}Warnings:${NC}      ${WARNINGS}"
    echo ""
    echo "  Base URL:      ${BASE_URL}"
    echo "  Test Email:    ${TEST_EMAIL}"
    echo "  Timestamp:     $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    echo ""

    if [[ $FAILED -gt 0 ]]; then
        echo -e "${RED}============================================${NC}"
        echo -e "${RED} HEALTH CHECK FAILED${NC}"
        echo -e "${RED}============================================${NC}"
        echo ""
        echo "Failed checks:"
        for result in "${RESULTS[@]}"; do
            if [[ "$result" == FAIL:* ]]; then
                echo -e "  ${RED}- ${result#FAIL: }${NC}"
            fi
        done
        echo ""
        return 1
    else
        echo -e "${GREEN}============================================${NC}"
        echo -e "${GREEN} ALL HEALTH CHECKS PASSED${NC}"
        echo -e "${GREEN}============================================${NC}"
        echo ""
        return 0
    fi
}

# ============================================================================
# Main
# ============================================================================

main() {
    echo ""
    echo "============================================"
    echo " Timesheet Application Health Check"
    echo "============================================"
    echo ""
    echo "  Target:    ${BASE_URL}"
    echo "  Email:     ${TEST_EMAIL}"
    echo "  Timeout:   ${TIMEOUT}s"
    echo "  Verbose:   ${VERBOSE}"
    echo "  Timestamp: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"

    run_connectivity_checks
    run_health_checks
    run_auth_checks
    run_client_checks
    run_work_entry_checks
    run_report_checks
    run_error_handling_checks
    run_dependency_checks

    print_summary
    exit $?
}

main "$@"
