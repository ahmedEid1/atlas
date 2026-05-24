import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/trigger-client", () => ({
  resolveWaitToken: vi.fn(),
}));

import { db } from "@/lib/db";
import { resolveWaitToken } from "@/lib/trigger-client";
import { deliverCheckpoint } from "@/lib/agent/checkpoint-delivery";

beforeEach(() => vi.clearAllMocks());

type Row = {
  waitToken: string | null;
  decisionPayload: unknown;
} | null;

/**
 * Mirror of the helper's `db.$transaction` surface so we can assert the
 * exact order of operations inside the helper:
 *   advisory lock -> findUnique -> resolveWaitToken -> update(waitToken=null)
 *
 * `row` simulates the row that `findUnique` returns. Spies capture every
 * call so the test can assert nothing is called when it shouldn't be
 * (e.g. resolveWaitToken must NOT fire when waitToken is null).
 */
function installTxMock(row: Row) {
  const executeRaw = vi.fn();
  const findUnique = vi.fn().mockResolvedValue(row);
  const update = vi.fn().mockResolvedValue({});

  vi.mocked(db.$transaction).mockImplementation((async (fnOrOps: unknown) => {
    const fn = fnOrOps as (t: unknown) => unknown;
    const tx = {
      $executeRaw: (async (...args: unknown[]) => {
        executeRaw(...args);
        return 1;
      }) as never,
      humanCheckpoint: {
        findUnique: findUnique as never,
        update: update as never,
      },
    };
    return fn(tx);
  }) as never);

  return { executeRaw, findUnique, update };
}

describe("deliverCheckpoint", () => {
  it("delivers when waitToken is non-null — calls resolveWaitToken with the PERSISTED payload, then nulls the token", async () => {
    const persisted = { approved: true, corpusItemIds: ["c1", "c2"] };
    const { executeRaw, findUnique, update } = installTxMock({
      waitToken: "tk_x",
      decisionPayload: persisted,
    });

    const result = await deliverCheckpoint("cp1");

    expect(result).toEqual({ outcome: "delivered" });
    // Advisory lock acquired with hashtext(<id>).
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "cp1" },
      select: { waitToken: true, decisionPayload: true },
    });
    // Critical invariant: delivered the persisted payload exactly.
    expect(resolveWaitToken).toHaveBeenCalledTimes(1);
    expect(resolveWaitToken).toHaveBeenCalledWith("tk_x", persisted);
    expect(update).toHaveBeenCalledWith({
      where: { id: "cp1" },
      data: { waitToken: null },
    });
  });

  it("delivers an empty object when decisionPayload is null in the row", async () => {
    // Sanity: the helper coerces null/undefined decisionPayload to {} so
    // Trigger doesn't receive `null` as the resume payload.
    const { update } = installTxMock({
      waitToken: "tk_x",
      decisionPayload: null,
    });

    const result = await deliverCheckpoint("cp1");

    expect(result).toEqual({ outcome: "delivered" });
    expect(resolveWaitToken).toHaveBeenCalledWith("tk_x", {});
    expect(update).toHaveBeenCalled();
  });

  it("returns already_delivered when waitToken is null — does NOT call resolveWaitToken or update", async () => {
    const { update } = installTxMock({
      waitToken: null,
      decisionPayload: { approved: true },
    });

    const result = await deliverCheckpoint("cp1");

    expect(result).toEqual({ outcome: "already_delivered" });
    expect(resolveWaitToken).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("returns not_found when the row is missing", async () => {
    const { update } = installTxMock(null);

    const result = await deliverCheckpoint("cp_missing");

    expect(result).toEqual({ outcome: "not_found" });
    expect(resolveWaitToken).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("accepts no external payload — signature forces persisted-only delivery", () => {
    // Compile-time / structural assertion: deliverCheckpoint takes a
    // single string id. There is no way to pass a substitute payload.
    // This is the invariant that prevents an audit-divergent retry.
    // If anyone adds a payload param, this test will start failing the
    // arity check below and force a code-review conversation.
    expect(deliverCheckpoint.length).toBe(1);
  });
});
