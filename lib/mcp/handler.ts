import type { ZodSchema } from "zod";
import { logMcpCall } from "@/lib/mcp/audit";
import { checkRateLimit } from "@/lib/mcp/rate-limit";
import type { McpUserCtx } from "@/lib/mcp/auth";

export type ErrorCode = "invalid_input" | "not_found" | "rate_limited" | "internal";

export class NotFoundError extends Error {
  constructor(message = "not_found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export function classifyError(err: unknown): ErrorCode {
  if (err instanceof Error) {
    if (err.name === "ZodError") return "invalid_input";
    if (err.name === "NotFoundError") return "not_found";
  }
  return "internal";
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type McpToolOpts<I, O> = {
  name: string;
  inputSchema: ZodSchema<I>;
  outputSchema: ZodSchema<O>;
  handler: (input: I, ctx: McpUserCtx) => Promise<O>;
};

/**
 * Wraps a tool handler with: rate limit → input validation → run →
 * output validation → audit log. Errors are classified and returned as
 * isError content (never thrown), so mcp-handler renders them as MCP
 * tool errors rather than transport-level failures.
 *
 * Internal-error messages are deliberately generic so we don't leak
 * stack contents to MCP clients.
 */
export function mcpTool<I, O>(opts: McpToolOpts<I, O>) {
  return async (rawInput: unknown, ctx: McpUserCtx): Promise<ToolResult> => {
    const start = Date.now();
    let status: "OK" | "ERROR" = "OK";
    let errorCode: ErrorCode | undefined;
    let result: ToolResult;

    const limit = await checkRateLimit(ctx.userId, opts.name);
    if (!limit.ok) {
      status = "ERROR";
      errorCode = "rate_limited";
      result = {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({
          error: "rate_limited",
          retryAfter: limit.retryAfter,
        }) }],
      };
    } else {
      try {
        const input = opts.inputSchema.parse(rawInput);
        const output = await opts.handler(input, ctx);
        const validated = opts.outputSchema.parse(output);
        result = { content: [{ type: "text", text: JSON.stringify(validated) }] };
      } catch (err) {
        status = "ERROR";
        errorCode = classifyError(err);
        const safeMessage = errorCode === "internal"
          ? "internal error — contact support with the request id"
          : errorCode;
        result = { isError: true, content: [{ type: "text", text: JSON.stringify({ error: safeMessage }) }] };
      }
    }

    await logMcpCall({
      userId: ctx.userId, toolName: opts.name, input: rawInput,
      status, errorCode, latencyMs: Date.now() - start,
    });
    return result;
  };
}
