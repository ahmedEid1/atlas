import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    run: { findFirst: vi.fn() },
    discoveredPaper: { findMany: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import { listDiscoveredPapers } from "@/lib/mcp/tools/list-discovered-papers";
import { NotFoundError } from "@/lib/mcp/handler";

beforeEach(() => vi.clearAllMocks());

describe("listDiscoveredPapers", () => {
  it("returns hits with screening verdicts + counts for an outbound run", async () => {
    vi.mocked(db.run.findFirst).mockResolvedValue({
      id: "r1", project: { searchScope: "outbound" },
    } as never);
    vi.mocked(db.discoveredPaper.findMany).mockResolvedValue([
      {
        id: "d1", provider: "openalex", externalId: "10.1/a", title: "A",
        authors: ["Alice"], publicationYear: 2024, venue: "ACL",
        citationCount: 5, oaUrl: "https://a", accessStatus: "open",
        initialScore: 0.91, corpusItemId: "ci1",
        screening: { include: true, relevanceScore: 0.88, reason: "matches scope" },
      },
      {
        id: "d2", provider: "arxiv", externalId: "arxiv:2401.0", title: "B",
        authors: [], publicationYear: null, venue: null, citationCount: null,
        oaUrl: null, accessStatus: "open", initialScore: 0.4,
        corpusItemId: null,
        screening: { include: false, relevanceScore: 0.12, reason: "off-topic" },
      },
      {
        id: "d3", provider: "exa", externalId: "exa-1", title: "C",
        authors: ["Bob"], publicationYear: 2023, venue: "NeurIPS",
        citationCount: 0, oaUrl: "https://c", accessStatus: "paywalled",
        initialScore: 0.2, corpusItemId: null, screening: null,
      },
    ] as never);

    const res = await listDiscoveredPapers(
      { reviewId: "r1" },
      { userId: "u1", clerkId: "c1" },
    );

    expect(res.reviewId).toBe("r1");
    expect(res.searchScope).toBe("outbound");
    expect(res.totalDiscovered).toBe(3);
    expect(res.totalScreenedIn).toBe(1);
    expect(res.totalScreenedOut).toBe(1);
    expect(res.papers).toHaveLength(3);
    expect(res.papers[0]).toMatchObject({
      discoveredPaperId: "d1", provider: "openalex", externalId: "10.1/a",
      fetched: true,
      screening: { include: true, relevanceScore: 0.88, reason: "matches scope" },
    });
    expect(res.papers[1]!.fetched).toBe(false);
    expect(res.papers[2]!.screening).toBeNull();
  });

  it("returns an empty list for an uploaded_only run", async () => {
    vi.mocked(db.run.findFirst).mockResolvedValue({
      id: "r2", project: { searchScope: "uploaded_only" },
    } as never);
    vi.mocked(db.discoveredPaper.findMany).mockResolvedValue([] as never);

    const res = await listDiscoveredPapers(
      { reviewId: "r2" },
      { userId: "u1", clerkId: "c1" },
    );

    expect(res.searchScope).toBe("uploaded_only");
    expect(res.papers).toEqual([]);
    expect(res.totalDiscovered).toBe(0);
    expect(res.totalScreenedIn).toBe(0);
    expect(res.totalScreenedOut).toBe(0);
  });

  it("scopes the query to the calling user's runs", async () => {
    vi.mocked(db.run.findFirst).mockResolvedValue({
      id: "r3", project: { searchScope: "hybrid" },
    } as never);
    vi.mocked(db.discoveredPaper.findMany).mockResolvedValue([] as never);

    await listDiscoveredPapers(
      { reviewId: "r3" },
      { userId: "u9", clerkId: "c9" },
    );

    expect(db.run.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "r3", project: { ownerId: "u9" } },
    }));
  });

  it("throws NotFoundError when review is unowned", async () => {
    vi.mocked(db.run.findFirst).mockResolvedValue(null as never);
    await expect(listDiscoveredPapers(
      { reviewId: "r_other" },
      { userId: "u1", clerkId: "c1" },
    )).rejects.toBeInstanceOf(NotFoundError);
    expect(db.discoveredPaper.findMany).not.toHaveBeenCalled();
  });
});
