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

## V2-M61 — Corpus-list polling effect uses stable signature

**Goal:** `CorpusItemList` polls every 2s while any item
is PENDING / PARSING via a `useEffect` whose dependency
array was `[items, router]`. Because `items` is a new
array reference on every server-page render (every 2s
while polling is active), the effect tore down + re-set
the interval on every tick. Behaviour was correct but
the cleanup/re-setup churn was unnecessary.

**What shipped:**

- Effect dependency switched from `items` to a stable
  string signature `items.map(i => i.status).join(",")`
  — only changes when at least one item's status
  actually changes.
- Matches the M42 RefreshTickList pattern (stable
  signature for the same reason).

**Key files:** `components/corpus/corpus-item-list.tsx`

## V2-M62 — Start-new-run shortcut on FAILED runs

**Goal:** When a run failed, the user had to navigate
back to the project page to start a new run — even
though the only thing the new run needs is the project
id + the same config (already on the project row). The
M51 failed-run panel was a good spotlight, but the next
step ("try again") required leaving the page.

**What shipped:**

- `StartReviewButton` gains `label` + `pendingLabel`
  props so callers can re-use the same component with
  different copy.
- The failed-run panel on the run-detail page now
  embeds the button labelled "Start new run" /
  "Starting new run…". Single click → POST → navigate
  to the new run.
- Same error handling (run-already-active /
  no-PARSED-items / generic) — inherited from the
  shared component.

**Why not a dedicated component:** the API call, error
mapping, and pending-state handling are identical to
the project-page Start button. A label prop is
right-sized vs. a parallel component.

**Key files:** `components/runs/start-review-button.tsx`, `app/projects/[id]/runs/[runId]/page.tsx`

## V2-M60 — Shared `compactCount` formatter helper

**Goal:** Both `TokenSpendBadge` (M36) and the new
`ProjectTokenStat` (M59) implemented their own
"format a token count as 121k / 1.2M" helper. Diverging
behaviour at the M-boundary (token-spend-badge didn't
handle ≥1M; project-token-stat did) waiting to bite
later.

**What shipped:**

- New `lib/format.ts` with a single `compactCount(n)`
  helper. Buckets: <10k locale grouped ("1,234"); 10k..1M
  integer k ("121k"); ≥1M one-decimal M ("1.2M").
  Negatives preserve sign ("-50k"). Non-finite / NaN
  defensively renders as "0".
- Both component callers swapped to the shared helper.
  Local inline `compact` functions deleted.
- 5 unit tests cover the bucket matrix, sign
  preservation, and the non-finite defence.

**Why a defensive non-finite branch:** Prisma's `_sum`
aggregate (used by M59) returns null when there are no
matching rows; the page coalesces with `?? 0`, but if a
future caller forgets the coalesce, `compactCount(null
+ undefined)` would render "NaN" — instead it renders
"0".

**Key files:** `lib/format.ts`, `components/runs/token-spend-badge.tsx`, `components/projects/project-token-stat.tsx`, `tests/lib/format.test.ts`

## V2-M59 — Project-level token aggregate stat

**Goal:** The per-run `TokenSpendBadge` (M36) shows how
close a single run is to MAX_TOKENS_PER_RUN. There was no
project-level counterpart — a user couldn't see "this
whole project has consumed 1.2M tokens across 4 runs"
without manually summing each run's badge.

**What shipped:**

- Project page server query gains a `db.runStep.aggregate
  ({ where: { run: { projectId: id } }, _sum: { ... } })`
  call. Scoped at the project (not just visible runs) so
  the total is correct for projects with >10 runs.
  Single scalar sum query — cheap thanks to FK indexes on
  Run + RunStep.
- New `ProjectTokenStat` component: compact monospace
  badge (`121k tk total`), styled to match the per-run
  badge family but in a neutral stone variant (no
  budget % since there's no project-level cap). Tooltip
  carries the precise breakdown (in / out / cache).
- Compact number formatter handles M / k / raw scales so
  a long-running project doesn't render `1,243,891 tk`
  next to the section heading.
- Auto-hides when billable = 0 so a fresh project
  doesn't render an empty stat.

**Why no test:** the component is presentational
(formatting + conditional render), with the aggregation
done by Prisma's `_sum` (Prisma's own test surface). A
unit test would mostly be tautological.

**Key files:** `components/projects/project-token-stat.tsx`, `app/projects/[id]/page.tsx`

## V2-M58 — Delete-run button on run detail page

**Goal:** Mirroring M57 for runs. The list-row Delete
(M40) handled the project-page case. From the run-detail
page itself, the user had to navigate back to the project
list to discard a run — extra friction for a routine op
(testing a flaky run, cleaning up after a deliberate
failure).

**What shipped:**

- `DeleteRunButton` extended with the same `variant`
  +`redirectTo` props pattern from M57's
  DeleteProjectButton:
    - `"list"` (default) — existing project-page row
      styling + `router.refresh()`.
    - `"page"` — always-visible button with hover-
      destructive border + navigates to `redirectTo`
      after a successful delete.
- Run-detail page header gains the button next to the
  status pill, redirecting to the parent project page
  on success.
- Button label upgraded to "Delete run" (was just
  "Delete") so the affordance reads correctly when it
  sits next to other run-page chrome.

**Key files:** `components/runs/delete-run-button.tsx`, `app/projects/[id]/runs/[runId]/page.tsx`

## V2-M57 — Delete-project button on project detail page

**Goal:** Deletion was reachable only via the dashboard
list (M41) — once a user was *on* the project detail page,
they had to navigate back to the dashboard, find the row,
hover-reveal the Delete affordance, and click. Add a Delete
button directly to the project header next to Edit.

**What shipped:**

- `DeleteProjectButton` extended with a `variant` prop:
    - `"list"` (default) — existing dashboard styling
      (hover-revealed link) + `router.refresh()` on
      success.
    - `"page"` — always-visible button with a subtle
      destructive-on-hover border, suitable for header
      bars + navigates to `/dashboard` on success
      (otherwise the user is left on a page that 404s).
- Project page header now renders `<EditProjectDialog />`
  + `<DeleteProjectButton variant="page" />` side by side.

**Why two variants in one component:** the API + state
machine + confirm-copy + error handling are identical;
only the navigation target + visual styling differ. A
boolean / variant prop is right-sized vs. extracting a
hook + re-implementing the markup twice.

**Key files:** `components/projects/delete-project-button.tsx`, `app/projects/[id]/page.tsx`

## V2-M56 — Relative-time on project page runs list

**Goal:** Same change as M55 but applied to the project
detail page's runs list. Rows read "5/28/2026, 12:42:33 PM"
— locale-dependent and forces the reader to compute "is
that an hour ago or yesterday?". Switch to the M55
`relativeTime` helper so rows read "Started 4 hours ago".

**What shipped:**

- Runs list rows now render `Started {relativeTime(...)}`
  with the absolute datetime preserved in the `<time>`
  tooltip + `dateTime` attribute.
- Page-level `nowMs` snapshot at the start of the map so
  all rows compute against the same reference clock (no
  one-row-off-by-1 second jitter).

**Key files:** `app/projects/[id]/page.tsx`

## V2-M55 — Relative-time "Updated X ago" on dashboard

**Goal:** The dashboard project list eyebrow showed "Updated
28 May 2026" (absolute). For an active project the
glanceable signal is "Updated 2 days ago" / "Updated 4 hours
ago" — easier to triage what needs attention.

**What shipped:**

- New `lib/relative-time.ts` with a `relativeTime(thenMs,
  nowMs, locale?)` helper using `Intl.RelativeTimeFormat`
  so locale negotiation works server-side without a
  separate i18n dep.
- Resolution buckets: <60s "just now"; 60s..1h minutes;
  1h..24h hours; 1d..30d days; 30d..365d months; >365d
  years. Future timestamps clamp to "just now" rather
  than rendering "in 3 seconds" (clock skew).
- `numeric: "auto"` for natural singular forms ("1 minute
  ago" / "yesterday" / "1 hour ago").
- `ProjectList` accepts an optional `nowMs` prop. When
  passed (dashboard does), the eyebrow renders relative
  time; when omitted (showcase fixture), falls back to
  absolute date.
- `<time>` tag retains the ISO `dateTime` attribute and
  gains a tooltip `title` with the absolute datetime so
  accessibility tech still surfaces the precise time.
- 4 unit tests (just-now / bucket matrix / numeric:auto
  singular form / future-clock-skew clamp).

**Why server-passed nowMs and not a client effect:**
matches the M43 step-duration pattern. The dashboard
re-renders on every navigation back to it, so the
relative-time copy refreshes naturally; a live-ticking
effect would be overkill for the eyebrow surface.

**Key files:** `lib/relative-time.ts`, `components/projects/project-list.tsx`, `app/dashboard/page.tsx`, `tests/lib/relative-time.test.ts`

## V2-M54 — Latest-run pill on dashboard project rows

**Goal:** The dashboard project list showed title + scope
badge + papers/reviews counts. A user with several
projects couldn't tell *at a glance* if a project's most
recent run was completed, mid-flight, or failed — they
had to click into each project to see.

**What shipped:**

- Dashboard query adds
  `runs: { orderBy: { createdAt: "desc" }, take: 1,
    select: { status: true, createdAt: true } }`. Cheap
  thanks to the implicit `[projectId, createdAt]` index
  from the FK + orderBy.
- ProjectList row's title gets a small inline status pill
  rendered via the same `RunStatusPill` the project page
  uses — so the visual language is consistent across the
  dashboard + project-detail surfaces.
- Pill hides when the project has zero runs (a fresh
  project shouldn't read "pending" without context).
- `runs?` on the Project prop is optional for the same
  showcase-fixture forward-compat reason `_count?` was —
  v1-style callers without that data render the existing
  layout unchanged.

**Why "latest" and not a summary:** the M49 RunsBreakdown
already provides a multi-status summary on the project
detail page. On the dashboard, the latest run is the most
actionable signal — "is the thing I started yesterday
done yet" / "did the run I queued before lunch finish".

**Key files:** `app/dashboard/page.tsx`, `components/projects/project-list.tsx`

## V2-M53 — Empty-discovery guidance copy

**Goal:** When the discoverer ran but every adapter
returned zero papers, the DiscoverySummary header still
just read "5 queries ran across the project's configured
providers." with no follow-up — the user didn't know what
to do next.

**What shipped:**

- Empty case now appends actionable guidance to the
  header:
    - If at least one provider errored: "All configured
      providers errored — see the panel below." (points
      at the existing partial-failures panel).
    - Otherwise: "Try broadening the research question,
      widening the year range, or adding more providers
      via Edit project." (recommends the M39
      EditProjectDialog as the action).
- Branch fires only when `queries.length > 0` —
  pre-discovery (no queries yet) shows nothing, since the
  next refresh-tick will reveal the count.

**Why no helper / no test:** the change is two ternaries
in JSX — already-tested upstream signals (queries.length,
providerErrors.length) drive the copy choice.

**Key files:** `components/runs/discovery-summary.tsx`

## V2-M52 — Discovery summary shows per-provider counts

**Goal:** The discovery summary header showed total
discovered papers + screening verdicts but not which
*provider* surfaced them. When the provider-errors panel
flagged a partial failure, the user couldn't tell whether
that failure cost them many or few papers.

**What shipped:**

- New `perProviderCounts()` helper grouping the
  `DiscoveredPaper[]` by provider, sorted by descending
  count (tiebreak: alphabetical label). Returns
  presentation-ready labels so unknown providers don't
  render as their raw enum string.
- `PROVIDER_LABEL` lookup lifted out of the existing inline
  badge map so the helper can reuse it.
- Summary header gains a third caption line:
  `By provider: OpenAlex 12 · arXiv 5 · Exa 3`. Only
  rendered when >1 provider returned papers (a single-
  provider run doesn't need the breakdown).
- 4 unit tests cover counting, descending-with-tiebreak
  ordering, unknown-provider forward-compat, and the
  empty-list base case.

**Why this matters with the partial-failures panel:**
when "arxiv: 429" appears in errors AND "by provider:
OpenAlex 12 · arXiv 0" appears in the summary, the user
sees immediately that the 429 cost the run all of its
arXiv coverage. Pre-this they had to guess.

**Key files:** `components/runs/discovery-summary.tsx`, `tests/components/discovery-summary-counts.test.ts`

## V2-M51 — Surface failed-step name on FAILED runs

**Goal:** When a run failed, the run-detail header just
showed `run.failureReason` as a single line of red text.
The user had to scan the steps list to find which step
blew up. For FAILED runs this is the most important
information on the page — promote it.

**What shipped:**

- The single line of red text becomes a small bordered
  destructive panel containing:
    - The `run.failureReason` (terminal-error copy).
    - A "Failed during: [humanised node name]" caption
      identifying the last step with a `failureReason`,
      using `nodeLabel` for the friendly mapping.
    - When the step's failureReason differs from the
      run-level reason (e.g. extractor failed with "Mistral
      429" but the run's reason was a wrapper message),
      both are shown.
- "Last step with failureReason by startedAt" is the
  heuristic — covers the common case where the terminal
  failure is the outermost step + the inner-per-item case
  where a per-paper step had its own failure that
  bubbled up.

**Why no separate tests:** the change is presentational
(JSX inside the failure branch); existing run-detail
integration tests would need DOM scraping to verify, which
isn't worth standing up jsdom for. The failed-step lookup
is a one-liner over `run.steps` (already test-covered as
a Prisma include).

**Key files:** `app/projects/[id]/runs/[runId]/page.tsx`

## V2-M50 — Per-page tab titles

**Goal:** Every page in the app rendered with the same
"Thoth — Agentic systematic literature reviews" tab title
because only `app/layout.tsx` declared metadata. Users with
several Thoth tabs open had to switch into each tab to know
which project / run it was.

**What shipped:**

- `app/projects/[id]/page.tsx` adds a `generateMetadata`
  that renders `${project.title} — Thoth` as the tab
  title. Existence-probe posture preserved: a missing /
  not-yours project gets "Project not found" instead of a
  richer title.
- `app/projects/[id]/runs/[runId]/page.tsx` adds a
  `generateMetadata` that renders
  `${project.title} — ${status}` ("GAT review —
  completed", "GAT review — awaiting plan review"). A
  status in the tab title means juggling multiple
  in-flight runs across tabs becomes possible without
  context-switching into each.
- Both fall back to a generic title before owner checks
  complete so an existence-probe can't enumerate other
  users' project / run titles via tab metadata.

**Why no separate tests:** Next.js metadata generation is
tested by Next.js itself; our `generateMetadata` is just
an `await` + a conditional that mirrors the page-handler's
existing posture (which IS test-covered).

**Key files:** `app/projects/[id]/page.tsx`, `app/projects/[id]/runs/[runId]/page.tsx`

## V2-M49 — Runs section status breakdown

**Goal:** The "Reviews" section on the project page just
showed N rows with status pills. With several runs the
user had to eyeball the pills to know "did anything
complete?" / "is anything still going?". Add a one-line
breakdown above the list.

**What shipped:**

- New `bucketRuns()` helper sorting runs into completed /
  failed / active buckets. REJECTED is grouped with FAILED
  ("didn't produce a draft") rather than its own bucket —
  the project-page summary is about outcomes, not reasons.
- `RunsBreakdown` component renders a tabular-nums caption:
  "2 completed · 3 in progress · 1 failed". Zero-count
  buckets are hidden so a fresh project doesn't read "0
  completed · 0 active · 0 failed". Returns null when all
  buckets are zero.
- Project-page Reviews section header gets the breakdown
  line under the "Reviews" h2 + above the runs list.
- Forward-compat: unknown statuses are silently ignored so
  a future enum member can't render junk.
- 5 unit tests cover mixed buckets, empty list, V2 active
  states, REJECTED grouping, and unknown-status forward
  compat.

**Why bucket from `project.runs` (top 10) rather than
groupBy:** the project page already loads the runs for
the list; reusing the data avoids a second DB round-trip.
For projects with >10 runs the breakdown is "of the 10
most recent" — accurate enough for the at-a-glance
summary the section is meant to provide.

**Key files:** `components/runs/runs-breakdown.tsx`, `app/projects/[id]/page.tsx`, `tests/components/runs-breakdown.test.ts`

## V2-M48 — Status pill covers all V2 states + friendlier labels

**Goal:** The `RunStatusPill` component's status union +
variant map were V1-only — missing the four V2 states
(DISCOVERING, AWAITING_DISCOVERY_APPROVAL, FETCHING,
SCREENING). When a V2 run was in any of those states, the
`VARIANT[status]` lookup returned undefined and the Badge
silently fell back to no-variant rendering.

**What shipped:**

- Status union extended with the V2 states.
- Variant map matches V1 visual semantics: processing
  states are "secondary" (subtle), HITL gates "default"
  (prominent).
- New `statusLabel(status)` helper renders friendlier copy
  for the awkward AWAITING_* statuses:
    - `AWAITING_PLAN_APPROVAL` → "awaiting plan review"
    - `AWAITING_PAPERS_APPROVAL` → "awaiting paper review"
    - `AWAITING_DISCOVERY_APPROVAL` → "awaiting discovery
      review"
- Defensive `VARIANT[status] ?? "outline"` fallback at the
  call site so a future-added enum value still renders
  *something* until the map catches up.
- 3 unit tests cover the simple cases, the AWAITING_*
  friendlier mapping, and a compile-time + runtime check
  that every union member produces a non-empty label.

**Key files:** `components/runs/run-status-pill.tsx`, `tests/components/run-status-pill.test.ts`

## V2-M47 — Corpus list shows real paper titles

**Goal:** The corpus list rows showed only `item.source`
— `corpus/<projectId>/<uuid>.pdf` for uploads,
`openalex:W4234567` / `arxiv:2310.06770` for V2 discoveries.
Functional but opaque; you couldn't tell what paper a row
was at a glance.

**What shipped:**

- New `corpusItemLabel(item)` helper. Priority:
    1. First H1/H2 heading line of `parsedMarkdown`
       (Mistral OCR consistently emits the paper title as
       `# Title`). Works for both uploads AND V2 fetched
       papers once OCR'd.
    2. Humanised `source` fallback for items that haven't
       been OCR'd yet (PENDING / PARSING / FAILED): R2 key
       → filename only; `openalex:W123` → "OpenAlex W123";
       `arxiv:2310.06770` → "arXiv 2310.06770"; `exa:url`
       → "Exa url". Unknown prefixes pass through (forward
       compat for new providers).
    3. Long titles >140 chars get truncated with an
       ellipsis so a long DOI/long thesis title doesn't
       blow the layout.
- ItemCard now renders `corpusItemLabel(item)` as the
  primary title (medium-weight) with the raw `source`
  underneath as a small mono caption. Hover-tooltip on
  the title shows the raw source.
- 9 unit tests cover the matrix (5 markdown extraction
  cases, 4 source-fallback cases including unknown
  prefixes).

**Why not also join `discoveredAs.title` from the
DiscoveredPaper table:** the parsedMarkdown heading is the
canonical title once OCR succeeds, and items that haven't
been OCR'd yet still need a fallback anyway. Adding the
DiscoveredPaper join would only catch a brief window after
fetch + before OCR — not worth the query cost.

**Key files:** `components/corpus/corpus-item-list.tsx`, `tests/components/corpus-item-label.test.ts`

## V2-M46 — Dashboard project counts at a glance

**Goal:** The dashboard project list showed title +
question + updated-date but no signal of "how big" each
project was. Users with several projects had to click into
each to learn how many papers + runs were inside.

**What shipped:**

- Dashboard query adds `_count: { select: { corpus: true,
  runs: true } }` — a single Postgres scalar subquery per
  relation, no N+1 fan-out.
- `ProjectList` row renders a small "3 papers · 1 review"
  line below the research-question deck. Tabular-nums
  alignment + stone color so it sits as a quiet third tier
  under the title + question.
- `countsLine` helper handles singular/plural for each
  side independently — "1 paper · 5 reviews", "7 papers ·
  1 review", "0 papers · 0 reviews". 3 unit tests cover
  the matrix.
- `_count` is optional on the type so the showcase project
  built from a v1-shape fixture (and any other v1-style
  caller) can omit it without rendering "undefined".

**Key files:** `app/dashboard/page.tsx`, `components/projects/project-list.tsx`, `tests/components/project-list-counts.test.ts`

## V2-M45 — Corpus-item delete affordance

**Goal:** Users could upload PDFs but couldn't delete
individual corpus items. To remove a wrong-PDF they had to
delete the whole project. Closing this CRUD gap.

**What shipped:**

- New `DELETE /api/corpus/[id]` route. Owner check via
  project FK before delete; 404 (not 403) for not-yours to
  match the existence-probing posture. Cascade behaviour
  spelled out in the route doc:
    - `IncludedPaper` rows cascade-delete (with their
      `ExtractedClaim` + `ClaimCheck` children).
    - `ScreeningDecision.corpusItemId` becomes null
      (SetNull) — the decision row survives.
- `CorpusItemList` ItemCard renders a small inline
  "Delete" button next to the existing actions. Click →
  confirm() spelling out the cascade ("If any review run
  included this paper, its included-paper + extracted-claim
  rows will be deleted with it. The review draft itself
  is preserved.") → DELETE → `router.refresh()`.
- 4 unit tests cover the endpoint (happy / 404 missing /
  404 not-yours / 401 unauthenticated).

**Why allow delete on items used in completed runs:** the
alternative would be to block, forcing the user to
"discard the run, then delete the item" — high friction
for a low-stakes operation in a single-user app. The
confirm() copy spells out the impact instead.

**Key files:** `app/api/corpus/[id]/route.ts`, `components/corpus/corpus-item-list.tsx`, `tests/api/corpus-delete.test.ts`

## V2-M44 — Humanised node-name labels in step timeline

**Goal:** The step list showed raw nodeName values
("planner", "retriever", "discoverer", "fetcher_paper",
"cite_check_citation"). Recognisable to maintainers; opaque
to new users.

**What shipped:**

- New `nodeLabel(nodeName)` helper mapping each agent node to
  a verb-y, present-tense label:
    - planner → "Planning the review"
    - retriever → "Retrieving papers"
    - discoverer → "Discovering outbound papers"
    - fetcher → "Fetching paper metadata"
    - screener → "Screening papers"
    - assessor → "Assessing papers"
    - drafter → "Drafting the review"
    - critic → "Reviewing the draft"
    - cite_check → "Verifying citations"
- Inner per-item nodes (suffix `_paper` / `_citation`) get a
  singular variant so a screen full of "Verifying citation"
  rows reads naturally.
- Forward-compat: unknown nodeNames fall through to the raw
  string (new nodes won't render `undefined`).
- 3 unit tests cover the outer mappings, the inner per-item
  mappings, and the unknown-name fallback.

**Key files:** `components/runs/run-step-list.tsx`, `tests/components/run-step-list.test.ts`

## V2-M43 — Per-step durations in run timeline

**Goal:** A run takes 5-15 minutes end-to-end and can stall
on any node (Mistral rate limit on extractor, LLM call slow,
search adapter timeout). The step list showed `nodeName` +
token usage + trace link but nothing about *how long* each
step took, so it was impossible to spot a slow step at a
glance.

**What shipped:**

- New `formatStepDuration(ms)` helper with 5 unit tests
  covering: sub-second (1-decimal), 1s..59s (integer), 1m..
  59m (omitting 0s suffix), >=1h (omitting 0m suffix), and
  negative/non-finite clamp to "0s" (wall-clock skew
  shouldn't render "-3s").
- `RunStepList` now renders the duration next to each
  step's token usage. In-progress steps render in Thoth
  blue to signal liveness; completed steps render in the
  default muted color.
- `nowMs` is passed in as a prop rather than computed in
  render — React 19's purity rule blocks impure calls in
  render bodies. The run-detail server page captures
  `Date.now()` once per request; RefreshTick polls every 2s
  so in-progress durations tick up naturally.

**Key files:** `components/runs/run-step-list.tsx`, `app/projects/[id]/runs/[runId]/page.tsx`, `tests/components/run-step-list.test.ts`

## V2-M42 — Live run-status polling on the project page

**Goal:** The run-detail page polls every 2s via `RefreshTick`
so the user sees plan-approval gates, paper-approval gates,
status changes, and step events update in place. The project
page (where the runs list lives) didn't poll, so a user who
kicked off a run and stayed on the project page had to
manually refresh to see status pills move PROCESSING →
AWAITING_PLAN_APPROVAL → AWAITING_PAPER_APPROVAL → COMPLETED.

**What shipped:**

- Refactored `RefreshTick` to delegate to a new
  `RefreshTickList` that polls if *any* of N runs is non-
  terminal. Single-run wrapper preserves the existing API.
- Added `<RefreshTickList runs={...}/>` to the project-page
  runs list so it polls 2s while any visible run is active.
- Visibility-pause + immediate-refresh-on-tab-return
  semantics are inherited from the underlying effect.

**Why not one tick per row:** they'd all share the same
`router.refresh()` (it's the page-level cache, not per-row),
and we'd pay N timers' worth of overhead. Computing
"anyActive" once at the list level is cleaner.

**Why no unit tests:** the polling effect needs jsdom +
react-testing-library to exercise; existing component tests
use server-side `renderToString` which doesn't run effects.
The behavior is verified by the live e2e (which observes
status transitions on the project page).

**Key files:** `components/runs/refresh-tick.tsx`, `app/projects/[id]/page.tsx`

## V2-M41 — Delete-project affordance in dashboard

**Goal:** Symmetric with M40. `DELETE /api/projects/[id]`
existed (added in M24) but the only callers were the e2e
test + curl-by-hand. The dashboard project list didn't
surface deletion, so users had to leave the UI to discard a
project.

**What shipped:**

- `DeleteProjectButton` client component (`components/projects/delete-project-button.tsx`)
  — same shape as `DeleteRunButton`: confirm() → DELETE →
  `router.refresh()`. Confirm copy spells out the cascade
  ("every run, paper, claim, and check") since project
  deletion is the most destructive op in the app.
- Project-list row layout: the existing `<Link>` still wraps
  the card content; the delete button is absolutely
  positioned on top, outside the `<Link>` element, so it
  doesn't nest interactive elements (a11y + Safari
  click-bubble safety). `opacity-0 group-hover:opacity-100`
  keeps the editorial dashboard clean until the user mouses
  over a row.

**Key files:** `components/projects/delete-project-button.tsx`, `components/projects/project-list.tsx`

## V2-M40 — Delete-run affordance

**Goal:** Close the Run CRUD gap. POST /api/runs (start), GET
/api/runs/[id] (read), but no DELETE — failed/test runs were
stuck cluttering the project page forever. Add the missing
endpoint + a small UI button per row.

**What shipped:**

- `DELETE /api/runs/[id]` route. Owner-check via project FK
  before delete; 404 (not 403) for not-yours to match the
  existence-probing posture; FK cascade handles the cleanup
  (RunStep, HumanCheckpoint, IncludedPaper, ExtractedClaim,
  ClaimCheck, DiscoveredPaper, ScreeningDecision — all
  onDelete: Cascade pointing at Run).
- `DeleteRunButton` client component (`components/runs/delete-run-button.tsx`)
  — small inline "Delete" affordance with a `confirm()` guard.
  Lives outside the runs-list `<Link>` to avoid nested
  interactive elements.
- Project page run-list layout updated to flex the link + the
  delete button side-by-side. Click → confirm → 204 →
  `router.refresh()` re-fetches the list from the server.
- 4 unit tests cover the DELETE endpoint (happy path / 404
  missing / 404 not-yours / 401 unauthenticated).

**Why a `confirm()` and not a more elaborate confirm dialog:**
the cascade is consequential (every step, checkpoint, included
paper, claim, claim-check is dropped) but reversible only via
restart-from-zero — there's no undo. A browser confirm() is
adequate friction without a heavyweight dialog component.

**Key files:** `app/api/runs/[id]/route.ts`, `components/runs/delete-run-button.tsx`, `app/projects/[id]/page.tsx`, `tests/api/runs-delete.test.ts`

## V2-M39 — Edit Project dialog UI

**Goal:** Close the loop on M38. The PATCH endpoint exists; surface
it via an Edit button on the project detail page header.

**What shipped:**

- New `EditProjectDialog` client component
  (`components/projects/edit-project-dialog.tsx`). Mirrors
  `NewProjectDialog`'s field set + UI conventions but:
    - Pre-fills every field from the current project row.
    - POSTs `PATCH /api/projects/<id>` instead of `POST /api/projects`.
    - Submit button reads "Save" not "Create".
    - On success, `router.refresh()` instead of `router.push(...)`
      so the user stays on the project page.
- Project page header gains a flex-row layout: title + question on
  the left, Edit button on the right.
- Why a sibling component instead of reusing NewProjectDialog with
  a mode prop: the create + edit flows diverge in defaulting,
  navigation, and button text; two clear siblings read better than
  a two-mode super-component.

**Key files:** `components/projects/edit-project-dialog.tsx`, `app/projects/[id]/page.tsx`

## V2-M38 — PATCH /api/projects/[id] for editing project settings

**Goal:** A real CRUD gap. Users could create + read + delete
projects (POST /api/projects, GET /api/projects/[id], DELETE
/api/projects/[id]) but the only way to change a project's
settings (typo in title, flip scope from uploaded_only to
outbound, switch providers, adjust max-hits) was to delete + start
over. Add the missing PATCH endpoint.

**What shipped:**

- New `PATCH /api/projects/[id]` route. Schema mirrors the POST
  create schema with every field optional + the same Zod refines
  (year-range ordering, maxHits ≤ 100). Auto-defaults providers
  to OpenAlex+arXiv when flipping scope to outbound/hybrid AND the
  caller didn't pass an explicit list AND the row currently has
  no providers — matching the create-time defaulting behavior.
  Owner check via `updateMany({ where: { id, ownerId } })` pushes
  the filter to the DB layer (same atomic pattern as DELETE in
  M24). 404 for unowned/missing, 400 for validation failure,
  401 for unauthenticated.
- 6 new unit tests cover: happy-path update, 404 unowned, 400
  yearStart>yearEnd, provider auto-default branch, explicit-list
  branch skips the default, 401 unauth.

**What still doesn't ship in this milestone (deliberate):** the UI
to surface this endpoint. A future iteration could add an
"Edit project" dialog reusing the NewProjectDialog shape. For now
the API surface is sufficient — power users + MCP-driven flows can
call it directly.

**Key files:** `app/api/projects/[id]/route.ts`, `tests/api/projects.test.ts`

## V2-M37 — BibTeX export of included papers

**Goal:** Researchers writing actual literature reviews need to
cite the papers Thoth selected. They can copy DOIs from the
discovery summary manually but that's friction. Add a one-click
BibTeX download to drop straight into their `.bib` file.

**What shipped:**

- New helper `lib/bibtex.ts` with `paperToBibtex` +
  `buildBibtexFile`. Picks `@article` when a DOI is present,
  `@misc` otherwise (the catch-all for arXiv preprints + grey
  literature). Citation keys match the draft's `paper_NNN`
  convention so search-and-replace into LaTeX works directly.
  Title escaping handles `\`, `{`, `}`, `@`. Key sanitisation
  preserves DOI dots but replaces slashes with underscores.
- New route: `GET /api/runs/[id]/citations.bib`. Joins each
  IncludedPaper to its CorpusItem for title (extracted from the
  first `# ` heading in parsedMarkdown) + externalDoi +
  externalArxivId + source. `Content-Disposition: attachment;
  filename="thoth-<id>-citations.bib"`. 404 for no-draft,
  unowned, or missing.
- `DraftView` gains a second "Download .bib" link alongside the
  M34 "Download .md" link. The download trio is now: markdown
  draft (M34) · cite_check audit JSON (M35) · BibTeX citations
  (M37).
- 14 new tests: 9 in `tests/lib/bibtex.test.ts` (every BibTeX
  branch + edge case) + 5 in `tests/api/runs-citations-bib.test.ts`
  (full route shape, no-draft, unowned, unauth, empty-corpus
  comment).

**Key files:** `lib/bibtex.ts`, `app/api/runs/[id]/citations.bib/route.ts`, `components/runs/draft-view.tsx`, `tests/lib/bibtex.test.ts`, `tests/api/runs-citations-bib.test.ts`

## V2-M36 — Token-spend badge on the run-detail page

**Goal:** Researchers on free-tier LLMs care about per-run cost.
The cost-cap (`MAX_TOKENS_PER_RUN`) already enforces a hard
ceiling — but until now there was no UI visibility into where
each run sat relative to that ceiling. A user couldn't tell from
the run-detail page whether a review consumed 5% of the budget
or 95%.

**What shipped:**

- New `TokenSpendBadge` server component
  (`components/runs/token-spend-badge.tsx`). Sums input + output
  tokens across all RunSteps (matching `cost-cap.ts`'s billable
  definition — cache reads excluded, shown separately on hover).
  Renders next to the status pill on the run-detail header.
- Color thresholds: <50% neutral stone · 50–80% gold (heading
  toward the cap) · ≥80% warn brick (close to
  BudgetExceededError).
- Compact format: `121,463` → `121k` to keep the badge from
  ballooning. Full unabbreviated values live in the title
  attribute on hover.
- Run-detail page passes `env.MAX_TOKENS_PER_RUN` (400k default
  per M6) so the percentage reflects whatever the deploy is
  configured for.
- 7 new tests cover: input+output summing, k-suffix formatting,
  cache-token exclusion, warn-color threshold (≥80%), neutral
  threshold (<50%), title-attribute breakdown content, no-cache
  title omission.

**Key files:** `components/runs/token-spend-badge.tsx`, `app/projects/[id]/runs/[runId]/page.tsx`, `tests/components/token-spend-badge.test.ts`

## V2-M35 — cite_check audit JSON download

**Goal:** Parallel to M34. The markdown draft is downloadable;
the cite_check audit (per-claim verdicts + faithfulness score)
deserves the same treatment for downstream analysis. Users with
an MCP client already have this data via `get_citation_audit`;
this gives non-MCP users the same channel.

**What shipped:**

- New route: `GET /api/runs/[id]/audit.json`. Returns the audit
  in the same shape the `get_citation_audit` MCP tool returns
  (reviewId, faithfulnessScore, totalClaims + per-verdict
  counts, claims[]). `Content-Disposition: attachment;
  filename="thoth-<id>-audit.json"`. `Cache-Control: no-store`
  matches the M34 endpoint's behaviour. 404 for "no draft yet"
  (cite_check only runs once the drafter completes), unowned,
  or missing.
- `CitationFaithfulnessWidget` gains an optional `runId` prop +
  renders a "Download .json" link in its header. The showcase
  page intentionally omits `runId` (public exemplar, not the
  user's own data).
- 5 new tests in `tests/api/runs-audit-json.test.ts`: full audit
  shape, no-draft 404, unowned 404, unauthenticated 401, empty
  claimChecks array.

**Key files:** `app/api/runs/[id]/audit.json/route.ts`, `components/runs/CitationFaithfulnessWidget.tsx`, `app/projects/[id]/runs/[runId]/page.tsx`, `tests/api/runs-audit-json.test.ts`

## V2-M34 — Markdown download for the draft

**Goal:** Real UX gap — users can read the draft in the page but
can't keep a copy without copy-pasting. For a research tool whose
output IS the review, that's a significant friction.

**What shipped:**

- New route: `GET /api/runs/[id]/draft.md`. Returns the draft
  markdown as `Content-Disposition: attachment; filename="thoth-<runId>.md"`.
  `Cache-Control: no-store` so a re-run's fresh draft isn't masked by
  the browser's cached copy. 404 for "no such run", "not yours",
  or "no draft yet" (same existence-probe defense as the rest of
  the API).
- `DraftView` gains an optional `runId` prop + renders a
  "Download .md" link next to the heading when set. Uses native
  `<a download>` so no client-side state is needed.
- Run-detail page passes `runId` through. The showcase page
  intentionally doesn't — the seeded exemplar is a public
  read-only artifact, not the user's own data to save.
- 4 new tests in `tests/api/runs-draft-md.test.ts` cover: 200
  with correct headers + body, 404 (no draft), 404 (unowned),
  401 (unauthenticated).

**Key files:** `app/api/runs/[id]/draft.md/route.ts`, `components/runs/draft-view.tsx`, `app/projects/[id]/runs/[runId]/page.tsx`, `tests/api/runs-draft-md.test.ts`

## V2-M33 — SSRF defense in the fetcher

**Goal:** The V2 fetcher pulls PDFs from URLs in `DiscoveredPaper.oaUrl`,
which originate in provider responses (OpenAlex / arXiv / Exa). A
compromised or malicious provider response could include URLs
targeting internal services — `http://localhost`, `http://127.0.0.1`,
`http://169.254.169.254/latest/meta-data/` (AWS metadata =
IAM-credential leak), RFC 1918 subnets, or non-HTTP schemes
(`file://`, `ftp://`, `gopher://`). Defense-in-depth: validate the URL
shape before calling `fetch()`.

**What shipped:**

- New exported helper `isSafeExternalUrl(url: string): boolean` in
  `lib/agent/nodes/fetcher.ts`. Rejects:
    - Non-HTTP(S) schemes
    - `localhost` / `[::1]` / `127.0.0.0/8` loopback
    - `169.254.0.0/16` link-local (AWS/GCP metadata service)
    - RFC 1918 private subnets (10/8, 172.16-31/12, 192.168/16)
    - The `0.0.0.0` wildcard
    - Malformed URLs (catches the `new URL(url)` throw)
- `downloadPdf()` calls the validator before HEAD — keeps the
  SSRF probe out of the network stack entirely.
- 9 new tests in `tests/lib/agent/nodes/fetcher-ssrf.test.ts`
  covering each rejection class + a few "this IP looks private but
  is NOT actually private" boundary cases (172.15.x.x and 172.32.x.x
  must pass).

**Limits:** This is a defense-in-depth layer, not a full SSRF
fix. A DNS-rebind attack (resolve external first, then internal on
second resolution) would still get through. Vercel's network
isolation handles that case at the infrastructure level; this
helper catches the obvious probe shapes before they even leave the
runtime.

**Key files:** `lib/agent/nodes/fetcher.ts`, `tests/lib/agent/nodes/fetcher-ssrf.test.ts`

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
