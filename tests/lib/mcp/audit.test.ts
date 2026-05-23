import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("@/lib/db", () => ({
  db: { mcpCall: { create: vi.fn() } },
}));

import { db } from "@/lib/db";
import { logMcpCall, canonicalJson, hashInput } from "@/lib/mcp/audit";

beforeEach(() => vi.clearAllMocks());

describe("canonicalJson", () => {
  it("sorts object keys for stable hashing", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it("recurses into nested objects", () => {
    expect(canonicalJson({ b: { y: 1, x: 2 }, a: 1 })).toBe('{"a":1,"b":{"x":2,"y":1}}');
  });
  it("preserves array order", () => {
    expect(canonicalJson({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });
});

describe("hashInput", () => {
  it("is deterministic", () => {
    expect(hashInput({ a: 1, b: 2 })).toBe(hashInput({ b: 2, a: 1 }));
  });
  it("returns a 64-char hex string (SHA-256)", () => {
    const h = hashInput({ x: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(createHash("sha256").update('{"x":1}').digest("hex"));
  });
});

describe("logMcpCall", () => {
  it("writes OK row with input hash and no reviewId", async () => {
    await logMcpCall({
      userId: "u1", toolName: "list_reviews", input: {},
      status: "OK", latencyMs: 12,
    });
    expect(db.mcpCall.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "u1", toolName: "list_reviews",
        inputHash: hashInput({}), reviewId: null,
        status: "OK", errorCode: null, latencyMs: 12,
      }),
    });
  });

  it("extracts reviewId from input when present", async () => {
    await logMcpCall({
      userId: "u1", toolName: "get_review_draft",
      input: { reviewId: "r123" }, status: "OK", latencyMs: 5,
    });
    expect(db.mcpCall.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ reviewId: "r123" }),
    });
  });

  it("writes ERROR row with errorCode", async () => {
    await logMcpCall({
      userId: "u1", toolName: "list_reviews", input: {},
      status: "ERROR", errorCode: "rate_limited", latencyMs: 0,
    });
    expect(db.mcpCall.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "ERROR", errorCode: "rate_limited" }),
    });
  });

  it("does NOT throw when db.create fails", async () => {
    (db.mcpCall.create as any).mockRejectedValue(new Error("DB down"));
    await expect(logMcpCall({
      userId: "u1", toolName: "list_reviews", input: {},
      status: "OK", latencyMs: 1,
    })).resolves.toBeUndefined();
  });
});
