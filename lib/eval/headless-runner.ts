import { Command } from "@langchain/langgraph";
import { buildGraph } from "@/lib/agent/graph";
import type { AgentState } from "@/lib/agent/state";
import { db } from "@/lib/db";

export type HeadlessRunArgs = {
  runId: string;
  projectId: string;
  question: string;
  corpusItemIds: string[];
};

export type HeadlessRunResult = AgentState & {
  /** Number of graph.invoke() calls that happened (1 + number of interrupt resumes) */
  segments: number;
};

const MAX_SEGMENTS = 6; // 1 initial + up to 2 HITL gates + up to 2 critic loops + 1 cite_check buffer

/**
 * Drives Atlas's M3+M4a LangGraph in-process, auto-approving every HITL gate
 * so the run completes without external intervention. Used by the eval harness.
 *
 * Does NOT use Trigger.dev, durable checkpointing across worker restarts, or
 * any HTTP. Pure in-process; the LangGraph's in-memory checkpointer is enough
 * for the interrupt/resume cycle within a single Node process.
 */
export async function runHeadless(args: HeadlessRunArgs): Promise<HeadlessRunResult> {
  const graph = await buildGraph();
  const config = { configurable: { thread_id: args.runId } };

  // Fetch the seeded CorpusItems and map them into the CandidateCorpusItem shape the
  // planner/retriever expect (mirrors trigger/run-review.ts:hydrate-initial-state).
  const corpus = await db.corpusItem.findMany({
    where: { id: { in: args.corpusItemIds } },
    select: { id: true, source: true, summary: true, status: true },
  });
  if (corpus.length !== args.corpusItemIds.length) {
    throw new Error(
      `runHeadless: only found ${corpus.length}/${args.corpusItemIds.length} CorpusItems by id`,
    );
  }

  // Initial invocation seeds the run; subsequent invocations pass a Command to resume from interrupts.
  let payload: Partial<AgentState> | Command = {
    runId: args.runId,
    projectId: args.projectId,
    question: args.question,
    candidateCorpusItems: corpus.map((c) => ({
      id: c.id,
      title: c.source.split("/").pop() ?? c.id,
      summary: c.summary as
        | { abstract: string; studyType: string; relevanceToSLR: string }
        | null,
    })),
  };

  let state: AgentState | undefined;
  let segment = 0;

  for (segment = 0; segment < MAX_SEGMENTS; segment++) {
    // The graph's invoke type doesn't include `__interrupt__` on its return; cast for the interrupt check.
    state = (await graph.invoke(payload as Parameters<typeof graph.invoke>[0], config)) as AgentState & {
      __interrupt__?: Array<{ value: { kind: string } }>;
    };
    const interrupts = (state as { __interrupt__?: Array<{ value: { kind: string } }> }).__interrupt__;
    if (!interrupts || interrupts.length === 0) break;
    // Auto-approve any interrupt with { approved: true }; gates use the same shape per state.ts.
    payload = new Command({ resume: { approved: true } });
  }

  if (segment >= MAX_SEGMENTS) {
    throw new Error(`runHeadless: exceeded maxSegments (${MAX_SEGMENTS}); graph likely stuck in an interrupt loop`);
  }
  if (state === undefined) throw new Error("runHeadless: graph.invoke never returned a state");

  return { ...state, segments: segment + 1 };
}
