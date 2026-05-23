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

## Stack

| Layer | Choice |
|---|---|
| App | Next.js 16 + TypeScript (strict) |
| UI | Tailwind v4 + shadcn/ui (base-nova / `@base-ui/react`) + Lucide |
| Auth | Clerk |
| DB | Postgres 16 + Prisma v7 (`prisma-client` generator + `@prisma/adapter-pg`) |
| Object store | S3-compatible (MinIO locally, swap endpoint for prod) |
| Background jobs | Trigger.dev v4 (`@trigger.dev/sdk`, `@trigger.dev/python` for marker) |
| PDF parsing | marker-pdf (Python, via Trigger.dev Python extension) |
| Tests | Vitest (unit/integration) + Playwright (e2e) |
| Local dev orchestration | docker-compose |

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

### Environment variables

See [`.env.example`](.env.example) for the full list. The non-obvious ones:

- `S3_FORCE_PATH_STYLE=true` — required for MinIO (and most non-AWS S3)
- `CLERK_WEBHOOK_SIGNING_SECRET` — only needed in M3 when the webhook fires from Clerk's cloud; dev runs without it

## LLM provider

Atlas uses [Vercel AI SDK](https://ai-sdk.dev) so you can swap providers via a single env var.

| Provider  | Free? | Setup                                         | Env var                          |
|-----------|-------|-----------------------------------------------|----------------------------------|
| **Gemini** (default) | ✅ Free | https://aistudio.google.com (30s)       | `GOOGLE_GENERATIVE_AI_API_KEY`   |
| Anthropic | Paid  | https://console.anthropic.com                 | `ANTHROPIC_API_KEY`              |
| OpenAI    | Paid  | https://platform.openai.com                   | `OPENAI_API_KEY`                 |
| Groq      | ✅ Free | https://console.groq.com                      | `GROQ_API_KEY`                   |

To switch provider, set `LLM_PROVIDER=anthropic` (or `openai`, `groq`) in `.env` and restart.
Tier choice (`smart`/`fast`) per prompt stays the same — the dispatcher maps each tier to
the equivalent model on the new provider (see `lib/llm/tiers.ts`).

### Python (for marker-pdf)

Atlas uses [`uv`](https://github.com/astral-sh/uv) to manage the Python venv:

```bash
cd python
uv venv --python 3.12 .venv
uv pip install --python .venv/Scripts/python.exe -r requirements.txt
```

Trigger.dev's Python extension picks up `python/.venv/Scripts/python.exe` at dev time and a Linux-built venv in deployment.

## Tests

```bash
pnpm test       # 88 tests (Vitest)
pnpm test:e2e   # 2 e2e tests (Playwright); 1 skipped pending Linux compute for marker
```

## Roadmap

- ~~**M2** (Wk 2): Single-node summarisation + Langfuse self-hosted observability~~ ✅ shipped as `v0.2.0-m2`
- ~~**M3** (Wk 4): Full agent loop (planner → retriever → assessor → drafter) + HITL gates + Hetzner deployment~~ ✅ shipped as `v0.3.0-m3` (code only — Hetzner deployment is the deferred M3.5 task)
- ~~**M3.5a**: LLM provider abstraction (Gemini default, free)~~ ✅ shipped as `v0.3.5-m3.5a`
- ~~**M3.5b**: Vercel deploy + Neon + R2 + Trigger.dev Cloud + Langfuse Cloud (free tier stack)~~ ✅ shipped as `v0.3.6-m3.5b` — **live at https://atlas-sooty-delta.vercel.app**
- **M3.5c**: Self-host fallback docs (Oracle Cloud Always Free)
- ~~**M4** (Wk 5): Critic + `cite_check` + eval harness v1 with public `/evals` dashboard~~ split into M4a (shipped) + M4b (next)
- ~~**M4a**: Critic + cite_check~~ ✅ shipped as `v0.4.0-m4a`
- ~~**M4b**: Evals harness + 10 golden questions + GitHub Actions + public /evals dashboard~~ ✅ shipped as `v0.4.1-m4b` — **live at https://atlas-sooty-delta.vercel.app/evals** (3 synthetic goldens; 10 real-paper goldens in v0.4.2-m4b-expand)
- **M5** (Wk 6): Authenticated MCP server (OAuth 2.1) published to MCP registry
- **M6** (Wk 7): Public launch with 30-question golden eval set, blog series, recruiter 1-pager

See [`docs/superpowers/plans/`](docs/superpowers/plans/) for the per-milestone implementation plans.

## Built with spec-driven development

Every feature is specified before code. The spec at [`docs/superpowers/specs/2026-05-22-atlas-design.md`](docs/superpowers/specs/2026-05-22-atlas-design.md) is the contract. The M1 plan at [`docs/superpowers/plans/2026-05-22-m1-workspace-foundation.md`](docs/superpowers/plans/2026-05-22-m1-workspace-foundation.md) breaks it into 12 TDD tasks that produced this release.

## Deferred (next up)
- **M3.5c — Self-host fallback.** Docker-compose-prod + Caddy + Oracle Cloud Always Free quickstart (4 ARM cores, 24 GB RAM, free forever) for the day Vercel limits bite.
- **M4b** — Evals harness v1 (10 golden SLR questions + Promptfoo + GitHub Actions + public /evals dashboard)

## License

MIT
