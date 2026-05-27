import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    run: { findUnique: vi.fn() },
  },
}));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/runs/[id]", () => {
  it("returns the run + steps + checkpoints when owned, with waitToken stripped", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue({
      id: "r1",
      status: "AWAITING_PLAN_APPROVAL",
      project: { ownerId: "u1" },
      steps: [{ id: "s1", nodeName: "planner" }],
      checkpoints: [{ id: "cp1", kind: "APPROVE_PLAN", status: "PENDING", waitToken: "tk_xyz" }],
    } as never);

    const { GET } = await import("@/app/api/runs/[id]/route");
    const res = await GET(new NextRequest("http://localhost/api/runs/r1"), {
      params: Promise.resolve({ id: "r1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      steps: unknown[];
      checkpoints: Array<Record<string, unknown>>;
    };
    expect(body.id).toBe("r1");
    expect(body.steps).toHaveLength(1);
    expect(body.checkpoints).toHaveLength(1);
    // waitToken is a server-side secret — confirm it never crosses the JSON
    // boundary even when the route returns the run to its owner.
    expect("waitToken" in body.checkpoints[0]!).toBe(false);
  });

  it("derives awaitingDelivery=true for stranded checkpoints (status != PENDING + waitToken set)", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue({
      id: "r1",
      project: { ownerId: "u1" },
      steps: [],
      checkpoints: [
        { id: "cp_stranded", kind: "APPROVE_PLAN", status: "APPROVED", waitToken: "tk_stuck" },
        { id: "cp_done", kind: "APPROVE_PAPERS", status: "APPROVED", waitToken: null },
        { id: "cp_pending", kind: "APPROVE_PLAN", status: "PENDING", waitToken: "tk_fresh" },
      ],
    } as never);

    const { GET } = await import("@/app/api/runs/[id]/route");
    const res = await GET(new NextRequest("http://localhost/api/runs/r1"), {
      params: Promise.resolve({ id: "r1" }),
    });
    const body = (await res.json()) as {
      checkpoints: Array<{ id: string; awaitingDelivery: boolean }>;
    };
    const byId = new Map(body.checkpoints.map((c) => [c.id, c.awaitingDelivery]));
    // Status committed + waitToken still set = stranded, awaiting recovery.
    expect(byId.get("cp_stranded")).toBe(true);
    // Status committed + waitToken null = Phase 2 succeeded, fully delivered.
    expect(byId.get("cp_done")).toBe(false);
    // Still PENDING = user hasn't decided yet, NOT a delivery problem.
    expect(byId.get("cp_pending")).toBe(false);
  });

  // V2 (post-M32): outbound + hybrid runs accumulate DiscoveredPaper rows
  // with their ScreeningDecision join. The route now includes them in the
  // response so the run-detail server component + external clients (MCP
  // tools, live e2e) can inspect the V2 surface in one round-trip.
  it("includes discoveredPapers (with screening) for outbound runs", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue({
      id: "r1",
      status: "AWAITING_PAPERS_APPROVAL",
      project: { ownerId: "u1" },
      steps: [],
      checkpoints: [],
      includedPapers: [],
      discoveredPapers: [
        {
          id: "dp1",
          provider: "arxiv",
          externalId: "arxiv:2310.06770",
          title: "Paper one",
          initialScore: 0.9,
          corpusItemId: "ci1",
          screening: { include: true, relevanceScore: 0.85, reason: "matches scope" },
        },
        {
          id: "dp2",
          provider: "uploaded",
          externalId: "uploaded:ci_a",
          title: "User upload",
          initialScore: 1.0,
          corpusItemId: "ci_a",
          screening: null,
        },
      ],
    } as never);

    const { GET } = await import("@/app/api/runs/[id]/route");
    const res = await GET(new NextRequest("http://localhost/api/runs/r1"), {
      params: Promise.resolve({ id: "r1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      discoveredPapers: Array<{ provider: string; externalId: string; screening: unknown }>;
    };
    expect(body.discoveredPapers).toHaveLength(2);
    // Provider widening: M13's "uploaded" synthetic appears alongside real
    // provider hits.
    expect(body.discoveredPapers.map((d) => d.provider).sort()).toEqual(["arxiv", "uploaded"]);
    // Screening is included when present; null when the screener hasn't
    // voted on a paper yet.
    expect(body.discoveredPapers[0]!.screening).toBeTruthy();
    expect(body.discoveredPapers[1]!.screening).toBeNull();
  });

  it("returns 404 for non-owner", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue({
      id: "r1",
      project: { ownerId: "u2" },
      steps: [],
      checkpoints: [],
    } as never);

    const { GET } = await import("@/app/api/runs/[id]/route");
    const res = await GET(new NextRequest("http://localhost/api/runs/r1"), {
      params: Promise.resolve({ id: "r1" }),
    });
    expect(res.status).toBe(404);
  });
});
