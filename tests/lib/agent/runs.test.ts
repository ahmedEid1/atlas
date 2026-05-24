import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    run: {
      create: vi.fn(),
      update: vi.fn(),
    },
    runStep: {
      create: vi.fn(),
      update: vi.fn(),
    },
    humanCheckpoint: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
    includedPaper: {
      createMany: vi.fn(),
      findMany: vi.fn(),
    },
    extractedClaim: {
      createMany: vi.fn(),
    },
    corpusItem: {
      findUnique: vi.fn(),
    },
  },
}));

import { db } from "@/lib/db";

beforeEach(() => vi.clearAllMocks());

describe("runs helpers", () => {
  it("createRun creates a row with PENDING status", async () => {
    vi.mocked(db.run.create).mockResolvedValue({ id: "r1" } as never);
    const { createRun } = await import("@/lib/agent/runs");
    const r = await createRun({ projectId: "p1", question: "Q?" });
    expect(r.id).toBe("r1");
    expect(db.run.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ projectId: "p1", question: "Q?", status: "PENDING" }) }),
    );
  });

  it("addStep returns the created step id", async () => {
    vi.mocked(db.runStep.create).mockResolvedValue({ id: "step_1" } as never);
    const { addStep } = await import("@/lib/agent/runs");
    const s = await addStep({ runId: "r1", nodeName: "planner" });
    expect(s.id).toBe("step_1");
  });

  it("finishStep updates the row with token usage and trace url", async () => {
    const { finishStep } = await import("@/lib/agent/runs");
    await finishStep({
      stepId: "step_1",
      traceUrl: "http://lf/x",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 80,
    });
    expect(db.runStep.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "step_1" },
        data: expect.objectContaining({
          traceUrl: "http://lf/x",
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 80,
          endedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("findCorpusMarkdown returns parsedMarkdown when PARSED", async () => {
    vi.mocked(db.corpusItem.findUnique).mockResolvedValue({
      id: "c1",
      status: "PARSED",
      parsedMarkdown: "# Paper",
    } as never);
    const { findCorpusMarkdown } = await import("@/lib/agent/runs");
    expect(await findCorpusMarkdown("c1")).toBe("# Paper");
  });

  it("findCorpusMarkdown returns null when not PARSED", async () => {
    vi.mocked(db.corpusItem.findUnique).mockResolvedValue({
      id: "c1",
      status: "PARSING",
      parsedMarkdown: null,
    } as never);
    const { findCorpusMarkdown } = await import("@/lib/agent/runs");
    expect(await findCorpusMarkdown("c1")).toBeNull();
  });

  it("recordCheckpoint persists a PENDING checkpoint with the proposal payload", async () => {
    vi.mocked(db.humanCheckpoint.create).mockResolvedValue({ id: "cp_1" } as never);
    const { recordCheckpoint } = await import("@/lib/agent/runs");
    const cp = await recordCheckpoint({
      runId: "r1",
      kind: "APPROVE_PLAN",
      proposal: { picoc: {} } as never,
      waitToken: "tk_abc",
    });
    expect(cp.id).toBe("cp_1");
    expect(db.humanCheckpoint.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          runId: "r1",
          kind: "APPROVE_PLAN",
          status: "PENDING",
          waitToken: "tk_abc",
        }),
      }),
    );
  });

  describe("resolveCheckpoint (atomic, TOCTOU-safe)", () => {
    it("uses a conditional updateMany gated on status: PENDING and returns the waitToken on success", async () => {
      vi.mocked(db.humanCheckpoint.updateMany).mockResolvedValue({ count: 1 } as never);
      vi.mocked(db.humanCheckpoint.findUnique).mockResolvedValue({ waitToken: "tk_abc" } as never);
      const { resolveCheckpoint } = await import("@/lib/agent/runs");

      const result = await resolveCheckpoint({
        checkpointId: "cp_1",
        status: "APPROVED",
        decisionPayload: { approved: true } as never,
      });

      expect(result).toEqual({ waitToken: "tk_abc" });
      expect(db.humanCheckpoint.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "cp_1", status: "PENDING" },
          data: expect.objectContaining({ status: "APPROVED" }),
        }),
      );
    });

    it("returns null (race lost) when no row matched the PENDING guard", async () => {
      vi.mocked(db.humanCheckpoint.updateMany).mockResolvedValue({ count: 0 } as never);
      const { resolveCheckpoint } = await import("@/lib/agent/runs");

      const result = await resolveCheckpoint({
        checkpointId: "cp_1",
        status: "REJECTED",
        decisionPayload: { approved: false } as never,
        rejectionReason: "x",
      });

      expect(result).toBeNull();
      // Must NOT fall through to findUnique — caller would otherwise resolve a wait token
      // for a checkpoint someone else already decided.
      expect(db.humanCheckpoint.findUnique).not.toHaveBeenCalled();
    });
  });
});
