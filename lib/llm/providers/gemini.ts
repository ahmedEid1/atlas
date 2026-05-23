import { google } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

/**
 * Wraps @ai-sdk/google's factory. Reads GOOGLE_GENERATIVE_AI_API_KEY at call time.
 * Throws via the underlying SDK if the key is missing AND a live call happens.
 */
export function geminiModel(modelId: string): LanguageModel {
  return google(modelId);
}
