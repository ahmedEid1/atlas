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
  new NextRequest("http://localhost/api/runs/r1/checkpoints/cp1/approve", {
    method: "POST",
    body: JSON.stringify(body),
  });

type TxMockOpts = {
  updateManyCount: 0 | 1;
  rowAfter: { waitToken: string | null; decisionPayload: unknown } | null;
};

/**
 * Wires up `db.$transaction` so it invokes the route callback with a
 * mock tx whose `$executeRaw`, `humanCheckpoint.updateMany`,
 * `findUnique`, and `update` are scripted by the test. Returns the
 * spies so the test can assert exact call counts/arguments.
 */
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

describe("POST /api/runs/[id]/checkpoints/[cpId]/approve", () => {
  it("marks the checkpoint approved and completes the wait token", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "PENDING",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);
    const { txExecuteRaw, txUpdateMany, txUpdate } = installTxMock({
      updateManyCount: 1,
      rowAfter: { waitToken: "tk_xyz", decisionPayload: { approved: true } },
    });

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/approve/route");
    const res = await POST(buildReq({ corpusItemIds: ["c1", "c2"] }), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(200);
    // F3: advisory lock executed inside the tx.
    expect(txExecuteRaw).toHaveBeenCalledTimes(1);
    expect(txUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cp1", status: "PENDING" },
        data: expect.objectContaining({ status: "APPROVED" }),
      }),
    );
    // Happy path uses the LIVE request payload (corpusItemIds flows through).
    expect(resolveWaitToken).toHaveBeenCalledTimes(1);
    expect(resolveWaitToken).toHaveBeenCalledWith(
      "tk_xyz",
      expect.objectContaining({ approved: true, corpusItemIds: ["c1", "c2"] }),
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

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/approve/route");
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
      rowAfter: { waitToken: null, decisionPayload: { approved: true } },
    });

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/approve/route");
    const res = await POST(buildReq({}), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("checkpoint_already_resolved");
    // Lock and PENDING-guarded updateMany still ran (the route always
    // takes the lock + probes); only the side-effect must not fire.
    expect(txExecuteRaw).toHaveBeenCalledTimes(1);
    expect(txUpdateMany).toHaveBeenCalledTimes(1);
    expect(resolveWaitToken).not.toHaveBeenCalled();
  });

  it("F2.2: recovers a stranded wait-token on retry", async () => {
    // A prior attempt updated the DB row (PENDING -> APPROVED) but the
    // resolveWaitToken call crashed (Trigger outage), leaving waitToken
    // non-null. On retry the conditional updateMany returns count=0
    // (status already APPROVED), but the route sees the stranded
    // waitToken inside the lock and replays delivery with the PERSISTED
    // decisionPayload (NOT the empty retry body).
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "APPROVED",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);
    const { txExecuteRaw, txUpdate } = installTxMock({
      updateManyCount: 0,
      rowAfter: {
        waitToken: "tk_stranded",
        decisionPayload: { approved: true, corpusItemIds: ["c1"] },
      },
    });

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/approve/route");
    const res = await POST(buildReq({}), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; recovered: boolean };
    expect(body.recovered).toBe(true);
    expect(txExecuteRaw).toHaveBeenCalledTimes(1);
    // Replays using the PERSISTED decisionPayload, not the (empty) retry body.
    expect(resolveWaitToken).toHaveBeenCalledTimes(1);
    expect(resolveWaitToken).toHaveBeenCalledWith(
      "tk_stranded",
      expect.objectContaining({ approved: true, corpusItemIds: ["c1"] }),
    );
    expect(txUpdate).toHaveBeenCalledWith({
      where: { id: "cp1" },
      data: { waitToken: null },
    });
  });

  it("F3: two concurrent POSTs serialized by the advisory lock deliver EXACTLY ONCE", async () => {
    // Simulates the per-checkpoint advisory lock: the two tx callbacks
    // run serially (caller B sees the side effects of caller A). The
    // mock's `$transaction` enqueues each callback and awaits the
    // previous one before invoking the next, mirroring the real lock's
    // ordering guarantee. Assertion: across two parallel POSTs,
    // resolveWaitToken is called EXACTLY ONCE total — one POST returns
    // 200 (winner) and the other 409 (loser).
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "PENDING",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);

    // Shared "DB" state mutated by the serialized tx callbacks.
    const state = {
      status: "PENDING" as "PENDING" | "APPROVED",
      waitToken: "tk_only" as string | null,
      decisionPayload: null as unknown,
    };

    // Serialize tx callback execution via a chained promise.
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
              state.status = "APPROVED";
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
      // Chain so this callback only runs after the previous one resolves.
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

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/approve/route");
    const [res1, res2] = await Promise.all([
      POST(buildReq({ note: "A" }), {
        params: Promise.resolve({ id: "r1", cpId: "cp1" }),
      }),
      POST(buildReq({ note: "B" }), {
        params: Promise.resolve({ id: "r1", cpId: "cp1" }),
      }),
    ]);

    // EXACTLY ONE delivery across both POSTs — the core exactly-once guarantee.
    expect(resolveWaitToken).toHaveBeenCalledTimes(1);
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]);
  });
});
