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
  {
    // The MCP SDK 1.29.0 Implementation schema accepts title, description,
    // websiteUrl, and icons[] alongside the required name + version.
    // mcp-handler 1.1.0's type is narrower (just name + version) but it
    // passes the object through to McpServer unchanged, so the extra
    // fields reach clients that read them (claude.ai's connector card
    // shows the icon + title; older clients drop the unknown fields
    // silently). The `as never` cast bridges mcp-handler's narrow type
    // to the SDK's actual schema without re-typing the whole config.
    serverInfo: {
      name: "thoth",
      version: "1.0.1",
      title: "Thoth — Agentic SLR",
      description:
        "Authenticated MCP server for systematic literature reviews with verified citations. Surfaces your Thoth reviews + per-claim cite_check audits.",
      websiteUrl: "https://thoth-slr.vercel.app",
      icons: [
        {
          src: "https://thoth-slr.vercel.app/icon.svg",
          mimeType: "image/svg+xml",
        },
      ],
    } as never,
    capabilities: { tools: {} },
  },
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
