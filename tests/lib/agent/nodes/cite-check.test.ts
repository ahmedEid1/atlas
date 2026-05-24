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
vi.mock("@/lib/agent/cost-cap", () => ({
  assertWithinBudget: mocks.assertWithinBudget,
  BudgetExceededError: class BudgetExceededError extends Error {},
}));

beforeEach(() => {
  mocks.runLLM.mockReset();
  mocks.addStep.mockResolvedValue({ id: "step_cc" });
  mocks.finishStep.mockResolvedValue(undefined);
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
});
