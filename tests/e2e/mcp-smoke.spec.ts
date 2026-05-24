import { test, expect } from "@playwright/test";

/**
 * Smoke test for the MCP server on the live deploy.
 * Run with: pnpm playwright test tests/e2e/mcp-smoke.spec.ts --project=chromium
 *
 * Required env (none for the unauthenticated path):
 *  - PLAYWRIGHT_BASE_URL or defaults to https://atlas-sooty-delta.vercel.app
 *
 * The authenticated tool-call path is covered by the manual smoke in
 * RELEASING.md (Task 14) — using a Clerk testing JWT requires more
 * setup than this smoke is worth.
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://atlas-sooty-delta.vercel.app";

test("MCP /api/mcp/mcp returns 401 with proper WWW-Authenticate header when no auth", async ({ request }) => {
  const res = await request.post(`${BASE}/api/mcp/mcp`, {
    headers: {
      "content-type": "application/json",
      // Streamable HTTP transport requires both media types in Accept
      accept: "application/json, text/event-stream",
    },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(401);
  const wwwAuth = res.headers()["www-authenticate"] ?? "";
  expect(wwwAuth).toContain("Bearer");
  expect(wwwAuth).toContain("resource_metadata");
});

test("Protected Resource Metadata endpoint is publicly readable", async ({ request }) => {
  const res = await request.get(`${BASE}/.well-known/oauth-protected-resource/mcp`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.authorization_servers).toBeDefined();
  expect(Array.isArray(body.authorization_servers)).toBe(true);
  expect(body.authorization_servers.length).toBeGreaterThan(0);
});

test("Authorization Server Metadata advertises a registration_endpoint (DCR is on)", async ({ request }) => {
  const res = await request.get(`${BASE}/.well-known/oauth-authorization-server`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(
    body.registration_endpoint,
    "DCR endpoint missing — enable Dynamic Client Registration in Clerk Dashboard",
  ).toBeTruthy();
});
