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
