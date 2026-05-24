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
  mocks.addStep.mockResolvedValue({ id: "step_2" });
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
});
