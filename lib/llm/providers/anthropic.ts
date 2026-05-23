import { anthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

/** Wraps @ai-sdk/anthropic's factory. Reads ANTHROPIC_API_KEY at call time. */
export function anthropicModel(modelId: string): LanguageModel {
  return anthropic(modelId);
}
