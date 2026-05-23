import type { LanguageModel } from "ai";
import { geminiModel } from "./gemini";
import { anthropicModel } from "./anthropic";
import { openaiModel } from "./openai";
import { groqModel } from "./groq";
import { mistralModel } from "./mistral";
import type { ProviderName } from "@/lib/llm/tiers";

export type ModelFactory = (modelId: string) => LanguageModel;

const ADAPTERS: Record<ProviderName, ModelFactory> = {
  gemini: geminiModel,
  anthropic: anthropicModel,
  openai: openaiModel,
  groq: groqModel,
  // claude-agent does NOT go through the Vercel AI SDK LanguageModel path;
  // lib/llm.ts short-circuits to the Agent SDK adapter before resolveProvider
  // is called. This stub exists only to satisfy the Record<ProviderName, ...>
  // type; reaching it would indicate a bug in the bypass branch.
  "claude-agent": () => {
    throw new Error(
      "claude-agent provider is handled by the bypass branch in lib/llm.ts and should not be resolved here",
    );
  },
  mistral: mistralModel,
};

export function resolveProvider(name: ProviderName): ModelFactory {
  const factory = ADAPTERS[name];
  if (!factory) throw new Error(`Unknown LLM provider: ${name}`);
  return factory;
}
