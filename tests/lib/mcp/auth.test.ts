import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
  clerkClient: vi.fn(),
}));
vi.mock("@clerk/mcp-tools/next", () => ({
  verifyClerkToken: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: vi.fn(), create: vi.fn() },
  },
}));

import { auth } from "@clerk/nextjs/server";
import { verifyClerkToken } from "@clerk/mcp-tools/next";
import { db } from "@/lib/db";
import { resolveMcpUser, McpAuthError } from "@/lib/mcp/auth";

beforeEach(() => vi.clearAllMocks());

describe("resolveMcpUser", () => {
  it("returns Atlas User.id when JWT is valid and user exists", async () => {
    vi.mocked(auth).mockResolvedValue({ tokenType: "oauth_token" } as never);
    vi.mocked(verifyClerkToken).mockResolvedValue({ token: "t", clientId: "c", scopes: ["profile","email"], extra: { userId: "user_clerk_abc" } } as never);
    vi.mocked(db.user.findUnique).mockResolvedValue({ id: "atlas_user_xyz", clerkId: "user_clerk_abc" } as never);

    const ctx = await resolveMcpUser("fake-jwt");

    expect(ctx).toEqual({ userId: "atlas_user_xyz", clerkId: "user_clerk_abc" });
  });

  it("throws McpAuthError when verifyClerkToken returns null subject", async () => {
    vi.mocked(auth).mockResolvedValue({} as never);
    vi.mocked(verifyClerkToken).mockResolvedValue({ token: "t", clientId: "c", scopes: [], extra: {} } as never);

    await expect(resolveMcpUser("bad-jwt")).rejects.toBeInstanceOf(McpAuthError);
  });

  it("throws McpAuthError when local User row is missing (webhook race)", async () => {
    vi.mocked(auth).mockResolvedValue({} as never);
    vi.mocked(verifyClerkToken).mockResolvedValue({ token: "t", clientId: "c", scopes: ["profile","email"], extra: { userId: "user_clerk_new" } } as never);
    vi.mocked(db.user.findUnique).mockResolvedValue(null as never);

    await expect(resolveMcpUser("jwt")).rejects.toBeInstanceOf(McpAuthError);
  });

  it("throws McpAuthError when verifyClerkToken throws", async () => {
    vi.mocked(auth).mockResolvedValue({} as never);
    vi.mocked(verifyClerkToken).mockRejectedValue(new Error("expired") as never);

    await expect(resolveMcpUser("expired-jwt")).rejects.toBeInstanceOf(McpAuthError);
  });
});
