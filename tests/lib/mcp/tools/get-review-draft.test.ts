import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    run: { findFirst: vi.fn() },
    runStep: { count: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import { getReviewDraft } from "@/lib/mcp/tools/get-review-draft";
import { NotFoundError } from "@/lib/mcp/handler";

beforeEach(() => vi.clearAllMocks());

describe("getReviewDraft", () => {
  it("returns draft for an owned, completed review", async () => {
    vi.mocked(db.run.findFirst).mockResolvedValue({
      id: "r1", question: "q", status: "COMPLETED",
      draft: "## Review\n\nIntroduction with [paper_1].",
      critiqueScore: 0.9, faithfulnessScore: 0.88,
      completedAt: new Date("2026-05-24T12:00:00Z"),
      project: { ownerId: "u1" },
    } as never);
    vi.mocked(db.runStep.count).mockResolvedValue(2 as never);

    const res = await getReviewDraft(
      { reviewId: "r1" },
      { userId: "u1", clerkId: "c1" },
    );

    expect(db.run.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "r1", project: { ownerId: "u1" } },
    }));
    expect(res).toEqual({
      reviewId: "r1",
      researchQuestion: "q",
      status: "COMPLETED",
      draftMarkdown: "## Review\n\nIntroduction with [paper_1].",
      critiqueScore: 0.9,
      faithfulnessScore: 0.88,
      criticIterations: 2,
      generatedAt: "2026-05-24T12:00:00.000Z",
    });
  });

  it("throws NotFoundError when the review is owned by someone else", async () => {
    vi.mocked(db.run.findFirst).mockResolvedValue(null as never);
    await expect(getReviewDraft(
      { reviewId: "r_other" },
      { userId: "u1", clerkId: "c1" },
    )).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError when reviewId does not exist", async () => {
    vi.mocked(db.run.findFirst).mockResolvedValue(null as never);
    await expect(getReviewDraft(
      { reviewId: "missing" },
      { userId: "u1", clerkId: "c1" },
    )).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError when run exists but has no draft yet", async () => {
    vi.mocked(db.run.findFirst).mockResolvedValue({
      id: "r1", question: "q", status: "RUNNING",
      draft: null, critiqueScore: null, faithfulnessScore: null,
      completedAt: null, project: { ownerId: "u1" },
    } as never);
    await expect(getReviewDraft(
      { reviewId: "r1" },
      { userId: "u1", clerkId: "c1" },
    )).rejects.toBeInstanceOf(NotFoundError);
  });
});
