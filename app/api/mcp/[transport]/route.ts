import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { auth } from "@clerk/nextjs/server";
import { verifyClerkToken } from "@clerk/mcp-tools/next";
import { db } from "@/lib/db";
import { MCP_TOOLS } from "@/lib/mcp/tools";

const baseHandler = createMcpHandler(
  (server) => {
    for (const tool of MCP_TOOLS) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          // MCP spec 2025-11-25 ToolAnnotations: behaviour hints clients use
          // for UX (auto-approval, danger badges, etc.). Verified against
          // @modelcontextprotocol/sdk 1.29.0 — registerTool's config object
          // accepts an `annotations?: ToolAnnotations` field directly.
          annotations: tool.annotations,
        },
        async (input: unknown, extra: { authInfo?: { extra?: unknown } }) => {
          const ctx = extra?.authInfo?.extra as { userId: string; clerkId: string } | undefined;
          if (!ctx) {
            return { isError: true, content: [{ type: "text", text: '{"error":"unauthorized"}' }] };
          }
          return tool.handler(input, ctx) as Promise<{
            content: Array<{ type: "text"; text: string }>;
            isError?: boolean;
          }>;
        },
      );
    }
  },
  { serverInfo: { name: "thoth", version: "0.7.0" }, capabilities: { tools: {} } },
  { basePath: "/api/mcp", maxDuration: 60, verboseLogs: process.env.NODE_ENV !== "production" },
);

const authedHandler = withMcpAuth(
  baseHandler,
  async (_req, token) => {
    if (!token) return undefined;
    const clerkAuth = await auth({ acceptsToken: "oauth_token" });
    const verified = await verifyClerkToken(clerkAuth, token);
    const fromExtra = verified?.extra?.userId;
    const clerkUserId = typeof fromExtra === "string" ? fromExtra : null;
    if (!clerkUserId) return undefined;
    const user = await db.user.findUnique({ where: { clerkId: clerkUserId } });
    if (!user) return undefined;
    // Returned object becomes extra.authInfo on the MCP tool handler's second arg.
    return {
      token,
      clientId: "mcp",
      scopes: ["profile", "email"],
      extra: { userId: user.id, clerkId: clerkUserId },
    };
  },
  {
    required: true,
    resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
  },
);

export { authedHandler as GET, authedHandler as POST, authedHandler as DELETE };
