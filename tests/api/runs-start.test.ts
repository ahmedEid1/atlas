import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const envMock = { SEARCH_DISABLED: undefined as string | undefined };
vi.mock("@/lib/env", () => ({ env: envMock }));

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    project: { findUnique: vi.fn() },
    corpusItem: { count: vi.fn() },
    run: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
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

/**
 * Wires up `db.$transaction` so it invokes the route's tx callback with a
 * mock tx whose `run.findFirst` + `$executeRaw` are scripted by the test.
 * The route calls `createRun(args, tx)` (mocked separately) and returns
 * `{ run }` or `{ conflict }`; we pass that through unchanged.
 */
function installTxMock(opts: {
  existingActive?: { id: string; status: string } | null;
}) {
  const txFindFirst = vi.fn().mockResolvedValue(opts.existingActive ?? null);
  const txExecuteRaw = vi.fn().mockResolvedValue(1);
  vi.mocked(db.$transaction).mockImplementation((async (fn: unknown) => {
    const tx = {
      $executeRaw: txExecuteRaw,
      run: { findFirst: txFindFirst, create: vi.fn() },
    };
    return (fn as (t: unknown) => unknown)(tx);
  }) as never);
  return { txFindFirst, txExecuteRaw };
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.SEARCH_DISABLED = undefined;
});

describe("POST /api/projects/[id]/runs", () => {
  it("creates a run and enqueues the task", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u1", question: "Q?", searchScope: "uploaded_only", searchProviders: [] } as never);
    vi.mocked(db.corpusItem.count).mockResolvedValue(3 as never);
    installTxMock({ existingActive: null });
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
    expect(createRun).toHaveBeenCalledWith(
      { projectId: "p1", question: "Q?" },
      expect.anything(),
    );
    expect(enqueueRunReview).toHaveBeenCalledWith("r1");
  });

  it("returns 404 for a project the user doesn't own", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u2", question: "x", searchScope: "uploaded_only", searchProviders: [] } as never);

    const { POST } = await import("@/app/api/projects/[id]/runs/route");
    const res = await POST(
      new NextRequest("http://localhost/api/projects/p1/runs", { method: "POST" }),
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 if the project has zero PARSED corpus items", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u1", question: "x", searchScope: "uploaded_only", searchProviders: [] } as never);
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
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u1", question: "Q?", searchScope: "uploaded_only", searchProviders: [] } as never);
    vi.mocked(db.corpusItem.count).mockResolvedValue(3 as never);
    installTxMock({ existingActive: { id: "r_active", status: "DRAFTING" } });

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
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u1", question: "Q?", searchScope: "uploaded_only", searchProviders: [] } as never);
    vi.mocked(db.corpusItem.count).mockResolvedValue(3 as never);
    installTxMock({ existingActive: null });
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
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u1", question: "Q?", searchScope: "uploaded_only", searchProviders: [] } as never);
    vi.mocked(db.corpusItem.count).mockResolvedValue(3 as never);
    installTxMock({ existingActive: null });
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

  it("F1: holds advisory lock + active-run check + createRun in the same transaction", async () => {
    // Verifies the TOCTOU fix: all three operations must occur inside the
    // tx callback passed to db.$transaction. The advisory lock comes first
    // (so concurrent POSTs serialize), then the findFirst inside the lock
    // sees committed state, then createRun reuses the tx client.
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u1", question: "Q?", searchScope: "uploaded_only", searchProviders: [] } as never);
    vi.mocked(db.corpusItem.count).mockResolvedValue(3 as never);
    const { txExecuteRaw, txFindFirst } = installTxMock({ existingActive: null });
    vi.mocked(createRun).mockResolvedValue({ id: "r1" } as never);
    vi.mocked(enqueueRunReview).mockResolvedValue({ id: "tr_1" } as never);
    vi.mocked(setRunStatus).mockResolvedValue(undefined as never);

    const { POST } = await import("@/app/api/projects/[id]/runs/route");
    await POST(
      new NextRequest("http://localhost/api/projects/p1/runs", { method: "POST" }),
      { params: Promise.resolve({ id: "p1" }) },
    );

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(txExecuteRaw).toHaveBeenCalledTimes(1);
    expect(txFindFirst).toHaveBeenCalledTimes(1);
    // createRun must receive the tx client (second arg) so its insert
    // participates in the same transaction that holds the advisory lock.
    expect(createRun).toHaveBeenCalledWith(
      { projectId: "p1", question: "Q?" },
      expect.objectContaining({ run: expect.any(Object), $executeRaw: expect.any(Function) }),
    );
  });

  it("F1: second concurrent POST sees the just-created run and returns 409", async () => {
    // Simulates two POSTs serialized by the advisory lock. The first
    // creates the run; the second's findFirst (inside its own transaction,
    // after the first commits) sees the active row and returns conflict.
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u1", question: "Q?", searchScope: "uploaded_only", searchProviders: [] } as never);
    vi.mocked(db.corpusItem.count).mockResolvedValue(3 as never);

    // Script $transaction across two calls: first sees no active run,
    // second sees the run the first just created.
    let txCallCount = 0;
    vi.mocked(db.$transaction).mockImplementation((async (fn: unknown) => {
      txCallCount += 1;
      const isFirst = txCallCount === 1;
      const tx = {
        $executeRaw: vi.fn().mockResolvedValue(1),
        run: {
          findFirst: vi
            .fn()
            .mockResolvedValue(isFirst ? null : { id: "r1", status: "PENDING" }),
          create: vi.fn(),
        },
      };
      return (fn as (t: unknown) => unknown)(tx);
    }) as never);
    vi.mocked(createRun).mockResolvedValue({ id: "r1" } as never);
    vi.mocked(enqueueRunReview).mockResolvedValue({ id: "tr_1" } as never);
    vi.mocked(setRunStatus).mockResolvedValue(undefined as never);

    const { POST } = await import("@/app/api/projects/[id]/runs/route");
    const [res1, res2] = await Promise.all([
      POST(
        new NextRequest("http://localhost/api/projects/p1/runs", { method: "POST" }),
        { params: Promise.resolve({ id: "p1" }) },
      ),
      POST(
        new NextRequest("http://localhost/api/projects/p1/runs", { method: "POST" }),
        { params: Promise.resolve({ id: "p1" }) },
      ),
    ]);

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(409);
    const body2 = (await res2.json()) as { error: string; runId: string };
    expect(body2.error).toBe("run_already_active");
    expect(body2.runId).toBe("r1");
    // Critical: createRun + enqueueRunReview MUST have run exactly once,
    // not twice — the lock prevented duplicate LLM spend.
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(enqueueRunReview).toHaveBeenCalledTimes(1);
  });

  // V2 outbound-mode coverage. The runs-start route was extended in M2c so
  // outbound projects skip the corpus check (the discoverer builds the
  // corpus) but still require ≥1 search provider. Hybrid keeps the corpus
  // check + the provider check.
  it("V2 outbound: starts a run without any PARSED corpus items", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({
      id: "p1", ownerId: "u1", question: "Q?",
      searchScope: "outbound", searchProviders: ["openalex", "arxiv"],
    } as never);
    installTxMock({ existingActive: null });
    vi.mocked(createRun).mockResolvedValue({ id: "r1" } as never);
    vi.mocked(enqueueRunReview).mockResolvedValue({ id: "trg_x" } as never);
    vi.mocked(setRunStatus).mockResolvedValue(undefined as never);

    const { POST } = await import("@/app/api/projects/[id]/runs/route");
    const res = await POST(
      new NextRequest("http://localhost/api/projects/p1/runs", { method: "POST" }),
      { params: Promise.resolve({ id: "p1" }) },
    );

    expect(res.status).toBe(201);
    // The discoverer builds the corpus — the corpus check should not run.
    expect(db.corpusItem.count).not.toHaveBeenCalled();
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(enqueueRunReview).toHaveBeenCalledWith("r1");
  });

  it("V2 outbound: rejects 409 when the project has zero search providers", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({
      id: "p1", ownerId: "u1", question: "Q?",
      searchScope: "outbound", searchProviders: [],
    } as never);

    const { POST } = await import("@/app/api/projects/[id]/runs/route");
    const res = await POST(
      new NextRequest("http://localhost/api/projects/p1/runs", { method: "POST" }),
      { params: Promise.resolve({ id: "p1" }) },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/at least one search provider/);
    expect(createRun).not.toHaveBeenCalled();
    expect(enqueueRunReview).not.toHaveBeenCalled();
  });

  it("V2 outbound: returns 503 search_disabled when SEARCH_DISABLED=1 (no planner spend wasted)", async () => {
    envMock.SEARCH_DISABLED = "1";
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({
      id: "p1", ownerId: "u1", question: "Q?",
      searchScope: "outbound", searchProviders: ["openalex"],
    } as never);

    const { POST } = await import("@/app/api/projects/[id]/runs/route");
    const res = await POST(
      new NextRequest("http://localhost/api/projects/p1/runs", { method: "POST" }),
      { params: Promise.resolve({ id: "p1" }) },
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("search_disabled");
    expect(body.message).toMatch(/temporarily disabled/);
    // Crucially: NO run was created + NO trigger enqueued.
    expect(createRun).not.toHaveBeenCalled();
    expect(enqueueRunReview).not.toHaveBeenCalled();
  });

  it("uploaded_only ignores SEARCH_DISABLED (V1 path doesn't touch search providers)", async () => {
    envMock.SEARCH_DISABLED = "1";
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({
      id: "p1", ownerId: "u1", question: "Q?",
      searchScope: "uploaded_only", searchProviders: [],
    } as never);
    vi.mocked(db.corpusItem.count).mockResolvedValue(3 as never);
    installTxMock({ existingActive: null });
    vi.mocked(createRun).mockResolvedValue({ id: "r1" } as never);
    vi.mocked(enqueueRunReview).mockResolvedValue({ id: "trg_x" } as never);

    const { POST } = await import("@/app/api/projects/[id]/runs/route");
    const res = await POST(
      new NextRequest("http://localhost/api/projects/p1/runs", { method: "POST" }),
      { params: Promise.resolve({ id: "p1" }) },
    );

    expect(res.status).toBe(201);
  });

  it("V2 hybrid: rejects 409 when corpus is empty (hybrid still needs uploads)", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({
      id: "p1", ownerId: "u1", question: "Q?",
      searchScope: "hybrid", searchProviders: ["openalex"],
    } as never);
    vi.mocked(db.corpusItem.count).mockResolvedValue(0 as never);

    const { POST } = await import("@/app/api/projects/[id]/runs/route");
    const res = await POST(
      new NextRequest("http://localhost/api/projects/p1/runs", { method: "POST" }),
      { params: Promise.resolve({ id: "p1" }) },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    // Specifically the hybrid-shaped error message (not the uploaded-only one).
    expect(body.error).toMatch(/Hybrid mode|switch the project's search scope/);
    expect(createRun).not.toHaveBeenCalled();
  });
});
