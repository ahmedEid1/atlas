import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/mcp/audit", () => ({ logMcpCall: vi.fn() }));
vi.mock("@/lib/mcp/rate-limit", () => ({ checkRateLimit: vi.fn() }));

import { logMcpCall } from "@/lib/mcp/audit";
import { checkRateLimit } from "@/lib/mcp/rate-limit";
import { mcpTool, classifyError } from "@/lib/mcp/handler";

beforeEach(() => vi.clearAllMocks());

const echoInput = z.object({ msg: z.string() });
const echoOutput = z.object({ echoed: z.string() });

describe("mcpTool wrapper", () => {
  it("runs the handler on valid input, logs OK, returns MCP content", async () => {
    (checkRateLimit as any).mockResolvedValue({ ok: true });
    const tool = mcpTool({
      name: "echo",
      inputSchema: echoInput,
      outputSchema: echoOutput,
      handler: async (input) => ({ echoed: input.msg }),
    });
    const res = await tool({ msg: "hi" }, { userId: "u1", clerkId: "c1" });
    expect(res.content[0]!.type).toBe("text");
    expect(JSON.parse(res.content[0]!.text)).toEqual({ echoed: "hi" });
    expect(logMcpCall).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "echo", status: "OK", userId: "u1",
    }));
  });

  it("returns rate_limited error without invoking handler", async () => {
    (checkRateLimit as any).mockResolvedValue({
      ok: false, retryAfter: 60, errorCode: "rate_limited",
    });
    const handlerFn = vi.fn();
    const tool = mcpTool({
      name: "echo", inputSchema: echoInput, outputSchema: echoOutput,
      handler: handlerFn,
    });
    const res = await tool({ msg: "hi" }, { userId: "u1", clerkId: "c1" });
    expect(handlerFn).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("rate_limited");
    expect(logMcpCall).toHaveBeenCalledWith(expect.objectContaining({
      status: "ERROR", errorCode: "rate_limited",
    }));
  });

  it("returns invalid_input on Zod failure", async () => {
    (checkRateLimit as any).mockResolvedValue({ ok: true });
    const tool = mcpTool({
      name: "echo", inputSchema: echoInput, outputSchema: echoOutput,
      handler: async () => ({ echoed: "x" }),
    });
    const res = await tool({ msg: 42 } as any, { userId: "u1", clerkId: "c1" });
    expect(res.isError).toBe(true);
    expect(logMcpCall).toHaveBeenCalledWith(expect.objectContaining({
      status: "ERROR", errorCode: "invalid_input",
    }));
  });

  it("returns generic internal on unknown error (does not leak message)", async () => {
    (checkRateLimit as any).mockResolvedValue({ ok: true });
    const tool = mcpTool({
      name: "echo", inputSchema: echoInput, outputSchema: echoOutput,
      handler: async () => { throw new Error("secret stack trace contents"); },
    });
    const res = await tool({ msg: "hi" }, { userId: "u1", clerkId: "c1" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).not.toContain("secret stack trace contents");
    expect(res.content[0]!.text).toContain("internal");
    expect(logMcpCall).toHaveBeenCalledWith(expect.objectContaining({
      status: "ERROR", errorCode: "internal",
    }));
  });

  it("returns not_found when handler throws an Error with name=NotFoundError", async () => {
    (checkRateLimit as any).mockResolvedValue({ ok: true });
    const tool = mcpTool({
      name: "get", inputSchema: echoInput, outputSchema: echoOutput,
      handler: async () => {
        const e = new Error("nope"); e.name = "NotFoundError"; throw e;
      },
    });
    const res = await tool({ msg: "x" }, { userId: "u1", clerkId: "c1" });
    expect(res.isError).toBe(true);
    expect(logMcpCall).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "not_found",
    }));
  });
});

describe("classifyError", () => {
  it("classifies ZodError as invalid_input", () => {
    const e = new Error("validation");
    e.name = "ZodError";
    expect(classifyError(e)).toBe("invalid_input");
  });
  it("classifies NotFoundError as not_found", () => {
    const e = new Error("not found");
    e.name = "NotFoundError";
    expect(classifyError(e)).toBe("not_found");
  });
  it("classifies unknown errors as internal", () => {
    expect(classifyError(new Error("boom"))).toBe("internal");
  });
});
