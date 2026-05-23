import { generateObject, type ModelMessage } from "ai";
import type { AttributeValue } from "@opentelemetry/api";
import { z } from "zod";
import { env } from "@/lib/env";
import { resolveProvider } from "@/lib/llm/providers";
import { resolveTier, type Tier, type ProviderName } from "@/lib/llm/tiers";

export type RunLLMArgs<T> = {
  /** Span name shown in Langfuse — used to group traces ("summarize-paper", "planner", etc.) */
  name: string;
  /** Quality tier — maps to a per-provider model id via lib/llm/tiers. */
  tier: Tier;
  /** Max output tokens. */
  maxTokens: number;
  /** System prompt (single string — provider-neutral). */
  system: string;
  /** Conversation messages. */
  messages: ModelMessage[];
  /** Zod schema for structured output. */
  schema: z.ZodType<T>;
  /** Trace metadata (runId, projectId, userId, etc.). */
  metadata?: Record<string, unknown>;
};

export type RunLLMResult<T> = {
  output: T;
  /** Trace URL is now constructed via Langfuse OTel exporter — populated by instrumentation. */
  traceUrl: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** Cache read tokens, when the provider reports them. 0 otherwise. */
    cacheReadInputTokens: number;
  };
};

/**
 * The single LLM call surface for the whole codebase.
 *
 * Resolves {provider, tier} -> concrete ai-SDK LanguageModel via the provider
 * registry, calls generateObject with the caller's Zod schema, attaches
 * experimental_telemetry so the Langfuse OTel exporter captures the span,
 * and returns a uniform RunLLMResult regardless of provider.
 */
export async function runLLM<T>(args: RunLLMArgs<T>): Promise<RunLLMResult<T>> {
  const providerName = env.LLM_PROVIDER as ProviderName;
  const factory = resolveProvider(providerName);
  const model = factory(resolveTier(providerName, args.tier));

  const meta = args.metadata ?? {};
  const runId = typeof meta.runId === "string" ? meta.runId : undefined;
  // OTel AttributeValue only accepts string|number|boolean (+ arrays of those).
  // We pass through string/number/boolean values from caller metadata and skip
  // anything else so the exporter doesn't reject the span.
  const telemetryMeta: Record<string, AttributeValue> = {
    tags: [args.tier, providerName],
  };
  for (const [k, v] of Object.entries(meta)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      telemetryMeta[k] = v;
    }
  }
  if (runId !== undefined) telemetryMeta.sessionId = runId;

  const { object, usage } = await generateObject({
    model,
    output: "object",
    schema: args.schema as z.ZodType<Record<string, unknown>>,
    system: args.system,
    messages: args.messages,
    maxOutputTokens: args.maxTokens,
    experimental_telemetry: {
      isEnabled: true,
      functionId: args.name,
      metadata: telemetryMeta,
    },
  });

  return {
    output: object as T,
    // Trace URL is recorded on the OTel span; left empty here. Consumers that
    // need a URL can construct one from env.LANGFUSE_HOST + the captured span ID
    // in a future iteration. Empty string is intentional placeholder.
    traceUrl: "",
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      cacheReadInputTokens: 0,
    },
  };
}
