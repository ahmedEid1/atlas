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
        select: { question: true },
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
      };

      const graph = await buildGraph();
      const config = { configurable: { thread_id: runId } };

      let payload: unknown = initial;

      // Bound the loop — at most 6 segments (defensive vs infinite resume).
      for (let segment = 0; segment < 6; segment++) {
        await setRunStatus({ runId, status: segmentStatus(segment) });
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
        const decision = await wait
          .forToken<{ approved: boolean; rejectionReason?: string; editedPlan?: unknown; corpusItemIds?: string[] }>(token)
          .unwrap();

        payload = new Command({ resume: decision });
      }

      // Persist claims and draft if the run reached the end
      const draft = lastState.draft;
      const claims = lastState.claims;
      const planApproved = lastState.planApproved;
      const papersApproved = lastState.papersApproved;

      if (planApproved && !planApproved.approved) {
        await setRunStatus({ runId, status: "REJECTED" });
        return { ok: true, status: "REJECTED" as const };
      }
      if (papersApproved && !papersApproved.approved) {
        await setRunStatus({ runId, status: "REJECTED" });
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
      const reason = err instanceof Error ? err.message : String(err);
      logger.error("run-review failed", { reason, lastState });
      await failRun({ runId, reason });
      throw err;
    }
  },
});

function segmentStatus(
  segment: number,
): "PLANNING" | "RETRIEVING" | "ASSESSING" | "DRAFTING" {
  switch (segment) {
    case 0:
      return "PLANNING";
    case 1:
      return "RETRIEVING";
    case 2:
      return "ASSESSING";
    case 3:
      return "DRAFTING";
    default:
      return "DRAFTING";
  }
}
