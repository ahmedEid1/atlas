export type Tier = "smart" | "fast";
export type ProviderName = "gemini" | "anthropic" | "openai" | "groq" | "claude-agent" | "mistral";

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
    // GPT-5.5 is current flagship (released 2026-04-24); 5.4-mini is the cost-effective workhorse.
    smart: "gpt-5.5",
    fast: "gpt-5.4-mini",
  },
  groq: {
    // gpt-oss-* are the only Groq models with strict json_schema support
    // (required by generateObject's Zod validation). 120b hits Groq's
    // 8K TPM on multi-paper questions; 20b has higher TPM and handles
    // Atlas's schemas reliably. Both free tier.
    smart: "openai/gpt-oss-20b",
    fast: "openai/gpt-oss-20b",
  },
  "claude-agent": {
    // Agent SDK uses Claude Code's configured model (typically Sonnet 4.6).
    // Tier label is informational; the SDK doesn't take a model param.
    smart: "sonnet-via-claude-code",
    fast: "sonnet-via-claude-code",
  },
  mistral: {
    // Free Experiment tier covers both; mistral-large for quality,
    // mistral-small for fast/cheap retriever batch scoring.
    smart: "mistral-large-latest",
    fast: "mistral-small-latest",
  },
};

export function resolveTier(provider: ProviderName, tier: Tier): string {
  const tierMap = MODELS[provider];
  if (!tierMap) throw new Error(`Unknown LLM provider: ${provider}`);
  const model = tierMap[tier];
  if (!model) throw new Error(`Unknown tier "${tier}" for provider "${provider}"`);
  return model;
}
