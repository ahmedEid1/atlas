import { defineConfig } from "@trigger.dev/sdk";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";
import { config as dotenvConfig } from "dotenv";

/**
 * Trigger.dev project env sync — armed-switch + explicit allowlist.
 *
 * Behavior:
 *   - Default (TRIGGER_DEPLOY_CONFIRM unset): sync is DISABLED. Returns `[]`
 *     so Trigger.dev's existing project env is preserved untouched. This
 *     prevents a developer's local .env from silently overwriting prod env.
 *   - Armed (TRIGGER_DEPLOY_CONFIRM="1"): reads local .env and pushes ONLY
 *     keys present in `ALLOWED_PROD_KEYS`. Anything else (unknown keys,
 *     personal tokens, scratch values) is silently dropped — never leaves
 *     the laptop.
 *
 * Why an allowlist (not a denylist):
 *   - Adding a new env var to local .env (e.g. `MY_DEBUG_FLAG=1`) must NOT
 *     leak to prod by accident. The default is "drop everything not on the
 *     list", so new vars require an explicit code change to this file —
 *     visible in PR review.
 *
 * To deploy with synced env:
 *   TRIGGER_DEPLOY_CONFIRM=1 pnpm trigger:deploy
 *
 * To add a new key to prod sync: append it to ALLOWED_PROD_KEYS below.
 */

/**
 * Env vars the Trigger.dev workers (LangGraph pipeline, PDF parsing,
 * LLM calls, Langfuse traces, S3 uploads) genuinely need at runtime.
 * Cross-referenced against `lib/env.ts`. Keep alphabetical within groups.
 *
 * NOT included on purpose:
 *   - TRIGGER_PROJECT_REF / TRIGGER_SECRET_KEY — CLI-only credentials,
 *     the workers don't read them.
 *   - DEMO_TEMPLATE_PROJECT_ID — dormant, only referenced by the kept-for-
 *     potential-re-enable `lib/demo/clone-review.ts`; not on any active path.
 *   - LLM_PROVIDER — pinned per environment in Trigger.dev project settings,
 *     so the dev default ("groq") doesn't accidentally override prod.
 *   - NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY — web-only; workers don't render UI.
 *   - S3_FORCE_PATH_STYLE — bool flag, set per environment in Trigger UI.
 */
export const ALLOWED_PROD_KEYS: readonly string[] = [
  // Postgres (Prisma + LangGraph checkpointer in @langchain/langgraph-checkpoint-postgres)
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",

  // Object storage for PDFs + parsed markdown (lib/object-store.ts → @aws-sdk/client-s3)
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_BUCKET",

  // LLM providers (lib/llm.ts; each is optional but read at call-time)
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENAI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",

  // Observability (langfuse / langfuse-vercel — required by lib/env.ts)
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_HOST",

  // Clerk server-side (workers verify user/project ownership via @clerk/nextjs/server)
  "CLERK_SECRET_KEY",
  "CLERK_WEBHOOK_SIGNING_SECRET",
] as const;

export async function loadSyncEnv(): Promise<{ name: string; value: string }[]> {
  const armed = process.env.TRIGGER_DEPLOY_CONFIRM === "1";
  if (!armed) {
    // Disabled: leave Trigger.dev project env untouched.
    console.log("[trigger.config] sync mode: disabled; keys: 0");
    return [];
  }

  const result = dotenvConfig({ path: ".env", processEnv: {} });
  if (result.error) {
    console.log("[trigger.config] sync mode: armed; keys: 0 (no .env found)");
    return [];
  }
  const allow = new Set(ALLOWED_PROD_KEYS);
  const entries = Object.entries(result.parsed ?? {})
    .filter(([k, v]) => allow.has(k) && typeof v === "string" && v.length > 0)
    .map(([name, value]) => ({ name, value }));

  console.log(`[trigger.config] sync mode: armed; keys: ${entries.length}`);
  return entries;
}

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "",
  dirs: ["./trigger"],
  runtime: "node",
  logLevel: "info",
  maxDuration: 600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 30000,
      randomize: true,
    },
  },
  build: {
    extensions: [
      prismaExtension({
        mode: "modern",
      }),
      syncEnvVars(loadSyncEnv),
    ],
  },
});
