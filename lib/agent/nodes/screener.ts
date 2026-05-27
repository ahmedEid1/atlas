import { runLLM } from "@/lib/llm";
import {
  ScreeningVerdictSchema,
  buildScreenPaperRequest,
} from "@/lib/prompts/screen-paper";
import { addStep, finishStep, findCorpusMarkdown } from "@/lib/agent/runs";
import {
  assertWithinBudget,
  BudgetExceededError,
} from "@/lib/agent/cost-cap";
import { db } from "@/lib/db";
import type { AgentState, ScreeningRef } from "@/lib/agent/state";
import type { IncludedPaperSpec } from "@/lib/agent/state";

/**
 * V2 screener node — per-paper inclusion/exclusion verdict against the
 * plan's criteria. Replaces V1's retriever (which scored uploaded items)
 * for outbound runs.
 *
 * Behavior:
 *  - For each DiscoveredPaper in state, build a screening prompt with
 *    title + abstract + (when available) the fetcher's OCR'd full text.
 *  - One smart-tier LLM call per paper. Per-paper errors are NOT swallowed
 *    (unlike cite-check) — the screening pool needs to be either complete
 *    or fail honestly; a half-screened set would bias the corpus.
 *  - Cost-cap is gated BEFORE every call so a runaway-budget run halts
 *    mid-screening instead of completing all calls and only failing on
 *    the next node entry.
 *  - Sequential (PARALLEL=1) to respect Mistral free-tier RPS — matches
 *    cite-check's stance for the same reason.
 *
 * Output:
 *  - Persists one `ScreeningDecision` row per paper.
 *  - Materializes `IncludedPaper` rows for every paper where include=true
 *    (the assessor reads from IncludedPaper, same as V1) so the downstream
 *    pipeline doesn't need to branch on searchScope.
 *  - Returns the include-set as `IncludedPaperSpec[]` in `state.includedPapers`
 *    so the papers_gate HITL renders the same shape V1 produces.
 */
export async function screenerNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  if (!state.plan) {
    throw new Error("screener: state.plan is null — planner must run first");
  }

  await assertWithinBudget(state.runId);
  const outerStep = await addStep({ runId: state.runId, nodeName: "screener" });

  try {
    if (state.discoveredPapers.length === 0) {
      await finishStep({ stepId: outerStep.id });
      return { includedPapers: [], screeningDecisions: [] };
    }

    const decisions: ScreeningRef[] = [];
    const included: IncludedPaperSpec[] = [];

    for (const paper of state.discoveredPapers) {
      await assertWithinBudget(state.runId);

      const fullText = paper.corpusItemId
        ? await findCorpusMarkdown(paper.corpusItemId)
        : null;

      const innerStep = await addStep({
        runId: state.runId,
        nodeName: "screener_paper",
      });
      try {
        const { system, messages } = buildScreenPaperRequest({
          question: state.question,
          plan: state.plan,
          paper: { title: paper.title, abstract: paper.abstract, fullText },
        });
        const { output, traceUrl, usage } = await runLLM({
          name: "screener:decide",
          tier: "smart",
          maxTokens: 800,
          system,
          messages,
          schema: ScreeningVerdictSchema,
          metadata: {
            runId: state.runId,
            projectId: state.projectId,
            node: "screener",
            discoveredPaperId: paper.id,
          },
        });
        await finishStep({
          stepId: innerStep.id,
          traceUrl,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
        });

        await db.screeningDecision.create({
          data: {
            runId: state.runId,
            discoveredPaperId: paper.id,
            include: output.include,
            reason: output.reason,
            relevanceScore: output.relevanceScore,
          },
        });

        decisions.push({
          discoveredPaperId: paper.id,
          include: output.include,
          relevanceScore: output.relevanceScore,
          reason: output.reason,
        });

        // Only include papers where the fetcher successfully created a
        // CorpusItem — the assessor reads parsedMarkdown from CorpusItem
        // and would fail downstream on a null corpusItemId. Papers screened
        // "include=true" but missing the full text (paywalled / failed
        // fetch) get the screening decision but stay out of IncludedPaper.
        if (output.include && paper.corpusItemId) {
          included.push({
            corpusItemId: paper.corpusItemId,
            relevanceScore: output.relevanceScore,
            inclusionReason: output.reason,
          });
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await finishStep({
          stepId: innerStep.id,
          failureReason: reason.slice(0, 1000),
        });
        // BudgetExceededError propagates — runaway budget should not get
        // silently screened-out. Other errors also propagate; the screener
        // has no per-paper soft-fail story (same posture as retriever).
        if (err instanceof BudgetExceededError) throw err;
        throw err;
      }
    }

    await finishStep({ stepId: outerStep.id });
    return { includedPapers: included, screeningDecisions: decisions };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await finishStep({ stepId: outerStep.id, failureReason: reason.slice(0, 1000) });
    throw err;
  }
}
