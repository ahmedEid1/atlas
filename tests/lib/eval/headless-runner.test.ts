import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildGraph: vi.fn(),
}));

vi.mock("@/lib/agent/graph", () => ({ buildGraph: mocks.buildGraph }));

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.buildGraph.mockReset();
  mocks.buildGraph.mockResolvedValue({ invoke: mocks.invoke });
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
        __interrupt__: [{ value: { kind: "APPROVE_PLAN" } }],
      })
      .mockResolvedValueOnce({
        runId: "r1", projectId: "p1", question: "Q",
        candidateCorpusItems: [], plan: { picoc: { population:"p", intervention:"i", comparison:"c", outcome:"o", context:"ctx" }, subQuestions:[], inclusionCriteria:[], exclusionCriteria:[] },
        planApproved: { approved: true },
        includedPapers: [], papersApproved: null, claims: [],
        draft: null, critique: null, critiqueIterations: 0,
        __interrupt__: [{ value: { kind: "APPROVE_PAPERS" } }],
      })
      .mockResolvedValueOnce({
        runId: "r1", projectId: "p1", question: "Q",
        candidateCorpusItems: [], plan: { picoc: { population:"p", intervention:"i", comparison:"c", outcome:"o", context:"ctx" }, subQuestions:[], inclusionCriteria:[], exclusionCriteria:[] },
        planApproved: { approved: true },
        includedPapers: [], papersApproved: { approved: true },
        claims: [], draft: "Done.", critique: null, critiqueIterations: 0,
      });

    const { runHeadless } = await import("@/lib/eval/headless-runner");
    const result = await runHeadless({ runId: "r1", projectId: "p1", question: "Q", corpusItemIds: ["c1"] });

    expect(mocks.invoke).toHaveBeenCalledTimes(3);
    expect(result.draft).toBe("Done.");
  });

  it("throws after maxSegments to prevent infinite loops on a buggy graph", async () => {
    mocks.invoke.mockResolvedValue({
      runId: "r1", projectId: "p1", question: "Q",
      candidateCorpusItems: [], plan: null, planApproved: null,
      includedPapers: [], papersApproved: null, claims: [],
      draft: null, critique: null, critiqueIterations: 0,
      __interrupt__: [{ value: { kind: "APPROVE_PLAN" } }],
    });

    const { runHeadless } = await import("@/lib/eval/headless-runner");
    await expect(
      runHeadless({ runId: "r1", projectId: "p1", question: "Q", corpusItemIds: ["c1"] }),
    ).rejects.toThrow(/maxSegments/);
  });
});
