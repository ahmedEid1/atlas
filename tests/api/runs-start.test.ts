import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    project: { findUnique: vi.fn() },
    corpusItem: { count: vi.fn() },
    run: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("@/lib/agent/runs", () => ({ createRun: vi.fn(), setRunStatus: vi.fn() }));
vi.mock("@/lib/trigger-client", () => ({
  enqueueRunReview: vi.fn(),
  enqueueParsePdf: vi.fn(),
  enqueueSummarizePaper: vi.fn(),
  resolveWaitToken: vi.fn(),
}));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { createRun, setRunStatus } from "@/lib/agent/runs";
import { enqueueRunReview } from "@/lib/trigger-client";

beforeEach(() => vi.clearAllMocks());

describe("POST /api/projects/[id]/runs", () => {
  it("creates a run and enqueues the task", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u1", question: "Q?" } as never);
    vi.mocked(db.corpusItem.count).mockResolvedValue(3 as never);
    vi.mocked(db.run.findFirst).mockResolvedValue(null as never);
    vi.mocked(createRun).mockResolvedValue({ id: "r1" } as never);
    vi.mocked(enqueueRunReview).mockResolvedValue({ id: "trigger_run_abc" } as never);
    vi.mocked(setRunStatus).mockResolvedValue(undefined as never);

    const { POST } = await import("@/app/api/projects/[id]/runs/route");
    const res = await POST(
      new NextRequest("http://localhost/api/projects/p1/runs", { method: "POST" }),
      { params: Promise.resolve({ id: "p1" }) },
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: string; triggerRunId: string };
    expect(body.runId).toBe("r1");
    expect(body.triggerRunId).toBe("trigger_run_abc");
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

  it("returns 409 run_already_active when an active run exists", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u1", question: "Q?" } as never);
    vi.mocked(db.corpusItem.count).mockResolvedValue(3 as never);
    vi.mocked(db.run.findFirst).mockResolvedValue({
      id: "r_active",
      status: "DRAFTING",
      createdAt: new Date(),
    } as never);

    const { POST } = await import("@/app/api/projects/[id]/runs/route");
    const res = await POST(
      new NextRequest("http://localhost/api/projects/p1/runs", { method: "POST" }),
      { params: Promise.resolve({ id: "p1" }) },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; runId: string };
    expect(body.error).toBe("run_already_active");
    expect(body.runId).toBe("r_active");
    expect(createRun).not.toHaveBeenCalled();
  });

  it("stores Trigger handle on success", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u1", question: "Q?" } as never);
    vi.mocked(db.corpusItem.count).mockResolvedValue(3 as never);
    vi.mocked(db.run.findFirst).mockResolvedValue(null as never);
    vi.mocked(createRun).mockResolvedValue({ id: "r1" } as never);
    vi.mocked(enqueueRunReview).mockResolvedValue({ id: "tr_xyz" } as never);
    vi.mocked(setRunStatus).mockResolvedValue(undefined as never);

    const { POST } = await import("@/app/api/projects/[id]/runs/route");
    const res = await POST(
      new NextRequest("http://localhost/api/projects/p1/runs", { method: "POST" }),
      { params: Promise.resolve({ id: "p1" }) },
    );

    expect(res.status).toBe(201);
    expect(setRunStatus).toHaveBeenCalledWith({
      runId: "r1",
      status: "PENDING",
      triggerRunId: "tr_xyz",
    });
    const body = (await res.json()) as { runId: string; triggerRunId: string };
    expect(body.triggerRunId).toBe("tr_xyz");
  });

  it("marks run FAILED + returns 502 if enqueueRunReview throws", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u1", question: "Q?" } as never);
    vi.mocked(db.corpusItem.count).mockResolvedValue(3 as never);
    vi.mocked(db.run.findFirst).mockResolvedValue(null as never);
    vi.mocked(createRun).mockResolvedValue({ id: "r1" } as never);
    vi.mocked(enqueueRunReview).mockRejectedValue(new Error("Trigger down"));
    vi.mocked(setRunStatus).mockResolvedValue(undefined as never);

    const { POST } = await import("@/app/api/projects/[id]/runs/route");
    const res = await POST(
      new NextRequest("http://localhost/api/projects/p1/runs", { method: "POST" }),
      { params: Promise.resolve({ id: "p1" }) },
    );

    expect(res.status).toBe(502);
    expect(setRunStatus).toHaveBeenCalledWith({ runId: "r1", status: "FAILED" });
    const body = (await res.json()) as { error: string; message: string; detail: string };
    expect(body.error).toBe("run_enqueue_failed");
    // Verbatim error must not leak into the top-level message.
    expect(body.message).not.toContain("Trigger down");
    // But it should appear in `detail` (sliced).
    expect(body.detail).toContain("Trigger down");
  });
});
