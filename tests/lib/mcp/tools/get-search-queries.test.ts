import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    run: { findFirst: vi.fn() },
    humanCheckpoint: { findFirst: vi.fn() },
    runStep: { findMany: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import { getSearchQueries } from "@/lib/mcp/tools/get-search-queries";
import { NotFoundError } from "@/lib/mcp/handler";

beforeEach(() => vi.clearAllMocks());

describe("getSearchQueries", () => {
  it("returns the discoverer's queries + provider set + provider errors", async () => {
    vi.mocked(db.run.findFirst).mockResolvedValue({
      id: "r1",
      project: { searchScope: "outbound", searchProviders: ["openalex", "arxiv"] },
    } as never);
    vi.mocked(db.humanCheckpoint.findFirst).mockResolvedValue({
      proposal: {
        queries: ["chain of thought prompting", "in-context learning survey"],
        hits: [],
      },
    } as never);
    vi.mocked(db.runStep.findMany).mockResolvedValue([
      { nodeName: "discoverer", failureReason: "partial: exa: missing API key" },
    ] as never);

    const res = await getSearchQueries(
      { reviewId: "r1" },
      { userId: "u1", clerkId: "c1" },
    );

    expect(res).toEqual({
      reviewId: "r1",
      searchScope: "outbound",
      searchProviders: ["openalex", "arxiv"],
      queries: ["chain of thought prompting", "in-context learning survey"],
      providerErrors: [
        { nodeName: "discoverer", failureReason: "partial: exa: missing API key" },
      ],
    });
  });

  it("returns empty queries + empty errors for uploaded_only runs", async () => {
    vi.mocked(db.run.findFirst).mockResolvedValue({
      id: "r2",
      project: { searchScope: "uploaded_only", searchProviders: [] },
    } as never);
    vi.mocked(db.humanCheckpoint.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.runStep.findMany).mockResolvedValue([] as never);

    const res = await getSearchQueries(
      { reviewId: "r2" },
      { userId: "u1", clerkId: "c1" },
    );

    expect(res.searchScope).toBe("uploaded_only");
    expect(res.queries).toEqual([]);
    expect(res.providerErrors).toEqual([]);
  });

  it("returns empty queries when checkpoint exists but proposal is malformed", async () => {
    vi.mocked(db.run.findFirst).mockResolvedValue({
      id: "r3",
      project: { searchScope: "outbound", searchProviders: ["openalex"] },
    } as never);
    vi.mocked(db.humanCheckpoint.findFirst).mockResolvedValue({
      proposal: { queries: "not-an-array" },
    } as never);
    vi.mocked(db.runStep.findMany).mockResolvedValue([] as never);

    const res = await getSearchQueries(
      { reviewId: "r3" },
      { userId: "u1", clerkId: "c1" },
    );

    expect(res.queries).toEqual([]);
  });

  it("scopes the query to the calling user's runs", async () => {
    vi.mocked(db.run.findFirst).mockResolvedValue({
      id: "r4",
      project: { searchScope: "outbound", searchProviders: ["arxiv"] },
    } as never);
    vi.mocked(db.humanCheckpoint.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.runStep.findMany).mockResolvedValue([] as never);

    await getSearchQueries(
      { reviewId: "r4" },
      { userId: "u42", clerkId: "c42" },
    );

    expect(db.run.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "r4", project: { ownerId: "u42" } },
    }));
  });

  it("throws NotFoundError when review is unowned", async () => {
    vi.mocked(db.run.findFirst).mockResolvedValue(null as never);
    await expect(getSearchQueries(
      { reviewId: "r_other" },
      { userId: "u1", clerkId: "c1" },
    )).rejects.toBeInstanceOf(NotFoundError);
    expect(db.humanCheckpoint.findFirst).not.toHaveBeenCalled();
    expect(db.runStep.findMany).not.toHaveBeenCalled();
  });
});
