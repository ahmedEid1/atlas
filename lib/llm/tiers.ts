export type Tier = "smart" | "fast";
export type ProviderName = "gemini" | "anthropic" | "openai" | "groq";

const MODELS: Record<ProviderName, Record<Tier, string>> = {
  gemini: {
    // smart and fast both use Flash on Gemini: gemini-2.5-pro is paywalled (not on free tier)
    // and Atlas's $0 budget requires the free tier. Other providers keep the smart/fast split.
    smart: "gemini-2.5-flash",
    fast: "gemini-2.5-flash",
  },
  anthropic: {
    smart: "claude-opus-4-7",
    fast: "claude-sonnet-4-6",
  },
  openai: {
    smart: "gpt-4o",
    fast: "gpt-4o-mini",
  },
  groq: {
    smart: "llama-3.3-70b-versatile",
    fast: "llama-3.1-8b-instant",
  },
};

export function resolveTier(provider: ProviderName, tier: Tier): string {
  const tierMap = MODELS[provider];
  if (!tierMap) throw new Error(`Unknown LLM provider: ${provider}`);
  const model = tierMap[tier];
  if (!model) throw new Error(`Unknown tier "${tier}" for provider "${provider}"`);
  return model;
}
