import { z } from "zod";
import { db } from "@/lib/db";
import { mcpTool } from "@/lib/mcp/handler";
import type { McpUserCtx } from "@/lib/mcp/auth";

export const listReviewsInput = z.object({});

export const listReviewsOutput = z.object({
  reviews: z.array(z.object({
    id: z.string(),
    projectId: z.string(),
    projectName: z.string(),
    researchQuestion: z.string(),
    status: z.string(),     // RunStatus enum — kept as string for forward-compat as Atlas adds new states (current: PENDING|PLANNING|AWAITING_PLAN_APPROVAL|RETRIEVING|AWAITING_PAPERS_APPROVAL|ASSESSING|DRAFTING|COMPLETED|REJECTED|FAILED)
    createdAt: z.string(),
    completedAt: z.string().nullable(),
    critiqueScore: z.number().nullable(),
    faithfulnessScore: z.number().nullable(),
    claimCount: z.number().int(),
    citationCount: z.number().int(),
  })),
});

export async function listReviews(
  _input: z.infer<typeof listReviewsInput>,
  ctx: McpUserCtx,
): Promise<z.infer<typeof listReviewsOutput>> {
  const runs = await db.run.findMany({
    where: { project: { ownerId: ctx.userId } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, projectId: true, status: true, question: true,
      createdAt: true, completedAt: true,
      critiqueScore: true, faithfulnessScore: true,
      project: { select: { id: true, title: true } },
      _count: { select: { claims: true, claimChecks: true } },
    },
  });

  return {
    reviews: runs.map(r => ({
      id: r.id,
      projectId: r.projectId,
      projectName: r.project.title,
      researchQuestion: r.question,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      critiqueScore: r.critiqueScore,
      faithfulnessScore: r.faithfulnessScore,
      claimCount: r._count.claims,
      citationCount: r._count.claimChecks,
    })),
  };
}

export const listReviewsTool = mcpTool({
  name: "list_reviews",
  inputSchema: listReviewsInput,
  outputSchema: listReviewsOutput,
  handler: listReviews,
});
