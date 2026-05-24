import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { RunStatusPill, type RunStatus } from "@/components/runs/run-status-pill";
import { RunStepList } from "@/components/runs/run-step-list";
import { PlanApprovalCard } from "@/components/runs/plan-approval-card";
import { PapersApprovalCard } from "@/components/runs/papers-approval-card";
import { StrandedCheckpointCard } from "@/components/runs/stranded-checkpoint-card";
import { DraftView } from "@/components/runs/draft-view";
import { RefreshTick } from "@/components/runs/refresh-tick";
import { CritiquePanel } from "@/components/runs/CritiquePanel";
import {
  CitationFaithfulnessWidget,
  type ClaimCheckRow,
} from "@/components/runs/CitationFaithfulnessWidget";

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id: projectId, runId } = await params;
  const user = await requireUser();

  const run = await db.run.findUnique({
    where: { id: runId },
    include: {
      project: { select: { ownerId: true, title: true, question: true } },
      steps: { orderBy: { startedAt: "asc" } },
      // Fetch BOTH pending checkpoints (for the approve/reject cards) AND
      // any checkpoint with a still-set waitToken (for the "stranded"
      // recovery affordance). The waitToken column is read server-side
      // only — it never crosses the client boundary; we derive an
      // `awaitingDelivery` boolean instead.
      checkpoints: { orderBy: { createdAt: "asc" } },
      claimChecks: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!run || run.project.ownerId !== user.id) notFound();

  const pendingPlan = run.checkpoints.find(
    (c) => c.kind === "APPROVE_PLAN" && c.status === "PENDING",
  );
  const pendingPapers = run.checkpoints.find(
    (c) => c.kind === "APPROVE_PAPERS" && c.status === "PENDING",
  );

  // Derive the "stranded" set: decision committed but Phase 2 delivery
  // failed. Strip waitToken before any client-bound shape is built.
  const strandedCheckpoints = run.checkpoints
    .filter((c) => c.status !== "PENDING" && c.waitToken !== null)
    .map((c) => ({
      id: c.id,
      kind: c.kind,
      status: c.status,
      awaitingDelivery: true,
    }));

  return (
    <main id="main" className="max-w-5xl mx-auto px-6 py-10 space-y-8">
      <header className="space-y-2">
        <p className="text-xs text-muted-foreground">
          <a href={`/projects/${projectId}`} className="underline">{run.project.title}</a> / run
        </p>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">{run.question}</h1>
          <RunStatusPill status={run.status as RunStatus} />
        </div>
        {run.failureReason && <p className="text-destructive text-sm">{run.failureReason}</p>}
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Steps</h2>
        <RunStepList steps={run.steps as never} />
      </section>

      {pendingPlan && (
        <PlanApprovalCard
          runId={runId}
          checkpointId={pendingPlan.id}
          plan={(pendingPlan.proposal as { plan: never }).plan ?? (pendingPlan.proposal as never)}
        />
      )}

      {pendingPapers && (
        <PapersApprovalCard
          runId={runId}
          checkpointId={pendingPapers.id}
          proposed={(pendingPapers.proposal as { includedPapers: never }).includedPapers ?? []}
        />
      )}

      {strandedCheckpoints.length > 0 && (
        <section className="space-y-3">
          {strandedCheckpoints.map((cp) => (
            <StrandedCheckpointCard
              key={cp.id}
              runId={runId}
              checkpoint={cp}
            />
          ))}
        </section>
      )}

      {run.status === "COMPLETED" && (run.critiqueScore != null || run.faithfulnessScore != null) && (
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <CritiquePanel critiqueScore={run.critiqueScore} />
          <CitationFaithfulnessWidget
            faithfulnessScore={run.faithfulnessScore}
            claimChecks={(run.claimChecks ?? []) as ClaimCheckRow[]}
          />
        </section>
      )}

      {run.draft && <DraftView draft={run.draft} />}

      <RefreshTick run={run} />
    </main>
  );
}
