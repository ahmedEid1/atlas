# Atlas — Design Spec

**Status:** Approved for implementation planning
**Date:** 2026-05-22
**Author:** Ahmed Hobeishy (with Claude)
**Target ship:** v1.0 by 2026-07-10 (~7 weeks of evenings/weekends)

---

## 1. Purpose

Atlas is a GDPR-safe, open-source, agentic research workspace. Researchers create a project with a research question and a corpus (PDFs, URLs, notes). Atlas's agent loop plans the review, retrieves relevant sources, extracts and verifies claims, and produces an evidence-grounded **systematic literature review** with inline citations and a PRISMA-style flow diagram.

This project exists to serve two outcomes simultaneously:
1. **Useful artifact** — a tool real researchers can self-host and run, GDPR-clean for EU labs.
2. **Portfolio artifact** — a single deeply-engineered project that demonstrates the production agentic skills hiring teams ask for in 2026 (LangGraph, evals, observability, MCP, HITL, cost discipline). It is being designed and built to land an Agentic SWE / Applied AI Developer role.

The two outcomes are aligned: the same engineering rigor that makes Atlas a defensible CV piece also makes it actually useful.

---

## 2. Why this niche, why now

**Systematic Literature Reviews (Kitchenham & Charters style)** is the v1 niche, chosen because:
- Narrow enough to build a real golden eval set (citation recall, faithfulness, hallucination rate are all measurable).
- Author already has working knowledge of the methodology (kitchenham-slr, paper-audit, slr-editorial-pipeline skills loaded).
- Nobody has shipped a production-grade agent for this — Elicit/Undermind/Perplexity address adjacent but different jobs.
- Outputs are evaluable against published reviews — a natural ground truth.

Market signals validating timing (from May 2026 research):
- Agentic AI job postings +280% YoY into 2026.
- Eval & observability ownership is the single strongest hiring differentiator (Aleph Alpha has a dedicated "AI Software Engineer — Model Evaluation" req).
- MCP registry: 1,200 → 9,400+ servers in a year; **8,000+ ship with no auth** — a secure, authenticated MCP server is an open niche.
- Langfuse (self-hosted) is the "I know production AI in EU" signal because of GDPR/sovereignty.
- LangGraph is the framework named most often in Agentic SWE postings.

---

## 3. Scope

### In scope for v1.0
- Project workspace: research question + corpus (PDF, URL, manual note)
- Planner agent: research question → PICOC, sub-questions, search strings, inclusion/exclusion criteria
- Retriever agent: web (Exa) + OpenAlex + local corpus (pgvector hybrid search)
- Assessor agent: claim extraction + Kitchenham quality scoring
- Drafter agent: review sections with inline `[paper_id]` citations
- Critic agent: LLM-as-judge against rubric, can loop back to drafter (max 2 iterations)
- `cite_check` post-pass: verifies every cited claim is actually supported by the paper
- Human-in-the-loop checkpoints: approve plan, approve included papers, approve draft sections
- Authenticated MCP server (OAuth 2.1, stdio + SSE) — published to MCP registry
- Eval harness:
  - Per-tool unit evals (CI gate via Braintrust)
  - 30 end-to-end golden SLR questions (nightly, public dashboard)
  - 10 adversarial red-team questions
- Self-hosted Langfuse observability with public cost dashboard
- Live demo at an `.eu` domain, Hetzner-hosted
- Six-post blog series documenting each milestone

### Explicitly out of scope for v1.0
- General "ask the web" chat (we do not compete with Perplexity)
- Real-time multi-user collaboration (Liveblocks deferred — focus elsewhere)
- Fine-tuned models
- Quantitative meta-analysis (defer to v2 — existing Kitchenham skill covers this)
- Non-English documents
- Mobile app
- Pricing / SaaS billing

### Deferred to v1.1
- Reciprocal/refutational qualitative synthesis (Noblit & Hare)
- Multi-tenant org workspaces
- LaTeX/Word export beyond Markdown

---

## 4. Architecture

### 4.1 Component map

```
┌─────────────────────────────────────────────────────────────────┐
│                         Atlas Web UI                            │
│   Next.js 16 / shadcn / Tailwind v4 · Clerk auth                │
│  ┌────────────┐  ┌─────────────┐  ┌──────────────────────────┐ │
│  │ Workspace  │  │ Live agent  │  │  Eval dashboard (public) │ │
│  │ (corpus +  │  │ narration   │  │  recall · faithfulness · │ │
│  │  artifact) │  │ + HITL gates│  │  cost · latency          │ │
│  └────────────┘  └─────────────┘  └──────────────────────────┘ │
└────────────────────────┬────────────────────────────────────────┘
                         │ Server actions / streaming SSE
┌────────────────────────▼────────────────────────────────────────┐
│                    Atlas API + Agent Runtime                    │
│  LangGraph state machine (TS): plan → retrieve → assess →       │
│       draft → critic, with HITL edges back to user              │
│  Durable execution: Trigger.dev v4                              │
│  LLM: Claude Opus 4.7 / Sonnet 4.6 / Haiku 4.5 (+ caching)      │
│  Embeddings: Voyage-3                                           │
└────────────────────────┬────────────────────────────────────────┘
                         │
┌────────────┬───────────┴──────────┬──────────────┬──────────────┐
▼            ▼                      ▼              ▼              ▼
Postgres   pgvector             Object store    Langfuse      Tools layer
+ Prisma   (corpus              (PDFs, run     (self-hosted   web · openalex
schema     embeddings,          artifacts)     OTel ingest)   unstructured
runs,      citations)                                         corpus_search
claims,                                                       cite_check
checks)                                                       summarize_paper

         ┌──────────────────────────────────────────────────┐
         │   Atlas MCP server (authenticated, OAuth 2.1)    │
         │   stdio + SSE transports                         │
         │   tools: search_corpus, summarize_paper,         │
         │          draft_section, find_supporting_citations│
         └──────────────────────────────────────────────────┘
```

### 4.2 Stack

| Layer | Choice | Reason |
|---|---|---|
| App framework | Next.js 16 + TypeScript (strict) | Author already ships in this |
| UI | Tailwind v4 + shadcn/ui + Lucide | Reuse ghost.ai design-system patterns |
| Auth | Clerk | Author already knows it |
| DB | Postgres + pgvector | Vector + relational in one store |
| ORM | Prisma v7 | Author already knows it |
| Agent framework | **LangGraph (TS — `@langchain/langgraph`)** | #1 framework named in 2026 Agentic SWE postings |
| Durable jobs | **Trigger.dev v4** | Author already knows it; carry-over from ghost.ai |
| LLM provider | Anthropic Claude via AI SDK + Anthropic SDK directly | Familiarity + prompt caching support |
| Models | Opus 4.7 (planner, drafter), Sonnet 4.6 (assessor, critic), Haiku 4.5 (retriever scoring) | Cost-routed by node |
| Embeddings | Voyage-3 (fallback bge-m3) | Best-in-class English research embedding |
| External tools | Exa (web), OpenAlex (citation graph), unstructured.io or marker-pdf (PDF parse) | Best academic coverage; OpenAlex is free + GDPR-clean |
| Observability | **Langfuse (self-hosted, docker-compose)** | GDPR/sovereignty narrative for EU employers |
| Eval CI gate | **Braintrust** (free tier) | Standard regression-gate pattern |
| MCP SDK | `@modelcontextprotocol/sdk` (TypeScript) | Official |
| Deployment | Docker Compose on a Hetzner CX22 in Falkenstein, DE | Cheap, GDPR-clean, demonstrable infra ownership |
| CI | GitHub Actions | Standard |

### 4.3 Architecture invariants
1. **No long-running LLM work in a Next.js request handler** — every agent run goes through Trigger.dev.
2. **All LLM output that mutates persistent state is Zod-validated** before write.
3. **Every LLM/tool call produces a Langfuse span** with cost + latency + prompt version.
4. **Every cited claim must be `cite_check`'d before the user sees the draft.** Unverified citations are flagged in the UI.
5. **Every MCP call is audit-logged** with user_id, tool, input hash, latency, cost.
6. **HITL gates are blocking** — runs persist (Trigger.dev wait tokens) until the user approves or rejects.
7. **Memory is project-scoped.** No cross-project knowledge leakage. GDPR-essential.
8. **The `/evals` dashboard is public and tied to main branch.** A regression isn't a private failure — it's visible.

---

## 5. Agent loop

LangGraph state machine. Five nodes + a critic loop edge.

| Node | Model | Inputs | Outputs | Human-in-the-loop? |
|---|---|---|---|---|
| `planner` | Opus 4.7 | research question, corpus summary | PICOC, sub-questions, search strings, inclusion/exclusion criteria | ✅ approve plan |
| `retriever` | Haiku 4.5 (scoring), tools | search strings, criteria | candidate-paper list with relevance + criteria checks | ✅ approve included set |
| `assessor` | Sonnet 4.6 | included papers | extracted claims + quality scores (Kitchenham Table 5/6) | — |
| `drafter` | Opus 4.7 | claims, structure | review sections with inline `[paper_id]` citations | ✅ approve sections |
| `critic` | Sonnet 4.6 | draft, claims, original question | rubric scores + revision request | conditional loop to drafter, max 2 iterations |

A single `runLLM(...)` wrapper handles: prompt caching, Langfuse span, cost capture, retry-with-backoff, Zod-validated structured output, UI phase-event emission.

A separate `cite_check` post-pass runs after drafter and after critic — it is not an LLM node in the graph but a tool-call sequence over each `(claim, paper)` pair.

---

## 6. Tools

Each tool has: Zod input schema, JSON output schema, idempotency key, Langfuse span, README entry, **and a unit eval set** in CI.

| Tool | Source | Side effect |
|---|---|---|
| `web_search` | Exa neural search | read-only, external-network, $$ |
| `openalex_lookup` | OpenAlex REST API | read-only, external-network, free |
| `pdf_extract` | unstructured.io or marker-pdf | read-only, writes-to-blob |
| `corpus_search` | pgvector + BM25 hybrid | read-only |
| `summarize_paper` | Claude w/ paper as cached prompt | read-only, $$$ |
| `cite_check` | OpenAlex + local + Claude | read-only, $$ |

**`cite_check` is the trust differentiator.** After the drafter writes "Smith (2024) showed X," `cite_check` reads Smith 2024 and judges whether the claim is supported. Unsupported citations are flagged in the UI before the user reads the draft. This is the single feature that builds user trust faster than anything else.

---

## 7. MCP server

A separate package (`@atlas/mcp-server`), published to npm and registered at `registry.modelcontextprotocol.io`.

- **Transports**: stdio (Claude Desktop) and HTTP+SSE (remote agents)
- **Auth**: OAuth 2.1 with PKCE
- **Tools exposed**: `search_corpus`, `summarize_paper`, `draft_section`, `find_supporting_citations`, `list_projects`, `get_project_artifact`
- **Side-effects manifest** in README: every tool annotated `read-only | writes | external-network | costs-money`
- **Rate limiting + audit log** per user_id per tool
- **One-command install snippet** for Claude Desktop

The differentiator is the auth + audit story. Research showed 8,000+ MCP servers ship with no auth — Atlas's authenticated, audited MCP server is a quotable CV bullet on its own.

---

## 8. Eval harness

Three layers.

### 8.1 Unit evals per tool (Braintrust, CI gate)
- `corpus_search`: 20 (question, expected_top_k_doc_ids) pairs → recall@5, recall@10
- `cite_check`: 30 (claim, paper, expected_verdict) → precision + recall on hallucination detection
- `summarize_paper`: 15 papers with human-written summaries → ROUGE + LLM-judge

### 8.2 End-to-end agent evals (nightly on Trigger.dev)
- 30 curated SLR research questions across CS, medicine, software engineering with hand-built golden citation sets
- Metrics: citation recall, citation precision, hallucination rate (1 − cite_check pass %), rubric score (LLM-as-judge against Kitchenham criteria), cost per review (EUR), wall-clock latency
- Results posted to `/evals` page on the live site, full history retained
- Regression gate: PR cannot merge if citation recall drops more than 3 points or cost rises more than 20%

### 8.3 Red-team set (visible scoreboard)
- 10 adversarial questions designed to elicit hallucinated citations or contradictory claims

The headline CV-bullet number set will be drawn from §8.2: *"On a 30-question SLR benchmark, Atlas achieved {recall} citation recall and {hallucination_rate} hallucination rate at €{cost_per_run}/run."* Numbers are unknown today; they get filled in at M6.

---

## 9. Observability

Self-hosted Langfuse (Postgres + ClickHouse via docker-compose, deployed alongside the app on the Hetzner box).

- Every LLM call, tool call, retrieval is a Langfuse span
- Prompt versions tracked; drafter prompts are A/B-able
- Public `/observability` page on the live demo — sanitized cost/latency dashboard
- Why self-hosted (not Langfuse Cloud or LangSmith): GDPR/data sovereignty narrative for EU employers. Research confirmed this is the #1 EU-market differentiator.

---

## 10. Memory model

| Layer | Stored | Backing |
|---|---|---|
| Conversation / per-run | LangGraph state at each step | LangGraph Postgres checkpointer |
| Project knowledge | included papers, extracted claims, reviewer notes | Postgres + pgvector |
| Long-term per-user | preferred journals, blocklists, prior reviews | Postgres |
| Episodic | summarised past runs surfaced to planner | Postgres + Claude-generated summary |

Each layer has explicit read/write boundaries. All layers are project-scoped. No cross-user or cross-project leakage.

---

## 11. Data model (Prisma sketch — illustrative, not authoritative)

```
User ──< Project ──< CorpusItem (pdf | url | note)
                ├──< Run ──< RunStep (planner | retriever | assessor | drafter | critic)
                │       └──< HumanCheckpoint
                ├──< IncludedPaper ──< ExtractedClaim ──< CiteCheck
                └──< Artifact (review.md | prisma.svg | bibliography.bib)

MCPSession ──< MCPCall (auditable: user_id, tool, input_hash, latency, cost)
```

---

## 12. Milestones

Each milestone = a tagged release on GitHub + a blog post + an updated `/evals` dashboard if applicable.

| # | Milestone | Definition of done | Target wk |
|---|---|---|---|
| **M1** | Workspace foundation | Clerk auth, Postgres + Prisma schema, can upload PDF and see it parsed; one Trigger.dev hello-world task | Wk 1 |
| **M2** | Single-node summarisation | `summarize_paper` tool with Langfuse trace per call; UI shows summary + trace link | Wk 2 |
| **M3** | Full agent loop | LangGraph planner → retriever → assessor → drafter (no critic yet); HITL approve-plan and approve-sources gates; one full review run on a real question, end-to-end | Wk 4 |
| **M4** | Critic, cite_check, evals v1 | Critic node with loop edge; `cite_check` post-pass; 10-question golden set; `/evals` page live with first numbers | Wk 5 |
| **M5** | Authenticated MCP server | `@atlas/mcp-server` with OAuth 2.1, audit log, published to npm + MCP registry; Claude Desktop install snippet in README | Wk 6 |
| **M6** | Public launch | 30-question golden set complete; HN/Twitter/LinkedIn launch; recruiter 1-pager; six-post blog series complete | Wk 7 |

---

## 13. Distribution & portfolio surfaces

| Surface | Artifact | Milestone |
|---|---|---|
| GitHub repo | README with live demo, eval numbers, architecture diagram, "Why" section, contribution guide | Continuous |
| MCP registry | `atlas-research` server entry with side-effect manifest | M5 |
| Blog series (own domain or dev.to) | 1. Why LangGraph 2. Designing safe tools 3. Cite-check the unsung hero 4. Self-hosted Langfuse in production 5. Authenticated MCP — what nobody talks about 6. What 30 golden questions taught me | One per milestone |
| Live demo | `atlas.eu` or `atlasresearch.app`, Hetzner-hosted, GDPR-clean | M3 onward |
| Public eval dashboard | `/evals` on demo | M4 onward |
| HN launch | "Show HN: Atlas — open-source agentic literature review with authenticated MCP server" | M6 |
| LinkedIn case study | One slide per technical decision, link to repo | M6 |
| CV bullets | Three pre-written variants (Engineering / Applied AI / MCP focus) | M6 |
| Recruiter 1-pager PDF | What it is, numbers, stack, links | M6 |
| Conference talk pitch | EuroPython or PyData Berlin | After M6 |

---

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Scope creep around UI polish | Reuse ghost.ai design system; freeze design by M3; no new components after M4 |
| LangGraph TS maturity unknown to author | M2 milestone exists precisely to de-risk this with a single-node graph before M3 |
| Eval golden-set construction is the bottleneck | Build incrementally: 10 questions by M4, +10 by M5, +10 by M6 |
| Cost of nightly e2e evals could surprise | Cost-cap per run enforced in `runLLM` wrapper; nightly job has hard budget; Haiku for retrieval scoring |
| `cite_check` false-positives confuse users | Show the supporting span next to the claim; let user override |
| MCP OAuth complexity slips M5 | Fallback: ship MCP with bearer-token auth, defer OAuth to v1.1; still distinct from no-auth |
| Hallucination rate in evals embarrasses launch | Ship anyway — visibility is the point; an honest number beats a hidden one |
| Recruiter doesn't read the README | The recruiter 1-pager PDF is the load-bearing artifact, not the README |

---

## 15. Resolved decisions (formerly open questions)

1. **Deployment**: Hetzner CX22 in Falkenstein DE with plain docker-compose. Coolify deferred — extra moving part for no v1 benefit. (Decision 2026-05-22.)
2. **PDF parsing**: marker-pdf as primary (better academic-paper layout, OSS), unstructured.io as fallback for edge cases. Benchmark in M1; switch if marker fails on >20% of golden papers. (Decision 2026-05-22.)
3. **Search stack**: Exa (neural web search) + OpenAlex (citation graph, always-on, free, GDPR-clean). Tavily not used — Exa has materially better academic coverage per their 2025 benchmarks. (Decision 2026-05-22.)
4. **Embeddings**: Voyage-3 primary, bge-m3 self-hosted fallback (also useful for the "fully self-hosted" demo path). Cohere v3 dropped — no EU data-residency story. (Decision 2026-05-22.)
5. **Blog hosting**: Custom domain. Personal-brand compounding matters; dev.to is a write-only graveyard for SEO. Use Astro static site, hosted on the same Hetzner box. (Decision 2026-05-22.)
6. **Domain name**: provisional `atlas.review` (`.review` is a real TLD, semantically perfect, likely available). **Requires Ahmed to register** — flagged as the one v1 action only he can take. Fallback: `atlasreview.io`.

**Action required from Ahmed (the only thing blocking ship-ready hosting):**
- [ ] Register `atlas.review` (or chosen fallback) — €20–30/yr, can wait until M3.
- [ ] Spin up a Hetzner CX22 in Falkenstein when ready for first prod deploy at M3.

---

## 16. Acceptance criteria for v1.0 (the line for "done enough to launch")

- [ ] One full end-to-end SLR run on a public golden question, fully cited, with `cite_check` results visible
- [ ] All 30 golden questions run nightly without manual intervention; results on public dashboard
- [ ] Citation recall ≥ 0.70 across the 30-question set
- [ ] Hallucination rate ≤ 0.08 across the 30-question set
- [ ] Cost per run ≤ €0.50 median, ≤ €1.50 p95
- [ ] MCP server published to npm and registry; Claude Desktop install verified by author on a fresh machine
- [ ] Self-hosted Langfuse running in prod; `/observability` page live
- [ ] All six blog posts published
- [ ] Recruiter 1-pager PDF written, linked from README
- [ ] Repo has >0 external contributions OR >25 stars OR is shared by ≥3 hiring managers (any of the three)

---

## 17. Hand-off to implementation planning

This spec is the WHAT and WHY. The HOW (file-by-file plan, dependency order, per-milestone task graph) goes to the `superpowers:writing-plans` skill.
