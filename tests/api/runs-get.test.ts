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
  it("returns the run + steps + checkpoints when owned", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue({
      id: "r1",
      status: "AWAITING_PLAN_APPROVAL",
      project: { ownerId: "u1" },
      steps: [{ id: "s1", nodeName: "planner" }],
      checkpoints: [{ id: "cp1", kind: "APPROVE_PLAN", status: "PENDING" }],
    } as never);

    const { GET } = await import("@/app/api/runs/[id]/route");
    const res = await GET(new NextRequest("http://localhost/api/runs/r1"), {
      params: Promise.resolve({ id: "r1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; steps: unknown[]; checkpoints: unknown[] };
    expect(body.id).toBe("r1");
    expect(body.steps).toHaveLength(1);
    expect(body.checkpoints).toHaveLength(1);
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
