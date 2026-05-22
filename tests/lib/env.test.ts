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

    await expect(import("@/lib/env")).rejects.toThrow(/DATABASE_URL/);
  });
});
