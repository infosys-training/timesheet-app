#!/usr/bin/env node

/**
 * Timesheet App — Health Check Script
 *
 * Tests all critical backend endpoints and dependencies.
 * Exit code 0 = all checks passed, 1 = one or more checks failed.
 *
 * Usage:
 *   node scripts/health-check.js                    # defaults to http://localhost:3001
 *   node scripts/health-check.js http://myhost:3001 # custom base URL
 */

const http = require("http");
const https = require("https");

const BASE_URL = process.argv[2] || "http://localhost:3001";
const TEST_EMAIL = "healthcheck@timesheet-app.com";
const TIMEOUT_MS = 5000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const transport = url.protocol === "https:" ? https : http;

    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
        "x-user-email": TEST_EMAIL,
      },
      timeout: TIMEOUT_MS,
    };

    const req = transport.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timed out after ${TIMEOUT_MS}ms`));
    });
    req.on("error", (err) => reject(err));

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ── Checks ───────────────────────────────────────────────────────────────────

const results = [];

async function check(name, fn) {
  const start = Date.now();
  try {
    await fn();
    const ms = Date.now() - start;
    results.push({ name, status: "PASS", ms });
    console.log(`  ✓  ${name} (${ms}ms)`);
  } catch (err) {
    const ms = Date.now() - start;
    const msg = err.message || String(err);
    results.push({ name, status: "FAIL", ms, error: msg });
    console.log(`  ✗  ${name} (${ms}ms) — ${msg}`);
  }
}

async function run() {
  console.log(`\nTimesheet App Health Check — ${BASE_URL}`);
  console.log(`${"─".repeat(60)}\n`);

  // ── 1. Health endpoint ───────────────────────────────────────────────────
  await check("GET /health", async () => {
    const res = await request("GET", "/health");
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (res.body.status !== "OK") throw new Error(`Status field is "${res.body.status}", expected "OK"`);
    if (!res.body.timestamp) throw new Error("Missing timestamp field");
  });

  // ── 2. Auth — login ──────────────────────────────────────────────────────
  await check("POST /api/auth/login", async () => {
    const res = await request("POST", "/api/auth/login", { email: TEST_EMAIL });
    if (res.status !== 200 && res.status !== 201)
      throw new Error(`Expected 200 or 201, got ${res.status}`);
    if (!res.body.user || !res.body.user.email)
      throw new Error("Response missing user.email");
  });

  // ── 3. Auth — get current user ───────────────────────────────────────────
  await check("GET /api/auth/me", async () => {
    const res = await request("GET", "/api/auth/me");
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!res.body.user) throw new Error("Response missing user object");
  });

  // ── 4. Auth — missing header returns 401 ─────────────────────────────────
  await check("GET /api/auth/me (no header → 401)", async () => {
    const url = new URL("/api/auth/me", BASE_URL);
    const transport = url.protocol === "https:" ? https : http;
    const res = await new Promise((resolve, reject) => {
      const req = transport.request(
        {
          method: "GET",
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          headers: { "Content-Type": "application/json" },
          timeout: TIMEOUT_MS,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode }));
        }
      );
      req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
      req.on("error", reject);
      req.end();
    });
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  // ── 5. Clients — list (empty is fine) ────────────────────────────────────
  await check("GET /api/clients", async () => {
    const res = await request("GET", "/api/clients");
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!Array.isArray(res.body.clients))
      throw new Error("Response missing clients array");
  });

  // ── 6. Clients — create ──────────────────────────────────────────────────
  let testClientId;
  await check("POST /api/clients (create)", async () => {
    const res = await request("POST", "/api/clients", {
      name: "HealthCheck Test Client",
      description: "Created by health-check script — safe to delete",
    });
    if (res.status !== 201) throw new Error(`Expected 201, got ${res.status}`);
    if (!res.body.client || !res.body.client.id)
      throw new Error("Response missing client.id");
    testClientId = res.body.client.id;
  });

  // ── 7. Clients — get by ID ──────────────────────────────────────────────
  if (testClientId) {
    await check(`GET /api/clients/${testClientId}`, async () => {
      const res = await request("GET", `/api/clients/${testClientId}`);
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    });
  }

  // ── 8. Work entries — list ───────────────────────────────────────────────
  await check("GET /api/work-entries", async () => {
    const res = await request("GET", "/api/work-entries");
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!Array.isArray(res.body.workEntries))
      throw new Error("Response missing workEntries array");
  });

  // ── 9. Work entries — create ─────────────────────────────────────────────
  let testEntryId;
  if (testClientId) {
    await check("POST /api/work-entries (create)", async () => {
      const res = await request("POST", "/api/work-entries", {
        clientId: testClientId,
        hours: 1.5,
        description: "Health-check test entry",
        date: new Date().toISOString().split("T")[0],
      });
      if (res.status !== 201) throw new Error(`Expected 201, got ${res.status}`);
      if (!res.body.workEntry || !res.body.workEntry.id)
        throw new Error("Response missing workEntry.id");
      testEntryId = res.body.workEntry.id;
    });
  }

  // ── 10. Reports — client report ──────────────────────────────────────────
  if (testClientId) {
    await check(`GET /api/reports/client/${testClientId}`, async () => {
      const res = await request("GET", `/api/reports/client/${testClientId}`);
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      if (res.body.totalHours === undefined)
        throw new Error("Response missing totalHours");
    });
  }

  // ── 11. Reports — CSV export ─────────────────────────────────────────────
  if (testClientId) {
    await check(`GET /api/reports/export/csv/${testClientId}`, async () => {
      const res = await request("GET", `/api/reports/export/csv/${testClientId}`);
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    });
  }

  // ── 12. Reports — PDF export ─────────────────────────────────────────────
  if (testClientId) {
    await check(`GET /api/reports/export/pdf/${testClientId}`, async () => {
      const res = await request("GET", `/api/reports/export/pdf/${testClientId}`);
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    });
  }

  // ── 13. Validation — invalid payload returns 400 ─────────────────────────
  await check("POST /api/clients (invalid → 400)", async () => {
    const res = await request("POST", "/api/clients", {});
    if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`);
  });

  // ── 14. 404 handler ─────────────────────────────────────────────────────
  await check("GET /nonexistent → 404", async () => {
    const res = await request("GET", "/nonexistent");
    if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`);
  });

  // ── Cleanup: delete test work entry ──────────────────────────────────────
  if (testEntryId) {
    await check("DELETE /api/work-entries/:id (cleanup)", async () => {
      const res = await request("DELETE", `/api/work-entries/${testEntryId}`);
      if (res.status !== 200 && res.status !== 204)
        throw new Error(`Expected 200 or 204, got ${res.status}`);
    });
  }

  // ── Cleanup: delete test client ──────────────────────────────────────────
  if (testClientId) {
    await check("DELETE /api/clients/:id (cleanup)", async () => {
      const res = await request("DELETE", `/api/clients/${testClientId}`);
      if (res.status !== 200 && res.status !== 204)
        throw new Error(`Expected 200 or 204, got ${res.status}`);
    });
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(60)}`);
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total\n`);

  if (failed > 0) {
    console.log("Failed checks:");
    results
      .filter((r) => r.status === "FAIL")
      .forEach((r) => console.log(`  • ${r.name}: ${r.error}`));
    console.log("");
    process.exit(1);
  }

  console.log("All checks passed.\n");
  process.exit(0);
}

run().catch((err) => {
  console.error("Health check script crashed:", err);
  process.exit(1);
});
