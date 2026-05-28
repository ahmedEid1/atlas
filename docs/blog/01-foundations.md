# Thoth, week one: foundations

*The first in a series documenting an open-source agentic literature-review platform, built from spec to public release over a few focused weeks of evenings.*

## Why I'm building Thoth

I've spent the last few years writing full-stack TypeScript for SaaS apps. Agentic AI is the shift I wanted to learn deeply, so I built Thoth as a way to actually use LangGraph, evals, observability, MCP, HITL gates, and cost discipline in one project. "I've used the OpenAI API once" wasn't going to teach me much; *shipping* a real agentic system that I can defend technically end to end would.

Thoth is a useful artifact — a tool a researcher can self-host and actually run on real PDFs without sending the contents to a third-party SaaS — and a single deeply-engineered project that exercises each of those agentic skills with code I can read back later.

The name is Thoth, after the ibis-headed Egyptian god of writing and scribes. The hieroglyph for "scribe" was literally an ibis. It's a tool that drafts and verifies systematic literature reviews — the ibis on the cover does the symbolism for me so I don't have to do it in the copy.

## Why SLR-only for v1

Systematic literature reviews (Kitchenham-style) are a narrow niche, and that's the point. Narrow means I can build a real golden eval set: citation recall, citation precision, claim faithfulness, factual accuracy — all measurable against published reviews. I already have working knowledge of the Kitchenham methodology from earlier writing, so I'm not learning the domain and the engineering at the same time.

Adjacent tools (Elicit, Undermind, Perplexity) address different jobs. Nobody has shipped a production-grade agent that does the full SLR loop end to end — plan → retrieve → assess → draft → critique → verify citations — with a public eval harness behind it. That's the gap.

Once the eval harness has signal, the same machinery extends to broader literature review in v2. For now: one niche, fully evaluable.

## The boring infra choices that matter

The temptation with any agentic project is to spend week one on the agent. I deliberately didn't. Week one was the unglamorous foundation: auth, DB, object storage, durable jobs, PDF parsing. If the bottom of the stack wobbles, nothing on top of it is credible.

- **Clerk for auth.** Not roll-your-own JWT. Clerk also doubles as the OAuth Authorization Server later when M5 adds an authenticated MCP server — same identity provider, no rebuild.
- **Prisma v7 with `@prisma/adapter-neon`.** v7 went all-in on the driver-adapter pattern; you pick your driver (`pg` locally, `@neondatabase/serverless` in prod) and Prisma is provider-agnostic. This is what made the eventual move to Neon serverless in M3.5b a single-file change.
- **Trigger.dev v4 for durable jobs.** The agent loop cannot live inside a Next.js request handler — it runs for minutes, pauses for hours on human approvals, and needs to survive worker restarts. Trigger.dev gives me that durability without me writing a queue.
- **S3-compatible object storage (MinIO local, Cloudflare R2 in prod).** PDFs are private user content; they belong in a bucket, not in Postgres. S3-compatible means MinIO in docker-compose for dev and R2 for prod — same SDK, one env var.

None of this is novel. That's the point. The novel parts come later (LangGraph + Trigger.dev HITL, cite_check, the eval harness, the authenticated MCP server). The foundation is supposed to be boring.

## Why Mistral OCR for PDF parsing

The original plan was to run `marker-pdf` inside a Trigger.dev Python worker. It would keep all PDF parsing local — no third-party SaaS — which is the GDPR-friendly story for EU labs. But there were two problems.

The first is engineering velocity. The Python worker would need its own Dockerfile, its own dependencies, its own deploy pipeline. That's real time, and I have a fixed budget of evenings.

The second is quality. When I started benchmarking, Mistral's OCR API (`mistral-ocr-latest`) was producing markdown output that was strictly better than `marker-pdf` on the academic PDFs I tested — equations preserved, columns merged correctly, figure captions in the right place. And the API is on Mistral's free tier, with EU data residency.

So `lib/pdf-parse.ts` calls Mistral OCR over HTTPS with the PDF as a base64 data URL — no public hosting required, works for R2-stored private files. The TS-only worker means one runtime, one deploy. The self-host story still holds: a Thoth instance on Oracle Cloud Always Free uses the same Mistral free tier (or any other supported provider) for parsing, with no Thoth user data crossing my infrastructure.

Lesson learned for me: the "default obvious choice" from the design spec is worth re-evaluating once you can actually benchmark it. Marker would have been fine; Mistral was better and shipped faster.

## TDD for full-stack: what's testable, what isn't

The test pyramid for M1 looks like:

- **Unit tests** mock everything external — Clerk, Prisma, the S3 client. They run in milliseconds and assert pure logic: "given this auth context and this input, the upload handler returns 401 / 400 / 200 with this shape."
- **Integration tests** use the real Prisma client against a docker-compose Postgres, and the real S3 SDK against MinIO. They catch the things mocks can't: a Prisma migration drift, an S3 bucket-not-found, a presigned URL that doesn't actually work.
- **E2E smoke tests** in Playwright drive the live deployed app for the most critical paths only — sign in, see the dashboard, MCP OAuth handshake. They're the slowest tier and they exist to catch deployment-level breakage that unit and integration tests can't see.

For the parse-pdf task specifically, the contract is "given a PDF blob in R2, populate `CorpusItem.parsedMarkdown` and flip status to `PARSED`." The unit test mocks `parsePdfWithMistral` because exercising the real Mistral API would cost money and take seconds per test. The integration test exercises the real Trigger.dev task runner with a small fixture PDF; we accept that the OCR call itself is the part not tested — the contract is what matters, and a contract test for "did we call Mistral with the right args" is more useful than a brittle end-to-end test against a live model.

One rule I made for myself early: **never make a real paid LLM call in tests without explicit approval.** Vitest can run the whole suite offline, in CI, against any branch, and it costs zero. That rule has held all the way through M5.

## What's next: M2

Week two: the first AI in the app. A `summarize_paper` tool, the single `runLLM` wrapper that every future LLM call in the codebase will go through, and a self-hosted Langfuse stack so every call is a traced, costed, validated span.

---

*The full design spec lives at [`docs/superpowers/specs/thoth-design.md`](../superpowers/specs/thoth-design.md). The per-milestone build order is at [`docs/superpowers/plans/thoth-roadmap.md`](../superpowers/plans/thoth-roadmap.md). Both are versioned alongside the code in [github.com/ahmedEid1/thoth](https://github.com/ahmedEid1/thoth). The work follows a spec-driven approach.*
