# Thoth v2 build roadmap

Per-milestone shipping log for V2 outbound search. The full spec is at
[`docs/superpowers/specs/thoth-v2-design.md`](../specs/thoth-v2-design.md);
V1's milestone log is at [`thoth-roadmap.md`](./thoth-roadmap.md).

Each milestone landed as a series of small commits on master with the
`v2-m{0..4}{a..d}` prefix on commit messages. Vercel auto-deployed every
push and the additive Prisma migrations ran on Neon at build time — V1
projects continue to route through the uploaded-only path unchanged.

## V2-M0 — Schema + adapter scaffolding

**Goal:** Lay down the data model + provider-interface contract without
touching the agent.

**What shipped:**

- Spec doc at `docs/superpowers/specs/thoth-v2-design.md`.
- Prisma migration `20260527190000_add_v2_outbound_search`:
  enum `SearchScope` (uploaded_only / outbound / hybrid); `Project`
  gains searchScope + searchProviders + year-range + skipDiscoveryGate
  (all defaulted to V1-equivalent values); `CorpusItem` gains optional
  `externalDoi` + `externalArxivId` cross-references; new tables
  `DiscoveredPaper` + `ScreeningDecision`.
- `lib/search/types.ts` + stubbed adapters under `lib/search/providers/`
  for OpenAlex / arXiv / Exa, plus the `dispatchSearch` fan-out with
  per-provider error isolation + score-max dedup.

**Key files:** `prisma/schema.prisma`, `prisma/migrations/20260527190000_add_v2_outbound_search/`, `lib/search/{types,dispatch}.ts`, `lib/search/providers/{openalex,arxiv,exa}.ts`

## V2-M1 — Real adapters + agent nodes

**Goal:** Make the outbound pipeline runnable end-to-end behind a feature
toggle.

**What shipped (m1a-m1d):**

- **OpenAlex** adapter — `lib/search/providers/openalex.ts` with abstract
  rebuild from the inverted index, year-range filtering via the
  documented `from_publication_date` / `to_publication_date` filters,
  DOI-first canonical externalId for cross-provider dedup, BM25-score
  normalization into [0,1].
- **arXiv** adapter — regex-based Atom XML parser (`parseArxivAtom`
  exported for unit tests), version-suffix normalization so `v1`/`v2`/`v3`
  of the same preprint dedup, DOI cross-reference when arXiv exposes one,
  always-OA accessStatus.
- **discoverer** node + `lib/prompts/discover-queries.ts` — smart-tier
  LLM call producing 4-8 natural-language queries + rationale; universal
  prompt (per-adapter translation) per spec §13.1; fan-out across
  providers via `dispatchSearch`; bulk persist via
  `createMany({ skipDuplicates: true })` for idempotency.
- **fetcher** node — bounded-concurrency-8 HEAD + GET + R2 upload +
  Mistral OCR + CorpusItem create; non-fatal skip for paywalled / 4xx /
  non-PDF / oversized; cross-reference cols populated.
- **screener** node + `lib/prompts/screen-paper.ts` — per-paper include
  / exclude verdict with relevanceScore + reason; persists
  `ScreeningDecision` rows; materializes `IncludedPaper` for the V1
  assessor when include=true AND the fetcher succeeded (so the assessor
  doesn't trip on null parsedMarkdown).
- **graph rewiring** — new conditional edge after `plan_gate`:
  `outbound`/`hybrid` projects route to `discoverer → discovery_gate →
  fetcher → screener → papers_gate`; `uploaded_only` keeps V1's
  `retriever → papers_gate` path. New `APPROVE_DISCOVERY` interrupt kind.
- **enum migration** `20260527200000_v2_status_and_checkpoint_kinds` —
  RunStatus += DISCOVERING / AWAITING_DISCOVERY_APPROVAL / FETCHING /
  SCREENING; CheckpointKind += APPROVE_DISCOVERY.
- **trigger task** — initial-state hydration now reads `project.searchScope`
  + `searchProviders`; setRunStatus branches APPROVE_DISCOVERY →
  AWAITING_DISCOVERY_APPROVAL.

**Key files:** `lib/agent/nodes/{discoverer,fetcher,screener}.ts`, `lib/agent/graph.ts`, `lib/agent/state.ts`, `lib/agent/runs.ts`, `trigger/run-review.ts`, `prisma/migrations/20260527200000_v2_status_and_checkpoint_kinds/`

## V2-M2 — Exa, UI, kill switch

**Goal:** Round out provider set + give users a way to actually use V2 +
operator panic-button.

**What shipped (m2a-m2d):**

- **Exa** adapter (`lib/search/providers/exa.ts`) — POST to
  `api.exa.ai/search` with semantic (`type: "neural"`) mode + bundled
  `contents.text` (free per-request pricing), x-api-key auth,
  startPublishedDate / endPublishedDate filters, PDF-URL detection for
  accessStatus.
- **SEARCH_DISABLED** kill switch in `lib/env.ts` — the discoverer node
  refuses to fan out when set to "1" (operator panic button pattern,
  same as DEMO_DISABLED).
- **EXA_API_KEY** env knob — Exa adapter throws SearchProviderError
  "missing API key" when unset; dispatcher records per-provider so other
  providers still contribute.
- **DiscoveryApprovalCard** (`components/runs/discovery-approval-card.tsx`)
  — client component renders queries + the deduped hit list with
  per-row keep/drop checkbox + reject-with-reason. Plugged into the
  run-detail page when an APPROVE_DISCOVERY checkpoint is PENDING.
- **NewProjectDialog** picks searchScope (uploaded_only / outbound /
  hybrid) + searchProviders. POST /api/projects accepts the new fields
  with safe defaults (outbound-without-providers coerces to
  ["openalex", "arxiv"]).
- **runs-start guard** relaxed: outbound mode skips the
  "≥1 PARSED corpus item" check (the discoverer builds the corpus
  itself); hybrid still requires uploads; both modes require ≥1
  search provider.

**Key files:** `lib/search/providers/exa.ts`, `lib/env.ts`, `lib/agent/nodes/discoverer.ts`, `components/runs/discovery-approval-card.tsx`, `components/projects/new-project-dialog.tsx`, `app/api/projects/route.ts`, `app/api/projects/[id]/runs/route.ts`

## V2-M3 — Eval metrics + schema field

**Goal:** Give the public `/evals` dashboard the same first-class
treatment for V2 nodes that V1 nodes get.

**What shipped:**

- `discoveryRecall(expected, discovered)` + `screeningPrecision(expected,
  admitted)` in `lib/eval/metrics.ts`, both honouring the existing
  vacuous-true convention.
- `expectedDois?: string[]` optional field added to
  `GoldenQuestionSchema` — existing v1 goldens stay valid (the field
  defaults to undefined → discoveryRecall returns 1 vacuously).

**Not yet shipped:** v2-mode golden YAMLs (with real arXiv DOIs) and the
EVAL_MODE=outbound CI path. These need careful research input from the
maintainer to pick goldens with verifiable arXiv IDs that aren't trivial
to surface. The framework is ready to consume them as soon as they land.

**Key files:** `lib/eval/metrics.ts`, `lib/eval/golden-schema.ts`

## V2-M32 — Hybrid full-pipeline e2e + run-detail API includes V2 surface

**Goal:** Verify M13's hybrid-mode-merges-uploaded-PDFs fix works
end-to-end on the live deploy. The unit tests cover the
synthetic-DiscoveredPaper-wrap logic; this is the live confirmation
that uploaded PDFs actually reach the screener alongside outbound
hits when running through the deployed worker + Mistral free tier.

**What shipped:**

- New live e2e test: `V2 hybrid: uploaded PDF + outbound discovery
  merge into the papers_gate`. Drives a hybrid project — uploads
  short.pdf, waits for PARSED, starts the run with skipDiscoveryGate
  + maxHits=2, approves the plan, then:
    - Asserts the papers_gate fires with an enabled "Approve N"
      button (N≥1 — proves the screener admitted at least one paper
      from EITHER the uploaded synthetic or the outbound hits).
    - Hits `GET /api/runs/<id>` and asserts at least one
      `discoveredPapers[].provider === "uploaded"` row with
      `externalId` starting with `uploaded:` — the M13 invariant
      that hybrid mode wraps PARSED uploads as synthetic
      DiscoveredPaper rows.
    - Rejects to avoid the expensive assessor + cite_check tail
      (the COMPLETED-draft path is covered by M31's test).
- New API surface: `GET /api/runs/<id>` now includes
  `discoveredPapers` (with their `screening` join) — was previously
  fetched separately by the run-detail server component. The new
  shape lets the live test inspect M13 via a single round-trip;
  external clients (MCP, future observability) benefit too.
- 1 new unit test in `tests/api/runs-get.test.ts` locking the
  contract: two-row outbound+hybrid response asserts provider
  widening + screening object-or-null per row.

**Live verification:** Pass (one flaky retry — Mistral RPM blip on
the first attempt, green on retry per playwright IS_LIVE retries=1).

**Key files:** `tests/e2e/live-full-pipeline.spec.ts`, `app/api/runs/[id]/route.ts`, `tests/api/runs-get.test.ts`

## V2-M31 — COMPLETED happy-path + reject-papers e2e

**Goal:** Cover the single biggest user story still untested
against the live deploy: "agent drafts a review + verifies every
cited claim against the source paper." M29's full-pipeline test
stopped at papers_gate to fit inside Mistral free-tier RPM; this
milestone takes it the rest of the way.

**What shipped:**

- New live e2e test: `COMPLETED happy path: V2 outbound all the way
  to draft + cite_check audit`. Drives a V2 outbound run through
  every node — planner → discoverer → fetcher → screener → papers_gate
  → assessor → drafter → critic → cite_check → COMPLETED — then
  reloads the page and asserts:
    - `<article>` / `<main>` heading is visible (react-markdown
      rendered the draft body).
    - cite_check audit copy is visible (supported / unsupported /
      faithfulness / cite_check keywords match the
      CitationFaithfulnessWidget).
  Verified live: **8.1 min** end-to-end against
  `thoth-slr.vercel.app` on Mistral free tier.
- New live e2e test: `V2 outbound: reject papers_gate → REJECTED
  with 'User aborted at papers gate' reason`. Exercises the M12
  papersApproved.rejectionReason path with the
  PapersApprovalCard's hardcoded "User aborted at papers gate"
  string. Verified live: 1.9 min.
- README + home page test-count strings sync to "466 unit + 19
  live (16 fast + 3 full pipeline)" — was bumped again here to
  cover M31's additions (now 23 total).
- README's Roadmap & changelog gains a v2.0.0 entry summarising
  the 31-milestone build + the 10-bug audit pass + the live e2e
  surface.

**Key files:** `tests/e2e/live-full-pipeline.spec.ts`, `README.md`, `app/page.tsx`

## V2-M30 — Rejection-path e2e + Trigger.dev worker redeploy

**Goal:** Per user direction ("all user stories and cases and
workflow are working"): cover the rejection branches at every HITL
gate. Found + fixed a deployment gap along the way.

**What shipped:**

- New test: `reject plan_gate → REJECTED with reason propagated to
  Run.failureReason`. Drives outbound project to plan_gate, clicks
  Reject, types reason, confirms. Asserts REJECTED pill + the
  user's reason on the page (M12 plumbing).
- New test: `V2 outbound: discovery_gate HITL renders + reject →
  REJECTED`. Outbound WITHOUT skipDiscoveryGate. Asserts the
  DiscoveryApprovalCard renders with the discoverer's search
  queries listed, then rejects the discovery sweep.
- Inter-test 30s sleep + planner-wait timeout bumped 120s→240s for
  Mistral free-tier RPM recovery.
- M29's happy-path test scaled back: maxHits 5→2, stops at
  papers_gate (rejects to avoid the expensive assessor→drafter→
  critic→cite_check tail).

**Deployment fix discovered via the new tests:** Existing REJECTED
runs in the DB had `Run.failureReason: null` even though M12 had
been merged. Root cause: Vercel auto-deploys the Next.js app, but
the **Trigger.dev worker is a separate deploy** still carrying
pre-M12 code. User authorised redeploy ("you can redploy it if you
want"); pushed Version 20260527.1. Now M12's failureReason
plumbing actually works in production.

**Memory updated:** `feedback_autonomy_thoth.md` now records that
Trigger.dev redeploys are authorised on Thoth + the
non-interactive deploy command pattern.

**`pnpm test:e2e:live:full`: 3/3 passing** in 11.8 min.

**Key files:** `tests/e2e/live-full-pipeline.spec.ts`, trigger.dev worker (deployed externally)

## V2-M29 — Full agent-pipeline e2e against live deploy

**Goal:** Per user direction ("we are using free llms, so cover
everything"): exercise the complete agent flow including every
LLM-billing node (planner, discoverer, fetcher, screener, etc.)
against the deployed app.

**What shipped:**

- New file `tests/e2e/live-full-pipeline.spec.ts` with a V2
  outbound happy-path test that drives the full agent chain.
- New `pnpm test:e2e:live:full` alias (separate from the standard
  `pnpm test:e2e:live` so the fast smoke stays fast).
- Outbound + skipDiscoveryGate=true + max 2 hits + arXiv only —
  reliably reaches papers_gate in ~50s on Mistral free tier.

**Key files:** `tests/e2e/live-full-pipeline.spec.ts`, `playwright.config.ts`, `package.json`

## V2-M28 — Real-user PDF upload in the live e2e

**Goal:** The most user-visible action not yet under live test
coverage was "upload a PDF + see it parse." Add a test that
exercises the entire upload → R2 → CorpusItem PENDING/PARSING
chain against the live deploy.

**What shipped:**

- New auth-walkthrough test: signs in, creates a project, uploads
  `tests/e2e/fixtures/short.pdf` via the UploadButton's hidden
  `<input type="file">`, asserts the corpus item's
  PENDING/PARSING/PARSED badge appears within 30s, then DELETEs
  the project. Does NOT wait for the OCR round-trip to complete —
  the badge appearance is enough proof that the upload + Trigger.dev
  enqueue both worked.
- Pattern mirrors `tests/e2e/upload-flow.spec.ts` (local) but
  pointed at the live deploy with cleanup baked in.

**Per-CI-run cost:** 1 R2 PUT + 1 Mistral OCR (small PDF, free-tier
acceptable) + 1 DB INSERT + 1 DB DELETE. The R2 blob orphans on
cleanup (CorpusItem cascade only drops the DB row, not the blob);
acceptable leak rate at the CI cadence.

**`pnpm test:e2e:live`: 16/16 passing** in 54.7s.

**Key files:** `tests/e2e/live-auth-walkthrough.spec.ts`

## V2-M27 — /sign-in render, 404, network-retry hardening

**Goal:** Round out the e2e to cover the rest of a user's
non-billing surface. Three new tests + one flake-tolerance fix.

**What shipped:**

- New browser-smoke: `/sign-in renders Clerk's SignIn component`.
  Loads /sign-in, waits for Clerk's hydrated email input to be
  reachable (Clerk SDK changes its DOM across releases — assert on
  the lowest-common-denominator input role).
- New browser-smoke: `unknown routes redirect unauthenticated to
  /sign-in (307)`. The proxy middleware's public allowlist is
  small; everything else 307s to Clerk. Verifies the redirect +
  the location header points at sign-in/Clerk.
- New auth-walkthrough: `authenticated 404 page renders with the
  styled custom not-found`. Signed-in user hits a non-existent
  project id; asserts the route returns 404 + the styled
  not-found.tsx renders (the "Back to home" CTA proves the custom
  page, not the default Next.js 404).
- Bug fix in the auth walkthrough: when tests run in serial mode
  the Clerk session persists across tests, so the second `clerk.signIn`
  threw "You're already signed in." Catch the specific
  already-signed-in error and pass through — the desired state is
  the signed-in one, and re-signing-in isn't needed.
- Bump per-test timeout for the auth walkthrough to 120s. Serial-
  mode tests chaining Neon-backed server renders against a Vercel
  deploy hit the 60s default when the deploy is cold-starting.
- `playwright.config.ts` retries=1 in IS_LIVE mode (was 0). Live
  e2e occasionally hits transient ERR_NETWORK_CHANGED /
  ERR_ABORTED from the external network. 1 retry tolerates these
  without polluting CI signal. Local runs keep retries=0 so a
  local flake is still a real bug to investigate.

**`pnpm test:e2e:live`: 15/15 passing** in 39.7s.

**Key files:** `tests/e2e/live-browser-smoke.spec.ts`, `tests/e2e/live-auth-walkthrough.spec.ts`, `playwright.config.ts`

## V2-M26 — Hybrid + tuning + sign-out coverage in the authenticated e2e

**Goal:** Per user direction ("test everything the user can do…
loop until everything in the app is perfect"), keep extending the
authenticated walkthrough to cover the rest of the user's
non-LLM-billing surface.

**What shipped:**

- New test: hybrid scope + every search-tuning knob. Drives:
  searchScope=hybrid, searchYearStart=2020, searchYearEnd=2025,
  searchMaxHits=30, skipDiscoveryGate=true. Verifies the project
  page Discovery configuration panel renders all five values, then
  ROUND-TRIPS through `GET /api/projects/<id>` to confirm the
  values landed in the DB (defends against a UI-render-only
  regression that doesn't persist). Hybrid auto-default providers
  (openalex + arxiv) are asserted in the response.
- New test: sign out via `clerk.signOut`. Asserts the New Project
  button disappears + the public "Sign in" link reappears on
  /. Covers the session-revoke + auth UI flip.
- `pnpm test:e2e:live` total surface: **12/12 passing** in 42.5s
  (3 MCP-transport + 5 public-surface + 4 authenticated).

**Cost per CI run:** 5 DB INSERTs + 5 DELETEs across all four
authenticated tests. No LLM, no OCR, no Trigger.dev work.

**Still NOT covered (intentionally — billing concerns):**
- PDF upload + Mistral OCR (would bill ~$0.001-0.01 per CI run +
  leak the R2 blob on cleanup).
- "Start review" + the agent pipeline (would bill 150-400k LLM
  tokens per run). RELEASING.md's MCP Inspector + Claude Desktop
  manual walkthrough covers this.

**Key files:** `tests/e2e/live-auth-walkthrough.spec.ts`

## V2-M25 — v2-mode authenticated e2e (create outbound + verify config panel)

**Goal:** Extend M24's authenticated walkthrough with a v2-shape test:
sign in, open New Project, pick **Outbound search**, fill the
question, submit, land on the project page, assert the **Discovery
configuration** panel renders with the picked scope + providers, then
delete to clean up.

**What shipped:**

- New test in `tests/e2e/live-auth-walkthrough.spec.ts`: drives the
  outbound radio button, verifies the provider checkboxes fieldset
  shows ("at least one is required" hint), submits, then asserts
  the project page's v2 panel renders the **Outbound search** scope
  label + the **openalex, arxiv** provider row.
- Viewport set to 1280×1400 for this test because the V2 dialog
  grows tall (radio buttons + provider checkboxes + tuning
  fieldset) and the Create button drops below the default 720px
  fold. Default viewport remains untouched for other tests.
- Cleanup pattern unchanged — afterAll DELETEs via the M24 endpoint;
  the beforeAll defensive sweep now matches "E2E live walkthrough"
  prefix (broader, catches v2 orphans too).
- `pnpm test:e2e:live` total surface: **10/10 passing** (3 MCP +
  5 browser + 2 authenticated walkthroughs).

**Key files:** `tests/e2e/live-auth-walkthrough.spec.ts`

## V2-M24 — DELETE /api/projects/[id] + authenticated live walkthrough

**Goal:** Per user direction ("it's ok add them, to your test and
clean the databases from them afterward"): drive a real authenticated
user through the deployed app, creating real DB rows, then clean
them up. Required a `DELETE /api/projects/[id]` endpoint that didn't
exist — users had no way to delete projects from anywhere.

**What shipped:**

- `DELETE /api/projects/[id]` in `app/api/projects/[id]/route.ts`.
  Uses `db.project.deleteMany({ where: { id, ownerId } })` so the
  owner check happens at the DB layer atomically; cascade-deletes
  every owned row (CorpusItem, Run, HumanCheckpoint, IncludedPaper,
  ExtractedClaim, ClaimCheck, DiscoveredPaper, ScreeningDecision)
  via the existing `onDelete: Cascade` foreign keys. 204 on
  success; 404 (not 403) when not found or not owned, matching the
  rest of the API's existence-probe defense.
- 3 unit tests for the route: 204 on owned, 404 on
  unowned/missing, 401 unauthenticated.
- New `tests/e2e/live-auth-walkthrough.spec.ts`: signs in via Clerk
  testing token, opens the New Project dialog, creates a project
  on the live deploy, asserts the project page renders, then
  DELETEs it and verifies it's gone from the dashboard. Auto-skips
  when CLERK_SECRET_KEY / E2E_EMAIL aren't set so CI runs without
  prod credentials still pass.
- Defensive `beforeAll` cleanup sweep: enumerates the test user's
  projects and deletes any whose title starts with the test's
  prefix, so an orphan from a previous crashed run gets swept up
  next time.
- `afterAll` belt-and-braces cleanup deletes anything the in-test
  cleanup missed.
- README test row + RELEASING.md MCP-smoke checklist updated to
  reflect the 9-test live suite.

**Why this matters:** an authenticated walkthrough exercises the
real `requireUser` middleware, real Clerk OAuth, real Postgres
writes, real cascade-delete on a project + its (about-to-exist)
children. The earlier 8 tests were public-surface only — this is
the first e2e that proves the auth-gated UI actually works against
the deployed instance.

**Cost:** ~3 DB INSERTs + 3 DELETEs per CI run. No LLM tokens,
no Trigger.dev enqueue, no Mistral OCR.

**Key files:** `app/api/projects/[id]/route.ts`, `tests/api/projects.test.ts`, `tests/e2e/live-auth-walkthrough.spec.ts`, `playwright.config.ts`, `package.json`

## V2-M23 — Live-deploy real-browser e2e smoke

**Goal:** The existing `pnpm test:e2e:live` only exercised the MCP
transport (3 API-level checks). User asked for a "real user in a
browser against the deployed version" check too.

**What shipped:**

- New `tests/e2e/live-browser-smoke.spec.ts` (5 tests, all run in
  a real Chromium under Playwright against
  `https://thoth-slr.vercel.app`):
    1. Home page renders the headline + a primary CTA.
    2. `/api/health` returns `{ ok: true, dbReachable: true,
       commitSha: <git sha> }`.
    3. `/evals` dashboard renders with at least one metric tile.
    4. `/showcase` renders the seeded exemplar (or `test.skip` if
       the deploy hasn't run `pnpm seed:showcase` yet).
    5. `/.well-known/security.txt` serves per RFC 9116.
- `playwright.config.ts` `IS_LIVE` projects' testMatch widens to
  `(mcp-smoke|live-browser-smoke).spec.ts`.
- `package.json` `test:e2e:live` alias adds the new spec to the
  test list.
- README test row updates to "463 unit/integration + 8 live e2e
  (3 MCP-transport + 5 real-browser)".
- `RELEASING.md` MCP-smoke checklist references the 8-test surface.

**What this does NOT cover (intentionally):**

- Authenticated flows (create project, start a run, the v2 outbound
  pipeline end-to-end). Those need a real Clerk session, would
  write to prod, and would bill Mistral + LLM tokens per CI run.
  RELEASING.md's manual MCP Inspector + Claude Desktop walkthrough
  covers them.

**Key files:** `tests/e2e/live-browser-smoke.spec.ts`, `playwright.config.ts`, `package.json`, `README.md`, `RELEASING.md`

## V2-M22 — segmentStatus is V2-aware (DISCOVERING/FETCHING were dead enums)

**Goal:** Tenth audit fix. The Run.status enum declared
`DISCOVERING`, `FETCHING`, `SCREENING` (added in the v2 migration)
but the trigger task's `segmentStatus()` always returned the V1
chain (PLANNING/RETRIEVING/ASSESSING/DRAFTING). Outbound runs
displayed `RETRIEVING` while the discoverer / fetcher / screener
were actually running — misleading on the dashboard status pill
and on `list_reviews` MCP output.

**What shipped:**

- `segmentStatus(segment, searchScope)` now takes the project's
  searchScope. uploaded_only keeps the V1 chain. outbound + hybrid
  return PLANNING → DISCOVERING → FETCHING → ASSESSING → DRAFTING.
- Trigger task call site passes `project.searchScope` through.
- New test asserts an outbound run's setRunStatus call sequence
  contains DISCOVERING + FETCHING + ASSESSING and crucially does
  NOT contain V1's RETRIEVING.

**Key files:** `trigger/run-review.ts`, `tests/trigger/run-review.test.ts`

## V2-M21 — Dispatcher all-providers-fail coverage + README v2 quickstart

**Goal:** Two small finishes.

**What shipped:**

- New dispatcher test: when EVERY configured provider rejects (network
  timeout / 503 / missing API key on the same run), `dispatchSearch` must
  return `{hits: [], errors: [...all three...]}` and NOT throw. An uncaught
  rejection here would crash the discoverer node and the whole run; the
  empty-hits-with-error-log shape lets the run gracefully end at the
  discovery_gate with the user seeing "0 papers found, here's why."
- README gains a "Trying the v2 outbound flow" subsection under
  Quickstart — 7-step walkthrough from sign-in through screener verdict,
  plus a note on the skipDiscoveryGate power-user option and the V2 MCP
  introspection tools.

**Key files:** `tests/lib/search/dispatch.test.ts`, `README.md`

## V2-M20 — Discovered-paper click-through links + author display

**Goal:** When users see a discovered paper in the DiscoverySummary
panel, the title was inert text. They had to copy the externalId
and paste it into a new tab to actually read the paper. Polish gap.

**What shipped:**

- New `lib/search/external-link.ts` with `externalPaperLink({ provider,
  externalId, oaUrl })` mapping each provider's externalId shape to a
  human-readable URL:
    - `arxiv:2310.06770`   → `https://arxiv.org/abs/2310.06770`
    - `10.1038/s41586-...` → `https://doi.org/10.1038/s41586-...`
    - `openalex:W12345`    → `https://openalex.org/W12345`
    - exa hits fall back to `oaUrl` when present
    - `uploaded:ci_a` returns null (no external link — it's a user upload)
- `DiscoverySummary` (run-detail panel) renders the paper title as an
  `<a href target="_blank" rel="noopener noreferrer">` when
  `externalPaperLink` returns a URL, falling back to a plain `<p>`
  otherwise. The author list (first 5, "+ N more" tail) also shows
  now — previously the field was loaded but never rendered.
- 7 new tests for `externalPaperLink` covering each provider shape +
  the uploaded null case + the unknown-shape fallback + the
  "don't mistake bare arxiv id for a DOI" edge case.

**Key files:** `lib/search/external-link.ts`, `components/runs/discovery-summary.tsx`, `app/projects/[id]/runs/[runId]/page.tsx`, `tests/lib/search/external-link.test.ts`

## V2-M19 — SEARCH_DISABLED fail-fast at runs-start

**Goal:** When the operator flips `SEARCH_DISABLED=1` (the v2 kill
switch from M2c), outbound/hybrid projects could still start a
run from the UI. The planner would then run + bill ~2k LLM tokens,
the plan_gate would interrupt + bill HITL latency, and only THEN
the discoverer would throw with the SEARCH_DISABLED message — at
which point the user has paid for half a planning round. Lousy
fail-mode UX + wasted spend.

**What shipped:**

- `/api/projects/[id]/runs` now reads `env.SEARCH_DISABLED` and,
  when set, returns **503 search_disabled** with a clear
  user-readable message for outbound/hybrid scope. The Run row is
  never created, no Trigger.dev task is enqueued, no LLM tokens
  are billed.
- uploaded_only projects still start normally — they don't touch
  the search providers, so the kill-switch doesn't apply to them.
- Two new tests cover the 503 path for outbound and the
  pass-through for uploaded_only when `SEARCH_DISABLED=1`.

**Key files:** `app/api/projects/[id]/runs/route.ts`, `tests/api/runs-start.test.ts`

## V2-M18 — Multi-tenant unique-constraint fix

**Goal:** Eighth audit bug. `CorpusItem.externalDoi` and
`externalArxivId` were declared `@unique` (globally unique) in the M0
migration. Effect: once any user's project fetched paper-X
(DOI="10.1/foo"), every OTHER user's outbound run that surfaced the
same paper crashed on a unique-constraint violation when the
fetcher tried to create the CorpusItem. Multi-tenant outbound was
broken — second user just couldn't get paper-X into their corpus,
ever.

**What shipped:**

- New migration
  `20260527220000_v2_corpus_xref_per_project/migration.sql`:
  `DROP INDEX IF EXISTS "CorpusItem_externalDoi_key"`,
  `DROP INDEX IF EXISTS "CorpusItem_externalArxivId_key"`,
  then create `(projectId, externalDoi)` + `(projectId, externalArxivId)`
  compound unique indexes. Migration is strictly less restrictive
  than the previous global unique, so the apply is safe regardless
  of existing data.
- `prisma/schema.prisma` reflects the new constraint via
  `@@unique([projectId, externalDoi])` / `@@unique([projectId,
  externalArxivId])` (the field-level `@unique` was removed).
- Prisma client regenerated; no other code change needed (the
  fetcher's create call passes `projectId` already, so the
  per-project uniqueness Just Works).

**Key files:** `prisma/schema.prisma`, `prisma/migrations/20260527220000_v2_corpus_xref_per_project/migration.sql`

## V2-M17 — Screener retry idempotency

**Goal:** Seventh audit bug, found by walking the screener loop one
more time. The screener processes up to 50 DiscoveredPapers
sequentially (Mistral free-tier RPS budget). If paper 25/50 hit a
rate-limit, the run died — but the first 24 already had
ScreeningDecision rows persisted. A Trigger.dev retry would crash
on the FIRST already-screened paper because `db.screeningDecision.
create({ data })` doesn't check for existing rows and
`ScreeningDecision.discoveredPaperId` is `@unique`.

**What shipped:**

- The screener now loads existing `ScreeningDecision` rows for the
  current `runId` at the top of the node, builds a `Map<discoveredPaperId,
  decision>`, and seeds the in-memory `decisions[]` + `included[]`
  accumulators from the cached rows. For each paper, if it's
  already in the map, the LLM call + `screeningDecision.create` are
  both skipped. Net result: the second attempt only LLM-calls the
  papers that hadn't been decided yet, and the create call's unique
  constraint never fires.
- IncludedPaper specs are rebuilt from the cached decisions too
  (subject to the same `include && corpusItemId` invariant as fresh
  runs).
- One new test: pre-populate
  `db.screeningDecision.findMany` with paper "a", drive the screener
  on `[a, b]`, assert (1) `runLLM` called exactly once (for b only),
  (2) `screeningDecision.create` called exactly once (for b only),
  (3) returned state includes both decisions (cached a + fresh b),
  (4) both papers materialize IncludedPaper rows.

**Key files:** `lib/agent/nodes/screener.ts`, `tests/lib/agent/nodes/screener.test.ts`

## V2-M16 — Hybrid cross-source dedup

**Goal:** Edge case turned up while auditing hybrid mode: if a user
had uploaded paper-X (so `CorpusItem.externalDoi="10.1/foo"`) AND
the outbound search ALSO surfaced paper-X via OpenAlex with
`externalId="10.1/foo"`, the discoverer would persist BOTH as
separate `DiscoveredPaper` rows. The screener would evaluate both,
the assessor would extract claims from both, and the drafter could
cite the same paper twice (once as the upload, once as the OCR'd
download). Subtle but real bug in hybrid mode.

**What shipped:**

- The discoverer's hybrid branch now reads
  `CorpusItem.externalDoi` + `externalArxivId` (the same columns
  the fetcher populates) for every PARSED upload BEFORE persisting
  outbound hits. Any outbound hit whose externalId matches an
  uploaded DOI or `arxiv:<id>` is dropped before the createMany.
  Uploads always win — they already have parsedMarkdown + summary,
  no re-fetch needed.
- One new discoverer test asserts the dedup: outbound returns 3
  hits (two duplicate, one new), uploads cover the two duplicates,
  the outbound createMany ends up with just the "genuinely new"
  one while both uploads still get wrapped as synthetic rows.

**Key files:** `lib/agent/nodes/discoverer.ts`, `tests/lib/agent/nodes/discoverer.test.ts`

## V2-M15 — Honor papersApproved.corpusItemIds (V1 bug found in V2 audit)

**Goal:** Fifth audit bug, and the oldest one of the five — exists
since V1's papers_gate landed. The PapersApprovalCard's per-row
checkbox sent `corpusItemIds` (the still-kept list) to the approve
endpoint, the approve endpoint persisted it on
HumanCheckpoint.decisionPayload, the trigger task ran the resume —
and then **no node ever filtered against it**. Unchecking a paper at
papers_gate did nothing. The assessor processed every paper, the
drafter cited every paper, the user's intent vanished. Same shape of
silent-no-op as keptExternalIds (M11) and skipDiscoveryGate (M14).

**What shipped:**

- `papersApprovalGate` in `lib/agent/graph.ts` now reads the
  resume decision's `corpusItemIds` (when present + approved) and
  filters `state.includedPapers` to that set before the assessor
  runs. The filter applies whether the includedPapers came from
  V1's retriever or V2's screener; both flow through the same
  shared gate.
- One new end-to-end graph test: retriever produces three included
  papers (c1, c2, c3), the user's resume payload says
  `corpusItemIds: ["c1", "c3"]`, assessor mock captures the
  includedPapers it actually sees, assert it sees only c1+c3.

**Key files:** `lib/agent/graph.ts`, `tests/lib/agent/graph.test.ts`

## V2-M14 — Wire Project.skipDiscoveryGate (was declared, never honored)

**Goal:** Fourth v2 audit bug. `Project.skipDiscoveryGate` has existed
as a column since the M0 migration (defaulted false, called out in the
spec as a power-user opt-out from the HITL gate) but no code consumed
it. Every outbound run paused at discovery_gate regardless of the
column's value — the field was pure dead schema.

**What shipped:**

- `AgentState.skipDiscoveryGate` channel added (boolean, default
  false, "neu wins" reducer like the other v2 channels).
- `trigger/run-review.ts` hydrates it from `Project.skipDiscoveryGate`
  alongside the other v2 fields.
- `lib/agent/graph.ts` discoveryApprovalGate short-circuits when
  `state.skipDiscoveryGate=true`: returns `{ approved: true }`
  directly without calling `interrupt()`, so the graph flows
  straight from discoverer → fetcher with no HITL pause. The
  fetcher + screener + cost-cap chain still applies, so this can't
  cause a runaway-cost incident on its own.
- `app/api/projects/route.ts` create schema accepts the new
  optional `skipDiscoveryGate` field.
- `NewProjectDialog` "Search tuning" fieldset gains a "Skip
  discovery approval" checkbox with explainer copy.
- Project detail page surfaces the setting in the Discovery
  configuration panel ("HITL gate: Discovery approval skipped").
- `tests/lib/agent/graph.test.ts` gets a new end-to-end case
  ("V2 outbound: skipDiscoveryGate=true auto-approves and flows
  straight to fetcher") that drives a full outbound run with only
  two Command.resume calls (plan_gate + papers_gate, none for
  discovery_gate) and asserts the draft is produced.

**Key files:** `lib/agent/state.ts`, `lib/agent/graph.ts`, `trigger/run-review.ts`, `app/api/projects/route.ts`, `components/projects/new-project-dialog.tsx`, `app/projects/[id]/page.tsx`, `tests/lib/agent/graph.test.ts`

## V2-M13 — Hybrid mode actually merges uploaded PDFs (bug fix)

**Goal:** Hybrid projects (`searchScope='hybrid'`) required ≥1 PARSED
corpus item at runs-start but the graph routed them straight to the
discoverer (never the retriever), so uploaded PDFs were dead in the
water — the screener never saw them, the assessor never saw them,
the user's uploads were silently dropped.

**What shipped:**

- After the search-provider dedup, the discoverer now also
  enumerates `PARSED` `CorpusItem` rows for the project and wraps
  each as a synthetic `DiscoveredPaper` row with
  `provider="uploaded"`, `externalId="uploaded:${corpusItem.id}"`,
  `initialScore=1.0` (user upload = strong prior), and
  `corpusItemId` pre-set so the fetcher's idempotency check skips
  the OCR step. Title is heuristic: first markdown heading > the
  source's filename > the corpus id.
- The screener (which iterates `state.discoveredPapers`) now sees
  uploaded + outbound papers in one pass and emits IncludedPaper
  rows for either source when its verdict is include=true.
- `DiscoveredPaperRef.provider` type widens to include `"uploaded"`.
  `PROVIDER_BADGE` in DiscoverySummary + DiscoveryApprovalCard
  picks up the new value so uploaded papers render with an
  "Uploaded" tag instead of the raw provider name.
- Two new discoverer tests: hybrid mode wraps PARSED uploads as
  synthetic rows (asserting provider/externalId/title/abstract
  shape); outbound mode does NOT call corpusItem.findMany at all
  (so V1 / pure-outbound semantics are unchanged).

**Key files:** `lib/agent/nodes/discoverer.ts`, `lib/agent/state.ts`, `components/runs/discovery-summary.tsx`, `components/runs/discovery-approval-card.tsx`, `tests/lib/agent/nodes/discoverer.test.ts`

## V2-M12 — Rejection-reason plumbing (bug fix)

**Goal:** Two bugs surfaced while auditing V2 critical paths. Both
were silent UX losses.

**What shipped:**

- `trigger/run-review.ts` now handles `discoveryApproved.approved=false`
  symmetrically with planApproved + papersApproved. Before this fix,
  rejecting the discovery_gate ended the graph at END with no draft,
  and the trigger task fell through to the "no draft → FAILED" path
  — mis-classifying user rejection as agent failure. Status now
  goes to REJECTED, matching the V1 plan / papers rejection
  behaviour.
- `setRunStatus()` gains an optional `failureReason` arg. All three
  rejection paths (plan, discovery, papers) now persist the user's
  rejection reason from the HumanCheckpoint to Run.failureReason,
  so the run-detail page's existing `run.failureReason && <p>`
  block actually surfaces "Why is this run REJECTED?" instead of
  staying empty.
- 1 new test in `tests/trigger/run-review.test.ts` covers the
  discovery rejection path end-to-end; the existing plan-rejection
  test was strengthened to assert failureReason propagation.

**Key files:** `trigger/run-review.ts`, `lib/agent/runs.ts`, `tests/trigger/run-review.test.ts`

## V2-M11 — Honor keptExternalIds in fetcher (bug fix)

**Goal:** Make the DiscoveryApprovalCard's per-row checkbox actually
do something. Before this fix, the fetcher and screener looped over
every discovered paper regardless of which ones the user dropped
at the discovery_gate — quietly negating the user's intent and
costing OCR + screener-LLM calls on rejected papers.

**What shipped:**

- `lib/agent/nodes/fetcher.ts` reads `state.discoveryApproved.
  keptExternalIds` and filters discoveredPapers to that list (when
  provided) before the open-access / OCR / persistence loop. When
  the user clicked "Approve N" without dropping anything, the field
  is undefined and the original "fetch all" behaviour stands.
- The returned state's `discoveredPapers` shrinks to the kept set
  so the downstream screener (which iterates state.discoveredPapers)
  never bills LLM calls on dropped papers either.
- The underlying `DiscoveredPaper` DB rows are NOT deleted — they
  still appear in `list_discovered_papers` (MCP tool) and the
  DiscoverySummary panel, so users + auditors can see "the
  discoverer found 50, you kept 30, the screener admitted 12."
- Two new fetcher tests cover the keptExternalIds path (only kept
  papers fetched + only kept papers in returned state) and the
  approved-as-is path (keptExternalIds undefined → every paper
  fetched).

**Key files:** `lib/agent/nodes/fetcher.ts`, `tests/lib/agent/nodes/fetcher.test.ts`

## V2-M10 — Eval CLI + dashboard wire V2 metrics

**Goal:** Make the public `/evals` dashboard ready for V2 outbound
goldens the moment one lands, without a separate code change.

**What shipped:**

- `lib/eval/golden-schema.ts` gains optional
  `expectedDois: string[]` field (turns out the earlier M3a milestone
  documented this but never actually committed the schema change —
  the previous compaction summary recorded code that wasn't on disk).
  Now properly committed with 3 schema tests covering present /
  absent / too-short cases.
- `scripts/run-evals.ts` imports `discoveryRecall` +
  `screeningPrecision`, computes both when the golden has
  `expectedDois` AND the run produced `discoveredPapers`.
  V1 goldens leave `expectedDois` undefined, so the V1 metric set
  emits unchanged — no vacuous-true 1.00 rows polluting the
  dashboard.
- `MetricRow` type widened with the two new metric names.
- `/evals` page METRICS array gains "Discovery recall (v2)" +
  "Screening precision (v2)" tiles. Aggregate stays per-metric so
  a v2-mode golden's data won't show until it actually lands.
- EvalRun schema comment updated to mention the new metric names.

**Key files:** `scripts/run-evals.ts`, `app/evals/page.tsx`, `lib/eval/golden-schema.ts`, `tests/lib/eval/golden-schema.test.ts`

## V2-M9 — Run-detail discovery summary

**Goal:** Make a v2 run legible at a glance — what queries ran, what
papers turned up, how the screener voted, which providers failed —
without users having to install an MCP client to read it.

**What shipped:**

- New `DiscoverySummary` server component
  (`components/runs/discovery-summary.tsx`) — renders queries +
  discovered-papers list (provider badge, year, initial score,
  fetched + screening verdict + reason) + a per-provider error
  panel that surfaces partial failures inline (e.g. "exa: missing
  API key") instead of burying them in `RunStep.failureReason`.
- Run-detail page (`app/projects/[id]/runs/[runId]/page.tsx`):
  fetches `discoveredPapers` (with their `screening` join) in the
  same query that loads the run; renders an `outbound` / `hybrid`
  badge in the run header; mounts the DiscoverySummary panel for
  outbound runs (gated to only render once queries OR discovered
  papers exist so v1 runs and freshly-started v2 runs aren't
  cluttered).
- Same source-of-truth as the V2 MCP tools: queries come from the
  APPROVE_DISCOVERY checkpoint's proposal; provider errors come
  from RunStep where nodeName='discoverer'.

**Key files:** `components/runs/discovery-summary.tsx`, `app/projects/[id]/runs/[runId]/page.tsx`

## V2-M8 — Search tuning surface (year range + max-hits in the create dialog)

**Goal:** Expose the search-tuning knobs the API already accepted but
the UI didn't surface, so power users can pick year range + max-hits
at project-create time without having to hit the API directly.

**What shipped:**

- `app/api/projects/route.ts` create schema gains optional
  `searchMaxHits` (Zod: int 1-100). Year range was already on the
  schema; this commit's tests are the first to assert the
  `yearStart > yearEnd` refine actually fails closed.
- `NewProjectDialog` grows a "Search tuning (optional)" fieldset
  (visible only when scope ≠ uploaded_only) with year-start, year-end,
  and max-hits number inputs. Empty fields = "use the server default"
  (the parsed values are skipped if NaN). Caption explains the
  free-tier cost trade-off.
- `tests/api/projects.test.ts` gains four new tests: outbound with
  explicit providers + year range + max-hits, outbound-without-providers
  auto-defaulting to OpenAlex+arXiv, yearStart>yearEnd → 400,
  searchMaxHits above the 100 ceiling → 400. (The first two were
  live code paths from M2c with no test coverage; backfilling now.)

**Key files:** `app/api/projects/route.ts`, `components/projects/new-project-dialog.tsx`, `tests/api/projects.test.ts`

## V2-M7 — Project-level V2 visibility + outbound start gate

**Goal:** Make a v2-configured project legible from the UI and let
outbound projects start a review without a pre-uploaded corpus.

**What shipped:**

- Project detail page (`app/projects/[id]/page.tsx`) gains a
  "Discovery configuration" panel for outbound + hybrid projects:
  scope label, provider list, max-hits cap, optional year range.
  Uploaded_only projects render identically to V1 (the panel is
  hidden) so V1 users see no change.
- `canStartReview` branches on `project.searchScope`. Outbound
  projects no longer need a parsed corpus item before the
  start-review button is clickable — the discoverer builds the
  corpus itself. Hybrid still requires uploads (matches the existing
  runs-start API guard).
- "No reviews yet" hint copy is scope-aware: outbound projects get
  "Start one — the agent will discover candidate papers, screen
  them…" instead of V1's "once at least one paper is parsed".
- Project list (`components/projects/project-list.tsx`) renders a
  small `v2` (outbound) / `hybrid` badge next to the title so users
  can spot mode at a glance on the dashboard.
- runs-start route gains three new tests covering outbound (corpus
  check skipped), outbound-without-providers (409), and hybrid with
  empty corpus (409 with the hybrid-shaped message).

**Key files:** `app/projects/[id]/page.tsx`, `components/projects/project-list.tsx`, `tests/api/runs-start.test.ts`

## V2-M6 — Cost-cap safety knobs (per-spec §7)

**Goal:** Implement the cost-cap knobs the v2 design promised so a
runaway outbound run can't blow the OCR + screener budget.

**What shipped:**

- `MAX_TOKENS_PER_RUN` default bumped 250k → 400k. V1 took ~150k for
  assessor/drafter/critic/cite_check; v2 adds discoverer + per-paper
  screener calls + OCR overhead. Per-env override unchanged.
- New `MAX_DISCOVERED_PAPERS_PER_RUN` env knob (default 50, ceiling
  100, Zod-validated). After dedup, the discoverer sorts by
  initialScore DESC and slices to `min(env_cap, project.searchMaxHits)`
  before persisting, so the fetcher loop never sees more than the
  configured ceiling. Per-project `searchMaxHits` (already on the
  Project model from M0) wins when tighter than the env cap; the env
  cap wins when the project asked for more (operator wins).
- `AgentState.searchMaxHits` added to plumb the per-project value;
  `trigger/run-review.ts` hydrates it alongside searchScope +
  searchProviders.

**Key files:** `lib/env.ts`, `lib/agent/nodes/discoverer.ts`, `lib/agent/state.ts`, `trigger/run-review.ts`, `tests/lib/agent/nodes/discoverer.test.ts`

## V2-M5 — MCP introspection for V2

**Goal:** Bring V2 capability into the MCP surface so external clients
(claude.ai, Cursor, Claude Desktop) can inspect outbound runs the same
way they inspect V1 reviews.

**What shipped:**

- `list_discovered_papers(reviewId)` — every paper the discoverer
  surfaced for an outbound run, plus per-paper fetch status + screener
  verdict + initial relevance score. Returns empty + searchScope hint
  for uploaded_only runs.
- `get_search_queries(reviewId)` — LLM-generated search queries
  (sourced from the APPROVE_DISCOVERY checkpoint's proposal),
  provider set, and per-provider error log from RunStep.
- Updated `tests/lib/mcp/tools-annotations.test.ts` + `mcp-route.test.ts`
  to assert the 5-tool surface.
- `docs/mcp/tools.md` + README MCP tool list updated.

**Key files:** `lib/mcp/tools/list-discovered-papers.ts`, `lib/mcp/tools/get-search-queries.ts`, `lib/mcp/tools/index.ts`, `tests/lib/mcp/tools/{list-discovered-papers,get-search-queries}.test.ts`, `docs/mcp/tools.md`

## V2-M4 — Docs sync + ceremony

**Goal:** Make the V2 capability legible to anyone landing in the README
+ cement the build narrative.

**What shipped:**

- README updated with the V2 mode overview ("Outbound search (v2, new)").
- README "What makes Thoth different" gets a new ribbon for outbound
  web search.
- Status row in the engineering-proofs table updated to mention v2.0.
- This roadmap doc (`thoth-v2-roadmap.md`) lands as the canonical
  shipping log.
- `thoth-v2-design.md` Status flipped from DRAFT to "Shipped".

## What stays deferred

Open V2-spec items that didn't ship in v2.0:

- **SearchQuery audit table.** The spec called for a per-call audit row
  capturing exact queries sent to each provider. The discoverer logs
  query strings + per-provider failures to RunStep.failureReason today,
  which is the on-disk audit. A dedicated table is easier to query but
  not load-bearing yet.
- **Real v2-mode goldens** + `EVAL_MODE=outbound` CI path. The metrics
  + schema field are wired *and* `lib/eval/headless-runner.ts` now
  accepts `searchScope` + `searchProviders` so callers can drive an
  outbound run end-to-end through the eval harness with an empty
  corpus. What's still missing is the YAML inputs themselves — picking
  goldens with verifiable arXiv DOIs that aren't trivial to surface
  needs maintainer judgement. The framework is ready to consume them.
- **Query-editing in the discovery_gate UI.** The first cut shows
  queries read-only and lets the user reject + re-plan if they're wrong.
  Edit-in-place is a v2.x UX upgrade.
