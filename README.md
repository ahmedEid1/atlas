# Atlas

> A GDPR-safe agentic workspace for systematic literature reviews.

Atlas turns a research question and a corpus of PDFs into an evidence-grounded literature review. It uses a multi-step agent (LangGraph, planner → retriever → assessor → drafter → critic) with tool use, human-in-the-loop gates, and a `cite_check` post-pass that verifies every citation against the source paper.

**Status:** M1 — workspace foundation. Full design spec: [`docs/superpowers/specs/2026-05-22-atlas-design.md`](docs/superpowers/specs/2026-05-22-atlas-design.md).

## What's in M1

- **Clerk auth** with webhook-synced user table (v7 `<Show>` API, `proxy.ts` middleware for Next 16)
- **Prisma v7 schema** for users, projects, corpus items (driver adapter `@prisma/adapter-pg`, `prisma.config.ts` for connection)
- **S3-compatible object store** helper, tested against local MinIO
- **PDF upload endpoint** with mime/size validation, owner-scoped access
- **Durable parse-pdf task** on Trigger.dev v4 wrapping marker-pdf via the Python extension
- **Minimal UI** for project workspace + corpus list with status polling
- **Tested**: 15 unit/integration tests + 2 Playwright e2e tests (1 skipped pending Linux infra)

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
docker compose up -d       # Postgres on :5433, MinIO on :9010/:9011
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

- **M2** (Wk 2): Single-node summarisation + Langfuse self-hosted observability
- **M3** (Wk 4): Full LangGraph agent loop (planner → retriever → assessor → drafter) + HITL gates + Hetzner deployment
- **M4** (Wk 5): Critic + `cite_check` + eval harness v1 with public `/evals` dashboard
- **M5** (Wk 6): Authenticated MCP server (OAuth 2.1) published to MCP registry
- **M6** (Wk 7): Public launch with 30-question golden eval set, blog series, recruiter 1-pager

See [`docs/superpowers/plans/`](docs/superpowers/plans/) for the per-milestone implementation plans.

## Built with spec-driven development

Every feature is specified before code. The spec at [`docs/superpowers/specs/2026-05-22-atlas-design.md`](docs/superpowers/specs/2026-05-22-atlas-design.md) is the contract. The M1 plan at [`docs/superpowers/plans/2026-05-22-m1-workspace-foundation.md`](docs/superpowers/plans/2026-05-22-m1-workspace-foundation.md) breaks it into 12 TDD tasks that produced this release.

## License

MIT
