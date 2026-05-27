import { z } from "zod";
import {
  listReviewsTool, listReviewsInput, listReviewsOutput,
} from "@/lib/mcp/tools/list-reviews";
import {
  getReviewDraftTool, getReviewDraftInput, getReviewDraftOutput,
} from "@/lib/mcp/tools/get-review-draft";
import {
  getCitationAuditTool, getCitationAuditInput, getCitationAuditOutput,
} from "@/lib/mcp/tools/get-citation-audit";
import {
  listDiscoveredPapersTool, listDiscoveredPapersInput, listDiscoveredPapersOutput,
} from "@/lib/mcp/tools/list-discovered-papers";
import {
  getSearchQueriesTool, getSearchQueriesInput, getSearchQueriesOutput,
} from "@/lib/mcp/tools/get-search-queries";
import type { McpUserCtx } from "@/lib/mcp/auth";

/**
 * MCP ToolAnnotations (spec 2025-11-25). These are behaviour hints clients
 * (Claude.ai, ChatGPT, etc.) use to decide whether a tool call should be
 * auto-approved. Mirrors `ToolAnnotations` from `@modelcontextprotocol/sdk`
 * — kept as a local type so this module does not have a hard dependency on
 * the SDK shape.
 */
export type McpToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

type RegisteredTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  annotations: McpToolAnnotations;
  handler: (input: unknown, ctx: McpUserCtx) => Promise<unknown>;
};

/**
 * Read-only annotation preset used by every tool in Thoth's current MCP
 * surface: each tool only reads owned rows out of Postgres. No mutation,
 * no external network calls, calling twice has the same observable
 * effect as calling once.
 */
const READ_ONLY_ANNOTATIONS: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * Each tool's `description` is the field the LLM reads when deciding
 * whether to call it. Always declare the side-effect class in plain
 * English at the start of the description.
 */
export const MCP_TOOLS: RegisteredTool[] = [
  {
    name: "list_reviews",
    title: "List my Thoth reviews",
    description: "Read-only. Lists every Thoth systematic-literature-review run you own, with status, critic score, faithfulness score, and claim/citation counts.",
    inputSchema: listReviewsInput.shape,
    annotations: READ_ONLY_ANNOTATIONS,
    handler: listReviewsTool,
  },
  {
    name: "get_review_draft",
    title: "Get the markdown draft of a review",
    description: "Read-only. Returns the full markdown draft of a completed Thoth review, plus its critic and faithfulness scores. 404 for unowned reviews.",
    inputSchema: getReviewDraftInput.shape,
    annotations: READ_ONLY_ANNOTATIONS,
    handler: getReviewDraftTool,
  },
  {
    name: "get_citation_audit",
    title: "Get the cite_check audit for a review",
    description: "Read-only. Returns Thoth's per-claim cite_check verdict (supported/unsupported/unclear) for every cited claim in a completed review, plus aggregate counts and the run's overall faithfulness score. 404 for unowned reviews.",
    inputSchema: getCitationAuditInput.shape,
    annotations: READ_ONLY_ANNOTATIONS,
    handler: getCitationAuditTool,
  },
  {
    name: "list_discovered_papers",
    title: "List discovered papers (v2 outbound search)",
    description: "Read-only. For outbound/hybrid v2 reviews, returns every paper the discoverer surfaced (across OpenAlex / arXiv / Exa), each with its initial relevance score, whether the fetcher acquired the PDF, and the screener's include/exclude verdict. Empty list for uploaded_only reviews. 404 for unowned reviews.",
    inputSchema: listDiscoveredPapersInput.shape,
    annotations: READ_ONLY_ANNOTATIONS,
    handler: listDiscoveredPapersTool,
  },
  {
    name: "get_search_queries",
    title: "Get the search queries Thoth ran (v2 outbound search)",
    description: "Read-only. For outbound/hybrid v2 reviews, returns the natural-language search queries the discoverer LLM generated from the research question, the provider set the run targeted, and any per-provider error messages. Empty queries for uploaded_only reviews. 404 for unowned reviews.",
    inputSchema: getSearchQueriesInput.shape,
    annotations: READ_ONLY_ANNOTATIONS,
    handler: getSearchQueriesTool,
  },
];

// Re-export for downstream type imports
export {
  listReviewsInput, listReviewsOutput,
  getReviewDraftInput, getReviewDraftOutput,
  getCitationAuditInput, getCitationAuditOutput,
  listDiscoveredPapersInput, listDiscoveredPapersOutput,
  getSearchQueriesInput, getSearchQueriesOutput,
};
