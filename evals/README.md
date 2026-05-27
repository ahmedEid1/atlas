# Thoth eval harness

17 golden SLR questions in YAML; a headless runner that drives the M3+M4a
LangGraph per question; 4 metrics per run; an **advisory** regression
check; the public dashboard at <https://thoth-slr.vercel.app/evals>.

The project default is `LLM_PROVIDER=mistral` (free Experiment tier).
Structured output via the Vercel AI SDK is reliable on `mistral-large-latest`
for every node in Thoth's pipeline; that's why it stays the default for the
harness even after we wired up Anthropic / OpenAI / Groq / Gemini / the
Claude Agent SDK as alternatives.

## Run locally

```bash
pnpm eval              # writes eval-results.json + persists rows to EvalRun
pnpm eval:check        # reads eval-results.json, logs over-threshold drops
```

Filter to a subset with `EVAL_GOLDENS=000,001,005`. Bound the per-golden
walltime with `EVAL_GOLDEN_TIMEOUT_MS=900000` (default 15 min — enough headroom
for Mistral free-tier rate-limiting on the cite-check loop).

## Alternative providers

```bash
# Anthropic — paid, ~$0.50 per full sweep on Claude Sonnet
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... pnpm eval

# OpenAI — paid, ~$0.30 per full sweep on GPT-5.4-mini
LLM_PROVIDER=openai OPENAI_API_KEY=sk-... pnpm eval

# Groq — free, faster than Mistral but stricter context window
LLM_PROVIDER=groq GROQ_API_KEY=gsk_... pnpm eval

# Claude Agent SDK — free with Claude Max subscription, local-dev only
# Routes through @anthropic-ai/claude-agent-sdk using your local `claude` CLI
# session auth. NOT suitable for CI (no CLI auth in containers).
LLM_PROVIDER=claude-agent pnpm eval
```

A single `LLM_FALLBACK_PROVIDER` env var enables a one-shot retry against a
sibling provider when the primary throws — see `lib/llm.ts`.

## CI

`.github/workflows/evals.yml` runs:

- **schedule**: weekly on Monday 06:00 UTC (so any regression is visible by
  Monday morning before the EU work week).
- **workflow_dispatch**: manual trigger from the Actions tab, with a
  `goldens: smoke | all` choice. The cron always runs the 6-golden smoke
  set (000,001,002,004,005,007); the full 17-golden sweep is opt-in via
  `workflow_dispatch` with `goldens: all`.

Required repository secrets (Settings → Secrets and variables → Actions):

| Secret | Source |
|---|---|
| `DATABASE_URL`, `DIRECT_DATABASE_URL` | Neon pooled + direct |
| `MISTRAL_API_KEY` | <https://console.mistral.ai> (Free Experiment tier) |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` | Langfuse Cloud project |
| `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` | Cloudflare R2 |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET` | Clerk (parsed by `lib/env.ts` even though the eval path doesn't touch Clerk at runtime) |

## Regression check is **advisory**

`pnpm eval:check` compares each metric to the highest historical score for
that `(goldenId, metric)` and logs over-threshold drops with the `✗` marker
— but the script always exits 0. Empirical sweeps on identical agent code
under the Mistral free tier showed ±25-40% per-metric variance on
small-N goldens (4-5 expected papers); neither most-recent nor
high-water-mark baselines can separate that noise from real regressions.
Full rationale + the three paths that would restore a hard gate (move off
free tier, multi-trial median, larger expected-paper lists) live in the
comment at the bottom of `scripts/check-eval-regression.ts`.

The `/evals` dashboard is the authoritative public signal; the workflow
status only reflects catastrophic failures (empty sweep, infrastructure
outage), not LLM-judge variance.

## Adding a golden question

Drop a new file at `evals/golden/NNN-slug.yaml` matching `GoldenQuestionSchema`
in `lib/eval/golden-schema.ts`. The `NNN` prefix is the next sequential 3-digit
number. Re-run `pnpm eval` once to populate a baseline.
