import { db } from "@/lib/db";
import type { Prisma } from "@/app/generated/prisma/client";
import type { IncludedPaperSpec, ClaimSpec } from "@/lib/agent/state";

/**
 * Create a new Run row in PENDING status.
 *
 * Contract: if `tx` is provided, the insert runs inside the caller's
 * transaction; otherwise it uses the global Prisma client. This mirrors
 * the `cloneReviewTemplate` pattern and lets the runs-start route hold
 * a project-scoped advisory lock across the active-run check + insert
 * (see app/api/projects/[id]/runs/route.ts).
 */
export async function createRun(
  args: { projectId: string; question: string },
  tx?: Prisma.TransactionClient,
): Promise<{ id: string }> {
  const client = tx ?? db;
  return client.run.create({
    data: { projectId: args.projectId, question: args.question, status: "PENDING" },
    select: { id: true },
  });
}

export async function setRunStatus(args: {
  runId: string;
  status:
    | "PENDING"
    | "PLANNING"
    | "AWAITING_PLAN_APPROVAL"
    | "RETRIEVING"
    | "AWAITING_PAPERS_APPROVAL"
    | "ASSESSING"
    | "DRAFTING"
    | "COMPLETED"
    | "REJECTED"
    | "FAILED"
    // V2 outbound-search statuses (lib/agent/graph.ts routes through these
    // when project.searchScope is outbound or hybrid).
    | "DISCOVERING"
    | "AWAITING_DISCOVERY_APPROVAL"
    | "FETCHING"
    | "SCREENING";
  triggerRunId?: string;
  // Optional human-readable reason for REJECTED / FAILED transitions, surfaced
  // on the run-detail page next to the status pill so users (and operators)
  // see why a run ended without having to dig through RunStep rows.
  failureReason?: string;
}): Promise<void> {
  await db.run.update({
    where: { id: args.runId },
    data: {
      status: args.status,
      ...(args.triggerRunId ? { triggerRunId: args.triggerRunId } : {}),
      ...(args.failureReason !== undefined ? { failureReason: args.failureReason.slice(0, 1000) } : {}),
    },
  });
}

export async function addStep(args: { runId: string; nodeName: string }): Promise<{ id: string }> {
  return db.runStep.create({
    data: { runId: args.runId, nodeName: args.nodeName },
    select: { id: true },
  });
}

export async function finishStep(args: {
  stepId: string;
  traceUrl?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  failureReason?: string;
}): Promise<void> {
  await db.runStep.update({
    where: { id: args.stepId },
    data: {
      endedAt: new Date(),
      traceUrl: args.traceUrl ?? null,
      inputTokens: args.inputTokens ?? 0,
      outputTokens: args.outputTokens ?? 0,
      cacheReadInputTokens: args.cacheReadInputTokens ?? 0,
      failureReason: args.failureReason ?? null,
    },
  });
}

export async function findCorpusMarkdown(corpusItemId: string): Promise<string | null> {
  const ci = await db.corpusItem.findUnique({
    where: { id: corpusItemId },
    select: { status: true, parsedMarkdown: true },
  });
  if (!ci || ci.status !== "PARSED") return null;
  return ci.parsedMarkdown;
}

/**
 * Returns the structured paper summary text used by cite_check to verify claims.
 * Reads `summary.abstract` from the M2 summarisation output if available;
 * falls back to the first 2000 chars of parsedMarkdown.
 */
export async function findCorpusSummary(corpusItemId: string): Promise<string | null> {
  const ci = await db.corpusItem.findUnique({
    where: { id: corpusItemId },
    select: { summary: true, parsedMarkdown: true, status: true },
  });
  if (!ci) return null;
  if (ci.summary && typeof ci.summary === "object" && "abstract" in ci.summary) {
    const s = ci.summary as { abstract: string; keyFindings?: string[]; methodology?: string };
    const parts = [
      `Abstract: ${s.abstract}`,
      s.methodology ? `Methodology: ${s.methodology}` : null,
      s.keyFindings && s.keyFindings.length > 0 ? `Key findings:\n- ${s.keyFindings.join("\n- ")}` : null,
    ].filter((p): p is string => p !== null);
    return parts.join("\n\n");
  }
  if (ci.status === "PARSED" && ci.parsedMarkdown) {
    return ci.parsedMarkdown.slice(0, 2000);
  }
  return null;
}

export async function recordCheckpoint(args: {
  runId: string;
  kind: "APPROVE_PLAN" | "APPROVE_PAPERS" | "APPROVE_DISCOVERY";
  proposal: Prisma.InputJsonValue;
  waitToken: string;
}): Promise<{ id: string }> {
  return db.humanCheckpoint.create({
    data: {
      runId: args.runId,
      kind: args.kind,
      proposal: args.proposal,
      waitToken: args.waitToken,
      status: "PENDING",
    },
    select: { id: true },
  });
}

export async function persistIncludedPapers(args: {
  runId: string;
  included: IncludedPaperSpec[];
}): Promise<void> {
  if (args.included.length === 0) return;
  await db.includedPaper.createMany({
    data: args.included.map((p) => ({
      runId: args.runId,
      corpusItemId: p.corpusItemId,
      relevanceScore: p.relevanceScore,
      inclusionReason: p.inclusionReason,
    })),
    skipDuplicates: true,
  });
}

export async function persistClaims(args: { runId: string; claims: ClaimSpec[] }): Promise<void> {
  if (args.claims.length === 0) return;
  // includedPaperId in state is the corpusItemId — resolve to the IncludedPaper row id here.
  const included = await db.includedPaper.findMany({
    where: { runId: args.runId },
    select: { id: true, corpusItemId: true },
  });
  const idByCorpus = new Map(included.map((i) => [i.corpusItemId, i.id]));
  const rows = args.claims
    .map((c) => {
      const inclId = idByCorpus.get(c.includedPaperId);
      if (!inclId) return null;
      return {
        runId: args.runId,
        includedPaperId: inclId,
        text: c.text,
        category: c.category,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (rows.length === 0) return;
  await db.extractedClaim.createMany({ data: rows });
}

export async function finishRun(args: { runId: string; draft: string }): Promise<void> {
  await db.run.update({
    where: { id: args.runId },
    data: { status: "COMPLETED", draft: args.draft, completedAt: new Date() },
  });
}

export async function failRun(args: { runId: string; reason: string }): Promise<void> {
  await db.run.update({
    where: { id: args.runId },
    data: { status: "FAILED", failureReason: args.reason.slice(0, 1000) },
  });
}

export type CiteCheckPersistInput = {
  runId: string;
  perCitation: Array<{
    paperId: string;
    claim: string;
    verdict: "supported" | "unsupported" | "unclear";
    reason: string;
    paperExcerpt?: string;
  }>;
  aggregate: {
    totalCitations: number;
    supported: number;
    unsupported: number;
    unclear: number;
    faithfulnessScore: number;
  };
};

const VERDICT_DB_MAP = {
  supported: "SUPPORTED",
  unsupported: "UNSUPPORTED",
  unclear: "UNCLEAR",
} as const;

export async function persistCiteCheck(args: CiteCheckPersistInput): Promise<void> {
  if (args.perCitation.length > 0) {
    await db.claimCheck.createMany({
      data: args.perCitation.map((c) => ({
        runId: args.runId,
        paperId: c.paperId,
        claim: c.claim,
        verdict: VERDICT_DB_MAP[c.verdict],
        reason: c.reason,
        paperExcerpt: c.paperExcerpt ?? null,
      })),
    });
  }
  await db.run.update({
    where: { id: args.runId },
    data: { faithfulnessScore: args.aggregate.faithfulnessScore },
  });
}

export async function persistCritiqueScore(args: { runId: string; overallScore: number }): Promise<void> {
  await db.run.update({
    where: { id: args.runId },
    data: { critiqueScore: args.overallScore },
  });
}
