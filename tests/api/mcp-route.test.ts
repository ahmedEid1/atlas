import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@clerk/mcp-tools/next", () => ({ verifyClerkToken: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(() => Promise.resolve({})),
  clerkClient: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: vi.fn() },
    run: { findMany: vi.fn(), findFirst: vi.fn() },
    runStep: { count: vi.fn() },
    claimCheck: { findMany: vi.fn() },
    mcpCall: { count: vi.fn(), create: vi.fn() },
  },
}));

import { verifyClerkToken } from "@clerk/mcp-tools/next";
import { db } from "@/lib/db";
import { POST } from "@/app/api/mcp/[transport]/route";

beforeEach(() => vi.clearAllMocks());

// mcp-handler's Streamable HTTP transport requires the client to advertise
// support for both application/json and text/event-stream per the MCP spec —
// without both, the server replies 406 Not Acceptable.
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/mcp/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });

// mcp-handler returns a (request: Request) => Promise<Response> handler that
// ignores Next.js's `{ params }` second arg — basePath is used internally for
// routing. So we call POST with just the request.
describe("POST /api/mcp/[transport]", () => {
  it("returns 401 with WWW-Authenticate header when no Authorization header", async () => {
    const res = await POST(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("returns the 3 registered tools on tools/list with a valid JWT", async () => {
    (verifyClerkToken as any).mockResolvedValue({
      token: "good-jwt",
      clientId: "client_test",
      scopes: ["profile", "email"],
      extra: { userId: "user_c1" },
    });
    (db.user.findUnique as any).mockResolvedValue({ id: "u1", clerkId: "user_c1" });

    const res = await POST(post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { authorization: "Bearer good-jwt" },
    ));
    expect(res.status).toBe(200);
    // Streamable HTTP transport responds as SSE (text/event-stream) by default;
    // the JSON-RPC payload is inside the `data:` line of the first event.
    const raw = await res.text();
    const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
    expect(dataLine, `expected an SSE data: line in response, got:\n${raw}`).toBeDefined();
    const body = JSON.parse(dataLine!.slice(5).trim());
    expect(body.result.tools.map((t: any) => t.name).sort()).toEqual(
      ["get_citation_audit", "get_review_draft", "list_reviews"],
    );
  });
});
