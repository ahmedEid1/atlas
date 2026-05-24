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

type TxState = {
  status: "PENDING" | "APPROVED" | "REJECTED";
  waitToken: string | null;
  decisionPayload: unknown;
  rejectionReason: string | null;
};

type TxSpies = {
  executeRaw: ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>;
  updateMany: ReturnType<typeof vi.fn<(args: unknown) => unknown>>;
  findUnique: ReturnType<typeof vi.fn<(args: unknown) => unknown>>;
  update: ReturnType<typeof vi.fn<(args: unknown) => unknown>>;
};

/**
 * Installs a stateful `db.$transaction` mock that mirrors the real
 * two-transaction route flow against an in-memory row. Both Phase 1
 * and Phase 2 invocations share the same state, so a Phase 1 commit
 * is visible to Phase 2 (and to any later request). The callbacks are
 * chained so concurrent calls observe each other's writes — the
 * advisory lock's serialization guarantee.
 *
 * `updateBehavior` lets a test inject a side-effect (e.g. throw) into
 * the waitToken null-out step to simulate a rollback after Trigger has
 * already been called.
 */
function installStatefulTxMock(
  initial: Partial<TxState> & { status: TxState["status"]; waitToken: string | null },
  options?: {
    updateBehavior?: (
      args: { where: { id: string }; data: { waitToken?: string | null } },
      state: TxState,
    ) => Promise<unknown> | unknown;
  },
) {
  const state: TxState = {
    status: initial.status,
    waitToken: initial.waitToken,
    decisionPayload: initial.decisionPayload ?? null,
    rejectionReason: initial.rejectionReason ?? null,
  };
  const spies: TxSpies = {
    executeRaw: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  };

  let lockChain: Promise<unknown> = Promise.resolve();
  vi.mocked(db.$transaction).mockImplementation((async (fnOrOps: unknown) => {
    const fn = fnOrOps as (t: unknown) => unknown;
    const tx = {
      $executeRaw: (async (...args: unknown[]) => {
        spies.executeRaw(...args);
        return 1;
      }) as never,
      humanCheckpoint: {
        updateMany: (async (args: {
          where: { id: string; status?: string };
          data: {
            status?: TxState["status"];
            decisionPayload?: unknown;
            rejectionReason?: string;
          };
        }) => {
          spies.updateMany(args);
          if (
            args.where.status === undefined ||
            args.where.status === state.status
          ) {
            if (args.data.status) state.status = args.data.status;
            if (args.data.decisionPayload !== undefined) {
              state.decisionPayload = args.data.decisionPayload;
            }
            if (args.data.rejectionReason !== undefined) {
              state.rejectionReason = args.data.rejectionReason;
            }
            return { count: 1 };
          }
          return { count: 0 };
        }) as never,
        findUnique: (async (args: { where: { id: string } }) => {
          spies.findUnique(args);
          return {
            waitToken: state.waitToken,
            decisionPayload: state.decisionPayload,
            status: state.status,
          };
        }) as never,
        update: (async (args: {
          where: { id: string };
          data: { waitToken?: string | null };
        }) => {
          spies.update(args);
          if (options?.updateBehavior) {
            await options.updateBehavior(args, state);
          }
          if (args.data.waitToken === null) state.waitToken = null;
          return {};
        }) as never,
      },
    };
    const prev = lockChain;
    let release!: () => void;
    lockChain = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn(tx);
    } finally {
      release();
    }
  }) as never);

  return { state, spies };
}

describe("POST /api/runs/[id]/checkpoints/[cpId]/approve", () => {
  it("Phase 1 + Phase 2: marks the checkpoint approved and delivers the persisted payload", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "PENDING",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);
    const { spies } = installStatefulTxMock({
      status: "PENDING",
      waitToken: "tk_xyz",
    });

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/approve/route");
    const res = await POST(buildReq({ corpusItemIds: ["c1", "c2"] }), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(200);
    // Two transactions: Phase 1 (commit) + Phase 2 (deliver).
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    // Advisory lock held in BOTH transactions.
    expect(spies.executeRaw).toHaveBeenCalledTimes(2);
    // Phase 1 wrote the request's live payload through updateMany.
    expect(spies.updateMany).toHaveBeenCalledTimes(1);
    expect(spies.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cp1", status: "PENDING" },
        data: expect.objectContaining({
          status: "APPROVED",
          decisionPayload: expect.objectContaining({
            approved: true,
            corpusItemIds: ["c1", "c2"],
          }),
        }),
      }),
    );
    // Phase 2 read the row and delivered the PERSISTED payload to Trigger.
    expect(resolveWaitToken).toHaveBeenCalledTimes(1);
    expect(resolveWaitToken).toHaveBeenCalledWith(
      "tk_xyz",
      expect.objectContaining({ approved: true, corpusItemIds: ["c1", "c2"] }),
    );
    expect(spies.update).toHaveBeenCalledWith({
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

  it("returns 409 when a prior caller fully resolved (waitToken null)", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "APPROVED",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);
    const { spies } = installStatefulTxMock({
      status: "APPROVED",
      waitToken: null,
      decisionPayload: { approved: true },
    });

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/approve/route");
    const res = await POST(buildReq({}), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("checkpoint_already_resolved");
    // Both Phase 1 + Phase 2 ran; Phase 1's updateMany matched 0 rows
    // (status != PENDING) and Phase 2 saw waitToken=null.
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(spies.executeRaw).toHaveBeenCalledTimes(2);
    expect(resolveWaitToken).not.toHaveBeenCalled();
  });

  it("F2.2: recovers a stranded wait-token on retry (Phase 1 no-ops, Phase 2 delivers persisted payload)", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "APPROVED",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);
    const { spies } = installStatefulTxMock({
      status: "APPROVED",
      waitToken: "tk_stranded",
      decisionPayload: { approved: true, corpusItemIds: ["c1"] },
    });

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/approve/route");
    const res = await POST(buildReq({}), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; recovered: boolean };
    expect(body.recovered).toBe(true);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    // Phase 2 replayed with the PERSISTED decisionPayload, not the empty retry body.
    expect(resolveWaitToken).toHaveBeenCalledTimes(1);
    expect(resolveWaitToken).toHaveBeenCalledWith(
      "tk_stranded",
      expect.objectContaining({ approved: true, corpusItemIds: ["c1"] }),
    );
    expect(spies.update).toHaveBeenCalledWith({
      where: { id: "cp1" },
      data: { waitToken: null },
    });
  });

  it("REGRESSION: audit log cannot diverge from agent payload when Phase 2 partially fails", async () => {
    // Scenario from Codex round 4: the first call (APPROVE with body A)
    // commits Phase 1 then calls Trigger successfully, but the
    // waitToken null-out throws and the tx rolls back — so waitToken
    // is still set. A second call (REJECT with body B) arrives.
    //
    // Under the old single-tx code, the retry would re-execute the
    // whole flow with its own payload, overwriting decisionPayload to
    // B and calling Trigger with B. Trigger's own idempotency would
    // ignore B (token already completed) — but the DB would
    // permanently record REJECTED with payload B even though the
    // agent ran with APPROVED payload A. Audit divergence.
    //
    // Under the new two-tx code, the REJECT retry's Phase 1 sees
    // status != PENDING and writes NOTHING. Phase 2 reads the
    // persisted APPROVED payload A and re-delivers it. The DB stays
    // APPROVED with payload A; the agent saw payload A. No divergence.
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "PENDING",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);

    // First call: APPROVE — Phase 1 succeeds, Phase 2's null-out throws,
    // rolling back waitToken. Use updateBehavior to throw on the
    // null-out call (which happens AFTER resolveWaitToken in Phase 2).
    let nullOutAttempts = 0;
    const { state, spies } = installStatefulTxMock(
      { status: "PENDING", waitToken: "tk_x" },
      {
        updateBehavior: async (args) => {
          if (args.data.waitToken === null) {
            nullOutAttempts++;
            if (nullOutAttempts === 1) {
              // First null-out (during APPROVE) throws — simulate
              // tx rollback by NOT applying it. The default impl
              // would have set state.waitToken = null; by throwing
              // here we both skip that and cause the route's
              // Phase 2 tx to reject.
              throw new Error("db connection lost");
            }
          }
        },
      },
    );

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/approve/route");
    await expect(
      POST(buildReq({ choice: "A" }), {
        params: Promise.resolve({ id: "r1", cpId: "cp1" }),
      }),
    ).rejects.toThrow("db connection lost");

    // After the failed APPROVE: DB is APPROVED with payload A; waitToken
    // is still "tk_x" (rollback preserved). resolveWaitToken WAS called
    // with payload A (the agent saw A).
    expect(state.status).toBe("APPROVED");
    expect(state.waitToken).toBe("tk_x");
    expect(state.decisionPayload).toEqual(
      expect.objectContaining({ approved: true, choice: "A" }),
    );
    expect(resolveWaitToken).toHaveBeenCalledTimes(1);
    expect(resolveWaitToken).toHaveBeenNthCalledWith(
      1,
      "tk_x",
      expect.objectContaining({ approved: true, choice: "A" }),
    );

    // Second call: REJECT retry with a DIFFERENT body. This must NOT
    // overwrite the DB to REJECTED, and Trigger must be re-delivered
    // with the ORIGINAL APPROVE payload, not the reject body.
    const { POST: REJECT_POST } = await import(
      "@/app/api/runs/[id]/checkpoints/[cpId]/reject/route"
    );
    const rejectReq = new NextRequest(
      "http://localhost/api/runs/r1/checkpoints/cp1/reject",
      { method: "POST", body: JSON.stringify({ reason: "B" }) },
    );
    const res2 = await REJECT_POST(rejectReq, {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });

    // The retry recovered the stranded delivery.
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { ok: boolean; recovered?: boolean };
    expect(body2.recovered).toBe(true);

    // CRITICAL ASSERTIONS — no audit divergence:
    // 1. The DB remains APPROVED with payload A. The REJECT request's
    //    Phase 1 was a no-op because status != PENDING.
    expect(state.status).toBe("APPROVED");
    expect(state.decisionPayload).toEqual(
      expect.objectContaining({ approved: true, choice: "A" }),
    );
    // The reject's rejectionReason was NOT written.
    expect(state.rejectionReason).toBeNull();

    // 2. resolveWaitToken was called twice — but BOTH calls used the
    //    persisted APPROVE payload A. The reject body never reached
    //    Trigger. This is the audit-divergence-prevented assertion.
    expect(resolveWaitToken).toHaveBeenCalledTimes(2);
    expect(resolveWaitToken).toHaveBeenNthCalledWith(
      2,
      "tk_x",
      expect.objectContaining({ approved: true, choice: "A" }),
    );
    // Neither call carried the reject body.
    for (const call of vi.mocked(resolveWaitToken).mock.calls) {
      const payload = call[1] as Record<string, unknown>;
      expect(payload.approved).toBe(true);
      expect(payload).not.toHaveProperty("rejectionReason");
    }

    // 3. waitToken is now null (the second null-out attempt succeeded).
    expect(state.waitToken).toBeNull();
    // Sanity: updateMany was called twice total (once per request),
    // but only the FIRST one had count=1; the second matched 0 rows.
    expect(spies.updateMany).toHaveBeenCalledTimes(2);
  });

  it("F3: two concurrent POSTs serialized by the advisory lock deliver EXACTLY ONCE", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "PENDING",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);
    installStatefulTxMock({ status: "PENDING", waitToken: "tk_only" });

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/approve/route");
    const [res1, res2] = await Promise.all([
      POST(buildReq({ note: "A" }), {
        params: Promise.resolve({ id: "r1", cpId: "cp1" }),
      }),
      POST(buildReq({ note: "B" }), {
        params: Promise.resolve({ id: "r1", cpId: "cp1" }),
      }),
    ]);

    // EXACTLY ONE delivery across both POSTs — the core exactly-once
    // guarantee survives the two-tx split. Acceptable outcomes per
    // the route table: winner 200; loser 200 (recovered) or 409.
    expect(resolveWaitToken).toHaveBeenCalledTimes(1);
    const statuses = [res1.status, res2.status].sort();
    // Winner is always 200; loser is 200 (recovered) or 409.
    expect([
      [200, 200],
      [200, 409],
    ]).toContainEqual(statuses);
  });
});
