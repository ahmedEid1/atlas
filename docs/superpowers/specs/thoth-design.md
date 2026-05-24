# Thoth — Design

**Status:** Authoritative design (matches code at `v0.7.1`)
**Owner:** Ahmed Hobeishy

---

## 1. Overview

Thoth is an open-source, agentic workspace for **systematic literature reviews**. A researcher creates a project around a research question, uploads a corpus of PDFs, and Thoth's agent loop plans the review, retrieves and assesses sources, drafts an evidence-grounded review with inline `[paper_id]` citations, critiques its own draft, and runs a `cite_check` post-pass that verifies every cited claim against the source paper before the user reads anything.

The product is named for **Thoth**, the ancient Egyptian ibis-headed god of writing and scribes — the divine patron of the work this tool automates. The ibis logo is by Delapouite, CC BY 3.0, via game-icons.net.

Two outcomes are served by one implementation:

1. **A real artifact** — a GDPR-friendly tool that researchers can sign into, run, and self-host. EU researchers can keep their corpus on Oracle Cloud Always Free in Frankfurt.
2. **A portfolio artifact** — a single, deeply-engineered project covering every production agentic skill on 2026 Agentic SWE / Applied AI job descriptions: LangGraph, HITL with durable execution, evals tied to a public dashboard, end-to-end OpenTelemetry tracing, authenticated MCP, and ruthless cost discipline.

The product niche — Kitchenham & Charters style SLRs — was chosen because it is narrow enough to build a real golden eval set against (citation recall, faithfulness, hallucination rate are all measurable), the methodology is well-defined, and no incumbent (Elicit / Undermind / Perplexity) addresses exactly this job with a public eval dashboard and an authenticated MCP surface.

---

## 2. Core value propositions

Four differentiators, each tied to a working part of the system. They are also the four ribbons on the README.

1. **`cite_check` post-pass.** Every `[paper_id]` mention in the generated draft is verified against the cited paper before the user reads the draft. Unsupported claims are flagged in-line, surfaced in the UI, and exposed as a structured MCP tool. The MCP demo in the README shows Claude.ai using `get_citation_audit` to identify six fabricated statistics in a real Thoth-produced draft.
2. **Authenticated, registered MCP server.** OAuth 2.1 + PKCE + Dynamic Client Registration via Clerk (resource-server pattern per RFC 8707), with SHA-256-hashed audit logs and DB-backed sliding-window rate limits. Listed in the official MCP Registry as `io.github.ahmedEid1/thoth`.
3. **Public eval dashboard tied to `master`.** The agent runs against a versioned golden set; results render at `/evals`. The intent is that an eval regression is a public signal, not a private failure.
4. **Six LLM providers, `$0` default.** A single env var (`LLM_PROVIDER`) selects between Mistral (default), Groq, Gemini, Anthropic, OpenAI, and the Claude Agent SDK. Mistral's Free Experiment tier is the default because it produces structured output reliably on this workload (Gemini Flash has a known parse issue with the AI SDK's Zod-validated structured output).

---

## 3. System architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Thoth Web (Vercel)                          │
│  Next.js 16 App Router · Tailwind v4 · shadcn/@base-ui · Clerk      │
│  - Dashboard / project workspace / live run narration / HITL gates  │
│  - Public /evals dashboard                                          │
│  - /demo entry + /demo/handoff ticket consumer                      │
└─────────┬──────────────────────────────────────────────┬────────────┘
          │ Server actions + REST API routes             │ /api/mcp/[transport]
          ▼                                              ▼
┌─────────────────────────────┐               ┌──────────────────────────┐
│   Next.js API routes         │               │   MCP Streamable HTTP    │
│   /api/runs/* /api/projects  │               │   mcp-handler 1.1.0 +    │
│   /api/corpus/*              │               │   @clerk/mcp-tools 0.5 + │
│   /api/webhooks/clerk        │               │   @modelcontextprotocol/ │
│   /api/health                │               │   sdk 1.29.0             │
│   /api/demo/start            │               │   3 read-only tools      │
│   /api/runs/[id]/checkpoints │               │   (audit + rate-limited) │
│     /[cpId]/{approve,reject, │               └────────────┬─────────────┘
│              retry-delivery} │                            │
└──────────┬──────────────────┘                            │
           │ enqueue                                       │
           ▼                                               │
┌────────────────────────────────────────────────┐         │
│   Trigger.dev v4 (Cloud)                        │         │
│   - run-review.ts (LangGraph 1.3 orchestrator)  │         │
│   - parse-pdf.ts (Mistral OCR)                  │         │
│   - summarize-paper.ts                          │         │
│   - checkpoint-delivery-outbox.ts (every 1m)    │         │
│   - guest-cleanup.ts (every 6h)                 │         │
└────────────┬────────────────────────────────────┘         │
             │                                              │
             ▼                                              ▼
┌──────────────────────┐  ┌──────────────────┐  ┌──────────────────────┐
│ Neon Postgres        │  │ Cloudflare R2    │  │ Langfuse Cloud       │
│ (Frankfurt)          │  │ (S3-compatible)  │  │ OTel ingest via      │
│ Prisma v7 +          │  │ raw PDFs +       │  │ langfuse-vercel +    │
│ @prisma/adapter-neon │  │ parsed markdown  │  │ @vercel/otel         │
│ LangGraph postgres   │  │                  │  │                      │
│ checkpointer         │  │                  │  │                      │
└──────────────────────┘  └──────────────────┘  └──────────────────────┘
                                                            ▲
                          ┌─────────────────────────────────┘
                          │ exports per-LLM-call span + cost + tier + provider
                          │
                ┌─────────────────────────┐
                │ LLM dispatch (lib/llm)   │
                │ Vercel AI SDK over       │
                │ 6 providers              │
                │ tier: smart | fast       │
                └─────────────────────────┘
```

### Layer responsibilities

- **Web app** (`app/`) — Next.js 16 App Router. Server components for the workspace; one client component (`/demo/handoff`) for the ticket-based sign-in. Server actions and REST routes mutate state.
- **API routes** (`app/api/`) — thin handlers; all long-running work is enqueued onto Trigger.dev. Checkpoint approve/reject/retry are the most security-critical routes and use the 2-phase commit-then-deliver pattern described in §4.
- **Agent runtime** (`lib/agent/`, `trigger/run-review.ts`) — LangGraph 1.3 state machine running inside a Trigger.dev task. The Postgres checkpointer (`@langchain/langgraph-checkpoint-postgres`) gives durable cross-process resume; `interrupt(...)` + `wait.completeToken` give exactly-once HITL.
- **Background workers** (`trigger/`) — Trigger.dev v4 tasks for PDF parsing, paper summarisation, the agent run itself, scheduled guest cleanup, and the checkpoint-delivery outbox.
- **Database** (`prisma/schema.prisma`) — Postgres 17. Prisma v7 with the Neon driver adapter in prod and `@prisma/adapter-pg` for local dev. The schema lives in §4.7 of the original M1 plan; the authoritative version is `prisma/schema.prisma`.
- **Object store** — S3-compatible. Cloudflare R2 in prod (`auto` region, virtual-hosted style), MinIO on `:9010/:9011` in local dev (`S3_FORCE_PATH_STYLE=true`). Code path is the same AWS SDK v3 client.
- **Observability** — Langfuse Cloud Hobby tier (50K obs/mo). Traces are emitted from both the Next.js process (`instrumentation.ts` via `@vercel/otel`) and the Trigger.dev workers (explicit `langfuse.flushAsync()` in a `finally` block). Every LLM call carries `runId`, `projectId`, `userId`, `tier`, `provider` as Langfuse metadata.

### Architecture invariants

1. **No long-running LLM work in a Next.js request handler.** Every agent run goes through a Trigger.dev task.
2. **All LLM output that mutates persistent state is Zod-validated** before write (via `generateObject` in `lib/llm.ts`).
3. **Every LLM call produces a Langfuse span** with cost, tokens, latency, prompt name, tier, and provider.
4. **Every cited claim is `cite_check`'d** before the user sees the draft; unsupported and unclear citations are surfaced both in the UI and via the MCP `get_citation_audit` tool.
5. **Every MCP call is audit-logged** with user id, tool, SHA-256 input hash, status, error code, and latency.
6. **HITL gates are durably blocking** — runs persist via Trigger.dev `wait.forToken` until the user approves or rejects; the wait-token is delivered exactly once even under retries (see §4).
7. **Memory is project-scoped.** No cross-project leakage. GDPR-essential.
8. **The `/evals` dashboard is public** and reads from the `EvalRun` table. A regression is visible.
9. **Every run is bounded by a hard token budget** (`MAX_TOKENS_PER_RUN`, default 250k). The cost-cap fails closed.

---

## 4. Agent pipeline

The pipeline is a LangGraph state machine compiled with a Postgres checkpointer. Topology:

```
START → planner → plan_gate ─(approve)→ retriever → papers_gate ─(approve)→ assessor
                       └─(reject)→ END        └─(reject)→ END
                                                                      │
                                                                      ▼
                                                                   drafter ←─┐
                                                                      │     │
                                                                      ▼     │
                                                                   critic ──┤ revise (< 2 iters)
                                                                      │
                                                                      ▼ approve OR cap
                                                                  cite_check → END
```

### Nodes

| Node | Tier | Purpose | Output written to |
|---|---|---|---|
| `planner` | smart | Research question + corpus summary → PICOC, sub-questions, inclusion/exclusion criteria | `Run.plan` (JSON) |
| `retriever` | fast (per paper) | Score each `CorpusItem` for relevance; produce included-set proposals | `IncludedPaper` rows |
| `assessor` | smart (per paper) | Extract claims with category (`finding | methodology | limitation | context`) | `ExtractedClaim` rows |
| `drafter` | smart | Synthesise the review markdown with inline `[paper_id]` citations | `Run.draft` |
| `critic` | smart | LLM-as-judge against a 4-dimension rubric (faithfulness, completeness, citationQuality, clarity 1–5); emits `decision: approve | revise` + actionable feedback | `state.critique`; `Run.critiqueScore` on the final iteration |
| `cite_check` | smart (per citation) | For every `[paper_id]` mention, verifies the surrounding claim against the paper summary; verdict `supported | unsupported | unclear` | `ClaimCheck` rows + `Run.faithfulnessScore` aggregate |

The retriever scores papers from the **project's uploaded corpus only**; outbound search providers (Exa, OpenAlex) are intentionally deferred. Each scoring call is per-paper to keep prompts small and parallelism cheap.

### State shape (`lib/agent/state.ts`)

```ts
{
  runId, projectId, question,
  candidateCorpusItems: CandidateCorpusItem[],
  plan: Plan | null,
  planApproved: { approved, editedPlan?, rejectionReason? } | null,
  includedPapers: IncludedPaperSpec[],
  papersApproved: { approved, corpusItemIds?, rejectionReason? } | null,
  claims: ClaimSpec[],
  draft: string | null,
  critique: Critique | null,
  critiqueIterations: number,
}
```

Channel reducers are `(_old, neu) => neu` for every field (last-write-wins). The reducer is required for arrays so that a partial state update from a node does not blow away the previous value.

### HITL gates — the 2-phase commit-then-deliver pattern

`plan_gate` and `papers_gate` use LangGraph's `interrupt(...)` to suspend the graph. The Trigger.dev task that runs the graph receives the interrupt and calls `wait.forToken` on a freshly-minted Trigger wait-token, which is written to `HumanCheckpoint.waitToken`.

When the user hits **Approve** on the UI, the API route at `app/api/runs/[id]/checkpoints/[cpId]/approve/route.ts` does the following:

- **Phase 1** (small, fast, no external call): inside a transaction with `pg_advisory_xact_lock(hashtext(cpId))`, `updateMany WHERE status='PENDING'` flips status to `APPROVED` and persists `decisionPayload`. Once Phase 1 commits, the decision is immutable; any later approve or reject sees `status != PENDING` and writes nothing. This is the invariant that prevents audit divergence.
- **Phase 2** (delegated to `deliverCheckpoint` in `lib/agent/checkpoint-delivery.ts`): outside the Phase 1 transaction, bumps `attemptCount` + `lastDeliveryAttemptAt`, then re-enters a second transaction with the same advisory lock, re-reads the persisted `decisionPayload`, calls `wait.completeToken(waitToken, decisionPayload)`, and nulls the `waitToken` column.

The delivery helper **always reads the persisted `decisionPayload`** — never an external payload — so a retry after a partial failure cannot substitute its own decision. Trigger.dev's `wait.completeToken` is documented idempotent (no-op success on already-completed tokens), so a re-delivery after a rolled-back null-out is safe.

Stranded checkpoints (Phase 1 committed, Phase 2 failed) are auto-recovered by `trigger/checkpoint-delivery-outbox.ts`, a cron task scheduled every minute that selects rows with `status != PENDING AND waitToken IS NOT NULL AND terminalError IS NULL`, ordered `lastDeliveryAttemptAt ASC NULLS FIRST, decidedAt ASC` (starvation-safe), and calls `deliverCheckpoint`. After `MAX_ATTEMPTS` failed deliveries the outbox stamps `terminalError`, removing the row from the candidate set; the UI surfaces the row with a "retry now" affordance backed by `app/api/runs/[id]/checkpoints/[cpId]/retry-delivery/route.ts`.

### Cost-cap

Every node calls `await assertWithinBudget(runId)` at entry. Per-item loops in the assessor and cite-check also call it inside the loop body. The check sums `inputTokens + outputTokens` across all `RunStep` rows for the run and throws `BudgetExceededError` if it exceeds `env.MAX_TOKENS_PER_RUN` (default 250k).

For the cite-check node specifically, a `RunStep` is recorded **per LLM call** (`cite_check_citation`) so the budget query sees per-citation spend; the outer `cite_check` step records `tokens=0` to avoid double counting. The cite-check node is sequential (`PARALLEL = 1`) — see `lib/agent/nodes/cite-check.ts:13` — because Mistral's free tier rate-limits at ~1 RPS.

The error class lives at `lib/agent/cost-cap.ts:17`; the gate at `lib/agent/cost-cap.ts:46`. `BudgetExceededError` bubbles up to `trigger/run-review.ts`, whose catch block matches with `instanceof BudgetExceededError`, transitions the run to `FAILED`, and writes a budget-specific `failureReason`.

---

## 5. Authentication & authorization

Clerk plays a **dual role**:

- **Web session AS** — Clerk hosted sign-in for the app. `auth()` from `@clerk/nextjs/server` produces a `userId`; `lib/auth.ts:25` lazy-creates the matching `User` row.
- **OAuth 2.1 AS for MCP** — Dynamic Client Registration enabled in the Clerk Dashboard. Clerk issues JWTs to remote MCP clients (Claude.ai, Claude Desktop, Cursor). Thoth's `/api/mcp` is the Resource Server (RFC 8707).

### `isGuest` propagation

Guest accounts (created by `/api/demo/start`) are marked in three places:

1. Clerk `publicMetadata.isGuest = true` (the source of truth).
2. Local `User.isGuest = true` written at creation time.
3. Webhook in `app/api/webhooks/clerk/route.ts` copies `publicMetadata.isGuest` to the local row on every `user.created` / `user.updated` event so the local state stays consistent even when the user is provisioned outside `/api/demo/start`.

### Lazy-create fails closed on Clerk read failure

`lib/auth.ts:32-43` lazy-creates a local `User` row when the webhook hasn't fired yet (race protection). It reads `publicMetadata.isGuest` from Clerk first. If the Clerk read throws (5xx, network blip), the error is re-thrown — the route returns 401. The trade-off is explicit: a guest whose local row was evicted during a Clerk outage cannot come back as a non-guest and bypass guest write-guards. Real users see a transient 401 during the rare outage; retrying after Clerk recovers succeeds.

---

## 6. Demo flow

Goal: a recruiter or first-time visitor can click one button on the landing page and be in a working dashboard within seconds, without seeing a sign-up form.

### Anonymous entry

`POST /api/demo/start` (`app/api/demo/start/route.ts`):

1. **Same-origin guard** (production only): `host` header must be present; `origin` or `referer` must parse via `new URL().origin` to one of `https://${host}` / `http://${host}` (exact-match Set). Runs **before** rate-limit so a cross-site POST from a victim's browser cannot drain that victim's per-hour bucket as a DoS amplifier.
2. **Per-IP rate limit**: `lib/demo/rate-limit.ts` enforces a 5/hour sliding window keyed by SHA-256-salted hash of the client IP, in-memory `Map`. Returns 429 with `Retry-After`.
3. Mints a globally unique guest email at `thoth-guest-<12hex>@example.com` (example.com is RFC 2606 reserved, resolves in DNS, and is accepted by Clerk's email validator).
4. Creates the Clerk user with `publicMetadata: { isGuest: true, source: "demo-button" }`.
5. Creates the local `User` row with `isGuest=true`.
6. Mints a Clerk **sign-in ticket** (`clerk.signInTokens.createSignInToken`, 60s TTL).
7. Builds a handoff URL `${proto}://${host}/demo/handoff?ticket=<jwt>` and returns it. `x-forwarded-proto` is sanitized (comma-split, lowercased, only `http`/`https` accepted; localhost/127. defaults to `http`).
8. **Reverse-order compensation** on any partial failure: the local `User` row is deleted first, then the Clerk user, each isolated in its own `try/catch` so a compensation failure can't swallow the original error or skip subsequent cleanup.

### Handoff page

`app/demo/handoff/page.tsx` is a client component wrapped in `<Suspense>` (because `useSearchParams()` triggers Next.js's CSR bailout during static prerender). It uses `useSignIn` from `@clerk/nextjs/legacy` — the legacy entry keeps the familiar imperative `signIn.create(...) → setActive(...)` shape that every "consume a sign-in ticket" example in the Clerk docs uses; the v7 main entry switched to a signal-based reactive API that's unnecessary for a one-shot ticket handoff.

The handoff calls `signIn.create({ strategy: "ticket", ticket })`, then `setActive({ session: attempt.createdSessionId })`, then `router.push("/dashboard")`. Ticket consumption is guarded by a `consumedRef` so React's effect re-runs (Strict Mode double-invoke in dev; reference change in prod) cannot trigger a second `signIn.create` with an already-consumed ticket. A `setTimeout` post-error rescue checks `isSignedIn` before surfacing the error — the harmless "ticket already consumed" race resolves to a successful dashboard navigation on the next render.

The handoff lives in our own app rather than redirecting directly to Clerk's `accounts.dev` ticket URL because Clerk's dev-instance ticket page ignores `?redirect_url=` when the destination isn't whitelisted in the dashboard and bounces the user to `/default-redirect`.

### Empty-dashboard landing

The guest lands on an **empty dashboard** — no pre-cloned sample data. They upload their own PDFs, create a project, and run the agent end-to-end. This is the intended demo experience: the recruiter sees the real flow (upload → plan gate → papers gate → draft → critic → cite_check), and the cost-cap (§4) is the spend boundary that makes guest write access safe.

A clone helper (`lib/demo/clone-review.ts`) and its tests remain in the repo for potential future re-enable but are not on the current code path.

### Cleanup

`trigger/guest-cleanup.ts` runs every 6 hours (cron `0 */6 * * *`) and deletes any `User` row with `isGuest=true AND createdAt < now − 24h`. Prisma cascade tears down the guest's projects, corpus, runs, and everything downstream. Clerk delete is best-effort; a Clerk-delete failure doesn't block the local cascade.

---

## 7. MCP server

Thoth ships a remote MCP server at `/api/mcp/[transport]` on the same Vercel deploy as the web app.

### Transport, libraries, versions

- **Streamable HTTP only.** Modern remote MCP clients (Claude Desktop, Cursor, claude.ai) speak Streamable HTTP directly; stdio and the deprecated SSE transport are not implemented.
- `mcp-handler` 1.1.0 — Vercel-maintained handler builder. Wraps a `McpServer` instance and handles transport plumbing.
- `@clerk/mcp-tools` 0.5 — provides `verifyClerkToken` (used inside `withMcpAuth`) and the well-known-route handlers for OAuth Protected Resource Metadata and Authorization Server Metadata proxy.
- `@modelcontextprotocol/sdk` 1.29.0 — pinned via pnpm `overrides` so the indirect dep used by `mcp-handler` and `@clerk/mcp-tools` agrees on a single SDK version (avoids the "two McpServers in the same process" failure mode).
- Server route at `app/api/mcp/[transport]/route.ts`; tool registry at `lib/mcp/tools/index.ts`.

### Auth flow

```
Claude Desktop → POST /api/mcp (no token) → 401 + WWW-Authenticate
              → GET /.well-known/oauth-protected-resource/mcp
              → GET /.well-known/oauth-authorization-server (proxies Clerk)
              → POST registration_endpoint (DCR per RFC 7591) → client_id
              → browser: Clerk consent → PKCE authorization_code
              → token exchange → JWT
              → POST /api/mcp Bearer JWT → tools/list and tools/call
```

`withMcpAuth` (configured in `route.ts`) verifies the bearer JWT via Clerk's JWKS, maps `clerkUserId` to the local `User.id`, and exposes `{ userId, clerkId }` on `extra.authInfo.extra` for every tool handler.

### Tools

Three read-only tools. All scoped to the JWT-verified `User.id`. None hits an LLM at call time — every response is a DB read of already-computed data, so recruiter traffic cannot exhaust the free-tier LLM budget.

| Tool | Returns | Notes |
|---|---|---|
| `list_reviews` | The user's `Run` rows with status, `critiqueScore`, `faithfulnessScore`, claim count, citation count | Empty array for new users. |
| `get_review_draft` | `draft` markdown + scores + `criticIterations` | 404 (not 403) for unowned reviews — prevents existence probing. 404 if `status != COMPLETED`. |
| `get_citation_audit` | Per-claim `ClaimCheck` rows (verdict, reason, supporting span) + aggregate counts | The differentiator tool. Surfaces Thoth's cite_check audit as structured MCP output. |

Every tool is annotated with MCP spec 2025-11-25 `ToolAnnotations`:

```
readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false
```

These are behaviour hints clients use to decide whether a call should be auto-approved.

### `serverInfo`

`serverInfo` carries `name`, `version`, `title`, `description`, `websiteUrl`, and `icons[]`. The MCP SDK 1.29.0 Implementation schema accepts these alongside the required `name`/`version`; `mcp-handler` 1.1.0's narrower type is bridged with an `as never` cast so the extra fields reach clients that read them (claude.ai's connector card shows the icon + title). Older clients drop unknown fields silently.

### Audit log + rate limits

`McpCall` schema (`prisma/schema.prisma:224`):

- `userId, toolName, inputHash, reviewId?, status (OK | ERROR), errorCode?, latencyMs, createdAt`
- Two indexes: `(userId, createdAt)` and `(userId, toolName, createdAt)` — both rate-limit lookups are cheap.

Design choices:

- **`inputHash`, never raw input.** SHA-256 of canonical-JSON. GDPR-clean; enough for per-(user, tool, input) frequency analysis.
- **`reviewId` materialised**: when input has one it's copied to a top-level column so queries don't have to parse JSON.
- **No FK to `User` / `Run`**: Clerk owns users; preserving call history after a review delete is correct audit behaviour.
- **Audit write failure is non-fatal**: wrapped in try/catch and emitted as a Langfuse span. The request still succeeds.

Rate limits (DB-backed sliding window over the `McpCall` indexes — no Redis):

- 60 calls / 60s per user (all tools)
- 30 calls / 60s per user per tool
- 1000 calls / 24h per user

Rate-limited responses themselves write a `McpCall` row with `status=ERROR errorCode=rate_limited`, so they count toward the user's window — preventing a spam-the-limit loophole. Limits are deliberately conservative for v1.

### Registry & docs

Published to the official MCP Registry as `io.github.ahmedEid1/thoth` (`status: active`). Reference docs at [`docs/mcp/tools.md`](../../mcp/tools.md) (per-tool inputs, outputs, examples) and [`docs/mcp/security.md`](../../mcp/security.md) (auth model, rate limits, audit log story). The pre-release MCP smoke checklist lives in [`RELEASING.md`](../../../RELEASING.md).

---

## 8. Eval harness

`pnpm eval` (`scripts/run-evals.ts`) runs the agent against a versioned golden set of SLR questions. Each golden question is a YAML file under `evals/golden/` carrying a research question, a PICOC, a corpus of papers inlined as markdown (seeded directly as `CorpusItem.status = PARSED` with `kind = NOTE`, so the run skips PDF parsing and the eval stays fast + free), and a list of expected claims that must appear in the draft.

### Metrics

| Metric | Formula | Target |
|---|---|---|
| Citation recall | (Thoth's papers ∩ expected) / expected | ≥ 0.6 |
| Citation precision | (Thoth's papers ∩ expected) / Thoth's papers | ≥ 0.5 |
| Claim faithfulness | supported / total (from cite_check) | ≥ 0.85 |
| Expected-claim coverage | (expected claims found in draft) / expected claims | ≥ 0.5 |

### Persistence + dashboard

Results are written to the `EvalRun` table (`goldenId, metric, score, runId?, commitSha, createdAt`). The public `/evals` page reads from Neon and renders the latest run's per-question scores plus aggregate averages, with the commit SHA and run timestamp surfaced inline.

### Regression script

`pnpm eval:check` (`scripts/check-eval-regression.ts`) compares the current run's metrics to the last `master` run and exits non-zero if any metric drops more than the configured threshold. It is intended to be wired into CI; today it runs manually (the `.github/workflows/evals.yml` slot is reserved but unwired pending the M6 30-question dataset — running it nightly on 3 synthetic goldens would burn LLM budget without much signal).

### Current state

3 synthetic golden questions are checked in today, with their corpora inlined directly into the YAML (no PDF upload). **30 real-paper golden questions is the M6 deliverable**, along with the trend-line UI on `/evals` and the CI workflow that fails on regressions; the existing 3 goldens exercise the harness end-to-end (headless graph runner → metrics → `EvalRun` rows → dashboard render → regression script) so the gap is "more data and the CI hookup," not "missing capability."

---

## 9. Deployment

### Cloud (default, `$0/month`)

| Service | Tier | Use |
|---|---|---|
| **Vercel Hobby** | Free | Next.js 16 app + serverless API routes. Cron is delegated to Trigger.dev. |
| **Neon** | Free | Postgres 17 in Frankfurt. Driver is `@prisma/adapter-neon`. `DATABASE_URL` is the pooled connection; `DIRECT_DATABASE_URL` is direct and used by `prisma migrate`. |
| **Cloudflare R2** | 10 GB free, 0 egress | Raw PDFs + parsed markdown. S3 SDK with `forcePathStyle=false` (virtual-hosted style). |
| **Langfuse Cloud Hobby** | 50K obs/mo | OTel ingest via `langfuse-vercel` + `@vercel/otel`. ~30–50 spans per review → ~1000 reviews/month headroom. |
| **Trigger.dev Cloud** | Free (500K runs/mo) | All background tasks (PDF parse, agent run, scheduled outbox + cleanup). |
| **Clerk Cloud** | Free up to 10K MAU | Web sessions + OAuth 2.1 AS + DCR for MCP. |
| **Mistral AI** | Free Experiment tier | Default LLM. Swap via `LLM_PROVIDER`. |

The build script (`package.json:7`) is `prisma generate && prisma migrate deploy && next build`, so DB migrations apply on every Vercel deploy.

### Self-host (Oracle Cloud Always Free)

`infra/self-host/docker-compose.prod.yml` runs the full stack on a single Oracle Cloud Ampere A1 instance (4 ARM cores, 24 GB RAM, free forever):

- Caddy reverse proxy with auto-TLS via Let's Encrypt
- Thoth web (multi-stage Node 22 Dockerfile; no Python — Mistral OCR is over HTTP)
- Postgres 17
- MinIO (S3-compatible object store)
- Self-hosted Langfuse stack: web + worker + ClickHouse + Redis + Langfuse-MinIO
- Daily `pg_dump` backup via `backup-postgres.sh` on a mounted volume

LLM and Clerk auth remain cloud-hosted in the self-host story (with documented swap paths). Self-hosted Trigger.dev v4 is referenced as an advanced step (link to upstream cookbook) rather than duplicated — their compose is too large to fold in cleanly.

Container healthcheck hits `GET /api/health` (`app/api/health/route.ts`), which probes DB liveness.

Step-by-step walkthrough: [`docs/self-host/oracle-cloud-quickstart.md`](../../self-host/oracle-cloud-quickstart.md). The acceptance bar is "fresh Ubuntu 22.04 ARM box → live Thoth in ≤ 60 min."

---

## 10. Security posture

### Write-paths

All authenticated users (including guests) can create projects, upload PDFs, and run the agent. The spend boundary is **not** identity-class — it's the per-run `MAX_TOKENS_PER_RUN` cost-cap (§4) plus the per-IP rate-limit on `/api/demo/start` (§6). A malicious guest cannot create infinite guest accounts (origin guard + IP rate limit + 24h cleanup) and cannot drain the LLM budget on the accounts they do get (cost-cap fails closed).

### Security headers (`next.config.ts`)

- `poweredByHeader: false`
- Non-API routes (matched by `/((?!api/).*)`) receive: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- HSTS (`Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`) is added only in production so local `http://localhost` dev is not pinned.
- The `/api/*` exclusion is deliberate: applying `X-Frame-Options` to streaming MCP responses risks interfering with browser-side MCP clients for no gain on a JSON-only endpoint.
- CSP is out of scope for this pass — too easy to break without per-route nonces.

### Trigger.dev env sync — armed-switch + allowlist (`trigger.config.ts`)

By default (no `TRIGGER_DEPLOY_CONFIRM`), `loadSyncEnv()` returns `[]` and Trigger.dev's existing project env is left untouched. A developer's `.env` cannot silently overwrite prod worker env.

When armed (`TRIGGER_DEPLOY_CONFIRM=1`), the deploy reads `.env` and pushes **only** keys present in `ALLOWED_PROD_KEYS` — a 16-key explicit allowlist covering Postgres, S3, the 5 LLM provider keys, Langfuse, and Clerk server-side. Adding a new key requires a code change to the file, visible in PR review. `LLM_PROVIDER` is intentionally excluded from the allowlist so the local dev default ("groq") doesn't accidentally override prod's pinned provider.

### Audit logs

- `McpCall` (per MCP call): `userId, toolName, inputHash (SHA-256), reviewId, status, errorCode, latencyMs`. SHA-256 hash, never raw input.
- `HumanCheckpoint` (per HITL decision): `decisionPayload, decidedAt, attemptCount, lastDeliveryAttemptAt, terminalError`. Once Phase 1 commits, the decision is immutable.
- `RunStep` (per LLM call): `nodeName, inputTokens, outputTokens, cacheReadInputTokens, traceUrl, failureReason`. Powers the cost-cap aggregate.

### Rate limits

- `/api/demo/start`: 5/hour per IP (in-memory).
- MCP: 60/60s per user, 30/60s per user-per-tool, 1000/24h per user (DB-backed sliding window).

---

## 11. Out of scope

The following are deliberately deferred. Each is a known gap, not an oversight.

- **Outbound search**. Exa, OpenAlex, web search — deferred. The retriever scores only against the project's uploaded corpus. Closes the GDPR story tightly for now; can be added behind a per-project toggle without re-architecting the graph.
- **Quantitative meta-analysis**. The existing Kitchenham skill covers this offline; not in Thoth v1.
- **Non-English documents**. PDF OCR works but prompts are English-only.
- **Real-time multi-user collaboration**. Liveblocks-style cursors are out.
- **Multi-tenant org workspaces**. Each project belongs to one `User`.
- **Pricing / SaaS billing**. Open-source, free-to-self-host. No billing surface.
- **MCP write tools**. `start_review`, `cancel_run`, `delete_review` are out by design — read-only keeps the recruiter demo cheap and bounded.
- **Pre-cloned sample SLR for guests**. The clone helper survives in code but is not on the demo path; the empty-dashboard flow is more honest about what Thoth does.
- **30-question real-paper golden set**. The harness runs end-to-end with 3 synthetic goldens today; 30 real ones are the M6 work item.
- **Anomaly detection over `McpCall`**. The data is captured; the cron is deferred.
- **CSP**. Excluded from the security-headers pass for now.
