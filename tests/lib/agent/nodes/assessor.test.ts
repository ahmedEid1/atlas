import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runLLM: vi.fn(),
  addStep: vi.fn(),
  finishStep: vi.fn(),
  findCorpusMarkdown: vi.fn(),
  assertWithinBudget: vi.fn(),
}));

vi.mock("@/lib/llm", () => ({ runLLM: mocks.runLLM }));
vi.mock("@/lib/agent/runs", () => ({
  addStep: mocks.addStep,
  finishStep: mocks.finishStep,
  findCorpusMarkdown: mocks.findCorpusMarkdown,
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
  mocks.findCorpusMarkdown.mockReset();
  mocks.assertWithinBudget.mockReset();
  mocks.assertWithinBudget.mockResolvedValue({ tokensUsed: 0, limit: 250_000 });
});

const baseState = {
  runId: "r1",
  projectId: "p1",
  question: "Q?",
  candidateCorpusItems: [],
  plan: {
    picoc: { population: "", intervention: "", comparison: "", outcome: "", context: "" },
    subQuestions: [],
    inclusionCriteria: [],
    exclusionCriteria: [],
  },
  planApproved: { approved: true },
  includedPapers: [
    { corpusItemId: "c1", relevanceScore: 0.9, inclusionReason: "x" },
    { corpusItemId: "c2", relevanceScore: 0.8, inclusionReason: "y" },
  ],
  papersApproved: { approved: true, corpusItemIds: ["c1", "c2"] },
  claims: [],
  draft: null,
  critique: null,
  critiqueIterations: 0,
};

describe("assessorNode", () => {
  it("extracts claims from each approved paper and aggregates them", async () => {
    mocks.findCorpusMarkdown.mockImplementation(async (id: string) => `# Paper ${id}`);
    mocks.runLLM
      .mockResolvedValueOnce({
        output: { claims: [{ text: "Finding 1", category: "finding" }] },
        traceUrl: "tu1",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      })
      .mockResolvedValueOnce({
        output: { claims: [{ text: "Method 1", category: "methodology" }] },
        traceUrl: "tu2",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      });

    const { assessorNode } = await import("@/lib/agent/nodes/assessor");
    const update = await assessorNode(baseState);

    expect(update.claims).toHaveLength(2);
    expect(update.claims?.[0]?.includedPaperId).toBe("c1");
    expect(update.claims?.[0]?.text).toBe("Finding 1");
    expect(update.claims?.[1]?.includedPaperId).toBe("c2");

    // 2 papers -> 1 outer + 2 inner = 3 addStep calls, 3 finishStep calls.
    expect(mocks.addStep).toHaveBeenCalledTimes(3);
    const nodeNames = mocks.addStep.mock.calls.map((c) => (c[0] as { nodeName: string }).nodeName);
    expect(nodeNames).toEqual(["assessor", "assessor_paper", "assessor_paper"]);
    expect(mocks.finishStep).toHaveBeenCalledTimes(3);
    // Inner finish carries usage; outer carries no tokens (defaults).
    const innerFinishCalls = mocks.finishStep.mock.calls
      .map((c) => c[0] as { stepId: string; inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number })
      .filter((args) => args.stepId.startsWith("step_assessor_paper_"));
    expect(innerFinishCalls).toHaveLength(2);
    for (const f of innerFinishCalls) {
      expect(f.inputTokens).toBe(1);
      expect(f.outputTokens).toBe(1);
      expect(f.cacheReadInputTokens).toBe(0);
    }
    const outerFinish = mocks.finishStep.mock.calls
      .map((c) => c[0] as { stepId: string; inputTokens?: number; outputTokens?: number })
      .find((args) => args.stepId === "step_assessor_1");
    expect(outerFinish).toBeDefined();
    expect(outerFinish?.inputTokens).toBeUndefined();
    expect(outerFinish?.outputTokens).toBeUndefined();
  });

  it("skips a paper that has no parsed markdown but continues with others", async () => {
    mocks.findCorpusMarkdown
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("# Paper c2");
    mocks.runLLM.mockResolvedValue({
      output: { claims: [{ text: "ok", category: "finding" }] },
      traceUrl: "tu",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });

    const { assessorNode } = await import("@/lib/agent/nodes/assessor");
    const update = await assessorNode(baseState);

    expect(mocks.runLLM).toHaveBeenCalledTimes(1);
    expect(update.claims?.[0]?.includedPaperId).toBe("c2");
  });

  it("mid-loop budget breach stops further LLM calls", async () => {
    // 10 papers in includedPapers. Each LLM call would be 30k tokens.
    // Simulated cumulative tokens grow by 30k per completed LLM call:
    //   call#1 (node entry):       tokensUsed = 0    -> pass
    //   call#2 (iter 1 gate):      tokensUsed = 30k  -> pass; LLM #1 fires
    //   call#3 (iter 2 gate):      tokensUsed = 60k  -> pass; LLM #2 fires
    //   call#4 (iter 3 gate):      tokensUsed = 90k  -> pass; LLM #3 fires
    //   call#5 (iter 4 gate):      tokensUsed = 120k -> THROW (no LLM #4)
    const includedPapers = Array.from({ length: 10 }, (_, i) => ({
      corpusItemId: `c${i}`,
      relevanceScore: 0.9,
      inclusionReason: "r",
    }));
    mocks.findCorpusMarkdown.mockImplementation(async (id: string) => `# Paper ${id}`);
    mocks.runLLM.mockResolvedValue({
      output: { claims: [{ text: "Finding", category: "finding" }] },
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

    const { assessorNode } = await import("@/lib/agent/nodes/assessor");
    await expect(assessorNode({ ...baseState, includedPapers })).rejects.toThrow(/exceeded/);

    // Only 3 LLM calls fire before the 4th iter's gate trips.
    expect(mocks.runLLM).toHaveBeenCalledTimes(3);
    // 3 inner steps were started (and finished) before the throw.
    const innerStarts = mocks.addStep.mock.calls
      .map((c) => (c[0] as { nodeName: string }).nodeName)
      .filter((n) => n === "assessor_paper");
    expect(innerStarts).toHaveLength(3);
    // The outer assessor step finishes via the catch branch with failureReason.
    const outerFail = mocks.finishStep.mock.calls
      .map((c) => c[0] as { stepId: string; failureReason?: string })
      .find((args) => args.stepId === "step_assessor_1");
    expect(outerFail?.failureReason).toMatch(/exceeded/);
  });
});
