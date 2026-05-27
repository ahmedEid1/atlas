import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runLLM: vi.fn(),
  addStep: vi.fn(),
  finishStep: vi.fn(),
  assertWithinBudget: vi.fn(),
}));

vi.mock("@/lib/llm", () => ({ runLLM: mocks.runLLM }));
vi.mock("@/lib/agent/runs", () => ({
  addStep: mocks.addStep,
  finishStep: mocks.finishStep,
}));
class FakeBudgetExceededError extends Error {
  constructor(msg = "budget exceeded") {
    super(msg);
    this.name = "BudgetExceededError";
  }
}
vi.mock("@/lib/agent/cost-cap", () => ({
  assertWithinBudget: mocks.assertWithinBudget,
  BudgetExceededError: FakeBudgetExceededError,
}));

beforeEach(() => {
  mocks.runLLM.mockReset();
  mocks.addStep.mockReset();
  // Hand out unique step ids per call so tests can assert per-paper steps.
  let stepCounter = 0;
  mocks.addStep.mockImplementation(({ nodeName }: { nodeName: string }) => {
    stepCounter += 1;
    return Promise.resolve({ id: `step_${nodeName}_${stepCounter}` });
  });
  mocks.finishStep.mockReset();
  mocks.finishStep.mockResolvedValue(undefined);
  mocks.assertWithinBudget.mockReset();
  mocks.assertWithinBudget.mockResolvedValue({ tokensUsed: 0, limit: 250_000 });
});

const baseState = {
  runId: "r1",
  projectId: "p1",
  question: "Q?",
  candidateCorpusItems: [
    { id: "c1", title: "P1", summary: null },
    { id: "c2", title: "P2", summary: null },
  ],
  plan: {
    picoc: { population: "", intervention: "", comparison: "", outcome: "", context: "" },
    subQuestions: [],
    inclusionCriteria: [],
    exclusionCriteria: [],
  },
  planApproved: { approved: true },
  includedPapers: [],
  papersApproved: null,
  claims: [],
  draft: null,
  critique: null,
  critiqueIterations: 0,
      searchScope: "uploaded_only" as const,
      searchProviders: [],
      searchMaxHits: null,
      skipDiscoveryGate: false,
      discoveryQueries: [],
      discoveredPapers: [],
      discoveryApproved: null,
      screeningDecisions: [],
};

describe("retrieverNode", () => {
  it("scores each candidate and returns only included papers", async () => {
    mocks.runLLM
      .mockResolvedValueOnce({
        output: { relevanceScore: 0.9, include: true, reason: "Hits PICOC." },
        traceUrl: "tu1",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      })
      .mockResolvedValueOnce({
        output: { relevanceScore: 0.2, include: false, reason: "Off topic." },
        traceUrl: "tu2",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      });

    const { retrieverNode } = await import("@/lib/agent/nodes/retriever");
    const update = await retrieverNode(baseState);

    expect(mocks.runLLM).toHaveBeenCalledTimes(2);
    expect(update.includedPapers).toHaveLength(1);
    expect(update.includedPapers?.[0]?.corpusItemId).toBe("c1");
    expect(update.includedPapers?.[0]?.relevanceScore).toBe(0.9);

    // 2 papers -> 1 outer + 2 inner = 3 addStep calls, 3 finishStep calls.
    expect(mocks.addStep).toHaveBeenCalledTimes(3);
    const nodeNames = mocks.addStep.mock.calls.map((c) => (c[0] as { nodeName: string }).nodeName);
    expect(nodeNames).toEqual(["retriever", "retriever_paper", "retriever_paper"]);
    expect(mocks.finishStep).toHaveBeenCalledTimes(3);
    // Inner finish carries usage; outer carries no tokens (defaults).
    const innerFinishCalls = mocks.finishStep.mock.calls
      .map((c) => c[0] as { stepId: string; inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number })
      .filter((args) => args.stepId.startsWith("step_retriever_paper_"));
    expect(innerFinishCalls).toHaveLength(2);
    for (const f of innerFinishCalls) {
      expect(f.inputTokens).toBe(1);
      expect(f.outputTokens).toBe(1);
      expect(f.cacheReadInputTokens).toBe(0);
    }
    const outerFinish = mocks.finishStep.mock.calls
      .map((c) => c[0] as { stepId: string; inputTokens?: number; outputTokens?: number })
      .find((args) => args.stepId === "step_retriever_1");
    expect(outerFinish).toBeDefined();
    expect(outerFinish?.inputTokens).toBeUndefined();
    expect(outerFinish?.outputTokens).toBeUndefined();
  });

  it("returns empty includedPapers if every candidate is excluded", async () => {
    mocks.runLLM.mockResolvedValue({
      output: { relevanceScore: 0.1, include: false, reason: "Off topic." },
      traceUrl: "tu",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });

    const { retrieverNode } = await import("@/lib/agent/nodes/retriever");
    const update = await retrieverNode(baseState);

    expect(update.includedPapers).toEqual([]);
  });

  it("throws when state.plan is null (planner hasn't run)", async () => {
    const { retrieverNode } = await import("@/lib/agent/nodes/retriever");
    await expect(retrieverNode({ ...baseState, plan: null })).rejects.toThrow(/plan/i);
  });

  it("mid-loop budget breach stops further LLM calls", async () => {
    // 10 candidate papers. Each LLM call would be 30k tokens.
    // Simulated cumulative tokens grow by 30k per completed LLM call:
    //   call#1 (node entry):       tokensUsed = 0    -> pass
    //   call#2 (iter 1 gate):      tokensUsed = 30k  -> pass; LLM #1 fires
    //   call#3 (iter 2 gate):      tokensUsed = 60k  -> pass; LLM #2 fires
    //   call#4 (iter 3 gate):      tokensUsed = 90k  -> pass; LLM #3 fires
    //   call#5 (iter 4 gate):      tokensUsed = 120k -> THROW (no LLM #4)
    const candidateCorpusItems = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      title: `P${i}`,
      summary: null,
    }));
    mocks.runLLM.mockResolvedValue({
      output: { relevanceScore: 0.9, include: true, reason: "Hit." },
      traceUrl: "tu",
      usage: { inputTokens: 20_000, outputTokens: 10_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
    let callCount = 0;
    mocks.assertWithinBudget.mockImplementation(() => {
      const tokensUsed = callCount * 30_000;
      callCount += 1;
      if (tokensUsed > 100_000) {
        return Promise.reject(new FakeBudgetExceededError(`run r1 exceeded: ${tokensUsed} > 100000`));
      }
      return Promise.resolve({ tokensUsed, limit: 100_000 });
    });

    const { retrieverNode } = await import("@/lib/agent/nodes/retriever");
    await expect(retrieverNode({ ...baseState, candidateCorpusItems })).rejects.toThrow(/exceeded/);

    // Only 3 LLM calls fire before the 4th iter's gate trips.
    expect(mocks.runLLM).toHaveBeenCalledTimes(3);
    // 3 inner steps were started (and finished) before the throw.
    const innerStarts = mocks.addStep.mock.calls
      .map((c) => (c[0] as { nodeName: string }).nodeName)
      .filter((n) => n === "retriever_paper");
    expect(innerStarts).toHaveLength(3);
    // The outer retriever step finishes via the catch branch with failureReason.
    const outerFail = mocks.finishStep.mock.calls
      .map((c) => c[0] as { stepId: string; failureReason?: string })
      .find((args) => args.stepId === "step_retriever_1");
    expect(outerFail?.failureReason).toMatch(/exceeded/);
  });
});
