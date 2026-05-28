import { runLLM } from "@/lib/llm";
import { ClaimsSchema, buildExtractClaimsRequest } from "@/lib/prompts/extract-claims";
import { addStep, finishStep, findCorpusMarkdown } from "@/lib/agent/runs";
import { assertWithinBudget, BudgetExceededError } from "@/lib/agent/cost-cap";
import type { AgentState, ClaimSpec } from "@/lib/agent/state";

export async function assessorNode(state: AgentState): Promise<Partial<AgentState>> {
  await assertWithinBudget(state.runId);
  const step = await addStep({ runId: state.runId, nodeName: "assessor" });
  const claims: ClaimSpec[] = [];

  try {
    for (const inc of state.includedPapers) {
      const markdown = await findCorpusMarkdown(inc.corpusItemId);
      if (!markdown) {
        // The screener only includes papers with a corpusItemId, yet
        // findCorpusMarkdown can still return null here — when OCR yielded
        // empty/null markdown (image-only / corrupt PDF) so the fetcher created
        // a content-less PARSED CorpusItem, OR when the CorpusItem is no longer
        // in a PARSED state. Either way there's nothing to extract claims from,
        // so skipping is correct — but record it as a finished RunStep with a
        // failureReason so an operator can see WHY a user-approved paper
        // produced zero claims, instead of it silently vanishing from the
        // synthesis. tokens=0; graceful (the rest of the corpus is still assessed).
        const skipStep = await addStep({ runId: state.runId, nodeName: "assessor_paper" });
        await finishStep({
          stepId: skipStep.id,
          failureReason: `assessor: no parsed full text for corpusItem ${inc.corpusItemId} — paper skipped (0 claims)`,
        });
        continue;
      }

      // Critical: gate inside the per-paper loop. A 50-paper review with
      // ~4k tokens each can otherwise blow the cap mid-loop before the next
      // node-entry check fires.
      await assertWithinBudget(state.runId);
      const { system, messages } = buildExtractClaimsRequest({
        question: state.question,
        paperMarkdown: markdown,
      });
      // Persist a RunStep PER LLM call so cost-cap's aggregate query sees this
      // node's spend. Without this, runLLM's `usage` is only flushed when the
      // outer `assessor` step finishes, so the per-iteration gate above reads
      // only completed-step tokens and a multi-paper assessor is silently
      // uncapped. The outer assessor step records tokens=0 to avoid double
      // counting.
      const innerStep = await addStep({ runId: state.runId, nodeName: "assessor_paper" });
      try {
        const { output, traceUrl, usage } = await runLLM({
          name: "assessor:extract",
          tier: "smart",
          maxTokens: 4096,
          system,
          messages,
          schema: ClaimsSchema,
          metadata: { runId: state.runId, projectId: state.projectId, node: "assessor", corpusItemId: inc.corpusItemId },
        });
        await finishStep({
          stepId: innerStep.id,
          traceUrl,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
        });

        for (const c of output.claims) {
          claims.push({
            includedPaperId: inc.corpusItemId,
            text: c.text,
            category: c.category,
          });
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await finishStep({ stepId: innerStep.id, failureReason: reason.slice(0, 1000) });
        // BudgetExceededError (and any other error) bubbles — assessor has no
        // per-paper soft-fail story like cite-check; an extraction failure
        // should fail the run so the user can investigate.
        if (err instanceof BudgetExceededError) throw err;
        throw err;
      }
    }

    // Outer step records tokens=0 (defaults) — actual spend lives on the
    // per-paper `assessor_paper` inner steps to keep cost-cap honest.
    await finishStep({ stepId: step.id });
    return { claims };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await finishStep({ stepId: step.id, failureReason: reason.slice(0, 1000) });
    throw err;
  }
}
