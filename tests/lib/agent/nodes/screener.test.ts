import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  class FakeBudgetExceededError extends Error {
    readonly runId: string;
    readonly tokensUsed: number;
    readonly limit: number;
    constructor(args: { runId: string; tokensUsed: number; limit: number }) {
      super(`Run ${args.runId} exceeded token budget`);
      this.runId = args.runId;
      this.tokensUsed = args.tokensUsed;
      this.limit = args.limit;
      this.name = "BudgetExceededError";
    }
  }
  return {
    runLLM: vi.fn(),
    addStep: vi.fn(),
    finishStep: vi.fn(),
    findCorpusMarkdown: vi.fn(),
    assertWithinBudget: vi.fn(),
    screeningDecisionCreate: vi.fn(),
    FakeBudgetExceededError,
  };
});

vi.mock("@/lib/llm", () => ({ runLLM: mocks.runLLM }));
vi.mock("@/lib/agent/runs", () => ({
  addStep: mocks.addStep,
  finishStep: mocks.finishStep,
  findCorpusMarkdown: mocks.findCorpusMarkdown,
}));
vi.mock("@/lib/agent/cost-cap", () => ({
  assertWithinBudget: mocks.assertWithinBudget,
  BudgetExceededError: mocks.FakeBudgetExceededError,
}));
vi.mock("@/lib/db", () => ({
  db: {
    screeningDecision: { create: mocks.screeningDecisionCreate },
  },
}));

import { screenerNode } from "@/lib/agent/nodes/screener";
import type { AgentState, DiscoveredPaperRef } from "@/lib/agent/state";

const baseState: AgentState = {
  runId: "r1", projectId: "p1", question: "?",
  candidateCorpusItems: [],
  plan: {
    picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "x" },
    subQuestions: ["q1"], inclusionCriteria: ["a"], exclusionCriteria: ["b"],
  },
  planApproved: { approved: true },
  includedPapers: [], papersApproved: null, claims: [],
  draft: null, critique: null, critiqueIterations: 0,
  searchScope: "outbound", searchProviders: ["openalex"],
  searchMaxHits: null,
  skipDiscoveryGate: false,
  discoveryQueries: [], discoveredPapers: [],
  discoveryApproved: null, screeningDecisions: [],
};

const dp = (id: string, withCorpus: boolean): DiscoveredPaperRef => ({
  id,
  provider: "openalex",
  externalId: `openalex:${id}`,
  title: `Paper ${id}`,
  abstract: "Abstract.",
  oaUrl: null,
  accessStatus: withCorpus ? "open" : "paywalled",
  corpusItemId: withCorpus ? `ci_${id}` : null,
});

beforeEach(() => {
  // Reset only the vi.fn mocks (the class slot has no mockReset).
  for (const v of Object.values(mocks)) {
    if (typeof v === "function" && "mockReset" in v) (v as { mockReset: () => void }).mockReset();
  }
  mocks.addStep.mockImplementation(({ nodeName }) =>
    Promise.resolve({ id: `step_${nodeName}_${Math.random().toString(36).slice(2, 8)}` }),
  );
  mocks.finishStep.mockResolvedValue(undefined);
  mocks.assertWithinBudget.mockResolvedValue({ tokensUsed: 0, limit: 250000 });
  mocks.findCorpusMarkdown.mockResolvedValue("# Full text body");
  mocks.screeningDecisionCreate.mockResolvedValue({ id: "sd_x" });
});

describe("screenerNode", () => {
  it("throws if state.plan is null", async () => {
    await expect(
      screenerNode({ ...baseState, plan: null }),
    ).rejects.toThrow(/plan is null/);
  });

  it("returns empty includedPapers when no discovered papers", async () => {
    const r = await screenerNode({ ...baseState, discoveredPapers: [] });
    expect(r.includedPapers).toEqual([]);
    expect(r.screeningDecisions).toEqual([]);
    expect(mocks.runLLM).not.toHaveBeenCalled();
  });

  it("scores each paper, persists ScreeningDecision, and emits IncludedPaperSpec for include=true with full text", async () => {
    mocks.runLLM
      .mockResolvedValueOnce({
        output: { include: true, relevanceScore: 0.9, reason: "Directly addresses the intervention and outcome." },
        traceUrl: "",
        usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130, cacheReadInputTokens: 0 },
      })
      .mockResolvedValueOnce({
        output: { include: false, relevanceScore: 0.2, reason: "Adjacent topic, fails the inclusion criteria on study type." },
        traceUrl: "",
        usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130, cacheReadInputTokens: 0 },
      });

    const r = await screenerNode({
      ...baseState,
      discoveredPapers: [dp("a", true), dp("b", true)],
    });

    expect(mocks.runLLM).toHaveBeenCalledTimes(2);
    expect(mocks.screeningDecisionCreate).toHaveBeenCalledTimes(2);
    expect(r.includedPapers).toHaveLength(1);
    expect(r.includedPapers![0]).toMatchObject({
      corpusItemId: "ci_a",
      relevanceScore: 0.9,
    });
    expect(r.screeningDecisions).toHaveLength(2);
  });

  it("does NOT emit IncludedPaper when screener says include=true but the paper has no corpusItemId (paywalled / fetch-failed)", async () => {
    mocks.runLLM.mockResolvedValue({
      output: { include: true, relevanceScore: 0.85, reason: "Looks great from the abstract." },
      traceUrl: "",
      usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130, cacheReadInputTokens: 0 },
    });

    const r = await screenerNode({
      ...baseState,
      discoveredPapers: [dp("paywalled", false)],
    });

    expect(mocks.screeningDecisionCreate).toHaveBeenCalledTimes(1); // decision recorded
    expect(r.includedPapers).toHaveLength(0); // but not added to corpus pool
    expect(r.screeningDecisions![0]!.include).toBe(true);
  });

  it("propagates BudgetExceededError without screening further papers", async () => {
    mocks.assertWithinBudget
      .mockResolvedValueOnce({ tokensUsed: 0, limit: 250000 })
      .mockResolvedValueOnce({ tokensUsed: 100_000, limit: 250000 })
      .mockRejectedValueOnce(
        new mocks.FakeBudgetExceededError({ runId: "r1", tokensUsed: 260_000, limit: 250000 }),
      );
    mocks.runLLM.mockResolvedValue({
      output: { include: true, relevanceScore: 0.9, reason: "ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok." },
      traceUrl: "",
      usage: { inputTokens: 50_000, outputTokens: 100, totalTokens: 50_100, cacheReadInputTokens: 0 },
    });

    await expect(
      screenerNode({
        ...baseState,
        discoveredPapers: [dp("a", true), dp("b", true)],
      }),
    ).rejects.toBeInstanceOf(mocks.FakeBudgetExceededError);

    // first paper screened, second never reached
    expect(mocks.runLLM).toHaveBeenCalledTimes(1);
    expect(mocks.screeningDecisionCreate).toHaveBeenCalledTimes(1);
  });

  it("propagates per-paper LLM errors (no soft-fail like cite-check)", async () => {
    mocks.runLLM.mockRejectedValue(new Error("Mistral 503"));

    await expect(
      screenerNode({
        ...baseState,
        discoveredPapers: [dp("a", true)],
      }),
    ).rejects.toThrow(/Mistral 503/);
    expect(mocks.screeningDecisionCreate).not.toHaveBeenCalled();
  });
});
