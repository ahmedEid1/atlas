import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger };
});

vi.mock("@trigger.dev/sdk", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@trigger.dev/sdk");
  return {
    ...actual,
    // schedules.task returns the config object so we can call .run({}) in tests.
    schedules: {
      task: (cfg: { run: (payload: unknown) => Promise<unknown> }) => cfg,
    },
    logger: mocks.logger,
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    humanCheckpoint: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/agent/checkpoint-delivery", () => ({
  deliverCheckpoint: vi.fn(),
}));

import { db } from "@/lib/db";
import { deliverCheckpoint } from "@/lib/agent/checkpoint-delivery";

beforeEach(() => {
  vi.clearAllMocks();
});

async function loadTask() {
  const mod = await import("@/trigger/checkpoint-delivery-outbox");
  return mod.checkpointDeliveryOutboxTask as unknown as {
    id: string;
    cron: string;
    run: () => Promise<{
      considered: number;
      delivered: number;
      alreadyDelivered: number;
      errors: number;
    }>;
  };
}

describe("checkpoint-delivery-outbox task", () => {
  it("is scheduled every minute and has the expected id", async () => {
    const task = await loadTask();
    expect(task.id).toBe("checkpoint-delivery-outbox");
    expect(task.cron).toBe("* * * * *");
  });

  it("logs and returns zeros when no stranded checkpoints exist", async () => {
    vi.mocked(db.humanCheckpoint.findMany).mockResolvedValue([] as never);

    const task = await loadTask();
    const result = await task.run();

    expect(result).toEqual({
      considered: 0,
      delivered: 0,
      alreadyDelivered: 0,
      errors: 0,
    });
    expect(deliverCheckpoint).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalledWith(
      "checkpoint-outbox: nothing to deliver",
    );
  });

  it("processes a batch: 2 delivered, 1 already_delivered, 0 errors", async () => {
    vi.mocked(db.humanCheckpoint.findMany).mockResolvedValue([
      { id: "cp1", runId: "r1", status: "APPROVED", createdAt: new Date(), decidedAt: new Date() },
      { id: "cp2", runId: "r1", status: "REJECTED", createdAt: new Date(), decidedAt: new Date() },
      { id: "cp3", runId: "r2", status: "APPROVED", createdAt: new Date(), decidedAt: new Date() },
    ] as never);
    vi.mocked(deliverCheckpoint)
      .mockResolvedValueOnce({ outcome: "delivered" })
      .mockResolvedValueOnce({ outcome: "delivered" })
      .mockResolvedValueOnce({ outcome: "already_delivered" });

    const task = await loadTask();
    const result = await task.run();

    expect(result).toEqual({
      considered: 3,
      delivered: 2,
      alreadyDelivered: 1,
      errors: 0,
    });
    expect(deliverCheckpoint).toHaveBeenCalledTimes(3);
    expect(deliverCheckpoint).toHaveBeenNthCalledWith(1, "cp1");
    expect(deliverCheckpoint).toHaveBeenNthCalledWith(2, "cp2");
    expect(deliverCheckpoint).toHaveBeenNthCalledWith(3, "cp3");
  });

  it("isolates a failing delivery — other rows still process and errors are counted", async () => {
    vi.mocked(db.humanCheckpoint.findMany).mockResolvedValue([
      { id: "cp1", runId: "r1", status: "APPROVED", createdAt: new Date(), decidedAt: new Date() },
      { id: "cp2", runId: "r1", status: "REJECTED", createdAt: new Date(), decidedAt: new Date() },
      { id: "cp3", runId: "r2", status: "APPROVED", createdAt: new Date(), decidedAt: new Date() },
    ] as never);
    vi.mocked(deliverCheckpoint)
      .mockResolvedValueOnce({ outcome: "delivered" })
      .mockRejectedValueOnce(new Error("Trigger 503"))
      .mockResolvedValueOnce({ outcome: "delivered" });

    const task = await loadTask();
    const result = await task.run();

    expect(result).toEqual({
      considered: 3,
      delivered: 2,
      alreadyDelivered: 0,
      errors: 1,
    });
    // All three rows were attempted — the throw on cp2 did NOT abort the loop.
    expect(deliverCheckpoint).toHaveBeenCalledTimes(3);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "checkpoint-outbox: delivery failed",
      expect.objectContaining({
        checkpointId: "cp2",
        runId: "r1",
        reason: "Trigger 503",
      }),
    );
  });

  it("queries with the stranded filter (status != PENDING AND waitToken NOT NULL), capped at 50 by decidedAt asc", async () => {
    vi.mocked(db.humanCheckpoint.findMany).mockResolvedValue([] as never);

    const task = await loadTask();
    await task.run();

    expect(db.humanCheckpoint.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { not: "PENDING" },
          waitToken: { not: null },
        },
        take: 50,
        orderBy: { decidedAt: "asc" },
      }),
    );
  });
});
