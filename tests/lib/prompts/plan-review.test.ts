import { describe, it, expect } from "vitest";
import { PlanSchema, buildPlannerRequest } from "@/lib/prompts/plan-review";

describe("PlanSchema", () => {
  it("parses a valid plan", () => {
    const valid = {
      picoc: {
        population: "Software engineers",
        intervention: "Pair programming",
        comparison: "Solo programming",
        outcome: "Code quality",
        context: "Industry",
      },
      subQuestions: ["Does pair programming reduce defects?"],
      inclusionCriteria: ["Empirical study"],
      exclusionCriteria: ["Opinion piece"],
    };
    expect(PlanSchema.parse(valid)).toEqual(valid);
  });

  it("rejects when picoc is missing", () => {
    expect(() => PlanSchema.parse({ subQuestions: [] })).toThrow();
  });
});

describe("buildPlannerRequest", () => {
  it("includes the research question and a system instruction about PICOC", () => {
    const req = buildPlannerRequest({
      question: "Does X improve Y in SE?",
      corpusSize: 12,
    });
    const [systemBlock] = req.system;
    expect(systemBlock?.text).toMatch(/PICOC/i);
    const [userMsg] = req.messages;
    expect(JSON.stringify(userMsg?.content)).toContain("Does X improve Y in SE?");
    expect(JSON.stringify(userMsg?.content)).toContain("12");
  });
});
