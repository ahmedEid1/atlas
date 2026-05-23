import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const metadata: { set: ReturnType<typeof vi.fn> } = { set: vi.fn() };
  metadata.set.mockReturnValue(metadata);
  const logger = { info: vi.fn(), error: vi.fn() };

  const waitForToken = vi.fn();
  const tokenObj = { id: "tk_abc" };
  const waitCreateToken = vi.fn(async () => tokenObj);

  const graphInvoke = vi.fn();
  const graphGetState = vi.fn();
  const buildGraph = vi.fn(async () => ({
    invoke: graphInvoke,
    getState: graphGetState,
  }));

  return { metadata, logger, waitForToken, waitCreateToken, graphInvoke, graphGetState, buildGraph };
});

vi.mock("@trigger.dev/sdk", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@trigger.dev/sdk");
  return {
    ...actual,
    schemaTask: (cfg: { run: (payload: unknown) => Promise<unknown> }) => cfg,
    logger: mocks.logger,
    metadata: mocks.metadata,
    wait: {
      createToken: mocks.waitCreateToken,
      forToken: mocks.waitForToken,
    },
  };
});

vi.mock("@/lib/agent/graph", () => ({ buildGraph: mocks.buildGraph }));
vi.mock("@/lib/agent/runs", () => ({
  setRunStatus: vi.fn(),
  recordCheckpoint: vi.fn().mockResolvedValue({ id: "cp_1" }),
  persistIncludedPapers: vi.fn(),
  persistClaims: vi.fn(),
  finishRun: vi.fn(),
  failRun: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    run: { findUniqueOrThrow: vi.fn() },
    project: { findUnique: vi.fn() },
    corpusItem: { findMany: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import * as runs from "@/lib/agent/runs";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.metadata.set.mockReturnValue(mocks.metadata);
  mocks.buildGraph.mockResolvedValue({
    invoke: mocks.graphInvoke,
    getState: mocks.graphGetState,
  });
  mocks.waitCreateToken.mockResolvedValue({ id: "tk_abc" });
  vi.mocked(db.run.findUniqueOrThrow).mockResolvedValue({ id: "r1", projectId: "p1", question: "Q?" } as never);
  vi.mocked(db.project.findUnique).mockResolvedValue({ question: "Q?" } as never);
  vi.mocked(db.corpusItem.findMany).mockResolvedValue([
    { id: "c1", source: "corpus/p1/c1.pdf", summary: null, status: "PARSED" },
  ] as never);
});

describe("run-review task", () => {
  it("runs to completion when both gates auto-approve", async () => {
    mocks.graphInvoke
      .mockResolvedValueOnce({ __interrupt__: [{ value: { kind: "APPROVE_PLAN", plan: { picoc: {} } } }] })
      .mockResolvedValueOnce({
        __interrupt__: [{
          value: { kind: "APPROVE_PAPERS", includedPapers: [{ corpusItemId: "c1", relevanceScore: 0.9, inclusionReason: "x" }] },
        }],
      })
      .mockResolvedValueOnce({
        draft: "# Review",
        includedPapers: [{ corpusItemId: "c1", relevanceScore: 0.9, inclusionReason: "x" }],
        claims: [{ includedPaperId: "c1", text: "F", category: "finding" }],
      });

    mocks.waitForToken
      .mockReturnValueOnce({ unwrap: () => Promise.resolve({ approved: true }) })
      .mockReturnValueOnce({ unwrap: () => Promise.resolve({ approved: true, corpusItemIds: ["c1"] }) });

    const mod = await import("@/trigger/run-review");
    const task = mod.runReviewTask as unknown as {
      run: (p: { runId: string }) => Promise<unknown>;
    };
    await task.run({ runId: "r1" });

    expect(runs.recordCheckpoint).toHaveBeenCalledTimes(2);
    expect(runs.persistIncludedPapers).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "r1" }),
    );
    expect(runs.persistClaims).toHaveBeenCalled();
    expect(runs.finishRun).toHaveBeenCalledWith(expect.objectContaining({ runId: "r1", draft: "# Review" }));
  });

  it("marks the run REJECTED when the plan gate is rejected", async () => {
    mocks.graphInvoke
      .mockResolvedValueOnce({ __interrupt__: [{ value: { kind: "APPROVE_PLAN", plan: { picoc: {} } } }] })
      .mockResolvedValueOnce({ planApproved: { approved: false, rejectionReason: "Out of scope" } });

    mocks.waitForToken.mockReturnValueOnce({
      unwrap: () => Promise.resolve({ approved: false, rejectionReason: "Out of scope" }),
    });

    const mod = await import("@/trigger/run-review");
    const task = mod.runReviewTask as unknown as {
      run: (p: { runId: string }) => Promise<unknown>;
    };
    await task.run({ runId: "r1" });

    expect(runs.finishRun).not.toHaveBeenCalled();
    expect(runs.failRun).not.toHaveBeenCalled();
    expect(runs.setRunStatus).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "r1", status: "REJECTED" }),
    );
  });
});
