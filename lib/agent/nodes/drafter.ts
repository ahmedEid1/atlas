import { runLLM } from "@/lib/llm";
import { DraftSchema, buildDrafterRequest } from "@/lib/prompts/draft-review";
import { addStep, finishStep } from "@/lib/agent/runs";
import type { AgentState } from "@/lib/agent/state";

export async function drafterNode(state: AgentState): Promise<Partial<AgentState>> {
  if (!state.plan) throw new Error("drafter: state.plan is null");
  if (state.claims.length === 0) throw new Error("drafter: no claims to draft from");

  const step = await addStep({ runId: state.runId, nodeName: "drafter" });
  try {
    const { system, messages } = buildDrafterRequest({
      question: state.question,
      plan: state.plan,
      claims: state.claims,
      critiqueFeedback:
        state.critique?.decision === "revise" ? state.critique.actionableFeedback : undefined,
    });
    const { output, traceUrl, usage } = await runLLM({
      name: "drafter",
      tier: "smart",
      maxTokens: 16000,
      system,
      messages,
      schema: DraftSchema,
      metadata: { runId: state.runId, projectId: state.projectId, node: "drafter" },
    });
    await finishStep({
      stepId: step.id,
      traceUrl,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
    });
    return { draft: output.draft };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await finishStep({ stepId: step.id, failureReason: reason.slice(0, 1000) });
    throw err;
  }
}
