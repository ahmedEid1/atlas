import { runLLM } from "@/lib/llm";
import { PlanSchema, buildPlannerRequest } from "@/lib/prompts/plan-review";
import { addStep, finishStep } from "@/lib/agent/runs";
import { assertWithinBudget } from "@/lib/agent/cost-cap";
import type { AgentState } from "@/lib/agent/state";

export async function plannerNode(state: AgentState): Promise<Partial<AgentState>> {
  await assertWithinBudget(state.runId);
  const step = await addStep({ runId: state.runId, nodeName: "planner" });
  try {
    const { system, messages } = buildPlannerRequest({
      question: state.question,
      corpusSize: state.candidateCorpusItems.length,
    });
    const { output, traceUrl, usage } = await runLLM({
      name: "planner",
      tier: "smart",
      maxTokens: 4096,
      system,
      messages,
      schema: PlanSchema,
      metadata: { runId: state.runId, projectId: state.projectId, node: "planner" },
    });
    await finishStep({
      stepId: step.id,
      traceUrl,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
    });
    return { plan: output };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await finishStep({ stepId: step.id, failureReason: reason.slice(0, 1000) });
    throw err;
  }
}
