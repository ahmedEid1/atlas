import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildGraph: vi.fn(),
  corpusFindMany: vi.fn(),
}));

vi.mock("@/lib/agent/graph", () => ({ buildGraph: mocks.buildGraph }));

vi.mock("@/lib/db", () => ({
  db: {
    corpusItem: { findMany: mocks.corpusFindMany },
  },
}));

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.buildGraph.mockReset();
  mocks.buildGraph.mockResolvedValue({ invoke: mocks.invoke });
  mocks.corpusFindMany.mockReset();
  // Default: return one item per requested id (echo-shape)
  mocks.corpusFindMany.mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
    Promise.resolve(
      where.id.in.map((id) => ({
        id,
        source: `golden:${id}`,
        summary: { abstract: `summary ${id}`, studyType: "other", relevanceToSLR: "relevant" },
        status: "PARSED",
      })),
    ),
  );
});

describe("runHeadless", () => {
  it("invokes the graph once when there are no interrupts (HITL fully bypassed via test mock)", async () => {
    mocks.invoke.mockResolvedValueOnce({
      runId: "r1",
      projectId: "p1",
      question: "Q",
      candidateCorpusItems: [],
      plan: { picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" }, subQuestions: [], inclusionCriteria: [], exclusionCriteria: [] },
      planApproved: { approved: true },
      includedPapers: [],
      papersApproved: { approved: true },
      claims: [],
      draft: "Final draft.",
      critique: null,
      critiqueIterations: 0,
      searchScope: "uploaded_only" as const,
      searchProviders: [],
      discoveryQueries: [],
      discoveredPapers: [],
      discoveryApproved: null,
      screeningDecisions: [],
    });

    const { runHeadless } = await import("@/lib/eval/headless-runner");
    const result = await runHeadless({
      runId: "r1",
      projectId: "p1",
      question: "Q",
      corpusItemIds: ["c1"],
    });

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(result.draft).toBe("Final draft.");
  });

  it("auto-resumes through both HITL gates by detecting __interrupt__ and re-invoking with Command", async () => {
    mocks.invoke
      .mockResolvedValueOnce({
        runId: "r1", projectId: "p1", question: "Q",
        candidateCorpusItems: [], plan: null, planApproved: null,
        includedPapers: [], papersApproved: null, claims: [],
        draft: null, critique: null, critiqueIterations: 0,
      searchScope: "uploaded_only" as const,
      searchProviders: [],
      discoveryQueries: [],
      discoveredPapers: [],
      discoveryApproved: null,
      screeningDecisions: [],
        __interrupt__: [{ value: { kind: "APPROVE_PLAN" } }],
      })
      .mockResolvedValueOnce({
        runId: "r1", projectId: "p1", question: "Q",
        candidateCorpusItems: [], plan: { picoc: { population:"p", intervention:"i", comparison:"c", outcome:"o", context:"ctx" }, subQuestions:[], inclusionCriteria:[], exclusionCriteria:[] },
        planApproved: { approved: true },
        includedPapers: [], papersApproved: null, claims: [],
        draft: null, critique: null, critiqueIterations: 0,
      searchScope: "uploaded_only" as const,
      searchProviders: [],
      discoveryQueries: [],
      discoveredPapers: [],
      discoveryApproved: null,
      screeningDecisions: [],
        __interrupt__: [{ value: { kind: "APPROVE_PAPERS" } }],
      })
      .mockResolvedValueOnce({
        runId: "r1", projectId: "p1", question: "Q",
        candidateCorpusItems: [], plan: { picoc: { population:"p", intervention:"i", comparison:"c", outcome:"o", context:"ctx" }, subQuestions:[], inclusionCriteria:[], exclusionCriteria:[] },
        planApproved: { approved: true },
        includedPapers: [], papersApproved: { approved: true },
        claims: [], draft: "Done.", critique: null, critiqueIterations: 0,
      searchScope: "uploaded_only" as const,
      searchProviders: [],
      discoveryQueries: [],
      discoveredPapers: [],
      discoveryApproved: null,
      screeningDecisions: [],
      });

    const { runHeadless } = await import("@/lib/eval/headless-runner");
    const result = await runHeadless({ runId: "r1", projectId: "p1", question: "Q", corpusItemIds: ["c1"] });

    expect(mocks.invoke).toHaveBeenCalledTimes(3);
    expect(result.draft).toBe("Done.");
  });

  // V2 — outbound headless eval: callers can pass searchScope='outbound'
  // and an empty corpusItemIds array; the discoverer fills the corpus.
  // This test verifies the seed payload reflects the override and the
  // corpus lookup is skipped.
  it("V2 outbound: skips the corpus lookup and passes searchScope through", async () => {
    mocks.invoke.mockResolvedValueOnce({
      runId: "r1", projectId: "p1", question: "Q",
      candidateCorpusItems: [], plan: null, planApproved: null,
      includedPapers: [], papersApproved: null, claims: [],
      draft: "Outbound draft.", critique: null, critiqueIterations: 0,
      searchScope: "outbound" as const,
      searchProviders: ["openalex"],
      discoveryQueries: ["foo"], discoveredPapers: [],
      discoveryApproved: null, screeningDecisions: [],
    });

    const { runHeadless } = await import("@/lib/eval/headless-runner");
    const result = await runHeadless({
      runId: "r1", projectId: "p1", question: "Q",
      corpusItemIds: [],
      searchScope: "outbound",
      searchProviders: ["openalex"],
    });

    expect(mocks.corpusFindMany).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    const seedPayload = mocks.invoke.mock.calls[0]![0];
    expect(seedPayload).toMatchObject({
      searchScope: "outbound",
      searchProviders: ["openalex"],
      candidateCorpusItems: [],
    });
    expect(result.draft).toBe("Outbound draft.");
  });

  it("throws after maxSegments to prevent infinite loops on a buggy graph", async () => {
    mocks.invoke.mockResolvedValue({
      runId: "r1", projectId: "p1", question: "Q",
      candidateCorpusItems: [], plan: null, planApproved: null,
      includedPapers: [], papersApproved: null, claims: [],
      draft: null, critique: null, critiqueIterations: 0,
      searchScope: "uploaded_only" as const,
      searchProviders: [],
      discoveryQueries: [],
      discoveredPapers: [],
      discoveryApproved: null,
      screeningDecisions: [],
      __interrupt__: [{ value: { kind: "APPROVE_PLAN" } }],
    });

    const { runHeadless } = await import("@/lib/eval/headless-runner");
    await expect(
      runHeadless({ runId: "r1", projectId: "p1", question: "Q", corpusItemIds: ["c1"] }),
    ).rejects.toThrow(/maxSegments/);
  });
});
