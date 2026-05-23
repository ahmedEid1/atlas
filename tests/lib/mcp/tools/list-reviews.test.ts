import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { run: { findMany: vi.fn() } },
}));

import { db } from "@/lib/db";
import { listReviews } from "@/lib/mcp/tools/list-reviews";

beforeEach(() => vi.clearAllMocks());

describe("listReviews", () => {
  it("returns reviews for the caller's projects only", async () => {
    (db.run.findMany as any).mockResolvedValue([
      {
        id: "r1", projectId: "p1", status: "COMPLETED",
        question: "q1",
        createdAt: new Date("2026-05-01T00:00:00Z"),
        completedAt: new Date("2026-05-01T01:00:00Z"),
        critiqueScore: 0.87, faithfulnessScore: 0.92,
        project: { id: "p1", title: "ProjectOne" },
        _count: { claims: 12, claimChecks: 10 },
      },
    ]);
    const res = await listReviews({}, { userId: "u1", clerkId: "c1" });
    expect(db.run.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { project: { ownerId: "u1" } },
    }));
    expect(res.reviews).toHaveLength(1);
    expect(res.reviews[0]).toEqual({
      id: "r1", projectId: "p1", projectName: "ProjectOne",
      researchQuestion: "q1", status: "COMPLETED",
      createdAt: "2026-05-01T00:00:00.000Z",
      completedAt: "2026-05-01T01:00:00.000Z",
      critiqueScore: 0.87, faithfulnessScore: 0.92,
      claimCount: 12, citationCount: 10,
    });
  });

  it("returns empty array for new user", async () => {
    (db.run.findMany as any).mockResolvedValue([]);
    const res = await listReviews({}, { userId: "u1", clerkId: "c1" });
    expect(res.reviews).toEqual([]);
  });

  it("handles null completedAt and null scores for in-progress runs", async () => {
    (db.run.findMany as any).mockResolvedValue([
      {
        id: "r2", projectId: "p1", status: "PLANNING",
        question: "q", createdAt: new Date("2026-05-24T00:00:00Z"),
        completedAt: null, critiqueScore: null, faithfulnessScore: null,
        project: { id: "p1", title: "Pending" },
        _count: { claims: 0, claimChecks: 0 },
      },
    ]);
    const res = await listReviews({}, { userId: "u1", clerkId: "c1" });
    expect(res.reviews[0]!.completedAt).toBeNull();
    expect(res.reviews[0]!.critiqueScore).toBeNull();
    expect(res.reviews[0]!.citationCount).toBe(0);
  });
});
