import { describe, it, expect } from "vitest";
import {
  PaperSummarySchema,
  buildSummarizePaperRequest,
} from "@/lib/prompts/summarize-paper";

describe("PaperSummarySchema", () => {
  it("parses a fully-populated summary", () => {
    const valid = {
      abstract: "This paper introduces a new approach to X.",
      researchQuestions: ["Does X improve Y?"],
      methodology: "Randomised controlled trial with 200 participants.",
      keyFindings: ["X improves Y by 25%."],
      limitations: ["Small sample size."],
      studyType: "empirical",
      relevanceToSLR: "highly_relevant",
    };
    expect(PaperSummarySchema.parse(valid)).toEqual(valid);
  });

  it("rejects unknown studyType", () => {
    const bad = {
      abstract: "x",
      researchQuestions: [],
      methodology: "x",
      keyFindings: [],
      limitations: [],
      studyType: "weird",
      relevanceToSLR: "highly_relevant",
    };
    expect(() => PaperSummarySchema.parse(bad)).toThrow();
  });
});

describe("buildSummarizePaperRequest", () => {
  it("returns system blocks with the paper markdown cached, and a user instruction", () => {
    const req = buildSummarizePaperRequest({
      paperMarkdown: "# Paper title\n\nSome content.",
      researchQuestion: "Does X improve Y in SE?",
    });

    expect(req.system).toHaveLength(2);
    const [instructions, paperBlock] = req.system;
    // Static role/instructions first — these stay in cache across re-summarisations of the same paper
    expect(instructions?.text).toMatch(/research analyst/i);
    // Paper markdown second, cached
    expect(paperBlock?.text).toContain("# Paper title");
    expect(paperBlock?.cache_control).toEqual({ type: "ephemeral" });
    // User turn carries the project-level research question
    expect(req.messages).toHaveLength(1);
    const [userMessage] = req.messages;
    expect(userMessage?.role).toBe("user");
    expect(JSON.stringify(userMessage?.content)).toContain("Does X improve Y in SE?");
  });
});
