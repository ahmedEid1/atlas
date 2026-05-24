import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// `dotenv`'s `config()` is replaced so the test doesn't read the real `.env`
// on the developer's machine. The mock returns whatever `parsedFixture`
// currently holds.
const parsedFixture: { current: Record<string, string> | null; error: Error | null } = {
  current: null,
  error: null,
};

vi.mock("dotenv", () => ({
  config: vi.fn(() => {
    if (parsedFixture.error) return { error: parsedFixture.error };
    return { parsed: parsedFixture.current ?? {} };
  }),
}));

const ORIGINAL_FLAG = process.env.TRIGGER_DEPLOY_CONFIRM;

beforeEach(() => {
  delete process.env.TRIGGER_DEPLOY_CONFIRM;
  parsedFixture.current = null;
  parsedFixture.error = null;
  // Silence the [trigger.config] log line so test output stays clean.
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.TRIGGER_DEPLOY_CONFIRM;
  else process.env.TRIGGER_DEPLOY_CONFIRM = ORIGINAL_FLAG;
  vi.restoreAllMocks();
});

describe("trigger.config loadSyncEnv", () => {
  it("returns [] when TRIGGER_DEPLOY_CONFIRM is unset (disabled by default)", async () => {
    parsedFixture.current = {
      DATABASE_URL: "postgres://prod",
      ANTHROPIC_API_KEY: "sk-prod",
    };

    const { loadSyncEnv } = await import("@/trigger.config");
    const out = await loadSyncEnv();

    expect(out).toEqual([]);
  });

  it("returns [] when armed but .env is missing (dotenv error)", async () => {
    process.env.TRIGGER_DEPLOY_CONFIRM = "1";
    parsedFixture.error = new Error("ENOENT");

    const { loadSyncEnv } = await import("@/trigger.config");
    const out = await loadSyncEnv();

    expect(out).toEqual([]);
  });

  it("returns only allowlisted keys when armed; drops unknown keys and CLI creds", async () => {
    process.env.TRIGGER_DEPLOY_CONFIRM = "1";
    parsedFixture.current = {
      // allowed
      DATABASE_URL: "postgres://prod",
      S3_ACCESS_KEY_ID: "AKIA...",
      ANTHROPIC_API_KEY: "sk-ant",
      LANGFUSE_PUBLIC_KEY: "pk-lf",
      CLERK_SECRET_KEY: "sk-clerk",
      // NOT allowed: CLI-only creds must never sync
      TRIGGER_PROJECT_REF: "proj_abc",
      TRIGGER_SECRET_KEY: "tr_secret",
      // NOT allowed: random local scratch values
      MY_LOCAL_DEBUG_FLAG: "1",
      SOME_PERSONAL_TOKEN: "xyz",
      LLM_PROVIDER: "groq", // intentionally excluded per allowlist rationale
      // Empty string — should be skipped even though key is allowed
      OPENAI_API_KEY: "",
    };

    const { loadSyncEnv, ALLOWED_PROD_KEYS } = await import("@/trigger.config");
    const out = await loadSyncEnv();

    const names = out.map((e) => e.name).sort();
    expect(names).toEqual(
      ["ANTHROPIC_API_KEY", "CLERK_SECRET_KEY", "DATABASE_URL", "LANGFUSE_PUBLIC_KEY", "S3_ACCESS_KEY_ID"].sort(),
    );

    // None of the non-allowed keys leaked.
    for (const name of names) {
      expect(ALLOWED_PROD_KEYS).toContain(name);
    }
    expect(names).not.toContain("TRIGGER_PROJECT_REF");
    expect(names).not.toContain("TRIGGER_SECRET_KEY");
    expect(names).not.toContain("MY_LOCAL_DEBUG_FLAG");
    expect(names).not.toContain("LLM_PROVIDER");
    expect(names).not.toContain("OPENAI_API_KEY");

    // Values pass through unchanged.
    const dbEntry = out.find((e) => e.name === "DATABASE_URL");
    expect(dbEntry?.value).toBe("postgres://prod");
  });

  it("logs sync mode + key count on every invocation", async () => {
    const logSpy = vi.spyOn(console, "log");

    // disabled
    await (await import("@/trigger.config")).loadSyncEnv();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("disabled"));

    // armed
    process.env.TRIGGER_DEPLOY_CONFIRM = "1";
    parsedFixture.current = { DATABASE_URL: "postgres://prod" };
    await (await import("@/trigger.config")).loadSyncEnv();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("armed"));
  });
});
