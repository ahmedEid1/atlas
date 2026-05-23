import { z } from "zod";
import { db } from "@/lib/db";
import { mcpTool, NotFoundError } from "@/lib/mcp/handler";
import type { McpUserCtx } from "@/lib/mcp/auth";

export const getReviewDraftInput = z.object({
  reviewId: z.string().min(1),
});

export const getReviewDraftOutput = z.object({
  reviewId: z.string(),
  researchQuestion: z.string(),
  status: z.string(),
  draftMarkdown: z.string(),
  critiqueScore: z.number().nullable(),
  faithfulnessScore: z.number().nullable(),
  criticIterations: z.number().int(),
  generatedAt: z.string(),
});

export async function getReviewDraft(
  input: z.infer<typeof getReviewDraftInput>,
  ctx: McpUserCtx,
): Promise<z.infer<typeof getReviewDraftOutput>> {
  const run = await db.run.findFirst({
    where: { id: input.reviewId, project: { ownerId: ctx.userId } },
    select: {
      id: true, question: true, status: true, draft: true,
      critiqueScore: true, faithfulnessScore: true, completedAt: true,
      project: { select: { ownerId: true } },
    },
  });

  // 404 for: nonexistent, not-owned, or owned-but-no-draft.
  if (!run || !run.draft || !run.completedAt) {
    throw new NotFoundError("review_draft_not_found");
  }

  const criticIterations = await db.runStep.count({
    where: { runId: input.reviewId, nodeName: "critic" },
  });

  return {
    reviewId: run.id,
    researchQuestion: run.question,
    status: run.status,
    draftMarkdown: run.draft,
    critiqueScore: run.critiqueScore,
    faithfulnessScore: run.faithfulnessScore,
    criticIterations,
    generatedAt: run.completedAt.toISOString(),
  };
}

export const getReviewDraftTool = mcpTool({
  name: "get_review_draft",
  inputSchema: getReviewDraftInput,
  outputSchema: getReviewDraftOutput,
  handler: getReviewDraft,
});
