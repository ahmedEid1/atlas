import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    humanCheckpoint: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/agent/checkpoint-delivery", () => ({
  deliverCheckpoint: vi.fn(),
}));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { deliverCheckpoint } from "@/lib/agent/checkpoint-delivery";

beforeEach(() => vi.clearAllMocks());

const buildReq = () =>
  new NextRequest(
    "http://localhost/api/runs/r1/checkpoints/cp1/retry-delivery",
    { method: "POST" },
  );

const ctx = { params: Promise.resolve({ id: "r1", cpId: "cp1" }) };

describe("POST /api/runs/[id]/checkpoints/[cpId]/retry-delivery", () => {
  it("returns 401 when no user", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("no session"));

    const { POST } = await import(
      "@/app/api/runs/[id]/checkpoints/[cpId]/retry-delivery/route"
    );
    const res = await POST(buildReq(), ctx);
    expect(res.status).toBe(401);
    expect(db.humanCheckpoint.findUnique).not.toHaveBeenCalled();
    expect(deliverCheckpoint).not.toHaveBeenCalled();
  });

  it("returns 403 demo_mode_readonly for guests and never calls deliver", async () => {
    vi.mocked(requireUser).mockResolvedValue({
      id: "u_guest",
      isGuest: true,
    } as never);

    const { POST } = await import(
      "@/app/api/runs/[id]/checkpoints/[cpId]/retry-delivery/route"
    );
    const res = await POST(buildReq(), ctx);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("demo_mode_readonly");
    expect(db.humanCheckpoint.findUnique).not.toHaveBeenCalled();
    expect(deliverCheckpoint).not.toHaveBeenCalled();
  });

  it("returns 404 when the checkpoint does not exist", async () => {
    vi.mocked(requireUser).mockResolvedValue({
      id: "u1",
      isGuest: false,
    } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue(null);

    const { POST } = await import(
      "@/app/api/runs/[id]/checkpoints/[cpId]/retry-delivery/route"
    );
    const res = await POST(buildReq(), ctx);
    expect(res.status).toBe(404);
    expect(deliverCheckpoint).not.toHaveBeenCalled();
  });

  it("returns 404 when the caller is not the project owner", async () => {
    vi.mocked(requireUser).mockResolvedValue({
      id: "u1",
      isGuest: false,
    } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "APPROVED",
      run: { id: "r1", project: { ownerId: "u2" } },
    } as never);

    const { POST } = await import(
      "@/app/api/runs/[id]/checkpoints/[cpId]/retry-delivery/route"
    );
    const res = await POST(buildReq(), ctx);
    expect(res.status).toBe(404);
    expect(deliverCheckpoint).not.toHaveBeenCalled();
  });

  it("returns 409 checkpoint_still_pending when status=PENDING", async () => {
    vi.mocked(requireUser).mockResolvedValue({
      id: "u1",
      isGuest: false,
    } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "PENDING",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);

    const { POST } = await import(
      "@/app/api/runs/[id]/checkpoints/[cpId]/retry-delivery/route"
    );
    const res = await POST(buildReq(), ctx);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("checkpoint_still_pending");
    expect(deliverCheckpoint).not.toHaveBeenCalled();
  });

  it("returns 200 with outcome=delivered when helper delivers", async () => {
    vi.mocked(requireUser).mockResolvedValue({
      id: "u1",
      isGuest: false,
    } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "APPROVED",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);
    vi.mocked(deliverCheckpoint).mockResolvedValue({ outcome: "delivered" });

    const { POST } = await import(
      "@/app/api/runs/[id]/checkpoints/[cpId]/retry-delivery/route"
    );
    const res = await POST(buildReq(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; outcome: string };
    expect(body).toEqual({ ok: true, outcome: "delivered" });
    expect(deliverCheckpoint).toHaveBeenCalledWith("cp1");
  });

  it("returns 200 with outcome=already_delivered when helper says so", async () => {
    vi.mocked(requireUser).mockResolvedValue({
      id: "u1",
      isGuest: false,
    } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "REJECTED",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);
    vi.mocked(deliverCheckpoint).mockResolvedValue({
      outcome: "already_delivered",
    });

    const { POST } = await import(
      "@/app/api/runs/[id]/checkpoints/[cpId]/retry-delivery/route"
    );
    const res = await POST(buildReq(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; outcome: string };
    expect(body).toEqual({ ok: true, outcome: "already_delivered" });
    expect(deliverCheckpoint).toHaveBeenCalledWith("cp1");
  });
});
