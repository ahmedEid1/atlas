# Thoth, week six: an authenticated MCP server, and the ibis

*The sixth post in a series documenting an open-source agentic literature-review platform.*

## What I shipped

- A remote MCP server at `https://thoth-slr.vercel.app/api/mcp/mcp`, speaking Streamable HTTP (the current spec), with **three read-only tools** scoped to the authenticated user: `list_reviews`, `get_review_draft`, `get_citation_audit`.
- **OAuth 2.1 + PKCE + Dynamic Client Registration via Clerk** — Thoth is the OAuth Resource Server, Clerk is the Authorization Server (RFC 8707 + OAuth 2.0 Protected Resource Metadata). No manual token paste anywhere in the flow.
- A **per-call audit log** in `McpCall`, with the input payload stored only as a SHA-256 hash. The raw user input is never persisted.
- **DB-backed sliding-window rate limits** per `(userId, toolName)` — no external Redis required.
- A listing in the **official MCP Registry** as `io.github.ahmedEid1/thoth`, published via `mcp-publisher` against a `server.json` manifest.
- A **rebrand**: the project that had been "Atlas" for the first five milestones became **Thoth**, with a Delapouite ibis mark across the logo, the hero, the favicon, and a tightened editorial visual identity.
- An **anonymous demo flow** at `/demo` that provisions a Clerk guest user with an `@example.com` email and signs the visitor straight into an empty dashboard, so anyone can build their own review without creating an account.

This is the milestone where Thoth became the thing I'd been describing to anyone who asked what I'd been working on.

## Why MCP, and why authenticated

Most public MCP servers ship with no auth. The MCP Registry has thousands of entries; many of them expose an unauthenticated stdio binary or a public HTTPS endpoint that anyone can call. That's understandable for stateless demo tools, and a security liability for anything that touches user data.

Thoth's MCP server returns *the user's own reviews and per-citation audit reports*. There is no version of this that's safe to expose without auth. So the M5 design starts from the question: "how does a remote MCP client get a bearer token without me writing my own OAuth Authorization Server?"

The answer turned out to be cleaner than I expected, thanks to two pieces of recent industry work:

1. **The MCP spec's Resource Server pattern.** A modern MCP server doesn't have to be its own OAuth server. It declares itself a Resource Server, publishes a `oauth-protected-resource` metadata document at `/.well-known/oauth-protected-resource/mcp`, and points clients at an external Authorization Server (Clerk, in my case). Clients discover the AS, do the OAuth dance there, come back with a bearer JWT, and the Resource Server validates the JWT against the AS's JWKS. RFC 8707 + OAuth 2.0 Protected Resource Metadata, both stable.
2. **Clerk's first-class MCP support.** `@clerk/mcp-tools` ships the helpers for the Resource Server pattern, including Dynamic Client Registration — the protocol that lets a brand-new MCP client (claude.ai, Cursor, MCP Inspector) register itself with Clerk on the fly. No manual client config, no per-client shared secret to distribute. The first time a user clicks "Connect to Thoth" in their MCP client, the client registers with Clerk, the user signs in to Clerk in their browser, Clerk issues a JWT, and the client has a bearer token. From the user's point of view: paste a URL, complete a browser sign-in, done.

The result is the demo I show in the README: a visitor pastes `https://thoth-slr.vercel.app/api/mcp/mcp` into claude.ai's custom connectors, signs in via Clerk in a popup, and calls `list_reviews` from inside a Claude conversation a few seconds later. End to end, no local install, no manual config.

## Three tools, read-only

The tool surface is small on purpose. M5's audience priority — locked during brainstorming — is **demo first**. A 3-tool surface ships in a day and a half; the original 6-tool design from the M1 spec would have taken three or four days and routed LLM cost onto demo traffic with no commensurate upside for the milestone's goals.

The three tools:

- **`list_reviews`** — returns the authenticated user's runs with status, critic score, and faithfulness score. The entry point.
- **`get_review_draft`** — given a run id, returns the full markdown draft with inline `[paper_id]` citations.
- **`get_citation_audit`** — given a run id, returns the per-claim `cite_check` verdict report: every citation, its claim, the cited paper id, the supported/partially/not-supported verdict, the justification.

All three are read-only. All three are tenant-scoped — the Clerk-authenticated `userId` is the only way data flows back; there is no path to read another user's reviews. No tool exposes LLM calls on the request path, which means casual traffic doesn't burn the free-tier Mistral quota.

The three tools are also the demo. `list_reviews` surfaces a review with low faithfulness; `get_citation_audit` shows Claude.ai which claims weren't supported by the cited paper. The whole "we built `cite_check` for a reason" narrative is a 30-second interaction in a Claude conversation.

## The audit log

Every MCP tool call writes a row to `McpCall`:

- `userId`, `toolName`, `requestedAt`, `latencyMs`, `httpStatus`
- `inputHash` — the SHA-256 of the JSON-serialised input
- `outputSize` — the byte size of the response
- `errorMessage` if applicable

What's not stored: the raw input payload. Auditing "user X called `get_review_draft` 47 times in the last hour" is what matters; storing the raw input is data the service doesn't need and shouldn't hold. The hash is enough to detect identical retries (e.g. for the rate-limit logic to identify pathological clients) and to anchor an audit trail without ever holding sensitive content.

The rate limit reads the same table: per `(userId, toolName)` sliding window, computed by SQL aggregate over rows in the last N seconds. No Redis dependency — Postgres handles it at this scale, and one less moving part in the deploy is one less thing to break.

## The MCP Registry submission

The MCP ecosystem has a public registry — analogous to npm, but for MCP servers. Listing there is the way new clients discover servers. Submitting required:

1. A `server.json` manifest at the repo root declaring the server name (`io.github.ahmedEid1/thoth`), the supported transports, the endpoint URL, the OAuth metadata URL, and the tool list.
2. Publishing via `mcp-publisher` — a CLI that validates the manifest, signs the submission against the GitHub repo (proving I own the namespace), and submits it to the registry.
3. A registry review and approval.

The listing is verifiable from the public registry API:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=thoth" | jq '.servers[0].server'
```

The status field is `active`. That's a third-party-verifiable proof on the README — anyone can run the curl and confirm.

## From Atlas to Thoth

The project shipped its first five milestones under the codename **Atlas**, which I'd picked because it was a placeholder I could live with for a few weeks. For the public surface — the production URL, the README, the social posts — the codename wasn't going to cut it. There are dozens of "Atlas"-something projects in the AI/data space; the name carries no signal.

The rebrand criteria were specific:

- A short, memorable proper noun.
- Symbolic fit with what the tool does (writing, scholarship, verification).
- Visual identity that doesn't lean on AI-stock-art (no neural networks, no purple-blue gradients, no robots).
- A logo I could ship as a single SVG without licensing risk.

**Thoth** — the ancient Egyptian ibis-headed god of writing, wisdom, and scribes — checked every box. The hieroglyph for "scribe" was literally an ibis. The name means "[he] is like the ibis." For a tool that drafts and verifies systematic literature reviews — the modern descendant of the work scribes did — the symbolic fit is direct.

The ibis mark is by [Delapouite](https://delapouite.com/), CC BY 3.0, via [game-icons.net](https://game-icons.net/1x1/delapouite/ibis.html). Single-color (Thoth blue, lapis lazuli `#1E3A8A`), papyrus gold as a quiet accent (`#C9A961`), no other ornamentation. The brand guide in [`docs/brand.md`](../brand.md) is explicit about what *not* to do: no papyrus textures, no hieroglyph dividers, no costume-party imagery. The brand carries via name and logo, not narrative.

All the production URLs moved to `thoth-slr.vercel.app`. The MCP registry slug is `io.github.ahmedEid1/thoth`. The git history still says Atlas in commits older than this milestone — I left that as-is, because rewriting history would have invalidated tags and broken external links.

## The anonymous demo flow

The other M5 surface worth covering is the anonymous demo. Anyone curious enough to click around the live app shouldn't have to fill out a sign-up form first.

The flow:

1. Visitor lands on `/`. Clicks "Try the demo."
2. `/api/demo/start` provisions a Clerk guest user with an `@example.com` email, returns a one-time handoff ticket.
3. The visitor is redirected to `/demo/handoff?ticket=...`, the only client component in the app. The client component exchanges the ticket for a Clerk session, signs the visitor into an empty dashboard.
4. From the visitor's point of view: click, half-second redirect, signed in, ready to build a review.

A guest cleanup task (`trigger/guest-cleanup.ts`, every 6 hours) drops guest accounts older than 24 hours along with their projects and corpus items. The free tier on Clerk + Neon + R2 stays within free-tier limits without manual gardening.

There's deliberately no pre-cloned sample data in the demo dashboard. I considered seeding it with a worked review of the ReAct paper so visitors could see the end state immediately, and decided against: the more interesting interaction is uploading a small PDF and watching the agent loop run. The visitor's own paper, in their own session, is more memorable than a canned demo on a paper they don't know.

## What's next: M6

The platform is built, the quality is measured, the interface is published. M6 is the **release** milestone:

- A 30-question golden eval set drawn from real published Kitchenham reviews (replacing the 10-question synthetic v1).
- A one-page overview linking to the live app, the public evals, the MCP demo, and the registry listing.

The engineering work is mostly done. What's left is making the project legible to people who aren't going to read the codebase — which is its own discipline.

---

*Spec: [`docs/superpowers/specs/thoth-design.md`](../superpowers/specs/thoth-design.md). Build order: [`docs/superpowers/plans/thoth-roadmap.md`](../superpowers/plans/thoth-roadmap.md). Live MCP endpoint: `https://thoth-slr.vercel.app/api/mcp/mcp`.*
