import { auth } from "@clerk/nextjs/server";
import { verifyClerkToken } from "@clerk/mcp-tools/next";
import { db } from "@/lib/db";

export type McpUserCtx = {
  userId: string;        // Atlas User.id (local cuid)
  clerkId: string;       // Clerk user id (subject of JWT)
};

export class McpAuthError extends Error {
  constructor(public reason: "invalid_token" | "user_not_found") {
    super(reason);
    this.name = "McpAuthError";
  }
}

/**
 * Verify a Clerk OAuth JWT and resolve it to an Atlas User.
 * Throws McpAuthError on any failure — caller is responsible for
 * returning a 401 with the correct WWW-Authenticate header.
 *
 * Wired into mcp-handler's withMcpAuth: the second argument to
 * withMcpAuth is (request, token) => Promise<extraData>; we return
 * { userId, clerkId } so tool handlers can read it from extra.
 */
export async function resolveMcpUser(token: string): Promise<McpUserCtx> {
  let clerkUserId: string | null;
  try {
    const clerkAuth = await auth({ acceptsToken: "oauth_token" });
    const verified = await verifyClerkToken(clerkAuth, token);
    const fromExtra = verified?.extra?.userId;
    clerkUserId = typeof fromExtra === "string" ? fromExtra : null;
  } catch {
    throw new McpAuthError("invalid_token");
  }

  if (!clerkUserId) throw new McpAuthError("invalid_token");

  const user = await db.user.findUnique({ where: { clerkId: clerkUserId } });
  if (!user) throw new McpAuthError("user_not_found");

  return { userId: user.id, clerkId: clerkUserId };
}
