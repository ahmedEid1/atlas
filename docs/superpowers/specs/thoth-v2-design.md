# Thoth v2 — Design

**Status:** Shipped — milestone log lives in the roadmap doc. V1 design is at [`thoth-design.md`](./thoth-design.md).
**Owner:** Ahmed Hobeishy

---

## 1. Why v2

V1's retriever scores papers from the **project's uploaded corpus only**. The
out-of-scope list explicitly defers outbound search (`Exa, OpenAlex, web search
— deferred`) and the design doc closes that decision tightly for the GDPR
story.

The v2 thesis: **make Thoth find its own papers.** The user gives a research
question; the agent discovers candidate papers across academic indices,
acquires their full text where openly available, screens them against the
plan's inclusion criteria, and only then drops into V1's existing
assessor → drafter → critic → cite_check pipeline. The uploaded-PDF surface
stays — V1 users keep working. V2 is additive.

This is the biggest single capability expansion since M5 (the MCP server).
Done right, it turns Thoth from "a workspace for a corpus you've already
collected" into "a tool you point at a research question and walk away from
for 30 minutes."

### Non-goals (still)

- Real-time multi-user collaboration on a single run.
- Quantitative meta-analysis (effect-size extraction, forest plots). Tracked
  for v2.x, **not** the v2.0 thesis.
- Multi-tenant org workspaces. Each project still belongs to one `User`.
- Writing assistance during the human-approval pause — the user reviews,
  doesn't co-author the draft.

---

## 2. Architecture changes

New nodes between `planner` and `retriever`. The V1 flow stays from
`assessor` onward.

```
START
  ↓
planner ─────────────→ plan_gate ──(approve)──→ discoverer
                            └─(reject)→ END         ↓
                                                    ▼
                                          discovery_gate (NEW HITL: edit query set?)
                                                    │
                                       ┌────────────┘
                                       ▼
                                    fetcher  (acquire PDFs for open-access hits)
                                       │
                                       ▼
                                    screener (per-paper inclusion check)
                                       │
                                       ▼
                                  papers_gate ──(approve)──→ assessor
                                       └─(reject)→ END
                                                                ↓
                                                             drafter ← ── ┐
                                                                ↓        │
                                                             critic ─revise (<2)
                                                                ↓ approve
                                                            cite_check
                                                                ↓
                                                              END
```

Concretely:

- **`discoverer`** (NEW, smart tier): takes the PICOC + sub-questions and emits
  N search queries per provider (4-8 queries total). Calls each provider in
  parallel, deduplicates by DOI / canonical-id, returns a `DiscoveredPaper[]`
  ranked by initial relevance heuristics (title-question similarity + venue
  prior + citation count).
- **`discovery_gate`** (NEW HITL): shows the user the generated queries and
  the deduplicated hit list (top 50 by initial rank). They can drop a query
  ("too broad"), add one, or approve. Same `interrupt()` + Trigger.dev
  `wait.forToken` pattern V1 uses for plan_gate.
- **`fetcher`** (NEW, no LLM): for each approved hit, resolves its
  open-access URL (OpenAlex `oa_url`, arXiv PDF link, Crossref `link[]` array
  filtered to OA), downloads the PDF to R2, runs Mistral OCR. Skips closed
  access (records `accessStatus: "paywalled"`). Bounded concurrency (8) so
  one slow source doesn't stall the run.
- **`screener`** (NEW, fast tier): per-paper inclusion decision against the
  plan's criteria. Replaces V1's retriever in spirit, but operates on
  fetcher-produced corpus items rather than user-uploaded ones. Records
  decision + reason + relevance score to `ScreeningDecision`.
- **`papers_gate`**: existing HITL gate, unchanged in shape. The list it
  proposes is now screener output rather than retriever output.

Everything from `assessor` onward is V1 code, unchanged. Drafter, critic, and
cite_check don't care how the included papers got there.

---

## 3. Data model

New tables + columns. All migrations additive; existing v1 projects keep
working (they default to `searchScope: "uploaded_only"`).

```prisma
enum SearchScope {
  uploaded_only   // V1 behaviour. Default for existing rows.
  outbound        // V2: agent searches indices itself.
  hybrid          // both — uploaded PDFs counted alongside discovered ones.
}

model Project {
  // ... existing fields ...
  searchScope        SearchScope  @default(uploaded_only)
  searchProviders    String[]                              // ["openalex","arxiv","exa"], etc.
  searchYearStart    Int?                                  // 1999..2026 or null
  searchYearEnd      Int?
  searchMaxHits      Int          @default(50)             // hard cap on discoverer output
}

model DiscoveredPaper {
  id              String   @id @default(cuid())
  runId           String
  run             Run      @relation(fields: [runId], references: [id], onDelete: Cascade)
  provider        String                                   // "openalex" | "arxiv" | "exa" | ...
  externalId      String                                   // DOI / arXiv id / OpenAlex W-id
  title           String
  authors         String[]
  abstract        String?       @db.Text
  publicationYear Int?
  venue           String?
  citationCount   Int?
  oaUrl           String?                                  // openly-accessible PDF URL when known
  accessStatus    String                                   // "open" | "paywalled" | "unknown"
  initialScore    Float                                    // discoverer's relevance heuristic
  corpusItemId    String?                                  // populated after fetcher downloads
  createdAt       DateTime @default(now())

  @@unique([runId, externalId])
  @@index([runId])
}

model ScreeningDecision {
  id              String   @id @default(cuid())
  runId           String
  run             Run      @relation(fields: [runId], references: [id], onDelete: Cascade)
  discoveredPaperId String
  discoveredPaper DiscoveredPaper @relation(fields: [discoveredPaperId], references: [id], onDelete: Cascade)
  include         Boolean
  reason          String   @db.Text
  relevanceScore  Float
  createdAt       DateTime @default(now())

  @@index([runId])
}
```

The existing `CorpusItem` gains optional cross-reference columns so an
acquired paper can be looked up by external id without an extra join:

```prisma
model CorpusItem {
  // ... existing ...
  source       String       // "upload" | "openalex:W..." | "arxiv:2310.06770" | ...
  externalDoi  String?      @unique
  externalArxivId String?   @unique
}
```

---

## 4. Search providers — v2.0 scope

Three providers in v2.0; more in v2.x.

| Provider | Why | Free-tier limit | Used for |
|---|---|---|---|
| **OpenAlex** | 250M+ works, comprehensive, no API key, well-structured | 100k/day per IP (anonymous), no auth needed for read | primary metadata + OA URL resolution |
| **arXiv** | Pre-prints, full-text PDFs always OA, machine-readable | Polite 3-second between calls (no daily cap) | physics/CS preprints + PDF acquisition |
| **Exa** | Semantic search (embeddings, not keywords) | 1000 searches/mo free | tightening recall on niche / phrasing-sensitive queries |

**Deferred to v2.1+:**

- Semantic Scholar (S2) — useful citation graph but needs key + rate limit signoff.
- PubMed — biomedical only; deferring until first biomedical eval golden lands.
- Crossref — primarily DOI resolution; integrate when OpenAlex's resolution misses.
- Google Scholar — no public API; scraping is fragile + ToS-risky.

Each provider gets a thin adapter at `lib/search/providers/<name>.ts`
matching the LLM-provider pattern from `lib/llm/providers/`. The dispatcher
is `lib/search/dispatch.ts`. Provider failure is **per-provider tolerable**
— a 5xx from one provider records the error to `DiscoveredPaper` (no rows)
and the run continues with the other providers.

---

## 5. PDF acquisition

The fetcher node downloads PDFs for OA hits. Pipeline:

1. For each `DiscoveredPaper` where `accessStatus === "open"` and `oaUrl !== null`:
   - HEAD the URL, check `Content-Type: application/pdf` and `Content-Length < 50MB`.
   - GET, stream to R2 at `corpus/<projectId>/discovered/<discoveredPaperId>.pdf`.
   - Call `parsePdfWithMistral` (V1 path, no change).
   - Create `CorpusItem` row with `source: "openalex:W..."` and the new
     `externalDoi` / `externalArxivId` columns.
   - Link back via `DiscoveredPaper.corpusItemId`.
2. Bounded concurrency at 8 (constant in `lib/agent/nodes/fetcher.ts`). Slow
   provider doesn't stall the run.
3. On HEAD failure / non-PDF / 4xx / timeout (30s): record
   `accessStatus: "paywalled"` and skip. Screener handles the abstract-only
   case by scoring against title + abstract instead of full text.
4. Cost-cap participates: each Mistral OCR call sums into the run's token
   budget per the existing cost-cap rules (Mistral OCR isn't an LLM call but
   we estimate ~50 tokens/page for budget accounting).

---

## 6. HITL gates

Three HITL gates in V2 (V1 had two — plan + papers):

- **`plan_gate`** — unchanged.
- **`discovery_gate`** (NEW) — shows queries + top hits, user can drop individual hits or reject the whole sweep. Query-editing UI deferred to a follow-up; today the user rejects + re-plans if the queries are wrong.
- **`papers_gate`** — unchanged in shape; now operates on screener output.

The discovery_gate is **opt-out at the project level**: a power user who
trusts the discoverer can set `Project.skipDiscoveryGate = true` and the
graph routes around it. Same pattern V0.7.1 considered for plan_gate but
didn't ship — v2 is the right time.

---

## 7. Cost-cap implications

The 250k-token default cap (`MAX_TOKENS_PER_RUN`) was sized for V1's
workload. V2 adds:

- Discoverer (1 LLM call, ~2k output tokens for 8 queries).
- Screener (1 LLM call per discovered paper — up to 50).
- Mistral OCR (paid by page, NOT token; accounted at ~50 tokens/page heuristic).

Worst case: 50 papers × (5-page abstract OCR + screener call) ≈ 50 × (250 OCR
+ 1500 LLM in/out) ≈ 87.5k tokens for the discovery/screening phase alone,
on top of V1's ~150k for assessor/drafter/critic/cite_check.

**Default bump**: `MAX_TOKENS_PER_RUN` default goes 250k → 400k. Per-env
override still works. The v2 docs explicitly call out the higher steady-state
cost.

A new `MAX_DISCOVERED_PAPERS_PER_RUN` knob (default 50, hard ceiling 100)
gates the fetcher loop so a runaway query doesn't blow OCR cost. Mirrors
V1's `MAX_TOKENS_PER_RUN` pattern.

---

## 8. UI changes

- **Project creation**: new "Discovery scope" config block — radio
  (uploaded-only / outbound / hybrid), provider checkboxes, year-range, max-hits.
  Existing projects default to `uploaded_only`; the upgrade is opt-in per project.
- **Run page**: new "Discovery" section between Steps and Approval Cards.
  Lists the generated queries + top-N hits live as the discoverer runs.
- **Discovery approval card**: shipped — renders queries as read-only
  rows + hit list with per-row "keep" checkboxes + global "approve N"
  + global "reject all" with reason. Query-editing + regenerate-queries
  are deferred (the spec's original plan); today the path is "reject +
  re-plan" when queries are wrong.
- **Corpus list**: PARSED items from discovery render with a small provider
  badge (`openalex` / `arxiv` / `exa` / `uploaded`) + the original OA URL.

---

## 9. Eval implications

Two new metrics layer onto V1's four:

| Metric | What it measures |
|---|---|
| `discovery_recall` | did the discoverer find the expected papers? (existing `expectedPapers` field; matched by DOI rather than uploaded id) |
| `screening_precision` | of the discoverer's hits, what fraction passed screening AND were expected? |

V1's metrics stay applicable post-screening — `citation_recall` etc. now
measure the assessor → drafter pipeline given a screening output.

The golden YAML schema gains optional `expectedDois: string[]` and
`expectedOaUrl: string[]` so a v2 golden can specify "agent should find
these via search" vs. v1 goldens that specify "agent should include these
from the uploaded corpus."

CI eval workflow: a new `EVAL_MODE=outbound` env path runs v2 goldens;
default stays `uploaded_only` so existing v1 goldens keep working.

---

## 10. Security & privacy

The big new privacy concern: **outbound API calls leak the research question
to third parties** (Exa, OpenAlex, arXiv). V1's tightest selling point —
"your corpus stays on your infra" — needs to be re-stated for v2:

Shipped controls (status of each, as of v2.0):

- Outbound mode is **opt-in per project**, not global default. ✓
- `docs/security-and-privacy.md` §2 lists each provider's
  data-residency: OpenAlex US, arXiv US, Exa US (opt-in only when
  `EXA_API_KEY` is set + the project explicitly selects Exa). ✓
- Discoverer query strings are persisted on the
  `HumanCheckpoint.proposal` JSON of the `APPROVE_DISCOVERY` row, and
  surfaced via the `get_search_queries` MCP tool and the run-detail
  page's Discovery summary panel. A worried researcher can re-derive
  what was sent to whom. (Dedicated `SearchQuery` audit table from
  the original spec was deferred — `HumanCheckpoint.proposal` is the
  on-disk audit today.)
- `SEARCH_DISABLED` env-gated operator kill switch (mirrors
  `DEMO_DISABLED` from v1.0.0). The runs-start route fails fast with
  503 `search_disabled` when set, so outbound runs don't burn
  planner LLM tokens before being told the feature is unavailable. ✓
- SSRF defense in the fetcher (`isSafeExternalUrl`): rejects
  loopback / link-local / RFC 1918 / non-HTTP-S URLs before any
  fetch() call. ✓ (M33)

The self-host story is unchanged: outbound providers still need to be
reachable from the self-host VM, but the search-API keys (Exa) live in
`.env.prod` and never travel to Trigger.dev Cloud (the v1 sync allowlist
in `trigger.config.ts` now lists `EXA_API_KEY` + `SEARCH_DISABLED` +
`MAX_TOKENS_PER_RUN` + `MAX_DISCOVERED_PAPERS_PER_RUN` so an armed deploy
picks them up — see commit `d720fd5`).

---

## 11. MCP surface

V2.0 ships **5 read-only tools** (was 3 in V1). The agent runs
server-side; MCP just exposes results. All tools are tenant-scoped and
audit-logged through the existing `McpCall` table.

V1 carry-over (unchanged):
- `list_reviews`
- `get_review_draft`
- `get_citation_audit`

V2 additions (shipped in M5):
- `list_discovered_papers(reviewId)` — every paper the discoverer
  surfaced from an academic index, with screening verdict + fetch
  status. Empty for uploaded_only runs.
- `get_search_queries(reviewId)` — the LLM-generated queries the
  discoverer ran, the provider set, and per-provider error log.

Full reference: [`docs/mcp/tools.md`](../../mcp/tools.md).

---

## 12. Backward compatibility

Every v1 project keeps working unchanged:

- `searchScope` defaults to `uploaded_only` on existing rows (Prisma
  migration sets the default).
- The graph routes around the new nodes when `searchScope === "uploaded_only"`.
- The HITL gate shape is identical — existing run pages keep rendering.

A user opting into outbound on an existing project:
- Old corpus items stay (kept alongside discovered ones in `hybrid` mode).
- A new Run with `searchScope === "outbound"` ignores uploaded items entirely;
  `hybrid` includes both.

---

## 13. Open questions — resolved

The answers each landed on, with the file the implementation lives in:

1. **Query generation prompt** — shipped as a **universal natural-language
   prompt**. The discoverer's LLM call emits plain English queries that go
   to every provider unchanged; each adapter is responsible for
   translating to its own URL params (OpenAlex `search=`, arXiv
   `search_query=`, Exa `query`). Source: [`lib/prompts/discover-queries.ts`](../../../lib/prompts/discover-queries.ts).
2. **Hit deduplication** — strict externalId dedup with cross-provider DOI
   canonicalisation in the adapter. OpenAlex prefers DOI; arXiv uses
   `arxiv:<id>`. No title-similarity matching shipped (deferred —
   acceptable false-positive rate at observed query shapes). Source:
   [`lib/search/dispatch.ts`](../../../lib/search/dispatch.ts).
3. **Re-screening on a re-run** — re-query every time, no caching. Each
   `Run` has its own `DiscoveredPaper` rows (`@@unique([runId, externalId])`);
   `(projectId, plan-hash)` caching is deferred. The dispatcher's per-
   provider error log is the audit trail.
4. **Free-tier exhaustion handling** — shipped: `dispatchSearch` returns
   `{ hits, errors }` with per-provider entries. Provider failure is
   non-fatal — the discoverer node concatenates errors into
   `RunStep.failureReason` and continues with whatever survived. The
   `SEARCH_DISABLED=1` operator kill switch (M2) is the explicit panic
   button.
5. **PDF acquisition rate** — empirically validated by the live e2e
   suite: ~50% of arXiv hits are openly accessible (every arXiv hit
   technically is). The screener falls back to abstract-only scoring
   when full text isn't available; coverage tested in `tests/lib/agent/nodes/screener.test.ts`.

---

## 14. Milestone breakdown (shipped)

| Milestone | Scope | Status |
|---|---|---|
| **v2-M0** | Schema migration, adapter scaffolding | shipped |
| **v2-M1** | Discoverer + fetcher + screener nodes wired. OpenAlex + arXiv adapters. Discovery HITL gate | shipped |
| **v2-M2** | Exa adapter, project-create UI, `SEARCH_DISABLED` kill switch | shipped |
| **v2-M3** | Eval metrics (`discovery_recall`, `screening_precision`) + `expectedDois` field on the golden schema | shipped |
| **v2-M4** | v2.0.0 release ceremony + docs | shipped |

Plus a long iteration tail (M5–M31) covering: MCP introspection tools,
project-page V2 panel, run-detail discovery summary, cost-cap knobs,
search-tuning UI, eval CLI wiring, the **12 audit/security fixes**
(M11–M19, M22, M33 + trigger.config allowlist — keptExternalIds,
rejection-reason plumbing, hybrid upload-merge,
`skipDiscoveryGate`, `papersApproved.corpusItemIds`, hybrid
cross-source dedup, screener idempotency, CorpusItem per-project
uniqueness, `SEARCH_DISABLED` fail-fast, V2 status enum values,
fetcher SSRF defense, Trigger.dev env-sync allowlist), the
live e2e suite (22 tests: public-surface, MCP transport,
authenticated walkthroughs, full agent-pipeline runs including a
COMPLETED happy-path), the M34 draft-download endpoint, and
Trigger.dev worker redeploys. Full
shipping log in [`docs/superpowers/plans/thoth-v2-roadmap.md`](../plans/thoth-v2-roadmap.md).

---

## 15. Risks / trade-offs

- **The discoverer LLM call is the new fragility surface.** If it generates
  bad queries, the whole run is biased. Eval recall metric is the canary.
- **PDF acquisition is dependent on third-party uptime.** A bad arXiv day
  drops the corpus quality for any biomedical / physics project that day.
  Cron-tracked alerts in v2.1 if needed.
- **Cost-cap defaults need re-calibration.** 400k token default is a guess;
  real-world runs will surface whether it's too tight.
- **GDPR positioning shifts.** "Your corpus stays on your infra" only holds
  in `uploaded_only` mode. The marketing surface needs an honest disclaimer.
- **MCP value-prop shifts.** V1's MCP demo was about *cite_check catching
  fabrications*. V2 enables a richer demo: "ask Claude to discover and
  draft a review on X." But the new demo needs new content.

---

## 16. Cost estimate (free-tier baseline)

A typical v2 run on the default `MAX_DISCOVERED_PAPERS_PER_RUN=50` budget:

| Component | Calls | Cost on Mistral free tier |
|---|---|---|
| Discoverer | 1 | $0 |
| Screener | up to 50 | $0 (~50× 1500 in+out tokens, well under daily quota) |
| Fetcher OCR | up to 50 PDFs × 5 pages avg | $0 on Free Experiment tier (250 page-calls/mo) — TIGHT |
| Assessor | up to 20 (screener-included) | $0 |
| Drafter / critic / cite_check | unchanged from v1 | $0 |
| Outbound search | OpenAlex + arXiv free; Exa ~33 searches/run × 1000/mo cap = 30 runs/mo | $0 |

**The OCR page budget is the binding constraint.** A user running v2 more
than ~5×/month on full 50-paper sets will hit Mistral's free OCR cap. The
docs need to be honest about this — v2 is "$0 for the first few runs, then
pay per page on a tier above Free Experiment ($0.001/page batch)."

---

## 17. Decisions (resolved)

- [x] Milestone breakdown — shipped through M31.
- [x] v2.0 cost-cap default — 400k tokens (vs V1's 250k; per §7).
- [x] Third provider — Exa (semantic search; opt-in via `EXA_API_KEY`).
- [x] `searchScope` default — `uploaded_only` for all existing projects
      (migration default; verified by the V1-path graph test).
- [x] §13 open questions — answered through M11-M19 + M22 audit cycle.

Plan + shipping log: [`docs/superpowers/plans/thoth-v2-roadmap.md`](../plans/thoth-v2-roadmap.md).
