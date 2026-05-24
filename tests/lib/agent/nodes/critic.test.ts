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
vi.mock("@/lib/agent/cost-cap", () => ({
  assertWithinBudget: mocks.assertWithinBudget,
  BudgetExceededError: class BudgetExceededError extends Error {},
}));

beforeEach(() => {
  mocks.runLLM.mockReset();
  mocks.addStep.mockResolvedValue({ id: "step_c" });
  mocks.finishStep.mockResolvedValue(undefined);
  mocks.assertWithinBudget.mockReset();
  mocks.assertWithinBudget.mockResolvedValue({ tokensUsed: 0, limit: 250_000 });
});

const baseState = {
  runId: "r1",
  projectId: "p1",
  question: "Does X improve Y?",
  candidateCorpusItems: [],
  plan: {
    picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" },
    subQuestions: ["Q1"],
    inclusionCriteria: ["IC1"],
    exclusionCriteria: ["EC1"],
  },
  planApproved: { approved: true } as const,
  includedPapers: [{ corpusItemId: "c1", relevanceScore: 0.9, inclusionReason: "r" }],
  papersApproved: { approved: true } as const,
  claims: [],
  draft: "Some draft [c1].",
  critique: null,
  critiqueIterations: 0,
};

describe("criticNode", () => {
  it("calls runLLM with tier:'smart' and returns critique + iteration update", async () => {
    mocks.runLLM.mockResolvedValue({
      output: {
        rubric: { faithfulness: 5, completeness: 4, citationQuality: 4, clarity: 4 },
        overallScore: 4.4,
        actionableFeedback: "Solid draft; minor formatting nit on heading levels.",
        decision: "approve",
      },
      traceUrl: "http://lf/trace_c1",
      usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, totalTokens: 150 },
    });

    const { criticNode } = await import("@/lib/agent/nodes/critic");
    const update = await criticNode(baseState);

    expect(mocks.runLLM).toHaveBeenCalledWith(
      expect.objectContaining({ name: "critic", tier: "smart" }),
    );
    expect(update.critique?.decision).toBe("approve");
    expect(update.critiqueIterations).toBe(1);
    expect(mocks.addStep).toHaveBeenCalledWith({ runId: "r1", nodeName: "critic" });
    expect(mocks.finishStep).toHaveBeenCalledWith(
      expect.objectContaining({ stepId: "step_c", traceUrl: "http://lf/trace_c1" }),
    );
  });

  it("increments critiqueIterations on a second pass", async () => {
    mocks.runLLM.mockResolvedValue({
      output: {
        rubric: { faithfulness: 3, completeness: 3, citationQuality: 3, clarity: 3 },
        overallScore: 3.0,
        actionableFeedback: "Add discussion of sub-question 2; expand the limitations section.",
        decision: "revise",
      },
      traceUrl: "http://lf/trace_c2",
      usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, totalTokens: 150 },
    });

    const { criticNode } = await import("@/lib/agent/nodes/critic");
    const update = await criticNode({ ...baseState, critiqueIterations: 1 });

    expect(update.critique?.decision).toBe("revise");
    expect(update.critiqueIterations).toBe(2);
  });

  it("marks the step as failed and rethrows on LLM error", async () => {
    mocks.runLLM.mockRejectedValue(new Error("gemini 500"));

    const { criticNode } = await import("@/lib/agent/nodes/critic");
    await expect(criticNode(baseState)).rejects.toThrow(/gemini 500/);
    expect(mocks.finishStep).toHaveBeenCalledWith(
      expect.objectContaining({ stepId: "step_c", failureReason: expect.stringContaining("gemini 500") }),
    );
  });

  it("throws if state.draft is null", async () => {
    const { criticNode } = await import("@/lib/agent/nodes/critic");
    await expect(criticNode({ ...baseState, draft: null })).rejects.toThrow(/draft/);
  });
});
