import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    humanCheckpoint: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/trigger-client", () => ({
  resolveWaitToken: vi.fn(),
  enqueueRunReview: vi.fn(),
  enqueueParsePdf: vi.fn(),
  enqueueSummarizePaper: vi.fn(),
}));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolveWaitToken } from "@/lib/trigger-client";

beforeEach(() => vi.clearAllMocks());

const buildReq = (body: unknown) =>
  new NextRequest("http://localhost/api/runs/r1/checkpoints/cp1/reject", {
    method: "POST",
    body: JSON.stringify(body),
  });

type TxMockOpts = {
  updateManyCount: 0 | 1;
  rowAfter: { waitToken: string | null; decisionPayload: unknown } | null;
};

function installTxMock(opts: TxMockOpts) {
  const txExecuteRaw = vi.fn().mockResolvedValue(1);
  const txUpdateMany = vi
    .fn()
    .mockResolvedValue({ count: opts.updateManyCount });
  const txFindUnique = vi.fn().mockResolvedValue(opts.rowAfter);
  const txUpdate = vi.fn().mockResolvedValue({});
  vi.mocked(db.$transaction).mockImplementation((async (fn: unknown) => {
    const tx = {
      $executeRaw: txExecuteRaw,
      humanCheckpoint: {
        updateMany: txUpdateMany,
        findUnique: txFindUnique,
        update: txUpdate,
      },
    };
    return (fn as (t: unknown) => unknown)(tx);
  }) as never);
  return { txExecuteRaw, txUpdateMany, txFindUnique, txUpdate };
}

describe("POST /api/runs/[id]/checkpoints/[cpId]/reject", () => {
  it("marks the checkpoint rejected and completes the wait token", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "PENDING",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);
    const { txExecuteRaw, txUpdateMany, txUpdate } = installTxMock({
      updateManyCount: 1,
      rowAfter: {
        waitToken: "tk_xyz",
        decisionPayload: { approved: false, rejectionReason: "off-topic" },
      },
    });

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/reject/route");
    const res = await POST(buildReq({ reason: "off-topic" }), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(200);
    // F3: advisory lock executed inside the tx.
    expect(txExecuteRaw).toHaveBeenCalledTimes(1);
    expect(txUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cp1", status: "PENDING" },
        data: expect.objectContaining({
          status: "REJECTED",
          rejectionReason: "off-topic",
        }),
      }),
    );
    expect(resolveWaitToken).toHaveBeenCalledTimes(1);
    expect(resolveWaitToken).toHaveBeenCalledWith(
      "tk_xyz",
      expect.objectContaining({ approved: false, rejectionReason: "off-topic" }),
    );
    // F2.1: waitToken nulled after successful delivery.
    expect(txUpdate).toHaveBeenCalledWith({
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

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/reject/route");
    const res = await POST(buildReq({}), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(404);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("returns 409 and does NOT complete the wait token when a prior caller fully resolved (waitToken null)", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "PENDING",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);
    const { txExecuteRaw, txUpdateMany } = installTxMock({
      updateManyCount: 0,
      rowAfter: { waitToken: null, decisionPayload: { approved: false } },
    });

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/reject/route");
    const res = await POST(buildReq({ reason: "x" }), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("checkpoint_already_resolved");
    expect(txExecuteRaw).toHaveBeenCalledTimes(1);
    expect(txUpdateMany).toHaveBeenCalledTimes(1);
    expect(resolveWaitToken).not.toHaveBeenCalled();
  });

  it("F2.2: recovers a stranded wait-token on retry", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "REJECTED",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);
    const { txExecuteRaw, txUpdate } = installTxMock({
      updateManyCount: 0,
      rowAfter: {
        waitToken: "tk_stranded",
        decisionPayload: { approved: false, rejectionReason: "off-topic" },
      },
    });

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/reject/route");
    const res = await POST(buildReq({ reason: "retry" }), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; recovered: boolean };
    expect(body.recovered).toBe(true);
    expect(txExecuteRaw).toHaveBeenCalledTimes(1);
    // Replays using the PERSISTED decisionPayload, not the retry body.
    expect(resolveWaitToken).toHaveBeenCalledTimes(1);
    expect(resolveWaitToken).toHaveBeenCalledWith(
      "tk_stranded",
      expect.objectContaining({ approved: false, rejectionReason: "off-topic" }),
    );
    expect(txUpdate).toHaveBeenCalledWith({
      where: { id: "cp1" },
      data: { waitToken: null },
    });
  });

  it("F3: two concurrent POSTs serialized by the advisory lock deliver EXACTLY ONCE", async () => {
    // See the matching test in checkpoint-approve.test.ts for full
    // rationale. Mirrors REJECTED state transitions.
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "PENDING",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);

    const state = {
      status: "PENDING" as "PENDING" | "REJECTED",
      waitToken: "tk_only" as string | null,
      decisionPayload: null as unknown,
    };

    let lockChain: Promise<unknown> = Promise.resolve();
    vi.mocked(db.$transaction).mockImplementation((async (fn: unknown) => {
      const tx = {
        $executeRaw: vi.fn().mockResolvedValue(1),
        humanCheckpoint: {
          updateMany: vi.fn().mockImplementation(async (args: {
            where: { status?: string };
            data: { decisionPayload?: unknown };
          }) => {
            if (state.status === "PENDING" && args.where.status === "PENDING") {
              state.status = "REJECTED";
              state.decisionPayload = args.data.decisionPayload;
              return { count: 1 };
            }
            return { count: 0 };
          }),
          findUnique: vi.fn().mockImplementation(async () => ({
            waitToken: state.waitToken,
            decisionPayload: state.decisionPayload,
          })),
          update: vi.fn().mockImplementation(async (args: {
            data: { waitToken?: string | null };
          }) => {
            if (args.data.waitToken === null) state.waitToken = null;
            return {};
          }),
        },
      };
      const prev = lockChain;
      let release!: () => void;
      lockChain = new Promise<void>((r) => {
        release = r;
      });
      await prev;
      try {
        return await (fn as (t: unknown) => unknown)(tx);
      } finally {
        release();
      }
    }) as never);

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/reject/route");
    const [res1, res2] = await Promise.all([
      POST(buildReq({ reason: "A" }), {
        params: Promise.resolve({ id: "r1", cpId: "cp1" }),
      }),
      POST(buildReq({ reason: "B" }), {
        params: Promise.resolve({ id: "r1", cpId: "cp1" }),
      }),
    ]);

    // EXACTLY ONE delivery across both POSTs.
    expect(resolveWaitToken).toHaveBeenCalledTimes(1);
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]);
  });
});
