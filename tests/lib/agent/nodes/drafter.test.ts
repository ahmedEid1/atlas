import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runLLM: vi.fn(),
  addStep: vi.fn(),
  finishStep: vi.fn(),
}));

vi.mock("@/lib/llm", () => ({ runLLM: mocks.runLLM }));
vi.mock("@/lib/agent/runs", () => ({
  addStep: mocks.addStep,
  finishStep: mocks.finishStep,
}));

beforeEach(() => {
  mocks.runLLM.mockReset();
  mocks.addStep.mockResolvedValue({ id: "step_4" });
  mocks.finishStep.mockResolvedValue(undefined);
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
