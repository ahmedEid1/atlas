# Thoth, week five: critique, cite-check, and a public scoreboard

*The fifth post in a series documenting an open-source agentic literature-review platform.*

## What I shipped

- A **critic** node between drafter and end-of-graph that scores every draft on a 4-axis rubric (faithfulness, completeness, citation quality, clarity) and conditionally loops back to the drafter once with the critique injected into the prompt (max 2 iterations).
- A **`cite_check`** post-pass that parses every `[paper_id]` reference from the draft and runs one LLM verification call per citation against the cited paper's summary — flagging the unsupported ones before the user sees them.
- A **headless eval harness** that drives the M3+M4 agent in-process with auto-approved HITL gates, scored on 4 metrics (citation recall, citation precision, claim faithfulness, expected-claim coverage) against a versioned golden set.
- A **public `/evals` dashboard** tied to main: every push runs the harness, results land in Postgres, the page renders the latest scores and the trend lines per metric. A regression of more than 10% on any metric fails the CI gate.

Before this milestone, Thoth could draft a review. After this milestone, Thoth can defend the draft to itself, verify its own citations, and tell you — in numbers, on a public URL — how well it does that across a curated set of real SLR questions.

This is the milestone that takes the project from "demo" to "evaluable system."

## Why critique + cite_check are one milestone, not two

A drafter with no critic ships its first attempt. A drafter with a critic ships its second attempt, informed by an explicit rubric. The delta on writing quality is real but bounded — the model is judging itself with the same general capability that wrote the draft.

`cite_check` is different. It's not asking "is this writing good" — it's asking "does the source paper actually support this specific claim." That's a *grounded* question, with a *specific* document to verify against. It catches the failure mode that critic alone cannot: the model writes a fluent, on-topic sentence and cites paper [3], and paper [3] simply doesn't say that thing.

Hallucinated citations are the #1 failure mode of agentic SLR generators in 2026. Shipping the critic without `cite_check` would have been shipping the easier half of the problem and leaving the hard half for "later."

So they ship together. The graph now looks like:

```
... → drafter → critic ─(approve)──→ cite_check → END
                  │
                  └(revise, iters < 2)→ drafter
                  └(revise, iters ≥ 2)→ cite_check  (safety cap)
```

The safety cap matters. Without it, a critic that keeps returning "revise" forever loops the drafter forever, burning tokens and time. Capping at 2 iterations means worst case the drafter runs 3 times total, the critic 3 times, then `cite_check` runs once. Bounded compute, bounded cost.

## The cite_check pass, in detail

`cite_check` runs after the critic is satisfied. The steps:

1. **Parse citations.** `lib/agent/cite-extract.ts` walks the markdown draft and pulls every `[paper_id]` reference with the surrounding claim sentence.
2. **For each citation, call the LLM once.** The prompt is small and grounded: "Here is a claim from a draft review. Here is the cited paper's summary. Does the paper support this exact claim? Return `supported`, `partially_supported`, or `not_supported`, with a one-sentence justification."
3. **Persist a `ClaimCheck` row per citation.** Each row has the run id, the claim text, the cited paper id, the verdict, the justification, and the LLM trace metadata.
4. **Aggregate into a faithfulness score** — the share of citations rated `supported` — and write it to `Run.faithfulnessScore`.

A few engineering choices that came out of the first live runs:

- **Serial, not parallel.** I initially ran the citations in parallel for speed. The Mistral free tier's per-second rate limit started rejecting requests halfway through long drafts; partial completion left the run in an "audit done but not really" state that was hard to reason about. Serial with a small backoff is slower and more correct.
- **Per-citation error tolerant.** A single citation failing (rate limit, timeout, validation error) does not fail the whole pass. The bad citation is marked `error` in its `ClaimCheck` row; the rest of the audit continues. The faithfulness score is computed over successfully-checked citations, with the error count surfaced separately in the UI.
- **The cited paper's summary, not its full text.** The prompt context is the structured `PaperSummary` produced by M2's summariser, not the full Mistral-OCR markdown. This is a tradeoff: the summary is a lossy compression of the paper, so a claim that's true but only visible deep in the methods section can be flagged as not-supported when it shouldn't be. The mitigation is that the summary explicitly captures `keyFindings`, `methodology`, and `limitations` as separate fields — the claim types that matter most for SLR citations. The full-text alternative would multiply token cost per audit by an order of magnitude. For v1, the summary-based audit is good enough; the eval harness will tell me when it isn't.

## The eval harness

A critic and a cite_check pass don't help anyone if nobody can tell whether they actually make the output better. The eval harness is the gate that turns those two new nodes — and every change after them — from "I think this is better" to "the four metrics moved this much, here's the diff."

The setup:

- **A versioned golden set** of SLR questions in `evals/golden/*.yaml`. Each entry has a research question, a small reference corpus (paper PDFs in `evals/golden/corpora/`), the list of expected `[paper_id]` citations, and the list of expected claims the review should make. The schema is enforced by `lib/eval/golden-schema.ts`; a malformed YAML fails the loader, not the metric computation.
- **A headless graph runner** (`lib/eval/headless-runner.ts`) that drives the same LangGraph agent the production app uses, but auto-approves both HITL gates. The agent doesn't know it's being evaluated; the only difference is that the human-in-the-loop is a function returning `{ approved: true }`.
- **Four metrics** (`lib/eval/metrics.ts`):
  - **Citation recall** — share of expected citations that appear in the draft
  - **Citation precision** — share of citations in the draft that were expected
  - **Claim faithfulness** — share of citations rated `supported` by `cite_check` (reuses the production cite_check pass on the eval-run output)
  - **Expected-claim coverage** — share of expected claims that appear in the draft (semantic match, LLM-judged)
- **The CI gate.** `scripts/check-eval-regression.ts` reads the previous `master` run from the `EvalRun` table and compares. A drop of more than 10% on any metric fails the PR. The pre-tag checklist in `RELEASING.md` requires this to be green.
- **The public dashboard.** `app/evals/page.tsx` is a server-rendered Next.js page reading from Neon: the latest scores, the trend lines per metric over the last N runs, the git SHA of each run, the wall-clock time, the LLM provider used. No login. Anyone can see the numbers; an eval regression is a public signal, not a hidden one.

The golden set is currently 10 hand-curated questions. M6 expands it to 30, drawn from real published Kitchenham reviews — the small-set-first approach was a deliberate choice to get the harness shape right before scaling the data. A flawed metric over 30 questions is more expensive to discover than a flawed metric over 10.

## What the harness has already caught

Two real regressions during the M4 → M5 work:

1. **A Mistral OCR migration in v0.5.1 dropped equation rendering for a couple of papers.** The agent's drafted claims about those papers stopped matching the expected claims (because the equation symbols were gone from the parsed markdown). Citation coverage dropped 8% across the affected corpora. The eval run flagged it; I fixed the OCR concatenation to preserve LaTeX delimiters before tagging.
2. **A change to `cite_check` that I'd intended as a refactor accidentally changed the prompt's response format.** The validation pass through Zod started failing for some verdicts, marking them as `error` instead of a real verdict. Faithfulness scores looked higher than they should have (the error verdicts were excluded from the denominator). The harness caught the metric anomaly before the change tagged.

Neither of those would have been visible from spot-checking a couple of draft outputs by hand. That's the value of an eval harness that runs on every push: the regressions you weren't looking for are the ones that catch you.

## Why public, not internal

I could have run the harness in CI and kept the results in a private dashboard. I made the dashboard public for a specific reason.

If someone asks "how good are this agent's outputs?", the honest answer is one of: "I don't know," "I think they're pretty good," or "here are the four numbers, here's the trend line, here's the git SHA of the worst regression and what fixed it." Only the third answer survives scrutiny, and it's the one I wanted Thoth to be able to give.

The public dashboard also forces a discipline I would not have imposed on myself otherwise: a regression is embarrassing if anyone might look at the page, so I don't ship regressions. Evals stop being a private engineering activity and start being a contract with whoever's looking.

## What's next: M5

The agent loop is good, the quality story is measured, the deploy is free. The last piece for v0.7 is the *interface* the rest of the AI ecosystem speaks: the Model Context Protocol. M5 ships an authenticated, registered MCP server at `/api/mcp/mcp` — OAuth 2.1 + PKCE + Dynamic Client Registration via Clerk, three read-only tools scoped to the authenticated user, an audit log of every call, and a listing in the official MCP Registry. Anyone can paste one URL into claude.ai, complete the OAuth flow in their browser, and call `get_citation_audit` on a real Thoth review without a single line of local configuration.

That's also the milestone the project becomes "Thoth" — the ibis brand replaces the Atlas codename.

---

*Spec: [`docs/superpowers/specs/thoth-design.md`](../superpowers/specs/thoth-design.md). Build order: [`docs/superpowers/plans/thoth-roadmap.md`](../superpowers/plans/thoth-roadmap.md). Live dashboard: [thoth-slr.vercel.app/evals](https://thoth-slr.vercel.app/evals).*
