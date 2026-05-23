export type Tier = "smart" | "fast";
export type ProviderName = "gemini" | "anthropic" | "openai" | "groq";

const MODELS: Record<ProviderName, Record<Tier, string>> = {
  gemini: {
    smart: "gemini-2.5-pro",
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

export function resolveTier(tier: Tier, provider: ProviderName): string {
  const tierMap = MODELS[provider];
  if (!tierMap) throw new Error(`Unknown LLM provider: ${provider}`);
  const model = tierMap[tier];
  if (!model) throw new Error(`Unknown tier "${tier}" for provider "${provider}"`);
  return model;
}
