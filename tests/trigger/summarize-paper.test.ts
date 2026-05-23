import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => {
  // metadata.set() returns the metadata object itself so chained .set().set() calls work
  const metadata: { set: ReturnType<typeof vi.fn> } = { set: vi.fn() };
  metadata.set.mockReturnValue(metadata);
  const logger = { info: vi.fn(), error: vi.fn() };
  const runLLM = vi.fn();
  return { metadata, logger, runLLM };
});

vi.mock("@trigger.dev/sdk", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@trigger.dev/sdk");
  return {
    ...actual,
    schemaTask: (cfg: { run: (payload: unknown) => Promise<unknown> }) => cfg,
    logger: mocks.logger,
    metadata: mocks.metadata,
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    corpusItem: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("@/lib/llm", () => ({
  runLLM: mocks.runLLM,
}));

import { db } from "@/lib/db";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runLLM.mockReset();
  mocks.metadata.set.mockReturnValue(mocks.metadata); // re-arm chain after clearAllMocks
});

describe("summarize-paper task", () => {
  it("calls runLLM with the paper markdown and persists the summary + trace URL", async () => {
    vi.mocked(db.corpusItem.findUnique).mockResolvedValue({
      id: "c1",
      projectId: "p1",
      status: "PARSED",
      parsedMarkdown: "# Some paper\n\nBody.",
      project: { question: "Does X improve Y?" },
    } as never);

    mocks.runLLM.mockResolvedValue({
      output: {
        abstract: "Tests",
        researchQuestions: [],
        methodology: "x",
        keyFindings: [],
        limitations: [],
        studyType: "empirical",
        relevanceToSLR: "highly_relevant",
      },
      traceUrl: "http://localhost:3030/project/atlas-dev/traces/trace_abc",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });

    const mod = await import("@/trigger/summarize-paper");
    const task = mod.summarizePaperTask as unknown as {
      run: (p: { corpusItemId: string }) => Promise<{ ok: boolean; traceUrl: string; usage: unknown }>;
    };
    const result = await task.run({ corpusItemId: "c1" });

    expect(mocks.runLLM).toHaveBeenCalledWith(
      expect.objectContaining({ name: "summarize-paper", tier: "fast" }),
    );

    const updateCalls = vi.mocked(db.corpusItem.update).mock.calls;
    const finalCall = updateCalls.at(-1)!;
    const finalData = (finalCall[0] as { data: Record<string, unknown> }).data;
    expect(finalData.summary).toEqual(expect.objectContaining({ studyType: "empirical" }));
    expect(finalData.summaryTraceUrl).toBe(
      "http://localhost:3030/project/atlas-dev/traces/trace_abc",
    );
    expect(finalData.summarisedAt).toBeInstanceOf(Date);

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        traceUrl: "http://localhost:3030/project/atlas-dev/traces/trace_abc",
      }),
    );
  });

  it("throws if the corpus item is not yet PARSED", async () => {
    vi.mocked(db.corpusItem.findUnique).mockResolvedValue({
      id: "c1",
      projectId: "p1",
      status: "PARSING",
      parsedMarkdown: null,
      project: { question: "Q" },
    } as never);

    const mod = await import("@/trigger/summarize-paper");
    const task = mod.summarizePaperTask as unknown as {
      run: (p: { corpusItemId: string }) => Promise<unknown>;
    };
    await expect(task.run({ corpusItemId: "c1" })).rejects.toThrow(/not yet PARSED/i);
  });

  it("records failureReason and rethrows on LLM error", async () => {
    vi.mocked(db.corpusItem.findUnique).mockResolvedValue({
      id: "c1",
      projectId: "p1",
      status: "PARSED",
      parsedMarkdown: "# x",
      project: { question: "Q" },
    } as never);

    mocks.runLLM.mockRejectedValue(new Error("anthropic 500"));

    const mod = await import("@/trigger/summarize-paper");
    const task = mod.summarizePaperTask as unknown as {
      run: (p: { corpusItemId: string }) => Promise<unknown>;
    };
    await expect(task.run({ corpusItemId: "c1" })).rejects.toThrow(/anthropic 500/);

    const updateCalls = vi.mocked(db.corpusItem.update).mock.calls;
    const failCall = updateCalls.at(-1)!;
    const failData = (failCall[0] as { data: Record<string, unknown> }).data;
    expect(failData.failureReason).toMatch(/anthropic 500/);
  });
});
