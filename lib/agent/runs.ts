import { db } from "@/lib/db";
import type { Prisma } from "@/app/generated/prisma/client";
import type { IncludedPaperSpec, ClaimSpec } from "@/lib/agent/state";

export async function createRun(args: { projectId: string; question: string }): Promise<{ id: string }> {
  return db.run.create({
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
    | "FAILED";
  triggerRunId?: string;
}): Promise<void> {
  await db.run.update({
    where: { id: args.runId },
    data: { status: args.status, ...(args.triggerRunId ? { triggerRunId: args.triggerRunId } : {}) },
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

export async function recordCheckpoint(args: {
  runId: string;
  kind: "APPROVE_PLAN" | "APPROVE_PAPERS";
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

export async function resolveCheckpoint(args: {
  checkpointId: string;
  status: "APPROVED" | "REJECTED";
  decisionPayload?: Prisma.InputJsonValue;
  rejectionReason?: string;
}): Promise<{ waitToken: string | null }> {
  return db.humanCheckpoint.update({
    where: { id: args.checkpointId },
    data: {
      status: args.status,
      decisionPayload: args.decisionPayload,
      rejectionReason: args.rejectionReason ?? null,
      decidedAt: new Date(),
    },
    select: { waitToken: true },
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
