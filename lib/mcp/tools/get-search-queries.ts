import { z } from "zod";
import { db } from "@/lib/db";
import { mcpTool, NotFoundError } from "@/lib/mcp/handler";
import type { McpUserCtx } from "@/lib/mcp/auth";

export const getSearchQueriesInput = z.object({
  reviewId: z.string().min(1),
});

export const getSearchQueriesOutput = z.object({
  reviewId: z.string(),
  searchScope: z.enum(["uploaded_only", "outbound", "hybrid"]),
  searchProviders: z.array(z.string()),
  queries: z.array(z.string()),
  providerErrors: z.array(z.object({
    nodeName: z.string(),
    failureReason: z.string(),
  })),
});

/**
 * Returns the search queries the discoverer generated for an outbound run.
 * Queries are sourced from the APPROVE_DISCOVERY checkpoint's proposal — that
 * row exists for every outbound/hybrid run because the discoverer always
 * emits a discovery_gate interrupt. Returns an empty queries list for
 * uploaded_only runs (with searchScope='uploaded_only' so the caller can
 * tell the difference from "discoverer hasn't run yet").
 */
export async function getSearchQueries(
  input: z.infer<typeof getSearchQueriesInput>,
  ctx: McpUserCtx,
): Promise<z.infer<typeof getSearchQueriesOutput>> {
  const run = await db.run.findFirst({
    where: { id: input.reviewId, project: { ownerId: ctx.userId } },
    select: {
      id: true,
      project: { select: { searchScope: true, searchProviders: true } },
    },
  });
  if (!run) throw new NotFoundError("review_not_found");

  const checkpoint = await db.humanCheckpoint.findFirst({
    where: { runId: input.reviewId, kind: "APPROVE_DISCOVERY" },
    orderBy: { createdAt: "desc" },
    select: { proposal: true },
  });

  const proposalQueries = checkpoint?.proposal as { queries?: unknown } | null;
  const queries = Array.isArray(proposalQueries?.queries)
    ? (proposalQueries.queries as unknown[]).filter((q): q is string => typeof q === "string")
    : [];

  const errSteps = await db.runStep.findMany({
    where: {
      runId: input.reviewId,
      nodeName: "discoverer",
      failureReason: { not: null },
    },
    select: { nodeName: true, failureReason: true },
    orderBy: { startedAt: "asc" },
  });

  return {
    reviewId: run.id,
    searchScope: run.project.searchScope as "uploaded_only" | "outbound" | "hybrid",
    searchProviders: run.project.searchProviders,
    queries,
    providerErrors: errSteps.map((s) => ({
      nodeName: s.nodeName,
      failureReason: s.failureReason as string,
    })),
  };
}

export const getSearchQueriesTool = mcpTool({
  name: "get_search_queries",
  inputSchema: getSearchQueriesInput,
  outputSchema: getSearchQueriesOutput,
  handler: getSearchQueries,
});
