import { runLLM } from "@/lib/llm";
import {
  DiscoveryQueriesSchema,
  buildDiscoverQueriesRequest,
} from "@/lib/prompts/discover-queries";
import { addStep, finishStep } from "@/lib/agent/runs";
import { assertWithinBudget } from "@/lib/agent/cost-cap";
import { dispatchSearch } from "@/lib/search/dispatch";
import type { SearchProviderName } from "@/lib/search/types";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import type { AgentState, DiscoveredPaperRef } from "@/lib/agent/state";

/**
 * V2 outbound-search entry node.
 *
 * 1. Generates 4-8 natural-language search queries via the LLM, scoped to
 *    the user's research question + PICOC (one smart-tier call).
 * 2. Fans those queries out to every enabled provider via the dispatcher.
 * 3. Persists every hit as a DiscoveredPaper row + returns thin refs in
 *    state for the discovery_gate to render.
 *
 * Routing: only runs when `state.searchScope` is "outbound" or "hybrid".
 * V1 "uploaded_only" projects skip this node entirely via a conditional
 * edge in graph.ts.
 *
 * Cost cap participates — the discoverer's LLM call is recorded as a
 * RunStep so the per-run budget gate sees it.
 *
 * Per-provider error tolerance: the dispatcher records failures
 * per-provider without throwing. We log the error count + provider names
 * to the RunStep's failureReason field so the user can see which
 * providers contributed and which fell over.
 */
export async function discovererNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  if (!state.plan) throw new Error("discoverer: state.plan is null — planner must run first");
  if (state.searchProviders.length === 0) {
    throw new Error("discoverer: state.searchProviders is empty — project config has no providers");
  }

  // Operator kill switch — refuse to fan out to any provider when set.
  // The run halts with a clear failureReason rather than silently producing
  // empty hits, so the operator's intent (pause outbound) reaches the user.
  if (env.SEARCH_DISABLED === "1") {
    throw new Error(
      "discoverer: outbound search is temporarily disabled by the operator (SEARCH_DISABLED=1); retry later",
    );
  }

  await assertWithinBudget(state.runId);
  const outerStep = await addStep({
    runId: state.runId,
    nodeName: "discoverer",
  });

  try {
    // 1. Generate queries via the LLM.
    const { system, messages } = buildDiscoverQueriesRequest({
      question: state.question,
      plan: state.plan,
    });
    const { output, traceUrl, usage } = await runLLM({
      name: "discoverer:queries",
      tier: "smart",
      maxTokens: 1024,
      system,
      messages,
      schema: DiscoveryQueriesSchema,
      metadata: { runId: state.runId, projectId: state.projectId, node: "discoverer" },
    });

    // 2. Fan out to providers. Per-provider errors are non-fatal — the
    //    dispatcher logs them and continues with whatever the survivors return.
    const providers = state.searchProviders as SearchProviderName[];
    const allHits: Array<Awaited<ReturnType<typeof dispatchSearch>>["hits"][number]> = [];
    const allErrors: Array<{ provider: SearchProviderName; message: string }> = [];

    // Sequential fan-out across queries to respect per-provider rate budgets
    // (arXiv recommends 3s between calls). Within a single query, providers run
    // in parallel via dispatchSearch.
    for (const query of output.queries) {
      const r = await dispatchSearch({
        query: { query, yearStart: undefined, yearEnd: undefined, limit: 25 },
        providers,
      });
      allHits.push(...r.hits);
      allErrors.push(...r.errors);
    }

    // 3. Deduplicate across queries (same externalId can recur across queries
    //    — keep the highest initialScore).
    const dedup = new Map<string, (typeof allHits)[number]>();
    for (const h of allHits) {
      const existing = dedup.get(h.externalId);
      if (!existing || h.initialScore > existing.initialScore) {
        dedup.set(h.externalId, h);
      }
    }
    const merged = Array.from(dedup.values()).sort(
      (a, b) => b.initialScore - a.initialScore,
    );

    // 4. Persist every survivor as a DiscoveredPaper row. createMany is
    //    fast; @@unique([runId, externalId]) skipDuplicates makes it
    //    idempotent if the node re-runs (e.g. after a Trigger.dev retry).
    if (merged.length > 0) {
      await db.discoveredPaper.createMany({
        data: merged.map((h) => ({
          runId: state.runId,
          provider: h.provider,
          externalId: h.externalId,
          title: h.title,
          authors: h.authors,
          abstract: h.abstract,
          publicationYear: h.publicationYear,
          venue: h.venue,
          citationCount: h.citationCount,
          oaUrl: h.oaUrl,
          accessStatus: h.accessStatus,
          initialScore: h.initialScore,
        })),
        skipDuplicates: true,
      });
    }

    // Re-fetch with assigned ids so state.discoveredPapers refs are stable.
    const rows = await db.discoveredPaper.findMany({
      where: { runId: state.runId },
      orderBy: { initialScore: "desc" },
    });
    const refs: DiscoveredPaperRef[] = rows.map((r) => ({
      id: r.id,
      provider: r.provider as DiscoveredPaperRef["provider"],
      externalId: r.externalId,
      title: r.title,
      abstract: r.abstract,
      oaUrl: r.oaUrl,
      accessStatus: r.accessStatus as DiscoveredPaperRef["accessStatus"],
      corpusItemId: r.corpusItemId,
    }));

    // Concatenate provider errors into failureReason for visibility (the
    // step doesn't fail — discoverer succeeds if ANY provider returned hits).
    const failureReason =
      allErrors.length > 0
        ? `partial: ${allErrors
            .map((e) => `${e.provider}: ${e.message}`)
            .join("; ")}`.slice(0, 1000)
        : undefined;
    await finishStep({
      stepId: outerStep.id,
      traceUrl,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      failureReason,
    });

    return {
      discoveryQueries: output.queries,
      discoveredPapers: refs,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await finishStep({ stepId: outerStep.id, failureReason: reason.slice(0, 1000) });
    throw err;
  }
}
