import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  planner: vi.fn(),
  retriever: vi.fn(),
  assessor: vi.fn(),
  drafter: vi.fn(),
  critic: vi.fn(),
  citeCheck: vi.fn(),
}));

vi.mock("@/lib/agent/nodes/planner", () => ({ plannerNode: mocks.planner }));
vi.mock("@/lib/agent/nodes/retriever", () => ({ retrieverNode: mocks.retriever }));
vi.mock("@/lib/agent/nodes/assessor", () => ({ assessorNode: mocks.assessor }));
vi.mock("@/lib/agent/nodes/drafter", () => ({ drafterNode: mocks.drafter }));
vi.mock("@/lib/agent/nodes/critic", () => ({ criticNode: mocks.critic }));
vi.mock("@/lib/agent/nodes/cite-check", () => ({ citeCheckNode: mocks.citeCheck }));

// Avoid touching real postgres in tests — use an in-memory checkpointer.
vi.mock("@/lib/agent/checkpointer", async () => {
  const { MemorySaver } = await import("@langchain/langgraph");
  const saver = new MemorySaver();
  return { getCheckpointer: async () => saver, _resetCheckpointerForTest: () => {} };
});

beforeEach(() => {
  mocks.planner.mockReset();
  mocks.retriever.mockReset();
  mocks.assessor.mockReset();
  mocks.drafter.mockReset();
  mocks.critic.mockReset();
  mocks.citeCheck.mockReset();
});

const initialState = {
  runId: "r1",
  projectId: "p1",
  question: "Q?",
  candidateCorpusItems: [{ id: "c1", title: "P1", summary: null }],
  plan: null,
  planApproved: null,
  includedPapers: [],
  papersApproved: null,
  claims: [],
  draft: null,
};

describe("agent graph", () => {
  it("pauses after planner with the plan ready for HITL approval", async () => {
    mocks.planner.mockResolvedValue({
      plan: {
        picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" },
        subQuestions: [],
        inclusionCriteria: [],
        exclusionCriteria: [],
      },
    });

    const { buildGraph } = await import("@/lib/agent/graph");
    const graph = await buildGraph();

    const config = { configurable: { thread_id: "r1" } };
    await graph.invoke(initialState, config);

    // Expect graph to have run planner then hit an interrupt
    expect(mocks.planner).toHaveBeenCalledTimes(1);
    expect(mocks.retriever).not.toHaveBeenCalled();

    const snapshot = await graph.getState(config);
    expect(snapshot.values.plan).toBeTruthy();
    expect(snapshot.values.planApproved).toBeNull();
    expect(snapshot.tasks.length).toBeGreaterThan(0);
  });

  it("runs to completion when both HITL gates are auto-approved via Command.resume", async () => {
    mocks.planner.mockResolvedValue({
      plan: {
        picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" },
        subQuestions: ["q1"],
        inclusionCriteria: [],
        exclusionCriteria: [],
      },
    });
    mocks.retriever.mockResolvedValue({
      includedPapers: [{ corpusItemId: "c1", relevanceScore: 0.9, inclusionReason: "r" }],
    });
    mocks.assessor.mockResolvedValue({
      claims: [{ includedPaperId: "c1", text: "Finding", category: "finding" }],
    });
    mocks.drafter.mockResolvedValue({ draft: "# Review\n\nFinding [c1]." });
    mocks.critic.mockResolvedValue({
      critique: {
        decision: "approve",
        overallScore: 4.5,
        rubric: { faithfulness: 5, completeness: 4, citationQuality: 5, clarity: 4 },
        actionableFeedback: "looks good",
      },
      critiqueIterations: 1,
    });
    mocks.citeCheck.mockResolvedValue({ claimChecks: [] });

    const { buildGraph } = await import("@/lib/agent/graph");
    const { Command } = await import("@langchain/langgraph");
    const graph = await buildGraph();

    const config = { configurable: { thread_id: "r2" } };
    await graph.invoke({ ...initialState, runId: "r2" }, config);
    await graph.invoke(new Command({ resume: { approved: true } }), config);
    await graph.invoke(new Command({ resume: { approved: true, corpusItemIds: ["c1"] } }), config);

    const final = await graph.getState(config);
    expect(final.values.draft).toContain("[c1]");
    expect(mocks.drafter).toHaveBeenCalledTimes(1);
    expect(mocks.critic).toHaveBeenCalledTimes(1);
    expect(mocks.citeCheck).toHaveBeenCalledTimes(1);
  });

  it("skips retriever/assessor/drafter when plan is rejected", async () => {
    mocks.planner.mockResolvedValue({
      plan: {
        picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" },
        subQuestions: [],
        inclusionCriteria: [],
        exclusionCriteria: [],
      },
    });

    const { buildGraph } = await import("@/lib/agent/graph");
    const { Command } = await import("@langchain/langgraph");
    const graph = await buildGraph();

    const config = { configurable: { thread_id: "r3" } };
    await graph.invoke({ ...initialState, runId: "r3" }, config);
    await graph.invoke(
      new Command({ resume: { approved: false, rejectionReason: "Out of scope" } }),
      config,
    );

    const final = await graph.getState(config);
    expect(mocks.retriever).not.toHaveBeenCalled();
    expect(mocks.assessor).not.toHaveBeenCalled();
    expect(mocks.drafter).not.toHaveBeenCalled();
    expect(mocks.critic).not.toHaveBeenCalled();
    expect(mocks.citeCheck).not.toHaveBeenCalled();
    expect(final.values.planApproved?.approved).toBe(false);
  });
});

describe("routeAfterCritic", () => {
  const minimalState = {
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
  };

  it("routes to cite_check on approve regardless of iteration count", async () => {
    const { routeAfterCritic } = await import("@/lib/agent/graph");
    expect(
      routeAfterCritic({
        ...minimalState,
        critique: {
          decision: "approve",
          overallScore: 4.5,
          rubric: { faithfulness: 5, completeness: 4, citationQuality: 5, clarity: 4 },
          actionableFeedback: "looks good",
        },
        critiqueIterations: 1,
      }),
    ).toBe("cite_check");
  });

  it("routes to drafter on revise when iterations < 2", async () => {
    const { routeAfterCritic } = await import("@/lib/agent/graph");
    expect(
      routeAfterCritic({
        ...minimalState,
        critique: {
          decision: "revise",
          overallScore: 3,
          rubric: { faithfulness: 3, completeness: 3, citationQuality: 3, clarity: 3 },
          actionableFeedback: "x".repeat(50),
        },
        critiqueIterations: 0,
      }),
    ).toBe("drafter");
  });

  it("caps the loop at 2 iterations — routes to cite_check even on revise", async () => {
    const { routeAfterCritic } = await import("@/lib/agent/graph");
    expect(
      routeAfterCritic({
        ...minimalState,
        critique: {
          decision: "revise",
          overallScore: 3,
          rubric: { faithfulness: 3, completeness: 3, citationQuality: 3, clarity: 3 },
          actionableFeedback: "x".repeat(50),
        },
        critiqueIterations: 2,
      }),
    ).toBe("cite_check");
  });
});
