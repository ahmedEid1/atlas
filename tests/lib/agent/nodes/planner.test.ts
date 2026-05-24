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
  mocks.addStep.mockResolvedValue({ id: "step_1" });
  mocks.finishStep.mockResolvedValue(undefined);
  mocks.assertWithinBudget.mockReset();
  mocks.assertWithinBudget.mockResolvedValue({ tokensUsed: 0, limit: 250_000 });
});

describe("plannerNode", () => {
  it("calls runLLM with the planner request and returns a plan in the state update", async () => {
    mocks.runLLM.mockResolvedValue({
      output: {
        picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" },
        subQuestions: ["q1"],
        inclusionCriteria: ["ic1"],
        exclusionCriteria: ["ec1"],
      },
      traceUrl: "http://lf/trace_1",
      usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });

    const { plannerNode } = await import("@/lib/agent/nodes/planner");
    const update = await plannerNode({
      runId: "r1",
      projectId: "p1",
      question: "Does X improve Y?",
      candidateCorpusItems: [{ id: "c1", title: "t", summary: null }],
      plan: null,
      planApproved: null,
      includedPapers: [],
      papersApproved: null,
      claims: [],
      draft: null,
      critique: null,
      critiqueIterations: 0,
    });

    expect(mocks.runLLM).toHaveBeenCalledWith(
      expect.objectContaining({ name: "planner", tier: "smart" }),
    );
    expect(update.plan?.picoc.population).toBe("p");
    expect(mocks.addStep).toHaveBeenCalledWith({ runId: "r1", nodeName: "planner" });
    expect(mocks.finishStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stepId: "step_1",
        traceUrl: "http://lf/trace_1",
        inputTokens: 100,
        outputTokens: 50,
      }),
    );
  });

  it("marks the step as failed on LLM error and rethrows", async () => {
    mocks.runLLM.mockRejectedValue(new Error("anthropic 500"));

    const { plannerNode } = await import("@/lib/agent/nodes/planner");
    await expect(
      plannerNode({
        runId: "r1",
        projectId: "p1",
        question: "?",
        candidateCorpusItems: [],
        plan: null,
        planApproved: null,
        includedPapers: [],
        papersApproved: null,
        claims: [],
        draft: null,
        critique: null,
        critiqueIterations: 0,
      }),
    ).rejects.toThrow(/anthropic 500/);
    expect(mocks.finishStep).toHaveBeenCalledWith(
      expect.objectContaining({ stepId: "step_1", failureReason: expect.stringContaining("anthropic 500") }),
    );
  });
});
