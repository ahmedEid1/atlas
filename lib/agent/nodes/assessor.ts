import { runLLM } from "@/lib/llm";
import { ClaimsSchema, buildExtractClaimsRequest } from "@/lib/prompts/extract-claims";
import { addStep, finishStep, findCorpusMarkdown } from "@/lib/agent/runs";
import { assertWithinBudget, BudgetExceededError } from "@/lib/agent/cost-cap";
import { env } from "@/lib/env";
import type { AgentState, ClaimSpec } from "@/lib/agent/state";

export async function assessorNode(state: AgentState): Promise<Partial<AgentState>> {
  await assertWithinBudget(state.runId);
  const step = await addStep({ runId: state.runId, nodeName: "assessor" });
  const claims: ClaimSpec[] = [];

  try {
    // Cap the included set before the per-paper loop. Even after the screener +
    // papers_gate HITL, a permissive review can carry dozens of approved papers,
    // and one smart-tier runLLM call each can balloon the token budget. Sort by
    // relevanceScore descending so the highest-signal papers survive the cut,
    // then take the top MAX_INCLUDED_PAPERS. Mirrors the discoverer's safety
    // cap: silent slice, but auditable — when truncation happens we log the
    // drop with the runId so an operator can see WHY some approved papers
    // produced no claims.
    const sortedIncluded = [...state.includedPapers].sort(
      (a, b) => b.relevanceScore - a.relevanceScore,
    );
    const includedPapers = sortedIncluded.slice(0, env.MAX_INCLUDED_PAPERS);
    if (sortedIncluded.length > includedPapers.length) {
      console.error(
        `assessor: run ${state.runId} truncated includedPapers from ` +
          `${sortedIncluded.length} to ${includedPapers.length} ` +
          `(MAX_INCLUDED_PAPERS=${env.MAX_INCLUDED_PAPERS}); ` +
          `lowest-scored papers will produce no claims`,
      );
    }

    for (const inc of includedPapers) {
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
        // BudgetExceededError MUST propagate — a runaway token budget should
        // halt the whole run, exactly as the screener does. We re-throw it
        // before the soft-fail path below can swallow it.
        if (err instanceof BudgetExceededError) throw err;
        // Per-paper soft-fail: any OTHER extraction error (LLM 5xx, schema
        // validation, transient network) is recorded on the inner RunStep
        // (above) and we CONTINUE to the next paper rather than aborting the
        // whole run. Killing the run here would discard every claim already
        // extracted from the other papers — the same "record + continue"
        // posture used for empty-markdown papers above.
        continue;
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
