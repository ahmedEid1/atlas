<div align="center">

<img src="docs/assets/thoth-logo.svg" alt="Thoth — sacred ibis logo" width="120" height="120" />

# Thoth

**Agentic systematic literature reviews — with every citation checked against the source.**

*Named for Thoth, ancient Egypt's ibis-headed god of writing and scribes.*

[![Live demo](https://img.shields.io/badge/▶_live_demo-thoth--slr.vercel.app-1E3A8A?style=flat-square)](https://thoth-slr.vercel.app)
[![Public evals](https://img.shields.io/badge/evals-public-C9A961?style=flat-square)](https://thoth-slr.vercel.app/evals)
[![MCP Registry](https://img.shields.io/badge/MCP-registered-orange?style=flat-square)](https://registry.modelcontextprotocol.io/v0.1/servers?search=thoth)
[![Tests](https://img.shields.io/badge/tests-676%20passing-success?style=flat-square)](docs/architecture.md#tests--verification)
[![Version](https://img.shields.io/badge/version-2.0.0-informational?style=flat-square)](CHANGELOG.md)
[![Deploy cost](https://img.shields.io/badge/deploy-%240%2Fmo-brightgreen?style=flat-square)](docs/self-host/oracle-cloud-quickstart.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-black?style=flat-square)](LICENSE)

**[Try the live demo](https://thoth-slr.vercel.app)** · **[See a sample review](https://thoth-slr.vercel.app/showcase)** · **[Public eval dashboard](https://thoth-slr.vercel.app/evals)** · **[Connect via MCP](#-connect-it-to-your-ai-assistant)**

<img src="docs/assets/media/showcase-walkthrough.gif" alt="Browsing a completed Thoth review — draft, critic score, and per-claim citation audit" width="760" />

</div>

---

## What is Thoth?

Systematic literature reviews are slow to write — and when you ask an LLM to write
one, it confidently invents citations and statistics that aren't in any paper.

**Thoth does both halves and checks its own work.** Give it a research question and
it discovers relevant papers, reads them, drafts an evidence-grounded review — then
runs a verification pass (`cite_check`) that compares **every cited claim against the
source paper** and flags anything unsupported *before you read the draft*. The result
is a review with a critic score, a citation-faithfulness percentage, and a per-claim
audit you can trust.

It runs as a polished web app, a public eval dashboard, and an authenticated MCP
server your AI assistant can call directly.

## See it work

**Claude.ai catches 6 fabricated citations in a real draft — using Thoth's audit:**

<div align="center">
<img src="docs/assets/m5-mcp-demo.gif" alt="Claude.ai connected to Thoth via MCP, using get_citation_audit to identify 6 unsupported claims" width="760" />
</div>

> Connected to Thoth via the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=thoth), Claude calls `get_citation_audit`, finds a review with faithfulness 0.13, and identifies all 6 unsupported claims — every one citing the same paper, with invented percentages that aren't in the source.

**Every claim, scored against its source** — the `/showcase` review (no login needed):

<div align="center">
<img src="docs/assets/media/02-showcase.png" alt="A completed Thoth review: critic 4.2/5, citation faithfulness 75%, 8/8 citations checked with 2 unsupported" width="760" />
</div>

**Evaluated in public** — [`/evals`](https://thoth-slr.vercel.app/evals) tracks recall / precision / faithfulness / coverage over a versioned golden set, refreshed weekly by CI, so a regression is a public signal:

<div align="center">
<img src="docs/assets/media/03-evals.png" alt="Thoth's public eval dashboard — citation recall, precision, faithfulness, and coverage per golden question" width="760" />
</div>

## Key features

- **🔎 `cite_check` — verifiable citations.** Every `[paper_id]` in the draft is
  checked against the cited paper and labelled supported / unsupported / unclear.
  This is the core differentiator: the LLM can't quietly hallucinate a citation.
- **🌐 Outbound web search (v2).** Point Thoth at a question and its
  `discoverer → fetcher → screener` agents find papers across **OpenAlex**, **arXiv**,
  and **Exa**, fetch the open-access PDFs, OCR them, and screen each against your plan
  — no manual uploads required. (Or stay in uploaded-only, or hybrid.)
- **🔌 Authenticated, registered MCP server.** OAuth 2.1 + PKCE + Dynamic Client
  Registration via Clerk, SHA-256 audit logging, rate limits — listed in the
  [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=thoth).
  Most public MCP servers ship with no auth; this one doesn't.
- **📊 Public eval dashboard.** Recall / precision / faithfulness / coverage over a
  versioned golden set, refreshed weekly by CI and rendered at
  [`/evals`](https://thoth-slr.vercel.app/evals) — an eval regression is a *public*
  signal, not a hidden one.
- **💸 6 LLM providers, $0 by default.** Swap providers with one env var; the Mistral
  free tier runs the whole thing, and the entire stack deploys on free tiers for
  **$0/month**.

## 🚀 Quickstart

**Try it now (nothing to install):**
- **[Open the live demo →](https://thoth-slr.vercel.app)** and build a review, or
  **[browse a finished one →](https://thoth-slr.vercel.app/showcase)**.

**Connect it to your AI assistant** — paste this into claude.ai (Pro/Max), Claude
Desktop, Cursor, or any MCP client (OAuth runs in your browser; no token to copy):

```
https://thoth-slr.vercel.app/api/mcp/mcp
```

<details>
<summary>Read-only MCP tools (scoped to your account)</summary>

- `list_reviews` — your reviews with critic + faithfulness scores
- `get_review_draft` — the markdown draft of a completed review
- `get_citation_audit` — the per-claim cite_check verdict report
- `list_discovered_papers` *(v2)* — papers the discoverer surfaced, with fetch + screening status
- `get_search_queries` *(v2)* — the queries the discoverer generated + per-provider errors

Full reference: [`docs/mcp/tools.md`](docs/mcp/tools.md) · auth + audit model: [`docs/mcp/security.md`](docs/mcp/security.md)
</details>

<div align="center">
<img src="docs/assets/m5-mcp-setup.gif" alt="Adding Thoth as a custom MCP connector in claude.ai — paste the URL, OAuth via Clerk + Dynamic Client Registration" width="760" />
<br/><em>Adding Thoth as a custom connector in claude.ai — OAuth runs in your browser (Clerk + DCR), no token to copy.</em>
</div>

**Run it locally:**

```bash
git clone https://github.com/ahmedEid1/thoth.git && cd thoth
cp .env.example .env        # Clerk + Trigger.dev keys + MISTRAL_API_KEY
docker compose up -d        # postgres, minio, langfuse
pnpm install && pnpm prisma migrate dev
pnpm dev                    # Next.js on :3000
pnpm dev:trigger            # Trigger.dev worker (separate terminal)
```

Full setup, the agent pipeline, and the v2 flow: **[docs/architecture.md](docs/architecture.md)**.

## Proof

| | |
|---|---|
| **Live app** | [thoth-slr.vercel.app](https://thoth-slr.vercel.app) (Clerk sign-in) · sample review at [`/showcase`](https://thoth-slr.vercel.app/showcase) |
| **Public evals** | [`/evals`](https://thoth-slr.vercel.app/evals) — recall/precision/faithfulness/coverage over an 18-question golden set, refreshed weekly by CI |
| **MCP Registry** | [`io.github.ahmedEid1/thoth`](https://registry.modelcontextprotocol.io/v0.1/servers?search=thoth) — `status: active` |
| **Tests** | 676 unit/integration + 22 live e2e against the deployed instance (MCP transport, real-browser, authenticated walkthroughs, full agent runs) — all green; tsc + lint clean |
| **Audit log** | Every MCP call recorded with a SHA-256 input hash; no raw input stored |
| **Deploy cost** | $0/month — Vercel + Neon + Cloudflare R2 + Langfuse + Trigger.dev, all free tiers ([self-host option](docs/self-host/oracle-cloud-quickstart.md)) |

## For engineers

Thoth is a **LangGraph** `StateGraph` driven by a **Trigger.dev** worker, with durable
human-in-the-loop gates, a per-run cost cap, and exactly-once gate delivery. Next.js 16
+ TypeScript (strict), Postgres + Prisma, Clerk auth (web + OAuth 2.1 for MCP),
S3-compatible storage, Mistral OCR, Langfuse tracing.

- **[Architecture](docs/architecture.md)** — the agent pipeline, full stack, v2 flow, tests
- **[LLM providers](docs/llm-providers.md)** — the 6-provider matrix + resilience knobs
- **[MCP tools](docs/mcp/tools.md)** · **[MCP security](docs/mcp/security.md)**
- **[Security & privacy](docs/security-and-privacy.md)** — data inventory, jurisdictions, deletion paths
- **[Self-host](docs/self-host/oracle-cloud-quickstart.md)** — one VM on Oracle Cloud Always Free
- **[Changelog](CHANGELOG.md)** · **[Design spec & build log](docs/superpowers/)** · **[Releasing](RELEASING.md)**

## Credits

Ibis icon by [Delapouite](https://delapouite.com/) under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), via [game-icons.net](https://game-icons.net/1x1/delapouite/ibis.html).

## License

[MIT](LICENSE) © 2026 Ahmed Hobeishy
