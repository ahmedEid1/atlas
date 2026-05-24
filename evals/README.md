# Thoth eval harness

10 golden SLR questions in YAML; a runner that drives Thoth's M3+M4a
LangGraph headlessly per question; 4 metrics; CI gate at >10% regression;
public dashboard at https://thoth-slr.vercel.app/evals.

## Live eval runs — current status

Thoth defaults to `LLM_PROVIDER=groq` with `openai/gpt-oss-20b` for both tiers (the
only Groq model with strict `json_schema` support that fits the free-tier 8K TPM
budget). The harness runs end-to-end, but **free-tier providers exhibit upstream
quirks** that the canary surfaced:

| Provider           | Issue (May 2026)                                                              | Status                      |
|--------------------|-------------------------------------------------------------------------------|-----------------------------|
| Gemini 2.5 Flash   | `vercel/ai#12187` — `generateObject` can't parse responses reliably           | upstream blocker            |
| Groq gpt-oss-120b  | 8K TPM free-tier limit, exceeded by multi-paper questions                      | quota limit                 |
| Groq gpt-oss-20b   | Schema-property rejection (`$schema` meta field), occasional missing fields    | model capability + SDK quirk|

For a clean live-eval baseline, use a paid provider with reliable structured-output:

```bash
# Option 1 — Anthropic (paid, ~$0.50 per full eval run on Sonnet 4.6)
export LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
pnpm eval

# Option 2 — OpenAI (paid, ~$0.30 per full eval run on GPT-5.4-mini)
export LLM_PROVIDER=openai
export OPENAI_API_KEY=sk-...
pnpm eval

# Option 3 — Groq free (best-effort; some questions will fail with the quirks above)
export GROQ_API_KEY=gsk_...
pnpm eval

# Option 4 — Claude Agent SDK (free with Claude Max subscription, local-dev only)
# Routes through @anthropic-ai/claude-agent-sdk using your local `claude` CLI
# session auth. No ANTHROPIC_API_KEY required when the Claude Code CLI is logged
# in on the same machine. Not suitable for CI (no CLI auth in containers).
export LLM_PROVIDER=claude-agent
pnpm eval
```

The harness, metrics, regression gate, and dashboard all work correctly when the
underlying LLM produces compliant structured output. Provider stability is the
gating factor for a populated dashboard.

### Why not Gemini default?

Thoth's original default was Gemini Flash (free tier), but `vercel/ai#12187` makes
`generateObject` unreliable on Gemini Flash. Groq promoted to default because its
free-tier quotas are higher (30K TPM / 14400 req/day vs Gemini's 10 RPM / 250 RPD)
and `gpt-oss-20b` works for simple structured-output tasks even if it stumbles on
Thoth's deeply nested SLR schemas.

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
