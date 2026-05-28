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
  vi.mocked(db.project.findUnique).mockResolvedValue({
    question: "Q?",
    searchScope: "uploaded_only",
    searchProviders: [],
  } as never);
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
      expect.objectContaining({
        runId: "r1",
        status: "REJECTED",
        failureReason: "Out of scope",
      }),
    );
  });

  // V2 nextPhaseStatus: outbound runs must show DISCOVERING / FETCHING /
  // ASSESSING in sequence, not the V1 RETRIEVING that was wrongly used
  // through M21. Asserts the status transitions seen by the dashboard
  // during an outbound run.
  it("V2 — uses V2 status enum values during outbound segments", async () => {
    vi.mocked(db.project.findUnique).mockResolvedValue({
      question: "Q?",
      searchScope: "outbound",
      searchProviders: ["openalex"],
    } as never);

    mocks.graphInvoke
      .mockResolvedValueOnce({
        __interrupt__: [{ value: { kind: "APPROVE_PLAN", plan: { picoc: {} } } }],
      })
      .mockResolvedValueOnce({
        __interrupt__: [{
          value: { kind: "APPROVE_DISCOVERY", queries: ["q"], discoveredPapers: [] },
        }],
      })
      .mockResolvedValueOnce({
        __interrupt__: [{
          value: { kind: "APPROVE_PAPERS", includedPapers: [] },
        }],
      })
      .mockResolvedValueOnce({
        draft: "# Review",
        includedPapers: [],
        claims: [],
      });

    mocks.waitForToken
      .mockReturnValueOnce({ unwrap: () => Promise.resolve({ approved: true }) })
      .mockReturnValueOnce({ unwrap: () => Promise.resolve({ approved: true }) })
      .mockReturnValueOnce({ unwrap: () => Promise.resolve({ approved: true, corpusItemIds: [] }) });

    const mod = await import("@/trigger/run-review");
    const task = mod.runReviewTask as unknown as {
      run: (p: { runId: string }) => Promise<unknown>;
    };
    await task.run({ runId: "r1" });

    // Extract the sequence of setRunStatus *phase* statuses (filter out the
    // AWAITING_* ones written from the interrupt branch).
    const phaseStatuses = vi.mocked(runs.setRunStatus).mock.calls
      .map((c) => (c[0] as { status: string }).status)
      .filter((s) => !s.startsWith("AWAITING_") && s !== "COMPLETED" && s !== "FAILED");

    // Outbound chain: PLANNING → DISCOVERING → FETCHING → ASSESSING.
    expect(phaseStatuses).toContain("PLANNING");
    expect(phaseStatuses).toContain("DISCOVERING");
    expect(phaseStatuses).toContain("FETCHING");
    expect(phaseStatuses).toContain("ASSESSING");
    // V1 RETRIEVING must NEVER appear on an outbound run.
    expect(phaseStatuses).not.toContain("RETRIEVING");
  });

  // M113 re-discovery: editing the queries at the discovery gate re-runs the
  // discoverer. The trigger loop is gate-agnostic, so the re-fired
  // discovery_gate gets its own checkpoint + token; the loop must continue
  // (not bail) and the re-run segment must display DISCOVERING (not FETCHING).
  it("V2 — re-discovery: a re-run decision drives a second discovery segment and the run still completes", async () => {
    vi.mocked(db.project.findUnique).mockResolvedValue({
      question: "Q?",
      searchScope: "outbound",
      searchProviders: ["openalex"],
    } as never);

    mocks.graphInvoke
      // seg0: planner → plan_gate
      .mockResolvedValueOnce({
        __interrupt__: [{ value: { kind: "APPROVE_PLAN", plan: { picoc: {} } } }],
      })
      // seg1: discoverer → discovery_gate (#1)
      .mockResolvedValueOnce({
        __interrupt__: [{ value: { kind: "APPROVE_DISCOVERY", queries: ["q"], discoveredPapers: [] } }],
      })
      // seg2: re-discoverer → discovery_gate (#2, after the re-run)
      .mockResolvedValueOnce({
        __interrupt__: [{ value: { kind: "APPROVE_DISCOVERY", queries: ["better q"], discoveredPapers: [] } }],
      })
      // seg3: fetcher → screener → papers_gate
      .mockResolvedValueOnce({
        __interrupt__: [{ value: { kind: "APPROVE_PAPERS", includedPapers: [] } }],
      })
      // seg4: assessor → … → END
      .mockResolvedValueOnce({ draft: "# Review", includedPapers: [], claims: [] });

    mocks.waitForToken
      .mockReturnValueOnce({ unwrap: () => Promise.resolve({ approved: true }) }) // plan
      // discovery #1 — user edits queries + re-runs (approved:false + editedQueries)
      .mockReturnValueOnce({ unwrap: () => Promise.resolve({ approved: false, editedQueries: ["better q"] }) })
      .mockReturnValueOnce({ unwrap: () => Promise.resolve({ approved: true }) }) // discovery #2
      .mockReturnValueOnce({ unwrap: () => Promise.resolve({ approved: true, corpusItemIds: [] }) }); // papers

    const mod = await import("@/trigger/run-review");
    const task = mod.runReviewTask as unknown as { run: (p: { runId: string }) => Promise<unknown> };
    await task.run({ runId: "r1" });

    // Two discovery checkpoints recorded (initial + re-run), plus plan + papers.
    const discoveryCheckpoints = vi.mocked(runs.recordCheckpoint).mock.calls.filter(
      (c) => (c[0] as { kind: string }).kind === "APPROVE_DISCOVERY",
    );
    expect(discoveryCheckpoints).toHaveLength(2);

    const phaseStatuses = vi.mocked(runs.setRunStatus).mock.calls
      .map((c) => (c[0] as { status: string }).status)
      .filter((s) => !s.startsWith("AWAITING_") && s !== "COMPLETED" && s !== "FAILED");
    // DISCOVERING appears twice (initial + re-run); the re-run segment is NOT
    // mislabeled FETCHING.
    expect(phaseStatuses.filter((s) => s === "DISCOVERING")).toHaveLength(2);

    // The run completed normally — the re-run's approved:false decision was
    // NOT misread as a rejection.
    expect(runs.finishRun).toHaveBeenCalledWith(expect.objectContaining({ runId: "r1", draft: "# Review" }));
    expect(runs.failRun).not.toHaveBeenCalled();
    expect(runs.setRunStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "REJECTED" }),
    );
  });

  it("fails the run with a clear reason when a HITL checkpoint times out (M124)", async () => {
    mocks.graphInvoke.mockResolvedValueOnce({
      __interrupt__: [{ value: { kind: "APPROVE_PLAN", plan: { picoc: {} } } }],
    });
    // forToken().unwrap() rejects — simulates the 24h wait-token timeout.
    mocks.waitForToken.mockReturnValueOnce({
      unwrap: () => Promise.reject(new Error("Waitpoint timed out")),
    });

    const mod = await import("@/trigger/run-review");
    const task = mod.runReviewTask as unknown as { run: (p: { runId: string }) => Promise<unknown> };

    await expect(task.run({ runId: "r1" })).rejects.toThrow(/not answered within 24h/);
    // The run is failed with an actionable reason, not a raw SDK string.
    expect(runs.failRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "r1",
        reason: expect.stringContaining("not answered within 24h"),
      }),
    );
  });

  it("V2 — hydrates the project's year range into the initial agent state (M115)", async () => {
    vi.mocked(db.project.findUnique).mockResolvedValue({
      question: "Q?",
      searchScope: "outbound",
      searchProviders: ["openalex"],
      searchMaxHits: 40,
      searchYearStart: 2018,
      searchYearEnd: 2023,
      skipDiscoveryGate: false,
    } as never);

    // Pause immediately at plan_gate — we only care about the initial payload.
    mocks.graphInvoke.mockResolvedValueOnce({
      __interrupt__: [{ value: { kind: "APPROVE_PLAN", plan: { picoc: {} } } }],
    });
    mocks.waitForToken.mockReturnValueOnce({
      unwrap: () => Promise.resolve({ approved: false, rejectionReason: "stop here" }),
    });
    // Second invoke after the (rejecting) plan decision — graph ends.
    mocks.graphInvoke.mockResolvedValueOnce({ planApproved: { approved: false } });

    const mod = await import("@/trigger/run-review");
    const task = mod.runReviewTask as unknown as { run: (p: { runId: string }) => Promise<unknown> };
    await task.run({ runId: "r1" });

    // The first graph.invoke receives the initial state — assert the year
    // range (and max hits) were hydrated from the project config.
    const initialPayload = mocks.graphInvoke.mock.calls[0]![0] as {
      searchYearStart: number | null;
      searchYearEnd: number | null;
      searchMaxHits: number | null;
    };
    expect(initialPayload.searchYearStart).toBe(2018);
    expect(initialPayload.searchYearEnd).toBe(2023);
    expect(initialPayload.searchMaxHits).toBe(40);
  });

  it("V2 — marks the run REJECTED when the discovery gate is rejected", async () => {
    mocks.graphInvoke
      .mockResolvedValueOnce({
        __interrupt__: [{ value: { kind: "APPROVE_DISCOVERY", queries: ["q"], discoveredPapers: [] } }],
      })
      .mockResolvedValueOnce({
        discoveryApproved: { approved: false, rejectionReason: "Off-topic queries" },
      });

    mocks.waitForToken.mockReturnValueOnce({
      unwrap: () => Promise.resolve({ approved: false, rejectionReason: "Off-topic queries" }),
    });

    const mod = await import("@/trigger/run-review");
    const task = mod.runReviewTask as unknown as {
      run: (p: { runId: string }) => Promise<unknown>;
    };
    await task.run({ runId: "r1" });

    expect(runs.setRunStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "r1",
        status: "REJECTED",
        failureReason: "Off-topic queries",
      }),
    );
    // Critical: the discovery rejection must NOT be misclassified as FAILED.
    expect(runs.failRun).not.toHaveBeenCalled();
    expect(runs.finishRun).not.toHaveBeenCalled();
  });
});
