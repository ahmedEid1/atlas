import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runLLM: vi.fn(),
  addStep: vi.fn(),
  finishStep: vi.fn(),
  persistCiteCheck: vi.fn(),
  findCorpusSummary: vi.fn(),
  assertWithinBudget: vi.fn(),
}));

vi.mock("@/lib/llm", () => ({ runLLM: mocks.runLLM }));
vi.mock("@/lib/agent/runs", () => ({
  addStep: mocks.addStep,
  finishStep: mocks.finishStep,
  persistCiteCheck: mocks.persistCiteCheck,
  findCorpusSummary: mocks.findCorpusSummary,
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
  // Hand out unique step ids per call so tests can assert per-citation steps.
  let stepCounter = 0;
  mocks.addStep.mockImplementation(({ nodeName }: { nodeName: string }) => {
    stepCounter += 1;
    return Promise.resolve({ id: `step_${nodeName}_${stepCounter}` });
  });
  mocks.finishStep.mockReset();
  mocks.finishStep.mockResolvedValue(undefined);
  mocks.persistCiteCheck.mockReset();
  mocks.persistCiteCheck.mockResolvedValue(undefined);
  mocks.findCorpusSummary.mockReset();
  mocks.assertWithinBudget.mockReset();
  mocks.assertWithinBudget.mockResolvedValue({ tokensUsed: 0, limit: 250_000 });
});

const baseState = {
  runId: "r1",
  projectId: "p1",
  question: "?",
  candidateCorpusItems: [],
  plan: null,
  planApproved: null,
  includedPapers: [
    { corpusItemId: "c1", relevanceScore: 0.9, inclusionReason: "r" },
    { corpusItemId: "c2", relevanceScore: 0.7, inclusionReason: "r" },
  ],
  papersApproved: null,
  claims: [],
  draft: "First claim [c1]. Second claim cites both [c1] [c2].",
  critique: null,
  critiqueIterations: 0,
};

describe("citeCheckNode", () => {
  it("verifies each citation, persists results, and returns a no-op state update", async () => {
    mocks.findCorpusSummary.mockImplementation((id: string) =>
      Promise.resolve(`summary for ${id}`),
    );
    mocks.runLLM
      .mockResolvedValueOnce({
        output: { verdict: "supported", reason: "directly stated" },
        traceUrl: "http://lf/1",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, totalTokens: 15 },
      })
      .mockResolvedValueOnce({
        output: { verdict: "supported", reason: "implied" },
        traceUrl: "http://lf/2",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, totalTokens: 15 },
      })
      .mockResolvedValueOnce({
        output: { verdict: "unclear", reason: "paper summary is brief" },
        traceUrl: "http://lf/3",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, totalTokens: 15 },
      });

    const { citeCheckNode } = await import("@/lib/agent/nodes/cite-check");
    const update = await citeCheckNode(baseState);

    expect(mocks.runLLM).toHaveBeenCalledTimes(3);
    expect(mocks.runLLM).toHaveBeenCalledWith(
      expect.objectContaining({ name: "cite-check", tier: "smart" }),
    );
    expect(mocks.persistCiteCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "r1",
        perCitation: expect.arrayContaining([
          expect.objectContaining({ paperId: "c1", verdict: "supported" }),
        ]),
        aggregate: expect.objectContaining({
          totalCitations: 3,
          supported: 2,
          unsupported: 0,
          unclear: 1,
        }),
      }),
    );
    // Node returns no state changes — persistence happened
    expect(update).toEqual({});
  });

  it("skips LLM call if the cited paper has no parsed summary (records as unclear)", async () => {
    mocks.findCorpusSummary.mockResolvedValue(null);
    const { citeCheckNode } = await import("@/lib/agent/nodes/cite-check");
    await citeCheckNode({ ...baseState, draft: "Lone claim [c1]." });

    expect(mocks.runLLM).not.toHaveBeenCalled();
    expect(mocks.persistCiteCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        perCitation: expect.arrayContaining([
          expect.objectContaining({
            paperId: "c1",
            verdict: "unclear",
            reason: expect.stringContaining("summary"),
          }),
        ]),
      }),
    );
  });

  it("handles a draft with no citations gracefully", async () => {
    const { citeCheckNode } = await import("@/lib/agent/nodes/cite-check");
    await citeCheckNode({ ...baseState, draft: "Plain draft with no citations." });

    expect(mocks.runLLM).not.toHaveBeenCalled();
    expect(mocks.persistCiteCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        perCitation: [],
        aggregate: { totalCitations: 0, supported: 0, unsupported: 0, unclear: 0, faithfulnessScore: 1 },
      }),
    );
  });

  it("throws if state.draft is null", async () => {
    const { citeCheckNode } = await import("@/lib/agent/nodes/cite-check");
    await expect(citeCheckNode({ ...baseState, draft: null })).rejects.toThrow(/draft/);
  });

  it("persists one RunStep per LLM call (outer + per-citation inner)", async () => {
    mocks.findCorpusSummary.mockImplementation((id: string) =>
      Promise.resolve(`summary for ${id}`),
    );
    mocks.runLLM.mockResolvedValue({
      output: { verdict: "supported", reason: "ok" },
      traceUrl: "http://lf/x",
      usage: { inputTokens: 12, outputTokens: 8, cacheReadInputTokens: 2, totalTokens: 20 },
    });

    const { citeCheckNode } = await import("@/lib/agent/nodes/cite-check");
    await citeCheckNode(baseState);

    // 3 citations in baseState's draft -> 1 outer + 3 inner = 4 addStep calls
    expect(mocks.addStep).toHaveBeenCalledTimes(4);
    const nodeNames = mocks.addStep.mock.calls.map((c) => (c[0] as { nodeName: string }).nodeName);
    expect(nodeNames).toEqual([
      "cite_check",
      "cite_check_citation",
      "cite_check_citation",
      "cite_check_citation",
    ]);
    // Each inner finishStep carries the call's usage; outer carries no tokens.
    const innerFinishCalls = mocks.finishStep.mock.calls
      .map((c) => c[0] as { stepId: string; inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number })
      .filter((args) => args.stepId.startsWith("step_cite_check_citation_"));
    expect(innerFinishCalls).toHaveLength(3);
    for (const f of innerFinishCalls) {
      expect(f.inputTokens).toBe(12);
      expect(f.outputTokens).toBe(8);
      expect(f.cacheReadInputTokens).toBe(2);
    }
    const outerFinish = mocks.finishStep.mock.calls
      .map((c) => c[0] as { stepId: string; inputTokens?: number; outputTokens?: number })
      .find((args) => args.stepId === "step_cite_check_1");
    expect(outerFinish).toBeDefined();
    expect(outerFinish?.inputTokens).toBeUndefined();
    expect(outerFinish?.outputTokens).toBeUndefined();
  });

  it("trips BudgetExceededError mid-loop once cumulative tokens cross the cap", async () => {
    // 10 citations all pointing at c1; each LLM call would be 30k tokens.
    // The in-loop gate reads cumulative completed-step tokens, so once 3 calls
    // have persisted (90k), the 4th call's gate (which sees 90k) is still under
    // 100k — pass; but if we simulate the aggregate including the in-flight
    // step (i.e. assertWithinBudget returns increasing counts that trip on the
    // 4th iteration), the loop must throw before more LLM calls fire.
    const claims = Array.from({ length: 10 }, (_, i) => `Claim ${i} [c1].`).join(" ");
    mocks.findCorpusSummary.mockResolvedValue("summary for c1");
    mocks.runLLM.mockResolvedValue({
      output: { verdict: "supported", reason: "ok" },
      traceUrl: "",
      usage: { inputTokens: 20_000, outputTokens: 10_000, cacheReadInputTokens: 0, totalTokens: 30_000 },
    });
    // assertWithinBudget is called once at node entry, then once per loop iter.
    // Simulated cumulative tokens grow by 30k per completed LLM call:
    //   call#1 (node entry):       tokensUsed = 0    -> pass
    //   call#2 (iter 1):           tokensUsed = 30k  -> pass; LLM #1 fires
    //   call#3 (iter 2):           tokensUsed = 60k  -> pass; LLM #2 fires
    //   call#4 (iter 3):           tokensUsed = 90k  -> pass; LLM #3 fires
    //   call#5 (iter 4):           tokensUsed = 120k -> THROW (no LLM #4)
    let callCount = 0;
    mocks.assertWithinBudget.mockImplementation(() => {
      const tokensUsed = callCount * 30_000;
      callCount += 1;
      if (tokensUsed > 100_000) {
        return Promise.reject(new FakeBudgetExceededError(`run r1 exceeded: ${tokensUsed} > 100000`));
      }
      return Promise.resolve({ tokensUsed, limit: 100_000 });
    });

    const { citeCheckNode } = await import("@/lib/agent/nodes/cite-check");
    await expect(
      citeCheckNode({ ...baseState, draft: claims }),
    ).rejects.toThrow(/exceeded/);

    // Only 3 LLM calls fire before the 4th iter's gate trips.
    expect(mocks.runLLM).toHaveBeenCalledTimes(3);
    // 3 inner steps were started (and finished) before the throw.
    const innerStarts = mocks.addStep.mock.calls
      .map((c) => (c[0] as { nodeName: string }).nodeName)
      .filter((n) => n === "cite_check_citation");
    expect(innerStarts).toHaveLength(3);
    // The outer cite_check step finishes via the catch branch with failureReason.
    const outerFail = mocks.finishStep.mock.calls
      .map((c) => c[0] as { stepId: string; failureReason?: string })
      .find((args) => args.stepId === "step_cite_check_1");
    expect(outerFail?.failureReason).toMatch(/exceeded/);
    // persistCiteCheck must NOT have been called — the throw aborted the node.
    expect(mocks.persistCiteCheck).not.toHaveBeenCalled();
  });
});
