import type { LanguageModel } from "ai";
import { geminiModel } from "./gemini";
import { anthropicModel } from "./anthropic";
import { openaiModel } from "./openai";
import { groqModel } from "./groq";
import type { ProviderName } from "@/lib/llm/tiers";

export type ModelFactory = (modelId: string) => LanguageModel;

const ADAPTERS: Record<ProviderName, ModelFactory> = {
  gemini: geminiModel,
  anthropic: anthropicModel,
  openai: openaiModel,
  groq: groqModel,
};

export function resolveProvider(name: ProviderName): ModelFactory {
  const factory = ADAPTERS[name];
  if (!factory) throw new Error(`Unknown LLM provider: ${name}`);
  return factory;
}
