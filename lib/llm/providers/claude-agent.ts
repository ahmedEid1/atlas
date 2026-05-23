import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * Calls Claude Agent SDK with a single-shot non-interactive prompt that asks
 * for strict JSON matching the given Zod schema. Used by lib/llm.ts's bypass
 * branch when env.LLM_PROVIDER === "claude-agent".
 *
 * Authentication: the SDK reads ANTHROPIC_API_KEY env var if set. If unset,
 * it falls back to the Claude Code CLI session auth on the same machine
 * (auto-detected). This lets users with a Claude Max subscription run evals
 * without paying for API tokens.
 */
export async function callClaudeAgent<T>(args: {
  system: string;
  userMessage: string;
  schema: z.ZodType<T>;
  schemaName: string;
}): Promise<T> {
  // Build a strict-JSON prompt. We tell the model to return ONLY JSON, no prose.
  // Use zod v4's built-in toJSONSchema so the model sees the real field
  // names, types, required-ness, and enum values rather than a placeholder.
  const jsonSchema = z.toJSONSchema(args.schema);
  const prompt = `${args.system}

${args.userMessage}

CRITICAL OUTPUT CONTRACT — read carefully:

You MUST respond with ONLY a single valid JSON object. No prose before or after. No markdown code fences. No explanatory text.

The JSON object MUST EXACTLY match this JSON Schema named "${args.schemaName}" — use the EXACT field names from the "properties" map below, in camelCase as shown. Do NOT invent new field names. Do NOT use snake_case substitutes (e.g., use "subQuestions" not "sub_questions" or "research_questions"). Do NOT add extra fields not in the schema. Every field listed under "required" MUST be present.

If the schema specifies an array of strings, return an array of plain strings (not objects). If the schema specifies an array of objects, follow each object's properties exactly.

JSON Schema:

${JSON.stringify(jsonSchema, null, 2)}

Now produce the JSON object that satisfies this schema:`;

  // No tools, single-turn, just text generation
  const session = query({
    prompt,
    options: { allowedTools: [], maxTurns: 1 },
  });

  let lastText = "";
  for await (const message of session) {
    if ("result" in message && typeof message.result === "string") {
      lastText = message.result;
    }
  }

  if (!lastText) {
    throw new Error("claude-agent: no result text returned from query()");
  }

  // Strip code fences if Agent SDK wraps in markdown (defensive — prompt says not to)
  const cleaned = lastText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(
      `claude-agent: response was not valid JSON. First 200 chars: ${cleaned.slice(0, 200)}`,
    );
  }

  return args.schema.parse(parsed);
}
