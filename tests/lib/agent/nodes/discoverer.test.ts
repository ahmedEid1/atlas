import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  runLLM: vi.fn(),
  dispatchSearch: vi.fn(),
  addStep: vi.fn(),
  finishStep: vi.fn(),
  assertWithinBudget: vi.fn(),
  createMany: vi.fn(),
  findMany: vi.fn(),
  corpusFindMany: vi.fn(),
  envMock: { MAX_DISCOVERED_PAPERS_PER_RUN: 50 } as {
    SEARCH_DISABLED?: string;
    MAX_DISCOVERED_PAPERS_PER_RUN: number;
  },
}));
const envMock = mocks.envMock;

vi.mock("@/lib/llm", () => ({ runLLM: mocks.runLLM }));
vi.mock("@/lib/search/dispatch", () => ({ dispatchSearch: mocks.dispatchSearch }));
vi.mock("@/lib/agent/runs", () => ({
  addStep: mocks.addStep,
  finishStep: mocks.finishStep,
}));
vi.mock("@/lib/agent/cost-cap", () => ({
  assertWithinBudget: mocks.assertWithinBudget,
  BudgetExceededError: class extends Error {},
}));
vi.mock("@/lib/db", () => ({
  db: {
    discoveredPaper: {
      createMany: mocks.createMany,
      findMany: mocks.findMany,
    },
    corpusItem: {
      findMany: mocks.corpusFindMany,
    },
  },
}));

// Mock the env proxy so the node's SEARCH_DISABLED read doesn't trigger
// a full schema parse against an unset process.env in the test runner.
vi.mock("@/lib/env", () => ({ env: mocks.envMock }));

import { discovererNode } from "@/lib/agent/nodes/discoverer";
import type { AgentState } from "@/lib/agent/state";

const baseState: AgentState = {
  runId: "r1",
  projectId: "p1",
  question: "Does X improve Y?",
  candidateCorpusItems: [],
  plan: {
    picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "x" },
    subQuestions: ["q1", "q2"],
    inclusionCriteria: ["a"],
    exclusionCriteria: ["b"],
  },
  planApproved: { approved: true },
  includedPapers: [],
  papersApproved: null,
  claims: [],
  draft: null,
  critique: null,
  critiqueIterations: 0,
  searchScope: "outbound",
  searchProviders: ["openalex", "arxiv"],
  searchMaxHits: null,
  discoveryQueries: [],
  discoveredPapers: [],
  discoveryApproved: null,
  screeningDecisions: [],
};

beforeEach(() => {
  for (const v of Object.values(mocks)) {
    if (typeof v === "function" && "mockReset" in v) (v as { mockReset: () => void }).mockReset();
  }
  delete envMock.SEARCH_DISABLED;
  envMock.MAX_DISCOVERED_PAPERS_PER_RUN = 50;
  mocks.addStep.mockResolvedValue({ id: "step_outer" });
  mocks.finishStep.mockResolvedValue(undefined);
  mocks.assertWithinBudget.mockResolvedValue({ tokensUsed: 0, limit: 250000 });
  mocks.createMany.mockResolvedValue({ count: 0 });
  mocks.corpusFindMany.mockResolvedValue([]);
  mocks.findMany.mockResolvedValue([]);
});

describe("discovererNode", () => {
  it("refuses to run when SEARCH_DISABLED=1 (operator kill switch)", async () => {
    envMock.SEARCH_DISABLED = "1";
    await expect(discovererNode(baseState)).rejects.toThrow(/SEARCH_DISABLED/);
    expect(mocks.runLLM).not.toHaveBeenCalled();
    expect(mocks.dispatchSearch).not.toHaveBeenCalled();
  });

  it("throws if state.plan is null", async () => {
    await expect(
      discovererNode({ ...baseState, plan: null }),
    ).rejects.toThrow(/plan is null/);
  });

  it("throws if state.searchProviders is empty", async () => {
    await expect(
      discovererNode({ ...baseState, searchProviders: [] }),
    ).rejects.toThrow(/no providers/);
  });

  it("generates queries, fans them out, persists hits, returns refs", async () => {
    mocks.runLLM.mockResolvedValue({
      output: {
        queries: ["graph attention networks", "GAT empirical evaluation"],
        rationale: "Two angles on the same architecture.",
      },
      traceUrl: "",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cacheReadInputTokens: 0 },
    });

    mocks.dispatchSearch
      .mockResolvedValueOnce({
        hits: [
          {
            provider: "openalex",
            externalId: "10.1/a",
            title: "Paper A",
            authors: ["X"],
            abstract: "About attention",
            publicationYear: 2023,
            venue: "ICLR",
            citationCount: 100,
            oaUrl: "https://x.org/a.pdf",
            accessStatus: "open",
            initialScore: 0.9,
          },
        ],
        errors: [],
      })
      .mockResolvedValueOnce({
        hits: [
          {
            provider: "arxiv",
            externalId: "arxiv:2310.06770",
            title: "Paper B",
            authors: ["Y"],
            abstract: null,
            publicationYear: 2023,
            venue: "arXiv",
            citationCount: null,
            oaUrl: "https://arxiv.org/pdf/2310.06770",
            accessStatus: "open",
            initialScore: 0.7,
          },
        ],
        errors: [],
      });

    mocks.findMany.mockResolvedValue([
      {
        id: "dp_a",
        provider: "openalex",
        externalId: "10.1/a",
        title: "Paper A",
        abstract: "About attention",
        oaUrl: "https://x.org/a.pdf",
        accessStatus: "open",
        corpusItemId: null,
      },
      {
        id: "dp_b",
        provider: "arxiv",
        externalId: "arxiv:2310.06770",
        title: "Paper B",
        abstract: null,
        oaUrl: "https://arxiv.org/pdf/2310.06770",
        accessStatus: "open",
        corpusItemId: null,
      },
    ]);

    const result = await discovererNode(baseState);

    // LLM was called once for query generation
    expect(mocks.runLLM).toHaveBeenCalledTimes(1);
    // Dispatched twice (one per query)
    expect(mocks.dispatchSearch).toHaveBeenCalledTimes(2);
    // Bulk persisted with deduped hits
    expect(mocks.createMany).toHaveBeenCalledTimes(1);
    expect(mocks.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ externalId: "10.1/a", provider: "openalex" }),
          expect.objectContaining({ externalId: "arxiv:2310.06770", provider: "arxiv" }),
        ]),
        skipDuplicates: true,
      }),
    );

    expect(result.discoveryQueries).toEqual(["graph attention networks", "GAT empirical evaluation"]);
    expect(result.discoveredPapers).toHaveLength(2);
    expect(result.discoveredPapers![0]!.id).toBe("dp_a");
  });

  it("deduplicates the same externalId across queries, keeping highest initialScore", async () => {
    mocks.runLLM.mockResolvedValue({
      output: { queries: ["q1", "q2"], rationale: "x." },
      traceUrl: "",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadInputTokens: 0 },
    });
    const hitLow = {
      provider: "openalex" as const, externalId: "10.1/same", title: "Same paper", authors: [],
      abstract: null, publicationYear: 2024, venue: null, citationCount: null,
      oaUrl: null, accessStatus: "unknown" as const, initialScore: 0.3,
    };
    const hitHigh = { ...hitLow, initialScore: 0.95 };
    mocks.dispatchSearch
      .mockResolvedValueOnce({ hits: [hitLow], errors: [] })
      .mockResolvedValueOnce({ hits: [hitHigh], errors: [] });

    await discovererNode(baseState);

    const createCall = mocks.createMany.mock.calls[0]![0];
    expect(createCall.data).toHaveLength(1);
    expect(createCall.data[0]).toMatchObject({ externalId: "10.1/same", initialScore: 0.95 });
  });

  it("records partial-provider failures to RunStep.failureReason without throwing", async () => {
    mocks.runLLM.mockResolvedValue({
      output: { queries: ["q1"], rationale: "x." },
      traceUrl: "",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadInputTokens: 0 },
    });
    mocks.dispatchSearch.mockResolvedValue({
      hits: [],
      errors: [{ provider: "openalex", message: "[openalex] 503" }],
    });

    await discovererNode(baseState);

    expect(mocks.finishStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stepId: "step_outer",
        failureReason: expect.stringContaining("partial"),
      }),
    );
  });

  it("propagates LLM errors and records them on the outer step", async () => {
    mocks.runLLM.mockRejectedValue(new Error("LLM hiccup"));

    await expect(discovererNode(baseState)).rejects.toThrow(/LLM hiccup/);
    expect(mocks.finishStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stepId: "step_outer",
        failureReason: expect.stringContaining("LLM hiccup"),
      }),
    );
  });

  it("caps the persisted hit list at env.MAX_DISCOVERED_PAPERS_PER_RUN (safety knob)", async () => {
    envMock.MAX_DISCOVERED_PAPERS_PER_RUN = 3;
    mocks.runLLM.mockResolvedValue({
      output: { queries: ["q1"], rationale: "x." },
      traceUrl: "",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadInputTokens: 0 },
    });
    const tenHits = Array.from({ length: 10 }, (_, i) => ({
      provider: "openalex" as const,
      externalId: `10.1/p${i}`,
      title: `paper ${i}`,
      authors: [],
      abstract: null,
      publicationYear: 2024,
      venue: null,
      citationCount: null,
      oaUrl: null,
      accessStatus: "unknown" as const,
      // Decreasing score so the top-3 by relevance is unambiguous.
      initialScore: 1 - i * 0.05,
    }));
    mocks.dispatchSearch.mockResolvedValue({ hits: tenHits, errors: [] });
    mocks.findMany.mockResolvedValue([]);

    await discovererNode(baseState);

    const createCall = mocks.createMany.mock.calls[0]![0];
    expect(createCall.data).toHaveLength(3);
    expect(createCall.data.map((d: { externalId: string }) => d.externalId)).toEqual([
      "10.1/p0", "10.1/p1", "10.1/p2",
    ]);
  });

  it("respects the per-project searchMaxHits when it is tighter than the env cap", async () => {
    envMock.MAX_DISCOVERED_PAPERS_PER_RUN = 50;
    mocks.runLLM.mockResolvedValue({
      output: { queries: ["q1"], rationale: "x." },
      traceUrl: "",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadInputTokens: 0 },
    });
    const sixHits = Array.from({ length: 6 }, (_, i) => ({
      provider: "openalex" as const,
      externalId: `10.1/q${i}`,
      title: `paper ${i}`,
      authors: [],
      abstract: null,
      publicationYear: 2024,
      venue: null,
      citationCount: null,
      oaUrl: null,
      accessStatus: "unknown" as const,
      initialScore: 1 - i * 0.05,
    }));
    mocks.dispatchSearch.mockResolvedValue({ hits: sixHits, errors: [] });
    mocks.findMany.mockResolvedValue([]);

    await discovererNode({ ...baseState, searchMaxHits: 2 });

    const createCall = mocks.createMany.mock.calls[0]![0];
    expect(createCall.data).toHaveLength(2);
  });

  it("hybrid mode: wraps PARSED uploaded CorpusItems as synthetic DiscoveredPaper rows", async () => {
    mocks.runLLM.mockResolvedValue({
      output: { queries: ["q1"], rationale: "x." },
      traceUrl: "",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadInputTokens: 0 },
    });
    mocks.dispatchSearch.mockResolvedValue({ hits: [], errors: [] });
    mocks.findMany.mockResolvedValue([]);
    // Two PARSED user uploads. The discoverer should wrap them as
    // provider="uploaded" DiscoveredPaper rows with corpusItemId pre-set
    // so the fetcher skips them.
    mocks.corpusFindMany.mockResolvedValue([
      {
        id: "ci_a", source: "corpus/p1/abc.pdf",
        parsedMarkdown: "# Foundational RAG paper\n\nText...",
        summary: { abstract: "Original RAG architecture description." },
        externalDoi: null, externalArxivId: null,
      },
      {
        id: "ci_b", source: "corpus/p1/xyz.pdf",
        parsedMarkdown: "no heading here",
        summary: null,
        externalDoi: null, externalArxivId: null,
      },
    ]);

    await discovererNode({ ...baseState, searchScope: "hybrid" as const });

    // The hybrid branch fires a second createMany call (the first one is
    // for outbound hits, which is empty in this test → may be skipped).
    const calls = mocks.createMany.mock.calls;
    const lastCall = calls[calls.length - 1]![0];
    expect(lastCall.data).toHaveLength(2);
    expect(lastCall.data[0]).toMatchObject({
      provider: "uploaded",
      externalId: "uploaded:ci_a",
      title: "Foundational RAG paper",
      abstract: "Original RAG architecture description.",
      corpusItemId: "ci_a",
      initialScore: 1.0,
      accessStatus: "open",
    });
    expect(lastCall.data[1]).toMatchObject({
      provider: "uploaded",
      externalId: "uploaded:ci_b",
      title: "xyz.pdf",
      abstract: null,
      corpusItemId: "ci_b",
    });
  });

  it("outbound mode: does NOT load uploaded CorpusItems", async () => {
    mocks.runLLM.mockResolvedValue({
      output: { queries: ["q1"], rationale: "x." },
      traceUrl: "",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadInputTokens: 0 },
    });
    mocks.dispatchSearch.mockResolvedValue({ hits: [], errors: [] });
    mocks.findMany.mockResolvedValue([]);

    await discovererNode({ ...baseState, searchScope: "outbound" as const });

    expect(mocks.corpusFindMany).not.toHaveBeenCalled();
  });

  it("env cap wins when the per-project value exceeds it", async () => {
    envMock.MAX_DISCOVERED_PAPERS_PER_RUN = 2;
    mocks.runLLM.mockResolvedValue({
      output: { queries: ["q1"], rationale: "x." },
      traceUrl: "",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadInputTokens: 0 },
    });
    const fourHits = Array.from({ length: 4 }, (_, i) => ({
      provider: "openalex" as const,
      externalId: `10.1/r${i}`,
      title: `paper ${i}`, authors: [], abstract: null, publicationYear: 2024,
      venue: null, citationCount: null, oaUrl: null,
      accessStatus: "unknown" as const, initialScore: 1 - i * 0.1,
    }));
    mocks.dispatchSearch.mockResolvedValue({ hits: fourHits, errors: [] });
    mocks.findMany.mockResolvedValue([]);

    await discovererNode({ ...baseState, searchMaxHits: 100 });

    const createCall = mocks.createMany.mock.calls[0]![0];
    expect(createCall.data).toHaveLength(2);
  });
});
