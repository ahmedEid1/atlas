import { runLLM } from "@/lib/llm";
import { CritiqueSchema, buildCriticRequest } from "@/lib/prompts/critic";
import { addStep, finishStep } from "@/lib/agent/runs";
import { assertWithinBudget } from "@/lib/agent/cost-cap";
import type { AgentState } from "@/lib/agent/state";

export async function criticNode(state: AgentState): Promise<Partial<AgentState>> {
  if (!state.draft) throw new Error("critic: state.draft is null — drafter must run first");
  if (!state.plan) throw new Error("critic: state.plan is null");

  await assertWithinBudget(state.runId);
  const step = await addStep({ runId: state.runId, nodeName: "critic" });
  try {
    const { system, messages } = buildCriticRequest({
      question: state.question,
      plan: state.plan,
      includedPapers: state.includedPapers,
      draft: state.draft,
      iteration: state.critiqueIterations,
    });
    const { output, traceUrl, usage } = await runLLM({
      name: "critic",
      tier: "smart",
      maxTokens: 2048,
      system,
      messages,
      schema: CritiqueSchema,
      metadata: { runId: state.runId, projectId: state.projectId, node: "critic" },
    });
    await finishStep({
      stepId: step.id,
      traceUrl,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
    });
    return {
      critique: output,
      critiqueIterations: state.critiqueIterations + 1,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await finishStep({ stepId: step.id, failureReason: reason.slice(0, 1000) });
    throw err;
  }
}
