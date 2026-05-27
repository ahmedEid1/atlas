import { z } from "zod";
import { db } from "@/lib/db";
import { mcpTool, NotFoundError } from "@/lib/mcp/handler";
import type { McpUserCtx } from "@/lib/mcp/auth";

export const listDiscoveredPapersInput = z.object({
  reviewId: z.string().min(1),
});

export const listDiscoveredPapersOutput = z.object({
  reviewId: z.string(),
  searchScope: z.enum(["uploaded_only", "outbound", "hybrid"]),
  totalDiscovered: z.number().int(),
  totalScreenedIn: z.number().int(),
  totalScreenedOut: z.number().int(),
  papers: z.array(z.object({
    discoveredPaperId: z.string(),
    provider: z.string(),
    externalId: z.string(),
    title: z.string(),
    authors: z.array(z.string()),
    publicationYear: z.number().int().nullable(),
    venue: z.string().nullable(),
    citationCount: z.number().int().nullable(),
    oaUrl: z.string().nullable(),
    accessStatus: z.string(),
    initialScore: z.number(),
    fetched: z.boolean(),
    screening: z.object({
      include: z.boolean(),
      relevanceScore: z.number(),
      reason: z.string(),
    }).nullable(),
  })),
});

export async function listDiscoveredPapers(
  input: z.infer<typeof listDiscoveredPapersInput>,
  ctx: McpUserCtx,
): Promise<z.infer<typeof listDiscoveredPapersOutput>> {
  const run = await db.run.findFirst({
    where: { id: input.reviewId, project: { ownerId: ctx.userId } },
    select: { id: true, project: { select: { searchScope: true } } },
  });
  if (!run) throw new NotFoundError("review_not_found");

  const rows = await db.discoveredPaper.findMany({
    where: { runId: input.reviewId },
    orderBy: { initialScore: "desc" },
    select: {
      id: true, provider: true, externalId: true, title: true, authors: true,
      publicationYear: true, venue: true, citationCount: true,
      oaUrl: true, accessStatus: true, initialScore: true, corpusItemId: true,
      screening: { select: { include: true, relevanceScore: true, reason: true } },
    },
  });

  let screenedIn = 0;
  let screenedOut = 0;
  const papers = rows.map((r) => {
    if (r.screening) {
      if (r.screening.include) screenedIn++;
      else screenedOut++;
    }
    return {
      discoveredPaperId: r.id,
      provider: r.provider,
      externalId: r.externalId,
      title: r.title,
      authors: r.authors,
      publicationYear: r.publicationYear,
      venue: r.venue,
      citationCount: r.citationCount,
      oaUrl: r.oaUrl,
      accessStatus: r.accessStatus,
      initialScore: r.initialScore,
      fetched: r.corpusItemId !== null,
      screening: r.screening
        ? {
            include: r.screening.include,
            relevanceScore: r.screening.relevanceScore,
            reason: r.screening.reason,
          }
        : null,
    };
  });

  return {
    reviewId: run.id,
    searchScope: run.project.searchScope as "uploaded_only" | "outbound" | "hybrid",
    totalDiscovered: rows.length,
    totalScreenedIn: screenedIn,
    totalScreenedOut: screenedOut,
    papers,
  };
}

export const listDiscoveredPapersTool = mcpTool({
  name: "list_discovered_papers",
  inputSchema: listDiscoveredPapersInput,
  outputSchema: listDiscoveredPapersOutput,
  handler: listDiscoveredPapers,
});
