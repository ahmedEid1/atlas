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

// Hoisted local copy of BudgetExceededError that the production code
// (drafter.ts) and the test's expectation both see as the same class —
// the production code imports it from @/lib/agent/cost-cap, which we mock
// here to expose this same class.
class TestBudgetExceededError extends Error {
  runId: string;
  tokensUsed: number;
  limit: number;
  constructor(args: { runId: string; tokensUsed: number; limit: number }) {
    super(`budget exceeded`);
    this.runId = args.runId;
    this.tokensUsed = args.tokensUsed;
    this.limit = args.limit;
  }
}

vi.mock("@/lib/agent/cost-cap", () => ({
  assertWithinBudget: mocks.assertWithinBudget,
  BudgetExceededError: TestBudgetExceededError,
}));

beforeEach(() => {
  mocks.runLLM.mockReset();
  mocks.addStep.mockReset();
  mocks.addStep.mockResolvedValue({ id: "step_4" });
  mocks.finishStep.mockReset();
  mocks.finishStep.mockResolvedValue(undefined);
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
    subQuestions: ["q1"],
    inclusionCriteria: [],
    exclusionCriteria: [],
  },
  planApproved: { approved: true },
  includedPapers: [{ corpusItemId: "c1", relevanceScore: 0.9, inclusionReason: "x" }],
  papersApproved: { approved: true, corpusItemIds: ["c1"] },
  claims: [{ includedPaperId: "c1", text: "X improves Y.", category: "finding" as const }],
  draft: null,
  critique: null,
  critiqueIterations: 0,
};

describe("drafterNode", () => {
  it("calls runLLM and returns the draft in the state update", async () => {
    mocks.runLLM.mockResolvedValue({
      output: { draft: "# Review\n\nFinding [c1]." },
      traceUrl: "tu",
      usage: { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });

    const { drafterNode } = await import("@/lib/agent/nodes/drafter");
    const update = await drafterNode(baseState);

    expect(update.draft).toContain("[c1]");
    expect(mocks.runLLM).toHaveBeenCalledWith(
      expect.objectContaining({ name: "drafter", tier: "smart" }),
    );
  });

  it("throws when state.claims is empty (nothing to draft from)", async () => {
    const { drafterNode } = await import("@/lib/agent/nodes/drafter");
    await expect(drafterNode({ ...baseState, claims: [] })).rejects.toThrow(/no claims/i);
  });

  it("bubbles BudgetExceededError when assertWithinBudget throws (does not swallow)", async () => {
    const budgetErr = new TestBudgetExceededError({
      runId: "r1",
      tokensUsed: 9999,
      limit: 1000,
    });
    mocks.assertWithinBudget.mockRejectedValueOnce(budgetErr);

    const { drafterNode } = await import("@/lib/agent/nodes/drafter");
    await expect(drafterNode(baseState)).rejects.toBe(budgetErr);
    // runLLM must NOT have been called once the gate trips.
    expect(mocks.runLLM).not.toHaveBeenCalled();
    // No step is created — the gate runs before addStep, so we don't
    // pollute the trace with an empty failed step.
    expect(mocks.addStep).not.toHaveBeenCalled();
  });

  it("passes critique feedback to the prompt when critique decision is revise", async () => {
    mocks.runLLM.mockResolvedValue({
      output: { draft: "Revised." },
      traceUrl: "http://lf/d2",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, totalTokens: 2 },
    });

    const { drafterNode } = await import("@/lib/agent/nodes/drafter");
    await drafterNode({
      ...baseState,
      critique: {
        rubric: { faithfulness: 3, completeness: 3, citationQuality: 3, clarity: 3 },
        overallScore: 3.0,
        actionableFeedback: "Add the missing limitations paragraph.",
        decision: "revise",
      },
      critiqueIterations: 1,
    });

    // The runLLM call's `messages[0].content` should contain the feedback text.
    const args = mocks.runLLM.mock.calls[0]?.[0];
    expect(JSON.stringify(args.messages)).toContain("Add the missing limitations paragraph.");
  });
});
