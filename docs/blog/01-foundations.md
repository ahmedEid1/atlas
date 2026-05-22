# Atlas, week one: foundations

*The first in a series documenting an open-source agentic literature-review platform, built from spec to public launch over seven weeks.*

## Why I'm building Atlas

[Pitch: applied AI engineering done right; SLR niche; what existing tools miss; why GDPR-safe matters; the personal angle (pivot from full-stack SWE).]

## Why SLR-only for v1

[Narrow niche → evaluable. Plays to existing Kitchenham methodology familiarity. Will expand to broader lit-review in v2 once the eval harness has signal.]

## The boring infra choices that matter

- Clerk for auth (not roll-your-own JWT)
- Prisma v7 for DB (the v7 driver-adapter pattern is new and worth a sub-section)
- Trigger.dev v4 for durable jobs (so the agent loop doesn't live inside Next.js request handlers)
- MinIO for blob storage (S3-compatible, self-hostable, GDPR-friendly)

## Why marker-pdf, via Trigger.dev's Python extension

[Not sending PDFs to a third-party SaaS. The Trigger.dev Python extension means we can keep the TS/Node ergonomics on the API side while running heavyweight ML inside the worker.]

## TDD for full-stack: what's testable, what isn't

[Show the unit/integration/e2e pyramid. Why mock Clerk + Prisma in unit tests but use real MinIO + Postgres in integration. Why the parse-pdf agent test mocks `python.runScript` and we accept that — the contract is what matters.]

## What's next: M2

[Summarisation agent + Langfuse self-hosted. The first piece of actual AI in the app.]

---

*The full design spec and per-milestone plans live at [github.com/ahmedEid1/atlas/docs](https://github.com/ahmedEid1/atlas/tree/main/docs). The work is built using a spec-driven approach with Claude Code as the implementation collaborator.*
