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
import type { McpUserCtx } from "@/lib/mcp/auth";

type RegisteredTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  handler: (input: unknown, ctx: McpUserCtx) => Promise<unknown>;
};

/**
 * Each tool's `description` is the field the LLM reads when deciding
 * whether to call it. Always declare the side-effect class in plain
 * English at the start of the description.
 */
export const MCP_TOOLS: RegisteredTool[] = [
  {
    name: "list_reviews",
    title: "List my Atlas reviews",
    description: "Read-only. Lists every Atlas systematic-literature-review run you own, with status, critic score, faithfulness score, and claim/citation counts.",
    inputSchema: listReviewsInput.shape,
    handler: listReviewsTool,
  },
  {
    name: "get_review_draft",
    title: "Get the markdown draft of a review",
    description: "Read-only. Returns the full markdown draft of a completed Atlas review, plus its critic and faithfulness scores. 404 for unowned reviews.",
    inputSchema: getReviewDraftInput.shape,
    handler: getReviewDraftTool,
  },
  {
    name: "get_citation_audit",
    title: "Get the cite_check audit for a review",
    description: "Read-only. Returns Atlas's per-claim cite_check verdict (supported/unsupported/unclear) for every cited claim in a completed review, plus aggregate counts and the run's overall faithfulness score. 404 for unowned reviews.",
    inputSchema: getCitationAuditInput.shape,
    handler: getCitationAuditTool,
  },
];

// Re-export for downstream type imports
export {
  listReviewsInput, listReviewsOutput,
  getReviewDraftInput, getReviewDraftOutput,
  getCitationAuditInput, getCitationAuditOutput,
};
