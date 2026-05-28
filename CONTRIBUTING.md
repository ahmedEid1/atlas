# Contributing to Thoth

Thanks for your interest! Thoth is built with spec-driven development — see
[`docs/architecture.md`](docs/architecture.md) for how it fits together and
[`docs/superpowers/`](docs/superpowers/) for the design specs + build log.

## Local setup

```bash
git clone https://github.com/ahmedEid1/thoth.git && cd thoth
cp .env.example .env        # Clerk + Trigger.dev keys + MISTRAL_API_KEY
docker compose up -d        # postgres, minio, langfuse
pnpm install && pnpm prisma migrate dev
pnpm dev                    # Next.js on :3000
pnpm dev:trigger            # Trigger.dev worker (separate terminal)
```

Pick any free LLM provider (Mistral/Groq/Gemini) — see
[`docs/llm-providers.md`](docs/llm-providers.md).

## Before you open a PR

```bash
pnpm verify     # typecheck + lint + tests — must be green (this is the pre-tag gate)
```

- **Tests:** Thoth is test-driven. New behaviour or bug fixes should come with a
  failing test first, then the change that makes it pass.
- **Style:** TypeScript strict; ESLint + the existing patterns. Keep comments to
  the *why*, not the *what*.
- **Scope:** small, focused PRs. Note any schema change (Prisma migration) and any
  new env var (add it to `.env.example` + `lib/env.ts`, and to
  `ALLOWED_PROD_KEYS` in `trigger.config.ts` if the worker needs it).
- **Secrets:** never commit `.env`, credentials, or large binaries.

## Commit messages

Conventional-commit style, e.g. `feat(...)`, `fix(...)`, `docs(...)`, `test(...)`,
`chore(...)`. Reference a milestone where relevant.

## Reporting issues

Use the issue templates. For security concerns, see
[`docs/security-and-privacy.md`](docs/security-and-privacy.md) rather than filing a
public issue.
