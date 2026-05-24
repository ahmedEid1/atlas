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
  if (env.LLM_PROVIDER === "claude-agent") {
    const { callClaudeAgent } = await import("@/lib/llm/providers/claude-agent");
    const userMessage = args.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n\n");
    const output = await callClaudeAgent({
      system: args.system,
      userMessage,
      schema: args.schema,
      schemaName: args.name,
    });
    // The Claude Agent SDK routes through the Claude Code CLI session
    // and does NOT surface per-call token usage. Without estimates here,
    // `lib/agent/cost-cap.ts`'s per-run budget cap (which sums
    // RunStep.{input,output}Tokens via Prisma aggregate) silently
    // no-ops for the whole claude-agent code path — a runaway loop on
    // a Claude Max session could blow far past MAX_TOKENS_PER_RUN
    // without tripping anything.
    //
    // Fix: estimate via the standard ~4-chars-per-token heuristic for
    // English text. We round UP so the cap engages slightly earlier
    // than reality rather than later. This isn't billing accuracy —
    // it's a budget guardrail, and a conservative estimate is the
    // right side to err on.
    const estimateTokens = (s: string) => Math.ceil(s.length / 4);
    const inputTokens = estimateTokens(args.system) + estimateTokens(userMessage);
    const outputTokens = estimateTokens(JSON.stringify(output));
    return {
      output,
      traceUrl: "",
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheReadInputTokens: 0,
      },
    };
  }

  const primaryProvider = env.LLM_PROVIDER as ProviderName;
  const fallbackProvider = env.LLM_FALLBACK_PROVIDER as ProviderName | undefined;

  const meta = args.metadata ?? {};
  const runId = typeof meta.runId === "string" ? meta.runId : undefined;

  // Helper: build the OTel telemetry metadata. We rebuild per attempt so
  // the `tags` array reflects which provider actually served the call.
  const buildTelemetry = (provider: ProviderName): Record<string, AttributeValue> => {
    // OTel AttributeValue only accepts string|number|boolean (+ arrays of those).
    const telemetryMeta: Record<string, AttributeValue> = {
      tags: [args.tier, provider],
    };
    for (const [k, v] of Object.entries(meta)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        telemetryMeta[k] = v;
      }
    }
    if (runId !== undefined) telemetryMeta.sessionId = runId;
    return telemetryMeta;
  };

  const callProvider = async (provider: ProviderName) => {
    const factory = resolveProvider(provider);
    const model = factory(resolveTier(provider, args.tier));
    return generateObject({
      model,
      output: "object",
      schema: args.schema as z.ZodType<Record<string, unknown>>,
      system: args.system,
      messages: args.messages,
      maxOutputTokens: args.maxTokens,
      // Default in @ai-sdk is 2 retries (3 attempts). Bumped to 4 retries (5
      // attempts) so Mistral's free Experiment tier (~1 RPS, occasionally
      // bursty rate-limiting on cite_check loops) gets more exponential
      // backoff before bubbling up to the eval harness as a hard failure.
      maxRetries: 4,
      experimental_telemetry: {
        isEnabled: true,
        functionId: args.name,
        metadata: buildTelemetry(provider),
      },
      providerOptions: {
        google: {
          // vercel/ai#12187: Gemini Flash often returns non-JSON without this hint
          structuredOutputs: true,
        },
      },
    });
  };

  // Try the primary provider. On failure, fall back ONCE to
  // env.LLM_FALLBACK_PROVIDER if it's set, distinct, and not
  // "claude-agent" (which has its own code path above and isn't a
  // sensible fallback for an HTTP-provider failure). One retry — not a
  // loop — so a hard outage surfaces to the caller instead of looping
  // forever between two dead providers.
  let object: Awaited<ReturnType<typeof callProvider>>["object"];
  let usage: Awaited<ReturnType<typeof callProvider>>["usage"];
  try {
    ({ object, usage } = await callProvider(primaryProvider));
  } catch (err) {
    const canFallback =
      fallbackProvider !== undefined &&
      fallbackProvider !== primaryProvider &&
      fallbackProvider !== "claude-agent";
    if (!canFallback) throw err;
    console.warn(
      `[runLLM] primary provider "${primaryProvider}" failed for "${args.name}"; ` +
        `falling back to "${fallbackProvider}". Reason: ${err instanceof Error ? err.message : String(err)}`,
    );
    ({ object, usage } = await callProvider(fallbackProvider));
  }

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
