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
