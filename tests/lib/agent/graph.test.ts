import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  planner: vi.fn(),
  retriever: vi.fn(),
  discoverer: vi.fn(),
  fetcher: vi.fn(),
  screener: vi.fn(),
  assessor: vi.fn(),
  drafter: vi.fn(),
  critic: vi.fn(),
  citeCheck: vi.fn(),
}));

vi.mock("@/lib/agent/nodes/planner", () => ({ plannerNode: mocks.planner }));
vi.mock("@/lib/agent/nodes/retriever", () => ({ retrieverNode: mocks.retriever }));
vi.mock("@/lib/agent/nodes/discoverer", () => ({ discovererNode: mocks.discoverer }));
vi.mock("@/lib/agent/nodes/fetcher", () => ({ fetcherNode: mocks.fetcher }));
vi.mock("@/lib/agent/nodes/screener", () => ({ screenerNode: mocks.screener }));
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
  mocks.discoverer.mockReset();
  mocks.fetcher.mockReset();
  mocks.screener.mockReset();
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
  searchScope: "uploaded_only" as const,
  searchProviders: [],
  searchMaxHits: null,
  skipDiscoveryGate: false,
  discoveryQueries: [],
  discoveredPapers: [],
  discoveryApproved: null,
  screeningDecisions: [],
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
      searchScope: "uploaded_only" as const,
      searchProviders: [],
      searchMaxHits: null,
      skipDiscoveryGate: false,
      discoveryQueries: [],
      discoveredPapers: [],
      discoveryApproved: null,
      screeningDecisions: [],
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

  it("papers_gate: filters state.includedPapers to corpusItemIds the user kept (was a no-op pre-M15)", async () => {
    mocks.planner.mockResolvedValue({
      plan: {
        picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" },
        subQuestions: [], inclusionCriteria: [], exclusionCriteria: [],
      },
    });
    mocks.retriever.mockResolvedValue({
      includedPapers: [
        { corpusItemId: "c1", relevanceScore: 0.9, inclusionReason: "r1" },
        { corpusItemId: "c2", relevanceScore: 0.8, inclusionReason: "r2" },
        { corpusItemId: "c3", relevanceScore: 0.7, inclusionReason: "r3" },
      ],
    });
    let assessorSawIncluded: Array<{ corpusItemId: string }> = [];
    mocks.assessor.mockImplementation((s: { includedPapers: Array<{ corpusItemId: string }> }) => {
      assessorSawIncluded = s.includedPapers;
      return Promise.resolve({ claims: [] });
    });
    mocks.drafter.mockResolvedValue({ draft: "X" });
    mocks.critic.mockResolvedValue({
      critique: {
        decision: "approve", overallScore: 4,
        rubric: { faithfulness: 4, completeness: 4, citationQuality: 4, clarity: 4 },
        actionableFeedback: "ok",
      },
      critiqueIterations: 1,
    });
    mocks.citeCheck.mockResolvedValue({});

    const { buildGraph } = await import("@/lib/agent/graph");
    const { Command } = await import("@langchain/langgraph");
    const graph = await buildGraph();
    const config = { configurable: { thread_id: "r_kept" } };

    await graph.invoke({ ...initialState, runId: "r_kept" }, config);
    await graph.invoke(new Command({ resume: { approved: true } }), config); // plan_gate
    // User checks c1 and c3, drops c2.
    await graph.invoke(
      new Command({ resume: { approved: true, corpusItemIds: ["c1", "c3"] } }),
      config,
    );

    // CRITICAL: assessor should ONLY see c1 + c3, not the c2 the user dropped.
    expect(assessorSawIncluded.map((p) => p.corpusItemId).sort()).toEqual(["c1", "c3"]);
  });

  it("V2 outbound: routes plan_gate → discoverer → discovery_gate → fetcher → screener → papers_gate, skipping retriever", async () => {
    mocks.planner.mockResolvedValue({
      plan: {
        picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" },
        subQuestions: ["q1"],
        inclusionCriteria: [],
        exclusionCriteria: [],
      },
    });
    mocks.discoverer.mockResolvedValue({
      discoveryQueries: ["q"],
      discoveredPapers: [
        {
          id: "dp1",
          provider: "arxiv",
          externalId: "arxiv:2310.06770",
          title: "T",
          abstract: "A",
          oaUrl: "https://arxiv.org/pdf/2310.06770",
          accessStatus: "open",
          corpusItemId: null,
        },
      ],
    });
    mocks.fetcher.mockResolvedValue({
      discoveredPapers: [
        {
          id: "dp1",
          provider: "arxiv",
          externalId: "arxiv:2310.06770",
          title: "T",
          abstract: "A",
          oaUrl: "https://arxiv.org/pdf/2310.06770",
          accessStatus: "open",
          corpusItemId: "ci_dp1",
        },
      ],
    });
    mocks.screener.mockResolvedValue({
      includedPapers: [{ corpusItemId: "ci_dp1", relevanceScore: 0.9, inclusionReason: "r" }],
      screeningDecisions: [
        { discoveredPaperId: "dp1", include: true, relevanceScore: 0.9, reason: "r" },
      ],
    });
    mocks.assessor.mockResolvedValue({ claims: [{ includedPaperId: "ci_dp1", text: "X", category: "finding" }] });
    mocks.drafter.mockResolvedValue({ draft: "Draft [ci_dp1]." });
    mocks.critic.mockResolvedValue({
      critique: {
        decision: "approve",
        overallScore: 4.5,
        rubric: { faithfulness: 5, completeness: 4, citationQuality: 5, clarity: 4 },
        actionableFeedback: "good",
      },
      critiqueIterations: 1,
    });
    mocks.citeCheck.mockResolvedValue({});

    const { buildGraph } = await import("@/lib/agent/graph");
    const { Command } = await import("@langchain/langgraph");
    const graph = await buildGraph();
    const config = { configurable: { thread_id: "r_v2" } };

    const outboundState = {
      ...initialState,
      runId: "r_v2",
      searchScope: "outbound" as const,
      searchProviders: ["arxiv" as const],
      searchMaxHits: null,
      skipDiscoveryGate: false,
    };

    await graph.invoke(outboundState, config);
    // plan_gate
    await graph.invoke(new Command({ resume: { approved: true } }), config);
    // discovery_gate (after discoverer ran)
    await graph.invoke(new Command({ resume: { approved: true } }), config);
    // papers_gate (after fetcher + screener)
    await graph.invoke(new Command({ resume: { approved: true } }), config);

    expect(mocks.retriever).not.toHaveBeenCalled();
    expect(mocks.discoverer).toHaveBeenCalledTimes(1);
    expect(mocks.fetcher).toHaveBeenCalledTimes(1);
    expect(mocks.screener).toHaveBeenCalledTimes(1);
    expect(mocks.assessor).toHaveBeenCalledTimes(1);
  });

  it("V2 outbound: skipDiscoveryGate=true auto-approves and flows straight to fetcher", async () => {
    mocks.planner.mockResolvedValue({
      plan: {
        picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" },
        subQuestions: [], inclusionCriteria: [], exclusionCriteria: [],
      },
    });
    mocks.discoverer.mockResolvedValue({
      discoveryQueries: ["q"],
      discoveredPapers: [{
        id: "dp1", provider: "arxiv", externalId: "arxiv:1", title: "T",
        abstract: "A", oaUrl: "https://x", accessStatus: "open", corpusItemId: null,
      }],
    });
    mocks.fetcher.mockResolvedValue({
      discoveredPapers: [{
        id: "dp1", provider: "arxiv", externalId: "arxiv:1", title: "T",
        abstract: "A", oaUrl: "https://x", accessStatus: "open", corpusItemId: "ci_dp1",
      }],
    });
    mocks.screener.mockResolvedValue({
      includedPapers: [{ corpusItemId: "ci_dp1", relevanceScore: 0.9, inclusionReason: "r" }],
      screeningDecisions: [{ discoveredPaperId: "dp1", include: true, relevanceScore: 0.9, reason: "r" }],
    });
    mocks.assessor.mockResolvedValue({ claims: [] });
    mocks.drafter.mockResolvedValue({ draft: "X" });
    mocks.critic.mockResolvedValue({
      critique: {
        decision: "approve", overallScore: 4,
        rubric: { faithfulness: 4, completeness: 4, citationQuality: 4, clarity: 4 },
        actionableFeedback: "ok",
      },
      critiqueIterations: 1,
    });
    mocks.citeCheck.mockResolvedValue({});

    const { buildGraph } = await import("@/lib/agent/graph");
    const { Command } = await import("@langchain/langgraph");
    const graph = await buildGraph();
    const config = { configurable: { thread_id: "r_v2_skip" } };

    await graph.invoke(
      {
        ...initialState, runId: "r_v2_skip",
        searchScope: "outbound" as const,
        searchProviders: ["arxiv" as const],
        searchMaxHits: null,
        skipDiscoveryGate: true,
      },
      config,
    );
    // plan_gate still interrupts (skipDiscoveryGate only affects discovery_gate).
    await graph.invoke(new Command({ resume: { approved: true } }), config);
    // papers_gate then interrupts (discovery_gate auto-approved, fetcher + screener
    // ran without a pause for HITL). Asserts that discovery_gate did NOT fire an
    // interrupt — only ONE resume call between plan_gate and papers_gate.
    await graph.invoke(new Command({ resume: { approved: true } }), config);

    expect(mocks.discoverer).toHaveBeenCalledTimes(1);
    expect(mocks.fetcher).toHaveBeenCalledTimes(1);
    expect(mocks.screener).toHaveBeenCalledTimes(1);
    // Final state.draft = "X" proves the run flowed all the way to drafter+critic
    // without ever pausing at discovery_gate.
    const final = await graph.getState(config);
    expect(final.values.draft).toBe("X");
  });

  it("V2 outbound: rejecting discovery_gate routes to END (no fetcher / screener / assessor)", async () => {
    mocks.planner.mockResolvedValue({
      plan: {
        picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" },
        subQuestions: [], inclusionCriteria: [], exclusionCriteria: [],
      },
    });
    mocks.discoverer.mockResolvedValue({
      discoveryQueries: ["q"],
      discoveredPapers: [],
    });

    const { buildGraph } = await import("@/lib/agent/graph");
    const { Command } = await import("@langchain/langgraph");
    const graph = await buildGraph();
    const config = { configurable: { thread_id: "r_v2_rej" } };

    await graph.invoke(
      { ...initialState, runId: "r_v2_rej", searchScope: "outbound" as const, searchProviders: ["arxiv" as const] },
      config,
    );
    await graph.invoke(new Command({ resume: { approved: true } }), config);
    await graph.invoke(new Command({ resume: { approved: false, rejectionReason: "bad hits" } }), config);

    expect(mocks.discoverer).toHaveBeenCalledTimes(1);
    expect(mocks.fetcher).not.toHaveBeenCalled();
    expect(mocks.screener).not.toHaveBeenCalled();
    expect(mocks.assessor).not.toHaveBeenCalled();
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
      searchScope: "uploaded_only" as const,
      searchProviders: [],
      searchMaxHits: null,
      skipDiscoveryGate: false,
      discoveryQueries: [],
      discoveredPapers: [],
      discoveryApproved: null,
      screeningDecisions: [],
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
      searchScope: "uploaded_only" as const,
      searchProviders: [],
      searchMaxHits: null,
      skipDiscoveryGate: false,
      discoveryQueries: [],
      discoveredPapers: [],
      discoveryApproved: null,
      screeningDecisions: [],
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
      searchScope: "uploaded_only" as const,
      searchProviders: [],
      searchMaxHits: null,
      skipDiscoveryGate: false,
      discoveryQueries: [],
      discoveredPapers: [],
      discoveryApproved: null,
      screeningDecisions: [],
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
      searchScope: "uploaded_only" as const,
      searchProviders: [],
      searchMaxHits: null,
      skipDiscoveryGate: false,
      discoveryQueries: [],
      discoveredPapers: [],
      discoveryApproved: null,
      screeningDecisions: [],
      }),
    ).toBe("cite_check");
  });
});
