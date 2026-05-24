import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    run: { findFirst: vi.fn() },
    claimCheck: { findMany: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import { getCitationAudit } from "@/lib/mcp/tools/get-citation-audit";
import { NotFoundError } from "@/lib/mcp/handler";

beforeEach(() => vi.clearAllMocks());

describe("getCitationAudit", () => {
  it("returns per-claim verdicts and aggregates for an owned review", async () => {
    vi.mocked(db.run.findFirst).mockResolvedValue({
      id: "r1", faithfulnessScore: 0.83,
    } as never);
    vi.mocked(db.claimCheck.findMany).mockResolvedValue([
      { paperId: "p1", claim: "A claim", verdict: "SUPPORTED", reason: "found in page 3", paperExcerpt: "supporting span" },
      { paperId: "p2", claim: "Another", verdict: "UNSUPPORTED", reason: "not found", paperExcerpt: null },
      { paperId: "p3", claim: "Unclear", verdict: "UNCLEAR", reason: "ambiguous", paperExcerpt: null },
    ] as never);

    const res = await getCitationAudit(
      { reviewId: "r1" },
      { userId: "u1", clerkId: "c1" },
    );

    expect(res).toEqual({
      reviewId: "r1",
      faithfulnessScore: 0.83,
      totalClaims: 3,
      supportedCount: 1,
      unsupportedCount: 1,
      unclearCount: 1,
      claims: [
        { claimText: "A claim", citedPaperId: "p1", verdict: "supported", reason: "found in page 3", supportingSpan: "supporting span" },
        { claimText: "Another", citedPaperId: "p2", verdict: "unsupported", reason: "not found", supportingSpan: null },
        { claimText: "Unclear", citedPaperId: "p3", verdict: "unclear", reason: "ambiguous", supportingSpan: null },
      ],
    });
  });

  it("returns empty claims array when cite_check has not run yet", async () => {
    vi.mocked(db.run.findFirst).mockResolvedValue({ id: "r1", faithfulnessScore: null } as never);
    vi.mocked(db.claimCheck.findMany).mockResolvedValue([] as never);

    const res = await getCitationAudit({ reviewId: "r1" }, { userId: "u1", clerkId: "c1" });

    expect(res).toEqual({
      reviewId: "r1", faithfulnessScore: null,
      totalClaims: 0, supportedCount: 0, unsupportedCount: 0, unclearCount: 0,
      claims: [],
    });
  });

  it("throws NotFoundError when review is unowned", async () => {
    vi.mocked(db.run.findFirst).mockResolvedValue(null as never);
    await expect(getCitationAudit(
      { reviewId: "r_other" },
      { userId: "u1", clerkId: "c1" },
    )).rejects.toBeInstanceOf(NotFoundError);
  });
});
