import { describe, it, expect } from "vitest";
import { MCP_TOOLS } from "@/lib/mcp/tools";

/**
 * Per MCP spec 2025-11-25, clients (Claude.ai, ChatGPT, Cursor, etc.) use
 * ToolAnnotations to decide auto-approval and UX presentation. Every
 * currently-shipped Thoth tool is strictly read-only (reads owned rows
 * from Postgres) so all four hints have known values. This test is
 * parametrised over the live tools array so adding a new tool without
 * annotations — or shipping a write tool with the wrong hints — fails CI.
 */
describe("MCP_TOOLS annotations", () => {
  it("registers the v1 + v2 read-only tools", () => {
    expect(MCP_TOOLS.length).toBeGreaterThanOrEqual(5);
    const names = MCP_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(expect.arrayContaining([
      "get_citation_audit",
      "get_review_draft",
      "get_search_queries",
      "list_discovered_papers",
      "list_reviews",
    ]));
  });

  for (const tool of MCP_TOOLS) {
    describe(`tool: ${tool.name}`, () => {
      it("has a non-empty annotations object", () => {
        expect(tool.annotations).toBeDefined();
        expect(typeof tool.annotations).toBe("object");
      });

      it("declares readOnlyHint=true (every current tool is read-only)", () => {
        expect(tool.annotations.readOnlyHint).toBe(true);
      });

      it("declares destructiveHint=false", () => {
        expect(tool.annotations.destructiveHint).toBe(false);
      });

      it("declares idempotentHint=true", () => {
        expect(tool.annotations.idempotentHint).toBe(true);
      });

      it("declares openWorldHint=false (closed world: owned DB rows only)", () => {
        expect(tool.annotations.openWorldHint).toBe(false);
      });
    });
  }
});
