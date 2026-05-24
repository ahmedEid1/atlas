# Atlas

> Agentic systematic literature reviews with verifiable citations.

**Live app:** https://atlas-sooty-delta.vercel.app · **Public evals:** https://atlas-sooty-delta.vercel.app/evals · **MCP endpoint:** `https://atlas-sooty-delta.vercel.app/api/mcp/mcp`

Atlas turns a research question and a corpus of PDFs into an evidence-grounded literature review. A multi-step LangGraph agent (planner → retriever → assessor → drafter → critic) reads the papers, drafts the review, and runs a `cite_check` post-pass that verifies every cited claim against the source paper — flagging hallucinated citations before the user reads the draft.

![Atlas MCP demo — Claude.ai catching 6 fabricated citations via cite_check](docs/assets/m5-mcp-demo.gif)

*Claude.ai connected to Atlas via the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=atlas-research). After `list_reviews` surfaces a review with faithfulness 0.13, Claude calls `get_citation_audit` and identifies all 6 unsupported claims — every one citing the same paper, with invented percentages that aren't in the source. Try it: [Connect via MCP](#connect-via-mcp).*

## Verified engineering proofs

| | |
|---|---|
| **Live app** | [atlas-sooty-delta.vercel.app](https://atlas-sooty-delta.vercel.app) (Clerk sign-in) |
| **Public eval dashboard** | [`/evals`](https://atlas-sooty-delta.vercel.app/evals) — recall/precision/faithfulness/coverage over a versioned golden set |
| **Official MCP Registry entry** | [`io.github.ahmedEid1/atlas-research`](https://registry.modelcontextprotocol.io/v0.1/servers?search=atlas-research) — `status: active` |
| **Tests** | 199 unit + 3 live e2e MCP smoke checks, all green; tsc + lint clean |
| **Audit log** | Every MCP tool call recorded in `McpCall` with SHA-256 input hash; no raw input ever stored |
| **Deploy cost** | $0 / month (Vercel + Neon + Cloudflare R2 + Langfuse Cloud + Trigger.dev Cloud — all free tiers) |
| **Self-host fallback** | One-VM deploy on Oracle Cloud Always Free (4 ARM cores, 24 GB RAM) — [`docs/self-host/`](docs/self-host/oracle-cloud-quickstart.md) |
| **Status** | `v0.7.0-m5` shipped 2026-05-24 · M6 (30-question eval set + public launch) next |

## What makes Atlas different

1. **`cite_check` post-pass.** Every `[paper_id]` citation in the generated draft is verified against the cited paper before the user reads the draft. The MCP demo above shows Claude.ai using this audit to identify 6 hallucinated statistics in a real SLR draft on the ReAct paper.
2. **Authenticated, registered MCP server.** Most public MCP servers ship with no auth. Atlas uses OAuth 2.1 + PKCE + Dynamic Client Registration via Clerk (resource-server pattern, RFC 8707), with SHA-256 audit logs and DB-backed sliding-window rate limits. Listed in the official MCP Registry; works in claude.ai, Claude Desktop (via `mcp-remote`), Cursor, and MCP Inspector.
3. **Public eval dashboard tied to main.** Every commit can run the agent against a versioned golden set; results render at `/evals`. Designed so an eval regression is a public signal, not a hidden one.
4. **6 LLM providers, `$0` default.** Switch providers via one env var (`LLM_PROVIDER=mistral|groq|gemini|anthropic|openai|claude-agent`); Mistral free tier is the default. Local eval runs can use a Claude Max subscription via `@anthropic-ai/claude-agent-sdk` without an API key.

## Connect via MCP

Atlas ships an authenticated MCP server at `https://atlas-sooty-delta.vercel.app/api/mcp/mcp` — paste this URL into claude.ai (Pro/Max), Claude Desktop, Cursor, or any MCP-compatible client. OAuth flow runs in your browser (powered by Clerk + Dynamic Client Registration); you never copy-paste a token.

**Listed in the official [MCP Registry](https://registry.modelcontextprotocol.io)** as `io.github.ahmedEid1/atlas-research`. Verify independently with:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=atlas-research" | jq '.servers[0].server'
```

**Available tools** (all read-only, all scoped to your Atlas account):
- `list_reviews` — list your Atlas reviews with critic + faithfulness scores
- `get_review_draft` — fetch the markdown draft of a completed review
- `get_citation_audit` — fetch the per-claim cite_check verdict report

See [`docs/mcp/tools.md`](docs/mcp/tools.md) for the full tool reference and [`docs/mcp/security.md`](docs/mcp/security.md) for the auth + audit model.

**Setting it up** in claude.ai (Pro/Max — Connectors → Add custom connector → paste the URL → OAuth via Clerk + DCR, no manual client config needed):

![Adding Atlas as a custom MCP connector in claude.ai](docs/assets/m5-mcp-setup.gif)

## Stack

| Layer | Choice |
|---|---|
| App | Next.js 16 + TypeScript (strict) |
| UI | Tailwind v4 + shadcn/ui (`@base-ui/react`) + Lucide |
| Auth | Clerk (web sessions + OAuth 2.1 + DCR for MCP) |
| DB | Postgres 17 + Prisma v7 (driver adapter `@prisma/adapter-neon`) |
| Object store | S3-compatible (Cloudflare R2 in prod, MinIO local) |
| Background jobs | Trigger.dev v4 |
| Agent framework | LangGraph (TypeScript) |
| LLM dispatch | Vercel AI SDK over 6 providers (see [LLM provider](#llm-provider)) |
| PDF parsing | Mistral OCR API |
| Observability | Langfuse Cloud (OpenTelemetry exporter via `langfuse-vercel` + `@vercel/otel`) |
| MCP server | `mcp-handler` + `@clerk/mcp-tools` + `@modelcontextprotocol/sdk` |
| Tests | Vitest (unit/integration) + Playwright (e2e smoke against live deploy) |
| Deploy | Vercel + Neon (Frankfurt) + Cloudflare R2 + Langfuse Cloud + Trigger.dev Cloud |
| Self-host | docker-compose on Oracle Cloud Always Free — [`infra/self-host/`](infra/self-host/) |

## Quickstart

```bash
git clone https://github.com/ahmedEid1/atlas.git
cd atlas
cp .env.example .env       # fill in Clerk + Trigger.dev keys + MISTRAL_API_KEY
docker compose up -d       # postgres :5433, minio :9010/:9011, langfuse :3030
pnpm install
pnpm prisma migrate dev
pnpm dev                   # Next.js on :3000
pnpm dev:trigger           # Trigger.dev worker (separate terminal)
```

See [`.env.example`](.env.example) for the full env-var list. Non-obvious ones: `S3_FORCE_PATH_STYLE=true` for MinIO; `CLERK_WEBHOOK_SIGNING_SECRET` only when wiring Clerk's webhook in prod.

## Tests

```bash
pnpm test                                                                # 199 unit/integration tests
PLAYWRIGHT_BASE_URL=https://atlas-sooty-delta.vercel.app pnpm playwright test tests/e2e/mcp-smoke.spec.ts  # 3 live e2e
pnpm tsx scripts/verify-mcp-audit.ts                                     # spot-check the McpCall audit log
```

## LLM provider

Atlas uses [Vercel AI SDK](https://ai-sdk.dev) so you can swap providers via a single env var.

| Provider  | Free? | Setup                                         | Env var                          |
|-----------|-------|-----------------------------------------------|----------------------------------|
| **Mistral** (default) | ✅ Free Experiment tier | https://console.mistral.ai (30s) | `MISTRAL_API_KEY` |
| Groq      | ✅ Free | https://console.groq.com                       | `GROQ_API_KEY`                   |
| Gemini    | ✅ Free* | https://aistudio.google.com                   | `GOOGLE_GENERATIVE_AI_API_KEY`   |
| Anthropic | Paid  | https://console.anthropic.com                  | `ANTHROPIC_API_KEY`              |
| OpenAI    | Paid  | https://platform.openai.com                    | `OPENAI_API_KEY`                 |
| Claude Agent SDK | ✅ Free with Max | `claude login` (Claude Code CLI)      | (CLI session — no key)           |

*Gemini Flash has a known parse issue with Vercel AI SDK structured output ([vercel/ai#12187](https://github.com/vercel/ai/issues/12187)) — usable but unreliable for Atlas's per-call Zod schemas. Mistral is the default specifically because it's the most reliable free option for this workload.

Switch with `LLM_PROVIDER=<name>` in `.env`. Tier choice (`smart`/`fast`) per prompt stays the same — the dispatcher maps each tier to the equivalent model per provider (see `lib/llm/tiers.ts`).

## Self-host alternative

Don't want to depend on Vercel + Neon + R2 + Langfuse Cloud? See [`docs/self-host/oracle-cloud-quickstart.md`](docs/self-host/oracle-cloud-quickstart.md) for a step-by-step walkthrough to deploy Atlas on **Oracle Cloud's Always Free** tier (4-core ARM Ampere A1 + 24 GB RAM, free forever). One VM runs Atlas + Postgres + MinIO + Langfuse behind Caddy with auto-TLS; you still use a hosted LLM API (Mistral free tier, or any of the 6 supported providers). Total recurring cost: **$0/month + ~€10/yr domain**. Config under [`infra/self-host/`](infra/self-host/).

## Built with spec-driven development

Every milestone is specified, planned, and reviewed before code. Specs live under [`docs/superpowers/specs/`](docs/superpowers/specs/); per-milestone TDD plans under [`docs/superpowers/plans/`](docs/superpowers/plans/). The release checklist is at [`RELEASING.md`](RELEASING.md).

## Roadmap & changelog

- ~~**M1** — Workspace foundation~~ ✅ `v0.1.0-m1` — Clerk auth, Prisma v7, S3 object store, PDF upload + Trigger.dev parse task
- ~~**M2** — Summarisation + Langfuse observability~~ ✅ `v0.2.0-m2` — `lib/llm.ts` wrapper, `summarize-paper` task, trace per call
- ~~**M3** — Full agent loop + HITL~~ ✅ `v0.3.0-m3` — LangGraph state machine + Trigger.dev durability + approve-plan / approve-papers gates
- ~~**M3.5a** — LLM provider abstraction~~ ✅ `v0.3.5-m3.5a` — Vercel AI SDK dispatcher, 4-provider adapters, tier mapping
- ~~**M3.5b** — Cloud deploy ($0)~~ ✅ `v0.3.6-m3.5b` — Vercel + Neon + R2 + Langfuse Cloud + Trigger.dev Cloud + Clerk Cloud
- ~~**M3.5c** — Self-host fallback~~ ✅ `v0.6.0-m3.5c` — Oracle Cloud Always Free walkthrough + `infra/self-host/`
- ~~**M4a** — Critic + cite_check~~ ✅ `v0.4.0-m4a` — LLM-as-judge critic loop + per-citation verification post-pass + `ClaimCheck` table
- ~~**M4b** — Eval harness + public `/evals`~~ ✅ `v0.4.1-m4b` — Headless graph runner, 4 metrics, public dashboard, regression gate
- ~~**v0.4.2** — Claude Agent SDK provider~~ ✅ — Free programmatic Claude via Code CLI session (no API key), for local eval baselines
- ~~**v0.5.0** — Trigger.dev Cloud production deploy~~ ✅ — All 3 background tasks on managed infra
- ~~**v0.5.1** — First live end-to-end review on prod~~ ✅ — Real PDF (ReAct paper) → full SLR pipeline → completed draft + critic + cite_check
- ~~**v0.7.0-m5** — Authenticated MCP server~~ ✅ — Streamable HTTP at `/api/mcp/mcp`, OAuth 2.1 + PKCE + DCR via Clerk, 3 read-only tools, audit log + rate limits, published to the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=atlas-research) as `io.github.ahmedEid1/atlas-research`
- **M6** (next) — 30-question real-paper golden eval set, recruiter 1-pager, public launch (HN / LinkedIn / Twitter)

## License

MIT
