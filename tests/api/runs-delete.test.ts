import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    run: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

beforeEach(() => vi.clearAllMocks());

describe("DELETE /api/runs/[id]", () => {
  it("deletes the run when owned by current user", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue({
      project: { ownerId: "u1" },
    } as never);
    vi.mocked(db.run.delete).mockResolvedValue({} as never);

    const { DELETE } = await import("@/app/api/runs/[id]/route");
    const res = await DELETE(
      new NextRequest("http://localhost/api/runs/r1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "r1" }) },
    );

    expect(res.status).toBe(204);
    expect(db.run.delete).toHaveBeenCalledWith({ where: { id: "r1" } });
  });

  it("returns 404 when the run doesn't exist", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue(null);

    const { DELETE } = await import("@/app/api/runs/[id]/route");
    const res = await DELETE(
      new NextRequest("http://localhost/api/runs/r1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "r1" }) },
    );

    expect(res.status).toBe(404);
    expect(db.run.delete).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when the run belongs to another user — existence-probe defense", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue({
      project: { ownerId: "u2" },
    } as never);

    const { DELETE } = await import("@/app/api/runs/[id]/route");
    const res = await DELETE(
      new NextRequest("http://localhost/api/runs/r1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "r1" }) },
    );

    expect(res.status).toBe(404);
    expect(db.run.delete).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("nope"));

    const { DELETE } = await import("@/app/api/runs/[id]/route");
    const res = await DELETE(
      new NextRequest("http://localhost/api/runs/r1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "r1" }) },
    );

    expect(res.status).toBe(401);
    expect(db.run.findUnique).not.toHaveBeenCalled();
  });
});
