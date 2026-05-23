# Atlas — M4 Critic + Cite-Check + Eval Harness Design Spec

**Status:** Approved for implementation planning (M4a detailed; M4b high-level)
**Date:** 2026-05-23
**Author:** Ahmed Hobeishy (with Claude)
**Supersedes:** §3 M4 row of `2026-05-22-atlas-design.md` (which only listed it as "critic + cite_check + evals v1")
**Builds on:** `v0.3.6-m3.5b` (live cloud deploy, $0/month stack)

---

## 1. Purpose

M4 is the **quality + measurement** milestone. Atlas v0.3.6 produces reviews end-to-end but has no quality gate beyond the drafter and no objective measure of how good the outputs are. M4 fixes both:

- **Critic** — LLM-as-judge that scores the draft against a rubric (faithfulness, completeness, citation quality, clarity) and can loop the drafter once if quality is low.
- **cite_check** — post-pass that verifies every `[paper_id]` citation in the draft is actually supported by the cited paper. Catches hallucinated citations — the #1 failure mode of agentic SLR generators.
- **Eval harness v1** — a curated set of golden SLR questions with known-good answers, run on every commit and nightly, published to a public `/evals` dashboard. **This is the #1 hiring differentiator** for Agentic SWE / Applied AI roles in 2026.

Constraints inherited from prior milestones:
- $0/month total cost (Gemini free tier covers all eval runs at our scale)
- Provider-neutral via Vercel AI SDK (eval harness works against any provider)
- Mock paid LLM calls in tests

---

## 2. Why this milestone now

- Atlas demoes well as a one-off; without evals it's hard to defend against "is this actually good or just a flashy demo?" — the question every interviewer asks
- The Aleph Alpha "AI Software Engineer — Model Evaluation" requisition + every other 2026 Agentic SWE JD names evals as a top requirement
- Critic + cite_check are themselves measurable improvements that the eval harness will quantify — perfect dogfooding story
- 12 days ahead of the original spec timeline; we have runway to do this properly

---

## 3. Scope

### In scope (M4 — two sub-milestones)

**M4a — Critic + cite_check**
- LangGraph critic node between drafter and cite_check, with conditional loop edge back to drafter (max 2 iterations)
- Rubric-based scoring (4 dimensions, 1–5 each)
- Actionable feedback injected into drafter prompt on revise
- cite_check post-pass (LLM-only verification of every citation)
- Schema: `ClaimCheck` table; `Run.faithfulnessScore` aggregate
- UI: critique panel + citation faithfulness widget in run workspace
- Ship as `v0.4.0-m4a`

**M4b — Eval harness + public `/evals` dashboard**
- 10 golden SLR questions (curated by hand from published Kitchenham reviews) — start small for quality, scale to 30 over time
- Per-question scoring: citation recall, citation precision, claim faithfulness, factual accuracy
- Eval framework: **Promptfoo** (OSS, runs locally + in CI, no cloud signup) — see §11 alternatives
- GitHub Actions workflow: runs eval suite on every push to master + nightly cron at 03:00 UTC
- Public `/evals` dashboard: server-rendered Next.js page reading eval history from Neon, showing per-question scores + trend lines per metric
- Ship as `v0.4.1-m4b`

### Explicitly out of scope for M4
- 30 golden questions (start with 10; M5+ expands)
- Multi-LLM-provider eval comparisons (`LLM_PROVIDER=anthropic` vs `=gemini` benchmarks) — single-provider baseline first
- Red-team adversarial evals (was 10 in original spec, deferred to M5)
- Auto-fix loop (where critic feedback triggers automatic re-retrieval, not just re-draft)
- Token-level cost optimization
- Production webhooks alerting on eval regressions

### Deferred to M4.5
- Hybrid cite_check (embedding short-list + LLM verify) — only if Gemini quota becomes a problem
- Critic auto-tuning (learning thresholds from human approvals over time)

---

## 4. M4a Architecture

### 4.1 Updated graph topology

```
START → planner → plan_gate (HITL) → retriever → papers_gate (HITL) → assessor
                                                                           │
                                                                           ▼
                                                                       drafter ─┐
                                                                           │    │
                                                                           ▼    │
                                                                        critic ─┤
                                                                        ┌──────┘
                                                                        │ approve OR iters >= 2
                                                                        ▼
                                                                    cite_check
                                                                        │
                                                                        ▼
                                                                       END
```

The critic loop is a **conditional edge** from `critic` back to `drafter` when `decision === "revise" && iterations < 2`.

### 4.2 Critic node contract

```ts
// lib/prompts/critic.ts
export const CritiqueSchema = z.object({
  rubric: z.object({
    faithfulness: z.number().int().min(1).max(5).describe("Are claims in the draft supported by cited papers?"),
    completeness: z.number().int().min(1).max(5).describe("Does the draft address all sub-questions from the plan?"),
    citationQuality: z.number().int().min(1).max(5).describe("Are citations specific and well-placed?"),
    clarity: z.number().int().min(1).max(5).describe("Is the draft readable and well-structured?"),
  }),
  overallScore: z.number().min(1).max(5).describe("Weighted average; faithfulness counts double"),
  actionableFeedback: z.string().min(20).max(2000).describe("2-5 specific changes the drafter should make. Empty if approve."),
  decision: z.enum(["approve", "revise"]),
});
```

**Threshold:** the critic itself sets `decision` based on its own rubric — we don't post-process. Heuristic baked into the prompt: "Set `decision: 'revise'` only when `overallScore < 4.0` AND `actionableFeedback` would meaningfully improve the draft."

**State additions (`lib/agent/state.ts`):**
- `critique: Critique | null` (latest critique)
- `critiqueIterations: number` (starts at 0)

**Node logic (`lib/agent/nodes/critic.ts`):**
1. Read `state.draft`, `state.plan`, `state.includedPapers`, `state.question`
2. Call `runLLM({ name: "critic", tier: "smart", schema: CritiqueSchema, ... })`
3. Update `state.critique = output; state.critiqueIterations = prev + 1`
4. Return state update

**Conditional edge (`lib/agent/graph.ts`):**
```ts
.addConditionalEdges("critic", (state) => {
  if (state.critique?.decision === "approve") return "cite_check";
  if (state.critiqueIterations >= 2) return "cite_check"; // max iterations
  return "drafter";
}, { drafter: "drafter", cite_check: "cite_check" })
```

**Drafter prompt change:** when `state.critique?.decision === "revise"`, inject `state.critique.actionableFeedback` into the drafter's prompt as additional context. Otherwise, drafter runs as before.

### 4.3 cite_check node contract

```ts
// lib/prompts/cite-check.ts
export const CiteCheckPerCitationSchema = z.object({
  verdict: z.enum(["supported", "unsupported", "unclear"]),
  reason: z.string().min(10).max(500).describe("Specific evidence from the paper or specific gap"),
  paperExcerpt: z.string().max(300).optional().describe("Short quote from the paper supporting/contradicting the claim"),
});
```

**Node logic (`lib/agent/nodes/cite-check.ts`):**
1. Parse `state.draft` for all `[paper_id]` mentions (regex `\[(\w+)\]`)
2. For each mention, extract the surrounding claim (sentence containing the citation)
3. For each (claim, paper) pair, call `runLLM({ name: "cite-check", tier: "smart", schema: CiteCheckPerCitationSchema, ... })` with the paper's summary + the claim
4. Aggregate: `{ totalCitations, supported, unsupported, unclear, faithfulnessScore = supported / total }`
5. Persist via `recordCiteCheck({ runId, perCitation, aggregate })` — see §4.4

**Parallelism:** cite_check is per-citation independent. Run with `Promise.all` over `Math.min(citations.length, 5)` at a time to avoid Gemini rate limits.

### 4.4 Schema additions

```prisma
// prisma/schema.prisma

model ClaimCheck {
  id          String   @id @default(cuid())
  runId       String
  paperId     String   // the [paper_id] referenced in the draft
  claim       String   @db.Text
  verdict     ClaimCheckVerdict
  reason      String   @db.Text
  paperExcerpt String? @db.Text
  createdAt   DateTime @default(now())
  run         Run      @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@index([runId])
}

enum ClaimCheckVerdict {
  SUPPORTED
  UNSUPPORTED
  UNCLEAR
}

// Add to Run model:
model Run {
  // ... existing fields ...
  faithfulnessScore Float?       // 0.0-1.0 = supported / total citations
  critiqueScore     Float?       // 1.0-5.0 weighted rubric average from final critique
  claimChecks       ClaimCheck[]
}
```

### 4.5 UI additions

In `app/projects/[id]/runs/[runId]/page.tsx` (or its components):
- **Critique panel** — collapsible, shows rubric scores + actionableFeedback, with a "Reviewed N times" badge
- **Citation faithfulness widget** — a number + color (green ≥80%, yellow 50-80%, red <50%) and a "View details" button that opens a modal with per-citation verdict + reason + paperExcerpt

---

## 5. M4b Architecture (high-level — detailed plan written after M4a ships)

### 5.1 Golden question format

```yaml
# evals/golden/000-question-id.yaml
question: "What are the most effective interventions for chronic back pain in adults?"
picoc:
  population: "Adults with chronic back pain (>12 weeks)"
  intervention: "Any non-surgical intervention"
  comparison: "Placebo or other intervention"
  outcome: "Pain reduction at 12+ weeks"
  context: "Clinical trials, 2015-2024"
# Each expected paper is a PDF that we pre-upload to the eval Atlas project's corpus.
# The `filename` matches a file under evals/corpus/<question-id>/. Atlas assigns its
# own CorpusItem IDs at upload; the eval harness matches by filename → CorpusItem.id.
expectedPapers:
  - filename: "wang-2019-cbt-back-pain.pdf"
  - filename: "smith-2021-spinal-manipulation.pdf"
  # ... ~5-15 expected papers
expectedClaims:                # claims that MUST appear in the draft
  - "Cognitive behavioral therapy outperforms standard care at 6 months"
  - "Spinal manipulation shows mixed evidence; effect size <0.3"
metadata:
  source: "Cochrane Review CD009790"
  difficulty: "medium"
```

Note: Atlas's M3 retriever scores papers from the project's own uploaded corpus (not OpenAlex/Exa — that's M5+). Eval golden questions provide their own PDF set per question, uploaded to a dedicated `evals-runner` Atlas project at CI time.

### 5.2 Eval framework choice: Promptfoo

- **OSS, runs locally + in CI** (no signup required, $0)
- Custom assertions for citation recall/precision/faithfulness in JS
- Built-in HTML + JSON output → consumed by our `/evals` dashboard
- Per-run timing + cost capture
- Alternative considered: **Braintrust** (cloud, free tier, nicer UI but requires signup; revisit if Promptfoo limitations surface)

### 5.3 Metrics

| Metric | Formula | Target |
|---|---|---|
| Citation recall | (Atlas's papers ∩ expected) / expected | ≥ 0.6 |
| Citation precision | (Atlas's papers ∩ expected) / Atlas's papers | ≥ 0.5 |
| Claim faithfulness | (supported claims in draft) / (total claims) | ≥ 0.85 |
| Expected-claim coverage | (expected claims found in draft) / (expected claims) | ≥ 0.5 |

### 5.4 CI integration

`.github/workflows/evals.yml`:
- Trigger: `push` to `master`, `pull_request`, `schedule` (cron `0 3 * * *`)
- Runs Promptfoo with the 10 golden questions
- Each question runs against the **live Vercel deploy** (preview URL on PR, production URL on master/cron) — avoids the complexity of spawning Atlas + Neon + R2 in CI runners, costs $0 because Gemini handles the load
- Results uploaded to Neon's `EvalRun` table via a small `scripts/upload-eval-results.ts` (reads Promptfoo's JSON output, calls `prisma.evalRun.createMany`) — DATABASE_URL provided as GitHub Actions secret
- CI fails if any metric drops > 10% vs the previous main-branch run (regression gate); the comparison is computed in `scripts/check-eval-regression.ts`

### 5.5 Public `/evals` dashboard

`app/evals/page.tsx` — server-rendered, reads from Neon:
- Per-question table: question + latest score per metric
- Trend lines: per-metric average over last 30 days
- Latest run timestamp + commit SHA + Vercel deploy URL
- "Run history" expandable per question showing past runs

### 5.6 Schema additions (M4b)

```prisma
model EvalRun {
  id        String   @id @default(cuid())
  goldenId  String   // e.g., "000-question-id"
  metric    String   // "citation_recall" | "claim_faithfulness" | ...
  score     Float
  runId     String?  // links to the underlying Atlas Run if reproducible
  commitSha String
  createdAt DateTime @default(now())
  @@index([goldenId, createdAt])
}
```

---

## 6. Test strategy

**M4a tests:**
- `tests/lib/prompts/critic.test.ts` — schema validation, prompt builder
- `tests/lib/prompts/cite-check.test.ts` — schema validation, prompt builder
- `tests/lib/agent/nodes/critic.test.ts` — calls runLLM, updates state, returns critique
- `tests/lib/agent/nodes/cite-check.test.ts` — parses citations, calls runLLM per citation, aggregates
- `tests/lib/agent/graph.test.ts` — extend to verify critic loop edge fires correctly (mocks runLLM to return revise then approve)
- All LLM calls mocked (same `vi.hoisted()` pattern from M3.5a)
- Smoke: one end-to-end review on the live Vercel deploy after M4a ships

**M4b tests:**
- Golden-question schema validation
- Promptfoo config parses correctly
- `EvalRun` model CRUD
- `/evals` page renders with mock data
- The actual eval runs are the "tests" — they exercise the full system

---

## 7. Migration plan

**M4a (no breaking changes to existing runs):**
- Existing `Run` rows: `faithfulnessScore` and `critiqueScore` default to `null`
- The graph rewires to insert critic + cite_check between drafter and END; old runs that ended at drafter remain valid (their state has no `critique` field, which is OK)
- LangGraph checkpointer (`@langchain/langgraph-checkpoint-postgres`) handles the new state channels automatically

**M4b:**
- New `EvalRun` table — additive
- `.github/workflows/evals.yml` is new

---

## 8. What's needed from Ahmed

**For M4a:**
- Nothing during implementation (all mocked tests)
- After ship: a real PDF + research question to trigger a live end-to-end smoke against the new critic + cite_check

**For M4b:**
- 10 published Kitchenham/Cochrane systematic reviews to crib golden questions from
  - Options: (a) Ahmed picks 10 from a domain he knows; (b) I propose 10 from open SE/ML reviews; (c) mix
- GitHub Actions runner enabled on `ahmedEid1/atlas` (free for public repos — should already be on)

---

## 9. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Critic loops forever despite cap | Low | Hard `iterations >= 2` check in conditional edge, plus a unit test |
| Critic too strict, never approves | Medium | Start with `overallScore < 4.0` threshold; tune after first 5 real runs |
| cite_check parses `[paper_id]` wrong (e.g., misses URL fragments) | Medium | Anchored regex `\[([a-z0-9_]+)\]`; test against varied draft formats |
| Gemini rate limit hit by ~30 cite_check calls per review | Low (15 RPM, 1500/day) | Promise.all over 5 at a time; if hit, fallback to sequential |
| Promptfoo + Vercel-hosted Atlas creates a chicken-and-egg in CI (need live URL but tests run before deploy) | Medium | First version runs evals against staged Vercel preview deployments only (auto-created on PRs); cron runs against production |
| Golden questions are biased / not representative | Medium | Document selection criteria in `evals/README.md`; expand to 30 over time |
| Critic + cite_check turn out to disagree (critic approves, cite_check flags issues) | Low | They measure different things (rubric vs per-citation); both signals shown in UI; eval harness measures both |

---

## 10. Acceptance criteria

**M4a complete when:**
- [ ] Critic node loops drafter once if score < 4.0, capped at 2 iterations total
- [ ] cite_check verdict for every `[paper_id]` mention in the final draft, persisted in `ClaimCheck`
- [ ] `Run.faithfulnessScore` and `Run.critiqueScore` populated on finished runs
- [ ] UI shows critique panel + faithfulness widget in run workspace
- [ ] All 95+ tests pass (88 baseline + 7 new), tsc + lint clean
- [ ] One live end-to-end smoke on Vercel deploy: review completes, critic fires, cite_check produces verdicts
- [ ] Tagged `v0.4.0-m4a` on GitHub
- [ ] Memory updated

**M4b complete when:**
- [ ] 10 golden questions in `evals/golden/*.yaml`
- [ ] `pnpm eval` runs Promptfoo against the 10 questions; outputs JSON results to Neon
- [ ] `.github/workflows/evals.yml` runs on push + nightly cron
- [ ] CI fails on >10% metric regression
- [ ] `/evals` page renders with per-question + trend data
- [ ] First nightly run completes successfully and is visible at `https://atlas-sooty-delta.vercel.app/evals`
- [ ] Tagged `v0.4.1-m4b` on GitHub
- [ ] Memory updated

---

## 11. Open questions (resolved)

- **Eval framework: Promptfoo vs Braintrust?** → Promptfoo. OSS, runs anywhere, $0, no cloud signup. Braintrust if Promptfoo limitations surface in M4b implementation.
- **cite_check approach: LLM vs embedding vs hybrid?** → LLM only. Free on Gemini. Upgrade to hybrid in M4.5 if quota becomes a problem.
- **Critic threshold?** → `overallScore < 4.0` for revise. Tune after first 5 runs.
- **Where do golden questions come from?** → 10 hand-curated by Ahmed (or Claude proposes; Ahmed approves), from published Kitchenham/Cochrane reviews. Decision made in M4b kickoff.

---

## 12. References

- LangGraph conditional edges + cycles: https://langchain-ai.github.io/langgraph/concepts/low_level/#edges
- Promptfoo docs: https://promptfoo.dev
- Eval-driven LLM dev (Hamel Husain): https://hamel.dev/blog/posts/evals/
- Original spec: `docs/superpowers/specs/2026-05-22-atlas-design.md` §3, §15
- M3.5 spec: `docs/superpowers/specs/2026-05-23-m3.5-free-tier-pivot-design.md`
