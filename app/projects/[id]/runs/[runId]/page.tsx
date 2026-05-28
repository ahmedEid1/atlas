import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Per-run tab title. Joins the project title + run status so the
 * browser tab tells the user at a glance which run is in which state
 * across multiple open tabs ("GAT review — completed", "GAT review —
 * awaiting plan review"). Falls back to a generic copy when the run is
 * missing / not owned — same existence-probe posture as the page
 * handler (which renders notFound()).
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ runId: string }>;
}): Promise<Metadata> {
  const { runId } = await params;
  const user = await requireUser().catch(() => null);
  if (!user) return { title: "Review run" };
  const run = await db.run.findUnique({
    where: { id: runId },
    select: { status: true, project: { select: { title: true, ownerId: true } } },
  });
  if (!run || run.project.ownerId !== user.id) return { title: "Run not found" };
  const status = run.status.toLowerCase().replace(/_/g, " ");
  return { title: `${run.project.title} — ${status}` };
}
import { RunStatusPill, type RunStatus } from "@/components/runs/run-status-pill";
import { RunStepList, nodeLabel } from "@/components/runs/run-step-list";
import { DeleteRunButton } from "@/components/runs/delete-run-button";
import { PlanApprovalCard } from "@/components/runs/plan-approval-card";
import { PapersApprovalCard } from "@/components/runs/papers-approval-card";
import { DiscoveryApprovalCard } from "@/components/runs/discovery-approval-card";
import { DiscoverySummary } from "@/components/runs/discovery-summary";
import { StrandedCheckpointCard } from "@/components/runs/stranded-checkpoint-card";
import { DraftView } from "@/components/runs/draft-view";
import { RefreshTick } from "@/components/runs/refresh-tick";
import { TokenSpendBadge } from "@/components/runs/token-spend-badge";
import { env } from "@/lib/env";
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
      project: {
        select: {
          ownerId: true, title: true, question: true,
          searchScope: true, searchProviders: true,
        },
      },
      steps: { orderBy: { startedAt: "asc" } },
      // Fetch BOTH pending checkpoints (for the approve/reject cards) AND
      // any checkpoint with a still-set waitToken (for the "stranded"
      // recovery affordance). The waitToken column is read server-side
      // only — it never crosses the client boundary; we derive an
      // `awaitingDelivery` boolean instead.
      checkpoints: { orderBy: { createdAt: "asc" } },
      claimChecks: { orderBy: { createdAt: "asc" } },
      // V2 — discovered papers + screening decisions, joined so we can
      // render the live discovery summary alongside the steps panel.
      // Empty array for uploaded_only runs.
      discoveredPapers: {
        include: { screening: true },
        orderBy: { initialScore: "desc" },
      },
    },
  });
  if (!run || run.project.ownerId !== user.id) notFound();

  const isOutbound =
    run.project.searchScope === "outbound" ||
    run.project.searchScope === "hybrid";

  // Queries live in the APPROVE_DISCOVERY checkpoint's proposal — pull
  // them out so the discovery summary can render them even after the
  // checkpoint is decided. Same source of truth as get_search_queries.
  const discoveryCheckpoint = run.checkpoints.find((c) => c.kind === "APPROVE_DISCOVERY");
  const discoveryQueries: string[] = (() => {
    const proposal = discoveryCheckpoint?.proposal as { queries?: unknown } | null;
    if (proposal && Array.isArray(proposal.queries)) {
      return (proposal.queries as unknown[]).filter((q): q is string => typeof q === "string");
    }
    return [];
  })();

  // Provider errors from the discoverer's RunStep.failureReason. The node
  // writes a "partial: <provider>: <msg>" line per failed provider.
  const providerErrors = run.steps
    .filter((s) => s.nodeName === "discoverer" && s.failureReason)
    .map((s) => ({
      nodeName: s.nodeName,
      failureReason: s.failureReason as string,
    }));

  const pendingPlan = run.checkpoints.find(
    (c) => c.kind === "APPROVE_PLAN" && c.status === "PENDING",
  );
  const pendingDiscovery = run.checkpoints.find(
    (c) => c.kind === "APPROVE_DISCOVERY" && c.status === "PENDING",
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
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h1 className="text-2xl font-semibold">{run.question}</h1>
          <div className="flex items-center gap-2">
            {isOutbound && (
              <span
                className="text-[10px] font-medium uppercase tracking-wider text-[var(--thoth-blue)] bg-[var(--thoth-blue-mist)]/50 px-1.5 py-0.5 rounded"
                title={`Outbound search · providers: ${run.project.searchProviders.join(", ") || "none"}`}
              >
                {run.project.searchScope === "hybrid" ? "hybrid" : "outbound"}
              </span>
            )}
            {run.steps.length > 0 && (
              <TokenSpendBadge steps={run.steps} budget={env.MAX_TOKENS_PER_RUN} />
            )}
            <RunStatusPill status={run.status as RunStatus} />
            <DeleteRunButton
              runId={runId}
              runLabel={new Date(run.createdAt).toLocaleString()}
              variant="page"
              redirectTo={`/projects/${projectId}`}
            />
          </div>
        </div>
        {run.failureReason && (
          <div className="rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
            <p className="font-medium text-destructive">{run.failureReason}</p>
            {(() => {
              // Surface which step blew up — the last step with a failureReason,
              // by startedAt. Per-item inner steps may also have a failureReason
              // but the *outer* terminal failure is what we want to spotlight.
              const failedStep = [...run.steps]
                .reverse()
                .find((s) => s.failureReason);
              if (!failedStep) return null;
              return (
                <p className="text-xs text-muted-foreground mt-1">
                  Failed during: <span className="font-medium">{nodeLabel(failedStep.nodeName)}</span>
                  {failedStep.failureReason &&
                  failedStep.failureReason !== run.failureReason ? (
                    <> — {failedStep.failureReason}</>
                  ) : null}
                </p>
              );
            })()}
          </div>
        )}
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Steps</h2>
        {/* eslint-disable-next-line react-hooks/purity -- wall-clock IS the
            source of truth for in-progress step durations; the page is a
            server component re-invoked per request (and via RefreshTick polling
            every 2s), so `nowMs` advances naturally on each render. */}
        <RunStepList steps={run.steps as never} nowMs={Date.now()} />
      </section>

      {isOutbound && (discoveryQueries.length > 0 || run.discoveredPapers.length > 0) && (
        <DiscoverySummary
          queries={discoveryQueries}
          discoveredPapers={run.discoveredPapers.map((p) => ({
            id: p.id,
            provider: p.provider,
            externalId: p.externalId,
            title: p.title,
            authors: p.authors,
            publicationYear: p.publicationYear,
            initialScore: p.initialScore,
            corpusItemId: p.corpusItemId,
            oaUrl: p.oaUrl,
            screening: p.screening
              ? {
                  include: p.screening.include,
                  relevanceScore: p.screening.relevanceScore,
                  reason: p.screening.reason,
                }
              : null,
          }))}
          providerErrors={providerErrors}
        />
      )}

      {pendingPlan && (
        <PlanApprovalCard
          runId={runId}
          checkpointId={pendingPlan.id}
          plan={(pendingPlan.proposal as { plan: never }).plan ?? (pendingPlan.proposal as never)}
        />
      )}

      {pendingDiscovery && (
        <DiscoveryApprovalCard
          runId={runId}
          checkpointId={pendingDiscovery.id}
          queries={(pendingDiscovery.proposal as { queries: string[] }).queries ?? []}
          hits={
            (
              pendingDiscovery.proposal as {
                discoveredPapers: Array<{
                  id: string;
                  externalId: string;
                  provider: string;
                  title: string;
                  abstract: string | null;
                  accessStatus: string;
                }>;
              }
            ).discoveredPapers ?? []
          }
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
            runId={runId}
          />
        </section>
      )}

      {run.draft && <DraftView draft={run.draft} runId={runId} />}

      <RefreshTick run={run} />
    </main>
  );
}
