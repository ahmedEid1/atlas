import { z } from "zod";
import { db } from "@/lib/db";
import { mcpTool, NotFoundError } from "@/lib/mcp/handler";
import type { McpUserCtx } from "@/lib/mcp/auth";

export const getCitationAuditInput = z.object({
  reviewId: z.string().min(1),
});

export const getCitationAuditOutput = z.object({
  reviewId: z.string(),
  faithfulnessScore: z.number().nullable(),
  totalClaims: z.number().int(),
  supportedCount: z.number().int(),
  unsupportedCount: z.number().int(),
  unclearCount: z.number().int(),
  claims: z.array(z.object({
    claimText: z.string(),
    citedPaperId: z.string(),
    verdict: z.enum(["supported", "unsupported", "unclear"]),
    reason: z.string(),
    supportingSpan: z.string().nullable(),
  })),
});

const VERDICT_MAP: Record<string, "supported" | "unsupported" | "unclear"> = {
  SUPPORTED: "supported",
  UNSUPPORTED: "unsupported",
  UNCLEAR: "unclear",
};

export async function getCitationAudit(
  input: z.infer<typeof getCitationAuditInput>,
  ctx: McpUserCtx,
): Promise<z.infer<typeof getCitationAuditOutput>> {
  const run = await db.run.findFirst({
    where: { id: input.reviewId, project: { ownerId: ctx.userId } },
    select: { id: true, faithfulnessScore: true },
  });
  if (!run) throw new NotFoundError("review_not_found");

  const rows = await db.claimCheck.findMany({
    where: { runId: input.reviewId },
    select: { paperId: true, claim: true, verdict: true, reason: true, paperExcerpt: true },
    orderBy: { createdAt: "asc" },
  });

  const claims = rows.map(r => ({
    claimText: r.claim,
    citedPaperId: r.paperId,
    verdict: VERDICT_MAP[r.verdict] ?? "unclear",
    reason: r.reason,
    supportingSpan: r.paperExcerpt,
  }));

  return {
    reviewId: run.id,
    faithfulnessScore: run.faithfulnessScore,
    totalClaims: claims.length,
    supportedCount: claims.filter(c => c.verdict === "supported").length,
    unsupportedCount: claims.filter(c => c.verdict === "unsupported").length,
    unclearCount: claims.filter(c => c.verdict === "unclear").length,
    claims,
  };
}

export const getCitationAuditTool = mcpTool({
  name: "get_citation_audit",
  inputSchema: getCitationAuditInput,
  outputSchema: getCitationAuditOutput,
  handler: getCitationAudit,
});
