import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    humanCheckpoint: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/agent/runs", () => ({
  resolveCheckpoint: vi.fn(),
}));
vi.mock("@/lib/trigger-client", () => ({
  resolveWaitToken: vi.fn(),
  enqueueRunReview: vi.fn(),
  enqueueParsePdf: vi.fn(),
  enqueueSummarizePaper: vi.fn(),
}));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolveCheckpoint } from "@/lib/agent/runs";
import { resolveWaitToken } from "@/lib/trigger-client";

beforeEach(() => vi.clearAllMocks());

const buildReq = (body: unknown) =>
  new NextRequest("http://localhost/api/runs/r1/checkpoints/cp1/reject", {
    method: "POST",
    body: JSON.stringify(body),
  });

describe("POST /api/runs/[id]/checkpoints/[cpId]/reject", () => {
  it("marks the checkpoint rejected and completes the wait token", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "PENDING",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);
    vi.mocked(resolveCheckpoint).mockResolvedValue({ waitToken: "tk_xyz" } as never);

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/reject/route");
    const res = await POST(buildReq({ reason: "off-topic" }), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(200);
    expect(resolveCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointId: "cp1",
        status: "REJECTED",
        rejectionReason: "off-topic",
      }),
    );
    expect(resolveWaitToken).toHaveBeenCalledWith(
      "tk_xyz",
      expect.objectContaining({ approved: false, rejectionReason: "off-topic" }),
    );
  });

  it("returns 404 for non-owner", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "PENDING",
      run: { id: "r1", project: { ownerId: "u2" } },
    } as never);

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/reject/route");
    const res = await POST(buildReq({}), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 and does NOT complete the wait token when a concurrent caller already resolved the checkpoint", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "PENDING",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);
    // Simulate the atomic update losing the race: resolveCheckpoint returns null
    // because another request already flipped PENDING -> {APPROVED,REJECTED} first.
    vi.mocked(resolveCheckpoint).mockResolvedValue(null);

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/reject/route");
    const res = await POST(buildReq({ reason: "x" }), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("checkpoint_already_resolved");
    expect(resolveWaitToken).not.toHaveBeenCalled();
  });
});
