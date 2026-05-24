import { createHash } from "node:crypto";
import { db } from "@/lib/db";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJson((value as any)[k])).join(",") + "}";
}

export function hashInput(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function extractReviewId(input: unknown): string | null {
  if (input && typeof input === "object" && "reviewId" in input) {
    const v = (input as { reviewId: unknown }).reviewId;
    if (typeof v === "string") return v;
  }
  return null;
}

export type McpCallLogArgs = {
  id?: string;
  userId: string;
  toolName: string;
  input: unknown;
  status: "OK" | "ERROR";
  errorCode?: string;
  latencyMs: number;
};

/**
 * Write a McpCall audit row. Never throws — audit-write failure is
 * captured as a console.error and silently swallowed, because failing
 * the user's request just to record an audit row is the wrong tradeoff.
 *
 * If we add Langfuse spans to MCP calls later, log-failure should emit
 * a span there (see spec §3.3 invariant 3).
 */
export async function logMcpCall(args: McpCallLogArgs): Promise<void> {
  try {
    await db.mcpCall.create({
      data: {
        ...(args.id !== undefined ? { id: args.id } : {}),
        userId: args.userId,
        toolName: args.toolName,
        inputHash: hashInput(args.input),
        reviewId: extractReviewId(args.input),
        status: args.status,
        errorCode: args.errorCode ?? null,
        latencyMs: args.latencyMs,
      },
    });
  } catch (err) {
    console.error("[mcp] audit log write failed:", err);
  }
}
