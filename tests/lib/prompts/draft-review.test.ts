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
});
