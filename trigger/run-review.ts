import { schemaTask, logger, metadata, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import { Command } from "@langchain/langgraph";
import { buildGraph } from "@/lib/agent/graph";
import {
  setRunStatus,
  recordCheckpoint,
  persistIncludedPapers,
  persistClaims,
  persistCritiqueScore,
  finishRun,
  failRun,
} from "@/lib/agent/runs";
import { BudgetExceededError } from "@/lib/agent/cost-cap";
import { db } from "@/lib/db";

type InterruptValue =
  | { kind: "APPROVE_PLAN"; plan: unknown }
  | {
      kind: "APPROVE_PAPERS";
      includedPapers: Array<{
        corpusItemId: string;
        relevanceScore: number;
        inclusionReason: string;
      }>;
    }
  | {
      kind: "APPROVE_DISCOVERY";
      queries: string[];
      discoveredPapers: Array<{
        id: string;
        externalId: string;
        provider: string;
        title: string;
        abstract: string | null;
        accessStatus: string;
      }>;
    };

type GraphResult = {
  __interrupt__?: Array<{ value: InterruptValue }>;
  draft?: string | null;
  claims?: Array<{
    includedPaperId: string;
    text: string;
    category: "finding" | "methodology" | "limitation" | "context";
  }>;
  planApproved?: { approved: boolean; rejectionReason?: string } | null;
  papersApproved?: { approved: boolean; rejectionReason?: string } | null;
  critique?: { overallScore?: number | null } | null;
  [k: string]: unknown;
};

export const runReviewTask = schemaTask({
  id: "run-review",
  schema: z.object({ runId: z.string() }),
  retry: { maxAttempts: 1 },
  machine: { preset: "small-2x" },
  maxDuration: 86400, // up to a day — runs can wait on HITL for a long time
  run: async ({ runId }) => {
    metadata.set("runId", runId);

    let lastState: GraphResult = {};

    try {
      // Hydrate initial agent state from DB
      const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
      const project = await db.project.findUnique({
        where: { id: (run as { projectId: string }).projectId },
        select: {
          question: true,
          // V2 search-scope configuration; defaults preserve V1 behaviour
          // for every existing project (per the migration default).
          searchScope: true,
          searchProviders: true,
          searchMaxHits: true,
          searchYearStart: true,
          searchYearEnd: true,
          skipDiscoveryGate: true,
        },
      });
      if (!project) throw new Error(`Project for run ${runId} not found`);

      const corpus = await db.corpusItem.findMany({
        where: { projectId: (run as { projectId: string }).projectId, status: "PARSED" },
        select: { id: true, source: true, summary: true, status: true },
      });

      const initial = {
        runId,
        projectId: (run as { projectId: string }).projectId,
        question: (run as { question: string }).question,
        candidateCorpusItems: corpus.map((c) => ({
          id: c.id,
          title: c.source.split("/").pop() ?? c.id,
          summary: c.summary as
            | { abstract: string; studyType: string; relevanceToSLR: string }
            | null,
        })),
        plan: null,
        planApproved: null,
        includedPapers: [],
        papersApproved: null,
        claims: [],
        draft: null,
        // V2 outbound search wiring. uploaded_only projects get the V1
        // path via the conditional edge in graph.ts; outbound / hybrid
        // route through discoverer → fetcher → screener instead.
        searchScope: project.searchScope,
        searchProviders: project.searchProviders.filter(
          (p): p is "openalex" | "arxiv" | "exa" =>
            p === "openalex" || p === "arxiv" || p === "exa",
        ),
        searchMaxHits: project.searchMaxHits,
        searchYearStart: project.searchYearStart,
        searchYearEnd: project.searchYearEnd,
        skipDiscoveryGate: project.skipDiscoveryGate,
        discoveryQueries: [],
        discoveredPapers: [],
        discoveryApproved: null,
        screeningDecisions: [],
      };

      const graph = await buildGraph();
      const config = { configurable: { thread_id: runId } };

      let payload: unknown = initial;

      // Bound the loop defensively against an infinite resume. A base
      // outbound run uses 4 segments (plan_gate, discovery_gate, papers_gate,
      // then the assessor→…→END invoke); uploaded_only uses 3. Each M113
      // re-discovery cycle the user triggers inserts ONE extra discovery_gate
      // segment, so the old cap of 6 silently capped re-runs at 2 (a 3rd left
      // the run paused → mis-reported FAILED). The cap can be generous because
      // every segment BLOCKS on a 24h human wait token — there is no machine
      // path that resumes without a deliberate human click, so this bounds
      // human patience, not runaway cost. 16 ≈ a dozen re-discovery rounds.
      const MAX_SEGMENTS = 16;
      // Phase-based status (not segment-index based). Re-discovery inserts
      // extra discovery_gate segments, so a raw `segment → status` mapping
      // would drift (a re-run segment would display "FETCHING"). Instead we
      // derive the status for the upcoming segment from the decision we just
      // resumed past — see nextPhaseStatus below. The first segment is always
      // planning.
      let phaseStatus: RunPhaseStatus = "PLANNING";
      for (let segment = 0; segment < MAX_SEGMENTS; segment++) {
        await setRunStatus({ runId, status: phaseStatus });
        lastState = (await graph.invoke(payload as never, config)) as GraphResult;

        const interrupts = lastState.__interrupt__;
        if (!interrupts || interrupts.length === 0) break; // graph completed

        const first = interrupts[0]!;
        const intr = first.value;

        // Create a wait token, persist a checkpoint that the UI can look up
        const token = await wait.createToken({ timeout: "24h" });
        await recordCheckpoint({
          runId,
          kind: intr.kind,
          proposal: intr as never,
          waitToken: token.id,
        });

        await setRunStatus({
          runId,
          status:
            intr.kind === "APPROVE_PLAN"
              ? "AWAITING_PLAN_APPROVAL"
              : intr.kind === "APPROVE_DISCOVERY"
                ? "AWAITING_DISCOVERY_APPROVAL"
                : "AWAITING_PAPERS_APPROVAL",
        });

        // Side-effect persistence: after the retriever segment, persist included papers
        if (intr.kind === "APPROVE_PAPERS") {
          await persistIncludedPapers({ runId, included: intr.includedPapers });
        }

        // Block until the UI calls the approve/reject endpoint with the token id.
        // .unwrap() returns just the decision payload (the data the approve API
        // sent); throws on timeout (24h) which propagates to the catch handler.
        // Without unwrap(), `decision` is { ok: boolean, output: T } and resuming
        // with that breaks the gate's expected shape — state.planApproved.approved
        // becomes undefined, routeAfterPlanGate returns END, graph skips retriever.
        let decision: {
          approved: boolean;
          rejectionReason?: string;
          editedPlan?: unknown;
          corpusItemIds?: string[];
          editedQueries?: string[];
        };
        try {
          decision = await wait
            .forToken<{
              approved: boolean;
              rejectionReason?: string;
              editedPlan?: unknown;
              corpusItemIds?: string[];
              editedQueries?: string[];
            }>(token)
            .unwrap();
        } catch (waitErr) {
          // forToken throws on the 24h timeout (the human never answered) or a
          // Trigger infra failure. Re-throw with a clear, actionable message so
          // the run's failureReason isn't an opaque SDK string — an operator
          // can immediately see the gate timed out rather than the agent
          // crashing. (The outer catch turns this into failRun.)
          const orig = waitErr instanceof Error ? waitErr.message : String(waitErr);
          throw new Error(
            `HITL ${intr.kind} was not answered within 24h (or token delivery failed) — run halted. [${orig}]`,
          );
        }

        payload = new Command({ resume: decision });
        // Derive the next segment's status from the decision we just made.
        phaseStatus = nextPhaseStatus(intr.kind, decision, project.searchScope);
      }

      // Persist claims and draft if the run reached the end
      const draft = lastState.draft;
      const claims = lastState.claims;
      const planApproved = lastState.planApproved;
      const papersApproved = lastState.papersApproved;
      const discoveryApproved = lastState.discoveryApproved as
        | { approved: boolean; rejectionReason?: string; editedQueries?: string[] }
        | null
        | undefined;

      if (planApproved && !planApproved.approved) {
        await setRunStatus({
          runId, status: "REJECTED",
          failureReason: planApproved.rejectionReason ?? "Plan rejected at HITL gate",
        });
        return { ok: true, status: "REJECTED" as const };
      }
      // V2 — outbound discovery rejection. Without this branch, a rejected
      // discovery_gate fell through to the "no draft → FAILED" path below,
      // mis-classifying user intent as agent failure. A re-run decision
      // (M113) also carries approved:false but with editedQueries — that is
      // NOT a rejection, so exclude it (only reachable if the segment cap is
      // exhausted mid-re-run; the run then falls through to FAILED, which is
      // the honest outcome for "user kept re-running past the safety bound").
      if (
        discoveryApproved &&
        !discoveryApproved.approved &&
        !(discoveryApproved.editedQueries && discoveryApproved.editedQueries.length > 0)
      ) {
        await setRunStatus({
          runId, status: "REJECTED",
          failureReason: discoveryApproved.rejectionReason ?? "Discovery rejected at HITL gate",
        });
        return { ok: true, status: "REJECTED" as const };
      }
      if (papersApproved && !papersApproved.approved) {
        await setRunStatus({
          runId, status: "REJECTED",
          failureReason: papersApproved.rejectionReason ?? "Papers rejected at HITL gate",
        });
        return { ok: true, status: "REJECTED" as const };
      }
      if (claims && claims.length > 0) await persistClaims({ runId, claims });
      if (lastState.critique?.overallScore != null) {
        await persistCritiqueScore({ runId, overallScore: lastState.critique.overallScore });
      }
      if (draft) {
        await finishRun({ runId, draft });
        return { ok: true, status: "COMPLETED" as const };
      }

      // Should not get here in a healthy run
      await setRunStatus({ runId, status: "FAILED" });
      return { ok: false, status: "FAILED" as const };
    } catch (err) {
      // Budget cap breach: record a budget-specific failureReason so the
      // dashboard distinguishes a runaway-cost shutdown from a generic error.
      if (err instanceof BudgetExceededError) {
        const reason = `Token budget exceeded: ${err.tokensUsed} > ${err.limit}`;
        logger.error("run-review halted: token budget exceeded", {
          runId: err.runId,
          tokensUsed: err.tokensUsed,
          limit: err.limit,
        });
        await failRun({ runId, reason });
        throw err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      logger.error("run-review failed", { reason, lastState });
      await failRun({ runId, reason });
      throw err;
    }
  },
});

type RunPhaseStatus =
  | "PLANNING"
  | "RETRIEVING"
  | "ASSESSING"
  | "DRAFTING"
  | "DISCOVERING"
  | "FETCHING";

/**
 * Map the HITL decision we just resumed past to the user-facing Run.status
 * that best describes the work the NEXT segment is about to do. Phase-based
 * (not segment-index based) so it stays correct under M113 re-discovery,
 * which inserts extra discovery_gate segments. V2 outbound/hybrid runs take a
 * different node chain than V1 uploaded_only, so the plan-approval branch
 * forks on searchScope. Without this, outbound runs displayed
 * Run.status="RETRIEVING" while the discoverer / fetcher / screener ran.
 *
 *   APPROVE_PLAN      → uploaded_only: RETRIEVING; outbound/hybrid: DISCOVERING
 *   APPROVE_DISCOVERY → re-run (editedQueries): DISCOVERING; else: FETCHING
 *   APPROVE_PAPERS    → ASSESSING (assessor→drafter→critic→cite_check run as
 *                       one uninterrupted segment)
 */
function nextPhaseStatus(
  kind: InterruptValue["kind"],
  decision: { editedQueries?: string[] },
  searchScope: "uploaded_only" | "outbound" | "hybrid",
): RunPhaseStatus {
  switch (kind) {
    case "APPROVE_PLAN":
      return searchScope === "uploaded_only" ? "RETRIEVING" : "DISCOVERING";
    case "APPROVE_DISCOVERY":
      // A re-run decision carries edited queries — the next segment re-runs
      // the discoverer, not the fetcher.
      return decision.editedQueries && decision.editedQueries.length > 0
        ? "DISCOVERING"
        : "FETCHING";
    case "APPROVE_PAPERS":
      return "ASSESSING";
  }
}
