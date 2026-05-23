# Atlas eval harness

10 golden SLR questions in YAML; a runner that drives Atlas's M3+M4a
LangGraph headlessly per question; 4 metrics; CI gate at >10% regression;
public dashboard at https://atlas-sooty-delta.vercel.app/evals.

## Known issue: Gemini + Vercel AI SDK structured output (May 2026)

`pnpm eval` against the default `LLM_PROVIDER=gemini` currently fails with
`No object generated: could not parse the response`. This is a known
upstream issue: https://github.com/vercel/ai/issues/12187 — the Vercel AI
SDK's `generateObject` does not reliably get strict JSON back from Gemini
Flash on the free tier. We've already set `providerOptions.google.structuredOutputs = true`
in `lib/llm.ts` (the documented workaround), but the parse error persists
on the free-tier Flash model.

The eval harness itself (golden schema, headless runner, metrics, runner
script, CI workflow, dashboard) works correctly. Once the upstream bug is
fixed OR you set a different provider that doesn't exhibit it, evals will
run end-to-end.

### Workarounds

1. **Use Anthropic for evals (paid)**: set `LLM_PROVIDER=anthropic` and add a
   real `ANTHROPIC_API_KEY` to `.env`. Atlas's tier mappings keep claude-opus-4-7
   for smart and claude-sonnet-4-6 for fast.
2. **Use Groq (free)**: set `LLM_PROVIDER=groq` and add a `GROQ_API_KEY`
   (free at https://console.groq.com). Atlas uses `llama-3.3-70b-versatile`
   for smart, `llama-3.1-8b-instant` for fast — both on Groq's free tier.
3. **Wait for upstream fix** in `ai` or `@ai-sdk/google`.

## Run locally

```bash
pnpm eval              # runs evals against Neon, writes eval-results.json
pnpm eval:check        # reads eval-results.json, exits non-zero on regression
```

## CI

`.github/workflows/evals.yml` runs on every push to master + nightly at 03:00 UTC.
Required GitHub Secrets (Settings → Secrets and variables → Actions):

- `DATABASE_URL`, `DIRECT_DATABASE_URL` (Neon pooled + direct)
- `GOOGLE_GENERATIVE_AI_API_KEY`
- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`
- `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`

## Adding a golden question

Drop a new file in `evals/golden/NNN-slug.yaml` matching `GoldenQuestionSchema`
in `lib/eval/golden-schema.ts`. The id prefix `NNN` should be the next sequential
3-digit number.
