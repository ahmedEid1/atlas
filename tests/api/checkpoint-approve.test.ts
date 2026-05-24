import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    humanCheckpoint: { findUnique: vi.fn(), update: vi.fn() },
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
  new NextRequest("http://localhost/api/runs/r1/checkpoints/cp1/approve", {
    method: "POST",
    body: JSON.stringify(body),
  });

describe("POST /api/runs/[id]/checkpoints/[cpId]/approve", () => {
  it("marks the checkpoint approved and completes the wait token", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "PENDING",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);
    vi.mocked(resolveCheckpoint).mockResolvedValue({ waitToken: "tk_xyz" } as never);
    vi.mocked(db.humanCheckpoint.update).mockResolvedValue({} as never);

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/approve/route");
    const res = await POST(buildReq({ corpusItemIds: ["c1", "c2"] }), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(200);
    expect(resolveCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointId: "cp1", status: "APPROVED" }),
    );
    expect(resolveWaitToken).toHaveBeenCalledWith(
      "tk_xyz",
      expect.objectContaining({ approved: true, corpusItemIds: ["c1", "c2"] }),
    );
    // F2.1: After the wait-token delivery succeeds, the route MUST null
    // out waitToken so a retry doesn't re-deliver (or trigger the F2.2
    // recovery path).
    expect(db.humanCheckpoint.update).toHaveBeenCalledWith({
      where: { id: "cp1" },
      data: { waitToken: null },
    });
  });

  it("returns 404 for non-owner", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "PENDING",
      run: { id: "r1", project: { ownerId: "u2" } },
    } as never);

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/approve/route");
    const res = await POST(buildReq({}), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 and does NOT complete the wait token when a prior caller fully resolved (waitToken null)", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    // First findUnique = ownership check (returns PENDING-shaped row).
    // Second findUnique = F2.2 recovery probe (waitToken already null
    // means a prior caller delivered the token; safe to 409).
    vi.mocked(db.humanCheckpoint.findUnique)
      .mockResolvedValueOnce({
        id: "cp1",
        status: "PENDING",
        run: { id: "r1", project: { ownerId: "u1" } },
      } as never)
      .mockResolvedValueOnce({
        waitToken: null,
        decisionPayload: { approved: true },
      } as never);
    vi.mocked(resolveCheckpoint).mockResolvedValue(null);

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/approve/route");
    const res = await POST(buildReq({}), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("checkpoint_already_resolved");
    expect(resolveWaitToken).not.toHaveBeenCalled();
  });

  it("F2.2: recovers a stranded wait-token on retry", async () => {
    // A prior attempt updated the DB row (PENDING -> APPROVED) but the
    // resolveWaitToken call crashed (Trigger outage), leaving waitToken
    // non-null. On retry, resolveCheckpoint returns null (status already
    // APPROVED), but the route MUST probe the row, see the stranded
    // waitToken, replay delivery with the persisted decisionPayload, and
    // null out waitToken so a third retry won't re-deliver.
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique)
      .mockResolvedValueOnce({
        id: "cp1",
        status: "APPROVED",
        run: { id: "r1", project: { ownerId: "u1" } },
      } as never)
      .mockResolvedValueOnce({
        waitToken: "tk_stranded",
        decisionPayload: { approved: true, corpusItemIds: ["c1"] },
      } as never);
    vi.mocked(resolveCheckpoint).mockResolvedValue(null);
    vi.mocked(db.humanCheckpoint.update).mockResolvedValue({} as never);

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/approve/route");
    const res = await POST(buildReq({}), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; recovered: boolean };
    expect(body.recovered).toBe(true);
    // Replays using the PERSISTED decisionPayload, not the (empty) retry body.
    expect(resolveWaitToken).toHaveBeenCalledWith(
      "tk_stranded",
      expect.objectContaining({ approved: true, corpusItemIds: ["c1"] }),
    );
    expect(db.humanCheckpoint.update).toHaveBeenCalledWith({
      where: { id: "cp1" },
      data: { waitToken: null },
    });
  });
});
