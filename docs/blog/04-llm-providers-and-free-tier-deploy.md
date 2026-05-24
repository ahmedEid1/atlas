# Thoth, week four: six providers, $0/month, live on the internet

*The fourth post in a series documenting an open-source agentic literature-review platform.*

## What I shipped

- A provider-neutral LLM dispatcher: one env var (`LLM_PROVIDER=mistral|groq|gemini|anthropic|openai|claude-agent`) and every node in the agent loop runs against a different model — no per-call branching, no node-level code change.
- A live public deploy at [thoth-slr.vercel.app](https://thoth-slr.vercel.app), built on six free tiers stacked end to end: **Vercel + Neon + Cloudflare R2 + Langfuse Cloud + Trigger.dev Cloud + Clerk Cloud**, with Mistral as the default LLM. Total recurring cost: $0/month.
- A self-host fallback: a step-by-step walkthrough that brings Thoth up on Oracle Cloud's Always Free tier (4-core ARM Ampere + 24 GB RAM, free forever) — one VM, Caddy + auto-TLS, the whole stack in docker-compose.
- A Langfuse migration from the direct JS SDK to the OpenTelemetry exporter, so traces emit from both the Next.js process and the Trigger.dev workers without per-call instrumentation code.

This milestone is the one where Thoth went from "a thing that works on my laptop" to "a thing anyone can sign into in 90 seconds." The engineering wasn't glamorous; the outcome moved the project.

## Why I pivoted off Anthropic-direct

The M2 wrapper hardcoded Anthropic. That was fine for week two — the goal was to get the *shape* right, not the supplier — but it had two problems.

The first was cost. The agent loop in M3 makes 6+ LLM calls per run (planner, retriever, assessor, drafter, critic, plus one per citation in `cite_check`). On Anthropic Sonnet that's roughly $0.50 per run at typical SLR sizes. $0.50/run is the difference between "leave it open and let people play" and "rate-limit aggressively and worry about the bill." Times a dozen evaluation runs in CI per push, it stops being trivial.

The second was data residency. "Thoth defaults to Mistral, an EU model, runs on EU infrastructure, with EU-region observability" is a meaningfully different posture from "Thoth uses Claude." Both are fine; the first one matters for EU labs that care about where research corpora live.

So I refactored. `runLLM` became a dispatcher: it resolves `(provider, tier)` to a concrete AI SDK `LanguageModel` via a provider registry, calls `generateObject` with the existing Zod schemas, and returns a uniform result. The agent nodes don't know which provider they're talking to.

## The tier abstraction

The prompts in Thoth have heterogeneous compute needs. The planner does longer-form structured reasoning; the per-citation `cite_check` does short factual yes/no judgements at scale. Pinning every call to one model is wasteful for the cheap calls and underprovisioned for the hard ones.

So each prompt declares a `tier` — `"smart"` or `"fast"` — and `lib/llm/tiers.ts` maps each tier to a per-provider model id:

| Tier | Mistral | Groq | Gemini | Anthropic | OpenAI |
|---|---|---|---|---|---|
| smart | mistral-large | llama-3.3-70b | gemini-2.0-flash | claude-opus-4-7 | gpt-4o |
| fast | mistral-small | llama-3.1-8b | gemini-2.0-flash | claude-sonnet-4-7 | gpt-4o-mini |

Switching providers preserves the relative quality stratification. A "smart" call on Mistral is mistral-large; the same call on Anthropic is Opus. No prompt knows or cares.

The tier system is also where I quarantine the Gemini quirk. The Vercel AI SDK has a [known issue](https://github.com/vercel/ai/issues/12187) where Gemini Flash returns non-JSON for some Zod-validated structured-output requests. The Gemini provider in the registry sets `providerOptions.google.structuredOutputs = true` as a workaround, but it's not 100% reliable. Mistral became the default specifically because it's the most reliable free option for Thoth's workload.

## The "Claude Max as a free provider" trick

Late in this milestone I added a sixth provider that's only useful for local eval runs but is funny enough to mention. `@anthropic-ai/claude-agent-sdk` is the npm package backing the Claude Code CLI. If you're already logged into the CLI with a Claude Max subscription, the SDK can call Claude programmatically through that same authenticated session — no API key, no per-token billing.

The catch is that the SDK returns text only, not native structured output. The adapter in `lib/llm/providers/claude-agent.ts` bridges the gap: it serialises the Zod schema via `z.toJSONSchema`, asks the model to return JSON matching that schema, and validates the result on the way back. It's not the path for production traffic (the rate limits are interactive-use limits, not server-use), but for `pnpm eval` against the golden set locally with a Max subscription, it's a free way to run a real-Claude baseline against the Mistral default.

## The free-tier stack, end to end

The deploy is a layer cake of free tiers, each chosen because it covers Thoth's scale and stays free without a credit card on file (where possible):

- **Vercel Hobby** for the Next.js host. Generous limits at Thoth's scale; the build runs `prisma migrate deploy` automatically.
- **Neon Free** for Postgres in Frankfurt — EU region, branchable, scale-to-zero. Prisma v7's `@prisma/adapter-neon` is the driver, so the same Prisma client works against `pg` locally and Neon's serverless WebSocket driver in prod.
- **Cloudflare R2** for the object store. No egress fees — important when the demo means visitors' PDFs are being downloaded for parsing. S3-compatible via AWS SDK v3, same code path as MinIO locally.
- **Langfuse Cloud Hobby** (50K observations/month, EU region) for traces. The migration to the OTel exporter (`langfuse-vercel` + `@vercel/otel`) was the key enabler — traces emit from the Next.js process via `instrumentation.ts` and from Trigger.dev workers explicitly. No per-call instrumentation code anywhere in the agent nodes.
- **Trigger.dev Cloud Free** for the durable job runtime. The local `pnpm dev:trigger` is the same task code; `syncEnvVars` pushes the local `.env` to the prod Trigger.dev environment on every deploy.
- **Clerk Cloud Free** for auth, with the EU-region option enabled. Doubles as the OAuth Authorization Server for the M5 MCP work.
- **Mistral Free Experiment tier** for the LLM. The actual workhorse.

The stack reads like a free-tier listicle, but the engineering choices that made it work as one are real. The Prisma driver adapter means `pg` locally and Neon serverless in prod — same Prisma client, one env var. The S3-compatible code path means MinIO locally and R2 in prod — same SDK, one env var. The Trigger.dev `syncEnvVars` build extension means the secrets flow exactly once, at deploy time, from `.env` into the prod environment. Each of those would have been a multi-day refactor if I'd waited until the cloud deploy to think about them.

The lesson, repeating itself: the M1 / M2 abstractions were the unlock for M3.5. Putting a wrapper on a thing on day one and then using that wrapper consistently is the cheapest way to keep options open later.

## The self-host fallback

A free-tier cloud stack is great until somebody asks "but what if I don't trust Vercel / Cloudflare / Clerk with my research corpus?" The honest answer is "use the self-host walkthrough."

[`docs/self-host/oracle-cloud-quickstart.md`](../self-host/oracle-cloud-quickstart.md) walks through standing up Thoth on Oracle Cloud's Always Free tier — an ARM Ampere A1 VM with 4 cores and 24 GB of RAM, free forever, no card required after sign-up. One VM runs Thoth + Postgres + MinIO + Langfuse behind Caddy with auto-TLS. The LLM stays hosted (Mistral free tier, or any other supported provider), but no user data crosses my infrastructure. Total recurring cost: **$0/month + about €10/yr for a domain**.

Whether anybody actually self-hosts is almost beside the point. A real, documented, single-VM deploy path is what makes the GDPR story land: the cloud deploy is the default, the self-host is the escape hatch.

## What's next: M4

The free-tier deploy is the platform. M4 is the quality story on top of it: a critic node between drafter and the end of the graph, a `cite_check` post-pass that verifies every citation against the source paper, and a public eval dashboard at `/evals` so the quality story is a number, not a vibe.

---

*Spec: [`docs/superpowers/specs/thoth-design.md`](../superpowers/specs/thoth-design.md). Build order: [`docs/superpowers/plans/thoth-roadmap.md`](../superpowers/plans/thoth-roadmap.md).*
