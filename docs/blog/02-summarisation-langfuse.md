# Atlas, week two: first AI, first traces

The second post in a series documenting an open-source agentic literature-review platform.

## What I shipped this week

- A `summarize_paper` tool: Claude Opus 4.7, adaptive thinking, structured output via Zod, paper markdown cached as a system prompt
- A self-hosted Langfuse stack — Postgres + ClickHouse + Redis + MinIO — bootstrapped via `LANGFUSE_INIT_*` so dev keys are deterministic
- One wrapper (`lib/llm.ts`) that every future LLM call in M3-M6 will go through
- UI: a "Summarise" button on parsed corpus items that surfaces the trace URL directly in the card

## Why a single LLM wrapper matters

[Pitch the value: every LLM call going through one place means cost tracking, Langfuse spans, schema validation, and prompt caching are not optional. You can't forget them, because the type system won't let you call Claude directly.]

## Why self-hosted Langfuse (and what it cost)

[The GDPR / sovereignty narrative. The docker-compose footprint. The trade-off vs Langfuse Cloud's free tier. Why this matters specifically for EU hiring stories.]

## Prompt caching on a paper-as-system-block

[Show the cache hit numbers from a re-summarisation. Explain prefix invariant. Explain why the paper goes last in the system array, not the instructions.]

## The structured-output trick

[Why `output_config.format` + `messages.parse()` beats hand-rolled JSON parsing + retry loops. What happens when validation fails inside the SDK.]

## What's next: M3

[The full LangGraph loop — planner → retriever → assessor → drafter — and the first HITL approval gate.]
