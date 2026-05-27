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
