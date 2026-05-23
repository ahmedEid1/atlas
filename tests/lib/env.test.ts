import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("env", () => {
  let original: NodeJS.ProcessEnv;

  beforeEach(() => {
    original = { ...process.env };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = original;
  });

  it("parses a valid env successfully", async () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/d";
    process.env.S3_ENDPOINT = "http://localhost:9000";
    process.env.S3_REGION = "us-east-1";
    process.env.S3_ACCESS_KEY_ID = "a";
    process.env.S3_SECRET_ACCESS_KEY = "b";
    process.env.S3_BUCKET = "atlas-corpus";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_x";
    process.env.CLERK_SECRET_KEY = "sk_test_x";
    process.env.CLERK_WEBHOOK_SIGNING_SECRET = "whsec_x";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    process.env.LANGFUSE_HOST = "http://localhost:3030";

    const { env } = await import("@/lib/env");
    expect(env.DATABASE_URL).toContain("postgresql");
    expect(env.S3_BUCKET).toBe("atlas-corpus");
  });

  it("throws on missing required var", async () => {
    delete process.env.DATABASE_URL;
    process.env.S3_ENDPOINT = "http://localhost:9000";
    process.env.S3_REGION = "us-east-1";
    process.env.S3_ACCESS_KEY_ID = "a";
    process.env.S3_SECRET_ACCESS_KEY = "b";
    process.env.S3_BUCKET = "atlas-corpus";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_x";
    process.env.CLERK_SECRET_KEY = "sk_test_x";
    process.env.CLERK_WEBHOOK_SIGNING_SECRET = "whsec_x";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    process.env.LANGFUSE_HOST = "http://localhost:3030";

    // env is lazy now — import succeeds; throw on first property read
    const { env } = await import("@/lib/env");
    expect(() => env.S3_BUCKET).toThrow(/DATABASE_URL/);
  });

  it("parses successfully without ANTHROPIC_API_KEY", async () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5433/d";
    process.env.S3_ENDPOINT = "http://localhost:9010";
    process.env.S3_REGION = "us-east-1";
    process.env.S3_ACCESS_KEY_ID = "a";
    process.env.S3_SECRET_ACCESS_KEY = "b";
    process.env.S3_BUCKET = "atlas-corpus";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_x";
    process.env.CLERK_SECRET_KEY = "sk_test_x";
    process.env.CLERK_WEBHOOK_SIGNING_SECRET = "whsec_x";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    process.env.LANGFUSE_HOST = "http://localhost:3030";
    delete process.env.ANTHROPIC_API_KEY;

    const { env } = await import("@/lib/env");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("defaults LLM_PROVIDER to 'groq' when unset", async () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5433/d";
    process.env.S3_ENDPOINT = "http://localhost:9010";
    process.env.S3_REGION = "us-east-1";
    process.env.S3_ACCESS_KEY_ID = "a";
    process.env.S3_SECRET_ACCESS_KEY = "b";
    process.env.S3_BUCKET = "atlas-corpus";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_x";
    process.env.CLERK_SECRET_KEY = "sk_test_x";
    process.env.CLERK_WEBHOOK_SIGNING_SECRET = "whsec_x";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    process.env.LANGFUSE_HOST = "http://localhost:3030";
    delete process.env.LLM_PROVIDER;

    const { env } = await import("@/lib/env");
    expect(env.LLM_PROVIDER).toBe("groq");
  });

  it("accepts LLM_PROVIDER=anthropic", async () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5433/d";
    process.env.S3_ENDPOINT = "http://localhost:9010";
    process.env.S3_REGION = "us-east-1";
    process.env.S3_ACCESS_KEY_ID = "a";
    process.env.S3_SECRET_ACCESS_KEY = "b";
    process.env.S3_BUCKET = "atlas-corpus";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_x";
    process.env.CLERK_SECRET_KEY = "sk_test_x";
    process.env.CLERK_WEBHOOK_SIGNING_SECRET = "whsec_x";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    process.env.LANGFUSE_HOST = "http://localhost:3030";
    process.env.LLM_PROVIDER = "anthropic";

    const { env } = await import("@/lib/env");
    expect(env.LLM_PROVIDER).toBe("anthropic");
  });

  it("rejects unknown LLM_PROVIDER values at parse time", async () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5433/d";
    process.env.S3_ENDPOINT = "http://localhost:9010";
    process.env.S3_REGION = "us-east-1";
    process.env.S3_ACCESS_KEY_ID = "a";
    process.env.S3_SECRET_ACCESS_KEY = "b";
    process.env.S3_BUCKET = "atlas-corpus";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_x";
    process.env.CLERK_SECRET_KEY = "sk_test_x";
    process.env.CLERK_WEBHOOK_SIGNING_SECRET = "whsec_x";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    process.env.LANGFUSE_HOST = "http://localhost:3030";
    process.env.LLM_PROVIDER = "ollama";

    // env is lazy now — import succeeds; throw on first property read
    const { env } = await import("@/lib/env");
    expect(() => env.LLM_PROVIDER).toThrow(/LLM_PROVIDER/);
  });

  it("treats GOOGLE_GENERATIVE_AI_API_KEY as optional", async () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5433/d";
    process.env.S3_ENDPOINT = "http://localhost:9010";
    process.env.S3_REGION = "us-east-1";
    process.env.S3_ACCESS_KEY_ID = "a";
    process.env.S3_SECRET_ACCESS_KEY = "b";
    process.env.S3_BUCKET = "atlas-corpus";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_x";
    process.env.CLERK_SECRET_KEY = "sk_test_x";
    process.env.CLERK_WEBHOOK_SIGNING_SECRET = "whsec_x";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    process.env.LANGFUSE_HOST = "http://localhost:3030";
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    const { env } = await import("@/lib/env");
    expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined();
  });
});
