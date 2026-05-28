import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// vi.hoisted lifts mock identifiers above vi.mock factories (TDZ workaround)
const mocks = vi.hoisted(() => {
  const generateObject = vi.fn();
  const geminiModel = vi.fn((id: string) => ({ kind: "gemini-model", id }));
  return { generateObject, geminiModel };
});

vi.mock("@/lib/env", () => ({
  env: {
    LLM_PROVIDER: "gemini",
    LLM_FALLBACK_PROVIDER: undefined,
    GOOGLE_GENERATIVE_AI_API_KEY: "test-gemini-key",
    LANGFUSE_PUBLIC_KEY: "pk-lf-test",
    LANGFUSE_SECRET_KEY: "sk-lf-test",
    LANGFUSE_HOST: "http://localhost:3030",
  },
}));

vi.mock("ai", () => ({ generateObject: mocks.generateObject }));

vi.mock("@/lib/llm/providers/gemini", () => ({ geminiModel: mocks.geminiModel }));

beforeEach(() => {
  mocks.generateObject.mockReset();
  mocks.geminiModel.mockClear();
});

describe("runLLM", () => {
  it("dispatches to gemini (default) and returns parsed output + usage", async () => {
    mocks.generateObject.mockResolvedValue({
      object: { answer: "42" },
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });

    const { runLLM } = await import("@/lib/llm");
    const result = await runLLM({
      name: "test-call",
      tier: "fast",
      maxTokens: 1024,
      system: "system prompt",
      messages: [{ role: "user", content: "ask" }],
      schema: z.object({ answer: z.string() }),
      metadata: { runId: "r1" },
    });

    expect(result.output).toEqual({ answer: "42" });
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.totalTokens).toBe(150);

    expect(mocks.geminiModel).toHaveBeenCalledWith("gemini-2.5-flash");
    expect(mocks.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { kind: "gemini-model", id: "gemini-2.5-flash" },
        system: "system prompt",
        messages: [{ role: "user", content: "ask" }],
        schema: expect.any(Object),
        experimental_telemetry: expect.objectContaining({
          isEnabled: true,
          functionId: "test-call",
          metadata: expect.objectContaining({
            tags: expect.arrayContaining(["fast", "gemini"]),
          }),
        }),
      }),
    );
  });

  it("rethrows on provider failure", async () => {
    mocks.generateObject.mockRejectedValue(new Error("gemini overloaded"));

    const { runLLM } = await import("@/lib/llm");
    await expect(
      runLLM({
        name: "test-call",
        tier: "fast",
        maxTokens: 1024,
        system: "system",
        messages: [{ role: "user", content: "ask" }],
        schema: z.object({ answer: z.string() }),
      }),
    ).rejects.toThrow(/gemini overloaded/);
  });

  it("includes runId/projectId/userId in telemetry metadata when provided", async () => {
    mocks.generateObject.mockResolvedValue({
      object: { answer: "ok" },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });

    const { runLLM } = await import("@/lib/llm");
    await runLLM({
      name: "test-call",
      tier: "smart",
      maxTokens: 100,
      system: "s",
      messages: [{ role: "user", content: "u" }],
      schema: z.object({ answer: z.string() }),
      metadata: { runId: "r1", projectId: "p1", userId: "u1" },
    });

    const callArgs = mocks.generateObject.mock.calls[0]?.[0];
    expect(callArgs?.experimental_telemetry?.metadata).toMatchObject({
      runId: "r1",
      projectId: "p1",
      userId: "u1",
      sessionId: "r1",
    });
  });

  it("passes maxOutputTokens to generateObject", async () => {
    mocks.generateObject.mockResolvedValue({
      object: { answer: "ok" },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });

    const { runLLM } = await import("@/lib/llm");
    await runLLM({
      name: "x",
      tier: "smart",
      maxTokens: 8192,
      system: "s",
      messages: [{ role: "user", content: "u" }],
      schema: z.object({ answer: z.string() }),
    });

    const callArgs = mocks.generateObject.mock.calls[0]?.[0];
    expect(callArgs?.maxOutputTokens).toBe(8192);
  });
});

// LLM_FALLBACK_PROVIDER: when set, runLLM retries ONCE on the fallback
// provider after the primary's generateObject throws.
describe("runLLM — provider fallback", () => {
  it("retries on the fallback when primary fails and returns its result", async () => {
    // Mock env to enable a fallback.
    const envMod = await import("@/lib/env");
    (envMod.env as { LLM_FALLBACK_PROVIDER: string | undefined }).LLM_FALLBACK_PROVIDER = "groq";
    vi.doMock("@/lib/llm/providers/groq", () => ({
      groqModel: vi.fn((id: string) => ({ kind: "groq-model", id })),
    }));

    // First call throws (primary), second call (fallback) succeeds.
    mocks.generateObject
      .mockRejectedValueOnce(new Error("primary 5xx"))
      .mockResolvedValueOnce({
        object: { answer: "from-fallback" },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });

    const { runLLM } = await import("@/lib/llm");
    const result = await runLLM({
      name: "test-call",
      tier: "fast",
      maxTokens: 1024,
      system: "s",
      messages: [{ role: "user", content: "u" }],
      schema: z.object({ answer: z.string() }),
    });

    expect(result.output).toEqual({ answer: "from-fallback" });
    expect(mocks.generateObject).toHaveBeenCalledTimes(2);
    // Fallback call's telemetry tags should reflect the actual provider used.
    const fallbackCallArgs = mocks.generateObject.mock.calls[1]?.[0];
    expect(fallbackCallArgs?.experimental_telemetry?.metadata?.tags).toContain("groq");

    // Clean up the env override
    (envMod.env as { LLM_FALLBACK_PROVIDER: string | undefined }).LLM_FALLBACK_PROVIDER = undefined;
  });

  it("does NOT retry when fallback equals primary (no infinite loop on dead provider)", async () => {
    const envMod = await import("@/lib/env");
    (envMod.env as { LLM_FALLBACK_PROVIDER: string | undefined }).LLM_FALLBACK_PROVIDER = "gemini"; // same as primary
    mocks.generateObject.mockRejectedValue(new Error("primary down"));

    const { runLLM } = await import("@/lib/llm");
    await expect(
      runLLM({
        name: "x",
        tier: "fast",
        maxTokens: 100,
        system: "s",
        messages: [{ role: "user", content: "u" }],
        schema: z.object({ answer: z.string() }),
      }),
    ).rejects.toThrow(/primary down/);
    expect(mocks.generateObject).toHaveBeenCalledTimes(1);

    (envMod.env as { LLM_FALLBACK_PROVIDER: string | undefined }).LLM_FALLBACK_PROVIDER = undefined;
  });

  it("rethrows immediately when no fallback is configured", async () => {
    mocks.generateObject.mockRejectedValue(new Error("alone in the dark"));

    const { runLLM } = await import("@/lib/llm");
    await expect(
      runLLM({
        name: "x",
        tier: "fast",
        maxTokens: 100,
        system: "s",
        messages: [{ role: "user", content: "u" }],
        schema: z.object({ answer: z.string() }),
      }),
    ).rejects.toThrow(/alone in the dark/);
    expect(mocks.generateObject).toHaveBeenCalledTimes(1);
  });
});

// NoObjectGeneratedError ("response did not match schema") is NOT covered by
// the AI SDK's maxRetries (that only retries transport/rate-limit failures).
// On Mistral's free tier a transient schema-miss on one of ~50 sequential
// screener calls would otherwise fail the whole outbound run. runLLM retries
// the SAME provider a bounded number of times on this specific error before
// falling back / rethrowing.
describe("runLLM — schema-mismatch (NoObjectGenerated) retry", () => {
  const schemaErr = () =>
    Object.assign(new Error("No object generated: response did not match schema."), {
      name: "AI_NoObjectGeneratedError",
    });

  it("retries the same provider on a schema mismatch and returns the recovered object (no fallback set)", async () => {
    mocks.generateObject
      .mockRejectedValueOnce(schemaErr())
      .mockResolvedValueOnce({
        object: { answer: "recovered" },
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      });

    const { runLLM } = await import("@/lib/llm");
    const result = await runLLM({
      name: "x",
      tier: "smart",
      maxTokens: 100,
      system: "s",
      messages: [{ role: "user", content: "u" }],
      schema: z.object({ answer: z.string() }),
    });

    expect(result.output).toEqual({ answer: "recovered" });
    // 1 failed attempt + 1 successful retry, both on the primary provider.
    expect(mocks.generateObject).toHaveBeenCalledTimes(2);
  });

  it("gives up (and rethrows) after bounded retries when the schema mismatch persists", async () => {
    mocks.generateObject.mockRejectedValue(schemaErr());

    const { runLLM } = await import("@/lib/llm");
    await expect(
      runLLM({
        name: "x",
        tier: "smart",
        maxTokens: 100,
        system: "s",
        messages: [{ role: "user", content: "u" }],
        schema: z.object({ answer: z.string() }),
      }),
    ).rejects.toThrow(/did not match schema/);
    // 1 initial + 2 retries = 3 attempts, then surfaces — not an infinite loop.
    expect(mocks.generateObject).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a non-schema (transport) error on the same provider", async () => {
    mocks.generateObject.mockRejectedValue(new Error("502 bad gateway"));

    const { runLLM } = await import("@/lib/llm");
    await expect(
      runLLM({
        name: "x",
        tier: "smart",
        maxTokens: 100,
        system: "s",
        messages: [{ role: "user", content: "u" }],
        schema: z.object({ answer: z.string() }),
      }),
    ).rejects.toThrow(/502 bad gateway/);
    // No same-provider retry for non-schema errors → exactly one attempt.
    expect(mocks.generateObject).toHaveBeenCalledTimes(1);
  });
});

// claude-agent has no per-call usage metric (CLI session). The cost-cap
// blind-spot fix estimates tokens from string lengths so the per-run
// budget cap in `lib/agent/cost-cap.ts` engages even on this provider.
describe("runLLM — claude-agent provider", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("estimates usage from input/output character length (no zero-usage no-op)", async () => {
    vi.doMock("@/lib/env", () => ({
      env: { LLM_PROVIDER: "claude-agent" },
    }));
    vi.doMock("@/lib/llm/providers/claude-agent", () => ({
      callClaudeAgent: vi.fn().mockResolvedValue({ answer: "twenty-four characters!!" }),
    }));

    const { runLLM } = await import("@/lib/llm");
    const result = await runLLM({
      name: "agent-call",
      tier: "smart",
      maxTokens: 2048,
      system: "0123456789".repeat(10), // 100 chars
      messages: [{ role: "user", content: "0123456789".repeat(20) }], // 200 chars
      schema: z.object({ answer: z.string() }),
    });

    expect(result.output).toEqual({ answer: "twenty-four characters!!" });
    // 100/4 + 200/4 = 25 + 50 = 75 input tokens
    expect(result.usage.inputTokens).toBe(75);
    // JSON.stringify of {answer: "twenty-four characters!!"} is 38 chars → ceil(38/4)=10
    expect(result.usage.outputTokens).toBeGreaterThanOrEqual(8);
    expect(result.usage.totalTokens).toBe(result.usage.inputTokens + result.usage.outputTokens);
    // Critically: NOT zero (the bug being fixed)
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });
});
