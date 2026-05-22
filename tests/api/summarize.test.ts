import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    corpusItem: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/trigger-client", () => ({
  enqueueSummarizePaper: vi.fn(),
  enqueueParsePdf: vi.fn(),
}));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { enqueueSummarizePaper } from "@/lib/trigger-client";

beforeEach(() => vi.clearAllMocks());

const mkReq = (id: string) =>
  new NextRequest(`http://localhost/api/corpus/${id}/summarize`, { method: "POST" });

describe("POST /api/corpus/[id]/summarize", () => {
  it("enqueues the task and returns 202 with the run id", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.corpusItem.findUnique).mockResolvedValue({
      id: "c1",
      status: "PARSED",
      project: { ownerId: "u1" },
    } as never);
    vi.mocked(enqueueSummarizePaper).mockResolvedValue({ id: "run_xyz" } as never);

    const { POST } = await import("@/app/api/corpus/[id]/summarize/route");
    const res = await POST(mkReq("c1"), { params: Promise.resolve({ id: "c1" }) });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: "run_xyz" });
    expect(enqueueSummarizePaper).toHaveBeenCalledWith("c1");
  });

  it("returns 404 when the corpus item belongs to another user", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.corpusItem.findUnique).mockResolvedValue({
      id: "c1",
      status: "PARSED",
      project: { ownerId: "u2" },
    } as never);

    const { POST } = await import("@/app/api/corpus/[id]/summarize/route");
    const res = await POST(mkReq("c1"), { params: Promise.resolve({ id: "c1" }) });

    expect(res.status).toBe(404);
    expect(enqueueSummarizePaper).not.toHaveBeenCalled();
  });

  it("returns 409 when the corpus item is not yet PARSED", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.corpusItem.findUnique).mockResolvedValue({
      id: "c1",
      status: "PARSING",
      project: { ownerId: "u1" },
    } as never);

    const { POST } = await import("@/app/api/corpus/[id]/summarize/route");
    const res = await POST(mkReq("c1"), { params: Promise.resolve({ id: "c1" }) });

    expect(res.status).toBe(409);
    expect(enqueueSummarizePaper).not.toHaveBeenCalled();
  });
});
