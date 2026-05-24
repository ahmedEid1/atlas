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
vi.mock("@/lib/agent/checkpoint-delivery", () => ({
  deliverCheckpoint: vi.fn(),
}));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolveWaitToken } from "@/lib/trigger-client";
import { deliverCheckpoint } from "@/lib/agent/checkpoint-delivery";

beforeEach(() => vi.clearAllMocks());

const buildReq = (body: unknown) =>
  new NextRequest("http://localhost/api/runs/r1/checkpoints/cp1/reject", {
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
};

/**
 * Same Phase-1-only stateful tx mock as checkpoint-approve.test.ts.
 * Phase 2 is now provided by the mocked `deliverCheckpoint` helper
 * (via `installDeliveryHelper`).
 */
function installStatefulTxMock(
  initial: Partial<TxState> & { status: TxState["status"]; waitToken: string | null },
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

/**
 * Mocks the shared `deliverCheckpoint` helper to behave against the
 * in-memory state (read persisted decisionPayload, call resolveWaitToken,
 * null the token). Optional `onNullOut` simulates a partial-failure
 * rollback after Trigger has already been called.
 */
function installDeliveryHelper(
  state: TxState,
  options?: { onNullOut?: (state: TxState) => Promise<void> | void },
) {
  vi.mocked(deliverCheckpoint).mockImplementation(async () => {
    if (state.waitToken === null && state.status === "PENDING") {
      return { outcome: "not_found" };
    }
    if (state.waitToken === null) {
      return { outcome: "already_delivered" };
    }
    const token = state.waitToken;
    await resolveWaitToken(
      token,
      (state.decisionPayload ?? {}) as Record<string, unknown>,
    );
    if (options?.onNullOut) {
      await options.onNullOut(state);
    }
    state.waitToken = null;
    return { outcome: "delivered" };
  });
}

describe("POST /api/runs/[id]/checkpoints/[cpId]/reject", () => {
  it("Phase 1 + Phase 2: marks the checkpoint rejected and delivers the persisted payload", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "PENDING",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);
    const { state, spies } = installStatefulTxMock({
      status: "PENDING",
      waitToken: "tk_xyz",
    });
    installDeliveryHelper(state);

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/reject/route");
    const res = await POST(buildReq({ reason: "off-topic" }), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(spies.executeRaw).toHaveBeenCalledTimes(1);
    expect(spies.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cp1", status: "PENDING" },
        data: expect.objectContaining({
          status: "REJECTED",
          rejectionReason: "off-topic",
        }),
      }),
    );
    expect(deliverCheckpoint).toHaveBeenCalledTimes(1);
    expect(deliverCheckpoint).toHaveBeenCalledWith("cp1");
    expect(resolveWaitToken).toHaveBeenCalledTimes(1);
    expect(resolveWaitToken).toHaveBeenCalledWith(
      "tk_xyz",
      expect.objectContaining({ approved: false, rejectionReason: "off-topic" }),
    );
    expect(state.waitToken).toBeNull();
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
    expect(deliverCheckpoint).not.toHaveBeenCalled();
  });

  it("returns 409 when a prior caller fully resolved (waitToken null)", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "REJECTED",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);
    const { state } = installStatefulTxMock({
      status: "REJECTED",
      waitToken: null,
      decisionPayload: { approved: false, rejectionReason: "prior" },
    });
    installDeliveryHelper(state);

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/reject/route");
    const res = await POST(buildReq({ reason: "x" }), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("checkpoint_already_resolved");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(deliverCheckpoint).toHaveBeenCalledTimes(1);
    expect(resolveWaitToken).not.toHaveBeenCalled();
  });

  it("F2.2: recovers a stranded wait-token on retry (Phase 1 no-ops, Phase 2 delivers persisted payload)", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "REJECTED",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);
    const { state } = installStatefulTxMock({
      status: "REJECTED",
      waitToken: "tk_stranded",
      decisionPayload: { approved: false, rejectionReason: "off-topic" },
      rejectionReason: "off-topic",
    });
    installDeliveryHelper(state);

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/reject/route");
    const res = await POST(buildReq({ reason: "retry" }), {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; recovered: boolean };
    expect(body.recovered).toBe(true);
    // Replays using the PERSISTED decisionPayload, not the retry body.
    expect(resolveWaitToken).toHaveBeenCalledTimes(1);
    expect(resolveWaitToken).toHaveBeenCalledWith(
      "tk_stranded",
      expect.objectContaining({ approved: false, rejectionReason: "off-topic" }),
    );
    expect(state.waitToken).toBeNull();
  });

  it("REGRESSION: audit log cannot diverge — REJECT then APPROVE retry preserves the original REJECT payload", async () => {
    // Mirror of the approve regression test, but with roles reversed:
    // first call REJECTs successfully through Phase 1 + Trigger, then
    // the null-out throws. A second APPROVE retry arrives; it must
    // NOT flip the DB to APPROVED, and Trigger must be re-delivered
    // with the original REJECT payload. deliverCheckpoint takes no
    // external payload param, so the helper is structurally incapable
    // of substituting the approve body.
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "PENDING",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);

    let nullOutAttempts = 0;
    const { state } = installStatefulTxMock({ status: "PENDING", waitToken: "tk_y" });
    installDeliveryHelper(state, {
      onNullOut: async () => {
        nullOutAttempts++;
        if (nullOutAttempts === 1) {
          throw new Error("db connection lost");
        }
      },
    });

    const { POST: REJECT_POST } = await import(
      "@/app/api/runs/[id]/checkpoints/[cpId]/reject/route"
    );
    await expect(
      REJECT_POST(buildReq({ reason: "first-reject" }), {
        params: Promise.resolve({ id: "r1", cpId: "cp1" }),
      }),
    ).rejects.toThrow("db connection lost");

    expect(state.status).toBe("REJECTED");
    expect(state.waitToken).toBe("tk_y");
    expect(state.decisionPayload).toEqual(
      expect.objectContaining({ approved: false, rejectionReason: "first-reject" }),
    );
    expect(state.rejectionReason).toBe("first-reject");
    expect(resolveWaitToken).toHaveBeenCalledTimes(1);
    expect(resolveWaitToken).toHaveBeenNthCalledWith(
      1,
      "tk_y",
      expect.objectContaining({ approved: false, rejectionReason: "first-reject" }),
    );

    // Second call: APPROVE retry with a different body. Must NOT flip
    // the DB and must re-deliver the original REJECT payload.
    const { POST: APPROVE_POST } = await import(
      "@/app/api/runs/[id]/checkpoints/[cpId]/approve/route"
    );
    const approveReq = new NextRequest(
      "http://localhost/api/runs/r1/checkpoints/cp1/approve",
      { method: "POST", body: JSON.stringify({ choice: "Z" }) },
    );
    const res2 = await APPROVE_POST(approveReq, {
      params: Promise.resolve({ id: "r1", cpId: "cp1" }),
    });

    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { ok: boolean; recovered?: boolean };
    expect(body2.recovered).toBe(true);

    // No divergence: DB still REJECTED with the original payload.
    expect(state.status).toBe("REJECTED");
    expect(state.decisionPayload).toEqual(
      expect.objectContaining({ approved: false, rejectionReason: "first-reject" }),
    );
    // approve body never reached the payload.
    expect(state.decisionPayload).not.toHaveProperty("choice");

    // Trigger received the REJECT payload on BOTH calls.
    expect(resolveWaitToken).toHaveBeenCalledTimes(2);
    expect(resolveWaitToken).toHaveBeenNthCalledWith(
      2,
      "tk_y",
      expect.objectContaining({ approved: false, rejectionReason: "first-reject" }),
    );
    for (const call of vi.mocked(resolveWaitToken).mock.calls) {
      const payload = call[1] as Record<string, unknown>;
      expect(payload.approved).toBe(false);
      expect(payload).not.toHaveProperty("choice");
    }

    expect(state.waitToken).toBeNull();
  });

  it("F3: two concurrent POSTs serialized by the advisory lock deliver EXACTLY ONCE", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", isGuest: false } as never);
    vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({
      id: "cp1",
      status: "PENDING",
      run: { id: "r1", project: { ownerId: "u1" } },
    } as never);
    const { state } = installStatefulTxMock({ status: "PENDING", waitToken: "tk_only" });
    installDeliveryHelper(state);

    const { POST } = await import("@/app/api/runs/[id]/checkpoints/[cpId]/reject/route");
    const [res1, res2] = await Promise.all([
      POST(buildReq({ reason: "A" }), {
        params: Promise.resolve({ id: "r1", cpId: "cp1" }),
      }),
      POST(buildReq({ reason: "B" }), {
        params: Promise.resolve({ id: "r1", cpId: "cp1" }),
      }),
    ]);

    expect(resolveWaitToken).toHaveBeenCalledTimes(1);
    const statuses = [res1.status, res2.status].sort();
    expect([
      [200, 200],
      [200, 409],
    ]).toContainEqual(statuses);
  });
});
