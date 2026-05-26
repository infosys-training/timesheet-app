#!/usr/bin/env bash
#
# Timesheet Application Health Check Script
# Tests all critical endpoints and reports pass/fail for each.
# Usage: ./scripts/healthcheck.sh [BASE_URL]
#
set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
AUTH_EMAIL="healthcheck@test.com"
TIMEOUT=10
SLOW_THRESHOLD=2  # seconds

PASSED=0
FAILED=0
WARNINGS=""
RESULTS=""
CREATED_CLIENT_ID=""

# ── helpers ───────────────────────────────────────────────────────────────────

record_result() {
  local status="$1" method="$2" path="$3" time_ms="$4"
  if [ "$status" = "PASS" ]; then
    PASSED=$((PASSED + 1))
    RESULTS+="$(printf '[PASS] %-6s %-30s (%sms)\n' "$method" "$path" "$time_ms")"
  elif [ "$status" = "FAIL" ]; then
    FAILED=$((FAILED + 1))
    RESULTS+="$(printf '[FAIL] %-6s %-30s (%sms)\n' "$method" "$path" "$time_ms")"
  fi
  RESULTS+=$'\n'

  # Check for slow response
  local time_s
  time_s=$(echo "$time_ms" | awk '{printf "%.3f", $1 / 1000}')
  if awk "BEGIN {exit !($time_s > $SLOW_THRESHOLD)}"; then
    WARNINGS+="  $method $path (${time_ms}ms)"$'\n'
  fi
}

ms_from_curl() {
  # Expects time_total in seconds from curl, converts to integer ms
  awk "BEGIN {printf \"%d\", $1 * 1000}"
}

# ── banner ────────────────────────────────────────────────────────────────────

echo "=== Timesheet App Health Check ==="
echo "Target: ${BASE_URL}"
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# ── 1. Health endpoint ────────────────────────────────────────────────────────

RESP=$(curl -s -w '\n%{http_code}\n%{time_total}' --max-time "$TIMEOUT" \
  "${BASE_URL}/health" 2>/dev/null) || true
HTTP_CODE=$(echo "$RESP" | tail -2 | head -1)
TIME_TOTAL=$(echo "$RESP" | tail -1)
TIME_MS=$(ms_from_curl "$TIME_TOTAL")
BODY=$(echo "$RESP" | sed '$d' | sed '$d')

if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q '"status":"OK"'; then
  record_result "PASS" "GET" "/health" "$TIME_MS"
else
  record_result "FAIL" "GET" "/health" "$TIME_MS"
fi

# ── 2. Auth login ─────────────────────────────────────────────────────────────

RESP=$(curl -s -w '\n%{http_code}\n%{time_total}' --max-time "$TIMEOUT" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${AUTH_EMAIL}\"}" \
  "${BASE_URL}/api/auth/login" 2>/dev/null) || true
HTTP_CODE=$(echo "$RESP" | tail -2 | head -1)
TIME_TOTAL=$(echo "$RESP" | tail -1)
TIME_MS=$(ms_from_curl "$TIME_TOTAL")

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  record_result "PASS" "POST" "/api/auth/login" "$TIME_MS"
else
  record_result "FAIL" "POST" "/api/auth/login" "$TIME_MS"
fi

# ── 3. Auth me ────────────────────────────────────────────────────────────────

RESP=$(curl -s -w '\n%{http_code}\n%{time_total}' --max-time "$TIMEOUT" \
  -H "x-user-email: ${AUTH_EMAIL}" \
  "${BASE_URL}/api/auth/me" 2>/dev/null) || true
HTTP_CODE=$(echo "$RESP" | tail -2 | head -1)
TIME_TOTAL=$(echo "$RESP" | tail -1)
TIME_MS=$(ms_from_curl "$TIME_TOTAL")

if [ "$HTTP_CODE" = "200" ]; then
  record_result "PASS" "GET" "/api/auth/me" "$TIME_MS"
else
  record_result "FAIL" "GET" "/api/auth/me" "$TIME_MS"
fi

# ── 4. List clients ──────────────────────────────────────────────────────────

RESP=$(curl -s -w '\n%{http_code}\n%{time_total}' --max-time "$TIMEOUT" \
  -H "x-user-email: ${AUTH_EMAIL}" \
  "${BASE_URL}/api/clients" 2>/dev/null) || true
HTTP_CODE=$(echo "$RESP" | tail -2 | head -1)
TIME_TOTAL=$(echo "$RESP" | tail -1)
TIME_MS=$(ms_from_curl "$TIME_TOTAL")

if [ "$HTTP_CODE" = "200" ]; then
  record_result "PASS" "GET" "/api/clients" "$TIME_MS"
else
  record_result "FAIL" "GET" "/api/clients" "$TIME_MS"
fi

# ── 5. List work entries ─────────────────────────────────────────────────────

RESP=$(curl -s -w '\n%{http_code}\n%{time_total}' --max-time "$TIMEOUT" \
  -H "x-user-email: ${AUTH_EMAIL}" \
  "${BASE_URL}/api/work-entries" 2>/dev/null) || true
HTTP_CODE=$(echo "$RESP" | tail -2 | head -1)
TIME_TOTAL=$(echo "$RESP" | tail -1)
TIME_MS=$(ms_from_curl "$TIME_TOTAL")

if [ "$HTTP_CODE" = "200" ]; then
  record_result "PASS" "GET" "/api/work-entries" "$TIME_MS"
else
  record_result "FAIL" "GET" "/api/work-entries" "$TIME_MS"
fi

# ── 6. Create + Delete client (write path test) ─────────────────────────────

# Create
RESP=$(curl -s -w '\n%{http_code}\n%{time_total}' --max-time "$TIMEOUT" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-user-email: ${AUTH_EMAIL}" \
  -d '{"name":"_healthcheck_temp"}' \
  "${BASE_URL}/api/clients" 2>/dev/null) || true
HTTP_CODE=$(echo "$RESP" | tail -2 | head -1)
TIME_TOTAL=$(echo "$RESP" | tail -1)
TIME_MS=$(ms_from_curl "$TIME_TOTAL")
BODY=$(echo "$RESP" | sed '$d' | sed '$d')

if [ "$HTTP_CODE" = "201" ]; then
  record_result "PASS" "POST" "/api/clients (create)" "$TIME_MS"
  # Extract client ID
  CREATED_CLIENT_ID=$(echo "$BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
else
  record_result "FAIL" "POST" "/api/clients (create)" "$TIME_MS"
fi

# Delete (only if create succeeded)
if [ -n "$CREATED_CLIENT_ID" ]; then
  RESP=$(curl -s -w '\n%{http_code}\n%{time_total}' --max-time "$TIMEOUT" \
    -X DELETE \
    -H "x-user-email: ${AUTH_EMAIL}" \
    "${BASE_URL}/api/clients/${CREATED_CLIENT_ID}" 2>/dev/null) || true
  HTTP_CODE=$(echo "$RESP" | tail -2 | head -1)
  TIME_TOTAL=$(echo "$RESP" | tail -1)
  TIME_MS=$(ms_from_curl "$TIME_TOTAL")

  if [ "$HTTP_CODE" = "200" ]; then
    record_result "PASS" "DELETE" "/api/clients/:id" "$TIME_MS"
  else
    record_result "FAIL" "DELETE" "/api/clients/:id" "$TIME_MS"
  fi
else
  record_result "FAIL" "DELETE" "/api/clients/:id" "0"
fi

# ── 7. Reports endpoint ──────────────────────────────────────────────────────

RESP=$(curl -s -w '\n%{http_code}\n%{time_total}' --max-time "$TIMEOUT" \
  -H "x-user-email: ${AUTH_EMAIL}" \
  "${BASE_URL}/api/reports/client/99999" 2>/dev/null) || true
HTTP_CODE=$(echo "$RESP" | tail -2 | head -1)
TIME_TOTAL=$(echo "$RESP" | tail -1)
TIME_MS=$(ms_from_curl "$TIME_TOTAL")

if [ "$HTTP_CODE" = "404" ]; then
  record_result "PASS" "GET" "/api/reports/client/:id" "$TIME_MS"
else
  record_result "FAIL" "GET" "/api/reports/client/:id" "$TIME_MS"
fi

# ── 8. Rate limit check ──────────────────────────────────────────────────────

RESP=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" \
  "${BASE_URL}/health" 2>/dev/null) || true
if [ "$RESP" = "429" ]; then
  echo "[WARN] Rate limit (429) detected on health endpoint"
  WARNINGS+="  Rate limited on /health"$'\n'
fi

# ── output ────────────────────────────────────────────────────────────────────

printf "%s" "$RESULTS"

TOTAL=$((PASSED + FAILED))

if [ -n "$WARNINGS" ]; then
  echo "[WARN] Response time > 2s on:"
  printf "%s" "$WARNINGS"
else
  echo "[WARN] Response time > 2s on: none"
fi

echo ""
echo "Results: ${PASSED}/${TOTAL} passed, ${FAILED} failed"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi

exit 0
