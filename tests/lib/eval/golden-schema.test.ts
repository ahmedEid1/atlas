import { describe, it, expect } from "vitest";
import { GoldenQuestionSchema } from "@/lib/eval/golden-schema";

const validGolden = {
  id: "000-test",
  question: "Does X improve Y?",
  picoc: {
    population: "Adults",
    intervention: "X",
    comparison: "Standard care",
    outcome: "Y",
    context: "Clinical trials",
  },
  papers: [
    {
      id: "paper_001",
      title: "Effect of X on Y",
      summary: "RCT of X vs control. Found 25% improvement in Y at 6 months.",
      markdown: "# Effect of X on Y\n\nFull paper text here...",
    },
  ],
  expectedPapers: ["paper_001"],
  expectedClaims: ["X improves Y by ~25%"],
  metadata: {
    source: "Cochrane Review CDxxxxxx",
    difficulty: "medium",
  },
};

describe("GoldenQuestionSchema", () => {
  it("accepts a valid golden question", () => {
    const r = GoldenQuestionSchema.safeParse(validGolden);
    expect(r.success).toBe(true);
  });

  it("requires id, question, picoc, papers, expectedPapers, expectedClaims", () => {
    const missing = { ...validGolden };
    delete (missing as Record<string, unknown>).question;
    expect(GoldenQuestionSchema.safeParse(missing).success).toBe(false);
  });

  it("rejects empty papers array (a question needs evaluable corpus)", () => {
    expect(GoldenQuestionSchema.safeParse({ ...validGolden, papers: [] }).success).toBe(false);
  });

  it("rejects expectedPapers that reference unknown paper ids", () => {
    const r = GoldenQuestionSchema.safeParse({
      ...validGolden,
      expectedPapers: ["paper_999"],
    });
    expect(r.success).toBe(false);
  });

  it("rejects duplicate paper ids within a question", () => {
    // Without this guard, seed-corpus.ts's paperIdMap silently drops the
    // first paper when two share an id, biasing the corpus passed to the
    // headless eval runner.
    const dup = {
      ...validGolden,
      papers: [
        validGolden.papers[0]!,
        { ...validGolden.papers[0]!, title: "Second paper, same id" },
      ],
    };
    const r = GoldenQuestionSchema.safeParse(dup);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /unique/.test(i.message))).toBe(true);
    }
  });

  it("accepts difficulty as easy/medium/hard", () => {
    for (const d of ["easy", "medium", "hard"] as const) {
      const r = GoldenQuestionSchema.safeParse({
        ...validGolden,
        metadata: { ...validGolden.metadata, difficulty: d },
      });
      expect(r.success).toBe(true);
    }
  });

  it("rejects unknown difficulty values", () => {
    const r = GoldenQuestionSchema.safeParse({
      ...validGolden,
      metadata: { ...validGolden.metadata, difficulty: "trivial" },
    });
    expect(r.success).toBe(false);
  });

  // V2 — expectedDois is optional. Existing v1 goldens omit it (vacuous-true
  // semantics on discovery_recall + screening_precision skip the row in the
  // eval CLI). v2 goldens populate it with real DOIs / arxiv ids.
  it("accepts optional expectedDois for v2 outbound goldens", () => {
    const r = GoldenQuestionSchema.safeParse({
      ...validGolden,
      expectedDois: ["10.48550/arXiv.2401.12345", "10.48550/arXiv.2402.99999"],
    });
    expect(r.success).toBe(true);
  });

  it("accepts goldens without expectedDois (v1 shape)", () => {
    const r = GoldenQuestionSchema.safeParse(validGolden);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.expectedDois).toBeUndefined();
  });

  it("rejects expectedDois entries that are too short (< 3 chars)", () => {
    const r = GoldenQuestionSchema.safeParse({
      ...validGolden,
      expectedDois: ["ok", "10.1/x"], // first is 2 chars → rejected
    });
    expect(r.success).toBe(false);
  });
});
