# Thoth, week two: first AI, first traces

*The second post in a series documenting an open-source agentic literature-review platform.*

## What I shipped this week

- A `summarize_paper` Trigger.dev task: takes a parsed corpus item, returns a structured `PaperSummary` (abstract, research questions, methodology, key findings, limitations, study type, relevance) validated by Zod.
- One wrapper — `lib/llm.ts` — that every future LLM call in M3 through M6 goes through. There is no second path to an LLM in this codebase.
- A self-hosted Langfuse stack — Postgres + ClickHouse + Redis + MinIO — running under docker-compose, bootstrapped via `LANGFUSE_INIT_*` env vars so dev keys are deterministic and no manual dashboard step is required.
- UI: a "Summarise" button on parsed corpus items that enqueues the task and renders the structured summary on the card when it lands.

The first piece of actual AI in the app. It's deliberately small — one tool, one prompt, one task — because the goal of M2 isn't to be impressive. The goal is to establish the *path* that everything else flows through.

## Why a single LLM wrapper matters

The shape of `runLLM` is the most important design decision of the whole project. Every Anthropic / Mistral / Groq / Gemini / OpenAI call in Thoth — planner, retriever, assessor, drafter, critic, cite_check, summariser — goes through this one function. It looks like:

```ts
export async function runLLM<T>(args: {
  name: string;           // span name, e.g. "summarize-paper"
  tier: Tier;             // "smart" | "fast" — mapped per-provider in lib/llm/tiers.ts
  maxTokens: number;
  system: string;
  messages: ModelMessage[];
  schema: z.ZodType<T>;   // structured output, Zod-validated
  metadata?: Record<string, unknown>;
}): Promise<RunLLMResult<T>>
```

Three things follow from this shape, and they're not optional:

1. **Every call is a Langfuse span.** The function attaches `experimental_telemetry` to every request; the Langfuse OTel exporter picks it up. Cost, latency, prompt, output, validation result — all captured, with no caller able to forget it.
2. **Every call has a Zod schema.** Structured output is a required argument. There is no path that lets a future agent node receive raw model text and try to parse it by hand.
3. **Every call resolves the provider through one registry.** Switch `LLM_PROVIDER=mistral` to `=groq` in `.env` and every node in M3+ uses the new provider — no node-level code change, no per-call branching.

That third point didn't matter on day one (M2 ran on Anthropic only). It became the entire premise of M3.5 when I pivoted from the original "Anthropic + self-host" stack to a six-provider, $0/month free-tier deploy. None of the M3 agent nodes had to change. That's the payoff of putting the wrapper in early.

## Why self-hosted Langfuse (and what it cost)

Langfuse Cloud has a generous free tier and I eventually moved Thoth's production traces there for M3.5b's $0 deploy. But for the local dev story, I wanted the docker-compose stack to include observability — partly because I wanted EU researchers self-hosting Thoth to get traces without signing up for anything, partly because standing it up end-to-end with no SaaS dependency forces you to learn the architecture in a way a hosted API key never will.

The footprint is more than I expected: Langfuse needs Postgres for the app, ClickHouse for the event store, Redis for the queue, and an S3-compatible bucket for blob storage. That's four services beyond the Langfuse web container itself. docker-compose handles the orchestration, and `LANGFUSE_INIT_PROJECT_PUBLIC_KEY` / `..._SECRET_KEY` env vars seed the project at first boot so my dev keys never change.

The trade-off vs Langfuse Cloud: the self-host stack adds ~700 MB to local memory and a slower cold start. In return, you can run the full Thoth dev loop with zero outbound network requests except the LLM API call itself — which matters if you're working on a flight, or you're a researcher who can't share traces with a US-based SaaS for compliance reasons.

For production I now run on Langfuse Cloud (EU region, GDPR-clean) because the operational cost of self-hosting a fifth-party service for the live deploy isn't justified at this scale. The docker-compose stack stays in the repo so the self-host story is real.

## Structured output with Zod, end to end

`summarize_paper` returns this shape:

```ts
export const PaperSummarySchema = z.object({
  abstract: z.string(),
  researchQuestions: z.array(z.string()),
  methodology: z.string(),
  keyFindings: z.array(z.string()),
  limitations: z.array(z.string()),
  studyType: z.enum(["empirical", "experiment", "case_study", "survey", "review", "theoretical", "other"]),
  relevanceToSLR: z.enum(["highly_relevant", "relevant", "tangential", "off_topic"]),
});
```

The schema flows three places:

1. Into the LLM call via `generateObject({ schema, ... })` from the Vercel AI SDK — the SDK handles the provider-specific JSON-mode plumbing.
2. Out of the LLM call as a fully-typed `PaperSummary` — no `as` casts, no `JSON.parse`, no retry-on-malformed-json loop.
3. Into Postgres as `CorpusItem.summary` (a `Json` column), where it's read back on render with the same Zod schema as a runtime validator at the trust boundary.

When validation fails — and it does occasionally, especially on smaller models — the Vercel AI SDK surfaces a typed error and `runLLM` re-throws it with the span already closed. The Trigger.dev task catches it and marks the corpus item `FAILED` with the validation message in `failureReason`. The UI shows the error inline. No silent fallback to half-parsed JSON, no swallowed exceptions.

This was the moment I stopped treating "the model returned something" and "the model returned the thing I asked for" as the same event.

## The summarise prompt: paper as system context

The system prompt is shaped as:

```
[instructions]

<paper>
[the full Mistral-OCR markdown of the PDF]
</paper>
```

A few things to note:

- The instructions go *first*, the paper goes *last*. On providers that support prompt caching (Anthropic), the prefix-invariant rule means you want the long, stable thing (the paper) in a position where it can be cached across re-summarisations of the same paper. Putting it last in the system text keeps the cache-eligible region maximally long if I later turn on explicit cache controls.
- The `<paper>...</paper>` delimiter is XML-ish on purpose. It's robust against accidental prompt injection inside the paper's text (a paper containing `Ignore previous instructions` is just literal text inside the tags) and trivial for the model to identify.
- The user message is short and predictable: "the user's research question is X, produce the structured summary." This keeps the cache hit rate high — only the user message varies per call for the same paper.

I'm not turning on the Anthropic cache-control headers explicitly in `runLLM` today; the wrapper has a single code path across six providers, and the structured output flow through Vercel AI SDK doesn't surface per-block cache controls uniformly yet. Anthropic still auto-caches eligible prompts above its threshold server-side, which is enough at current scale. Wiring explicit cache controls back in is a fast follow when M6 traffic actually justifies optimising for cache hit rate.

## What's next: M3

Week three goes from one-shot tool to a full agent loop: a four-node LangGraph state machine (planner → retriever → assessor → drafter) wrapped in Trigger.dev for worker-restart durability, with two human-in-the-loop approval gates — approve the plan before retrieval, approve the included papers before extraction.

Every one of those four nodes is going to call `runLLM`. The wrapper from this week is what makes the next week ship.

---

*Spec: [`docs/superpowers/specs/thoth-design.md`](../superpowers/specs/thoth-design.md). Build order: [`docs/superpowers/plans/thoth-roadmap.md`](../superpowers/plans/thoth-roadmap.md).*
