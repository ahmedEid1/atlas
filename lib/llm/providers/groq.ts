import { groq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";

/** Wraps @ai-sdk/groq's factory. Reads GROQ_API_KEY at call time. */
export function groqModel(modelId: string): LanguageModel {
  return groq(modelId);
}
