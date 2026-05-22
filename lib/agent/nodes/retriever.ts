import { runLLM } from "@/lib/llm";
import { PaperScoreSchema, buildPaperScoreRequest } from "@/lib/prompts/score-paper";
import { addStep, finishStep } from "@/lib/agent/runs";
import type { AgentState, IncludedPaperSpec } from "@/lib/agent/state";

export async function retrieverNode(state: AgentState): Promise<Partial<AgentState>> {
  if (!state.plan) throw new Error("retriever: state.plan is null — planner must run first");

  const step = await addStep({ runId: state.runId, nodeName: "retriever" });
  let totalIn = 0, totalOut = 0, totalCacheRead = 0;
  const traces: string[] = [];

  try {
    const included: IncludedPaperSpec[] = [];
    for (const paper of state.candidateCorpusItems) {
      const { system, messages } = buildPaperScoreRequest({
        question: state.question,
        plan: state.plan,
        paper,
      });
      const { output, traceUrl, usage } = await runLLM({
        name: "retriever:score",
        model: "claude-sonnet-4-6",
        maxTokens: 1024,
        system,
        messages,
        schema: PaperScoreSchema,
        metadata: { runId: state.runId, projectId: state.projectId, node: "retriever", corpusItemId: paper.id },
      });
      totalIn += usage.inputTokens;
      totalOut += usage.outputTokens;
      totalCacheRead += usage.cacheReadInputTokens;
      traces.push(traceUrl);

      if (output.include) {
        included.push({
          corpusItemId: paper.id,
          relevanceScore: output.relevanceScore,
          inclusionReason: output.reason,
        });
      }
    }

    await finishStep({
      stepId: step.id,
      traceUrl: traces[0],
      inputTokens: totalIn,
      outputTokens: totalOut,
      cacheReadInputTokens: totalCacheRead,
    });

    return { includedPapers: included };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await finishStep({ stepId: step.id, failureReason: reason.slice(0, 1000) });
    throw err;
  }
}
