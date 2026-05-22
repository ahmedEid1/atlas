import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    project: { findUnique: vi.fn() },
    corpusItem: { count: vi.fn() },
  },
}));
vi.mock("@/lib/agent/runs", () => ({ createRun: vi.fn() }));
vi.mock("@/lib/trigger-client", () => ({
  enqueueRunReview: vi.fn(),
  enqueueParsePdf: vi.fn(),
  enqueueSummarizePaper: vi.fn(),
  resolveWaitToken: vi.fn(),
}));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { createRun } from "@/lib/agent/runs";
import { enqueueRunReview } from "@/lib/trigger-client";

beforeEach(() => vi.clearAllMocks());

describe("POST /api/projects/[id]/runs", () => {
  it("creates a run and enqueues the task", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u1", question: "Q?" } as never);
    vi.mocked(db.corpusItem.count).mockResolvedValue(3 as never);
    vi.mocked(createRun).mockResolvedValue({ id: "r1" } as never);
    vi.mocked(enqueueRunReview).mockResolvedValue({ id: "trigger_run_abc" } as never);

    const { POST } = await import("@/app/api/projects/[id]/runs/route");
    const res = await POST(
      new NextRequest("http://localhost/api/projects/p1/runs", { method: "POST" }),
      { params: Promise.resolve({ id: "p1" }) },
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: string };
    expect(body.runId).toBe("r1");
    expect(createRun).toHaveBeenCalledWith({ projectId: "p1", question: "Q?" });
    expect(enqueueRunReview).toHaveBeenCalledWith("r1");
  });

  it("returns 404 for a project the user doesn't own", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u2", question: "x" } as never);

    const { POST } = await import("@/app/api/projects/[id]/runs/route");
    const res = await POST(
      new NextRequest("http://localhost/api/projects/p1/runs", { method: "POST" }),
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 if the project has zero PARSED corpus items", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u1", question: "x" } as never);
    vi.mocked(db.corpusItem.count).mockResolvedValue(0 as never);

    const { POST } = await import("@/app/api/projects/[id]/runs/route");
    const res = await POST(
      new NextRequest("http://localhost/api/projects/p1/runs", { method: "POST" }),
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(res.status).toBe(409);
  });
});
