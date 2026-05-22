import { describe, it, expect } from "vitest";
import { PaperScoreSchema, buildPaperScoreRequest } from "@/lib/prompts/score-paper";

describe("PaperScoreSchema", () => {
  it("parses a valid score", () => {
    const valid = { relevanceScore: 0.85, include: true, reason: "Hits PICOC outcome." };
    expect(PaperScoreSchema.parse(valid)).toEqual(valid);
  });

  it("rejects relevanceScore out of range", () => {
    expect(() => PaperScoreSchema.parse({ relevanceScore: 1.5, include: true, reason: "x" })).toThrow();
    expect(() => PaperScoreSchema.parse({ relevanceScore: -0.1, include: false, reason: "x" })).toThrow();
  });
});

describe("buildPaperScoreRequest", () => {
  it("includes the plan, the paper summary, and the user question", () => {
    const req = buildPaperScoreRequest({
      question: "Does X improve Y?",
      plan: {
        picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" },
        subQuestions: [],
        inclusionCriteria: ["ic1"],
        exclusionCriteria: [],
      },
      paper: { id: "c1", title: "Some paper", summary: { abstract: "About X.", studyType: "empirical", relevanceToSLR: "highly_relevant" } },
    });
    const full = JSON.stringify(req);
    expect(full).toContain("Does X improve Y?");
    expect(full).toContain("ic1");
    expect(full).toContain("About X.");
    expect(full).toContain("Some paper");
  });
});
