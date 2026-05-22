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
      expect.objectContaining({ name: "drafter", model: "claude-opus-4-7" }),
    );
  });

  it("throws when state.claims is empty (nothing to draft from)", async () => {
    const { drafterNode } = await import("@/lib/agent/nodes/drafter");
    await expect(drafterNode({ ...baseState, claims: [] })).rejects.toThrow(/no claims/i);
  });
});
