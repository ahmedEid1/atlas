import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    run: { findUnique: vi.fn() },
    claimCheck: { findMany: vi.fn() },
  },
}));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/runs/[id]/audit.json", () => {
  it("returns the cite_check audit as a JSON attachment for the owner", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue({
      id: "r1",
      draft: "# Review\n\nClaim [paper_001].",
      faithfulnessScore: 0.83,
      project: { ownerId: "u1" },
    } as never);
    vi.mocked(db.claimCheck.findMany).mockResolvedValue([
      { claim: "A claim", paperId: "p1", verdict: "SUPPORTED", reason: "matched p.3", paperExcerpt: "verbatim span" },
      { claim: "B claim", paperId: "p2", verdict: "UNSUPPORTED", reason: "not found", paperExcerpt: null },
      { claim: "C claim", paperId: "p3", verdict: "UNCLEAR", reason: "ambiguous", paperExcerpt: null },
    ] as never);

    const { GET } = await import("@/app/api/runs/[id]/audit.json/route");
    const res = await GET(
      new NextRequest("http://localhost/api/runs/r1/audit.json"),
      { params: Promise.resolve({ id: "r1" }) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="thoth-r1-audit.json"',
    );
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = JSON.parse(await res.text()) as {
      reviewId: string;
      faithfulnessScore: number;
      totalClaims: number;
      supportedCount: number;
      unsupportedCount: number;
      unclearCount: number;
      claims: Array<{ claimText: string; verdict: string }>;
    };
    expect(body.reviewId).toBe("r1");
    expect(body.faithfulnessScore).toBe(0.83);
    expect(body.totalClaims).toBe(3);
    expect(body.supportedCount).toBe(1);
    expect(body.unsupportedCount).toBe(1);
    expect(body.unclearCount).toBe(1);
    // Verdict is lowercased (matches the MCP get_citation_audit shape).
    expect(body.claims[0]!.verdict).toBe("supported");
    expect(body.claims[1]!.verdict).toBe("unsupported");
    expect(body.claims[2]!.verdict).toBe("unclear");
  });

  it("returns 404 when the run has no draft yet (cite_check hasn't run)", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue({
      id: "r1", draft: null, faithfulnessScore: null,
      project: { ownerId: "u1" },
    } as never);

    const { GET } = await import("@/app/api/runs/[id]/audit.json/route");
    const res = await GET(
      new NextRequest("http://localhost/api/runs/r1/audit.json"),
      { params: Promise.resolve({ id: "r1" }) },
    );
    expect(res.status).toBe(404);
    expect(db.claimCheck.findMany).not.toHaveBeenCalled();
  });

  it("returns 404 for unowned runs (existence-probe defense)", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue({
      id: "r1", draft: "X", faithfulnessScore: 0.5,
      project: { ownerId: "u2" },
    } as never);

    const { GET } = await import("@/app/api/runs/[id]/audit.json/route");
    const res = await GET(
      new NextRequest("http://localhost/api/runs/r1/audit.json"),
      { params: Promise.resolve({ id: "r1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("unauth"));

    const { GET } = await import("@/app/api/runs/[id]/audit.json/route");
    const res = await GET(
      new NextRequest("http://localhost/api/runs/r1/audit.json"),
      { params: Promise.resolve({ id: "r1" }) },
    );
    expect(res.status).toBe(401);
    expect(db.run.findUnique).not.toHaveBeenCalled();
  });

  it("returns empty claims array when cite_check produced no rows", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue({
      id: "r1", draft: "Review without citations.", faithfulnessScore: null,
      project: { ownerId: "u1" },
    } as never);
    vi.mocked(db.claimCheck.findMany).mockResolvedValue([] as never);

    const { GET } = await import("@/app/api/runs/[id]/audit.json/route");
    const res = await GET(
      new NextRequest("http://localhost/api/runs/r1/audit.json"),
      { params: Promise.resolve({ id: "r1" }) },
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text()) as {
      totalClaims: number;
      claims: unknown[];
    };
    expect(body.totalClaims).toBe(0);
    expect(body.claims).toEqual([]);
  });
});
