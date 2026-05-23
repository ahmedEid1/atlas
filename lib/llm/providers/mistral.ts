import { mistral } from "@ai-sdk/mistral";
import type { LanguageModel } from "ai";

/** Wraps @ai-sdk/mistral's factory. Reads MISTRAL_API_KEY at call time. */
export function mistralModel(modelId: string): LanguageModel {
  return mistral(modelId);
}
