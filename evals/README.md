# Atlas eval harness

10 golden SLR questions in YAML; a runner that drives Atlas's M3+M4a
LangGraph headlessly per question; 4 metrics; CI gate at >10% regression;
public dashboard at https://atlas-sooty-delta.vercel.app/evals.

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
