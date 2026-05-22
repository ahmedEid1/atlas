# Atlas

> A GDPR-safe agentic workspace for systematic literature reviews.

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
pnpm test       # 15 unit + integration tests (Vitest)
pnpm test:e2e   # 2 e2e tests (Playwright); 1 skipped pending Linux compute for marker
```

## Roadmap

- ~~**M2** (Wk 2): Single-node summarisation + Langfuse self-hosted observability~~ ✅ shipped as `v0.2.0-m2`
- ~~**M3** (Wk 4): Full agent loop (planner → retriever → assessor → drafter) + HITL gates + Hetzner deployment~~ ✅ shipped as `v0.3.0-m3` (code only — Hetzner deployment is the deferred M3.5 task)
- **M4** (Wk 5): Critic + `cite_check` + eval harness v1 with public `/evals` dashboard
- **M5** (Wk 6): Authenticated MCP server (OAuth 2.1) published to MCP registry
- **M6** (Wk 7): Public launch with 30-question golden eval set, blog series, recruiter 1-pager

See [`docs/superpowers/plans/`](docs/superpowers/plans/) for the per-milestone implementation plans.

## Built with spec-driven development

Every feature is specified before code. The spec at [`docs/superpowers/specs/2026-05-22-atlas-design.md`](docs/superpowers/specs/2026-05-22-atlas-design.md) is the contract. The M1 plan at [`docs/superpowers/plans/2026-05-22-m1-workspace-foundation.md`](docs/superpowers/plans/2026-05-22-m1-workspace-foundation.md) breaks it into 12 TDD tasks that produced this release.

## Deferred from M3
- **M3.5 — Hetzner deployment.** The agent code ships at M3, but a public live demo at `atlas.review` (or alternative domain) is the M3.5 task, requiring (a) a domain Ahmed registers and (b) a Hetzner CX22 in Falkenstein. Estimated 3-4 hours of work once both are in hand.

## License

MIT
