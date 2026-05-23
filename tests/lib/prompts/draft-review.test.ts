import { describe, it, expect } from "vitest";
import { DraftSchema, buildDrafterRequest } from "@/lib/prompts/draft-review";

describe("DraftSchema", () => {
  it("parses a markdown draft", () => {
    expect(DraftSchema.parse({ draft: "# Title\n\nBody [c1]." })).toEqual({ draft: "# Title\n\nBody [c1]." });
  });

  it("rejects empty draft", () => {
    expect(() => DraftSchema.parse({ draft: "" })).toThrow();
  });
});

describe("buildDrafterRequest", () => {
  const examplePlan = {
    picoc: { population: "p", intervention: "i", comparison: "c", outcome: "o", context: "ctx" },
    subQuestions: ["Q1"],
    inclusionCriteria: ["IC1"],
    exclusionCriteria: ["EC1"],
  };

  it("includes the plan, claims, and citation guidance", () => {
    const req = buildDrafterRequest({
      question: "Does X improve Y?",
      plan: {
        picoc: { population: "", intervention: "", comparison: "", outcome: "", context: "" },
        subQuestions: [],
        inclusionCriteria: [],
        exclusionCriteria: [],
      },
      claims: [{ includedPaperId: "c1", text: "X improves Y by 20%", category: "finding" }],
    });
    expect(req.system).toMatch(/\[paper_id\]/);
    const [userMsg] = req.messages;
    const userText = JSON.stringify(userMsg?.content);
    expect(userText).toContain("X improves Y by 20%");
    expect(userText).toContain("c1");
    expect(userText).toContain("Does X improve Y?");
  });

  it("appends critique feedback to the prompt when present (revise mode)", () => {
    const req = buildDrafterRequest({
      question: "?",
      plan: examplePlan,
      claims: [{ includedPaperId: "c1", text: "x", category: "finding" }],
      critiqueFeedback: "Add a discussion of sub-question Q2; expand the [c1] paragraph with the effect size.",
    });
    const userText = JSON.stringify(req.messages[0]?.content);
    expect(userText).toContain("Revise based on this feedback");
    expect(userText).toContain("expand the [c1] paragraph");
  });

  it("omits the feedback section when critiqueFeedback is undefined", () => {
    const req = buildDrafterRequest({
      question: "?",
      plan: examplePlan,
      claims: [{ includedPaperId: "c1", text: "x", category: "finding" }],
    });
    const userText = JSON.stringify(req.messages[0]?.content);
    expect(userText).not.toContain("Revise based on this feedback");
  });
});
