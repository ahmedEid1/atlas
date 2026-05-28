import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    corpusItem: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

beforeEach(() => vi.clearAllMocks());

describe("DELETE /api/corpus/[id]", () => {
  it("deletes the corpus item when the project is owned by the caller", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.corpusItem.findUnique).mockResolvedValue({
      project: { ownerId: "u1" },
    } as never);
    vi.mocked(db.corpusItem.delete).mockResolvedValue({} as never);

    const { DELETE } = await import("@/app/api/corpus/[id]/route");
    const res = await DELETE(
      new NextRequest("http://localhost/api/corpus/c1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "c1" }) },
    );

    expect(res.status).toBe(204);
    expect(db.corpusItem.delete).toHaveBeenCalledWith({ where: { id: "c1" } });
  });

  it("returns 404 when the corpus item doesn't exist", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.corpusItem.findUnique).mockResolvedValue(null);

    const { DELETE } = await import("@/app/api/corpus/[id]/route");
    const res = await DELETE(
      new NextRequest("http://localhost/api/corpus/c1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "c1" }) },
    );

    expect(res.status).toBe(404);
    expect(db.corpusItem.delete).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when the corpus item belongs to another user — existence-probe defense", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.corpusItem.findUnique).mockResolvedValue({
      project: { ownerId: "u2" },
    } as never);

    const { DELETE } = await import("@/app/api/corpus/[id]/route");
    const res = await DELETE(
      new NextRequest("http://localhost/api/corpus/c1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "c1" }) },
    );

    expect(res.status).toBe(404);
    expect(db.corpusItem.delete).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("nope"));

    const { DELETE } = await import("@/app/api/corpus/[id]/route");
    const res = await DELETE(
      new NextRequest("http://localhost/api/corpus/c1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "c1" }) },
    );

    expect(res.status).toBe(401);
    expect(db.corpusItem.findUnique).not.toHaveBeenCalled();
  });
});
