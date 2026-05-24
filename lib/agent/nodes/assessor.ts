import { runLLM } from "@/lib/llm";
import { ClaimsSchema, buildExtractClaimsRequest } from "@/lib/prompts/extract-claims";
import { addStep, finishStep, findCorpusMarkdown } from "@/lib/agent/runs";
import { assertWithinBudget } from "@/lib/agent/cost-cap";
import type { AgentState, ClaimSpec } from "@/lib/agent/state";

export async function assessorNode(state: AgentState): Promise<Partial<AgentState>> {
  await assertWithinBudget(state.runId);
  const step = await addStep({ runId: state.runId, nodeName: "assessor" });
  let totalIn = 0, totalOut = 0, totalCacheRead = 0;
  const firstTraceUrl: { value?: string } = {};
  const claims: ClaimSpec[] = [];

  try {
    for (const inc of state.includedPapers) {
      const markdown = await findCorpusMarkdown(inc.corpusItemId);
      if (!markdown) continue;

      // Critical: gate inside the per-paper loop. A 50-paper review with
      // ~4k tokens each can otherwise blow the cap mid-loop before the next
      // node-entry check fires.
      await assertWithinBudget(state.runId);
      const { system, messages } = buildExtractClaimsRequest({
        question: state.question,
        paperMarkdown: markdown,
      });
      const { output, traceUrl, usage } = await runLLM({
        name: "assessor:extract",
        tier: "smart",
        maxTokens: 4096,
        system,
        messages,
        schema: ClaimsSchema,
        metadata: { runId: state.runId, projectId: state.projectId, node: "assessor", corpusItemId: inc.corpusItemId },
      });

      totalIn += usage.inputTokens;
      totalOut += usage.outputTokens;
      totalCacheRead += usage.cacheReadInputTokens;
      firstTraceUrl.value ??= traceUrl;

      for (const c of output.claims) {
        claims.push({
          includedPaperId: inc.corpusItemId,
          text: c.text,
          category: c.category,
        });
      }
    }

    await finishStep({
      stepId: step.id,
      traceUrl: firstTraceUrl.value,
      inputTokens: totalIn,
      outputTokens: totalOut,
      cacheReadInputTokens: totalCacheRead,
    });
    return { claims };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await finishStep({ stepId: step.id, failureReason: reason.slice(0, 1000) });
    throw err;
  }
}
