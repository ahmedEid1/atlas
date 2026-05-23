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

  LLM_PROVIDER: z.enum(["gemini", "anthropic", "openai", "groq", "claude-agent"]).default("groq"),
  LANGFUSE_PUBLIC_KEY: z.string().min(1),
  LANGFUSE_SECRET_KEY: z.string().min(1),
  LANGFUSE_HOST: z.string().url(),
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
