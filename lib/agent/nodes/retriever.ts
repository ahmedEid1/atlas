import { runLLM } from "@/lib/llm";
import { PaperScoreSchema, buildPaperScoreRequest } from "@/lib/prompts/score-paper";
import { addStep, finishStep } from "@/lib/agent/runs";
import { assertWithinBudget, BudgetExceededError } from "@/lib/agent/cost-cap";
import type { AgentState, IncludedPaperSpec } from "@/lib/agent/state";

export async function retrieverNode(state: AgentState): Promise<Partial<AgentState>> {
  if (!state.plan) throw new Error("retriever: state.plan is null — planner must run first");

  await assertWithinBudget(state.runId);
  const step = await addStep({ runId: state.runId, nodeName: "retriever" });

  try {
    const included: IncludedPaperSpec[] = [];
    for (const paper of state.candidateCorpusItems) {
      // Gate inside the per-paper loop: a large corpus can blow past the cap
      // mid-iteration. Each new paper is a new LLM call, so re-check before
      // dispatching it.
      await assertWithinBudget(state.runId);
      const { system, messages } = buildPaperScoreRequest({
        question: state.question,
        plan: state.plan,
        paper,
      });
      // Persist a RunStep PER LLM call so cost-cap's aggregate query sees this
      // node's spend. Without this, runLLM's `usage` is only flushed when the
      // outer `retriever` step finishes, so the per-iteration gate above reads
      // only completed-step tokens and a large-corpus retriever is silently
      // uncapped. The outer retriever step records tokens=0 to avoid double
      // counting.
      const innerStep = await addStep({ runId: state.runId, nodeName: "retriever_paper" });
      try {
        const { output, traceUrl, usage } = await runLLM({
          name: "retriever:score",
          tier: "fast",
          maxTokens: 1024,
          system,
          messages,
          schema: PaperScoreSchema,
          metadata: { runId: state.runId, projectId: state.projectId, node: "retriever", corpusItemId: paper.id },
        });
        await finishStep({
          stepId: innerStep.id,
          traceUrl,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
        });

        if (output.include) {
          included.push({
            corpusItemId: paper.id,
            relevanceScore: output.relevanceScore,
            inclusionReason: output.reason,
          });
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await finishStep({ stepId: innerStep.id, failureReason: reason.slice(0, 1000) });
        // BudgetExceededError (and any other error) bubbles — retriever has
        // no per-paper soft-fail story like cite-check, because silently
        // skipping a paper here biases the inclusion decision and the user
        // can't tell which paper was dropped. Mirror of assessor.ts:60-64.
        if (err instanceof BudgetExceededError) throw err;
        throw err;
      }
    }

    // Outer step records tokens=0 (defaults) — actual spend lives on the
    // per-paper `retriever_paper` inner steps to keep cost-cap honest.
    await finishStep({ stepId: step.id });

    return { includedPapers: included };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await finishStep({ stepId: step.id, failureReason: reason.slice(0, 1000) });
    throw err;
  }
}
