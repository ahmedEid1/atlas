import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/** Wraps @ai-sdk/openai's factory. Reads OPENAI_API_KEY at call time. */
export function openaiModel(modelId: string): LanguageModel {
  return openai(modelId);
}
