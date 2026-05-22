import { describe, it, expect } from "vitest";
import { AgentStateAnnotation, type AgentState } from "@/lib/agent/state";

describe("AgentStateAnnotation", () => {
  it("has all the channels the nodes will read and write", () => {
    const channels = Object.keys(AgentStateAnnotation.spec);
    expect(channels).toEqual(
      expect.arrayContaining([
        "runId",
        "projectId",
        "question",
        "candidateCorpusItems",
        "plan",
        "planApproved",
        "includedPapers",
        "papersApproved",
        "claims",
        "draft",
      ]),
    );
  });

  it("an AgentState object can be constructed with the expected types", () => {
    const s: AgentState = {
      runId: "r1",
      projectId: "p1",
      question: "Does X improve Y?",
      candidateCorpusItems: [
        {
          id: "c1",
          title: "Some paper",
          summary: { abstract: "x", studyType: "empirical", relevanceToSLR: "highly_relevant" },
        },
      ],
      plan: null,
      planApproved: null,
      includedPapers: [],
      papersApproved: null,
      claims: [],
      draft: null,
    };
    expect(s.runId).toBe("r1");
  });
});
