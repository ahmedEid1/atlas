import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Download the cite_check audit for a completed Run as JSON.
 *
 * Mirrors the `get_citation_audit` MCP tool's response shape — a user
 * who doesn't have an MCP client can still pull the structured audit
 * (per-claim supported/unsupported/unclear verdicts + counts + the
 * run's faithfulness score) for downstream analysis in a spreadsheet
 * or a custom script.
 *
 * Returns 404 for "no such run", "not yours", or "no draft yet" — same
 * existence-probe defense as the rest of the API. The route requires
 * `run.draft` because cite_check only runs once the drafter completes;
 * a still-in-flight run has no audit to return.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  const run = await db.run.findUnique({
    where: { id },
    select: {
      id: true,
      draft: true,
      faithfulnessScore: true,
      project: { select: { ownerId: true } },
    },
  });
  if (!run || run.project.ownerId !== user.id || !run.draft) {
    return new NextResponse("Not found", { status: 404 });
  }

  const claimChecks = await db.claimCheck.findMany({
    where: { runId: id },
    select: { claim: true, paperId: true, verdict: true, reason: true, paperExcerpt: true },
    orderBy: { createdAt: "asc" },
  });

  const VERDICT_MAP: Record<string, "supported" | "unsupported" | "unclear"> = {
    SUPPORTED: "supported",
    UNSUPPORTED: "unsupported",
    UNCLEAR: "unclear",
  };

  const claims = claimChecks.map((c) => ({
    claimText: c.claim,
    citedPaperId: c.paperId,
    verdict: VERDICT_MAP[c.verdict] ?? "unclear",
    reason: c.reason,
    supportingSpan: c.paperExcerpt,
  }));

  const audit = {
    reviewId: run.id,
    faithfulnessScore: run.faithfulnessScore,
    totalClaims: claims.length,
    supportedCount: claims.filter((c) => c.verdict === "supported").length,
    unsupportedCount: claims.filter((c) => c.verdict === "unsupported").length,
    unclearCount: claims.filter((c) => c.verdict === "unclear").length,
    claims,
  };

  return new NextResponse(JSON.stringify(audit, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="thoth-${id}-audit.json"`,
      "cache-control": "no-store",
    },
  });
}
