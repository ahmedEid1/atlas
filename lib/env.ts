import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  DIRECT_DATABASE_URL: z.string().url().optional(),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().min(1),

  TRIGGER_PROJECT_REF: z.string().optional(),
  TRIGGER_SECRET_KEY: z.string().optional(),

  // Optional: only needed when a real LLM call is made. lib/llm.ts throws at call time if absent.
  ANTHROPIC_API_KEY: z.string().optional(),
  // Optional: only needed when LLM_PROVIDER=gemini at call time.
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  // Optional: only needed when the PDF parser runs. lib/pdf-parse.ts throws at call time if absent.
  MISTRAL_API_KEY: z.string().optional(),

  LLM_PROVIDER: z.enum(["gemini", "anthropic", "openai", "groq", "claude-agent", "mistral"]).default("groq"),
  LANGFUSE_PUBLIC_KEY: z.string().min(1),
  LANGFUSE_SECRET_KEY: z.string().min(1),
  LANGFUSE_HOST: z.string().url(),

  // Retained for the dormant `lib/demo/clone-review.ts` helper kept in
  // the tree for potential future re-enable. Not on the current code
  // path — `/api/demo/start` lands guests on an empty dashboard. Safe
  // to leave unset; safe to remove the helper + this var entirely if
  // the clone flow stays retired through V1.
  DEMO_TEMPLATE_PROJECT_ID: z.string().optional(),

  // Optional: salt used to hash client IPs before they're used as keys in
  // the in-memory demo rate limiter. Hashing-with-salt means we never keep
  // raw IPs in process memory. Defaults to a static value; override in
  // production to make hashes unpredictable across deploys.
  IP_HASH_SALT: z.string().default("thoth-demo-static-salt"),

  // Optional: shared secret that callers send in the `x-health-detail`
  // request header to /api/health to receive the raw DB error string in
  // the JSON response. When unset (the common case) the dbError field is
  // omitted unconditionally so we never leak Prisma error text — which
  // routinely includes DB hostnames, ports, and sometimes credentials —
  // to public scrapers / monitors.
  HEALTH_DETAIL_TOKEN: z.string().optional(),

  // Per-run token ceiling enforced by lib/agent/cost-cap.ts. Sums input+output
  // tokens across all RunSteps and trips BudgetExceededError before the next
  // runLLM call when exceeded. 250k covers a generous review run; tunable
  // per-env for tighter budgets in CI/eval or looser ones in production.
  MAX_TOKENS_PER_RUN: z.coerce.number().int().positive().default(250_000),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

function parseEnv(): Env {
  if (_env !== null) return _env;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  _env = parsed.data;
  return _env;
}

/**
 * Lazy env access via Proxy. Parsing + validation happens on the first property
 * read, not at module import. This lets indexer / build tools (notably
 * Trigger.dev's deploy indexing phase) load modules that import env without
 * the env vars being present in the build context. Real env access at runtime
 * still throws with a clear error if vars are missing.
 *
 * For tests: vi.mock("@/lib/env", () => ({ env: { ... } })) replaces this
 * whole module export, so the proxy is bypassed there entirely.
 */
export const env: Env = new Proxy({} as Env, {
  get(_, key: string) {
    return parseEnv()[key as keyof Env];
  },
  has(_, key: string) {
    return key in parseEnv();
  },
});

/** For tests that need to force re-parse after mocking process.env */
export function _resetEnvForTest(): void {
  _env = null;
}
