# Atlas MCP — Security & Auth Model

Most MCP servers in the wild today ship with no authentication. Atlas
ships with OAuth 2.1, PKCE, Dynamic Client Registration, and an audit
log. Here's how the pieces fit together.

## Auth: OAuth 2.1 with Clerk as the Authorization Server

Per the MCP spec (2025-11-25), Atlas's MCP server is a **Resource
Server**. The Authorization Server is **Clerk**.

```
Claude Desktop                     Atlas /api/mcp/mcp           Clerk
     │ POST /api/mcp/mcp (no token)            │                  │
     ├────────────────────────────────────────►│ 401              │
     │                                          │ WWW-Authenticate:│
     │                                          │ Bearer           │
     │                                          │ resource_metadata│
     │ GET /.well-known/...protected-resource/mcp                  │
     ├────────────────────────────────────────►│                  │
     │ {authorization_servers: [clerk...]}     │                  │
     │ GET .../authorization-server            │                  │
     ├────────────────────────────────────────►│ → proxy ──────►  │
     │ {registration_endpoint, ...}            │  ◄───────────────│
     │ Dynamic Client Registration             │                  │
     ├──────────────────────────────────────────────────────────► │
     │ Browser-based consent + PKCE auth code                     │
     ├══════════════════════════════════════════════════════════► │
     │ Exchange code → JWT                                         │
     ├──────────────────────────────────────────────────────────► │
     │ POST /api/mcp/mcp Authorization: Bearer JWT                │
     ├────────────────────────────────────────►│ verify via JWKS  │
     │ tool result                              │                  │
     │◄────────────────────────────────────────┤                  │
```

What you (the user) actually do: paste the Atlas MCP URL into Claude
Desktop's "Connect MCP server" dialog → a browser pops → sign into Atlas
(Clerk) → done. No tokens to copy-paste.

## Audit log

Every tool invocation writes one row to the `McpCall` table:

| Column | Notes |
|---|---|
| `userId` | Atlas internal id (Clerk user id is stored only on `User.clerkId`) |
| `toolName` | `list_reviews` / `get_review_draft` / `get_citation_audit` |
| `inputHash` | SHA-256 of canonical-JSON of the input — **raw input is never stored** |
| `reviewId` | Copied from input when present, for query convenience |
| `status` | `OK` or `ERROR` |
| `errorCode` | `invalid_input` / `not_found` / `rate_limited` / `internal` / null |
| `latencyMs` | wall-clock duration |
| `createdAt` | timestamp |

Failed audit writes never fail the user's request — they're logged to
stderr and ignored. (Spec §3.3.3 calls for emitting a Langfuse span on
audit-write failure; that integration is deferred to v1.1. Audit-write
failure rate in v0.7.x will surface in Vercel logs.)

## Rate limits

DB-backed sliding window over `McpCall`. No Redis dependency.

| Scope | Limit | Window |
|---|---|---|
| Per user, all tools | 60 | 60 seconds |
| Per user, per tool | 30 | 60 seconds |
| Per user, daily total | 1000 | 24 hours |

When a limit is hit, the tool call returns an `isError: true` MCP
response with body `{"error":"rate_limited","retryAfter":<seconds>}`.
This is at the JSON-RPC tool layer, NOT the HTTP layer — the HTTP status
remains 200 because mcp-handler reserves non-200 for transport-level
failures per the MCP spec. Clients should read `retryAfter` from the
tool result body. Rate-limited responses are themselves written to
McpCall (status=ERROR, errorCode=rate_limited), so they count toward
the user's window — preventing a spam-the-limit loophole.

## Authorization

Tools never accept `userId` as input — it always comes from the
validated Clerk JWT. Database queries are scoped at the type level
(`WHERE project.ownerId = ctx.userId`). Cross-user data leakage is
impossible by construction.

For "you don't own this" cases we return `404 not_found`, not `403
forbidden` — this prevents existence-probing of other users' reviews.

## What we deliberately don't do

- **No per-IP limit** — Clerk identity is the unit of trust; IPs add noise.
- **No global rate limit** — would slow legit traffic to protect against a problem we don't have. Add if observed.
- **No raw input in logs** — only SHA-256 of canonical-JSON.
- **No CAPTCHA** — Clerk's sign-up flow handles bot signups.

## Reporting a security issue

Please open a GitHub issue marked `[security]` on
[github.com/ahmedEid1/atlas](https://github.com/ahmedEid1/atlas).
