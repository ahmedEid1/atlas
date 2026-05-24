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
vi.mock("@/lib/agent/cost-cap", () => ({
  assertWithinBudget: mocks.assertWithinBudget,
  BudgetExceededError: class BudgetExceededError extends Error {},
}));

beforeEach(() => {
  mocks.runLLM.mockReset();
  mocks.addStep.mockResolvedValue({ id: "step_3" });
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
});
