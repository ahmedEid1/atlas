import { describe, it, expect, vi } from "vitest";

// Mock each adapter to return an identifiable token (so we can prove which one was picked).
vi.mock("@/lib/llm/providers/gemini", () => ({
  geminiModel: vi.fn((id: string) => ({ kind: "gemini", id })),
}));
vi.mock("@/lib/llm/providers/anthropic", () => ({
  anthropicModel: vi.fn((id: string) => ({ kind: "anthropic", id })),
}));
vi.mock("@/lib/llm/providers/openai", () => ({
  openaiModel: vi.fn((id: string) => ({ kind: "openai", id })),
}));
vi.mock("@/lib/llm/providers/groq", () => ({
  groqModel: vi.fn((id: string) => ({ kind: "groq", id })),
}));

describe("resolveProvider", () => {
  it("returns the gemini adapter for 'gemini'", async () => {
    const { resolveProvider } = await import("@/lib/llm/providers");
    const factory = resolveProvider("gemini");
    expect(factory("gemini-2.5-flash")).toEqual({ kind: "gemini", id: "gemini-2.5-flash" });
  });

  it("returns the anthropic adapter for 'anthropic'", async () => {
    const { resolveProvider } = await import("@/lib/llm/providers");
    const factory = resolveProvider("anthropic");
    expect(factory("claude-opus-4-7")).toEqual({ kind: "anthropic", id: "claude-opus-4-7" });
  });

  it("returns the openai adapter for 'openai'", async () => {
    const { resolveProvider } = await import("@/lib/llm/providers");
    const factory = resolveProvider("openai");
    expect(factory("gpt-4o")).toEqual({ kind: "openai", id: "gpt-4o" });
  });

  it("returns the groq adapter for 'groq'", async () => {
    const { resolveProvider } = await import("@/lib/llm/providers");
    const factory = resolveProvider("groq");
    expect(factory("llama-3.3-70b-versatile")).toEqual({ kind: "groq", id: "llama-3.3-70b-versatile" });
  });

  it("throws on an unknown provider name", async () => {
    const { resolveProvider } = await import("@/lib/llm/providers");
    // @ts-expect-error — invalid provider name on purpose
    expect(() => resolveProvider("ollama")).toThrow(/Unknown LLM provider/);
  });
});
