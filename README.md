# Atlas

> A GDPR-safe agentic workspace for systematic literature reviews.

**🚀 Live demo: https://atlas-sooty-delta.vercel.app**

Atlas turns a research question and a corpus of PDFs into an evidence-grounded literature review. It uses a multi-step agent (LangGraph, planner → retriever → assessor → drafter → critic) with tool use, human-in-the-loop gates, and a `cite_check` post-pass that verifies every citation against the source paper.

**Status:** M1 — workspace foundation. Full design spec: [`docs/superpowers/specs/2026-05-22-atlas-design.md`](docs/superpowers/specs/2026-05-22-atlas-design.md).

## Shipped

### M1 — Foundation (`v0.1.0-m1`)
- Clerk auth (v7 `<Show>` API, `proxy.ts` middleware for Next 16, webhook handler)
- Prisma v7 schema (driver adapter `@prisma/adapter-pg`, `prisma.config.ts`)
- S3-compatible object store helper (MinIO local, swap endpoint for prod)
- PDF upload endpoint with mime/size validation and owner-scoped access
- Durable `parse-pdf` task on Trigger.dev v4 wrapping marker-pdf
- Minimal UI: dashboard, project workspace, corpus list with status polling

### M2 — Summarisation + Observability (`v0.2.0-m2`)
- Self-hosted Langfuse stack (Postgres + ClickHouse + Redis + MinIO), bootstrapped via `LANGFUSE_INIT_*` so dev keys are deterministic
- `lib/llm.ts` — the single wrapper for every Claude call: adaptive thinking, Zod-validated structured output via `output_config.format`, prompt caching, Langfuse trace per call
- `summarize-paper` Trigger.dev task producing a structured summary (abstract, research questions, methodology, key findings, limitations, study type, SLR relevance)
- UI: per-corpus-item Summarise button → structured summary card with trace link
- 28 tests passing

### M3 — Agent Loop + HITL (`v0.3.0-m3`)
- LangGraph state machine: planner → retriever → assessor → drafter, with two HITL gates (approve plan, approve papers)
- Trigger.dev `run-review` task wraps the graph for durability: `interrupt()` produces a checkpoint, `wait.forToken()` pauses the worker, the UI approves to resume
- Schema: Run, RunStep, HumanCheckpoint, IncludedPaper, ExtractedClaim
- UI: Start Review button on project page; live run workspace with progress, plan-approval card, papers-approval checklist, and rendered draft review
- All four agent nodes go through the M2 `runLLM` wrapper — same Langfuse trace per call, same Zod validation, same cost capture
- 70 tests passing

### M3.5a — LLM provider abstraction (`v0.3.5-m3.5a`)
- `lib/llm.ts` rewritten as a provider-agnostic dispatcher over the Vercel AI SDK (`generateObject`)
- Four provider adapters: **Gemini (default, free)**, Anthropic, OpenAI, Groq — swap via single `LLM_PROVIDER` env var
- Tier abstraction (`smart` / `fast`) maps per-provider in `lib/llm/tiers.ts`
- All 5 prompt builders moved to provider-neutral types (`{ system: string, messages: ModelMessage[] }`)
- Langfuse tracing via OpenTelemetry exporter (`langfuse-vercel` + `@vercel/otel`)
- 88 tests passing, zero real LLM calls (all mocked), tsc clean

### M3.5b — Cloud deploy (`v0.3.6-m3.5b`)
- **Live at https://atlas-sooty-delta.vercel.app** (Vercel Hobby, free tier)
- **Neon Postgres** (eu-central-1 / Frankfurt) replaces local Docker — `@prisma/adapter-neon` for serverless connections
- **Cloudflare R2** (10 GB free, zero egress fees) replaces MinIO — zero code change to `lib/object-store.ts`, only env values flipped
- **Langfuse Cloud** (50K observations/mo free) replaces self-hosted stack
- **Trigger.dev Cloud** for background jobs (500K runs/mo free)
- **Clerk Cloud** webhook live (signed `user.created` events sync to Neon)
- 3 verification smoke scripts in `scripts/` (gemini, neon, r2, langfuse) — all re-runnable
- `postinstall: prisma generate` ensures the Vercel build picks up the generated client
- **Monthly cost: $0**

### M4a — Critic + cite_check (`v0.4.0-m4a`)
- Critic node after drafter (LLM-as-judge, 4-axis rubric, up to 2 revision iterations)
- cite_check post-pass: verifies every `[paper_id]` citation in the final draft against the cited paper's summary
- New `ClaimCheck` table + `Run.critiqueScore` + `Run.faithfulnessScore` aggregates
- UI: critic-score badge + citation-faithfulness widget with expandable per-citation verdicts
- 119+ tests passing, all mocked, tsc + lint clean

### M4b — Eval harness + public dashboard (`v0.4.1-m4b`)
- 3 hand-curated synthetic golden SLR questions in `evals/golden/*.yaml` (10-question target deferred to v0.4.2-m4b-expand)
- Headless graph runner (`lib/eval/headless-runner.ts`) drives Atlas's M3+M4a LangGraph in-process with auto-approved HITL
- 4 metrics: citation recall, citation precision, claim faithfulness, expected-claim coverage
- GitHub Actions: runs on push + nightly cron at 03:00 UTC
- Regression gate: CI fails if any metric drops >10% vs the last main-branch run
- **Public dashboard live at https://atlas-sooty-delta.vercel.app/evals** (empty-state until upstream LLM-SDK issue is resolved or a non-Gemini provider is configured; see [evals/README.md](evals/README.md))
- 148+ tests passing

### M4b+ — Claude Agent SDK provider + first live eval baseline (`v0.4.2-claude-agent-provider`)
- New `LLM_PROVIDER=claude-agent` routes Atlas through `@anthropic-ai/claude-agent-sdk`, inheriting your local `claude` CLI session auth — **$0 with a Claude Max subscription, no `ANTHROPIC_API_KEY` required**
- Adapter at `lib/llm/providers/claude-agent.ts` uses Zod v4's `z.toJSONSchema()` + strict output-contract prompt
- Local-dev only (CI containers have no CLI auth — production stays on Groq)
- **First live eval baseline populated**: 8 EvalRun rows in Neon (4 metrics × 2 of 3 goldens) — dashboard now shows real data
- 155 tests passing, $0 spend

## Stack

| Layer | Choice |
|---|---|
| App | Next.js 16 + TypeScript (strict) |
| UI | Tailwind v4 + shadcn/ui (base-nova / `@base-ui/react`) + Lucide |
| Auth | Clerk |
| DB | Postgres 16 + Prisma v7 (`prisma-client` generator + `@prisma/adapter-pg`) |
| Object store | S3-compatible (MinIO locally, swap endpoint for prod) |
| Background jobs | Trigger.dev v4 (`@trigger.dev/sdk`) |
| PDF parsing | Mistral OCR API (`lib/pdf-parse.ts`) — replaced marker-pdf in v0.5.x |
| Tests | Vitest (unit/integration) + Playwright (e2e) |
| Local dev orchestration | docker-compose |
| Deploy (cloud, default) | Vercel + Neon + Cloudflare R2 + Langfuse Cloud + Trigger.dev Cloud — all free tiers |
| Deploy (self-host alternative) | Single Oracle Cloud Ampere A1 VM via [`infra/self-host/`](infra/self-host/) — see [self-host quickstart](docs/self-host/oracle-cloud-quickstart.md) |

## Quickstart

```bash
git clone https://github.com/ahmedEid1/atlas.git
cd atlas
cp .env.example .env       # fill in Clerk + Trigger.dev keys
docker compose up -d       # postgres :5433, minio :9010/:9011, langfuse :3030
pnpm install
pnpm prisma migrate dev
pnpm dev                   # Next.js on :3000 (or :3001 if 3000 is taken)
pnpm dev:trigger           # Trigger.dev worker (separate terminal)
```

## Self-host alternative

Don't want to depend on Vercel + Neon + R2 + Langfuse Cloud? See
[`docs/self-host/oracle-cloud-quickstart.md`](docs/self-host/oracle-cloud-quickstart.md)
for a step-by-step walkthrough to deploy Atlas on **Oracle Cloud's Always Free** tier
(4-core ARM Ampere A1 + 24 GB RAM, free forever). One VM runs Atlas + Postgres +
MinIO + Langfuse behind Caddy with auto-TLS; you still use a hosted LLM API
(Mistral free tier, or any of the 6 supported providers). Total recurring cost:
**$0/month + ~€10/yr domain**. Config lives under [`infra/self-host/`](infra/self-host/).

### Environment variables

See [`.env.example`](.env.example) for the full list. The non-obvious ones:

- `S3_FORCE_PATH_STYLE=true` — required for MinIO (and most non-AWS S3)
- `CLERK_WEBHOOK_SIGNING_SECRET` — only needed in M3 when the webhook fires from Clerk's cloud; dev runs without it

## LLM provider

Atlas uses [Vercel AI SDK](https://ai-sdk.dev) so you can swap providers via a single env var.

| Provider  | Free? | Setup                                         | Env var                          |
|-----------|-------|-----------------------------------------------|----------------------------------|
| **Mistral** (default) | ✅ Free Experiment | https://console.mistral.ai (30s) | `MISTRAL_API_KEY`        |
| Groq      | ✅ Free | https://console.groq.com                       | `GROQ_API_KEY`                   |
| Gemini    | ✅ Free* | https://aistudio.google.com                   | `GOOGLE_GENERATIVE_AI_API_KEY`   |
| Anthropic | Paid  | https://console.anthropic.com                  | `ANTHROPIC_API_KEY`              |
| OpenAI    | Paid  | https://platform.openai.com                    | `OPENAI_API_KEY`                 |
| Claude Agent SDK | ✅ Free with Max | `claude login` (Claude Code CLI)      | (CLI session — no key)           |

*Gemini Flash has a known parse issue with Vercel AI SDK structured output
([vercel/ai#12187](https://github.com/vercel/ai/issues/12187)) — usable but
unreliable for Atlas's per-call structured Zod schemas. Switch to Mistral, Anthropic,
or OpenAI for production work; Gemini stays as an option for when the upstream
bug is fixed.

To switch provider, set `LLM_PROVIDER=anthropic` (or `gemini`, `groq`, `openai`, `claude-agent`) in `.env` and restart.
Tier choice (`smart`/`fast`) per prompt stays the same — the dispatcher maps each tier to
the equivalent model on the new provider (see `lib/llm/tiers.ts`).

The `claude-agent` option routes through Anthropic's [`@anthropic-ai/claude-agent-sdk`](https://code.claude.com/docs/en/agent-sdk/overview),
which uses the Claude Code CLI session auth on the local machine when `ANTHROPIC_API_KEY`
is unset. Best for local-dev eval runs (free for Claude Max subscribers); not suitable
for CI (no CLI auth in containers — CI should keep using Groq/OpenAI/Anthropic API keys).

## Tests

```bash
pnpm test       # 161 tests (Vitest)
pnpm test:e2e   # 2 e2e tests (Playwright); 1 skipped pending CI infra
```

## Connect via MCP

Atlas ships an authenticated MCP server at
`https://atlas-sooty-delta.vercel.app/api/mcp/mcp` — paste this URL
into Claude Desktop, Cursor, or any MCP-compatible client. OAuth flow
runs in your browser (powered by Clerk + Dynamic Client Registration);
you never copy-paste a token.

**Listed in the official [MCP Registry](https://registry.modelcontextprotocol.io)** as `io.github.ahmedEid1/atlas-research`. Verify with:
```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=atlas-research" | jq '.servers[0].server'
```

**Available tools** (all read-only, all scoped to your Atlas account):
- `list_reviews` — list your Atlas reviews with scores
- `get_review_draft` — fetch the markdown draft of a completed review
- `get_citation_audit` — fetch the per-claim cite_check verdict report

See [`docs/mcp/tools.md`](docs/mcp/tools.md) for full tool reference and
[`docs/mcp/security.md`](docs/mcp/security.md) for the auth and audit
model.

**See it work** — Claude.ai connected to Atlas, calling `list_reviews` then `get_citation_audit` and catching 6 fabricated citations in the draft (every one citing the same paper, with invented percentages that aren't in the source):

![Atlas MCP demo — Claude.ai catching fabricated citations via cite_check](docs/assets/m5-mcp-demo.gif)

**Setting it up** in claude.ai (Pro/Max — Connectors → Add custom connector → paste the URL → OAuth via Clerk + DCR, no manual client config needed):

![Adding Atlas as a custom MCP connector in claude.ai](docs/assets/m5-mcp-setup.gif)

## Roadmap

- ~~**M2** (Wk 2): Single-node summarisation + Langfuse self-hosted observability~~ ✅ shipped as `v0.2.0-m2`
- ~~**M3** (Wk 4): Full agent loop (planner → retriever → assessor → drafter) + HITL gates + Hetzner deployment~~ ✅ shipped as `v0.3.0-m3` (code only — Hetzner deployment is the deferred M3.5 task)
- ~~**M3.5a**: LLM provider abstraction (Gemini default, free)~~ ✅ shipped as `v0.3.5-m3.5a`
- ~~**M3.5b**: Vercel deploy + Neon + R2 + Trigger.dev Cloud + Langfuse Cloud (free tier stack)~~ ✅ shipped as `v0.3.6-m3.5b` — **live at https://atlas-sooty-delta.vercel.app**
- ~~**M3.5c**: Self-host fallback docs (Oracle Cloud Always Free)~~ ✅ shipped as `v0.6.0-m3.5c` — see [`docs/self-host/oracle-cloud-quickstart.md`](docs/self-host/oracle-cloud-quickstart.md)
- ~~**M4** (Wk 5): Critic + `cite_check` + eval harness v1 with public `/evals` dashboard~~ split into M4a (shipped) + M4b (next)
- ~~**M4a**: Critic + cite_check~~ ✅ shipped as `v0.4.0-m4a`
- ~~**M4b**: Evals harness + 10 golden questions + GitHub Actions + public /evals dashboard~~ ✅ shipped as `v0.4.1-m4b` — **live at https://atlas-sooty-delta.vercel.app/evals** (currently 3 synthetic goldens; 10 real-paper goldens deferred)
- ~~**v0.4.2 – Claude Agent SDK provider**~~ ✅ shipped — free programmatic Claude via Code CLI session auth, used for local eval baseline
- ~~**v0.5.0 – Trigger.dev Cloud production deploy**~~ ✅ shipped — all 3 background tasks running on managed infra
- ~~**v0.5.1 – First live end-to-end review on production**~~ ✅ shipped — real PDF → full SLR pipeline → completed draft + critic + cite_check
- ~~**v0.6.0 – M3.5c self-host fallback docs**~~ ✅ shipped — Oracle Cloud Always Free deployment path
- **v0.7.0-m5** (2026-05-24): Authenticated MCP server. Streamable HTTP at `/api/mcp/mcp`. OAuth 2.1 + PKCE + DCR via Clerk as Authorization Server, Atlas as Resource Server. 3 read-only tools (`list_reviews`, `get_review_draft`, `get_citation_audit`) over tenant-scoped data. DB-backed audit log + per-user sliding-window rate limits. Published to the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=atlas-research) as `io.github.ahmedEid1/atlas-research`.
- **M6** (Wk 7): Public launch with 30-question golden eval set, blog series, recruiter 1-pager

See [`docs/superpowers/plans/`](docs/superpowers/plans/) for the per-milestone implementation plans.

## Built with spec-driven development

Every feature is specified before code. The spec at [`docs/superpowers/specs/2026-05-22-atlas-design.md`](docs/superpowers/specs/2026-05-22-atlas-design.md) is the contract. The M1 plan at [`docs/superpowers/plans/2026-05-22-m1-workspace-foundation.md`](docs/superpowers/plans/2026-05-22-m1-workspace-foundation.md) breaks it into 12 TDD tasks that produced this release.

## Deferred (next up)
- **M4b-expand** — Expand from 3 synthetic golden questions to 10 real-paper goldens.
- **M5** — Authenticated MCP server (OAuth 2.1), published to the MCP registry.

## License

MIT
