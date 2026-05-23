import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userUpsert: vi.fn(),
  projectCreate: vi.fn(),
  projectDeleteMany: vi.fn(),
  corpusCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    user: { upsert: mocks.userUpsert },
    project: { create: mocks.projectCreate, deleteMany: mocks.projectDeleteMany },
    corpusItem: { create: mocks.corpusCreate },
  },
}));

beforeEach(() => {
  mocks.userUpsert.mockReset();
  mocks.projectCreate.mockReset();
  mocks.projectDeleteMany.mockReset();
  mocks.corpusCreate.mockReset();
  mocks.userUpsert.mockResolvedValue({ id: "user_eval" });
  mocks.projectCreate.mockResolvedValue({ id: "proj_eval" });
  mocks.projectDeleteMany.mockResolvedValue({ count: 0 });
  let n = 0;
  mocks.corpusCreate.mockImplementation(() => Promise.resolve({ id: `corpus_${n++}` }));
});

describe("seedEvalProject", () => {
  it("deletes any prior project with the same title before creating the new one (cleanup for Neon free tier)", async () => {
    const { seedEvalProject } = await import("@/lib/eval/seed-corpus");
    await seedEvalProject({
      id: "000-test",
      question: "Q",
      picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" },
      papers: [{ id: "p1", title: "P1", summary: "s", markdown: "m" }],
      expectedPapers: ["p1"],
      expectedClaims: ["c"],
      metadata: { source: "s", difficulty: "easy" as const },
    });
    expect(mocks.projectDeleteMany).toHaveBeenCalledWith({
      where: { ownerId: "user_eval", title: "eval-000-test" },
    });
  });

  it("creates the eval user (upsert), a project, and one CorpusItem per paper", async () => {
    const { seedEvalProject } = await import("@/lib/eval/seed-corpus");
    const golden = {
      id: "000-test",
      question: "Q",
      picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" },
      papers: [
        { id: "paper_1", title: "P1", summary: "s1", markdown: "m1" },
        { id: "paper_2", title: "P2", summary: "s2", markdown: "m2" },
      ],
      expectedPapers: ["paper_1"],
      expectedClaims: ["c1"],
      metadata: { source: "src", difficulty: "easy" as const },
    };
    const result = await seedEvalProject(golden);

    expect(mocks.userUpsert).toHaveBeenCalled();
    expect(mocks.projectCreate).toHaveBeenCalled();
    expect(mocks.corpusCreate).toHaveBeenCalledTimes(2);
    expect(result.userId).toBe("user_eval");
    expect(result.projectId).toBe("proj_eval");
    expect(result.corpusItemIds).toHaveLength(2);
    expect(result.paperIdMap).toEqual({ paper_1: "corpus_0", paper_2: "corpus_1" });
  });

  it("seeds CorpusItem rows with status=PARSED + parsedMarkdown + structured summary", async () => {
    const { seedEvalProject } = await import("@/lib/eval/seed-corpus");
    await seedEvalProject({
      id: "000",
      question: "Q",
      picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" },
      papers: [{ id: "p1", title: "P1", summary: "abstract here", markdown: "full text" }],
      expectedPapers: ["p1"],
      expectedClaims: ["c"],
      metadata: { source: "s", difficulty: "easy" as const },
    });
    const call = mocks.corpusCreate.mock.calls[0]?.[0];
    expect(call?.data?.status).toBe("PARSED");
    expect(call?.data?.parsedMarkdown).toBe("full text");
    expect(call?.data?.summary).toMatchObject({ abstract: "abstract here" });
  });
});
