import { describe, it, expect } from "vitest";
import { resolveTier, type Tier, type ProviderName } from "@/lib/llm/tiers";

describe("resolveTier", () => {
  const cases: Array<[ProviderName, Tier, string]> = [
    ["gemini", "smart", "gemini-2.5-flash"],
    ["gemini", "fast", "gemini-2.5-flash"],
    ["anthropic", "smart", "claude-opus-4-7"],
    ["anthropic", "fast", "claude-sonnet-4-6"],
    ["openai", "smart", "gpt-4o"],
    ["openai", "fast", "gpt-4o-mini"],
    ["groq", "smart", "llama-3.3-70b-versatile"],
    ["groq", "fast", "llama-3.1-8b-instant"],
  ];

  for (const [provider, tier, expected] of cases) {
    it(`maps ${provider}/${tier} → ${expected}`, () => {
      expect(resolveTier(provider, tier)).toBe(expected);
    });
  }

  it("throws on unknown tier", () => {
    // @ts-expect-error — invalid tier on purpose
    expect(() => resolveTier("gemini", "unknown")).toThrow(/Unknown tier/);
  });

  it("throws on unknown provider", () => {
    // @ts-expect-error — invalid provider on purpose
    expect(() => resolveTier("bogus", "smart")).toThrow(/Unknown LLM provider/);
  });
});
