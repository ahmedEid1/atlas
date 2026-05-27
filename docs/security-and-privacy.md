# Thoth — Security & Privacy

The evidence page for the README's "GDPR-friendly" claim. Describes
exactly what data Thoth stores, where it lives, how long it sticks
around, what the auth model is, and the limits we don't pretend to
have closed.

If you find anything in this document that disagrees with the running
code at `master`, please open a GitHub issue tagged `[security]` on
[github.com/ahmedEid1/thoth](https://github.com/ahmedEid1/thoth) —
this doc is meant to be code-honest, not aspirational.

---

## 1. Data inventory

Everything Thoth persists is in Postgres (via Prisma) or on the
S3-compatible object store (Cloudflare R2 in prod, MinIO locally).
The full schema lives at [`prisma/schema.prisma`](../prisma/schema.prisma); the
table below is a human summary of what each row actually holds.

| Table | What's in it | Sensitivity |
|---|---|---|
| `User` | `clerkId`, `email`, `isGuest`, `createdAt`. No password, no profile, no name. | Low (email is the only PII) |
| `Project` | Title + research question typed by the user. | User-provided text |
| `CorpusItem` | `source` blob key (`corpus/<projectId>/<uuid>.pdf`), `parsedMarkdown` (full text extracted by Mistral OCR), `summary` (structured summary JSON). The raw PDF lives on R2 under `source`. | User-uploaded content |
| `Run` | Agent run state + final `draft` markdown + scores. | Agent output |
| `RunStep` | Per-node trace + token counts. No prompt or response payload. | Operational metadata |
| `HumanCheckpoint` | `proposal` (the plan / paper list the agent is asking the user to approve) and `decisionPayload` (the user's approve/reject choice). | User decisions |
| `IncludedPaper` / `ExtractedClaim` / `ClaimCheck` | Per-claim cite_check audit trail. | Agent output |
| `McpCall` | Audit log: `userId`, `toolName`, `inputHash` (SHA-256), `reviewId`, `status`, `latencyMs`, `createdAt`. **Raw tool inputs are never stored** — only the SHA-256 of canonical-JSON. | Audit log |
| `EvalRun` | `goldenId`, `metric`, `score`, `commitSha`, `createdAt`. No user data. | Internal QA |
| R2 bucket | Raw uploaded PDFs (PDF only — refused at `app/api/corpus/upload/route.ts` otherwise) and exported parsed markdown blobs. | User-uploaded content |

What we deliberately **don't** store:

- Raw MCP tool-call inputs (only their SHA-256 hash in `McpCall.inputHash`)
- Clerk session tokens, OAuth refresh tokens, or any auth secrets (Clerk owns those)
- IP addresses in any persistent table. The demo rate-limiter (`lib/demo/rate-limit.ts`) keeps a SHA-256-salted hash in **process memory only**, scoped to a single Vercel lambda or self-host container; the salt is configurable via `IP_HASH_SALT` so two deploys can't correlate the same IP.
- LLM prompt / response payloads. Langfuse Cloud captures spans for tracing but those are scoped to the Langfuse project and not echoed into our DB.
- Anything from the showcase user (`/showcase`) beyond the seeded fixture — it's a fixed exemplar, no user interaction with it produces records.

---

## 2. Where data lives (jurisdiction)

| Service | Region | What's there | Notes |
|---|---|---|---|
| Vercel Hobby | Frankfurt (FRA1) | Next.js app + serverless API routes | Edge functions disabled; everything runs in the FRA1 region for residency |
| Neon | Frankfurt | Postgres 17 | `DATABASE_URL` points at the EU project; backups stay in-region |
| Cloudflare R2 | Auto (EU-routed for EU traffic) | Raw PDFs + parsed markdown | R2 has no cross-region replication by default |
| Langfuse Cloud | EU instance available | LLM trace spans + token counts | Self-host is the alternative (`docs/self-host/oracle-cloud-quickstart.md` runs Langfuse alongside the app on the same VM) |
| Trigger.dev Cloud | US | Background jobs (parse-pdf, summarize, run-review, guest-cleanup, eval workflow, checkpoint-outbox) | **US jurisdiction — known limit.** Trigger.dev is one of the deliberate trade-offs in the `$0/month` cloud stack. Self-host bypasses this. |
| Clerk Cloud | US | Auth (web sessions, OAuth 2.1, DCR for MCP) | **US jurisdiction — known limit.** Same trade-off note. |
| Mistral API (default LLM) | EU | LLM inference + PDF OCR | Other configured providers (Groq / Gemini / Anthropic / OpenAI / Claude Agent SDK) have their own data-residency stories — see the README LLM-provider table. The provider is a single env var (`LLM_PROVIDER`); a fallback (`LLM_FALLBACK_PROVIDER`) can route around a primary outage. |

**For full EU jurisdiction**: deploy via [`docs/self-host/oracle-cloud-quickstart.md`](self-host/oracle-cloud-quickstart.md) on Oracle Cloud Always Free in Frankfurt — Thoth + Postgres + MinIO + Langfuse all run on one VM under your control, leaving only the LLM provider as the outbound dependency (Mistral keeps you in the EU there too).

---

## 3. Retention

| Data | How long | Mechanism |
|---|---|---|
| **Guest** users (`isGuest = true`) and everything they own (project, corpus, runs, checkpoints, claims, audit) | **24 hours** | `trigger/guest-cleanup.ts` runs every 6 hours on Trigger.dev cron. Finds `User where isGuest = true AND createdAt < now() - 24h`, deletes the Clerk user (best-effort), then deletes the local User row — cascades to every owned table including `McpCall` (FK added in `prisma/migrations/20260524200000_mcp_call_user_fk`). |
| **Real users** (`isGuest = false`) | Until account deletion | No automatic expiry. Clerk's `user.deleted` webhook fires when an account is removed in the Clerk dashboard or via Clerk's API; `app/api/webhooks/clerk/route.ts` deletes the local User row, cascading to everything owned. |
| **Showcase user** (`user_thoth_showcase`, `isGuest = false`) | Indefinite | Excluded from cleanup because it's not a guest. Hand-curated exemplar that drives the public `/showcase` page; reseeded via `pnpm seed:showcase` (see `RELEASING.md`). |
| **MCP audit log** (`McpCall`) | Tied to the user | FK with cascade delete (see V1/item 7). When a user is gone, their audit history goes with them. |
| **Eval data** (`EvalRun`) | Indefinite | Accumulates one row per `(goldenId, metric, commit)`. No user data here; this is internal QA. |
| **Rate-limiter buckets** (anonymous demo) | 1 hour, in-memory | `Map<hashedIp, timestamps[]>` pruned on every request. Lambda recycle = state lost (per-lambda enforcement is documented in `lib/demo/rate-limit.ts`). |

---

## 4. Deletion paths

| What you want to delete | How |
|---|---|
| A guest you created via the demo button | Wait 24h. The cleanup cron sweeps it automatically; no action needed. To accelerate, an operator can run `pnpm seed:showcase` (which doesn't touch guests) — there is no exposed "delete my guest" UI today. |
| A real account + all its data | Delete the Clerk user via the Clerk dashboard (Settings → Users → Delete). The `user.deleted` webhook fires within seconds; `app/api/webhooks/clerk/route.ts` cascades the local User → projects → corpus → runs → MCP audit. |
| A single project but keeping the account | Delete via the dashboard. Cascade removes the corpus, runs, checkpoints, claims. |
| The MCP connector + revoke its OAuth grant | Disconnect Thoth from your MCP client (claude.ai → Connectors → Thoth → Disconnect, or equivalent). Revoke the OAuth client in Clerk's dashboard for full removal. The `McpCall` audit rows remain until the underlying user is deleted. |

There is no self-serve "export my data" endpoint yet. That's the most commonly-requested GDPR-Article-15 ("right of access") feature; it's not on V1 but tracking as a known gap (see §7 below).

---

## 5. Auth model

| Surface | Mechanism | Detail |
|---|---|---|
| **Web app** | Clerk session cookies | `proxy.ts` (Next.js middleware) protects every route by default; explicitly-public routes are whitelisted (home, evals, demo handoff, MCP, well-known, health, showcase). |
| **API routes** that take user actions | `requireUser()` from `lib/auth.ts` | Lazy-creates the local User row if the Clerk webhook hasn't fired yet (race-protection). Fails CLOSED on a Clerk metadata-read failure during lazy-create — never silently downgrades a guest to non-guest. |
| **Demo provisioning** (`/api/demo/start`) | Anonymous | Defended by: production-only same-origin guard (exact-match via `new URL().origin`), per-IP sliding-window rate limit (5/hour, SHA-256-salted hash, no raw IPs persisted), `DEMO_DISABLED=1` operator kill switch, reverse-order compensation on partial failure (Clerk + DB rollback). |
| **MCP server** (`/api/mcp/[transport]`) | OAuth 2.1 + PKCE + Dynamic Client Registration via Clerk | Resource-server pattern per RFC 8707. No manual tokens — MCP clients (claude.ai, Claude Desktop, Cursor, Inspector) register dynamically via the `/.well-known/oauth-protected-resource/mcp` discovery endpoint and complete a browser PKCE flow. Bearer JWTs are verified per-request via JWKS (see [`docs/mcp/security.md`](mcp/security.md) for the full flow diagram). |
| **MCP tool authorisation** | Always tenant-scoped at the type level | Tool handlers never accept a `userId` parameter — `ctx.userId` from the validated Clerk JWT is the only source. Cross-user data leakage is impossible by construction (queries `WHERE project.ownerId = ctx.userId`). "Not your record" is reported as `not_found`, not `forbidden`, to prevent existence-probing. |
| **`/admin/*` pages** | Allow-list against `ADMIN_EMAILS` env var | Comma-separated email allowlist (case-insensitive). Empty/unset means nobody has access. Unauthorised hits return 404 (not 403) to avoid leaking the existence of admin routes. |

---

## 6. Things we deliberately don't do

- **No password storage.** Clerk owns identity end-to-end.
- **No raw input in audit logs.** Only the SHA-256 of canonical-JSON, scoped to `(userId, toolName, inputHash)` for rate-limit + behaviour analytics.
- **No analytics SDKs** (no Google Analytics, no Segment, no PostHog, no Hotjar, etc.). The only third-party JS shipped to the browser is Clerk's auth widget and Next.js bundles.
- **No tracking cookies.** Clerk cookies are session-only. The site sets no marketing or third-party cookies.
- **No CAPTCHA.** Clerk handles bot signups on its end; the demo flow is rate-limited at the API layer.
- **No data-sharing with the LLM providers beyond the prompts themselves.** Mistral / Anthropic / OpenAI / Groq each have their own terms; check them for the provider you choose. Mistral's free Experiment tier (our default) is explicitly EU-jurisdiction.

---

## 7. Known limits

These are real gaps. Documenting them honestly is the point of this page.

- **No self-serve data export endpoint** (GDPR Article 15). For now, request via a GitHub issue and the maintainer extracts a SQL dump for the user; not scalable. Tracked for post-V1.
- **Clerk + Trigger.dev are US-hosted.** Both are in the `$0/month` cloud stack. The full self-host alternative (`docs/self-host/oracle-cloud-quickstart.md`) bypasses Trigger.dev (background jobs run inside the same VM); replacing Clerk requires a refactor to NextAuth or similar.
- **LLM provider data residency depends on the chosen provider.** The default (Mistral) is EU; switching providers is a single env var and the data residency moves with it.
- **No DPA template** with the deployer-provided providers (Vercel / Neon / Cloudflare / Clerk / Trigger.dev) is published in this repo. Each provider has their own — the operator deploying Thoth needs to manage those agreements with their own users.
- **Per-lambda rate-limit memory.** Vercel lambda recycling resets the rate-limiter state; the effective per-IP cap is "5 per hour PER LAMBDA INSTANCE." Acceptable for the current scale; an attacker would need to defeat Vercel's lambda routing to bypass it. A Redis-backed limiter is the upgrade path if usage grows.
- **The showcase user is a fixture, not a guarantee.** `/showcase` returns 404 if the seed hasn't run on this database. Running `pnpm seed:showcase` after a DB rebuild is on the deployer.

---

## 8. Reporting a security issue

Please open a GitHub issue marked `[security]` on
[github.com/ahmedEid1/thoth](https://github.com/ahmedEid1/thoth). No
bug bounty, no NDA — this is an open-source project; the most useful
response we can offer is a public fix + credit in the commit.

The same policy is advertised at
[`/.well-known/security.txt`](https://thoth-slr.vercel.app/.well-known/security.txt)
per RFC 9116 for security scanners and researchers who look there
first.
